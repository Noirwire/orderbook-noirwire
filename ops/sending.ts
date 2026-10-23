import {
  LAMPORTS_PER_SOL,
  Transaction,
  type Connection,
  type Keypair,
  type PublicKey,
  type TransactionInstruction,
} from "@solana/web3.js";
import { sendAndConfirm } from "../sdk/dist/index.js";

/** SOL from a local validator's faucet. No public network is asked for any. */
export async function airdropped(
  solana: Connection,
  to: PublicKey,
  sol: number,
): Promise<void> {
  const signature = await solana.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
  await solana.confirmTransaction(
    { signature, ...(await solana.getLatestBlockhash()) },
    "confirmed",
  );
}

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Reads until the value is truthy. A read that throws counts as not there yet. */
export async function until<T>(
  read: () => Promise<T | null | undefined | false>,
  what: string,
  timeoutMs = 60_000,
  everyMs = 200,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read().catch(() => null);
    if (value) return value;
    await sleep(everyMs);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const READ_ATTEMPTS = 4;

/** A read tried again when the endpoint hiccups (a 502 from a gateway, a 429), since a read changes nothing. */
export async function retried<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      if (attempt >= READ_ATTEMPTS) throw error;
      await sleep(500 * attempt);
    }
  }
}

/**
 * The error `instructions` would fail with, as the program's error text
 * (`{"InstructionError":...}`), or null when they would succeed: the network
 * runs them without keeping anything, so a failure lands in no signature
 * list.
 */
export async function simulatedError(
  connection: Connection,
  instructions: TransactionInstruction[],
  feePayer: Keypair,
  signers: Keypair[] = [],
): Promise<string | null> {
  return (await simulation(connection, instructions, feePayer, signers)).error;
}

async function simulation(
  connection: Connection,
  instructions: TransactionInstruction[],
  feePayer: Keypair,
  signers: Keypair[],
): Promise<{ error: string | null; logs: string[] }> {
  const transaction = new Transaction({
    feePayer: feePayer.publicKey,
    ...(await connection.getLatestBlockhash("confirmed")),
  }).add(...instructions);
  const { value } = await connection.simulateTransaction(transaction, [
    feePayer,
    ...signers,
  ]);
  return {
    error: value.err === null ? null : JSON.stringify(value.err),
    logs: value.logs ?? [],
  };
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** `bytes` as base58, which is how Solana writes a signature; derived here so it is known before anything is broadcast. */
export function base58Of(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  const digits: number[] = [];
  for (const byte of bytes.subarray(zeros)) {
    let carry = byte;
    for (let place = 0; place < digits.length; place += 1) {
      carry += digits[place] * 256;
      digits[place] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  return `${"1".repeat(zeros)}${digits
    .reverse()
    .map((digit) => BASE58[digit])
    .join("")}`;
}

const SOLANA_STATUS_POLL_MS = 1_000;
const SOLANA_REBROADCAST_MS = 4_000;
/** Longer than a blockhash lives, so the expiry is what ends the wait. */
const SOLANA_ABSOLUTE_LIMIT_MS = 180_000;

/**
 * Sends a transaction to Solana and resolves to its signature once it is
 * confirmed there. Unlike `send`, which is for a rollup that answers on the
 * first ask, this runs the transaction through the network's own checks first
 * (a refusal is thrown as the network words it, with nothing sent), then
 * sends the one signed transaction again and again until it lands or its
 * blockhash expires. Sending the same signed bytes cannot execute twice, and
 * once the blockhash has expired with no status the transaction can never
 * land, so the caller may build another without a double send. A transaction
 * that fails is thrown with its error and logs.
 */
export async function sendOnSolana(
  connection: Connection,
  instructions: TransactionInstruction | TransactionInstruction[],
  feePayer: Keypair,
  signers: Keypair[] = [],
  beforeBroadcast?: (signature: string, lastValidBlockHeight: number) => void,
): Promise<string> {
  const steps = [instructions].flat();
  const { error, logs } = await simulation(
    connection,
    steps,
    feePayer,
    signers,
  ).catch((failure: Error) => {
    throw new Error(
      `Solana would not simulate the transaction (${failure.message.split("\n")[0]}), so it is not sent. Nothing was sent.`,
    );
  });
  if (error !== null) {
    throw new Error(
      `Solana would refuse the transaction with ${error}${logs.length ? `:\n${logs.slice(-6).join("\n")}` : ""}\nNothing was sent.`,
    );
  }
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({
    feePayer: feePayer.publicKey,
    blockhash,
    lastValidBlockHeight,
  }).add(...steps);
  transaction.sign(feePayer, ...signers);
  const raw = transaction.serialize();
  if (beforeBroadcast && transaction.signature) {
    beforeBroadcast(base58Of(transaction.signature), lastValidBlockHeight);
  }
  const signature = await connection.sendRawTransaction(raw, {
    preflightCommitment: "confirmed",
  });
  const started = Date.now();
  let lastSent = started;
  while (Date.now() - started < SOLANA_ABSOLUTE_LIMIT_MS) {
    // A read that fails is not a verdict: the transaction is already sent, so
    // an endpoint's hiccup must not end the wait and leave its fate unknown.
    const value = await connection
      .getSignatureStatus(signature)
      .then((reply) => reply.value)
      .catch(() => undefined);
    if (value && value.confirmationStatus !== "processed") {
      if (!value.err) return signature;
      const logs = await connection
        .getTransaction(signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        })
        .then((landed) => landed?.meta?.logMessages ?? [])
        .catch(() => []);
      throw new Error(`${JSON.stringify(value.err)}\n${logs.join("\n")}`);
    }
    if (
      value === null &&
      (await connection.getBlockHeight("confirmed").catch(() => 0)) >
        lastValidBlockHeight
    ) {
      throw new Error(
        `Transaction ${signature} did not land and its blockhash has expired, so it never will. Nothing moved: it is safe to run the command again.`,
      );
    }
    if (Date.now() - lastSent >= SOLANA_REBROADCAST_MS) {
      await connection
        .sendRawTransaction(raw, { skipPreflight: true })
        .catch(() => null);
      lastSent = Date.now();
    }
    await sleep(SOLANA_STATUS_POLL_MS);
  }
  throw new Error(
    `Transaction ${signature} was not confirmed on Solana in ${SOLANA_ABSOLUTE_LIMIT_MS} ms. Look it up before running the command again.`,
  );
}

/** Sends instructions as one transaction and resolves to the signature, or throws with the logs. */
export function send(
  connection: Connection,
  instructions: TransactionInstruction | TransactionInstruction[],
  feePayer: Keypair,
  signers: Keypair[] = [],
): Promise<string> {
  return sendAndConfirm(connection, [instructions].flat(), feePayer, signers);
}

import {
  Connection,
  Keypair,
  SYSVAR_CLOCK_PUBKEY,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { sleep } from "./internal/async.js";
import type { Blockhash } from "./internal/blockhashes.js";

/** A signed transaction, ready to send as many times as needed. */
export type Signed = { raw: Buffer; signature: string };

/** Signs with `blockhash` when given one, and asks the network for one otherwise. */
export async function signed(
  connection: Connection,
  instructions: TransactionInstruction[],
  feePayer: Keypair,
  signers: Keypair[] = [],
  blockhash?: Blockhash,
): Promise<Signed> {
  const latest =
    blockhash ?? (await connection.getLatestBlockhash("confirmed"));
  const transaction = new Transaction({
    feePayer: feePayer.publicKey,
    ...latest,
  }).add(...instructions);
  transaction.sign(feePayer, ...signers);
  const signature = transaction.signature;
  if (!signature) throw new Error("the transaction was not signed");
  return {
    raw: transaction.serialize(),
    signature: Buffer.from(signature).toString("base64"),
  };
}

const STATUS_POLL_MS = { first: 100, growth: 1.5, slowest: 1_000 };

/**
 * The logs of a landed transaction, or none: the private endpoint may refuse
 * to show a transaction, and its error still has to reach the caller.
 */
async function logsOf(
  connection: Connection,
  signature: string,
): Promise<string[]> {
  const landed = await connection
    .getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    })
    .catch(() => null);
  return landed?.meta?.logMessages ?? [];
}

/**
 * Sends a transaction and waits for its status, for everything but orders.
 * The status is asked for less and less often, down to once a second: a
 * rollup answers on the first ask, and a public Solana endpoint that takes
 * seconds to confirm limits how often it may be asked.
 */
export async function sendAndConfirm(
  connection: Connection,
  instructions: TransactionInstruction[],
  feePayer: Keypair,
  signers: Keypair[] = [],
  timeoutMs = 60_000,
): Promise<string> {
  const { raw } = await signed(connection, instructions, feePayer, signers);
  const signature = await connection.sendRawTransaction(raw, {
    skipPreflight: true,
  });
  const deadline = Date.now() + timeoutMs;
  let pollMs = STATUS_POLL_MS.first;
  while (Date.now() < deadline) {
    const { value } = await connection.getSignatureStatus(signature);
    if (value && value.confirmationStatus !== "processed") {
      if (!value.err) return signature;
      const logs = await logsOf(connection, signature);
      throw new Error(`${JSON.stringify(value.err)}\n${logs.join("\n")}`);
    }
    await sleep(pollMs);
    pollMs = Math.min(STATUS_POLL_MS.slowest, pollMs * STATUS_POLL_MS.growth);
  }
  throw new Error(
    `transaction ${signature} was not confirmed in ${timeoutMs} ms`,
  );
}

const CLOCK_UNIX_TIMESTAMP_OFFSET = 32;

/** The clock the program reads, in unix seconds, as `connection` serves it. */
export async function clockOf(connection: Connection): Promise<number> {
  const clock = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY);
  if (!clock) throw new Error("the network serves no clock");
  return Number(
    new DataView(clock.data.buffer, clock.data.byteOffset).getBigInt64(
      CLOCK_UNIX_TIMESTAMP_OFFSET,
      true,
    ),
  );
}

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
): Promise<string | null> {
  const transaction = new Transaction({
    feePayer: feePayer.publicKey,
    ...(await connection.getLatestBlockhash("confirmed")),
  }).add(...instructions);
  const { value } = await connection.simulateTransaction(transaction, [
    feePayer,
  ]);
  return value.err === null ? null : JSON.stringify(value.err);
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

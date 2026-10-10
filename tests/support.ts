/** The local network the suite runs against: its connections, its admin and how a test reads and sends. */
import { readFileSync } from "fs";
import { join } from "path";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  HEADER_LEN,
  Instructions,
  clockOf,
  decodeLedger,
  decodeMarket,
  decodeStats,
  decodeTape,
  decodeView,
  signed,
  type Ledger,
  type View,
} from "../sdk/dist/index.js";
import { heldKey, readingAs as readingAsAt } from "../ops/keys";
import { send as sendAsBuilt } from "../ops/sending";
import { tokenBalance } from "../ops/tokens";

export { until } from "../ops/sending";

const SOLANA_URL = "http://127.0.0.1:8899";
const ROLLUP_URL = "http://127.0.0.1:7799";
const ROLLUP_WEBSOCKET_URL = "ws://127.0.0.1:7800";
const PRIVATE_URL = "http://127.0.0.1:6699";

export const VALIDATOR = new PublicKey(
  "mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev",
);

export const solana = new Connection(SOLANA_URL, "confirmed");
/** The rollup's own unguarded port, which serves every account to anyone. */
export const rollup = new Connection(ROLLUP_URL, {
  commitment: "confirmed",
  wsEndpoint: ROLLUP_WEBSOCKET_URL,
});
/** The private endpoint, not signed in. */
export const anonymous = new Connection(PRIVATE_URL, "confirmed");

export const admin = heldKey(join(process.cwd(), ".localnet/admin.json"));

export const idl = JSON.parse(
  readFileSync(
    join(process.cwd(), "target/idl/noirwire_orderbook.json"),
    "utf8",
  ),
) as {
  address: string;
  instructions: {
    name: string;
    discriminator: number[];
    accounts: { name: string; writable?: boolean; signer?: boolean }[];
  }[];
};

export const instructions = new Instructions(new PublicKey(idl.address));
export const { addresses, programId: PROGRAM_ID } = instructions;

export const readingAs = (reader: Keypair) => readingAsAt(PRIVATE_URL, reader);

const MAX_COMPUTE_UNITS = 1_400_000;
let transactionsSent = 0;

/**
 * Sends instructions as one transaction and resolves to the signature, or
 * throws with the logs. The rollup refuses a transaction whose bytes equal
 * an earlier one's inside the same blockhash as "already processed", so each
 * one sent here carries a compute unit limit no other has.
 */
export function send(
  connection: Connection,
  instructions: TransactionInstruction | TransactionInstruction[],
  feePayer: Keypair,
  signers: Keypair[] = [],
): Promise<string> {
  transactionsSent += 1;
  const unlikeAnyOther = ComputeBudgetProgram.setComputeUnitLimit({
    units: MAX_COMPUTE_UNITS - transactionsSent,
  });
  return sendAsBuilt(
    connection,
    [instructions, unlikeAnyOther].flat(),
    feePayer,
    signers,
  );
}

/** Signs `instructions` with `feePayer` and sends the bytes as they are, confirming nothing. */
export async function sentRaw(
  instructions: TransactionInstruction[],
  feePayer: Keypair,
): Promise<Buffer> {
  const { raw } = await signed(rollup, instructions, feePayer);
  await rollup.sendRawTransaction(raw, { skipPreflight: true });
  return raw;
}

/** The accounts and logs of a landed transaction, as `connection` shows them. */
export async function shownBy(connection: Connection, signature: string) {
  const shown = await connection.getTransaction(signature, {
    maxSupportedTransactionVersion: 0,
  });
  if (!shown?.meta) throw new Error(`transaction ${signature} is not shown`);
  return {
    accounts: shown.transaction.message.getAccountKeys(),
    logs: shown.meta.logMessages ?? [],
  };
}

/** Resolves to the error text of a call that must fail, and throws if it succeeds. */
export async function refusal(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (error) {
    return error instanceof Error ? error.message : JSON.stringify(error);
  }
  throw new Error("The call succeeded, and it must not");
}

async function dataOf(
  connection: Connection,
  address: PublicKey,
): Promise<Buffer> {
  const account = await connection.getAccountInfo(address);
  if (!account) throw new Error(`${address.toBase58()} is not served`);
  return account.data;
}

/** Account data as the port serves it. Tests only: no client can read a sealed account. */
export const throughThePort = (address: PublicKey) => dataOf(rollup, address);

/** Account data as the private endpoint serves it to anyone. */
export const inPublic = (address: PublicKey) => dataOf(anonymous, address);

export const ledgerThroughThePort = async (): Promise<Ledger> =>
  decodeLedger(await throughThePort(addresses.ledger));

export const viewThroughThePort = async (owner: PublicKey): Promise<View> =>
  decodeView(await throughThePort(addresses.view(owner)));

/** The funding state of a book, at its offsets in the book's body, read through the port. */
export async function fundingThroughThePort(marketId: number): Promise<{
  index: bigint;
  lastTime: bigint;
  tradedNotional: bigint;
  tradedSize: bigint;
}> {
  const data = await throughThePort(addresses.book(marketId));
  const body = new DataView(data.buffer, data.byteOffset + HEADER_LEN);
  return {
    index: body.getBigInt64(16, true),
    lastTime: body.getBigInt64(24, true),
    tradedNotional: body.getBigUint64(48, true),
    tradedSize: body.getBigUint64(56, true),
  };
}

export const publicMarket = async (marketId: number) =>
  decodeMarket(await inPublic(addresses.market(marketId)));

export const publicStats = async () =>
  decodeStats(await inPublic(addresses.stats));

export const publicTape = async (marketId: number) =>
  decodeTape(await inPublic(addresses.tape(marketId)));

export const balanceOf = (account: PublicKey) => tokenBalance(rollup, account);

export const nowSeconds = () => Math.floor(Date.now() / 1000);

export const rollupNow = () => clockOf(rollup);

import { readFileSync } from "fs";
import { join } from "path";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  type TransactionInstruction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  Addresses,
  Instructions,
  OrderKeyManager,
  TraderClient,
  decodeLedger,
  decodeView,
  signed,
  type Ledger,
  type Seat,
  type View,
} from "../sdk/dist/index.js";
import {
  clockOf,
  movedIntoRollup,
  readingAs as readingAsAt,
  send,
  tokenBalance,
  until,
} from "../ops/network";

export { refusal, send, until } from "../ops/network";

export const BASE_URL = "http://127.0.0.1:8899";
export const ROLLUP_URL = "http://127.0.0.1:7799";
export const PRIVATE_URL = "http://127.0.0.1:6699";

export const VALIDATOR = new PublicKey(
  "mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev",
);

export const base = new Connection(BASE_URL, "confirmed");
export const rollup = new Connection(ROLLUP_URL, {
  commitment: "confirmed",
  wsEndpoint: "ws://127.0.0.1:7800",
});
export const anonymous = new Connection(PRIVATE_URL, "confirmed");

export const admin = Keypair.fromSecretKey(
  Uint8Array.from(
    JSON.parse(
      readFileSync(join(process.cwd(), ".localnet/admin.json"), "utf8"),
    ),
  ),
);

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
export const addresses: Addresses = instructions.addresses;
export const PROGRAM_ID = instructions.programId;

export const readingAs = (reader: Keypair) => readingAsAt(PRIVATE_URL, reader);

export async function airdropped(to: PublicKey, sol: number): Promise<void> {
  const signature = await base.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
  await base.confirmTransaction(
    { signature, ...(await base.getLatestBlockhash()) },
    "confirmed",
  );
}

/** The whole ledger, read through the rollup's own unguarded port. Tests only. */
export async function ledgerThroughThePort(): Promise<Ledger> {
  const account = await rollup.getAccountInfo(addresses.ledger);
  if (!account) throw new Error("the ledger is not in the rollup");
  return decodeLedger(account.data);
}

export async function viewThroughThePort(owner: PublicKey): Promise<View> {
  const account = await rollup.getAccountInfo(addresses.view(owner));
  if (!account) throw new Error("the view is not in the rollup");
  return decodeView(account.data);
}

/** The funding index of a book, read through the port. */
export async function fundingThroughThePort(marketId: number): Promise<{
  index: bigint;
  lastTime: bigint;
  tradedNotional: bigint;
  tradedSize: bigint;
}> {
  const account = await rollup.getAccountInfo(addresses.book(marketId));
  if (!account) throw new Error("the book is not in the rollup");
  const view = new DataView(account.data.buffer, account.data.byteOffset);
  return {
    index: view.getBigInt64(16 + 16, true),
    lastTime: view.getBigInt64(16 + 24, true),
    tradedNotional: view.getBigUint64(16 + 48, true),
    tradedSize: view.getBigUint64(16 + 56, true),
  };
}

/** A trader: owner key, order key seed, token accounts in the rollup, and a client. */
export type Trader = {
  name: string;
  owner: Keypair;
  seed: Uint8Array;
  keys: OrderKeyManager;
  client: TraderClient;
  reader: Connection;
  tokenAccounts: Map<string, PublicKey>;
  seat: number;
};

export type Mints = { nUSD: PublicKey; nSOL: PublicKey };

export const tokenAccountOf = (mint: PublicKey, owner: PublicKey) =>
  getAssociatedTokenAddressSync(mint, owner, true);

export const balanceOf = (account: PublicKey) => tokenBalance(rollup, account);

/** Signs `instructions` with `feePayer` and sends the bytes as they are, confirming nothing. */
export async function sentRaw(
  instructions: TransactionInstruction[],
  feePayer: Keypair,
  signers: Keypair[] = [],
): Promise<{ raw: Buffer; signature: string }> {
  const built = await signed(rollup, instructions, feePayer, signers);
  const signature = await rollup.sendRawTransaction(built.raw, {
    skipPreflight: true,
  });
  return { raw: built.raw, signature };
}

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const nowSeconds = () => Math.floor(Date.now() / 1000);

export const rollupNow = () => clockOf(rollup);

export function percentile(sorted: number[], p: number): number {
  return sorted[
    Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  ];
}

export function summary(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const fixed = (value: number) => Number(value.toFixed(2));
  return {
    n: sorted.length,
    min: fixed(sorted[0]),
    median: fixed(percentile(sorted, 50)),
    p95: fixed(percentile(sorted, 95)),
    p99: fixed(percentile(sorted, 99)),
    max: fixed(sorted[sorted.length - 1]),
  };
}

/** `amount` of `mint`, minted to `owner` on Solana and moved into the rollup as a private balance. */
export async function funded(
  owner: Keypair,
  mint: PublicKey,
  amount: bigint,
  minted: (
    owner: PublicKey,
    mint: PublicKey,
    amount: bigint,
  ) => Promise<PublicKey>,
): Promise<PublicKey> {
  await minted(owner.publicKey, mint, amount);
  return movedIntoRollup(base, rollup, admin, owner, mint, amount, VALIDATOR);
}

export const seatOf = (ledger: Ledger, index: number): Seat =>
  ledger.seats[index];

export function waitFor<T>(
  read: () => Promise<T | null | undefined | false>,
  what: string,
  timeoutMs = 30_000,
) {
  return until(read, what, timeoutMs, 50);
}

export { send as sendTo };

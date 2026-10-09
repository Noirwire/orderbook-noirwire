import {
  ComputeBudgetProgram,
  type Connection,
  type Keypair,
  type PublicKey,
  type TransactionInstruction,
} from "@solana/web3.js";
import { decodeHeader } from "./accounts.js";
import { ACCOUNT_LEN, GROWTH_STEP, GROW_KIND } from "./constants.js";
import { Instructions, type MarketSettings } from "./instructions.js";
import { sendAndConfirm } from "./client.js";

/** Grow instructions per transaction. Each is two inner calls; 64 is the ceiling. */
const GROWS_PER_TRANSACTION = 30;

type Sender = (instructions: TransactionInstruction[]) => Promise<string>;

async function dataLength(
  connection: Connection,
  address: PublicKey,
): Promise<number> {
  const account = await connection.getAccountInfo(address);
  return account?.data.length ?? 0;
}

async function isReady(
  connection: Connection,
  address: PublicKey,
): Promise<boolean> {
  const account = await connection.getAccountInfo(address);
  return account !== null && decodeHeader(account.data).ready;
}

/** Grows one account to its full size, in steps, as many transactions as it takes. */
async function grown(
  connection: Connection,
  send: Sender,
  instructions: Instructions,
  admin: PublicKey,
  kind: number,
  marketId: number,
  target: PublicKey,
  full: number,
): Promise<void> {
  let length = await dataLength(connection, target);
  while (length < full) {
    const batch: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ];
    while (length < full && batch.length <= GROWS_PER_TRANSACTION) {
      length = Math.min(full, length + GROWTH_STEP);
      batch.push(
        instructions.growAccount(admin, kind, marketId, target, length),
      );
    }
    await send(batch);
  }
}

/** Grows one unready account to its full size without finalising anything. */
export function growToFullSize(
  connection: Connection,
  admin: Keypair,
  kind: number,
  marketId: number,
  target: PublicKey,
  full: number,
  programId?: PublicKey,
): Promise<void> {
  const instructions = new Instructions(programId);
  return grown(
    connection,
    (batch) => sendAndConfirm(connection, batch, admin),
    instructions,
    admin.publicKey,
    kind,
    marketId,
    target,
    full,
  );
}

/**
 * Creates the ledger and the stats account and grows the ledger to its full
 * size. Safe to repeat: whatever already exists is left alone.
 */
export async function setupLedger(
  connection: Connection,
  admin: Keypair,
  programId?: PublicKey,
): Promise<void> {
  const instructions = new Instructions(programId);
  const { ledger, stats } = instructions.addresses;
  const send: Sender = (batch) => sendAndConfirm(connection, batch, admin);
  if (await isReady(connection, ledger)) return;
  if ((await dataLength(connection, ledger)) === 0) {
    await send([instructions.createLedger(admin.publicKey)]);
  }
  await grown(
    connection,
    send,
    instructions,
    admin.publicKey,
    GROW_KIND.ledger,
    0,
    ledger,
    ACCOUNT_LEN.ledger,
  );
  if (!(await isReady(connection, stats))) {
    await send([instructions.finalizeLedger(admin.publicKey)]);
  }
}

/**
 * Creates a market's four accounts, grows the book and the tape and
 * finalises the market. Safe to repeat.
 */
export async function setupMarket(
  connection: Connection,
  admin: Keypair,
  marketId: number,
  settings: MarketSettings,
  programId?: PublicKey,
): Promise<void> {
  const instructions = new Instructions(programId);
  const addresses = instructions.addresses;
  const send: Sender = (batch) => sendAndConfirm(connection, batch, admin);
  if (await isReady(connection, addresses.market(marketId))) return;
  if ((await dataLength(connection, addresses.market(marketId))) === 0) {
    await send([
      instructions.createMarket(admin.publicKey, marketId, settings),
    ]);
  }
  await grown(
    connection,
    send,
    instructions,
    admin.publicKey,
    GROW_KIND.book,
    marketId,
    addresses.book(marketId),
    ACCOUNT_LEN.book,
  );
  await grown(
    connection,
    send,
    instructions,
    admin.publicKey,
    GROW_KIND.tape,
    marketId,
    addresses.tape(marketId),
    ACCOUNT_LEN.tape,
  );
  await send([instructions.finalizeMarket(admin.publicKey, marketId)]);
}

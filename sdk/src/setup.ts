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
import { PROGRAM_ERROR } from "./internal/programErrors.js";
import { sendAndConfirm } from "./transactions.js";

/** Grow instructions per transaction. Each is two inner calls; 64 is the ceiling. */
const GROWS_PER_TRANSACTION = 30;
const MAX_COMPUTE_UNITS = 1_400_000;

/** `InvalidGrowth` and `AlreadyReady`, as the text of a failed transaction carries them. */
const NOT_THE_NEXT_STEP = [
  PROGRAM_ERROR.invalidGrowth,
  PROGRAM_ERROR.alreadyReady,
].map(String);

/** The admin's set-up of one program through one connection. */
class AdminSetup {
  readonly instructions: Instructions;

  constructor(
    private readonly connection: Connection,
    private readonly admin: Keypair,
    programId?: PublicKey,
  ) {
    this.instructions = new Instructions(programId);
  }

  get adminKey(): PublicKey {
    return this.admin.publicKey;
  }

  send(instructions: TransactionInstruction[]): Promise<string> {
    return sendAndConfirm(this.connection, instructions, this.admin);
  }

  async dataLength(address: PublicKey): Promise<number> {
    const account = await this.connection.getAccountInfo(address);
    return account?.data.length ?? 0;
  }

  async isReady(address: PublicKey): Promise<boolean> {
    const account = await this.connection.getAccountInfo(address);
    return account !== null && decodeHeader(account.data).ready;
  }

  /**
   * Grows one account to its full size, in steps, as many transactions as it
   * takes. The account exists; when it cannot be read, its size is found by
   * `lengthByGrowing`.
   */
  async grown(
    kind: number,
    marketId: number,
    target: PublicKey,
    full: number,
  ): Promise<void> {
    const growTo = (length: number) =>
      this.instructions.growAccount(
        this.adminKey,
        kind,
        marketId,
        target,
        length,
      );
    let length =
      (await this.dataLength(target)) ||
      (await this.lengthByGrowing(growTo, full));
    while (length < full) {
      const batch: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_COMPUTE_UNITS }),
      ];
      while (length < full && batch.length <= GROWS_PER_TRANSACTION) {
        length = Math.min(full, length + GROWTH_STEP);
        batch.push(growTo(length));
      }
      await this.send(batch);
    }
  }

  /**
   * The size of an account this connection cannot read, which is every sealed
   * account through the private endpoint. The program is asked instead: a grow
   * to a size succeeds only from the step right below it, so the first one
   * that succeeds says where the account stood. A fresh account answers on the
   * first try.
   */
  private async lengthByGrowing(
    growTo: (length: number) => TransactionInstruction,
    full: number,
  ): Promise<number> {
    for (let next = 2 * GROWTH_STEP; ; next += GROWTH_STEP) {
      const length = Math.min(full, next);
      const refusal = await this.send([growTo(length)]).then(
        () => null,
        (error: Error) => error.message,
      );
      if (refusal === null) return length;
      if (!NOT_THE_NEXT_STEP.some((code) => refusal.includes(code))) {
        throw new Error(refusal);
      }
      if (length === full) return full;
    }
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
  return new AdminSetup(connection, admin, programId).grown(
    kind,
    marketId,
    target,
    full,
  );
}

/**
 * Creates the ledger and the stats account and grows the ledger to its full
 * size. Safe to repeat: whatever already exists is left alone. The ledger is
 * sealed, so how far things got is read from the public stats account, which
 * is created with the ledger and finalised after it. `connection` must be
 * allowed to send as `admin`: on a private endpoint, signed in.
 */
export async function setupLedger(
  connection: Connection,
  admin: Keypair,
  programId?: PublicKey,
): Promise<void> {
  const setup = new AdminSetup(connection, admin, programId);
  const { instructions } = setup;
  const { ledger, stats } = instructions.addresses;
  if (await setup.isReady(stats)) return;
  if ((await setup.dataLength(stats)) === 0) {
    await setup.send([instructions.createLedger(setup.adminKey)]);
  }
  await setup.grown(GROW_KIND.ledger, 0, ledger, ACCOUNT_LEN.ledger);
  if (!(await setup.isReady(stats))) {
    await setup.send([instructions.finalizeLedger(setup.adminKey)]);
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
  const setup = new AdminSetup(connection, admin, programId);
  const { instructions } = setup;
  const { addresses } = instructions;
  const market = addresses.market(marketId);
  if (await setup.isReady(market)) return;
  if ((await setup.dataLength(market)) === 0) {
    await setup.send([
      instructions.createMarket(setup.adminKey, marketId, settings),
    ]);
  }
  await setup.grown(
    GROW_KIND.book,
    marketId,
    addresses.book(marketId),
    ACCOUNT_LEN.book,
  );
  await setup.grown(
    GROW_KIND.tape,
    marketId,
    addresses.tape(marketId),
    ACCOUNT_LEN.tape,
  );
  await setup.send([instructions.finalizeMarket(setup.adminKey, marketId)]);
}

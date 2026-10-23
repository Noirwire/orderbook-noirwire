/**
 * What the launch's setup and the mark check both read about the keeper and
 * about insurance, so the two cannot disagree: the keeper's view as the
 * keeper reads it, whether it is funded and running, and the insurance a mark
 * is sized against. Everything here only reads.
 */
import { existsSync } from "fs";
import { ACCOUNT_SIZE, AccountLayout } from "@solana/spl-token";
import { type Connection, type Keypair, type PublicKey } from "@solana/web3.js";
import { decodeView, type View } from "../sdk/dist/index.js";
import {
  QUOTE_DECIMALS,
  existingKey,
  keyPath,
  readDeployment,
  type Target,
} from "./deployment";
import {
  atomsOf,
  insuranceSizing,
  keeperDepositFor,
  type CustodyHeld,
} from "./launch";
import { readingAs } from "./keys";
import { quoteToken } from "./market";
import { sleep } from "./sending";
import {
  keeperLiveWindowMs,
  keeperNotReady,
  keeperWrote,
  positiveInteger,
} from "./upkeep";

/**
 * The keeper's view, read as the keeper since nobody else may read it, or null
 * while it has no seat. This run only reads it: every instruction signed with
 * the keeper's order keys replaces the key it used, so a run that signed with
 * them would take the keys from under a keeper sweeping from the same seat. A
 * deposit does not write the view either, so its collateral is what the keeper
 * last synced, which is why the deposit is recorded (`keeperDeposited`).
 */
export async function keeperView(
  on: Target,
  keeper: Keypair,
): Promise<View | null> {
  const reader = await readingAs(on.privateUrl, keeper);
  const account = await reader.getAccountInfo(
    on.instructions.addresses.view(keeper.publicKey),
  );
  return account ? decodeView(account.data) : null;
}

/** How often a run watching the keeper's view reads it again. */
const KEEPER_WATCH_EVERY_MS = 3_000;

/**
 * Why the keeper cannot be relied on to liquidate, or null once its seat is
 * funded and, when `watch` is set, its view was written while this run
 * watched it, with the collateral its view last showed (null without a seat).
 * `deposited` says the deployment records the keeper's deposit. Every sweep
 * syncs the keeper's view, and a sync records a result, so a running keeper
 * moves it even over a paused market. The run watches for as long as a
 * running keeper can go between two writes (`keeperLiveWindowMs`, from
 * `KEEPER_EVERY`), and stops as soon as it sees one. It sends nothing.
 */
export async function keeperWatched(
  on: Target,
  keeper: Keypair,
  deposited: boolean,
  watch: boolean,
  reads: {
    view: (on: Target, keeper: Keypair) => Promise<View | null>;
    wait: (ms: number) => Promise<unknown>;
  } = { view: keeperView, wait: sleep },
): Promise<{ why: string | null; collateral: bigint | null }> {
  const windowMs = keeperLiveWindowMs(
    positiveInteger("KEEPER_EVERY", process.env.KEEPER_EVERY, 1),
  );
  const seen = { deposited, watchedSeconds: windowMs / 1_000 };
  const first = await reads.view(on, keeper);
  const firstCollateral = first?.snapshot.seat.collateral ?? null;
  if (first === null || !watch) {
    return {
      why: keeperNotReady({
        ...seen,
        collateral: firstCollateral,
        wrote: null,
      }),
      collateral: firstCollateral,
    };
  }
  console.error(
    `watching the keeper's view for up to ${seen.watchedSeconds} s, for a write that shows a keeper is running`,
  );
  const deadline = Date.now() + windowMs;
  let latest = first;
  while (!keeperWrote(first, latest) && Date.now() < deadline) {
    await reads.wait(KEEPER_WATCH_EVERY_MS);
    latest = (await reads.view(on, keeper)) ?? latest;
  }
  const collateral = latest.snapshot.seat.collateral;
  return {
    why: keeperNotReady({
      ...seen,
      collateral,
      wrote: keeperWrote(first, latest),
    }),
    collateral,
  };
}

/** `keeperWatched`'s reason alone. */
export async function keeperRefusal(
  on: Target,
  keeper: Keypair,
  deposited: boolean,
  watch: boolean,
): Promise<string | null> {
  return (await keeperWatched(on, keeper, deposited, watch)).why;
}

/** A custody token account the rollup did not serve, or served too short to be one. */
export class CustodyUnreadable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustodyUnreadable";
  }
}

/**
 * What a custody token account holds, read strictly: an account the
 * connection does not serve (null) or that is too short to be a token
 * account throws `CustodyUnreadable`. It is never read as 0, because "not
 * served" and "empty" are different facts and a cover sized from 0 is wrong
 * in both directions.
 */
export async function custodyHeld(
  connection: Connection,
  account: PublicKey,
): Promise<bigint> {
  const info = await connection.getAccountInfo(account);
  if (!info) {
    throw new CustodyUnreadable(
      `the rollup does not serve the custody token account ${account.toBase58()}`,
    );
  }
  if (info.data.length < ACCOUNT_SIZE) {
    throw new CustodyUnreadable(
      `the custody token account ${account.toBase58()} came back with ${info.data.length} bytes, too short for a token account (${ACCOUNT_SIZE})`,
    );
  }
  return AccountLayout.decode(info.data).amount;
}

/**
 * What public custody holds, read strictly: its balance, null where custody
 * is sealed, `"unreadable"` where it is public and the rollup does not serve
 * it. Never 0 for an account that is not there, which `tokenBalance` reads as
 * 0: every script that sizes, caps or refuses on what custody holds reads it
 * here.
 */
export async function custodyShown(
  on: Target,
  visibility: string,
  account: PublicKey,
): Promise<CustodyHeld> {
  if (visibility !== "public") return null;
  try {
    return await custodyHeld(on.rollup, account);
  } catch (error) {
    if (error instanceof CustodyUnreadable) return "unreadable";
    throw error;
  }
}

/**
 * The keeper's deposit as the insurance sizing counts it, without watching the
 * keeper: what this program's description records, else the collateral the
 * keeper's view shows where its key is on this machine, else 0 (the same
 * reading the mark check makes). It only reads.
 */
export async function keeperDepositKnown(on: Target): Promise<bigint> {
  const description = readDeployment(on.deploymentPath);
  const recorded =
    description?.programId === on.instructions.programId.toBase58()
      ? description.keeperDeposited
      : undefined;
  const kept = existsSync(keyPath(on, "keeper"));
  const collateral =
    recorded === undefined && kept
      ? ((await keeperView(on, existingKey(on, "keeper")))?.snapshot.seat
          .collateral ?? null)
      : null;
  return keeperDepositFor(recorded, collateral);
}

/**
 * The most the insurance seat can hold now, which is what a mark's cover is
 * sized from: the insurance funded, or less where public custody shows less
 * than that beyond the keeper's seat (`insuranceAtMost`), or less where the
 * operator read less from the console (`INSURANCE_HELD`, whole USDC, which
 * can only lower it). Where custody is sealed nothing shows it, and the seat
 * is sealed too: after an incident that paid deficits, only the console's own
 * figure shows what is left. Where custody is public but the rollup does not
 * serve its token account (the hosted rollup does not), the figure from the
 * console is the only thing left to size from, and without it this refuses.
 */
export async function insuranceNow(
  on: Target,
  keeperDeposited: bigint,
): Promise<bigint> {
  const token = await quoteToken(on);
  const held = await custodyShown(
    on,
    token.custodyVisibility,
    on.instructions.addresses.custody(token),
  );
  const stated = atomsOf(process.env.INSURANCE_HELD, QUOTE_DECIMALS);
  const { atMost, notes } = insuranceSizing(
    on.insurance,
    held,
    keeperDeposited,
    stated,
  );
  for (const note of notes) console.error(note);
  return atMost;
}

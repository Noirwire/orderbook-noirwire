/**
 * What the launch's setup and the mark check both read about the keeper and
 * about insurance, so the two cannot disagree: the keeper's view as the
 * keeper reads it, whether it is funded and running, and the insurance a mark
 * is sized against. Everything here only reads.
 */
import { type Keypair } from "@solana/web3.js";
import { decodeView, type View } from "../sdk/dist/index.js";
import { QUOTE_DECIMALS, type Target } from "./deployment";
import { atomsOf, insuranceAtMost } from "./launch";
import { readingAs } from "./keys";
import { quoteToken } from "./market";
import { sleep } from "./sending";
import { tokenBalance } from "./tokens";
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
): Promise<{ why: string | null; collateral: bigint | null }> {
  const windowMs = keeperLiveWindowMs(
    positiveInteger("KEEPER_EVERY", process.env.KEEPER_EVERY, 1),
  );
  const seen = { deposited, watchedSeconds: windowMs / 1_000 };
  const first = await keeperView(on, keeper);
  const firstCollateral = first?.snapshot.seat.collateral ?? null;
  const early = keeperNotReady({
    ...seen,
    collateral: firstCollateral,
    wrote: null,
  });
  if (early !== null || first === null || !watch) {
    return { why: early, collateral: firstCollateral };
  }
  console.error(
    `watching the keeper's view for up to ${seen.watchedSeconds} s, for a write that shows a keeper is running`,
  );
  const deadline = Date.now() + windowMs;
  let latest = first;
  while (!keeperWrote(first, latest) && Date.now() < deadline) {
    await sleep(KEEPER_WATCH_EVERY_MS);
    latest = (await keeperView(on, keeper)) ?? latest;
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

/**
 * The most the insurance seat can hold now, which is what a mark's cover is
 * sized from: the insurance funded, or less where public custody shows less
 * than that beyond the keeper's seat (`insuranceAtMost`), or less where the
 * operator read less from the console (`INSURANCE_HELD`, whole USDC, which
 * can only lower it). Where custody is sealed nothing shows it, and the seat
 * is sealed too: after an incident that paid deficits, only the console's own
 * figure shows what is left.
 */
export async function insuranceNow(
  on: Target,
  keeperDeposited: bigint,
): Promise<bigint> {
  const token = await quoteToken(on);
  const held =
    token.custodyVisibility === "public"
      ? await tokenBalance(on.rollup, on.instructions.addresses.custody(token))
      : null;
  const stated = atomsOf(process.env.INSURANCE_HELD, QUOTE_DECIMALS);
  const atMost = insuranceAtMost(on.insurance, held, keeperDeposited, stated);
  const fromCustody = insuranceAtMost(on.insurance, held, keeperDeposited);
  if (fromCustody < on.insurance) {
    console.error(
      `Public custody holds ${held} atoms, ${fromCustody} beyond the keeper's seat, less than the ${on.insurance} of insurance funded: ` +
        `tokens have left the exchange since, or never arrived. The cover is sized from ${fromCustody}.`,
    );
  }
  if (stated !== null && stated < fromCustody) {
    console.error(
      `INSURANCE_HELD=${stated / 10n ** BigInt(QUOTE_DECIMALS)} USDC is below what the tooling can bound (${fromCustody} atoms): the cover is sized from ${stated}.`,
    );
  } else if (stated !== null) {
    console.error(
      `INSURANCE_HELD names ${stated} atoms, not below the ${fromCustody} the tooling already bounds: it can only lower the figure, so it changes nothing.`,
    );
  }
  return atMost;
}

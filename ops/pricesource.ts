/**
 * What the set-price-source command decides, apart from the network so it can
 * be checked without one: whether it was asked to send, and whether the market
 * is in the state `set_price_source_v2` needs.
 */
import { MARKET_STATUS } from "../sdk/dist/index.js";
import {
  firstSyncFailure,
  heldMarkSyncFailure,
  type Observation,
} from "../sdk/dist/operator/index.js";
import { applyRequested } from "./administering";

export type RebindRequest = {
  /** The operator asked to send it (`APPLY=yes`); without it the command only shows the change. */
  apply: boolean;
};

/** Whether the run sends: only `APPLY=yes`. Anything else that is set is refused rather than read as a dry run. */
export function rebindRequest(settings: { APPLY?: string }): RebindRequest {
  return { apply: applyRequested(settings) };
}

/** What a run does about the market's binding: whether it sends the rebind, and the reason to show when it does for a market already bound. */
export type MarketRebind = { needed: boolean; why: string | null };

/**
 * A market that is not bound to the launch feed is rebound. One that is bound
 * is rebound too while its reserved parameter bytes still hold the earlier
 * build's liquidation age, because only `set_price_source_v2` clears them and
 * `resume_market` refuses the market (`MarketNotRebound`) until it has.
 */
export function marketRebind(
  bound: boolean,
  holdsEarlierBytes: boolean,
): MarketRebind {
  if (!bound) return { needed: true, why: null };
  if (!holdsEarlierBytes) return { needed: false, why: null };
  return {
    needed: true,
    why: "it reads as bound, but its reserved parameter bytes still hold the earlier build's liquidation age, which only a rebind clears and which resume_market refuses until it is cleared",
  };
}

/**
 * What can be said before sending. The rebind clears an empty book's mark, and
 * then any fresh print is accepted with no gap; a book that holds positions or
 * orders keeps its mark, and its first sync waits `min_publish_gap` from the
 * mark. The sealed book cannot be read to tell the two apart, so only the
 * feed's freshness refuses (`refusal`), and the held-mark wait is `ifHeld`,
 * a condition to show and never a reason to refuse. Neither says the market is
 * ready: that is `firstSyncVerdict`, after the sync.
 */
export type RebindPreflight = {
  refusal: string | null;
  ifHeld: string | null;
};

export function rebindPreflight(
  observation: Observation,
  clock: number,
  params: { maxPriceAge: number; minPublishGap: number },
  mark: { publishTime: number; acceptedAt: number },
): RebindPreflight {
  const refusal = firstSyncFailure(observation, clock, {
    maxPriceAge: params.maxPriceAge,
  });
  const ifHeld = heldMarkSyncFailure(observation, clock, {
    ...mark,
    minPublishGap: params.minPublishGap,
  });
  return { refusal, ifHeld };
}

/** The market as read back after the first sync. */
export type SyncedMarket = {
  /** The publish time of the source record. */
  sourcePublishTime: number;
  mark: bigint;
  markPublishTime: number;
};

export type SyncVerdict = { ready: boolean; line: string };

/**
 * The readiness verdict, from what the first sync did: `refusal` is the
 * program's error when the sync was refused, `after` the market read back.
 */
export function firstSyncVerdict(
  refusal: string | null,
  after: SyncedMarket | null,
  observationTime: number,
): SyncVerdict {
  if (refusal !== null) {
    return {
      ready: false,
      line: `not ready: the first sync was refused (${refusal}). Run the crank once the print is newer and the gap has passed.`,
    };
  }
  if (!after) {
    return {
      ready: false,
      line: "not ready: the market could not be read back after the first sync.",
    };
  }
  if (after.sourcePublishTime < observationTime) {
    return {
      ready: false,
      line: `not ready: the first sync was sent but the market's source still reads ${after.sourcePublishTime}, older than the print at ${observationTime}.`,
    };
  }
  return {
    ready: true,
    line: `the first sync was accepted: the source reads ${after.sourcePublishTime} and the mark is ${after.mark} stamped ${after.markPublishTime}.`,
  };
}

/** Why the market cannot be rebound now, or null: `set_price_source_v2` is refused unless the market is paused. */
export function rebindRefusal(status: number): string | null {
  if (status === MARKET_STATUS.paused) return null;
  return "The market is not paused. Pause it first with make mainnet-market-status STATUS=paused APPLY=yes: the program rebinds a market's price source only while it is paused, and the market stays paused until resume_market. Nothing was sent.";
}

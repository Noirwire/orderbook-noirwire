/**
 * What the mainnet profile decides, apart from the network so it can be
 * checked without one: which launch steps are left and in which order,
 * whether a market found on the network is the one the launch sets up,
 * and whether a first mark is close enough to the reference price, and covered
 * by insurance, for the admin to open the market on it. Nothing here touches
 * a file, a key or a network.
 */
import type { Exchange, MarketParams, SourceBinding } from "../accounts.js";
import type { MarketSettings, PriceSourceSettings } from "../instructions.js";
import {
  referenceSources,
  referenceUrl,
  type Lot,
  type ReferenceSource,
} from "./prices.js";
import {
  MAINNET_MARKET,
  MAINNET_PRICE_FEEDS,
  MAINNET_QUOTE_SOURCE,
} from "./profiles.js";

/**
 * SECURITY.md, "Running a small mainnet market", in the order it is done. The
 * exchange itself comes first and is not listed: every step reads it. The USDC
 * guard is bound before it is synced, the market is marked before its mark is
 * checked, insurance is funded before deposits are allowed, the keeper's seat
 * takes its deposit, and the market is resumed last, once insurance and the
 * keeper are in place.
 */
export const LAUNCH_STEPS = [
  "seatsPerDay",
  "quoteToken",
  "ledger",
  "market",
  "quoteSource",
  "syncQuote",
  "syncPrice",
  "funding",
  "adminFunds",
  "insurance",
  "keeper",
  "checkMark",
  "resume",
] as const;
export type LaunchStep = (typeof LAUNCH_STEPS)[number];

/** What a run finds before it starts. Each flag says that step's work is already done. */
export type LaunchObserved = {
  seatsPerDay: boolean;
  quoteToken: boolean;
  ledger: boolean;
  market: boolean;
  quoteSource: boolean;
  /** The guard has taken an observation since it was bound; keeping it fresh is the crank's job. */
  quoteRead: boolean;
  marked: boolean;
  active: boolean;
  /** The operator asked for `resume_market` (`RESUME_MARKET=yes`). */
  resumeConfirmed: boolean;
  funding: boolean;
  insurance: boolean;
  keeper: boolean;
  /**
   * The market has been opened once: it is active, the run's own record says
   * it was resumed, or the public counters show it traded.
   */
  launched: boolean;
  /** The one launch setting a run after launch was asked to write back, or null. */
  restore: RestorableStep | null;
};

/**
 * The launch's own settings that the admin may change during an incident:
 * the seats a day, the USDC guard, and the market's status. Once the market
 * has opened, a run never writes one back on its own.
 */
export const RESTORABLE_STEPS = [
  "seatsPerDay",
  "quoteSource",
  "resume",
] as const;
export type RestorableStep = (typeof RESTORABLE_STEPS)[number];

/** The step `value` names (`RESTORE=<step>`), or null when it is not set. */
export function restorableStep(
  value: string | undefined,
): RestorableStep | null {
  if (value === undefined || value === "") return null;
  const step = RESTORABLE_STEPS.find((each) => each === value);
  if (!step) {
    throw new Error(
      `RESTORE is one of: ${RESTORABLE_STEPS.join(", ")}, and names one step. Nothing was sent.`,
    );
  }
  return step;
}

/**
 * The steps a run still has to take, in launch order. The mark is checked
 * against the reference price on every run until the market is active, and the market is
 * resumed only on a run the operator confirmed. Once the market has opened,
 * the seats a day, the USDC guard and the market's status are left as the run
 * finds them, since the admin may have set them on purpose, unless the run
 * names that one step to write back (`restore`). Each step reads the network
 * again before it acts, so a step listed here that a parallel run finished
 * does nothing.
 */
export function launchSteps(observed: LaunchObserved): LaunchStep[] {
  const leftAlone = (step: RestorableStep) =>
    observed.launched && observed.restore !== step;
  const done: Record<LaunchStep, boolean> = {
    seatsPerDay: observed.seatsPerDay || leftAlone("seatsPerDay"),
    quoteToken: observed.quoteToken,
    ledger: observed.ledger,
    market: observed.market,
    quoteSource: observed.quoteSource || leftAlone("quoteSource"),
    syncQuote:
      (observed.quoteSource && observed.quoteRead) || leftAlone("quoteSource"),
    syncPrice: observed.marked,
    funding: observed.funding,
    adminFunds: observed.insurance && observed.keeper,
    insurance: observed.insurance,
    keeper: observed.keeper,
    checkMark: observed.active || leftAlone("resume"),
    resume:
      observed.active ||
      (observed.launched ? leftAlone("resume") : !observed.resumeConfirmed),
  };
  return LAUNCH_STEPS.filter((step) => !done[step]);
}

/**
 * The launch's own settings a run after launch finds changed and leaves as
 * they are, so it can say so: each is written back only on a run that names it.
 */
export function leftAsFound(observed: LaunchObserved): RestorableStep[] {
  if (!observed.launched) return [];
  const differs: Record<RestorableStep, boolean> = {
    seatsPerDay: !observed.seatsPerDay,
    quoteSource: !observed.quoteSource,
    resume: !observed.active,
  };
  return RESTORABLE_STEPS.filter(
    (step) => differs[step] && observed.restore !== step,
  );
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  Buffer.from(a).equals(Buffer.from(b));

/** The settings a market's account records, each under the name `create_market` takes it by. */
const MARKET_FIELDS = [
  "kind",
  "baseToken",
  "quoteToken",
  "tick",
  "baseLot",
] as const satisfies readonly (keyof MarketSettings & keyof MarketParams)[];
const LIMIT_FIELDS = [
  "minSize",
  "minNotional",
  "bandBps",
  "imBps",
  "mmBps",
  "takerFeeBps",
  "liqPenaltyBps",
  "fundingCapBps",
  "maxMoveBps",
  "maxOpenOrders",
  "maxPriceAge",
  "fundingInterval",
  "minPublishGap",
  "maxAgeLiquidation",
  "liqBufferBps",
  "liqInsuranceShareBps",
  "feeInsuranceShareBps",
  "settleWindow",
] as const satisfies readonly (keyof MarketSettings["limits"] &
  keyof MarketParams)[];
const SOURCE_FIELDS = [
  "expo",
  "maxConfBps",
  "baseDecimals",
  "quoteDecimals",
] as const satisfies readonly (keyof PriceSourceSettings &
  keyof SourceBinding)[];

/**
 * Every way a market found on the network differs from the one the launch
 * sets up: its settings, limits and the price source it is bound to. Empty
 * when it is that market. The two caps are bounds, not figures: the admin may
 * lower `open_interest_cap` below the launch's, which is how a market resumes
 * at a mark above the one it was sized at, and may raise `position_cap` up to
 * the open interest cap while one maker carries the market (SECURITY.md).
 */
export function settingsDiffer(
  found: { params: MarketParams; binding: SourceBinding },
  wanted: MarketSettings & { priceSource: PriceSourceSettings },
): string[] {
  const differ: string[] = [];
  const compared = (
    name: string,
    have: bigint | number,
    want: bigint | number | undefined,
  ) => {
    if (want !== undefined && have !== want) {
      differ.push(`${name} is ${have}, not ${want}`);
    }
  };
  for (const field of MARKET_FIELDS) {
    compared(field, found.params[field], wanted[field]);
  }
  for (const field of LIMIT_FIELDS) {
    compared(field, found.params[field], wanted.limits[field]);
  }
  const { openInterestCap, positionCap } = found.params;
  const launchCap = wanted.limits.openInterestCap;
  if (launchCap !== undefined && openInterestCap > launchCap) {
    differ.push(
      `openInterestCap is ${openInterestCap}, above the launch's ${launchCap}`,
    );
  }
  if (positionCap > openInterestCap) {
    differ.push(
      `positionCap is ${positionCap}, above the open interest cap of ${openInterestCap}`,
    );
  }
  if (!sameBytes(found.binding.feedId, wanted.priceSource.feedId)) {
    differ.push(
      `the feed is ${Buffer.from(found.binding.feedId).toString("hex")}, not ${Buffer.from(wanted.priceSource.feedId).toString("hex")}`,
    );
  }
  for (const field of SOURCE_FIELDS) {
    compared(
      `the feed's ${field}`,
      found.binding[field],
      wanted.priceSource[field],
    );
  }
  return differ;
}

/** Whether the USDC guard is bound to the mainnet profile's source and limits. */
export function quoteBoundAsLaunched({ quote }: Exchange): boolean {
  const wanted = MAINNET_QUOTE_SOURCE;
  return (
    sameBytes(quote.feedId, wanted.feedId) &&
    quote.expo === wanted.expo &&
    quote.maxConfBps === wanted.maxConfBps &&
    quote.depegBps === wanted.depegBps &&
    quote.maxAge === wanted.maxAge
  );
}

/** The Pyth Pro id of the feed the launch binds. */
export function proIdOfLaunch(): number {
  const { feedId } = MAINNET_MARKET.settings.priceSource;
  const named = Object.values(MAINNET_PRICE_FEEDS).find((known) =>
    sameBytes(known.feedId, feedId),
  );
  if (!named) {
    throw new Error(
      `The launch names no Pyth Pro id for its feed ${Buffer.from(feedId).toString("hex")}.`,
    );
  }
  return named.proId;
}

/** The lot the launch's market is priced in: its own settings, never the decimals a market on the network was bound with. */
export const LAUNCH_LOT: Lot = {
  baseLot: MAINNET_MARKET.settings.baseLot,
  baseDecimals: MAINNET_MARKET.settings.priceSource.baseDecimals,
  quoteDecimals: MAINNET_MARKET.settings.priceSource.quoteDecimals,
};

/**
 * The sources the launch's first mark is checked against, in quote atoms per
 * lot of the launch's own settings: the free public exchanges' SOL/USD prices
 * (Coinbase, Kraken, Bitstamp), with Pyth Pro's latest price added as one
 * more source when a token is given. Pyth Pro is asked for the launch's own
 * feed, by the Pro id the launch names next to the Pyth Core feed id it
 * binds, not for the feed the market names. `proUrl` is the Pyth Pro to ask
 * on a test network (`referenceUrl`).
 */
export function launchReferenceSources(
  mainnet: boolean,
  token: string | undefined,
  fetcher: typeof fetch = fetch,
  proUrl?: string,
): ReferenceSource[] {
  const url = referenceUrl(mainnet, proUrl);
  const pro = token ? { url, proId: proIdOfLaunch(), token } : undefined;
  return referenceSources(LAUNCH_LOT, pro, fetcher);
}

/** How far `mark` is from `reference`, in basis points of the reference, rounded up. */
export function gapBps(mark: bigint, reference: bigint): bigint {
  if (reference <= 0n) throw new Error("the reference price is not positive");
  const distance = mark > reference ? mark - reference : reference - mark;
  return (distance * 10_000n + reference - 1n) / reference;
}

/**
 * The widest gap between a first mark and the reference price, the median of
 * public exchange prices, that the admin resumes on. The mark is Pyth's, an
 * aggregate of many venues, so it differs from the exchanges' by the time
 * between two prints and by venue spreads; 1% is more than Pyth's 0.5% push
 * threshold plus a heartbeat of a calm market, and far less than a decimal slip.
 */
export const RESUME_GAP_BPS = 100n;

export type ResumeCheck = {
  mark: bigint;
  /** The median of the reference sources' prices, in the mark's unit. */
  reference: bigint;
  /** The operator asked for `resume_market` (`RESUME_MARKET=yes`). */
  confirmed: boolean;
  /**
   * The lots insurance covers across a planned gap from this mark (RULES 12),
   * from the insurance the launch funded, or from less where public custody
   * shows that less can be there: the insurance seat is sealed, so nothing
   * shows what it holds now.
   */
  covered: bigint;
  openInterestCap: bigint;
  /**
   * The mark's age by the rollup's clock, and the market's `max_price_age`, both
   * in seconds: a mark older than the market accepts is refused, since the
   * program would refuse orders on it the moment the market opened. A caller
   * that reads the mark gives both.
   */
  markAge?: bigint;
  maxPriceAge?: bigint;
  /** The USDC guard passes at the rollup's clock (RULES 9a): while it does not, perps take reduce-only orders. */
  guardPasses?: boolean;
  /** The market's price health is healthy: no dislocation or settlement is open. */
  marketHealthy?: boolean;
  /** The greatest recorded shortfall of any perp market, in quote atoms: `resume_market` refuses while one is above zero. */
  shortfall?: bigint;
  /** On mainnet: the exchange's admin is the program's upgrade authority. */
  adminUpgrades: boolean;
  /**
   * Why the liquidation keeper cannot be relied on, or null when its seat is
   * funded and it has been seen running. Null where a caller runs no keeper.
   */
  keeperWhy: string | null;
};

export type ResumeVerdict = { resume: true } | { resume: false; why: string };

/**
 * Whether to send `resume_market` on `mark`. `confirmHow` is what the
 * operator does to confirm, named in the answer when it is missing: the ops
 * scripts' variable unless a caller asks another way.
 */
export function resumeVerdict(
  check: ResumeCheck,
  confirmHow = "run this again with RESUME_MARKET=yes",
): ResumeVerdict {
  const { mark, reference } = check;
  if (mark <= 0n) return { resume: false, why: "the market has no mark" };
  if (
    check.markAge !== undefined &&
    check.maxPriceAge !== undefined &&
    check.markAge > check.maxPriceAge
  ) {
    return {
      resume: false,
      why: `the mark is ${check.markAge} s old, older than the market's max price age of ${check.maxPriceAge} s: run the crank until it has synced a fresh mark, then run this again`,
    };
  }
  if (check.guardPasses === false) {
    return {
      resume: false,
      why: "the USDC guard is not passing, so perps would take reduce-only orders at once: run the crank until it passes, then run this again",
    };
  }
  if (check.marketHealthy === false) {
    return {
      resume: false,
      why: "the market's price health is not healthy (a dislocation or a settlement is open): wait for it to clear, then run this again",
    };
  }
  if (check.shortfall !== undefined && check.shortfall > 0n) {
    return {
      resume: false,
      why: `a market records a shortfall of ${check.shortfall} quote atoms, which resume_market refuses until it is covered (RULES 12a)`,
    };
  }
  const gap = gapBps(mark, reference);
  if (gap > RESUME_GAP_BPS) {
    return {
      resume: false,
      why: `the mark is ${gap} bps from the reference price, more than ${RESUME_GAP_BPS}`,
    };
  }
  if (check.covered < check.openInterestCap) {
    return {
      resume: false,
      why:
        `insurance covers ${check.covered} lots at this mark, fewer than the open interest cap of ${check.openInterestCap}: ` +
        `lower open_interest_cap to at most ${check.covered} with update_market, and position_cap with it, then run this again (RULES 12)`,
    };
  }
  if (check.adminUpgrades) {
    return {
      resume: false,
      why:
        "the admin is the program's upgrade authority, which SECURITY.md never allows with real money: " +
        "move the upgrade authority to its multisig first",
    };
  }
  if (check.keeperWhy !== null) {
    return {
      resume: false,
      why: `a market opened without a running, funded keeper burns insurance with every price move nobody liquidates: ${check.keeperWhy}`,
    };
  }
  if (!check.confirmed) {
    return {
      resume: false,
      why: `check the mark against another source, then ${confirmHow}`,
    };
  }
  return { resume: true };
}

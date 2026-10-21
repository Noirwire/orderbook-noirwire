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
 * takes its deposit under the cap the step before it set, and the market is
 * resumed last, once insurance, the custody cap and the keeper are in place.
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
  "custodyCap",
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
  custodyCap: boolean;
  keeper: boolean;
};

/**
 * The steps a run still has to take, in launch order. The mark is checked
 * against the reference price on every run until the market is active, and the market is
 * resumed only on a run the operator confirmed. Each step reads the network
 * again before it acts, so a step listed here that a parallel run finished
 * does nothing.
 */
export function launchSteps(observed: LaunchObserved): LaunchStep[] {
  const done: Record<LaunchStep, boolean> = {
    seatsPerDay: observed.seatsPerDay,
    quoteToken: observed.quoteToken,
    ledger: observed.ledger,
    market: observed.market,
    quoteSource: observed.quoteSource,
    syncQuote: observed.quoteSource && observed.quoteRead,
    syncPrice: observed.marked,
    funding: observed.funding,
    adminFunds: observed.insurance && observed.keeper,
    insurance: observed.insurance,
    custodyCap: observed.custodyCap,
    keeper: observed.keeper,
    checkMark: observed.active,
    resume: observed.active || !observed.resumeConfirmed,
  };
  return LAUNCH_STEPS.filter((step) => !done[step]);
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
  "openInterestCap",
  "liqBufferBps",
  "liqInsuranceShareBps",
  "feeInsuranceShareBps",
  "settleWindow",
  "positionCap",
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
 * when it is that market.
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
  /** The lots insurance covers across a planned gap from this mark (RULES 12). */
  covered: bigint;
  openInterestCap: bigint;
  /** On mainnet: the exchange's admin is the program's upgrade authority. */
  adminUpgrades: boolean;
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
        "lower the cap with update_market, or fund insurance and size the cap from it again (RULES 12)",
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
  if (!check.confirmed) {
    return {
      resume: false,
      why: `check the mark against another source, then ${confirmHow}`,
    };
  }
  return { resume: true };
}

/**
 * What the mainnet profile decides, apart from the network so it can be
 * checked without one: which launch steps are left and in which order,
 * whether a market found on the network is the one the launch sets up,
 * whether a first mark is close enough to the reference price, and covered by insurance,
 * for the admin to open the market on it, and whether a send that may have
 * landed is sent again.
 */
import type {
  MarketParams,
  MarketSettings,
  PriceSourceSettings,
  SourceBinding,
} from "../sdk/dist/index.js";
import type { Profile } from "./deployment";

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

/** How far `mark` is from `reference`, in basis points of the reference, rounded up. */
export function gapBps(mark: bigint, reference: bigint): bigint {
  if (reference <= 0n) throw new Error("the reference price is not positive");
  const distance = mark > reference ? mark - reference : reference - mark;
  return (distance * 10_000n + reference - 1n) / reference;
}

/**
 * The widest gap between a first mark and the reference price, Pyth Pro's
 * latest, that the admin resumes on. Both are Pyth's price, so they differ by the time between
 * two prints; 1% is more than Pyth's 0.5% push threshold plus a heartbeat of
 * a calm market, and far less than a decimal slip.
 */
export const RESUME_GAP_BPS = 100n;

export type ResumeCheck = {
  mark: bigint;
  /** Pyth Pro's latest price, in the mark's unit. */
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

/** Whether to send `resume_market` on `mark`. */
export function resumeVerdict(check: ResumeCheck): ResumeVerdict {
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
      why: "check the mark against another source, then run this again with RESUME_MARKET=yes",
    };
  }
  return { resume: true };
}

/**
 * A send that moves money or cannot be repeated safely, recorded before it is
 * sent and again once it landed, so a run that stops in between leaves it
 * pending instead of forgotten.
 */
export type SentRecord = { state: "pending" | "landed"; at: string };

/**
 * What to do about a recorded send, given the operator's answer for a pending
 * one (`landed` or `lost`): send it, take it as done, or stop and ask.
 */
export function pendingVerdict(
  record: SentRecord | undefined,
  answer: string | undefined,
): "send" | "done" | "ask" {
  if (!record) return "send";
  if (record.state === "landed" || answer === "landed") return "done";
  return answer === "lost" ? "send" : "ask";
}

/**
 * Whether a failed send's error says the network ran it and refused it, so
 * it changed nothing. A timeout or a dropped connection says nothing of the
 * kind: that transaction may still land.
 */
export const refusedOnChain = (message: string) => /^[{"]/.test(message);

/**
 * Why the smoke may not run, or null. On mainnet it deposits the admin's
 * USDC into two seats and trades them against each other on the public tape,
 * so it asks for its own yes beyond the one that reaches mainnet.
 */
export function smokeRefusal(
  mainnet: boolean,
  confirmed: boolean,
): string | null {
  if (!mainnet || confirmed) return null;
  return (
    "On mainnet the smoke deposits real USDC of the admin's into two seats and trades them " +
    "against each other on the public tape: run it again with MAINNET_SMOKE=yes. Nothing was sent."
  );
}

/**
 * Whether the smoke raises a custody cap that refused its deposit: on a
 * rehearsal, never on mainnet, where a cap goes up only by the operator's
 * decision.
 */
export const smokeRaisesCap = (on: { profile: Profile; mainnet: boolean }) =>
  on.profile === "mainnet" && !on.mainnet;

/** `amount` whole tokens, from a variable, in atoms of a token of `decimals`; null when it is not set. */
export function atomsOf(
  amount: string | undefined,
  decimals: number,
): bigint | null {
  if (amount === undefined || amount === "") return null;
  if (!/^\d+$/.test(amount)) {
    throw new Error(`${amount} is not a whole number of tokens`);
  }
  return BigInt(amount) * 10n ** BigInt(decimals);
}

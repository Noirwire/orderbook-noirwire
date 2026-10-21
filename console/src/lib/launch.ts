/**
 * The mainnet profile of the ops launch, as far as the console reads it: the
 * launch's market and its settings, the launch steps in their order, which of
 * them are done, and the check before `resume_market`. The rules are the ops
 * scripts' own (`ops/deployment.ts` and `ops/launch.ts`: `MAINNET_MARKET`,
 * `settingsDiffer`, `launchSteps`, `resumeVerdict`, `gapBps`,
 * `openInterestCapFor`), so the console and `make rehearsal-setup` decide the
 * same way.
 */
import {
  MARKET_KIND,
  type MarketLimits,
  type MarketParams,
  type MarketSettings,
  type PriceSourceSettings,
  type SourceBinding,
} from "@noirwire/orderbook";

const BPS = 10_000n;
const QUOTE_DECIMALS = 6;

const feedId = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));

/** SECURITY.md, "Running a small mainnet market": the daily seat cap of the launch. */
export const MAINNET_MAX_SEATS_PER_DAY = 5;

/** The quote token's index, USDC on mainnet and a test mint of its decimals elsewhere. */
export const MAINNET_QUOTE_INDEX = 0;

/** What insurance is funded with, and the mark and gap it is sized for (RULES 12). */
export const MAINNET_INSURANCE = 3_000n * 1_000_000n;
export const MAINNET_SIZING = { mark: 150_000n, gapBps: 2_000n };

/**
 * RULES 9: mainnet's SOL/USD feed, which the launch binds. `proId` is the id
 * of the same price in Pyth Pro, where the first mark is checked against its
 * latest price; the chain never sees it.
 */
export const MAINNET_SOL_FEED = {
  feedId: feedId(
    "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  ),
  proId: 6,
  expo: -8,
};

/** RULES 9a: the USDC guard the launch binds, USDC/USD with its limits. */
export const MAINNET_QUOTE_SOURCE = {
  feedId: "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
  expo: -8,
  maxConfBps: 100,
  depegBps: 100,
  maxAge: 180n,
};

/**
 * RULES 12: the most lots `insurance` covers when a gap of `gapBps` from
 * `mark` lands before any liquidation and each position still holds its
 * penalty: `insurance / (mark * (gap - penalty))`.
 */
export function openInterestCapFor(
  insurance: bigint,
  mark: bigint,
  gapBps: bigint,
  penaltyBps: bigint,
): bigint {
  return (insurance * BPS) / (mark * (gapBps - penaltyBps));
}

const MAINNET_PENALTY_BPS = 200;
const MAINNET_OPEN_INTEREST_CAP = openInterestCapFor(
  MAINNET_INSURANCE,
  MAINNET_SIZING.mark,
  MAINNET_SIZING.gapBps,
  BigInt(MAINNET_PENALTY_BPS),
);

/**
 * The launch settings of SECURITY.md, "Running a small mainnet market": the
 * test networks' limits with at most 5x, every perp fee to insurance, and the
 * open interest cap sized from insurance with a fifth of it per seat.
 */
const MAINNET_LIMITS: MarketLimits = {
  minSize: 1n,
  minNotional: 1_000_000n,
  bandBps: 400,
  imBps: 2_000,
  mmBps: 500,
  takerFeeBps: 5,
  liqPenaltyBps: MAINNET_PENALTY_BPS,
  fundingCapBps: 50,
  maxMoveBps: 250,
  maxOpenOrders: 32,
  maxPriceAge: 90n,
  fundingInterval: 60n,
  minPublishGap: 1,
  maxAgeLiquidation: 180n,
  openInterestCap: MAINNET_OPEN_INTEREST_CAP,
  positionCap: MAINNET_OPEN_INTEREST_CAP / 5n,
  liqBufferBps: 100,
  liqInsuranceShareBps: 5_000,
  feeInsuranceShareBps: 10_000,
  settleWindow: 900n,
};

/** SOL/USD for a market of 0.001 SOL lots in 6-decimal USDC: $150 is 150,000 atoms per lot. */
const MAINNET_SOL_SOURCE: PriceSourceSettings = {
  feedId: MAINNET_SOL_FEED.feedId,
  expo: MAINNET_SOL_FEED.expo,
  maxConfBps: 100,
  baseDecimals: 9,
  quoteDecimals: QUOTE_DECIMALS,
};

/**
 * The one market the mainnet profile opens: the SOL perpetual in 0.001 SOL
 * lots and a tick of 10 quote atoms per lot, bound to Pyth's SOL/USD.
 */
export const MAINNET_MARKET = {
  id: 0,
  symbol: "SOL-PERP",
  settings: {
    kind: MARKET_KIND.perp,
    baseSymbol: "SOL",
    quoteSymbol: "USDC",
    baseToken: MAINNET_QUOTE_INDEX,
    quoteToken: MAINNET_QUOTE_INDEX,
    tick: 10n,
    baseLot: 1_000_000n,
    capacity: 1024,
    limits: MAINNET_LIMITS,
    priceSource: MAINNET_SOL_SOURCE,
  } satisfies MarketSettings,
};

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

/** Every way `found` differs from the launch's market, or that it is missing. Empty when it is that market. */
export function launchMarketDiffers(
  found: { params: MarketParams; binding: SourceBinding | null } | null,
): string[] {
  const { symbol, settings } = MAINNET_MARKET;
  if (!found) return [`${symbol} is not set up`];
  if (!found.binding) return [`${symbol} has no price feed`];
  return settingsDiffer(
    { params: found.params, binding: found.binding },
    settings,
  );
}

/**
 * SECURITY.md, "Running a small mainnet market", in the order it is done. The
 * exchange itself comes first and is not listed: every step reads it.
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
  quoteRead: boolean;
  marked: boolean;
  active: boolean;
  resumeConfirmed: boolean;
  funding: boolean;
  insurance: boolean;
  custodyCap: boolean;
  keeper: boolean;
};

/** The steps a run still has to take, in launch order. */
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

/** How far `mark` is from `reference`, in basis points of the reference, rounded up. */
export function gapBps(mark: bigint, reference: bigint): bigint {
  if (reference <= 0n) throw new Error("the reference price is not positive");
  const distance = mark > reference ? mark - reference : reference - mark;
  return (distance * 10_000n + reference - 1n) / reference;
}

/** The widest gap between a first mark and the reference price that the admin resumes on. */
export const RESUME_GAP_BPS = 100n;

export type ResumeCheck = {
  mark: bigint;
  reference: bigint;
  confirmed: boolean;
  covered: bigint;
  openInterestCap: bigint;
  adminUpgrades: boolean;
};

export type ResumeVerdict = { resume: true } | { resume: false; why: string };

/**
 * The check before `resume_market` as the console's server answers it,
 * numbers as decimal text, with the network, program and genesis it was made
 * on, which the page compares with its own before it builds the instruction.
 */
export type ResumeCheckAnswer = {
  network: string | null;
  programId: string | null;
  genesis: string | null;
  resume: boolean;
  why: string | null;
  mark: string | null;
  reference: string | null;
  gapBps: string | null;
  sources: string[];
  covered: string | null;
  openInterestCap: string | null;
};

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
      why: "check the mark against another source, then confirm",
    };
  }
  return { resume: true };
}

/** What the chain shows of one step: done, pending, or kept where the public cannot read it. */
export type StepState = "done" | "pending" | "not public";

export type StepRow = {
  step: LaunchStep;
  title: string;
  state: StepState;
  detail: string;
  /** The command that takes a pending step, with the variables it reads. */
  command: string | null;
};

const TITLES: Record<LaunchStep, string> = {
  seatsPerDay: `Daily seat cap of ${MAINNET_MAX_SEATS_PER_DAY}`,
  quoteToken: "Quote token registered, custody cap 0",
  ledger: "Ledger and stats",
  market: "SOL-PERP created, bound to Pyth SOL/USD",
  quoteSource: "USDC guard bound to Pyth USDC/USD",
  syncQuote: "USDC guard's first observation",
  syncPrice: "SOL-PERP's first mark",
  funding: "Funding scheduled",
  adminFunds: "Admin's USDC moved into the rollup",
  insurance: "Insurance funded",
  custodyCap: "First custody cap",
  keeper: "Liquidation keeper's seat, funded",
  checkMark: "Mark checked against the reference price",
  resume: "SOL-PERP resumed",
};

/**
 * What the public accounts cannot show, and why. The setup itself knows: it
 * records each one-shot send with the keys, and takes such a step only when
 * it is not done.
 */
const NOT_PUBLIC: Partial<Record<LaunchStep, string>> = {
  funding:
    "The funding task lives in the rollup's scheduler; the setup records its task id in the deployment description and skips the step once it is there.",
  adminFunds:
    "What insurance and the keeper's seat still need is in the sealed ledger; the setup reads it as the admin and the keeper.",
  insurance:
    "The insurance seat is in the sealed ledger; the setup records the amount it sent and never sends it twice.",
  keeper:
    "The keeper's view is private to the keeper; the setup reads it with the keeper's key and tops the seat up to KEEPER_DEPOSIT whole USDC when given one.",
};

/** The variables a pending step's command reads, beside the setup target. */
const VARIABLES: Partial<Record<LaunchStep, string>> = {
  custodyCap: "CUSTODY_CAP=<whole USDC>",
  resume: "RESUME_MARKET=yes",
};

/**
 * Every launch step, in order, as the chain shows it, with the command for
 * each pending one. A step the public cannot read gets no command of its own:
 * the setup takes it, with the variables beside it, when it is not done.
 */
export function launchRows(
  observed: Omit<LaunchObserved, "resumeConfirmed">,
  details: Partial<Record<LaunchStep, string>>,
  setup: string,
): StepRow[] {
  const pending = new Set(launchSteps({ ...observed, resumeConfirmed: true }));
  return LAUNCH_STEPS.map((step) => {
    const hidden = NOT_PUBLIC[step];
    const state: StepState = !pending.has(step)
      ? "done"
      : hidden
        ? "not public"
        : "pending";
    const variables = VARIABLES[step];
    return {
      step,
      title: TITLES[step],
      state,
      detail: state === "not public" ? (hidden ?? "") : (details[step] ?? ""),
      command:
        state !== "pending"
          ? null
          : variables
            ? `${setup} ${variables}`
            : setup,
    };
  });
}

/**
 * What each profile sets up: the test networks' tokens and markets, and the
 * mainnet launch's market, limits, price sources and insurance. Plain values
 * and arithmetic only, so nothing here touches a file, a key or a network.
 */
import { PublicKey } from "@solana/web3.js";
import { MARKET_KIND } from "../constants.js";
import type {
  MarketLimits,
  MarketSettings,
  PriceSourceSettings,
  QuoteSettings,
} from "../instructions.js";

const NUSD = 0;
const NSOL = 1;
export const QUOTE_DECIMALS = 6;
const BPS = 10_000n;

/**
 * `custodyCap` is the most a token's custody may hold after a trader's
 * deposit (RULES 11). Here it is the faucet's whole supply, so on a test
 * network it never refuses anything the faucet handed out.
 */
export const TOKENS = [
  {
    index: NUSD,
    symbol: "nUSD",
    decimals: QUOTE_DECIMALS,
    faucetAmount: 10_000_000n * 1_000_000n,
    custodyCap: 10_000_000n * 1_000_000n,
  },
  {
    index: NSOL,
    symbol: "nSOL",
    decimals: 9,
    faucetAmount: 100_000n * 1_000_000_000n,
    custodyCap: 100_000n * 1_000_000_000n,
  },
];

export const FUNDING_INTERVAL_SECONDS = 60n;

/**
 * The test networks' limits. Their markets are bound to no price source and
 * the oracle key publishes every few seconds, so the ages are short.
 */
const LIMITS: MarketLimits = {
  minSize: 1n,
  minNotional: 1_000_000n,
  bandBps: 400,
  imBps: 1_000,
  mmBps: 500,
  takerFeeBps: 5,
  liqPenaltyBps: 200,
  /** Per 8 h; each 60 s interval charges 1/480 of it (RULES 7). */
  fundingCapBps: 50,
  maxMoveBps: 250,
  maxOpenOrders: 32,
  maxPriceAge: 10n,
  fundingInterval: FUNDING_INTERVAL_SECONDS,
  minPublishGap: 1,
  maxAgeLiquidation: 60n,
  openInterestCap: 10_000_000n,
  /** A fifth of the open interest cap: no one seat can hold a market-sized position. */
  positionCap: 2_000_000n,
  liqBufferBps: 100,
  liqInsuranceShareBps: 5_000,
  feeInsuranceShareBps: 5_000,
  settleWindow: 900n,
};

const feedId = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));

/**
 * RULES 9 and 9a: mainnet's Pyth sources, which the mainnet profile binds. Each
 * account is the Pyth push oracle's shard 0 address for its feed id, owned by
 * the Pyth receiver program; `create_market` and `set_quote_source` derive it
 * from the feed id themselves. Devnet keeps the same accounts at the same
 * addresses. `proId` is the id of the same price in Pyth Pro, where the first
 * mark is checked against its latest price; the chain never sees it.
 */
export const MAINNET_PRICE_FEEDS = {
  solUsd: {
    feedId: feedId(
      "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
    ),
    proId: 6,
    account: new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"),
    expo: -8,
  },
  usdcUsd: {
    feedId: feedId(
      "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
    ),
    proId: 7,
    account: new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"),
    expo: -8,
  },
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

/** SECURITY.md, "Running a small mainnet market": what insurance is funded with and the gap it is sized for. */
export const MAINNET_INSURANCE = 3_000n * 1_000_000n;
export const MAINNET_SIZING = { mark: 150_000n, gapBps: 2_000n };
export const MAINNET_MAX_SEATS_PER_DAY = 5;

const MAINNET_PENALTY_BPS = 200;
const MAINNET_OPEN_INTEREST_CAP = openInterestCapFor(
  MAINNET_INSURANCE,
  MAINNET_SIZING.mark,
  MAINNET_SIZING.gapBps,
  BigInt(MAINNET_PENALTY_BPS),
);

/**
 * The launch settings of SECURITY.md, "Running a small mainnet market": at
 * most 5x, every perp fee to insurance, and the open interest cap sized from
 * insurance with a fifth of it per seat. Pyth pushes on a 0.5% move and a
 * 55 s heartbeat, so a 10 s age could not hold; the ages are to be confirmed
 * by a soak of the rollup's clock against each observation's publish time
 * before any deposit.
 */
export const MAINNET_LIMITS: MarketLimits = {
  ...LIMITS,
  imBps: 2_000,
  mmBps: 500,
  liqPenaltyBps: MAINNET_PENALTY_BPS,
  bandBps: 400,
  maxMoveBps: 250,
  takerFeeBps: 5,
  fundingCapBps: 50,
  maxPriceAge: 90n,
  maxAgeLiquidation: 180n,
  settleWindow: 900n,
  openInterestCap: MAINNET_OPEN_INTEREST_CAP,
  positionCap: MAINNET_OPEN_INTEREST_CAP / 5n,
  feeInsuranceShareBps: 10_000,
};

/** SOL/USD for a market of 0.001 SOL lots in 6-decimal USDC: $150 is 150,000 atoms per lot. */
export const MAINNET_SOL_SOURCE: PriceSourceSettings = {
  feedId: MAINNET_PRICE_FEEDS.solUsd.feedId,
  expo: MAINNET_PRICE_FEEDS.solUsd.expo,
  maxConfBps: 100,
  baseDecimals: 9,
  quoteDecimals: QUOTE_DECIMALS,
};

/** RULES 9a: perps turn reduce-only beyond 1% from a dollar, or 180 s after the last healthy USDC observation. */
export const MAINNET_QUOTE_SOURCE: QuoteSettings = {
  feedId: MAINNET_PRICE_FEEDS.usdcUsd.feedId,
  expo: MAINNET_PRICE_FEEDS.usdcUsd.expo,
  maxConfBps: 100,
  depegBps: 100,
  maxAge: 180n,
};

/** Circle's USDC on mainnet, the one mint the USDC/USD guard prices. */
export const MAINNET_USDC_MINT = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
);

/** The mainnet profile's collateral: USDC on mainnet, a test mint of the same decimals elsewhere. */
export const MAINNET_QUOTE_TOKEN = {
  index: 0,
  symbol: "USDC",
  decimals: QUOTE_DECIMALS,
};

/**
 * The one market the mainnet profile opens: the SOL perpetual in 0.001 SOL
 * lots and a tick of 10 quote atoms per lot, 0.01 USDC per SOL, bound to
 * Pyth's SOL/USD.
 */
export const MAINNET_MARKET = {
  id: 0,
  symbol: "SOL-PERP",
  baseDecimals: 9,
  settings: {
    kind: MARKET_KIND.perp,
    baseSymbol: "SOL",
    quoteSymbol: "USDC",
    baseToken: MAINNET_QUOTE_TOKEN.index,
    quoteToken: MAINNET_QUOTE_TOKEN.index,
    tick: 10n,
    baseLot: 1_000_000n,
    capacity: 1024,
    limits: MAINNET_LIMITS,
    priceSource: MAINNET_SOL_SOURCE,
  } satisfies MarketSettings,
};

/**
 * `baseDecimals` is how many decimals the base asset counts in, token or not.
 * Prices are quote atoms per lot: a lot is 0.001 SOL or 0.01 NVDA.
 * `initialMark` is the test networks' only: their markets are bound to no
 * source and the oracle key publishes it. A mainnet market starts with no mark
 * and takes its first from `sync_price`.
 */
export const MARKETS: {
  id: number;
  symbol: string;
  baseDecimals: number;
  initialMark: bigint;
  settings: MarketSettings;
}[] = [
  {
    id: 0,
    symbol: "NSOL-PERP",
    baseDecimals: 9,
    initialMark: 150_000n,
    settings: {
      kind: MARKET_KIND.perp,
      baseSymbol: "NSOL",
      quoteSymbol: "NUSD",
      baseToken: NUSD,
      quoteToken: NUSD,
      tick: 100n,
      baseLot: 1_000_000n,
      capacity: 1024,
      limits: LIMITS,
    },
  },
  {
    id: 1,
    symbol: "NNVDA-PERP",
    baseDecimals: 6,
    initialMark: 1_800_000n,
    settings: {
      kind: MARKET_KIND.perp,
      baseSymbol: "NNVDA",
      quoteSymbol: "NUSD",
      baseToken: NUSD,
      quoteToken: NUSD,
      tick: 1_000n,
      baseLot: 10_000n,
      capacity: 1024,
      limits: LIMITS,
    },
  },
  {
    id: 2,
    symbol: "NSOL-NUSD",
    baseDecimals: 9,
    initialMark: 150_000n,
    settings: {
      kind: MARKET_KIND.spot,
      baseSymbol: "NSOL",
      quoteSymbol: "NUSD",
      baseToken: NSOL,
      quoteToken: NUSD,
      tick: 100n,
      baseLot: 1_000_000n,
      capacity: 1024,
      limits: LIMITS,
    },
  },
];

export const PROFILES = ["test", "mainnet"] as const;
/**
 * What `setup` sets up. `test` is the test networks' exchange: two test mints
 * with a faucet and three markets priced by the oracle key. `mainnet` is the
 * launch of SECURITY.md: one quote token, one market priced by Pyth.
 */
export type Profile = (typeof PROFILES)[number];

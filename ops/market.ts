/**
 * The mainnet profile's market, its price feed and the USDC guard as the
 * rollup holds them, read the same way by the launch and by the drills: the
 * market refused unless it is the one the launch sets up, and its mark checked
 * against the reference price.
 */
import { PublicKey } from "@solana/web3.js";
import {
  MAX_MARKETS,
  ORACLE_HEALTH,
  QUOTE_STATE,
  clockOf,
  decodeExchange,
  decodeHeader,
  decodeMarket,
  decodePriceFeed,
  type Exchange,
  type MarketParams,
  type PriceFeed,
  type TokenInfo,
} from "../sdk/dist/index.js";
import {
  MAINNET_MARKET,
  MAINNET_QUOTE_TOKEN,
  MAINNET_SIZING,
  launchMarket,
  openInterestCapFor,
  type Target,
} from "./deployment";
import { gapBps, launchReferenceSources, settingsDiffer } from "./launch";
import { gatherQuotes, referenceOf } from "../sdk/dist/operator/index.js";

export { quoteBoundAsLaunched } from "./launch";

export const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  Buffer.from(a).equals(Buffer.from(b));

export async function exchangeInRollup(on: Target): Promise<Exchange> {
  const account = await on.rollup.getAccountInfo(
    on.instructions.addresses.exchange,
  );
  if (!account) {
    throw new Error("The exchange is not in the rollup. Run setup again.");
  }
  return decodeExchange(account.data);
}

/** The custody token the exchange records at the quote index. */
export async function quoteToken(on: Target): Promise<TokenInfo> {
  const token = (await exchangeInRollup(on)).tokens[MAINNET_QUOTE_TOKEN.index];
  if (token.mint.equals(PublicKey.default)) {
    throw new Error("The quote token is not registered. Run setup again.");
  }
  return token;
}

export async function priceFeedInRollup(
  on: Target,
  marketId: number,
): Promise<PriceFeed | null> {
  const feed = await on.rollup.getAccountInfo(
    on.instructions.addresses.priceFeed(marketId),
  );
  return feed && decodeHeader(feed.data).ready
    ? decodePriceFeed(feed.data)
    : null;
}

/** Every perp market the exchange has, by rising id. */
export async function perpMarketIds(on: Target): Promise<number[]> {
  const { perpMarkets } = await exchangeInRollup(on);
  return Array.from({ length: MAX_MARKETS }, (_, id) => id).filter(
    (id) => (perpMarkets >> id) & 1,
  );
}

/** RULES 9a: whether the guard lets perps grow at the rollup's `clock`. */
export const quotePasses = ({ quote }: Exchange, clock: number) =>
  quote.state === QUOTE_STATE.healthy && BigInt(clock) <= quote.okUntil;

/** The profile's market and its price feed, refused unless they are the ones the launch sets up, settings, limits and price source alike. */
export async function launchedMarket(
  on: Target,
): Promise<{ params: MarketParams; feed: PriceFeed }> {
  const { id, symbol, settings } = launchMarket(on.insurance);
  const [market, feed] = await Promise.all([
    on.rollup.getAccountInfo(on.instructions.addresses.market(id)),
    priceFeedInRollup(on, id),
  ]);
  if (!market || !feed) throw new Error(`${symbol} is not set up.`);
  const { params } = decodeMarket(market.data);
  const differ = settingsDiffer({ params, binding: feed.binding }, settings);
  if (differ.length > 0) {
    throw new Error(
      `${symbol} is not the market the launch sets up: ${differ.join("; ")}. Nothing was sent; it stays as it is.`,
    );
  }
  return { params, feed };
}

/**
 * The lots the insurance the launch funded covers across the planned gap from
 * `mark` (RULES 12), none while the market has no mark.
 */
export const lotsCovered = (
  on: Pick<Target, "insurance">,
  mark: bigint,
  { liqPenaltyBps }: Pick<MarketParams, "liqPenaltyBps">,
): bigint =>
  mark > 0n
    ? openInterestCapFor(
        on.insurance,
        mark,
        MAINNET_SIZING.gapBps,
        BigInt(liqPenaltyBps),
      )
    : 0n;

/** A Pyth mark is any atom; an order's price is a whole number of ticks. */
export const onTick = (price: bigint, tick: bigint) => (price / tick) * tick;

/** The fewest lots that clear the market's minimum notional at `price` and its minimum size. */
export function smallestSize(params: MarketParams, price: bigint): bigint {
  const forNotional = (params.minNotional + price - 1n) / price;
  return forNotional > params.minSize ? forNotional : params.minSize;
}

export type CheckedMark = {
  mark: bigint;
  reference: bigint;
  covered: bigint;
  openInterestCap: bigint;
  /** The mark's age by the rollup's clock, and the market's `max_price_age`, in seconds. */
  markAge: bigint;
  maxPriceAge: bigint;
  /** What a takeover of a seat at the position cap needs margin for: the cap in lots and the initial margin in bps. */
  positionCap: bigint;
  imBps: number;
  /** The USDC guard passes at the rollup's clock, and its state. */
  guardPasses: boolean;
  guardState: number;
  /** The launch market's price health, and whether it is healthy. */
  health: number;
  marketHealthy: boolean;
  /** Every perp market that records a shortfall, and the greatest of them (0 when none does). */
  shortfalls: { id: number; shortfall: bigint }[];
  shortfall: bigint;
};

/** Every perp market's recorded shortfall above zero, which `resume_market` refuses while any is. */
async function shortfallsOf(
  on: Target,
): Promise<{ id: number; shortfall: bigint }[]> {
  const found: { id: number; shortfall: bigint }[] = [];
  for (const id of await perpMarketIds(on)) {
    const account = await on.rollup.getAccountInfo(
      on.instructions.addresses.market(id),
    );
    if (!account) throw new Error(`Market ${id} cannot be read.`);
    const { uncoveredShortfall } = decodeMarket(account.data).params;
    if (uncoveredShortfall > 0n) {
      found.push({ id, shortfall: uncoveredShortfall });
    }
  }
  return found;
}

/**
 * The mark of the profile's market against the reference, in quote atoms per
 * lot: the median of the free public exchanges' SOL/USD prices (Coinbase,
 * Kraken, Bitstamp), with Pyth Pro's latest price added as one more source
 * when `PYTH_PRO_TOKEN` is set. Also the lots insurance covers across the
 * planned gap from that mark, once the market is the one the launch sets up
 * (`launchReferenceSources`), from `insurance` atoms, which is the insurance
 * the launch funded unless the caller knows the seat holds less.
 */
export async function checkedMark(
  on: Target,
  insurance = on.insurance,
): Promise<CheckedMark> {
  const { params, feed } = await launchedMarket(on);
  const { symbol } = MAINNET_MARKET;
  const { quotes, skipped } = await gatherQuotes(
    launchReferenceSources(
      on.mainnet,
      process.env.PYTH_PRO_TOKEN,
      fetch,
      process.env.PYTH_PRO_URL,
    ),
  );
  for (const { name, atoms, note } of quotes) {
    console.error(
      `reference source ${name}: ${atoms} quote atoms per lot${note ? ` (${note})` : ""}`,
    );
  }
  for (const { name, why } of skipped) {
    console.error(`reference source ${name} skipped: ${why}`);
  }
  const reference = referenceOf(quotes);
  const covered = lotsCovered({ insurance }, feed.price, params);
  const clock = await clockOf(on.rollup);
  const age = clock - Number(feed.publishTime);
  const exchange = await exchangeInRollup(on);
  const guardPasses = quotePasses(exchange, clock);
  const shortfalls = await shortfallsOf(on);
  console.error(
    `${symbol} mark ${feed.price} quote atoms per lot, ${age} s old; ` +
      `reference median ${reference} of ${quotes.length} sources (${quotes.map(({ name }) => name).join(", ")}); ` +
      `${feed.price > 0n ? gapBps(feed.price, reference) : "no"} bps apart; ` +
      `insurance covers ${covered} lots at this mark against an open interest cap of ${params.openInterestCap}`,
  );
  return {
    mark: feed.price,
    reference,
    covered,
    openInterestCap: params.openInterestCap,
    markAge: BigInt(age),
    maxPriceAge: params.maxPriceAge,
    positionCap: params.positionCap,
    imBps: params.imBps,
    guardPasses,
    guardState: exchange.quote.state,
    health: params.oracleHealth,
    marketHealthy: params.oracleHealth === ORACLE_HEALTH.healthy,
    shortfalls,
    shortfall: shortfalls.reduce(
      (most, { shortfall }) => (shortfall > most ? shortfall : most),
      0n,
    ),
  };
}

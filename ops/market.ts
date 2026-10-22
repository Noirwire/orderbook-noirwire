/**
 * The mainnet profile's market, its price feed and the USDC guard as the
 * rollup holds them, read the same way by the launch and by the drills: the
 * market refused unless it is the one the launch sets up, and its mark checked
 * against the reference price.
 */
import {
  MAX_MARKETS,
  QUOTE_STATE,
  clockOf,
  decodeExchange,
  decodeHeader,
  decodeMarket,
  decodePriceFeed,
  type Exchange,
  type MarketParams,
  type PriceFeed,
} from "../sdk/dist/index.js";
import {
  MAINNET_MARKET,
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

export type CheckedMark = {
  mark: bigint;
  reference: bigint;
  covered: bigint;
  openInterestCap: bigint;
};

/**
 * The mark of the profile's market against the reference, in quote atoms per
 * lot: the median of the free public exchanges' SOL/USD prices (Coinbase,
 * Kraken, Bitstamp), with Pyth Pro's latest price added as one more source
 * when `PYTH_PRO_TOKEN` is set. Also the lots insurance covers across the
 * planned gap from that mark, once the market is the one the launch sets up
 * (`launchReferenceSources`).
 */
export async function checkedMark(on: Target): Promise<CheckedMark> {
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
  const covered = lotsCovered(on, feed.price, params);
  const age = (await clockOf(on.rollup)) - Number(feed.publishTime);
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
  };
}

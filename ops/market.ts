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
  MAINNET_INSURANCE,
  MAINNET_MARKET,
  MAINNET_PRICE_FEEDS,
  MAINNET_QUOTE_SOURCE,
  MAINNET_SIZING,
  openInterestCapFor,
  type Target,
} from "./deployment";
import { gapBps, settingsDiffer } from "./launch";
import {
  gatherQuotes,
  referenceOf,
  referenceSources,
  referenceUrl,
} from "./pyth";

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

/** RULES 9a: whether the guard lets perps grow at the rollup's `clock`. */
export const quotePasses = ({ quote }: Exchange, clock: number) =>
  quote.state === QUOTE_STATE.healthy && BigInt(clock) <= quote.okUntil;

/** The profile's market and its price feed, refused unless they are the ones the launch sets up, settings, limits and price source alike. */
export async function launchedMarket(
  on: Target,
): Promise<{ params: MarketParams; feed: PriceFeed }> {
  const { id, symbol, settings } = MAINNET_MARKET;
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

/** The Pyth Pro id of the feed the launch binds. */
function proIdOfLaunch(): number {
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
 * planned gap from that mark, once the market is the one the launch sets up.
 * Pyth Pro is asked for the launch's own feed, by the Pro id the launch names
 * next to the Pyth Core feed id it binds, not for the feed the market names.
 */
export async function checkedMark(on: Target): Promise<CheckedMark> {
  const { params, feed } = await launchedMarket(on);
  const { symbol, settings } = MAINNET_MARKET;
  const { priceSource } = settings;
  const url = referenceUrl(on.mainnet);
  const token = process.env.PYTH_PRO_TOKEN;
  const pro = token ? { url, proId: proIdOfLaunch(), token } : undefined;
  const { quotes, skipped } = await gatherQuotes(
    referenceSources(
      {
        baseLot: settings.baseLot,
        baseDecimals: priceSource.baseDecimals,
        quoteDecimals: priceSource.quoteDecimals,
      },
      pro,
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
  const covered =
    feed.price > 0n
      ? openInterestCapFor(
          MAINNET_INSURANCE,
          feed.price,
          MAINNET_SIZING.gapBps,
          BigInt(params.liqPenaltyBps),
        )
      : 0n;
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

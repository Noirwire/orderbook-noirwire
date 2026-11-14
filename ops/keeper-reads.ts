/**
 * What the keeper reads of the rollup's public accounts each sweep: the
 * exchange, every perp market and its price feed. They come from an
 * `AccountWatch` (`ops/watching.ts`), which holds them current from
 * websocket notifications, so a sweep reads nothing over RPC for them.
 */
import { PublicKey } from "@solana/web3.js";
import {
  MAX_MARKETS,
  decodeExchange,
  decodeMarket,
  decodePriceFeed,
  liveSeatCapacity,
  type MarketParams,
} from "../sdk/dist/index.js";
import type { Target } from "./deployment";
import { SetupError } from "./upkeep";
import type { AccountWatch } from "./watching";

export type Held = Pick<AccountWatch, "get" | "fresh" | "markBusy">;
type Addresses = Pick<
  Target["instructions"]["addresses"],
  "exchange" | "market" | "priceFeed"
>;

export type PerpMarket = { id: number; params: MarketParams; mark: bigint };

/**
 * The seats the exchange's ledger holds, read from the exchange: the bound of
 * every sweep. An exchange that is not live (not migrated, or being copied)
 * has no ledger to sweep, which is a wrong setup and stops the keeper.
 */
export async function seatCapacity(
  addresses: Addresses,
  held: Held,
): Promise<number> {
  const account = await held.get(addresses.exchange);
  if (!account) throw new SetupError("The exchange is not in the rollup.");
  try {
    return liveSeatCapacity(decodeExchange(account.data));
  } catch (error) {
    throw new SetupError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** How many perp markets the exchange has, which sets how long a sweep of a large table takes. */
export async function perpMarketCount(
  addresses: Addresses,
  held: Held,
): Promise<number> {
  const account = await held.get(addresses.exchange);
  if (!account) throw new SetupError("The exchange is not in the rollup.");
  let bits = decodeExchange(account.data).perpMarkets;
  let count = 0;
  for (; bits > 0; bits >>= 1) count += bits & 1;
  return count;
}

export const markOf = async (
  addresses: Addresses,
  held: Held,
  id: number,
): Promise<bigint> => {
  const feed = await held.get(addresses.priceFeed(id));
  if (!feed) throw new Error(`market ${id}'s price feed is unreadable`);
  return decodePriceFeed(feed.data).price;
};

/**
 * Every perp market with its public settings and mark, as the rollup serves
 * them, and the id of each perp market whose market or price feed account
 * could not be read, which a sweep cannot cover. Where `fresh` is set the
 * market and feed accounts are read by hand first, ahead of their
 * notifications: after sends that changed them.
 */
export async function perpMarkets(
  addresses: Addresses,
  held: Held,
  fresh = false,
): Promise<{ markets: PerpMarket[]; unreadable: number[] }> {
  const exchange = await held.get(addresses.exchange);
  if (!exchange) throw new SetupError("The exchange is not in the rollup.");
  const { perpMarkets: bits } = decodeExchange(exchange.data);
  const ids = Array.from({ length: MAX_MARKETS }, (_, id) => id).filter(
    (id) => (bits >> id) & 1,
  );
  if (fresh) {
    await held.fresh(
      ids.flatMap((id) => [addresses.market(id), addresses.priceFeed(id)]),
    );
  }
  const markets: PerpMarket[] = [];
  const unreadable: number[] = [];
  for (const id of ids) {
    const [market, feed] = await Promise.all([
      held.get(addresses.market(id)),
      held.get(addresses.priceFeed(id)),
    ]);
    if (!market || !feed) {
      unreadable.push(id);
      continue;
    }
    const { params } = decodeMarket(market.data);
    const { price, binding } = decodePriceFeed(feed.data);
    if (!binding.account.equals(PublicKey.default)) {
      held.markBusy(binding.account);
    }
    markets.push({ id, params, mark: price });
  }
  return { markets, unreadable };
}

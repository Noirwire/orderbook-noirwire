import { cache } from "react";
import { PublicKey } from "@solana/web3.js";
import type { MarketState } from "./chain";
import { MAINNET_MARKET, MAINNET_SOL_FEED } from "./launch";
import type { Network } from "./networks";
import {
  gatherQuotes,
  referenceOf,
  referenceSources,
  referenceUrl,
  type Gathered,
  type Lot,
} from "./pyth";

export type Reference = Gathered & {
  /** The median, in quote atoms per lot, or why there is none. */
  median: bigint | null;
  why: string | null;
};

/** The lot a market's mark is in, when its price source names the decimals; a market bound to nothing has none. */
export function lotOf({ market, feed }: MarketState): Lot | null {
  if (!feed || feed.binding.account.equals(PublicKey.default)) return null;
  return {
    baseLot: market.params.baseLot,
    baseDecimals: feed.binding.baseDecimals,
    quoteDecimals: feed.binding.quoteDecimals,
  };
}

/** The lot the launch's market is priced in: its own settings, never the decimals a market on chain was bound with. */
export const LAUNCH_LOT: Lot = {
  baseLot: MAINNET_MARKET.settings.baseLot,
  baseDecimals: MAINNET_MARKET.settings.priceSource.baseDecimals,
  quoteDecimals: MAINNET_MARKET.settings.priceSource.quoteDecimals,
};

/**
 * The reference price of the launch's market, as `checkedMark` in the ops
 * scripts takes it: the median of Coinbase, Kraken and Bitstamp's SOL/USD,
 * with Pyth Pro's latest price of the launch's own feed added when the
 * server has `PYTH_PRO_TOKEN`, all in quote atoms per lot of the launch's
 * settings. A market bound with other decimals is then off by the same
 * factor from this reference, which is what the gap check catches.
 */
export const launchReference = cache(
  async (mainnet: boolean): Promise<Reference> => {
    const token = process.env.PYTH_PRO_TOKEN;
    let pro: { url: string; proId: number; token: string } | undefined;
    try {
      pro = token
        ? { url: referenceUrl(mainnet), proId: MAINNET_SOL_FEED.proId, token }
        : undefined;
    } catch (error) {
      return {
        quotes: [],
        skipped: [],
        median: null,
        why: error instanceof Error ? error.message : String(error),
      };
    }
    const gathered = await gatherQuotes(referenceSources(LAUNCH_LOT, pro));
    try {
      return { ...gathered, median: referenceOf(gathered.quotes), why: null };
    } catch (error) {
      return {
        ...gathered,
        median: null,
        why: error instanceof Error ? error.message : String(error),
      };
    }
  },
);

/** Whether `state` is the launch's market on a network of the launch profile, the one market a reference is taken for. */
export const isLaunchMarket = (network: Network, state: MarketState) =>
  network.profile === "mainnet" && state.id === MAINNET_MARKET.id;

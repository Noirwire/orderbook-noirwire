import { cache } from "react";
import { PublicKey } from "@solana/web3.js";
import { launchReferenceSources } from "@ops/launch";
import {
  gatherQuotes,
  referenceOf,
  type Gathered,
  type Lot,
} from "@ops/prices";
import { MAINNET_MARKET } from "@ops/profiles";
import type { MarketState } from "./chain";
import type { Network } from "./networks";

export type Reference = Gathered & {
  /** The median, in quote atoms per lot, or why there is none. */
  median: bigint | null;
  why: string | null;
};

/** `fetch` that Next.js never answers from its cache: every reference price is asked for fresh. */
export const freshFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, cache: "no-store" });

const reason = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** The lot a market's mark is in, when its price source names the decimals; a market bound to nothing has none. */
export function lotOf({ market, feed }: MarketState): Lot | null {
  if (!feed || feed.binding.account.equals(PublicKey.default)) return null;
  return {
    baseLot: market.params.baseLot,
    baseDecimals: feed.binding.baseDecimals,
    quoteDecimals: feed.binding.quoteDecimals,
  };
}

/**
 * The reference price of the launch's market, from the ops scripts' own
 * sources (`launchReferenceSources`): the median of Coinbase, Kraken and
 * Bitstamp's SOL/USD, with Pyth Pro's latest price of the launch's own feed
 * added when the server has `PYTH_PRO_TOKEN`, all in quote atoms per lot of
 * the launch's settings. A market bound with other decimals is then off by
 * the same factor from this reference, which is what the gap check catches.
 * The token is sent to Pyth Pro alone and never shown.
 */
export const launchReference = cache(
  async (mainnet: boolean): Promise<Reference> => {
    let sources;
    try {
      sources = launchReferenceSources(
        mainnet,
        process.env.PYTH_PRO_TOKEN,
        freshFetch,
      );
    } catch (error) {
      return { quotes: [], skipped: [], median: null, why: reason(error) };
    }
    const gathered = await gatherQuotes(sources);
    try {
      return { ...gathered, median: referenceOf(gathered.quotes), why: null };
    } catch (error) {
      return { ...gathered, median: null, why: reason(error) };
    }
  },
);

/** Whether `state` is the launch's market on a network of the launch profile, the one market a reference is taken for. */
export const isLaunchMarket = (network: Network, state: MarketState) =>
  network.profile === "mainnet" && state.id === MAINNET_MARKET.id;

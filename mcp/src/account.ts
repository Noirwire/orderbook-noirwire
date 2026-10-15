import type { View } from "@noirwire/orderbook";
import type { Deployment } from "./deployment.js";
import {
  averagePrice,
  chainToPrice,
  formatDecimal,
  lotsToSize,
  marketUnitsOf,
  quoteToDecimal,
} from "./units.js";

/** A token the exchange holds, and where its balance sits in a seat. */
export type TokenSlot = { symbol: string; decimals: number; index: number };

/**
 * Which seat slot holds which token: the exchange lists its token mints in
 * slot order, and the deployment names each mint's symbol and decimals.
 */
export function tokenSlots(
  exchangeMints: string[],
  deployment: Pick<Deployment, "markets">,
): TokenSlot[] {
  const known = new Map<string, { symbol: string; decimals: number }>();
  for (const market of deployment.markets) {
    for (const token of [market.baseToken, market.quoteToken]) {
      if (token) known.set(token.mint, token);
    }
  }
  const slots: TokenSlot[] = [];
  exchangeMints.forEach((mint, index) => {
    const token = known.get(mint);
    if (token)
      slots.push({ symbol: token.symbol, decimals: token.decimals, index });
  });
  return slots;
}

/**
 * A trader's view in human terms. The view lists open orders for one
 * market only, the one the last instruction named, so `openOrders` says
 * which.
 */
export function summariseView(
  view: View,
  deployment: Pick<Deployment, "markets">,
  tokens: TokenSlot[],
) {
  const { seat } = view.snapshot;

  const spotBalances = tokens.flatMap(({ symbol, decimals, index }) => {
    const slot = seat.spot[index];
    if (!slot) return [];
    return [
      {
        asset: symbol,
        available: formatDecimal(slot.available, decimals),
        locked: formatDecimal(slot.locked, decimals),
        total: formatDecimal(slot.available + slot.locked, decimals),
      },
    ];
  });

  const perpPositions = deployment.markets.flatMap((market) => {
    const slot = seat.perp[market.marketId];
    if (market.kind !== "perp" || !slot || slot.base === 0n) return [];
    const units = marketUnitsOf(market);
    const lots = slot.base < 0n ? -slot.base : slot.base;
    const cost = slot.quote < 0n ? -slot.quote : slot.quote;
    return [
      {
        market: market.symbol,
        side: slot.base > 0n ? ("long" as const) : ("short" as const),
        size: lotsToSize(units, lots),
        entryPrice: averagePrice(units, cost, lots) ?? "0",
      },
    ];
  });

  const ordersMarket =
    deployment.markets.find(
      (market) => market.marketId === view.snapshot.marketId,
    ) ?? null;
  const orderUnits = ordersMarket ? marketUnitsOf(ordersMarket) : null;
  const orders = orderUnits
    ? view.snapshot.orders.map((order) => ({
        orderId: order.sequence.toString(),
        side: order.side === 0 ? ("buy" as const) : ("sell" as const),
        price: chainToPrice(orderUnits, order.price),
        size: lotsToSize(orderUnits, order.remaining),
      }))
    : [];

  return {
    collateral: { asset: "nUSD", total: quoteToDecimal(seat.collateral) },
    spotBalances,
    perpPositions,
    openOrders: { market: ordersMarket?.symbol ?? null, orders },
  };
}

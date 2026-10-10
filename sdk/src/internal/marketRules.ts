import type { MarketParams } from "../accounts.js";
import type { OrderInvalid } from "../outcomes.js";

/**
 * Why the program would refuse an order on the market's public settings
 * alone, in the order the program checks them.
 */
export function refusalOnPublicSettings(
  { tick, minSize, minNotional }: MarketParams,
  order: { price: bigint; size: bigint },
): OrderInvalid["reason"] | undefined {
  if (order.size === 0n || order.size < minSize) return "SizeTooSmall";
  if (order.price <= 0n || order.price % tick !== 0n) return "PriceOffTick";
  if (order.price * order.size < minNotional) return "NotionalTooSmall";
  return undefined;
}

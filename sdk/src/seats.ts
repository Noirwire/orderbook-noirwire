import type { AssetKind } from "./instructions.js";

/**
 * The reason the program would refuse a deposit into a view, judged before
 * anything is sent, or null. A view that holds a seat takes any deposit. One
 * that does not takes a seat with the deposit, which must then be collateral
 * and, when the exchange sets a minimum (`Exchange.minSeatDeposit`, 0 for
 * none), at least that much.
 *
 * `seated` is true only when `TraderClient.confirmSeat` just said so. A
 * depositor who cannot sync the owner's view (a third party) passes false, so
 * the check always applies: a view that records a seat may have lost it to the
 * release sweep.
 */
export function seatDepositRefusal(
  minSeatDeposit: bigint,
  seated: boolean,
  asset: AssetKind,
  amount: bigint,
): string | null {
  if (seated) return null;
  if (!("collateral" in asset)) {
    return "the first deposit opens the trading account and must be collateral, not a spot balance";
  }
  if (minSeatDeposit > 0n && amount < minSeatDeposit) {
    return `the first deposit opens the trading account and must be at least ${minSeatDeposit} atoms of collateral`;
  }
  return null;
}

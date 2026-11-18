/**
 * What the set-price-source command decides, apart from the network so it can
 * be checked without one: whether it was asked to send, and whether the market
 * is in the state `set_price_source` needs.
 */
import { MARKET_STATUS } from "../sdk/dist/index.js";
import { applyRequested } from "./administering";

export type RebindRequest = {
  /** The operator asked to send it (`APPLY=yes`); without it the command only shows the change. */
  apply: boolean;
};

/** Whether the run sends: only `APPLY=yes`. Anything else that is set is refused rather than read as a dry run. */
export function rebindRequest(settings: { APPLY?: string }): RebindRequest {
  return { apply: applyRequested(settings) };
}

/** Why the market cannot be rebound now, or null: `set_price_source` is refused unless the market is paused. */
export function rebindRefusal(status: number): string | null {
  if (status === MARKET_STATUS.paused) return null;
  return "The market is not paused. Pause it first with make mainnet-market-status STATUS=paused APPLY=yes: the program rebinds a market's price source only while it is paused, and the market stays paused until resume_market. Nothing was sent.";
}

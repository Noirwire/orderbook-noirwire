import { Connection } from "@solana/web3.js";
import {
  MAX_MARKETS,
  decodeExchange,
  type Addresses,
  type Exchange,
} from "@noirwire/orderbook";

/** The perp markets of `exchange`, by rising id, as `resume_market` and `set_seat_access` take them. */
export const perpMarketIdsOf = ({ perpMarkets }: Exchange) =>
  Array.from({ length: MAX_MARKETS }, (_, id) => id).filter(
    (id) => (perpMarkets >> id) & 1,
  );

/** The exchange as the rollup holds it now, read for the values an instruction carries over. */
export async function exchangeNow(
  rollupUrl: string,
  addresses: Addresses,
): Promise<Exchange> {
  const account = await new Connection(rollupUrl, "confirmed").getAccountInfo(
    addresses.exchange,
  );
  if (!account) throw new Error("The exchange is not in the rollup.");
  return decodeExchange(account.data);
}

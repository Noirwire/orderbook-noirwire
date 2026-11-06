/**
 * Adds the BTC perpetual to the rehearsal: the market-only step of the
 * launch. It creates `BTC-PERP` bound to Pyth's BTC/USD, takes its first
 * mark, schedules its funding, records it in the deployment description and,
 * with `RESUME_MARKET=yes`, opens it once the first mark is within the
 * reference's gap, insurance covers its open interest cap and the keeper is
 * funded and running. Without it the market stays reduce-only and the run
 * says why it would not open. It adds nothing to mainnet: a deployment whose
 * Solana is mainnet is refused before anything is sent.
 *
 * The Makefile is the way in (`make rehearsal-add-btc-market`).
 */
import { run } from "./deployment";
import { btcMarketAdded } from "./adding";

run(btcMarketAdded);

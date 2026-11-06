/**
 * The insurance coverage check, on its own: for every perp market it prints
 * the lots insurance covers at the market's current mark against the market's
 * open interest, and whether that is ok, thin (under `COVERAGE_MARGIN_BPS` of
 * headroom, 2000 by default) or uncovered. It exits non-zero while any market
 * is uncovered. It only reads: it needs no key, pauses nothing and sends
 * nothing. `INSURANCE_HELD` (whole USDC) lowers the insurance it sizes from,
 * as in the mark check. The crank runs the same check every
 * `COVERAGE_EVERY` seconds and holds back its healthy ping while a market is
 * uncovered.
 *
 * The Makefile is the way in (`make rehearsal-coverage`,
 * `make mainnet-coverage`).
 */
import { run } from "./deployment";
import {
  anyUncovered,
  coverageLine,
  coverageMarginBps,
  coverageOfMarkets,
} from "./covering";
import { shown } from "./leaving";

run(async (on) => {
  const rows = await coverageOfMarkets(on, coverageMarginBps());
  for (const row of rows) shown(`market ${row.id} cover`, coverageLine(row));
  if (anyUncovered(rows)) {
    throw new Error("Insurance does not cover a market's open interest.");
  }
});

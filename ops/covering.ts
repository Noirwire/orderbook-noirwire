/**
 * The live insurance coverage check's work, apart from the process that runs
 * it so a test can run its math without a network: it only reads. A market is
 * covered while the lots insurance covers at its current mark (`lotsCovered`,
 * the same math the add-market sizing uses) are at least its open interest.
 */
import { decodeHeader, decodeMarket, decodeStats } from "../sdk/dist/index.js";
import { errorLine, type Target } from "./deployment";
import { at } from "./heartbeat";
import { insuranceNow, keeperDepositKnown } from "./keeping";
import { UnreadableInsurance } from "./launch";
import { lotsCovered, perpMarketIds, priceFeedInRollup } from "./market";
import { positiveInteger } from "./upkeep";

export const COVERAGE_STATUS = {
  ok: "ok",
  thin: "thin",
  uncovered: "uncovered",
} as const;
export type CoverageStatus =
  (typeof COVERAGE_STATUS)[keyof typeof COVERAGE_STATUS];

/** The headroom, in bps of open interest, under which a covered market reads as thin. */
export const DEFAULT_COVERAGE_MARGIN_BPS = 2_000;
/** Seconds between the crank's coverage reads. */
export const DEFAULT_COVERAGE_EVERY_SECONDS = 60;

const BPS = 10_000n;
const MAX_MARGIN_BPS = 100_000;

export const coverageMarginBps = () =>
  positiveInteger(
    "COVERAGE_MARGIN_BPS",
    process.env.COVERAGE_MARGIN_BPS,
    DEFAULT_COVERAGE_MARGIN_BPS,
    MAX_MARGIN_BPS,
  );

export const coverageEverySeconds = () =>
  positiveInteger(
    "COVERAGE_EVERY",
    process.env.COVERAGE_EVERY,
    DEFAULT_COVERAGE_EVERY_SECONDS,
  );

export type Coverage = {
  covered: bigint;
  required: bigint;
  status: CoverageStatus;
};

/** ok while `covered` clears `required` by `marginBps`, thin while it only clears `required`, uncovered below it. */
export function coverageStatus(
  covered: bigint,
  required: bigint,
  marginBps: number,
): Coverage {
  const status =
    covered < required
      ? COVERAGE_STATUS.uncovered
      : covered * BPS < required * (BPS + BigInt(marginBps))
        ? COVERAGE_STATUS.thin
        : COVERAGE_STATUS.ok;
  return { covered, required, status };
}

export const anyUncovered = (rows: readonly { status: CoverageStatus }[]) =>
  rows.some(({ status }) => status === COVERAGE_STATUS.uncovered);

export type MarketCoverage = Coverage & { id: number };

/** One perp market's coverage from `insurance` atoms, its current mark and its open interest. Reads only. */
export async function marketCoverage(
  on: Target,
  id: number,
  insurance: bigint,
  marginBps: number,
): Promise<MarketCoverage> {
  const { addresses } = on.instructions;
  const [market, feed, stats] = await Promise.all([
    on.rollup.getAccountInfo(addresses.market(id)),
    priceFeedInRollup(on, id),
    on.rollup.getAccountInfo(addresses.stats),
  ]);
  if (!market || !feed || !stats || !decodeHeader(stats.data).ready) {
    throw new Error(`Market ${id}'s coverage cannot be read.`);
  }
  const { params } = decodeMarket(market.data);
  const covered = lotsCovered({ insurance }, feed.price, params);
  const required = decodeStats(stats.data).openInterest[id];
  return { id, ...coverageStatus(covered, required, marginBps) };
}

/** Every perp market's coverage, sized from the insurance the seat can hold now. */
export async function coverageOfMarkets(
  on: Target,
  marginBps: number,
): Promise<MarketCoverage[]> {
  const insurance = await insuranceNow(on, await keeperDepositKnown(on));
  const rows: MarketCoverage[] = [];
  for (const id of await perpMarketIds(on)) {
    rows.push(await marketCoverage(on, id, insurance, marginBps));
  }
  return rows;
}

export const coverageLine = ({ covered, required, status }: Coverage) =>
  `${status}: insurance covers ${covered} lots against ${required} lots of open interest`;

/**
 * The crank's view of coverage: at most one read each `everySeconds`, and
 * whether some market is uncovered as of the last read. A read that fails is
 * logged and leaves the last answer standing.
 */
export function coverageWatch(
  on: Target,
  marginBps: number,
  everySeconds: number,
  now: () => number = Date.now,
): () => Promise<boolean> {
  let readAt = Number.NEGATIVE_INFINITY;
  let uncovered = false;
  return async () => {
    if (now() - readAt < everySeconds * 1_000) return uncovered;
    readAt = now();
    try {
      const rows = await coverageOfMarkets(on, marginBps);
      uncovered = anyUncovered(rows);
      for (const row of rows) {
        if (row.status === COVERAGE_STATUS.ok) continue;
        console.log(
          `${at()} market ${row.id} ${row.status === COVERAGE_STATUS.uncovered ? "ALERT " : ""}coverage ${coverageLine(row)}`,
        );
      }
    } catch (error) {
      const why =
        error instanceof UnreadableInsurance
          ? "custody cannot be read here (set INSURANCE_HELD)"
          : errorLine(error);
      console.log(`${at()} coverage not checked: ${why}`);
    }
    return uncovered;
  };
}

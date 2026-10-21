/**
 * What the crank and the liquidation keeper decide, apart from the network so
 * it can be checked without one.
 */
import {
  FEE_SEAT,
  INSURANCE_SEAT,
  LIQUIDATION_STATUS,
  ORACLE_HEALTH,
  QUOTE_STATE,
} from "../sdk/dist/index.js";

/**
 * A setting read from a variable: a positive whole number, or `fallback`
 * when it is not set. Anything else stops the process before it starts, since
 * a count that is not a number would never be reached and a pause that is
 * not one would not pause.
 */
export function positiveInteger(
  name: string,
  value: string | undefined,
  fallback: number | null,
): number {
  if (value === undefined || value === "") {
    if (fallback === null) throw new Error(`Set ${name}.`);
    return fallback;
  }
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${name} is ${value}, not a positive whole number.`);
  }
  return Number(value);
}

/**
 * What one sync of one source came to. `raced` is a refusal for an
 * observation that is not newer than the one recorded, or too soon after it:
 * another crank got there first, which is what two cranks are for.
 * `dislocated`, `settling` and `depegged` are a sync the program took that
 * left a price incident open (RULES 9 and 9a): a sync that succeeds can be
 * the one that starts it.
 */
export type SyncOutcome =
  | "synced"
  | "unchanged"
  | "raced"
  | "stale"
  | "refused"
  | "unreadable"
  | "dislocated"
  | "settling"
  | "depegged";

const FAILURES: ReadonlySet<SyncOutcome> = new Set([
  "stale",
  "refused",
  "unreadable",
  "dislocated",
  "settling",
  "depegged",
]);

/** The name `value` has in a table of the program's codes, such as `MARKET_STATUS`, or the number itself. */
export const nameIn = (table: Record<string, number>, value: number) =>
  Object.keys(table).find((name) => table[name] === value) ?? `${value}`;

/** The incident a market's `oracleHealth` records, or null while it is healthy. */
export function marketIncident(oracleHealth: number): SyncOutcome | null {
  if (oracleHealth === ORACLE_HEALTH.dislocated) return "dislocated";
  if (oracleHealth === ORACLE_HEALTH.settling) return "settling";
  return null;
}

/** The incident the USDC guard's state records, or null while it is healthy. */
export const guardIncident = (state: number): SyncOutcome | null =>
  state === QUOTE_STATE.healthy ? null : "depegged";

/** A round's outcome once the source's state is read: an open incident outranks anything but a failure. */
export const withIncident = (
  outcome: SyncOutcome,
  incident: SyncOutcome | null,
): SyncOutcome =>
  incident === null || FAILURES.has(outcome) ? outcome : incident;

/**
 * What to do about one source: send a sync for a newer observation, or say
 * why not. An account that has not changed is a failure once its observation
 * is older than the source's `max_age`, since the program would then refuse
 * it and everything that needs a fresh price stops.
 */
export function syncDecision(
  publishTime: number | null,
  recorded: number,
  clock: number,
  maxAge: number,
): "send" | SyncOutcome {
  if (publishTime === null) return "unreadable";
  if (clock - publishTime > maxAge) return "stale";
  return publishTime > recorded ? "send" : "unchanged";
}

/** RULES 9, checks 12 and the gap rule: `PriceTimeWentBackwards` and `PricePublishedTooSoon`. */
const RACED_CODES = [6070, 6073];
/** RULES 9, check 11: `PriceTooOld`. */
const STALE_CODES = [6079];

/** The program's error number in a failed send's text, or null. */
export function errorCode(message: string): number | null {
  const found = /"Custom":(\d+)/.exec(message);
  return found ? Number(found[1]) : null;
}

/** What a refused sync came to, by the program's error. */
export function refusalOutcome(message: string): SyncOutcome {
  const code = errorCode(message);
  if (code !== null && RACED_CODES.includes(code)) return "raced";
  if (code !== null && STALE_CODES.includes(code)) return "stale";
  return "refused";
}

/**
 * Consecutive failures per source after `outcome`: a failure adds one, and
 * anything else starts that source again at zero. Counted per source, so one
 * healthy feed does not hide another that keeps failing.
 */
export function afterOutcome(
  streaks: ReadonlyMap<string, number>,
  source: string,
  outcome: SyncOutcome,
): Map<string, number> {
  const next = new Map(streaks);
  next.set(source, FAILURES.has(outcome) ? (streaks.get(source) ?? 0) + 1 : 0);
  return next;
}

/** The first source that failed `limit` times in a row, or null. */
export function givenUp(
  streaks: ReadonlyMap<string, number>,
  limit: number,
): string | null {
  for (const [source, count] of streaks) if (count >= limit) return source;
  return null;
}

/**
 * The seats a sweep tries, below `seats`: every trader seat but the
 * keeper's own. Seats open at the lowest free index (RULES 12), so the
 * occupied ones sit at the bottom of the table, below the number the gate
 * has ever opened plus the two reserved ones.
 */
export function sweepTargets(seats: number, own: number): number[] {
  const reserved = new Set([FEE_SEAT, INSURANCE_SEAT, own]);
  return Array.from({ length: seats }, (_, seat) => seat).filter(
    (seat) => !reserved.has(seat),
  );
}

/**
 * The worst liquidation price the keeper states, blind to the target's side
 * (RULES 8.3). A long target is taken at the mark less the penalty and a
 * short one at the mark plus it, so the mark itself accepts either, and a
 * bankrupt target, taken at the mark, too.
 */
export const worstPriceFor = (mark: bigint) => mark;

export type Attempt =
  "liquidated" | "stale price" | "margin insufficient" | "nothing to liquidate";

export function attemptOf(status: number): Attempt {
  switch (status) {
    case LIQUIDATION_STATUS.liquidated:
      return "liquidated";
    case LIQUIDATION_STATUS.stalePrice:
      return "stale price";
    case LIQUIDATION_STATUS.liquidatorMarginInsufficient:
      return "margin insufficient";
    default:
      return "nothing to liquidate";
  }
}

/**
 * "Stale price" is decided before the target is read (RULES 8), so every
 * other seat would get it too: the sweep of that market ends there.
 */
export const endsSweep = (attempt: Attempt) => attempt === "stale price";

/**
 * Whether a sweep went wrong: an attempt that failed to send, or one the
 * keeper's own margin could not take, which means a liquidatable seat stays
 * as it is until the keeper is funded.
 */
export const sweepFailed = (counts: ReadonlyMap<string, number>) =>
  (counts.get("failed") ?? 0) > 0 ||
  (counts.get("margin insufficient") ?? 0) > 0;

/** The perp markets with a recorded shortfall, which `cover_shortfall` may lower. */
export function marketsOwed(
  markets: { id: number; uncoveredShortfall: bigint }[],
): number[] {
  return markets
    .filter(({ uncoveredShortfall }) => uncoveredShortfall > 0n)
    .map(({ id }) => id);
}

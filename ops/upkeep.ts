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
  SEATS,
} from "../sdk/dist/index.js";

/** The largest number the program keeps in 32 bits. */
export const U32_MAX = 0xffff_ffff;

/**
 * A setting read from a variable: a positive whole number up to `max`, or
 * `fallback` when it is not set. Anything else stops the process before it
 * starts, since a count that is not a number would never be reached, a pause
 * that is not one would not pause, and a number past what the program stores
 * would be cut to another one on the way.
 */
export function positiveInteger(
  name: string,
  value: string | undefined,
  fallback: number | null,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (value === undefined || value === "") {
    if (fallback === null) throw new Error(`Set ${name}.`);
    return fallback;
  }
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${name} is ${value}, not a positive whole number.`);
  }
  if (BigInt(value) > BigInt(max)) {
    throw new Error(`${name} is ${value}, more than ${max}.`);
  }
  return Number(value);
}

/**
 * An error that means the setup is wrong, such as a missing key or seat, an
 * exchange that is not in the rollup or no market bound to a price: running
 * on would not help, so the process stops at once.
 */
export class SetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupError";
  }
}

/**
 * What to do about an error caught at the end of a round. Only a setup that
 * is wrong stops the process: a `SetupError`, or the refusals the deployment
 * checks make ("Nothing was sent."). Every other error, such as a 5xx or 429
 * from an endpoint, a refused connection, a timeout or a fetch that failed,
 * is an outage that can end, so the round is counted as failed and retried.
 */
export function roundErrorKind(error: unknown): "fatal" | "retry" {
  if (error instanceof SetupError) return "fatal";
  if (error instanceof Error && error.message.includes("Nothing was sent.")) {
    return "fatal";
  }
  return "retry";
}

/** The longest pause after failed rounds, in milliseconds. */
export const MAX_BACKOFF_MS = 60_000;

/**
 * The pause before the next round: `everyMs` after a good round, doubled for
 * each round in a row that hit an error, but never beyond `MAX_BACKOFF_MS`
 * and never below `everyMs`.
 */
export function backoffMs(everyMs: number, erroredInARow: number): number {
  const doubled = everyMs * 2 ** Math.min(erroredInARow, 30);
  return Math.max(everyMs, Math.min(MAX_BACKOFF_MS, doubled));
}

/** The longest deadline a setting may name, in seconds: a timer holds 2^31 ms at most. */
export const MAX_DEADLINE_SECONDS = 3_600;

/**
 * Runs `work` and gives up on it after `seconds`: the promise rejects with an
 * error that names `what`, which `roundErrorKind` reads as an outage that can
 * end, so the round counts as failed and the loop goes on. A request that
 * never answers (a network outage can leave one pending for good) would
 * otherwise stop the loop for as long as it hangs. A request in flight cannot
 * be cancelled and its result is dropped, but `work` is handed a signal that
 * aborts with the deadline error when time is up: work that goes on to sign
 * more requests must check it (`signal.throwIfAborted()`) before each one, or
 * it keeps signing with the same keys while the next round starts.
 */
export async function withDeadline<T>(
  what: string,
  seconds: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const abandoned = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${what} did not finish within ${seconds} s`);
      abandoned.abort(error);
      reject(error);
    }, seconds * 1_000);
  });
  try {
    return await Promise.race([work(abandoned.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Why the keeper must not start on its seat, or null. A takeover needs the
 * keeper's own margin: a seat with no collateral would find every
 * liquidatable seat and be unable to take it.
 */
export function emptySeatRefusal(
  seat: number,
  collateral: bigint,
): string | null {
  if (collateral > 0n) return null;
  return `The keeper's seat ${seat} holds no collateral, so it could not take over a liquidatable seat. Fund it first: run the setup target with KEEPER_DEPOSIT.`;
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
 * occupied ones sit at the bottom of the table, below the highest index the
 * gate has ever opened plus one, the two reserved seats counted.
 */
export function sweepTargets(seats: number, own: number): number[] {
  const reserved = new Set([FEE_SEAT, INSURANCE_SEAT, own]);
  return Array.from({ length: seats }, (_, seat) => seat).filter(
    (seat) => !reserved.has(seat),
  );
}

/**
 * The exchange's public count of openings: the UTC day it counts and how many
 * seats the gate opened that day. It is the only public count of seats, and
 * it says nothing of earlier days.
 */
export type SeatCount = { day: bigint; opened: number };

/**
 * The sweep bound once the exchange's count has moved from `before` to `now`:
 * each opening it shows since is added to `seats`, never past the table.
 * Seats open at the lowest free index, so an opening raises the highest index
 * in use by one at most. Read sweep after sweep (`continuous`), a new day's
 * count is all new, and only openings of the old day after its last read go
 * uncounted, which the starting margin covers. Read after a gap, such as a
 * restart, the old day and every day between are taken as full, at
 * `maxPerDay` each, since nothing shows what they opened.
 */
export function seatsAfterCount(
  seats: number,
  before: SeatCount,
  now: SeatCount,
  maxPerDay: number,
  continuous: boolean,
): number {
  if (now.day < before.day) return seats;
  let added: number;
  if (now.day === before.day) {
    added = Math.max(0, now.opened - before.opened);
  } else if (continuous) {
    added = now.opened;
  } else {
    const between = Math.min(SEATS, Number(now.day - before.day - 1n));
    added =
      Math.max(0, maxPerDay - before.opened) + between * maxPerDay + now.opened;
  }
  return Math.min(SEATS, seats + added);
}

/**
 * When each market began ending its sweep at "stale price", for the markets
 * this sweep ended so: a market keeps the time it began while it stays stale,
 * and leaves the map on the first sweep that does not end so.
 */
export function staleSince(
  before: ReadonlyMap<number, number>,
  stale: number[],
  now: number,
): Map<number, number> {
  return new Map(stale.map((id) => [id, before.get(id) ?? now]));
}

/** The first market that has read "stale price" for longer than `limitSeconds`, or null. */
export function staleTooLong(
  since: ReadonlyMap<number, number>,
  now: number,
  limitSeconds: number,
): number | null {
  for (const [id, began] of since) {
    if (now - began > limitSeconds * 1_000) return id;
  }
  return null;
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

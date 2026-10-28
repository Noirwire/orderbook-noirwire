/**
 * What the crank and the liquidation keeper decide, apart from the network so
 * it can be checked without one.
 */
import {
  INSURANCE_SEAT,
  LIQUIDATION_STATUS,
  ORACLE_HEALTH,
  QUOTE_STATE,
  SIDE,
  type MarketParams,
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
  return `The keeper's seat ${seat} holds no collateral, so it could not take over a liquidatable seat. Fund it first: run the setup target with KEEPER_DEPOSIT, or, where the admin key is gone, the keeper-deposit target from any funded wallet.`;
}

/**
 * Slack on top of the keeper's pause for the rest of a sweep and the
 * rollup's lag: a sweep syncs the keeper's view first and then reads, and a
 * paused market is skipped, so this is a few round trips, not a sweep of the
 * table.
 */
const KEEPER_SWEEP_ALLOWANCE_MS = 30_000;

/**
 * How long a keeper may go between two writes of its view and still be
 * running. It writes once at the start of each sweep, so the gap holds a whole
 * sweep (up to its deadline, `KEEPER_DEADLINE` seconds, and a blind sweep of a
 * full table takes about 100 s), then its pause between sweeps
 * (`KEEPER_EVERY` seconds), the longest the pause grows to while it backs off
 * after errors, and the allowance. A keeper that has written nothing for
 * longer than this is not running, or is too hurt to be relied on.
 */
export const keeperLiveWindowMs = (
  everySeconds: number,
  sweepDeadlineSeconds = 180,
) =>
  sweepDeadlineSeconds * 1_000 +
  everySeconds * 1_000 +
  MAX_BACKOFF_MS +
  KEEPER_SWEEP_ALLOWANCE_MS;

/**
 * Whether the keeper wrote its view between two reads of it. Every sweep
 * syncs the view before it looks at any market, and a sync records a
 * result, so a running keeper moves this counter even while the market is
 * paused, and nothing else writes the keeper's view.
 */
export const keeperWrote = (
  before: { resultsWritten: number },
  after: { resultsWritten: number },
) => after.resultsWritten > before.resultsWritten;

/** What a run knows of the keeper before it relies on it. */
export type KeeperSeen = {
  /** The collateral in the keeper's view, null while it has no seat. */
  collateral: bigint | null;
  /** The run's own record says the keeper's deposit landed; a seat funded before records existed has none. */
  deposited: boolean;
  /** The view was written while this run watched it, or null if it did not watch. */
  wrote: boolean | null;
  /** The seconds the run watched for. */
  watchedSeconds: number;
};

/**
 * Why the keeper cannot be relied on to liquidate once the market opens, or
 * null: it has a seat, the seat is funded, and the view was written while
 * this run watched. The seat is funded when the deployment records the
 * deposit or the keeper's own view already shows collateral: the view lags the
 * seat but never exceeds it, so collateral above zero is proof of a deposit
 * even where nothing recorded it.
 */
export function keeperNotReady(seen: KeeperSeen): string | null {
  if (seen.collateral === null) {
    return "the keeper has no seat: run setup with KEEPER_DEPOSIT, which opens and funds it, then start the keeper (make mainnet-keeper or make rehearsal-keeper) and run this again";
  }
  if (!seen.deposited && seen.collateral <= 0n) {
    return "the keeper's seat is not funded: run setup with KEEPER_DEPOSIT, then start the keeper and run this again";
  }
  if (seen.wrote === null) return null;
  if (!seen.wrote) {
    return (
      `no keeper is running on the keeper's seat: its view was not written in the ${seen.watchedSeconds} s this run watched it, ` +
      "and a running keeper writes it every sweep, KEEPER_EVERY seconds apart and up to a minute more while it backs off. " +
      "Start the keeper (make mainnet-keeper or make rehearsal-keeper), wait for its first sweep to log, " +
      "give this run the same KEEPER_EVERY, and run this again"
    );
  }
  if (seen.collateral <= 0n) {
    return "the keeper's seat holds no collateral: run setup with KEEPER_DEPOSIT, wait for the keeper's next sweep, and run this again";
  }
  return null;
}

/**
 * What one sync of one source came to. `raced` is a refusal for an
 * observation that is not newer than the one recorded, or too soon after it:
 * another crank got there first, which is what two cranks are for.
 * `confidence` is a refusal of an observation that is newer than the one
 * recorded, because its confidence interval is wider than the market allows
 * (RULES 9, check 9): the market goes on at the last mark it accepted.
 * `dislocated`, `settling` and `depegged` are a sync the program took that
 * left a price incident open (RULES 9 and 9a): a sync that succeeds can be
 * the one that starts it.
 */
export type SyncOutcome =
  | "synced"
  | "unchanged"
  | "raced"
  | "stale"
  | "confidence"
  | "refused"
  | "unreadable"
  | "dislocated"
  | "settling"
  | "depegged";

const FAILURES: ReadonlySet<SyncOutcome> = new Set([
  "stale",
  "confidence",
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
/** RULES 9, check 9: `PriceConfidenceTooWide`. */
const CONFIDENCE_CODES = [6080];

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
  if (code !== null && CONFIDENCE_CODES.includes(code)) return "confidence";
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
 * Rounds in a row a source's newer observation may be refused for its
 * confidence before the crank calls it an incident. The observation is the
 * program's own to refuse, so a round that sent a sync for it is a present,
 * newer observation by construction (`syncDecision`): the market is then
 * valued at the last mark it accepted, which stays fresh for `max_age`,
 * while the price moves on.
 */
export const CONFIDENCE_INCIDENT_ROUNDS = 3;

/**
 * Consecutive rounds a source's newer observation was refused for its
 * confidence after `outcome`: a refusal adds one, anything else starts that
 * source again at zero.
 */
export function afterConfidence(
  streaks: ReadonlyMap<string, number>,
  source: string,
  outcome: SyncOutcome,
): Map<string, number> {
  const next = new Map(streaks);
  next.set(
    source,
    outcome === "confidence" ? (streaks.get(source) ?? 0) + 1 : 0,
  );
  return next;
}

/** The alert line for a source in a confidence incident: what is happening and what to do. */
export function confidenceAlert(
  source: string,
  rounds: number,
  maxAgeSeconds: number,
): string {
  return (
    `ALERT ${source}: the program has refused ${rounds} rounds in a row of newer Pyth prices because their confidence interval is too wide. ` +
    `Until a confident price lands, positions are valued at the last accepted mark, which counts as fresh for up to ${maxAgeSeconds} s, ` +
    "and the first confident price may be a jump the market settles at once. " +
    "Put the market in reduce-only status now with restrict_market from the admin console, and resume it only once prices are confident again and the mark check (make mainnet-markcheck) says a resume is safe"
  );
}

/** Whether some source has been refused for its confidence `alertAfter` rounds in a row, which is when the crank prints its alert. */
export const confidenceIncident = (
  refused: ReadonlyMap<string, number>,
  alertAfter: number,
) => [...refused.values()].some((rounds) => rounds >= alertAfter);

/**
 * Whether a round is good enough to tell a dead-man's switch the crank is
 * alive: no part of it hit an error, and no source is failing or in an
 * incident. A confidence incident (`confidenceIncident`) is not counted
 * here, and the crank holds its ping back for it as well, so the switch
 * rings while an alert stands.
 */
export const roundWasGood = (
  streaks: ReadonlyMap<string, number>,
  errored: boolean,
) => !errored && [...streaks.values()].every((rounds) => rounds === 0);

/** The seats a sweep starts at: the fee seat and the insurance seat hold no positions. */
export const FIRST_TRADER_SEAT = INSURANCE_SEAT + 1;

/** A run of seats, `count` of them from `start`, as one ranged call takes them. */
export type SeatRange = { start: number; count: number };

/**
 * The ranges that cover the trader seats below `capacity`, `size` seats at the
 * most in each. A seat is given back and taken again at any index, so the
 * whole table is swept, not the part of it the gate has opened. The program
 * passes over the keeper's own seat and every seat that cannot be taken.
 */
export function seatRanges(capacity: number, size: number): SeatRange[] {
  const ranges: SeatRange[] = [];
  for (let start = FIRST_TRADER_SEAT; start < capacity; start += size) {
    ranges.push({ start, count: Math.min(size, capacity - start) });
  }
  return ranges;
}

/** What the result of a `liquidate_range` call says about where the sweep stood. */
export type RangeResult = { orderSeq: bigint; status: number; code: number };

/**
 * The part of `range` a call left unvisited, or null when it ran through. A
 * call ends early after its takeover limit, or at a stale price, a takeover the
 * keeper's margin could not carry or one it has no slot for; `orderSeq` is
 * the first seat it did not finish with. The seat the margin could not carry
 * is passed over, so the next call does not stop at it again, and a call that
 * made no progress still moves on by one seat.
 */
export function restOfRange(
  range: SeatRange,
  result: RangeResult,
): SeatRange | null {
  const end = range.start + range.count;
  const skip =
    result.status === LIQUIDATION_STATUS.liquidatorMarginInsufficient;
  const from = Math.max(
    Number(result.orderSeq) + (skip ? 1 : 0),
    range.start + 1,
  );
  return from >= end ? null : { start: from, count: end - from };
}

/**
 * Why the ledger migration must not start from this machine, or null: it is
 * mainnet, where the admin is the console, or the exchange is still trading.
 * An exchange already on the new layout has nothing to refuse.
 */
export function relayoutRefusal(
  exchange: { paused: boolean; layoutState: string },
  onMainnet: boolean,
): string | null {
  if (onMainnet) {
    return "This is mainnet, where the admin is the console: run the ledger migration there. Nothing was sent.";
  }
  if (exchange.layoutState === "live") return null;
  if (!exchange.paused) {
    return "The exchange is not paused. Pause it first: the copy needs trading stopped. Nothing was sent.";
  }
  return null;
}

/** Whether a release sweep is due: none has run, or `everyMs` has passed since the last began. */
export const releaseDue = (
  lastBeganAt: number | null,
  now: number,
  everyMs: number,
) => lastBeganAt === null || now - lastBeganAt >= everyMs;

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
  | "liquidated"
  | "stale price"
  | "margin insufficient"
  | "slots full"
  | "nothing to liquidate";

export function attemptOf(status: number): Attempt {
  switch (status) {
    case LIQUIDATION_STATUS.liquidated:
      return "liquidated";
    case LIQUIDATION_STATUS.stalePrice:
      return "stale price";
    case LIQUIDATION_STATUS.liquidatorMarginInsufficient:
      return "margin insufficient";
    case LIQUIDATION_STATUS.liquidatorSlotsFull:
      return "slots full";
    default:
      return "nothing to liquidate";
  }
}

/**
 * "Stale price" is decided before the target is read (RULES 8), so every
 * other seat would get it too: the sweep of that market ends there. So does
 * a keeper seat with no slot left for it: it could take no seat on that market.
 */
export const endsSweep = (attempt: Attempt) =>
  attempt === "stale price" || attempt === "slots full";

/**
 * The alert line for a market the keeper cannot take over positions on: its
 * seat already holds positions or orders on four other markets.
 */
export const slotsFullAlert = (marketId: number) =>
  `market ${marketId}: ALERT, the keeper's seat holds positions or orders on four other markets, so it cannot take over a liquidation here. ` +
  "Close the positions it holds (the keeper unwinds them on its next sweeps), and keep each keeper key to at most four markets: " +
  "a fifth perp market needs a second keeper key with its own funded seat";

/**
 * Whether a sweep went wrong: an attempt that failed to send. A liquidatable
 * seat the keeper's own margin could not take is not one: it is an alert
 * (`marginAlert`) the operator answers by funding the keeper, and counting it
 * as a failed sweep would end the keeper after `KEEPER_GIVE_UP` of them, which
 * leaves nobody liquidating at all.
 */
export const sweepFailed = (counts: ReadonlyMap<string, number>) =>
  (counts.get("failed") ?? 0) > 0;

/** The alert line for a liquidatable seat the keeper's own margin cannot carry. */
export const marginAlert = (seat: number) =>
  `seat ${seat}: ALERT, liquidatable but the keeper's margin cannot carry its position, so nobody takes it and insurance pays its deficit if the price keeps moving. ` +
  "Deposit more collateral into the keeper's seat now: make mainnet-keeper-deposit MAINNET_PROGRAM_ID=<program id> KEYFILE=<a funded wallet's key file> AMOUNT=<whole USDC> " +
  "(make rehearsal-keeper-deposit on the rehearsal), signed by any funded wallet, not the admin's; " +
  "the keeper keeps sweeping and takes the seat on the first sweep its margin can carry it";

/**
 * What the keeper does about the position it holds on a market, as the
 * program lets it: a reduce-only order, which never rests (a reduce-only
 * order together with post only is refused, RULES 2), needs no listing, no
 * margin and no fresh feed (RULES 3, checks 1a and 4), and its size is
 * capped to the position by the program. `dust` is a position under the
 * market's minimum size or notional, which no order can close.
 */
export type Unwind =
  | { kind: "flat" }
  | { kind: "dust" }
  | { kind: "order"; side: number; size: bigint; price: bigint };

const BPS = 10_000n;

/**
 * The price an unwind accepts, inside the band: half the crossing band
 * (`band_bps`) from the mark, on the tick and at least one tick, rounded
 * towards the mark. A fill happens at each resting order's own price, so this
 * is only the worst the keeper gives up for getting out.
 */
export function unwindPrice(
  side: number,
  mark: bigint,
  params: Pick<MarketParams, "tick" | "bandBps">,
): bigint {
  const { tick, bandBps } = params;
  const halfBand = ((mark * BigInt(bandBps)) / BPS / 2n / tick) * tick;
  const reach = halfBand > tick ? halfBand : tick;
  if (side === SIDE.ask) return ((mark - reach + tick - 1n) / tick) * tick;
  return ((mark + reach) / tick) * tick;
}

/** The order that closes `base` lots (negative for a short), at the mark. */
export function unwindOrder(
  base: bigint,
  mark: bigint,
  params: Pick<MarketParams, "tick" | "bandBps" | "minSize" | "minNotional">,
): Unwind {
  if (base === 0n) return { kind: "flat" };
  const side = base > 0n ? SIDE.ask : SIDE.bid;
  const size = base > 0n ? base : -base;
  const price = unwindPrice(side, mark, params);
  if (size < params.minSize || price * size < params.minNotional) {
    return { kind: "dust" };
  }
  return { kind: "order", side, size, price };
}

/**
 * The alert line for a position the keeper could not close, or not close in
 * full: what is left and what to do. The keeper tries again on its next
 * sweep, so the alert stands until the position is flat.
 */
export const unwindAlert = (marketId: number, left: bigint, why: string) =>
  `market ${marketId}: ALERT, the keeper holds ${left > 0n ? left : -left} lots ${left > 0n ? "long" : "short"} it could not close (${why}). ` +
  "It tries again on every sweep. If this goes on, close the position from the keeper's seat by hand or bring orders to that side of the book, " +
  "since a position left to grow is liquidated and its deficit lands on insurance";

/**
 * The alert line for a position the keeper holds that is under the market's
 * minimum order size or notional, so no order of its own closes it. It is
 * printed on every sweep that finds the position, not once after the takeover,
 * and the sweep holds back its healthy ping while it stands: the position is
 * exposed, and a price move can liquidate it and put its deficit on insurance.
 */
export const dustAlert = (marketId: number, held: bigint, took: boolean) =>
  `market ${marketId}: ALERT, the keeper holds ${held > 0n ? held : -held} lots ${held > 0n ? "long" : "short"}${took ? " after a takeover" : ""}, under the market's minimum order size or notional, so no order closes it. ` +
  'It stays an alert on every sweep until the position is flat: a later takeover on the other side offsets it, or the operator offsets it by hand (docs/LAUNCH.md, "A position the keeper cannot close"). ' +
  "A position left to grow is liquidated and its deficit lands on insurance";

/**
 * Whether a sweep is healthy enough to send the dead-man's switch its ping:
 * nothing failed, no market ended at "stale price" and no alert stands (a
 * seat the keeper's margin cannot carry, a position it could not close, one
 * too small for any order to close, a checkpoint it could not keep).
 */
export const sweepHealthy = (failed: boolean, stale: number, alert: boolean) =>
  !failed && stale === 0 && !alert;

/** The perp markets with a recorded shortfall, which `cover_shortfall` may lower. */
export function marketsOwed(
  markets: { id: number; uncoveredShortfall: bigint }[],
): number[] {
  return markets
    .filter(({ uncoveredShortfall }) => uncoveredShortfall > 0n)
    .map(({ id }) => id);
}

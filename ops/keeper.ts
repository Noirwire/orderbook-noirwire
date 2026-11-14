/**
 * The operator's liquidation keeper (SECURITY.md, "Running a small mainnet
 * market").
 *
 * Nobody can read the ledger through the private endpoint, the operator
 * included: it is sealed by a permission with no members. So the keeper does
 * not look for seats below maintenance margin; it does what the program is
 * built for instead (RULES 8). From a funded seat of its own it sends
 * `liquidate_range` blind over every trader seat on every perp market, sweep
 * after sweep, at the mark as its worst price, read again before each batch,
 * and reads each outcome from its own view, which only its owner may read. A
 * seat that does not exist, holds no position or is above maintenance reads
 * the same: nothing to liquidate. While a market records a shortfall it also
 * sends `reconcile_shortfall` calls over the whole table at the start of the
 * pass, before the liquidation sweep, and `cover_shortfall_range` over every
 * seat after it, which anyone may call (RULES 8, steps 6 and 7). The reconcile
 * sweep's cursor is on chain, so it advances every pass and completes within
 * one pass from idle.
 *
 * The mainnet profile's setup funds the keeper's seat. A seat is taken by a
 * deposit and given back when it is empty, at any index, so the sweep covers
 * the whole table: its bound is the exchange's seat capacity, read from the
 * exchange each sweep, and nothing is kept on disk or set by hand. A sweep
 * sends `ORDER_KEYS` ranges of `KEEPER_RANGE` seats at a time, and a range a
 * call left unfinished (its takeover limit, or a seat the keeper's margin
 * could not carry) is sent again from where it stopped.
 *
 * Every `RELEASE_EVERY_MS` (ten minutes by default), beside the liquidation
 * sweep and never holding it up, the keeper also sends `release_empty_seats`
 * over the table in ranges of `RELEASE_RANGE` seats, which anyone may send: it
 * gives back the empty seats so the table does not fill with dust.
 *
 * Every instruction replaces the order key it signs with, so the keeper keeps
 * one set of keys for the life of the process and saves where they sit in the
 * derivation (a file of indices, no secret, `keeper-order-keys` beside the
 * keys) after each batch. A restart picks them up from it instead of
 * searching from index 0, which gives up past 100,000 rotations, about seven
 * hours of sweeping.
 *
 * A position the keeper takes over is closed at once: after each batch that
 * took one, and at the start of a sweep for what an earlier one left, the
 * keeper sends one reduce-only order for the whole position, priced half the
 * crossing band from the mark. The program refuses a reduce-only order that is
 * also post only, and a reduce-only order never rests, so it fills against what
 * the book shows inside that price and the rest is tried again on the next
 * sweep. It needs no margin and no listing. A position it could not close,
 * or not in full, is an `ALERT` line that says what to do, never a failed
 * sweep: a keeper that stopped for it would leave nobody liquidating.
 *
 * A sweep fails when an attempt fails to send, a cover fails, or a perp market
 * or its price feed cannot be read. A liquidatable seat the keeper's own
 * margin cannot take is an `ALERT` line that says to fund the keeper, and no
 * failed sweep for the same reason. After `KEEPER_GIVE_UP` failed sweeps in a
 * row the keeper exits non-zero, so its supervisor tells someone. It also
 * exits non-zero once one market has ended every sweep at
 * "stale price" for longer than `KEEPER_STALE_GIVE_UP` seconds, 1,800 by
 * default: then it can liquidate nobody there, and a price incident that the
 * program settles within its settle window does not last that long. A sweep
 * has a deadline too, `KEEPER_DEADLINE` seconds (by default 180 or, on a large
 * table, two seconds for each round of ranges on each perp market): a request
 * that never answers ends it as failed instead of holding the keeper, and the
 * sweep sends nothing more once its deadline has passed. An error that stops a whole sweep (an
 * endpoint's 5xx or 429, a refused connection, a timeout) is logged, counts as
 * a failed sweep and doubles the pause before the next, up to 60 s, back to
 * `KEEPER_EVERY` after a good one. A wrong setup (a key file that cannot be
 * read, no seat, a seat without collateral on the first sweep, an exchange not
 * in the rollup) stops it at once: a takeover needs the keeper's own margin.
 * With `HEALTHCHECK_URL` set, each sweep that did not fail, ended no market
 * at "stale price" and left no ALERT standing (a liquidatable seat its margin
 * cannot carry, a position it could not close) sends a plain GET to it, for a
 * dead-man's switch outside the server, so the switch means healthy and not
 * only alive; a ping that fails is logged and dropped.
 *
 * Last in each pass, the keeper also sends one `sweep_triggers` call per perp
 * market, which drops the take-profit and stop-loss triggers that no longer
 * belong to their seat. The trigger book keeps its cursor on chain, so every
 * pass reads the next `SWEEP_TRIGGER_SLOTS_PER_CALL` slots and the passes
 * together cover the whole book. A trigger is safe whether or not it is swept,
 * so a call that fails is said and stands as an alert (it holds back the
 * ping and shows in the status's failed steps), and never fails the pass or
 * holds up a step before it.
 *
 * The exchange, the markets and their price feeds are held in memory from
 * websocket subscriptions (`ops/watching.ts`, as the crank does), so a sweep
 * reads none of them over RPC: only the sends and the keeper's own signed-in
 * view go over the network. The sweeps still run every `KEEPER_EVERY`
 * seconds. A busy account with no news for 2 s, or a change that a check read
 * (every 10 s) shows and the socket never delivered, makes the keeper read
 * by hand once a second; a missed change fails the sweep like any other
 * fault. `ROLLUP_WS_URL` names the websocket.
 *
 * With `KEEPER_STATUS_PORT` set, the keeper also answers a service's signed
 * status request over HTTP (`ops/keeper-status.ts`).
 *
 * The Makefile is the way in (`make rehearsal-keeper`).
 */
import { Connection, type Keypair } from "@solana/web3.js";
import {
  MARKET_STATUS,
  ORDER_KEYS,
  ORDER_TYPE,
  OrderKeyManager,
  RECONCILE_SEATS_PER_CALL,
  RELEASE_SEATS_PER_CALL,
  RESULT_STATUS,
  SIDE,
  SWEEP_TRIGGER_SLOTS_PER_CALL,
  TraderClient,
  decodeView,
  positionOn,
  type MarketParams,
  type OrderResult,
} from "../sdk/dist/index.js";
import {
  errorLine,
  keeperKeysPath,
  keyPath,
  rollupIsRunBy,
  run,
  sendingAs,
  type Target,
} from "./deployment";
import {
  HEARTBEAT_FILE_LABEL,
  HEARTBEAT_LABEL,
  at,
  heartbeatFile,
  heartbeatTo,
  heartbeatUrl,
} from "./heartbeat";
import {
  afterSweep,
  keeperStatusSettings,
  serveKeeperStatus,
  type KeeperStatusSettings,
  type SweepRecord,
} from "./keeper-status";
import {
  markOf as heldMarkOf,
  perpMarketCount as heldPerpMarketCount,
  perpMarkets as heldPerpMarkets,
  seatCapacity as heldSeatCapacity,
  type PerpMarket,
} from "./keeper-reads";
import { keepOrderKeys, keyAt, orderKeysFor, readingAs } from "./keys";
import { deployedAsBuilt } from "./program";
import { send, sleep, withFullBudget } from "./sending";
import {
  SetupError,
  attemptOf,
  backoffMs,
  dustAlert,
  emptySeatRefusal,
  endsSweep,
  marginAlert,
  marketsOwed,
  passSteps,
  reconcileCalls,
  positiveInteger,
  releaseDue,
  restOfRange,
  roundErrorKind,
  seatRanges,
  slotsFullAlert,
  staleSince,
  staleTooLong,
  MAX_DEADLINE_SECONDS,
  passDeadlineSeconds,
  passIsSlow,
  stillOwed,
  sweepFailed,
  sweepHealthy,
  unwindAlert,
  unwindOrder,
  withDeadline,
  worstPriceFor,
  type Attempt,
  type SeatRange,
} from "./upkeep";
import { AccountWatch } from "./watching";

type Settings = {
  status: KeeperStatusSettings | null;
  rangeSeats: number;
  releaseEveryMs: number;
  releaseRangeSeats: number;
  everySeconds: number;
  giveUpAfter: number;
  staleGiveUpSeconds: number;
  deadlineSeconds: number | null;
  healthcheck: string | null;
  heartbeatPath: string | undefined;
};

/**
 * The least a sweep may be given, and what the read of the exchange's seat
 * count is given. A request that never answers in an outage would otherwise
 * hold the keeper for as long as it hangs; past its deadline the sweep counts
 * as failed and the next one starts. A sweep of a large table takes about a
 * round trip per `ORDER_KEYS` ranges of `KEEPER_RANGE` seats and market, so
 * unless `KEEPER_DEADLINE` names one, each sweep's deadline is the more of this
 * and two seconds for each such round on each perp market, worked out from the
 * seat capacity and market count read at its start.
 */
const DEADLINE_SECONDS = 180;

/**
 * The seats one `liquidate_range` call looks at, unless `KEEPER_RANGE` says
 * another number. The call has the 400,000 units `extend_compute` gives: 64
 * seats with four takeovers measure about 250,000, while 128 already exceed it.
 */
const DEFAULT_RANGE_SEATS = 64;
/** The most takeovers one `liquidate_range` call makes before it ends. */
const TAKEOVERS_PER_CALL = 4;
/** The seats one `cover_shortfall_range` call looks at. */
const COVER_RANGE_SEATS = 256;
/** Ten minutes between release sweeps, unless `RELEASE_EVERY_MS` says another. */
const DEFAULT_RELEASE_EVERY_MS = 600_000;
/** The most a seat count, a range or a call's seats may be: the program takes 16 bits of count. */
const U16_MAX = 0xffff;

function settings(): Settings {
  return {
    status: keeperStatusSettings(process.env),
    rangeSeats: positiveInteger(
      "KEEPER_RANGE",
      process.env.KEEPER_RANGE,
      DEFAULT_RANGE_SEATS,
      U16_MAX,
    ),
    releaseEveryMs: positiveInteger(
      "RELEASE_EVERY_MS",
      process.env.RELEASE_EVERY_MS,
      DEFAULT_RELEASE_EVERY_MS,
    ),
    releaseRangeSeats: positiveInteger(
      "RELEASE_RANGE",
      process.env.RELEASE_RANGE,
      RELEASE_SEATS_PER_CALL,
      RELEASE_SEATS_PER_CALL,
    ),
    everySeconds: positiveInteger("KEEPER_EVERY", process.env.KEEPER_EVERY, 1),
    giveUpAfter: positiveInteger(
      "KEEPER_GIVE_UP",
      process.env.KEEPER_GIVE_UP,
      6,
    ),
    staleGiveUpSeconds: positiveInteger(
      "KEEPER_STALE_GIVE_UP",
      process.env.KEEPER_STALE_GIVE_UP,
      1_800,
    ),
    deadlineSeconds: process.env.KEEPER_DEADLINE
      ? positiveInteger(
          "KEEPER_DEADLINE",
          process.env.KEEPER_DEADLINE,
          null,
          MAX_DEADLINE_SECONDS,
        )
      : null,
    healthcheck: heartbeatUrl(process.env.HEALTHCHECK_URL),
    heartbeatPath: process.env.KEEPER_HEARTBEAT_FILE,
  };
}

/**
 * The keeper's copy of the rollup's public accounts (`ops/watching.ts`), made
 * when it starts: the reads below take the exchange, the markets and the price
 * feeds from it, and send nothing over RPC in steady state.
 */
let rollupWatch: AccountWatch;

const seatCapacity = (on: Target) =>
  heldSeatCapacity(on.instructions.addresses, rollupWatch);
const perpMarketCount = (on: Target) =>
  heldPerpMarketCount(on.instructions.addresses, rollupWatch);
const markOf = (on: Target, id: number) =>
  heldMarkOf(on.instructions.addresses, rollupWatch, id);
const perpMarkets = (on: Target, fresh = false) =>
  heldPerpMarkets(on.instructions.addresses, rollupWatch, fresh);

/** The capacity after this sweep's read of the exchange, said when it grew. */
async function capacityNow(on: Target, before: number | null) {
  const capacity = await seatCapacity(on);
  if (before !== null && capacity > before) {
    console.log(
      `${at()} the ledger grew by ${capacity - before} seats: sweeping seats below ${capacity}`,
    );
  }
  return capacity;
}

/** Whether a save of the order key checkpoint failed during the sweep under way, which then fails. */
let checkpointFailed = false;

/** Saves the keys' places, and remembers a failed save for the sweep to fail on. */
function keptKeys(on: Target, client: TraderClient): void {
  if (!keepOrderKeys(keeperKeysPath(on), client.keys)) checkpointFailed = true;
}

/**
 * The keeper's order keys, kept for the life of the process. Every instruction
 * replaces the key it signs with, so a keeper that searched for its keys from
 * index 0 at each sweep would stop finding them past 100,000 rotations.
 */
type HeldKeys = { manager: OrderKeyManager | null };

/**
 * The keeper as a trader, signed in afresh for each sweep, since a private
 * endpoint's sign-in runs out. It signs with the same order keys as the sweep
 * before, brought in line with its view; only the first sweep after a start
 * picks them up from the checkpoint kept beside the keeper's key. A
 * sweep given up on after its deadline stops at the first check of `signal`,
 * before it touches the keys held for the next.
 */
async function signedIn(
  on: Target,
  owner: Keypair,
  held: HeldKeys,
  signal: AbortSignal,
) {
  const reader = await readingAs(on.privateUrl, owner);
  const view = await reader.getAccountInfo(
    on.instructions.addresses.view(owner.publicKey),
  );
  signal.throwIfAborted();
  if (!view) {
    throw new SetupError(
      `The keeper ${owner.publicKey.toBase58()} has no seat. Run the setup target with KEEPER_DEPOSIT.`,
    );
  }
  const keys = orderKeysFor(
    owner.secretKey.subarray(0, 32),
    decodeView(view.data),
    keeperKeysPath(on),
    held.manager,
  );
  held.manager = keys;
  const client = new TraderClient(
    await sendingAs(on, owner),
    reader,
    owner.publicKey,
    keys,
    on.instructions.programId,
    { push: false },
  );
  await client.ready();
  return client;
}

/** What a `liquidate_range` call came to, as one line; `orderSeq` is where it stopped. */
function described(
  range: SeatRange,
  attempt: Attempt,
  result: OrderResult,
  marketId: number,
): string {
  const seats = `seats ${range.start} to ${range.start + range.count - 1}`;
  const stoppedAt = Number(result.orderSeq);
  if (attempt === "margin insufficient") return marginAlert(stoppedAt);
  if (attempt === "slots full") return slotsFullAlert(marketId);
  if (result.code === 0) return `${seats}: ${attempt}`;
  return (
    `${seats}: ${result.code} takeovers, took ${result.filled} lots for ${result.filledNotional} quote atoms, ` +
    `cancelled ${result.cancelled} of their orders, insurance and fees paid ${result.fee}, ${result.rested} left uncovered`
  );
}

/**
 * Closes what the keeper holds on a market with one reduce-only order inside
 * the band (`unwindOrder`), read from its own view after a sync. Trouble with
 * the order is an alert line and never an error, so a position the market will
 * not take back does not count as a failed sweep; a read that fails does throw,
 * like any other read of a sweep. `afterTakeover` says a takeover just left the
 * position, which is when a position too small for any order is worth a line.
 * Resolves to whether an alert stands: a position is left that was not closed.
 */
async function unwound(
  on: Target,
  client: TraderClient,
  market: PerpMarket,
  signal: AbortSignal,
  afterTakeover: boolean,
): Promise<boolean> {
  signal.throwIfAborted();
  await client.syncView(market.id);
  signal.throwIfAborted();
  const held = positionOn((await client.view()).snapshot.seat, market.id).base;
  const unwind = unwindOrder(held, await markOf(on, market.id), market.params);
  if (unwind.kind === "flat") return false;
  const lots = held > 0n ? held : -held;
  if (unwind.kind === "dust") {
    console.log(`${at()} ${dustAlert(market.id, held, afterTakeover)}`);
    return true;
  }
  signal.throwIfAborted();
  let placed;
  try {
    placed = await client.placeOrder(market.id, {
      side: unwind.side,
      orderType: ORDER_TYPE.market,
      price: unwind.price,
      size: unwind.size,
      reduceOnly: true,
    });
  } catch (error) {
    signal.throwIfAborted();
    console.log(`${at()} ${unwindAlert(market.id, held, errorLine(error))}`);
    return true;
  }
  keptKeys(on, client);
  if (placed.outcome !== "placed") {
    const why =
      placed.outcome === "unknown"
        ? "the order's outcome is not known yet"
        : "the order expired without running";
    console.log(`${at()} ${unwindAlert(market.id, held, why)}`);
    return true;
  }
  const { status, code, filled, filledNotional, fee } = placed.result;
  console.log(
    `${at()} market ${market.id} unwind: ${unwind.side === SIDE.ask ? "sold" : "bought"} ${filled} of ${lots} lots for ${filledNotional} quote atoms, ` +
      `fee ${fee}, no worse than ${unwind.price} per lot`,
  );
  const left = held > 0n ? held - filled : held + filled;
  if (left !== 0n) {
    const why =
      status === RESULT_STATUS.refused
        ? `the program refused the order, error ${6000 + code}`
        : `${filled} of ${lots} lots filled inside the price limit`;
    console.log(`${at()} ${unwindAlert(market.id, left, why)}`);
  }
  return left !== 0n;
}

/**
 * One sweep of one market over the whole table, `ORDER_KEYS` ranges at a time
 * at the mark read just before each batch, until done or a stale price (or a
 * keeper seat with no slot left for the market) ends it. A range a call left
 * unfinished is sent again from where it stopped. Resolves to what the calls
 * came to, counted, and whether an alert stands: a seat the keeper's margin
 * could not take, or a position it could not close. The order keys' places are
 * saved after each batch, so a restart is never more than a batch behind them.
 * A sweep given up on stops before its next batch.
 */
async function swept(
  on: Target,
  client: TraderClient,
  market: PerpMarket,
  capacity: number,
  rangeSeats: number,
  signal: AbortSignal,
): Promise<{ counts: Map<string, number>; alert: boolean }> {
  const began = Date.now();
  let alert = false;
  const counts = new Map<string, number>();
  const counted = (what: string, by = 1) =>
    counts.set(what, (counts.get(what) ?? 0) + by);
  const pending = seatRanges(capacity, rangeSeats);
  let mark = market.mark;
  while (pending.length > 0) {
    signal.throwIfAborted();
    mark = await markOf(on, market.id);
    signal.throwIfAborted();
    const batch = pending.splice(0, ORDER_KEYS);
    const results = await Promise.all(
      batch.map((range) =>
        client
          .liquidateRange(market.id, {
            ...range,
            size: market.params.openInterestCap,
            worstPrice: worstPriceFor(mark),
            maxTakeovers: TAKEOVERS_PER_CALL,
          })
          .then((result) => {
            const attempt = attemptOf(result.status);
            if (result.code > 0) counted("liquidated", result.code);
            else if (attempt === "nothing to liquidate")
              counted("ranges clear");
            else counted(attempt);
            if (result.code > 0 || attempt !== "nothing to liquidate") {
              console.log(
                `${at()} market ${market.id} ${described(range, attempt, result, market.id)}`,
              );
            }
            if (attempt === "margin insufficient" || attempt === "slots full") {
              alert = true;
            }
            return { range, result, attempt };
          })
          .catch((error: Error) => {
            counted("failed");
            console.log(
              `${at()} market ${market.id} seats ${range.start} to ${range.start + range.count - 1}: failed, ${errorLine(error)}`,
            );
            return null;
          }),
      ),
    );
    keptKeys(on, client);
    const finished = results.flatMap((each) => (each === null ? [] : [each]));
    if (finished.some(({ result }) => result.code > 0)) {
      if (await unwound(on, client, market, signal, true)) alert = true;
    }
    const ended = finished.find(({ attempt }) => endsSweep(attempt));
    if (ended) {
      console.log(
        `${at()} market ${market.id}: ${ended.attempt}, so the sweep of this market ends`,
      );
      break;
    }
    const rests = finished.flatMap(({ range, result }) => {
      const rest = restOfRange(range, result);
      return rest === null ? [] : [rest];
    });
    pending.unshift(...rests);
  }
  const summary = [...counts]
    .map(([what, count]) => `${count} ${what}`)
    .join(", ");
  console.log(
    `${at()} market ${market.id} swept in ${Date.now() - began} ms, last at mark ${mark}: ${summary || "nothing tried"}`,
  );
  return { counts, alert };
}

/**
 * Gives back the empty seats of the table, `rangeSeats` at a time, with
 * `release_empty_seats`. It runs beside the liquidation sweep and is not part
 * of it: a call that fails is said and the next range goes on, since the
 * seats it missed are looked at again by the next release sweep.
 */
async function released(
  on: Target,
  owner: Keypair,
  capacity: number,
  rangeSeats: number,
): Promise<void> {
  const began = Date.now();
  const sender = await sendingAs(on, owner);
  let failed = 0;
  const ranges = seatRanges(capacity, rangeSeats);
  for (const { start, count } of ranges) {
    await send(
      sender,
      withFullBudget(
        on.instructions.releaseEmptySeats(owner.publicKey, start, count),
      ),
      owner,
    ).catch((error: Error) => {
      failed += 1;
      console.log(
        `${at()} release of seats ${start} to ${start + count - 1} failed: ${errorLine(error)}`,
      );
    });
  }
  console.log(
    `${at()} release sweep of seats below ${capacity}: ${ranges.length - failed} of ${ranges.length} calls in ${Date.now() - began} ms`,
  );
}

/**
 * RULES 8.6: while a market records a shortfall, sends the calls that read the
 * whole table, one per transaction. The sweep's cursor is kept on chain, so
 * each pass advances a sweep and one from idle completes within the pass. A
 * call that fails is said and the rest of the pass goes on. Resolves to
 * whether any of it failed.
 */
async function reconciled(
  on: Target,
  owner: Keypair,
  markets: PerpMarket[],
  capacity: number,
  signal: AbortSignal,
): Promise<boolean> {
  let failed = false;
  const sender = await sendingAs(on, owner);
  const calls = reconcileCalls(capacity);
  for (let call = 1; call <= calls; call += 1) {
    signal.throwIfAborted();
    await send(
      sender,
      withFullBudget(
        on.instructions.reconcileShortfall(
          markets.map(({ id }) => id),
          RECONCILE_SEATS_PER_CALL,
        ),
      ),
      owner,
    ).catch((error: Error) => {
      failed = true;
      console.log(
        `${at()} reconcile call ${call} of ${calls} failed: ${errorLine(error)}`,
      );
    });
  }
  return failed;
}

/**
 * RULES 8, step 6: covers every flat seat in debt on each market that records
 * a shortfall. Resolves to whether any of it failed.
 */
async function covered(
  on: Target,
  owner: Keypair,
  markets: PerpMarket[],
  capacity: number,
  signal: AbortSignal,
): Promise<boolean> {
  const owed = marketsOwed(
    markets.map(({ id, params }) => ({
      id,
      uncoveredShortfall: params.uncoveredShortfall,
    })),
  );
  if (owed.length === 0) return false;
  let failed = false;
  const failure = (what: string) => (error: Error) => {
    failed = true;
    console.log(`${at()} ${what} failed: ${errorLine(error)}`);
  };
  const shortfall = (of: PerpMarket[], id: number) =>
    of.find((market) => market.id === id)?.params.uncoveredShortfall;
  const sender = await sendingAs(on, owner);
  for (const id of owed) {
    console.log(
      `${at()} market ${id} records a shortfall of ${shortfall(markets, id)}: covering every seat`,
    );
    for (const { start, count } of seatRanges(capacity, COVER_RANGE_SEATS)) {
      signal.throwIfAborted();
      await send(
        sender,
        withFullBudget(on.instructions.coverShortfallRange(id, start, count)),
        owner,
      ).catch(
        failure(`market ${id} cover of seats ${start} to ${start + count - 1}`),
      );
    }
  }
  const { markets: after } = await perpMarkets(on, true);
  for (const id of owed) {
    console.log(
      `${at()} market ${id} records ${shortfall(after, id)} after covering`,
    );
  }
  return failed;
}

/**
 * Upkeep: one `sweep_triggers` call on each perp market, which reads the next
 * slots of its trigger book from the cursor the book keeps. A call that fails
 * is said and the next market goes on; a connection that cannot be made is
 * said once and skips the calls. Resolves to whether any of it failed, which
 * stands as an alert and not as a failed sweep. Only an overrun of the sweep's
 * deadline throws.
 */
async function triggersSwept(
  on: Target,
  owner: Keypair,
  markets: PerpMarket[],
  signal: AbortSignal,
): Promise<boolean> {
  let sender: Connection;
  try {
    sender = await sendingAs(on, owner);
  } catch (error) {
    console.log(`${at()} trigger sweep failed: ${errorLine(error)}`);
    return true;
  }
  let failed = false;
  for (const { id } of markets) {
    signal.throwIfAborted();
    await send(
      sender,
      withFullBudget(
        on.instructions.sweepTriggers(id, SWEEP_TRIGGER_SLOTS_PER_CALL),
      ),
      owner,
    ).catch((error: Error) => {
      failed = true;
      console.log(
        `${at()} market ${id} trigger sweep failed: ${errorLine(error)}`,
      );
    });
  }
  return failed;
}

/**
 * What a sweep came to: whether it failed, the markets it ended at "stale
 * price", and whether an alert stands.
 */
type SweepOutcome = {
  failed: boolean;
  stale: number[];
  alert: boolean;
};

/**
 * One sweep of every perp market, then the covers. Resolves to whether it
 * failed and which markets ended it at "stale price", and throws when a read
 * or a send outside an attempt does. On the first sweep, a seat without
 * collateral is refused. Once `signal` aborts, at the sweep's deadline, it
 * sends nothing more, so the next sweep is the only one signing with the keys.
 */
async function sweptAll(
  on: Target,
  owner: Keypair,
  capacity: number,
  rangeSeats: number,
  first: boolean,
  held: HeldKeys,
  signal: AbortSignal,
): Promise<SweepOutcome> {
  checkpointFailed = false;
  const client = await signedIn(on, owner, held, signal);
  let outcome: SweepOutcome;
  try {
    signal.throwIfAborted();
    const { markets, unreadable } = await perpMarkets(on);
    signal.throwIfAborted();
    if (markets.length > 0) await client.syncView(markets[0].id);
    const view = await client.view();
    const { collateral } = view.snapshot.seat;
    if (first && !view.seatRecorded) {
      throw new SetupError(
        `The keeper ${owner.publicKey.toBase58()} holds no seat, so it could not take over a liquidatable seat. Fund it first: run the setup target with KEEPER_DEPOSIT, or, where the admin key is gone, the keeper-deposit target from any funded wallet.`,
      );
    }
    const refusal = first ? emptySeatRefusal(view.seat, collateral) : null;
    if (refusal) throw new SetupError(refusal);
    console.log(
      `${at()} keeper seat ${view.seat}, collateral ${collateral} quote atoms, seats below ${capacity}`,
    );
    let failed = unreadable.length > 0;
    for (const id of unreadable) {
      console.log(
        `${at()} market ${id}: ALERT, its market or price feed account is unreadable, so it is not swept`,
      );
    }
    const owed = marketsOwed(
      markets.map(({ id, params }) => ({
        id,
        uncoveredShortfall: params.uncoveredShortfall,
      })),
    );
    const reconcileRan = passSteps(owed)[0] === "reconcile";
    if (reconcileRan) {
      if (await reconciled(on, owner, markets, capacity, signal)) failed = true;
    }
    const stale: number[] = [];
    let alert = false;
    for (const market of markets) {
      if (market.params.status === MARKET_STATUS.paused) {
        console.log(
          `${at()} market ${market.id} is paused, so liquidation is refused there: skipped`,
        );
        continue;
      }
      if (market.mark === 0n) {
        console.log(`${at()} market ${market.id} has no mark yet: skipped`);
        continue;
      }
      if (positionOn(view.snapshot.seat, market.id).base !== 0n) {
        if (await unwound(on, client, market, signal, false)) alert = true;
      }
      const result = await swept(
        on,
        client,
        market,
        capacity,
        rangeSeats,
        signal,
      );
      const { counts } = result;
      if (result.alert) alert = true;
      if (sweepFailed(counts)) failed = true;
      if ((counts.get("stale price") ?? 0) > 0) stale.push(market.id);
    }
    let toCover = markets;
    if (reconcileRan) {
      signal.throwIfAborted();
      const { markets: fresh } = await perpMarkets(on, true);
      const keep = new Set(
        stillOwed(
          owed,
          fresh.map(({ id, params }) => ({
            id,
            uncoveredShortfall: params.uncoveredShortfall,
          })),
        ),
      );
      toCover = fresh.filter(({ id }) => keep.has(id));
    }
    if (await covered(on, owner, toCover, capacity, signal)) failed = true;
    if (await triggersSwept(on, owner, markets, signal)) alert = true;
    outcome = { failed, stale, alert };
  } finally {
    keptKeys(on, client);
    client.close();
  }
  if (checkpointFailed) outcome.failed = true;
  return outcome;
}

async function keeper(on: Target): Promise<void> {
  const {
    status,
    rangeSeats,
    releaseEveryMs,
    releaseRangeSeats,
    everySeconds,
    giveUpAfter,
    staleGiveUpSeconds,
    deadlineSeconds,
    healthcheck,
    heartbeatPath,
  } = settings();
  if (on.profile === "mainnet") await deployedAsBuilt(on);
  await rollupIsRunBy(on);
  const owner = keyAt(keyPath(on, "keeper"));
  rollupWatch = new AccountWatch(
    new Connection(on.rollupUrl, {
      commitment: "confirmed",
      wsEndpoint: process.env.ROLLUP_WS_URL || undefined,
    }),
    on.rollup,
    () => performance.now(),
  );
  let capacity = await seatCapacity(on);
  console.log(
    `keeping ${on.network}: seats below ${capacity}, ${rangeSeats} to a call, a sweep every ${everySeconds} s, a release sweep every ${releaseEveryMs / 1_000} s, giving up after ${giveUpAfter} failed sweeps in a row ` +
      `or ${staleGiveUpSeconds} s of stale prices on one market; a sweep that takes more than ${deadlineSeconds === null ? `its deadline (at least ${DEADLINE_SECONDS} s, more as the table and the markets grow; KEEPER_DEADLINE fixes it)` : `${deadlineSeconds} s`} counts as failed` +
      `${healthcheck ? `; pinging ${HEARTBEAT_LABEL} after each good sweep` : ""}` +
      `${heartbeatPath ? `; stamping ${HEARTBEAT_FILE_LABEL} after each good sweep` : ""}` +
      `${status ? `; answering status requests as ${status.id} on ${status.host}:${status.port}` : ""}`,
  );
  const alive = heartbeatTo(healthcheck);
  const stamp = heartbeatFile(heartbeatPath);
  let lastSweep: SweepRecord | null = null;
  if (status) serveKeeperStatus(status, on.network, () => lastSweep);
  let failedInARow = 0;
  let erroredInARow = 0;
  let first = true;
  let stale = new Map<number, number>();
  const held: HeldKeys = { manager: null };
  let releasing = false;
  let releaseBeganAt: number | null = null;
  for (;;) {
    let failed: boolean;
    let alert = false;
    let socketFault = false;
    try {
      const read = await withDeadline(
        "The read of the seat capacity",
        deadlineSeconds ?? DEADLINE_SECONDS,
        async () => {
          socketFault = (await rollupWatch.maintain()).fault !== null;
          return {
            seats: await capacityNow(on, capacity),
            markets: await perpMarketCount(on),
          };
        },
      );
      capacity = read.seats;
      const passDeadline = passDeadlineSeconds(
        deadlineSeconds,
        DEADLINE_SECONDS,
        capacity,
        rangeSeats,
        ORDER_KEYS,
        read.markets,
      );
      const passBegan = Date.now();
      const sweep = await withDeadline("The sweep", passDeadline, (signal) =>
        sweptAll(on, owner, capacity, rangeSeats, first, held, signal),
      );
      const took = Date.now() - passBegan;
      if (passIsSlow(took, passDeadline)) {
        console.log(
          `${at()} the pass took ${Math.round(took / 1_000)} s of its ${passDeadline} s deadline: the table has grown, so give the pass more time (KEEPER_DEADLINE) or run more keepers over parts of it`,
        );
      }
      if (
        !releasing &&
        releaseDue(releaseBeganAt, Date.now(), releaseEveryMs)
      ) {
        releasing = true;
        releaseBeganAt = Date.now();
        void released(on, owner, capacity, releaseRangeSeats)
          .catch((error: Error) =>
            console.log(`${at()} release sweep failed: ${errorLine(error)}`),
          )
          .finally(() => {
            releasing = false;
          });
      }
      failed = sweep.failed || socketFault;
      alert = sweep.alert;
      stale = staleSince(stale, sweep.stale, Date.now());
      first = false;
      erroredInARow = 0;
    } catch (error) {
      if (roundErrorKind(error) === "fatal") throw error;
      console.log(`${at()} sweep failed: ${errorLine(error)}`);
      failed = true;
      erroredInARow += 1;
    }
    failedInARow = failed ? failedInARow + 1 : 0;
    if (failedInARow >= giveUpAfter) {
      throw new Error(
        `${giveUpAfter} sweeps in a row failed. The keeper stops.`,
      );
    }
    const staleMarket = staleTooLong(stale, Date.now(), staleGiveUpSeconds);
    if (staleMarket !== null) {
      throw new Error(
        `Market ${staleMarket} has read "stale price" on every sweep for more than ${staleGiveUpSeconds} s, so nobody there can be liquidated: ` +
          "check the cranks and the feed. The keeper stops.",
      );
    }
    const healthy = sweepHealthy(failed, stale.size, alert);
    lastSweep = afterSweep(
      lastSweep,
      healthy ? 0 : (failed ? 1 : 0) + stale.size + (alert ? 1 : 0),
      Date.now(),
    );
    if (healthy) {
      void alive();
      stamp();
    }
    const pause = backoffMs(everySeconds * 1_000, erroredInARow);
    if (erroredInARow > 0) {
      console.log(`${at()} next sweep in ${pause / 1_000} s`);
    }
    await sleep(pause);
  }
}

run(keeper);

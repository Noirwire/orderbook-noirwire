/**
 * The operator's liquidation keeper (SECURITY.md, "Running a small mainnet
 * market").
 *
 * Nobody can read the ledger through the private endpoint, the operator
 * included: it is sealed by a permission with no members. So the keeper does
 * not look for seats below maintenance margin; it does what the program is
 * built for instead (RULES 8). From a funded seat of its own it tries
 * `liquidate` blind against every trader seat on every perp market, sweep
 * after sweep, at the mark as its worst price, read again before each batch,
 * and reads each outcome from its own view, which only its owner may read. A
 * seat that does not exist, holds no position or is above maintenance reads
 * the same: nothing to liquidate. While a market records a shortfall it also
 * sends `cover_shortfall` for every seat and then `reconcile_shortfall`,
 * which anyone may call (RULES 8, steps 6 and 7).
 *
 * The mainnet profile's setup opens and funds the keeper's seat. Seats open
 * at the lowest free index, so a sweep stops at a bound: the part of the table
 * that can hold a position. Nothing public counts the seats opened before
 * today, so `KEEPER_SEATS` is required: the highest seat index the gate has
 * ever opened plus one, the two reserved seats included, from the gate's own
 * records. The keeper sweeps that many plus a margin of one day's openings,
 * and adds every opening the exchange's public day count shows from then on.
 * It keeps that bound in a file with the keys, so a restart starts from it,
 * taking every day it did not see as a full day of openings. A sweep tries
 * `ORDER_KEYS` seats at a time, so it takes about a round trip to the rollup
 * per four seats.
 *
 * Every instruction replaces the order key it signs with, so the keeper keeps
 * one set of keys for the life of the process and saves where they sit in the
 * derivation (a file of indices, no secret, `keeper-order-keys` beside the
 * bound) after each batch. A restart picks them up from it instead of
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
 * has a deadline too, `KEEPER_DEADLINE` seconds (180 by default): a request
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
 * The Makefile is the way in (`make rehearsal-keeper`).
 */
import { type Keypair } from "@solana/web3.js";
import {
  MARKET_STATUS,
  MAX_MARKETS,
  ORDER_KEYS,
  ORDER_TYPE,
  OrderKeyManager,
  RESULT_STATUS,
  SEATS,
  SIDE,
  TraderClient,
  decodeExchange,
  decodeMarket,
  decodePriceFeed,
  decodeView,
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
import { HEARTBEAT_LABEL, heartbeatTo, heartbeatUrl } from "./heartbeat";
import {
  keepOrderKeys,
  keyAt,
  orderKeysFor,
  readingAs,
  readSeatBound,
  saveSeatBound,
} from "./keys";
import { deployedAsBuilt } from "./program";
import { send, sleep } from "./sending";
import {
  SetupError,
  attemptOf,
  backoffMs,
  dustAlert,
  emptySeatRefusal,
  endsSweep,
  marginAlert,
  marketsOwed,
  positiveInteger,
  roundErrorKind,
  seatsAfterCount,
  staleSince,
  staleTooLong,
  MAX_DEADLINE_SECONDS,
  sweepFailed,
  sweepHealthy,
  sweepTargets,
  unwindAlert,
  unwindOrder,
  withDeadline,
  worstPriceFor,
  type Attempt,
  type SeatCount,
} from "./upkeep";

const at = () => new Date().toISOString();

type Settings = {
  seats: number;
  everySeconds: number;
  giveUpAfter: number;
  staleGiveUpSeconds: number;
  deadlineSeconds: number;
  healthcheck: string | null;
};

/**
 * The longest a sweep may take (`KEEPER_DEADLINE`), and the longest the read
 * of the exchange's seat count may take. A request that never answers in an
 * outage would otherwise hold the keeper for as long as it hangs; past this
 * the sweep counts as failed and the next one starts. A sweep of a large
 * table takes about a round trip per four seats and market, so size it to
 * the bound.
 */
const DEADLINE_SECONDS = 180;

function settings(): Settings {
  const seats = positiveInteger(
    "KEEPER_SEATS",
    process.env.KEEPER_SEATS,
    null,
    SEATS,
  );
  return {
    seats,
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
    deadlineSeconds: positiveInteger(
      "KEEPER_DEADLINE",
      process.env.KEEPER_DEADLINE,
      DEADLINE_SECONDS,
      MAX_DEADLINE_SECONDS,
    ),
    healthcheck: heartbeatUrl(process.env.HEALTHCHECK_URL),
  };
}

/** The sweep bound and the exchange's count it was last brought up to. */
type SeatBound = { seats: number; count: SeatCount };

/** The exchange's public day count of openings, and the most it opens in a day. */
async function seatCount(
  on: Target,
): Promise<{ count: SeatCount; maxPerDay: number }> {
  const account = await on.rollup.getAccountInfo(
    on.instructions.addresses.exchange,
  );
  if (!account) throw new SetupError("The exchange is not in the rollup.");
  const { seatsDay, seatsOpened, maxSeatsPerDay } = decodeExchange(
    account.data,
  );
  return {
    count: { day: seatsDay, opened: seatsOpened },
    maxPerDay: maxSeatsPerDay,
  };
}

/** Where the keeper keeps its bound across restarts. */
const boundPath = (on: Target) => keyPath(on, "keeper-seats");

function keptBound(path: string): SeatBound | null {
  const kept = readSeatBound(path);
  return kept
    ? { seats: kept.seats, count: { day: kept.day, opened: kept.opened } }
    : null;
}

function boundKept(path: string, bound: SeatBound): void {
  saveSeatBound(path, {
    seats: bound.seats,
    day: bound.count.day,
    opened: bound.count.opened,
  });
}

/**
 * The bound the first sweep starts from: `KEEPER_SEATS` plus one day's
 * openings, or the kept bound brought up to the exchange's count when that is
 * higher.
 */
async function startingBound(on: Target, given: number): Promise<SeatBound> {
  const { count, maxPerDay } = await seatCount(on);
  const path = boundPath(on);
  const kept = keptBound(path);
  const fromKept = kept
    ? seatsAfterCount(kept.seats, kept.count, count, maxPerDay, false)
    : 0;
  const seats = Math.max(Math.min(SEATS, given + maxPerDay), fromKept);
  console.log(
    `WARNING: nothing public counts the seats opened before today. The sweep covers seats below ${seats}: ` +
      `KEEPER_SEATS=${given} plus a margin of ${maxPerDay}, one day's openings` +
      `${kept ? `, or the bound kept in ${path} brought up to today's count` : ""}, ` +
      "and grows with every opening the exchange counts from now on. A seat above it is never liquidated: " +
      "KEEPER_SEATS must be the highest seat index the gate has opened plus one, from the gate's own records.",
  );
  const bound = { seats, count };
  boundKept(path, bound);
  return bound;
}

/** The bound after this sweep's read of the exchange's count, kept on disk when it grew. */
async function boundNow(on: Target, before: SeatBound): Promise<SeatBound> {
  const { count, maxPerDay } = await seatCount(on);
  const seats = seatsAfterCount(
    before.seats,
    before.count,
    count,
    maxPerDay,
    true,
  );
  const bound = { seats, count };
  if (seats > before.seats) {
    console.log(
      `${at()} the exchange counted ${seats - before.seats} more seats opened: sweeping seats below ${seats}`,
    );
  }
  const moved =
    seats !== before.seats ||
    count.day !== before.count.day ||
    count.opened !== before.count.opened;
  if (moved) boundKept(boundPath(on), bound);
  return bound;
}

type PerpMarket = { id: number; params: MarketParams; mark: bigint };

const markOf = async (on: Target, id: number): Promise<bigint> => {
  const feed = await on.rollup.getAccountInfo(
    on.instructions.addresses.priceFeed(id),
  );
  if (!feed) throw new Error(`market ${id}'s price feed is unreadable`);
  return decodePriceFeed(feed.data).price;
};

/**
 * Every perp market with its public settings and mark, as the rollup serves
 * them, and the id of each perp market whose market or price feed account
 * could not be read, which a sweep cannot cover.
 */
async function perpMarkets(
  on: Target,
): Promise<{ markets: PerpMarket[]; unreadable: number[] }> {
  const { addresses } = on.instructions;
  const exchange = await on.rollup.getAccountInfo(addresses.exchange);
  if (!exchange) throw new SetupError("The exchange is not in the rollup.");
  const { perpMarkets: bits } = decodeExchange(exchange.data);
  const markets: PerpMarket[] = [];
  const unreadable: number[] = [];
  for (let id = 0; id < MAX_MARKETS; id += 1) {
    if (!((bits >> id) & 1)) continue;
    const [market, feed] = await Promise.all([
      on.rollup.getAccountInfo(addresses.market(id)),
      on.rollup.getAccountInfo(addresses.priceFeed(id)),
    ]);
    if (!market || !feed) {
      unreadable.push(id);
      continue;
    }
    markets.push({
      id,
      params: decodeMarket(market.data).params,
      mark: decodePriceFeed(feed.data).price,
    });
  }
  return { markets, unreadable };
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
 * picks them up from the checkpoint kept beside the keeper's seat bound. A
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

function described(
  seat: number,
  attempt: Attempt,
  result: OrderResult,
): string {
  if (attempt === "margin insufficient") return marginAlert(seat);
  if (attempt !== "liquidated") return `seat ${seat}: ${attempt}`;
  return (
    `seat ${seat}: liquidated, took ${result.filled} lots for ${result.filledNotional} quote atoms, ` +
    `cancelled ${result.cancelled} of its orders, insurance and fees paid ${result.fee}, ${result.rested} left uncovered`
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
  const held = (await client.view()).snapshot.seat.perp[market.id].base;
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
 * One sweep of one market, `ORDER_KEYS` attempts at a time at the mark read
 * just before each batch, until done or a stale price ends it. Resolves to
 * what each attempt came to, counted, and whether an alert stands: a seat
 * the keeper's margin could not take, or a position it could not close. The
 * order keys' places are saved after each batch, so a restart is never more
 * than a batch behind them. A sweep given up on stops before its next batch.
 */
async function swept(
  on: Target,
  client: TraderClient,
  market: PerpMarket,
  targets: number[],
  signal: AbortSignal,
): Promise<{ counts: Map<string, number>; alert: boolean }> {
  const began = Date.now();
  let alert = false;
  const counts = new Map<string, number>();
  const counted = (what: string) =>
    counts.set(what, (counts.get(what) ?? 0) + 1);
  let mark = market.mark;
  for (let first = 0; first < targets.length; first += ORDER_KEYS) {
    signal.throwIfAborted();
    mark = await markOf(on, market.id);
    signal.throwIfAborted();
    const batch = targets.slice(first, first + ORDER_KEYS);
    const attempts = await Promise.all(
      batch.map((seat) =>
        client
          .liquidate(
            market.id,
            seat,
            market.params.openInterestCap,
            worstPriceFor(mark),
          )
          .then((result) => {
            const attempt = attemptOf(result.status);
            counted(attempt);
            if (attempt !== "nothing to liquidate") {
              console.log(
                `${at()} market ${market.id} ${described(seat, attempt, result)}`,
              );
            }
            if (attempt === "margin insufficient") alert = true;
            return attempt;
          })
          .catch((error: Error) => {
            counted("failed");
            console.log(
              `${at()} market ${market.id} seat ${seat}: failed, ${errorLine(error)}`,
            );
            return null;
          }),
      ),
    );
    keptKeys(on, client);
    if (attempts.includes("liquidated")) {
      if (await unwound(on, client, market, signal, true)) alert = true;
    }
    if (attempts.some((attempt) => attempt !== null && endsSweep(attempt))) {
      console.log(
        `${at()} market ${market.id}: stale price, so every seat would read the same; the sweep of this market ends`,
      );
      break;
    }
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
 * RULES 8, steps 6 and 7: covers every flat seat in debt on each market that
 * records a shortfall, then reconciles. Resolves to whether any of it failed.
 */
async function covered(
  on: Target,
  owner: Keypair,
  markets: PerpMarket[],
  targets: number[],
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
    for (const seat of targets) {
      signal.throwIfAborted();
      await send(sender, on.instructions.coverShortfall(id, seat), owner).catch(
        failure(`market ${id} cover of seat ${seat}`),
      );
    }
  }
  signal.throwIfAborted();
  await send(
    sender,
    on.instructions.reconcileShortfall(markets.map(({ id }) => id)),
    owner,
  ).catch(failure("reconcile"));
  const { markets: after } = await perpMarkets(on);
  for (const id of owed) {
    console.log(
      `${at()} market ${id} records ${shortfall(after, id)} after covering and reconciling`,
    );
  }
  return failed;
}

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
  seats: number,
  first: boolean,
  held: HeldKeys,
  signal: AbortSignal,
): Promise<{ failed: boolean; stale: number[]; alert: boolean }> {
  checkpointFailed = false;
  const client = await signedIn(on, owner, held, signal);
  let outcome: { failed: boolean; stale: number[]; alert: boolean };
  try {
    signal.throwIfAborted();
    const { markets, unreadable } = await perpMarkets(on);
    signal.throwIfAborted();
    if (markets.length > 0) await client.syncView(markets[0].id);
    const view = await client.view();
    const { collateral } = view.snapshot.seat;
    const refusal = first ? emptySeatRefusal(view.seat, collateral) : null;
    if (refusal) throw new SetupError(refusal);
    const targets = sweepTargets(seats, view.seat);
    console.log(
      `${at()} keeper seat ${view.seat}, collateral ${collateral} quote atoms, seats below ${seats}`,
    );
    let failed = unreadable.length > 0;
    for (const id of unreadable) {
      console.log(
        `${at()} market ${id}: ALERT, its market or price feed account is unreadable, so it is not swept`,
      );
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
      if (view.snapshot.seat.perp[market.id].base !== 0n) {
        if (await unwound(on, client, market, signal, false)) alert = true;
      }
      const result = await swept(on, client, market, targets, signal);
      const { counts } = result;
      if (result.alert) alert = true;
      if (sweepFailed(counts)) failed = true;
      if ((counts.get("stale price") ?? 0) > 0) stale.push(market.id);
    }
    if (await covered(on, owner, markets, sweepTargets(seats, -1), signal)) {
      failed = true;
    }
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
    seats,
    everySeconds,
    giveUpAfter,
    staleGiveUpSeconds,
    deadlineSeconds,
    healthcheck,
  } = settings();
  if (on.profile === "mainnet") await deployedAsBuilt(on);
  await rollupIsRunBy(on);
  const owner = keyAt(keyPath(on, "keeper"));
  let bound = await startingBound(on, seats);
  console.log(
    `keeping ${on.network}: seats below ${bound.seats}, a sweep every ${everySeconds} s, giving up after ${giveUpAfter} failed sweeps in a row ` +
      `or ${staleGiveUpSeconds} s of stale prices on one market; a sweep that takes more than ${deadlineSeconds} s counts as failed` +
      `${healthcheck ? `; pinging ${HEARTBEAT_LABEL} after each good sweep` : ""}`,
  );
  const alive = heartbeatTo(healthcheck);
  let failedInARow = 0;
  let erroredInARow = 0;
  let first = true;
  let stale = new Map<number, number>();
  const held: HeldKeys = { manager: null };
  for (;;) {
    let failed: boolean;
    let alert = false;
    try {
      bound = await withDeadline(
        "The read of the seat count",
        deadlineSeconds,
        () => boundNow(on, bound),
      );
      const sweep = await withDeadline("The sweep", deadlineSeconds, (signal) =>
        sweptAll(on, owner, bound.seats, first, held, signal),
      );
      failed = sweep.failed;
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
    if (sweepHealthy(failed, stale.size, alert)) void alive();
    const pause = backoffMs(everySeconds * 1_000, erroredInARow);
    if (erroredInARow > 0) {
      console.log(`${at()} next sweep in ${pause / 1_000} s`);
    }
    await sleep(pause);
  }
}

run(keeper);

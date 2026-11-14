/**
 * Keeps every perp market and the USDC guard synced to MagicBlock's price
 * accounts. It holds a
 * websocket subscription (`ops/watching.ts`) on every account it decides from
 * (the exchange, each market and price feed, each bound price account, the
 * guard's) and keeps the latest copy of each in memory. Whenever one changes
 * it runs a round, after a short delay that is the same on every start and
 * differs between two cranks (`CRANK_PHASE_SEED`), and a round sends
 * `sync_price` or `sync_quote` when the price account holds an observation
 * newer than the one the program recorded. So a new MagicBlock stamp is synced
 * as soon as it arrives, and a round with nothing newer sends nothing and
 * reads nothing from the network. `CRANK_EVERY_MS` (200 by default; the whole
 * seconds of `CRANK_EVERY` still work) is the
 * most time between two rounds when nothing changes, so ages and staleness are
 * still judged on time. The rollup's clock is read once and counted forward,
 * and read again every 30 s.
 *
 * A socket is not trusted blindly. While MagicBlock's account, which publishes
 * about ten times a second, says nothing for 2 s, every account is read by
 * hand once a second until it speaks; with the socket healthy, every account
 * is read once every 10 s and compared with what the socket said. A change a
 * read shows that the socket has not delivered 1.5 s later is a socket fault:
 * it counts as a failure under the name `Rollup websocket` (so the crank gives
 * up and its supervisor starts it afresh, and no ping is sent meanwhile), the
 * crank reads by hand and subscribes again, with a longer wait each time. An
 * account that has not changed on the reads is the oracle's silence and not
 * a fault, as below. A move beyond the market's
 * `max_move_bps` between two observations the program takes dislocates the
 * market (RULES 9), so a crank that reads too seldom, or falls behind while it
 * backs off, turns a fast but continuous move into a dislocation and then a
 * settlement. A perp market whose market or price feed account cannot be read
 * counts as an unreadable source under its own name, like a price account that
 * cannot. Per source it logs the rollup clock minus the observation's publish
 * time, what came of it, and the state the program then records: the
 * market's status and price health, or the guard's state; a line that would
 * repeat the last one is held back for ten seconds. A price incident (a
 * dislocated or settling market, a depegged guard) counts as a failure even
 * when the sync that opened it succeeded, so the crank exits non-zero once one
 * source has failed or stayed in an incident for `CRANK_GIVE_UP` seconds (and
 * at least three rounds) in a row, and its supervisor tells someone. An
 * observation the program refused is sent again at most once a second.
 *
 * An oracle that publishes nothing newer (its newest observation is older
 * than the source's max age) is not the crank's failure and a restart cannot
 * mend it: the crank goes on, the source does not count toward the give-up,
 * one `ALERT` line says the oracle has published nothing for N seconds, one
 * `RECOVERED` line says it is back, and the alert is repeated every three
 * minutes while it lasts. The dead-man's switch keeps being pinged
 * meanwhile, since the crank is healthy; the alert is what tells someone.
 *
 * Two cranks on the same markets run side by side and wake on the same
 * change. Each waits 0 to 49 ms before its round, a delay worked out from its
 * key and `CRANK_PHASE_SEED` (set a different one on each when they share a
 * key), so the one with the shorter delay sends and the other usually finds
 * the mark already moved.
 *
 * Every source is read at MagicBlock's account, which lives only inside the
 * rollup, and synced with it as the one account beside the market's own. The
 * crank syncs a source when that account holds an observation newer than the
 * one the program recorded. A move beyond the limit is a refusal and counts as
 * a failure, so a stuck mark reaches whoever the supervisor tells before it
 * goes stale.
 *
 * With `HEALTHCHECK_URL` set, a round with no error and no failing source or
 * open incident, then sends a plain GET to it, for a dead-man's switch outside the server, so the switch
 * means healthy and not only alive. A ping that fails is logged and dropped.
 *
 * An error while reading or sending in a round (an endpoint's 5xx or 429, a
 * refused connection, a timeout) does not stop it: the round is logged, counts
 * as a failure for the source it hit (or for the rollup read), and the pause
 * before the next round doubles up to 60 s, back to the usual pause after a
 * good one. A round also has a deadline, `CRANK_DEADLINE` seconds (15 by default):
 * a request that never answers, as one can in a network outage, ends the round
 * as failed instead of holding the crank for as long as it hangs. Only a wrong
 * setup (a key file that cannot be read, an exchange not in the rollup, no
 * market bound to a price) stops it at once.
 *
 * The Makefile is the way in (`make rehearsal-crank`).
 */
import {
  Connection,
  PublicKey,
  type Keypair,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  MARKET_STATUS,
  MAX_MARKETS,
  ORACLE_HEALTH,
  QUOTE_STATE,
  clockOf,
  decodeExchange,
  decodeMarket,
  decodePriceFeed,
} from "../sdk/dist/index.js";
import { observationIn } from "../sdk/dist/operator/index.js";
import {
  errorLine,
  keyPath,
  rollupIsRunBy,
  run,
  sendingAs,
  type Target,
} from "./deployment";
import { HEARTBEAT_LABEL, at, heartbeatTo, heartbeatUrl } from "./heartbeat";
import { keyAt } from "./keys";
import { deployedAsBuilt } from "./program";
import { send, sleep } from "./sending";
import {
  CRANK_DELAY_SPAN_MS,
  SetupError,
  afterOutcome,
  afterSilence,
  backoffMs,
  configuredEveryMs,
  crankEveryMs,
  crankPhaseMs,
  errorCode,
  failingSince,
  givenUp,
  guardIncident,
  MAX_DEADLINE_SECONDS,
  marketIncident,
  nameIn,
  positiveInteger,
  refusalOutcome,
  resendDue,
  roundErrorKind,
  roundLineDue,
  roundWasGood,
  syncDecision,
  withDeadline,
  withIncident,
  type Silent,
  type Standing,
  type SyncOutcome,
} from "./upkeep";
import { AccountWatch, RollupClock, Wakeup } from "./watching";

const ROLLUP_READ = "Rollup read";
const SOCKET = "Rollup websocket";
/** A good round pings the dead-man's switch at most this often, since rounds come as fast as accounts change. */
const PING_EVERY_MS = 5_000;

/** What a round works with: the target, the held accounts and clock, and the crank's key. */
type Rig = {
  on: Target;
  watch: AccountWatch;
  clock: RollupClock;
  key: Keypair;
};
/**
 * The longest a round may take (`CRANK_DEADLINE`). A request that never
 * answers in an outage would otherwise hold the loop for as long as it hangs;
 * past this the round counts as failed and the next one starts. A round is a
 * few reads and at most a send per source, so this is long for one.
 */
const DEADLINE_SECONDS = 15;
/**
 * `CRANK_GIVE_UP`, in seconds: how long one source may fail, or stay in an
 * incident, before the crank exits. A time and not a count of rounds, so it
 * means the same at 200 ms between rounds as at a second.
 */
const GIVE_UP_SECONDS = 6;

type Settings = {
  everyMs: number | null;
  giveUpSeconds: number;
  deadlineSeconds: number;
  healthcheck: string | null;
  phaseSeed: string;
};

function settings(): Settings {
  return {
    everyMs: configuredEveryMs(
      process.env.CRANK_EVERY_MS,
      process.env.CRANK_EVERY,
    ),
    giveUpSeconds: positiveInteger(
      "CRANK_GIVE_UP",
      process.env.CRANK_GIVE_UP,
      GIVE_UP_SECONDS,
    ),
    deadlineSeconds: positiveInteger(
      "CRANK_DEADLINE",
      process.env.CRANK_DEADLINE,
      DEADLINE_SECONDS,
      MAX_DEADLINE_SECONDS,
    ),
    healthcheck: heartbeatUrl(process.env.HEALTHCHECK_URL),
    phaseSeed: process.env.CRANK_PHASE_SEED ?? "",
  };
}

/** What the program records for a source after a round, and how it is logged. */
type SourceState = { incident: SyncOutcome | null; shown: string };

/**
 * One MagicBlock price account the program takes the mark or the guard from,
 * and what syncing it takes. `oracle` names whoever publishes `account`, for
 * the alert when it is silent.
 */
type Source = {
  name: string;
  oracle: string;
  account: PublicKey;
  /** The publish time of the newest observation the program took from it. */
  recorded: number;
  maxAge: number;
  sync: TransactionInstruction;
  /** The program's accounts a sync changes, read by hand after one is sent, ahead of their notifications. */
  touched: PublicKey[];
  state: () => Promise<SourceState>;
};

async function marketState(rig: Rig, id: number): Promise<SourceState> {
  const account = await rig.watch.get(rig.on.instructions.addresses.market(id));
  if (!account) return { incident: "unreadable", shown: "market unreadable" };
  const { status, oracleHealth } = decodeMarket(account.data).params;
  return {
    incident: marketIncident(oracleHealth),
    shown: `status ${nameIn(MARKET_STATUS, status)}, health ${nameIn(ORACLE_HEALTH, oracleHealth)}`,
  };
}

async function guardState(rig: Rig): Promise<SourceState> {
  const account = await rig.watch.get(rig.on.instructions.addresses.exchange);
  if (!account) return { incident: "unreadable", shown: "guard unreadable" };
  const { state } = decodeExchange(account.data).quote;
  return {
    incident: guardIncident(state),
    shown: `guard ${nameIn(QUOTE_STATE, state)}`,
  };
}

/**
 * Every bound source as the exchange, its markets and their price feeds now
 * say, and the name of each perp market whose market or price feed account
 * could not be read, so its failure is counted rather than skipped. A market
 * bound to no source has nothing to sync and is neither.
 */
async function sources(
  rig: Rig,
): Promise<{ found: Source[]; unreadable: string[] }> {
  const { on, watch } = rig;
  const { addresses } = on.instructions;
  const exchangeAccount = await watch.get(addresses.exchange);
  if (!exchangeAccount) {
    throw new SetupError("The exchange is not in the rollup.");
  }
  const exchange = decodeExchange(exchangeAccount.data);
  const found: Source[] = [];
  const unreadable: string[] = [];
  for (let id = 0; id < MAX_MARKETS; id += 1) {
    if (!((exchange.perpMarkets >> id) & 1)) continue;
    const [market, feed] = await Promise.all([
      watch.get(addresses.market(id)),
      watch.get(addresses.priceFeed(id)),
    ]);
    if (!market || !feed) {
      unreadable.push(`market ${id}`);
      continue;
    }
    const { binding, source } = decodePriceFeed(feed.data);
    if (binding.account.equals(PublicKey.default)) continue;
    const { params } = decodeMarket(market.data);
    watch.markBusy(binding.account);
    found.push({
      name: `market ${id}`,
      oracle: "MagicBlock's oracle",
      account: binding.account,
      recorded: Number(source.publishTime),
      maxAge: Number(params.maxPriceAge),
      sync: on.instructions.syncPrice(id, binding.account),
      touched: [addresses.market(id), addresses.priceFeed(id)],
      state: () => marketState(rig, id),
    });
  }
  const { quote } = exchange;
  if (!quote.account.equals(PublicKey.default)) {
    watch.markBusy(quote.account);
    found.push({
      name: "USDC guard",
      oracle: "MagicBlock's oracle",
      account: quote.account,
      recorded: Number(quote.publishTime),
      maxAge: Number(quote.maxAge),
      sync: on.instructions.syncQuote(quote.account),
      touched: [addresses.exchange],
      state: () => guardState(rig),
    });
  }
  return { found, unreadable };
}

/**
 * A source's round: its outcome, whether an error that is not the program's
 * own refusal got in the way, and how old the newest observation is.
 */
type Round = {
  outcome: SyncOutcome;
  errored: boolean;
  ageSeconds: number | null;
};

/** What the crank remembers of a source between rounds. */
type Memory = {
  /** The observation the program last refused, and when, so the same one is not sent every round. */
  refused: { publishTime: number; atMs: number; outcome: SyncOutcome } | null;
  /** The outcome last logged for it, and when. */
  logged: { outcome: SyncOutcome; atMs: number } | undefined;
};

const memories = new Map<string, Memory>();

const memoryOf = (name: string): Memory => {
  const held = memories.get(name) ?? { refused: null, logged: undefined };
  memories.set(name, held);
  return held;
};

/** One sync of one source, and the line that logs it. */
async function synced(rig: Rig, source: Source, clock: number): Promise<Round> {
  const { on, key: crank } = rig;
  const account = await rig.watch.get(source.account);
  const observation = account ? observationIn(account.data) : null;
  const decision = syncDecision(
    observation?.publishTime ?? null,
    source.recorded,
    clock,
    source.maxAge,
  );
  const now = Date.now();
  const memory = memoryOf(source.name);
  let detail = "";
  let outcome: SyncOutcome = decision === "send" ? "synced" : decision;
  let errored = false;
  let sent = false;
  if (decision === "send" && observation) {
    const { refused } = memory;
    if (
      refused?.publishTime === observation.publishTime &&
      !resendDue(refused.atMs, now)
    ) {
      outcome = refused.outcome;
    } else {
      sent = true;
      memory.refused = null;
      const connection = await sendingAs(on, crank);
      await send(connection, source.sync, crank).catch((error: Error) => {
        detail = `: ${errorLine(error)}`;
        outcome = refusalOutcome(error.message);
        errored = errorCode(error.message) === null;
        if (!errored) {
          memory.refused = {
            publishTime: observation.publishTime,
            atMs: now,
            outcome,
          };
        }
      });
    }
  }
  if (sent) await rig.watch.fresh(source.touched);
  const { incident, shown } = await source.state();
  const result = withIncident(outcome, incident);
  const ageSeconds = observation
    ? Math.max(0, clock - observation.publishTime)
    : null;
  if (roundLineDue(memory.logged, result, sent, now)) {
    memory.logged = { outcome: result, atMs: now };
    const age = ageSeconds === null ? "unread" : `${ageSeconds} s`;
    console.log(
      `${at()} ${source.name.padEnd(11)} clock - publish ${age.padStart(6)}  ${result}${detail}; ${shown}`,
    );
  }
  return { outcome: result, errored, ageSeconds };
}

/**
 * A source's round, with any error that is not a wrong setup caught: it is
 * logged on one line with the source, and counts as an unreadable source.
 */
async function syncedOrFailed(
  rig: Rig,
  source: Source,
  clock: number,
): Promise<Round> {
  try {
    return await synced(rig, source, clock);
  } catch (error) {
    if (roundErrorKind(error) === "fatal") throw error;
    console.log(
      `${at()} ${source.name.padEnd(11)} round failed: ${errorLine(error)}`,
    );
    return { outcome: "unreadable", errored: true, ageSeconds: null };
  }
}

/** The streak name under which a round that did not finish in time is counted. */
const ROUND = "Round deadline";

/**
 * What one round came to: the failure streaks after it, each source's silent
 * oracle, and whether an error ended any part of it.
 */
type RoundResult = {
  streaks: Map<string, number>;
  /** Each source the round read: its oracle's silence, or null while it publishes. */
  silent: Map<string, Silent | null>;
  errored: boolean;
};

/**
 * One round: every bound source read from what is held, and a sync sent for
 * each newer observation.
 */
async function round(
  rig: Rig,
  before: ReadonlyMap<string, number>,
): Promise<RoundResult> {
  let streaks = new Map(before);
  const silent = new Map<string, Silent | null>();
  let errored = false;
  let found: Source[] = [];
  let clock = 0;
  try {
    const socket = await rig.watch.maintain();
    streaks = afterOutcome(
      streaks,
      SOCKET,
      socket.fault === null ? "synced" : "unreadable",
    );
    await rig.clock.ready();
    const read = await sources(rig);
    if (read.found.length === 0 && read.unreadable.length === 0) {
      throw new SetupError("No market or guard is bound to a price account.");
    }
    clock = rig.clock.seconds();
    found = read.found;
    for (const name of read.unreadable) {
      console.log(
        `${at()} ${name.padEnd(11)} market or price feed account unreadable`,
      );
      streaks = afterOutcome(streaks, name, "unreadable");
    }
    streaks = afterOutcome(streaks, ROLLUP_READ, "synced");
  } catch (error) {
    if (roundErrorKind(error) === "fatal") throw error;
    console.log(`${at()} ${ROLLUP_READ} failed: ${errorLine(error)}`);
    streaks = afterOutcome(streaks, ROLLUP_READ, "unreadable");
    errored = true;
  }
  for (const source of found) {
    const result = await syncedOrFailed(rig, source, clock);
    silent.set(
      source.name,
      result.outcome === "silent"
        ? { oracle: source.oracle, seconds: result.ageSeconds ?? 0 }
        : null,
    );
    streaks = afterOutcome(streaks, source.name, result.outcome);
    errored ||= result.errored;
  }
  return { streaks, silent, errored };
}

async function crank(on: Target): Promise<void> {
  const {
    everyMs: configured,
    giveUpSeconds,
    deadlineSeconds,
    healthcheck,
    phaseSeed,
  } = settings();
  if (on.profile === "mainnet") await deployedAsBuilt(on);
  await rollupIsRunBy(on);
  const everyMs = crankEveryMs(configured);
  console.log(
    `cranking ${on.network} on every change to the rollup's accounts over its websocket, and at least every ${everyMs} ms; giving up after ${giveUpSeconds} s of failures or incident rounds in a row; a round that takes more than ${deadlineSeconds} s counts as failed` +
      `${healthcheck ? `; pinging ${HEARTBEAT_LABEL} after good rounds` : ""}`,
  );
  const crankKey = keyAt(keyPath(on, "crank"));
  const alive = heartbeatTo(healthcheck);
  const socket = new Connection(on.rollupUrl, {
    commitment: "confirmed",
    wsEndpoint: process.env.ROLLUP_WS_URL || undefined,
  });
  const watch = new AccountWatch(socket, on.rollup, () => performance.now());
  const wakeup = new Wakeup();
  watch.onChange = () => wakeup.signal();
  const rig: Rig = {
    on,
    watch,
    clock: new RollupClock(
      () => clockOf(on.rollup),
      () => performance.now(),
    ),
    key: crankKey,
  };
  const delayMs = crankPhaseMs(
    crankKey.publicKey.toBytes(),
    phaseSeed,
    CRANK_DELAY_SPAN_MS,
  );
  let streaks = new Map<string, number>();
  let failing = new Map<string, number>();
  let silences = new Map<string, Standing<Silent>>();
  let erroredInARow = 0;
  let pingedAtMs = -Infinity;
  let woke: "change" | "tick" = "tick";
  for (;;) {
    if (woke === "change") await sleep(delayMs);
    let errored: boolean;
    try {
      const result = await withDeadline("The round", deadlineSeconds, () =>
        round(rig, streaks),
      );
      streaks = afterOutcome(result.streaks, ROUND, "synced");
      errored = result.errored;
      const silence = afterSilence(silences, result.silent, Date.now());
      silences = silence.after;
      for (const line of silence.lines) console.log(`${at()} ${line}`);
    } catch (error) {
      if (roundErrorKind(error) === "fatal") throw error;
      console.log(`${at()} round failed: ${errorLine(error)}`);
      streaks = afterOutcome(streaks, ROUND, "unreadable");
      errored = true;
    }
    failing = failingSince(failing, streaks, Date.now());
    const failed = givenUp(streaks, failing, Date.now(), giveUpSeconds * 1_000);
    if (failed) {
      throw new Error(
        `${failed} failed or stayed in an incident for ${giveUpSeconds} s in a row. The crank stops.`,
      );
    }
    const now = Date.now();
    if (roundWasGood(streaks, errored) && now - pingedAtMs >= PING_EVERY_MS) {
      pingedAtMs = now;
      void alive();
    }
    erroredInARow = errored ? erroredInARow + 1 : 0;
    if (errored) {
      const pause = backoffMs(everyMs, erroredInARow);
      console.log(`${at()} round had errors; next round in ${pause / 1_000} s`);
      await sleep(pause);
      woke = "tick";
    } else {
      woke = await wakeup.wait(everyMs);
    }
  }
}

run(crank);

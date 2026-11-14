/**
 * Keeps every Pyth-bound perp market and the USDC guard synced. It holds a
 * websocket subscription (`ops/watching.ts`) on every account it decides from
 * (the exchange, each market and price feed, each bound price account, the
 * guard's) and keeps the latest copy of each in memory. Whenever one changes
 * it runs a round, after a short delay that is the same on every start and
 * differs between two cranks (`CRANK_PHASE_SEED`), and a round sends
 * `sync_price` or `sync_quote` when the price account holds an observation
 * newer than the one the program recorded. So a new MagicBlock stamp is synced
 * as soon as it arrives, and a round with nothing newer sends nothing and
 * reads nothing from the network. `CRANK_EVERY_MS` (1,000 by default, 10,000
 * with `CRANK_PUSH`; the whole seconds of `CRANK_EVERY` still work) is the
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
 * counts as an unreadable source under its own name, like a Pyth account that
 * cannot. Per source it logs the rollup clock minus the observation's publish
 * time, what came of it, and the state the program then records: the
 * market's status and price health, or the guard's state; a line that would
 * repeat the last one is held back for ten seconds. A price incident (a
 * dislocated or settling market, a depegged guard) counts as a failure even
 * when the sync that opened it succeeded, so the crank exits non-zero once one
 * source has failed or stayed in an incident for `CRANK_GIVE_UP` seconds (and
 * at least three rounds) in a row, and its supervisor tells someone. A newer
 * observation the program refuses because its confidence interval is too wide
 * leaves the market at its last accepted mark, which counts as fresh for
 * `max_age` while the price moves on, so it counts as a failure, and once
 * `CONFIDENCE_INCIDENT_SECONDS` (3, or `CRANK_GIVE_UP` when that is fewer)
 * seconds in a row refuse one for a source, every round prints an `ALERT`
 * line for it that says to put the market in reduce-only status, until a
 * confident price lands. An observation the program refused is sent again at
 * most once a second.
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
 * A market with a primary price (RULES 9b, `Market.markFeed`) is read at
 * MagicBlock's account, which lives only inside the rollup, and synced with its
 * Pyth account beside it as the circuit breaker (a fourth account; a market with
 * none takes three). The program freezes the mark when MagicBlock is further than
 * the market's limit from Pyth's latest observation, however old within the
 * breaker's age; when Pyth is silent the mark follows the primary alone, a move
 * limit at a time and never further than the market's limit from the last Pyth
 * price. The crank syncs such a market when MagicBlock's observation is newer
 * than the mark or Pyth's is newer than the one the price feed kept, so a
 * stalled MagicBlock does not leave Pyth unrecorded. A tripped breaker is a
 * sync the program takes: it keeps Pyth's observation, leaves the mark, and
 * logs `noirwire:breaker_tripped`; the crank reads that log (one request per
 * sync it sent) and raises the breaker alert, and goes on. A sync that logs
 * `noirwire:pyth_recorded` kept only Pyth's newer observation because
 * MagicBlock was not newer or too old, which is the silent oracle's alert.
 * Neither counts toward the give-up. An unguarded move beyond the limits is a
 * refusal and counts as a failure, so a frozen mark reaches whoever the
 * supervisor tells before it goes stale. The crank never falls back to Pyth
 * for the mark.
 *
 * With `HEALTHCHECK_URL` set, a round with no error and no failing source or
 * open incident, and no ALERT standing for a confidence incident, then sends a
 * plain GET to it, for a dead-man's switch outside the server, so the switch
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
 * With `CRANK_PUSH=1` it first posts Hermes's latest update to each account on
 * Solana through Pyth's push oracle whenever Pyth's own mainnet rules (a 55 s
 * heartbeat or a 0.5% move) say one is due, paid by the crank's key. That is
 * for a test network whose own updates come too slowly for mainnet's ages;
 * mainnet's feeds are pushed by Pyth, and the crank refuses it there. A push
 * that fails counts like a source that failed.
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
  magicblockPriceAccount,
} from "../sdk/dist/index.js";
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
import {
  hermesLatest,
  hermesUrl,
  observationIn,
  pushDue,
  pushed,
  pushedAccount,
} from "./pyth";
import { logsOf, send, sleep } from "./sending";
import {
  CRANK_DELAY_SPAN_MS,
  SetupError,
  afterConfidence,
  afterOutcome,
  afterSilence,
  backoffMs,
  configuredEveryMs,
  confidenceAlert,
  confidenceIncident,
  confidenceIncidentMs,
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
  syncLogOutcome,
  withDeadline,
  withIncident,
  withPythNewer,
  type Silent,
  type Standing,
  type SyncOutcome,
} from "./upkeep";
import { AccountWatch, RollupClock, Wakeup } from "./watching";

const PUSH = "Hermes push";
const ROLLUP_READ = "Rollup read";
const SOCKET = "Rollup websocket";
/** A good round pings the dead-man's switch at most this often, since rounds come as fast as accounts change. */
const PING_EVERY_MS = 5_000;
/** A confidence alert, once it stands, is printed this often. */
const ALERT_EVERY_MS = 10_000;

/** What a round works with: the target, the held accounts and clock, the crank's key, and the settings it reads. */
type Rig = {
  on: Target;
  watch: AccountWatch;
  clock: RollupClock;
  key: Keypair;
  pushing: boolean;
  alertAfterMs: number;
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
  pushing: boolean;
  deadlineSeconds: number;
  healthcheck: string | null;
  phaseSeed: string;
};

function settings(on: Target): Settings {
  const pushing = process.env.CRANK_PUSH === "1";
  if (pushing && on.mainnet) {
    throw new Error(
      "CRANK_PUSH is for a test network: Pyth pushes mainnet's feeds itself. Nothing was sent.",
    );
  }
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
    pushing,
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
 * One price account the program takes the mark or the guard from, and what
 * syncing it takes. A market with a primary price (RULES 9b) is read at
 * MagicBlock's account inside the rollup, `account`, and sent with its Pyth
 * account beside it as the guard; every other source is read at its Pyth
 * account. `pythAccount` is the Pyth account in both, the one Pyth pushes.
 * `oracle` names whoever publishes `account`, for the alert when it is silent.
 */
type Source = {
  name: string;
  oracle: string;
  primary: boolean;
  account: PublicKey;
  pythAccount: PublicKey;
  /** The market's number, which its sync names in its log; null for the guard. */
  marketId: number | null;
  /** The publish time of the Pyth observation the price feed last kept, for a source with a primary price (null for any other). */
  pythRecorded: number | null;
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
    const { binding, source, publishTime, incident } = decodePriceFeed(
      feed.data,
    );
    if (binding.account.equals(PublicKey.default)) continue;
    const { params, markFeed } = decodeMarket(market.data);
    const primary = markFeed === 0 ? null : magicblockPriceAccount(markFeed);
    const dislocated = params.oracleHealth === ORACLE_HEALTH.dislocated;
    if (primary) watch.markBusy(primary);
    found.push({
      name: `market ${id}`,
      oracle: primary ? "MagicBlock's oracle" : "Pyth",
      primary: primary !== null,
      account: primary ?? binding.account,
      pythAccount: binding.account,
      marketId: id,
      pythRecorded: primary ? Number(source.publishTime) : null,
      recorded: primary
        ? Math.max(Number(publishTime), dislocated ? Number(incident.since) : 0)
        : Number(source.publishTime),
      maxAge: Number(params.maxPriceAge),
      sync: on.instructions.syncPrice(
        id,
        binding.account,
        primary ?? undefined,
      ),
      touched: [addresses.market(id), addresses.priceFeed(id)],
      state: () => marketState(rig, id),
    });
  }
  const { quote } = exchange;
  if (!quote.account.equals(PublicKey.default)) {
    found.push({
      name: "USDC guard",
      oracle: "Pyth",
      primary: false,
      account: quote.account,
      pythAccount: quote.account,
      marketId: null,
      pythRecorded: null,
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
 * Posts Hermes's latest update for every source the push rules say is due,
 * after checking that the push oracle writes the very account the program
 * reads.
 */
async function pushedWhereDue(
  on: Target,
  found: Source[],
  crank: Keypair,
): Promise<void> {
  const url = hermesUrl(on.mainnet);
  const held = await Promise.all(
    found.map(async (source) => {
      const account = await on.solana.getAccountInfo(source.pythAccount);
      const observation = account ? observationIn(account.data) : null;
      if (!observation) {
        throw new Error(
          `${source.name}'s Pyth account is missing or unreadable on Solana; nothing was pushed.`,
        );
      }
      return { source, observation };
    }),
  );
  const { observations } = await hermesLatest(
    url,
    held.map(({ observation }) => observation.feedId),
  );
  const due = held.filter(({ observation }) => {
    const latest = observations.find(
      ({ feedId }) => feedId === observation.feedId,
    );
    return latest !== undefined && pushDue(observation, latest);
  });
  if (due.length === 0) return;
  for (const { source, observation } of due) {
    if (!(await pushedAccount(observation.feedId)).equals(source.pythAccount)) {
      throw new Error(
        `The push oracle writes another account than ${source.name} reads; nothing was pushed.`,
      );
    }
  }
  const { updates } = await hermesLatest(
    url,
    due.map(({ observation }) => observation.feedId),
  );
  const began = Date.now();
  const signatures = await pushed(on.solana, crank, updates);
  console.log(
    `${at()} pushed ${due.map(({ source }) => source.name).join(", ")} to Solana in ${signatures.length} transactions, ${Date.now() - began} ms`,
  );
}

/** A round's push, as an outcome the failure count takes. */
const pushOutcome = (
  on: Target,
  found: Source[],
  crank: Keypair,
): Promise<SyncOutcome> =>
  pushedWhereDue(on, found, crank).then(
    () => "synced",
    (error: Error) => {
      console.log(`${at()} push failed: ${errorLine(error)}`);
      return "refused";
    },
  );

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
  /** When its confidence alert was last printed. */
  alertedAtMs: number;
};

const memories = new Map<string, Memory>();

const memoryOf = (name: string): Memory => {
  const held = memories.get(name) ?? {
    refused: null,
    logged: undefined,
    alertedAtMs: -Infinity,
  };
  memories.set(name, held);
  return held;
};

/** One sync of one source, and the line that logs it. */
async function synced(rig: Rig, source: Source, clock: number): Promise<Round> {
  const { on, key: crank } = rig;
  const account = await rig.watch.get(source.account);
  const observation = account ? observationIn(account.data) : null;
  const pyth =
    source.pythRecorded === null
      ? null
      : await rig.watch.get(source.pythAccount);
  const decision = withPythNewer(
    syncDecision(
      observation?.publishTime ?? null,
      source.recorded,
      clock,
      source.maxAge,
    ),
    pyth ? (observationIn(pyth.data)?.publishTime ?? null) : null,
    source.pythRecorded,
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
      const signature = await send(connection, source.sync, crank).catch(
        (error: Error) => {
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
          return null;
        },
      );
      if (signature !== null) {
        outcome = syncLogOutcome(
          await logsOf(connection, signature),
          source.marketId,
        );
      }
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
 * What one round came to: the failure streaks after it, the rounds in a row
 * each source's newer observation was refused for its confidence, and whether
 * an error ended any part of it.
 */
type RoundResult = {
  streaks: Map<string, number>;
  refused: Map<string, number>;
  /** Each source the round read: its oracle's silence, or null while it publishes. */
  silent: Map<string, Silent | null>;
  /** When each source's run of refusals for confidence began. */
  refusedSince: Map<string, number>;
  errored: boolean;
};

/**
 * One round: every bound source read from what is held, and a sync sent for
 * each newer observation. A source whose newer observations have been
 * refused for their confidence for `alertAfterMs` is an incident, and the
 * round prints an alert line for it. `push` says Hermes may be asked, which
 * only the safety tick does.
 */
async function round(
  rig: Rig,
  push: boolean,
  before: ReadonlyMap<string, number>,
  refusedBefore: ReadonlyMap<string, number>,
  refusedSinceBefore: ReadonlyMap<string, number>,
): Promise<RoundResult> {
  const { on, key: crankKey, pushing } = rig;
  let streaks = new Map(before);
  let refused = new Map(refusedBefore);
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
      throw new SetupError("No market or guard is bound to a Pyth account.");
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
  if (pushing && push && found.length > 0) {
    streaks = afterOutcome(
      streaks,
      PUSH,
      await pushOutcome(on, found, crankKey),
    );
  }
  let refusedSince = new Map(refusedSinceBefore);
  for (const source of found) {
    const result = await syncedOrFailed(rig, source, clock);
    silent.set(
      source.name,
      result.outcome === "silent" || result.outcome === "disagrees"
        ? {
            oracle: source.oracle,
            seconds: result.ageSeconds ?? 0,
            kind: result.outcome,
          }
        : null,
    );
    streaks = afterOutcome(streaks, source.name, result.outcome);
    refused = afterConfidence(refused, source.name, result.outcome);
    const now = Date.now();
    refusedSince = failingSince(refusedSince, refused, now);
    const rounds = refused.get(source.name) ?? 0;
    const memory = memoryOf(source.name);
    if (
      confidenceIncident(
        new Map([[source.name, rounds]]),
        refusedSince,
        now,
        rig.alertAfterMs,
      ) &&
      now - memory.alertedAtMs >= ALERT_EVERY_MS
    ) {
      memory.alertedAtMs = now;
      console.log(
        `${at()} ${confidenceAlert(source.name, rounds, source.maxAge)}`,
      );
    }
    errored ||= result.errored;
  }
  return { streaks, refused, silent, refusedSince, errored };
}

async function crank(on: Target): Promise<void> {
  const {
    everyMs: configured,
    giveUpSeconds,
    pushing,
    deadlineSeconds,
    healthcheck,
    phaseSeed,
  } = settings(on);
  if (on.profile === "mainnet") await deployedAsBuilt(on);
  await rollupIsRunBy(on);
  const everyMs = crankEveryMs(configured, pushing);
  console.log(
    `cranking ${on.network} on every change to the rollup's accounts over its websocket, and at least every ${everyMs} ms${pushing ? ", pushing Hermes updates to Solana when due" : ""}; giving up after ${giveUpSeconds} s of failures or incident rounds in a row; a round that takes more than ${deadlineSeconds} s counts as failed` +
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
    pushing,
    alertAfterMs: confidenceIncidentMs(giveUpSeconds),
  };
  const delayMs = crankPhaseMs(
    crankKey.publicKey.toBytes(),
    phaseSeed,
    CRANK_DELAY_SPAN_MS,
  );
  let streaks = new Map<string, number>();
  let failing = new Map<string, number>();
  let refused = new Map<string, number>();
  let refusedSince = new Map<string, number>();
  let silences = new Map<string, Standing<Silent>>();
  let erroredInARow = 0;
  let pingedAtMs = -Infinity;
  let woke: "change" | "tick" = "tick";
  for (;;) {
    if (woke === "change") await sleep(delayMs);
    let errored: boolean;
    try {
      const result = await withDeadline("The round", deadlineSeconds, () =>
        round(rig, woke === "tick", streaks, refused, refusedSince),
      );
      streaks = afterOutcome(result.streaks, ROUND, "synced");
      refused = result.refused;
      refusedSince = result.refusedSince;
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
    if (
      roundWasGood(streaks, errored) &&
      !confidenceIncident(refused, refusedSince, now, rig.alertAfterMs) &&
      now - pingedAtMs >= PING_EVERY_MS
    ) {
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

/**
 * Keeps every Pyth-bound perp market and the USDC guard synced. Every
 * `CRANK_EVERY_MS` milliseconds (200 with a market that has a primary price,
 * 1,000 with Pyth sources only, 10,000 with `CRANK_PUSH`; the whole seconds of
 * `CRANK_EVERY` still work) it reads each bound price account as the rollup
 * serves it, and sends `sync_price` or `sync_quote` when the account holds an
 * observation newer than the one the program recorded; a round with none
 * sends nothing and costs only reads. A move beyond the market's
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
 * Two cranks on the same markets run side by side. Each one's rounds fall at
 * a fixed place in the interval, worked out from its key and `CRANK_PHASE_SEED`
 * (set a different one on each when they share a key), so they mostly do not
 * send the same sync at the same moment.
 *
 * A market with a primary price (RULES 9b, `Market.markFeed`) is read at
 * MagicBlock's account, which lives only inside the rollup, and synced with its
 * Pyth account beside it as the circuit breaker (a fourth account; a market with
 * none takes three). The program freezes the mark when MagicBlock is further than
 * the market's limit from Pyth's latest observation, however old within the
 * breaker's age; when Pyth is silent the mark follows the primary alone, a move
 * limit at a time and never further than the market's limit from the last Pyth
 * price. A refusal, for a tripped breaker or an unguarded move beyond those
 * limits, counts as a failure, so a frozen
 * mark reaches whoever the supervisor tells before it goes stale. The crank
 * never falls back to Pyth for the mark.
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
import { send, sleep } from "./sending";
import {
  SetupError,
  afterConfidence,
  afterOutcome,
  afterSilence,
  backoffMs,
  configuredEveryMs,
  confidenceAlert,
  confidenceIncident,
  confidenceRounds,
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
  untilNextRound,
  withDeadline,
  withIncident,
  type Silent,
  type Standing,
  type SyncOutcome,
} from "./upkeep";

const PUSH = "Hermes push";
const ROLLUP_READ = "Rollup read";
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
  /** The publish time of the newest observation the program took from it. */
  recorded: number;
  maxAge: number;
  sync: TransactionInstruction;
  state: () => Promise<SourceState>;
};

async function marketState(on: Target, id: number): Promise<SourceState> {
  const account = await on.rollup.getAccountInfo(
    on.instructions.addresses.market(id),
  );
  if (!account) return { incident: "unreadable", shown: "market unreadable" };
  const { status, oracleHealth } = decodeMarket(account.data).params;
  return {
    incident: marketIncident(oracleHealth),
    shown: `status ${nameIn(MARKET_STATUS, status)}, health ${nameIn(ORACLE_HEALTH, oracleHealth)}`,
  };
}

async function guardState(on: Target): Promise<SourceState> {
  const account = await on.rollup.getAccountInfo(
    on.instructions.addresses.exchange,
  );
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
  on: Target,
): Promise<{ found: Source[]; unreadable: string[] }> {
  const { addresses } = on.instructions;
  const exchangeAccount = await on.rollup.getAccountInfo(addresses.exchange);
  if (!exchangeAccount) {
    throw new SetupError("The exchange is not in the rollup.");
  }
  const exchange = decodeExchange(exchangeAccount.data);
  const found: Source[] = [];
  const unreadable: string[] = [];
  for (let id = 0; id < MAX_MARKETS; id += 1) {
    if (!((exchange.perpMarkets >> id) & 1)) continue;
    const [market, feed] = await Promise.all([
      on.rollup.getAccountInfo(addresses.market(id)),
      on.rollup.getAccountInfo(addresses.priceFeed(id)),
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
    found.push({
      name: `market ${id}`,
      oracle: primary ? "MagicBlock's oracle" : "Pyth",
      primary: primary !== null,
      account: primary ?? binding.account,
      pythAccount: binding.account,
      recorded: primary
        ? Math.max(Number(publishTime), dislocated ? Number(incident.since) : 0)
        : Number(source.publishTime),
      maxAge: Number(params.maxPriceAge),
      sync: on.instructions.syncPrice(
        id,
        binding.account,
        primary ?? undefined,
      ),
      state: () => marketState(on, id),
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
      recorded: Number(quote.publishTime),
      maxAge: Number(quote.maxAge),
      sync: on.instructions.syncQuote(quote.account),
      state: () => guardState(on),
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
};

const memories = new Map<string, Memory>();

/** One sync of one source, and the line that logs it. */
async function synced(
  on: Target,
  source: Source,
  crank: Keypair,
  clock: number,
): Promise<Round> {
  const account = await on.rollup
    .getAccountInfo(source.account)
    .catch(() => null);
  const observation = account ? observationIn(account.data) : null;
  const decision = syncDecision(
    observation?.publishTime ?? null,
    source.recorded,
    clock,
    source.maxAge,
  );
  const now = Date.now();
  const memory = memories.get(source.name) ?? {
    refused: null,
    logged: undefined,
  };
  memories.set(source.name, memory);
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
      await send(await sendingAs(on, crank), source.sync, crank).catch(
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
        },
      );
    }
  }
  const { incident, shown } = await source.state();
  const result = withIncident(outcome, incident);
  if (roundLineDue(memory.logged, result, sent, now)) {
    memory.logged = { outcome: result, atMs: now };
    const age = observation ? `${clock - observation.publishTime} s` : "unread";
    console.log(
      `${at()} ${source.name.padEnd(11)} clock - publish ${age.padStart(6)}  ${result}${detail}; ${shown}`,
    );
  }
  return {
    outcome: result,
    errored,
    ageSeconds: observation ? clock - observation.publishTime : null,
  };
}

/**
 * A source's round, with any error that is not a wrong setup caught: it is
 * logged on one line with the source, and counts as an unreadable source.
 */
async function syncedOrFailed(
  on: Target,
  source: Source,
  crank: Keypair,
  clock: number,
): Promise<Round> {
  try {
    return await synced(on, source, crank, clock);
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
  /** Whether a market with a primary price is bound, which sets the pace; null when the round read no source. */
  primary: boolean | null;
  errored: boolean;
};

/**
 * One round: every bound source read, and a sync sent for each newer
 * observation. A source whose newer observations have been refused for their
 * confidence `alertAfter` rounds in a row is an incident, and the round
 * prints an alert line for it.
 */
async function round(
  on: Target,
  crankKey: Keypair,
  pushing: boolean,
  before: ReadonlyMap<string, number>,
  refusedBefore: ReadonlyMap<string, number>,
  alertAfter: number,
): Promise<RoundResult> {
  let streaks = new Map(before);
  let refused = new Map(refusedBefore);
  const silent = new Map<string, Silent | null>();
  let errored = false;
  let found: Source[] = [];
  let clock = 0;
  try {
    const read = await sources(on);
    if (read.found.length === 0 && read.unreadable.length === 0) {
      throw new SetupError("No market or guard is bound to a Pyth account.");
    }
    clock = await clockOf(on.rollup);
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
  if (pushing && found.length > 0) {
    streaks = afterOutcome(
      streaks,
      PUSH,
      await pushOutcome(on, found, crankKey),
    );
  }
  for (const source of found) {
    const result = await syncedOrFailed(on, source, crankKey, clock);
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
    const rounds = refused.get(source.name) ?? 0;
    if (rounds >= alertAfter) {
      console.log(
        `${at()} ${confidenceAlert(source.name, rounds, source.maxAge)}`,
      );
    }
    errored ||= result.errored;
  }
  return {
    streaks,
    refused,
    silent,
    primary: found.length === 0 ? null : found.some(({ primary }) => primary),
    errored,
  };
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
  const pace = configured
    ? `${configured} ms`
    : pushing
      ? `${crankEveryMs(null, true, false)} ms`
      : `${crankEveryMs(null, false, true)} ms with a primary price and ${crankEveryMs(null, false, false)} ms without`;
  console.log(
    `cranking ${on.network} every ${pace}${pushing ? ", pushing Hermes updates to Solana when due" : ""}; giving up after ${giveUpSeconds} s of failures or incident rounds in a row; a round that takes more than ${deadlineSeconds} s counts as failed` +
      `${healthcheck ? `; pinging ${HEARTBEAT_LABEL} after each good round` : ""}`,
  );
  const crankKey = keyAt(keyPath(on, "crank"));
  const alive = heartbeatTo(healthcheck);
  let hasPrimary = false;
  let everyMs = crankEveryMs(configured, pushing, hasPrimary);
  let streaks = new Map<string, number>();
  let failing = new Map<string, number>();
  let refused = new Map<string, number>();
  let silences = new Map<string, Standing<Silent>>();
  let erroredInARow = 0;
  for (;;) {
    const alertAfter = confidenceRounds(everyMs, giveUpSeconds);
    let errored: boolean;
    try {
      const result = await withDeadline("The round", deadlineSeconds, () =>
        round(on, crankKey, pushing, streaks, refused, alertAfter),
      );
      streaks = afterOutcome(result.streaks, ROUND, "synced");
      refused = result.refused;
      errored = result.errored;
      hasPrimary = result.primary ?? hasPrimary;
      everyMs = crankEveryMs(configured, pushing, hasPrimary);
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
    if (
      roundWasGood(streaks, errored) &&
      !confidenceIncident(refused, alertAfter)
    ) {
      void alive();
    }
    erroredInARow = errored ? erroredInARow + 1 : 0;
    const pause = errored
      ? backoffMs(everyMs, erroredInARow)
      : untilNextRound(
          Date.now(),
          everyMs,
          crankPhaseMs(crankKey.publicKey.toBytes(), phaseSeed, everyMs),
        );
    if (errored) {
      console.log(`${at()} round had errors; next round in ${pause / 1_000} s`);
    }
    await sleep(pause);
  }
}

run(crank);

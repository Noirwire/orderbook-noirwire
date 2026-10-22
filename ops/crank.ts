/**
 * Keeps every Pyth-bound perp market and the USDC guard synced. Every
 * `CRANK_EVERY` seconds (1 by default, 10 with `CRANK_PUSH`) it reads each
 * bound Pyth account as the rollup serves it, and sends `sync_price` or
 * `sync_quote` when the account holds an observation newer than the one the
 * program recorded. A move beyond the market's `max_move_bps` between two
 * observations the program takes dislocates the market (RULES 9), so a crank
 * that reads too seldom, or falls behind while it backs off, turns a fast but
 * continuous move into a dislocation and then a settlement. A perp market
 * whose market or price feed account cannot be read counts as an unreadable
 * source under its own name, like a Pyth account that cannot. Per source and round
 * it logs the rollup clock minus the observation's publish time, what came
 * of it, and the state the program then records: the market's status and
 * price health, or the guard's state. A price incident (a dislocated or
 * settling market, a depegged guard) counts as a failure even when the sync
 * that opened it succeeded, so the crank exits non-zero once one source has
 * failed or stayed in an incident `CRANK_GIVE_UP` rounds in a row, and its
 * supervisor tells someone. A newer observation the program refuses because
 * its confidence interval is too wide leaves the market at its last accepted
 * mark, which counts as fresh for `max_age` while the price moves on, so it
 * counts as a failure, and once `CONFIDENCE_INCIDENT_ROUNDS` rounds (3, or
 * `CRANK_GIVE_UP` when that is fewer) in a row refuse one for a source, every
 * round prints an `ALERT` line for it that says to put the market in
 * reduce-only status, until a confident price lands.
 *
 * With `HEALTHCHECK_URL` set, a round with no error and no failing source or
 * open incident, and no ALERT standing for a confidence incident, then sends a
 * plain GET to it, for a dead-man's switch outside the server, so the switch
 * means healthy and not only alive. A ping that fails is logged and dropped.
 *
 * An error while reading or sending in a round (an endpoint's 5xx or 429, a
 * refused connection, a timeout) does not stop it: the round is logged, counts
 * as a failure for the source it hit (or for the rollup read), and the pause
 * before the next round doubles up to 60 s, back to `CRANK_EVERY` after a good
 * one. A round also has a deadline, `CRANK_DEADLINE` seconds (60 by default):
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
} from "../sdk/dist/index.js";
import {
  errorLine,
  keyPath,
  rollupIsRunBy,
  run,
  sendingAs,
  type Target,
} from "./deployment";
import { heartbeatTo, heartbeatUrl } from "./heartbeat";
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
  CONFIDENCE_INCIDENT_ROUNDS,
  SetupError,
  afterConfidence,
  afterOutcome,
  backoffMs,
  confidenceAlert,
  confidenceIncident,
  errorCode,
  givenUp,
  guardIncident,
  MAX_DEADLINE_SECONDS,
  marketIncident,
  nameIn,
  positiveInteger,
  refusalOutcome,
  roundErrorKind,
  roundWasGood,
  syncDecision,
  withDeadline,
  withIncident,
  type SyncOutcome,
} from "./upkeep";

const PUSH = "Hermes push";
const ROLLUP_READ = "Rollup read";
/**
 * Between rounds by default. A round reads each Pyth account, which costs a
 * read and nothing else, and sends only for a newer observation, so a round
 * every second or two follows each of Pyth's 0.5% pushes as it comes: the
 * program then sees a fast but continuous move step by step, inside its move
 * limit, instead of as one jump that dislocates the market.
 */
const EVERY_SECONDS = 1;
/**
 * The longest a round may take (`CRANK_DEADLINE`). A request that never
 * answers in an outage would otherwise hold the loop for as long as it hangs;
 * past this the round counts as failed and the next one starts.
 */
const DEADLINE_SECONDS = 60;
/** With `CRANK_PUSH`, each round also asks Hermes, whose public rate limit a round a second would meet. */
const PUSHING_EVERY_SECONDS = 10;

const at = () => new Date().toISOString();

type Settings = {
  everySeconds: number;
  giveUpAfter: number;
  pushing: boolean;
  deadlineSeconds: number;
  healthcheck: string | null;
};

function settings(on: Target): Settings {
  const pushing = process.env.CRANK_PUSH === "1";
  if (pushing && on.mainnet) {
    throw new Error(
      "CRANK_PUSH is for a test network: Pyth pushes mainnet's feeds itself. Nothing was sent.",
    );
  }
  return {
    everySeconds: positiveInteger(
      "CRANK_EVERY",
      process.env.CRANK_EVERY,
      pushing ? PUSHING_EVERY_SECONDS : EVERY_SECONDS,
    ),
    giveUpAfter: positiveInteger("CRANK_GIVE_UP", process.env.CRANK_GIVE_UP, 6),
    pushing,
    deadlineSeconds: positiveInteger(
      "CRANK_DEADLINE",
      process.env.CRANK_DEADLINE,
      DEADLINE_SECONDS,
      MAX_DEADLINE_SECONDS,
    ),
    healthcheck: heartbeatUrl(process.env.HEALTHCHECK_URL),
  };
}

/** What the program records for a source after a round, and how it is logged. */
type SourceState = { incident: SyncOutcome | null; shown: string };

/** One Pyth account the program reads, and what syncing it takes. */
type Source = {
  name: string;
  account: PublicKey;
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
    const { binding, source } = decodePriceFeed(feed.data);
    if (binding.account.equals(PublicKey.default)) continue;
    found.push({
      name: `market ${id}`,
      account: binding.account,
      recorded: Number(source.publishTime),
      maxAge: Number(decodeMarket(market.data).params.maxPriceAge),
      sync: on.instructions.syncPrice(id, binding.account),
      state: () => marketState(on, id),
    });
  }
  const { quote } = exchange;
  if (!quote.account.equals(PublicKey.default)) {
    found.push({
      name: "USDC guard",
      account: quote.account,
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
      const account = await on.solana.getAccountInfo(source.account);
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
    if (!(await pushedAccount(observation.feedId)).equals(source.account)) {
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

/** A source's round: its outcome, and whether an error that is not the program's own refusal got in the way. */
type Round = { outcome: SyncOutcome; errored: boolean };

/** One sync of one source, and the line that logs it. */
async function synced(
  on: Target,
  source: Source,
  crank: Keypair,
): Promise<Round> {
  const account = await on.rollup
    .getAccountInfo(source.account)
    .catch(() => null);
  const observation = account ? observationIn(account.data) : null;
  const clock = await clockOf(on.rollup);
  const decision = syncDecision(
    observation?.publishTime ?? null,
    source.recorded,
    clock,
    source.maxAge,
  );
  let detail = "";
  let outcome: SyncOutcome = decision === "send" ? "synced" : decision;
  let errored = false;
  if (decision === "send") {
    await send(await sendingAs(on, crank), source.sync, crank).catch(
      (error: Error) => {
        detail = `: ${errorLine(error)}`;
        outcome = refusalOutcome(error.message);
        errored = errorCode(error.message) === null;
      },
    );
  }
  const { incident, shown } = await source.state();
  const age = observation ? `${clock - observation.publishTime} s` : "unread";
  const result = withIncident(outcome, incident);
  console.log(
    `${at()} ${source.name.padEnd(11)} clock - publish ${age.padStart(6)}  ${result}${detail}; ${shown}`,
  );
  return { outcome: result, errored };
}

/**
 * A source's round, with any error that is not a wrong setup caught: it is
 * logged on one line with the source, and counts as an unreadable source.
 */
async function syncedOrFailed(
  on: Target,
  source: Source,
  crank: Keypair,
): Promise<Round> {
  try {
    return await synced(on, source, crank);
  } catch (error) {
    if (roundErrorKind(error) === "fatal") throw error;
    console.log(
      `${at()} ${source.name.padEnd(11)} round failed: ${errorLine(error)}`,
    );
    return { outcome: "unreadable", errored: true };
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
  let errored = false;
  let found: Source[] = [];
  try {
    const read = await sources(on);
    found = read.found;
    if (found.length === 0 && read.unreadable.length === 0) {
      throw new SetupError("No market or guard is bound to a Pyth account.");
    }
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
    const result = await syncedOrFailed(on, source, crankKey);
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
  return { streaks, refused, errored };
}

async function crank(on: Target): Promise<void> {
  const { everySeconds, giveUpAfter, pushing, deadlineSeconds, healthcheck } =
    settings(on);
  if (on.profile === "mainnet") await deployedAsBuilt(on);
  await rollupIsRunBy(on);
  console.log(
    `cranking ${on.network} every ${everySeconds} s${pushing ? ", pushing Hermes updates to Solana when due" : ""}; giving up after ${giveUpAfter} failures or incident rounds in a row; a round that takes more than ${deadlineSeconds} s counts as failed` +
      `${healthcheck ? `; pinging ${new URL(healthcheck).host} after each good round` : ""}`,
  );
  const crankKey = keyAt(keyPath(on, "crank"));
  const alive = heartbeatTo(healthcheck);
  const alertAfter = Math.min(CONFIDENCE_INCIDENT_ROUNDS, giveUpAfter);
  let streaks = new Map<string, number>();
  let refused = new Map<string, number>();
  let erroredInARow = 0;
  for (;;) {
    let errored: boolean;
    try {
      const result = await withDeadline("The round", deadlineSeconds, () =>
        round(on, crankKey, pushing, streaks, refused, alertAfter),
      );
      streaks = afterOutcome(result.streaks, ROUND, "synced");
      refused = result.refused;
      errored = result.errored;
    } catch (error) {
      if (roundErrorKind(error) === "fatal") throw error;
      console.log(`${at()} round failed: ${errorLine(error)}`);
      streaks = afterOutcome(streaks, ROUND, "unreadable");
      errored = true;
    }
    const failing = givenUp(streaks, giveUpAfter);
    if (failing) {
      throw new Error(
        `${failing} failed or stayed in an incident ${giveUpAfter} rounds in a row. The crank stops.`,
      );
    }
    if (
      roundWasGood(streaks, errored) &&
      !confidenceIncident(refused, alertAfter)
    ) {
      void alive();
    }
    erroredInARow = errored ? erroredInARow + 1 : 0;
    const pause = backoffMs(everySeconds * 1_000, erroredInARow);
    if (errored) {
      console.log(`${at()} round had errors; next round in ${pause / 1_000} s`);
    }
    await sleep(pause);
  }
}

run(crank);

/**
 * Keeps every Pyth-bound perp market and the USDC guard synced. Every
 * `CRANK_EVERY` seconds it reads each bound Pyth account as the rollup serves
 * it, and sends `sync_price` or `sync_quote` when the account holds an
 * observation newer than the one the program recorded. Per source and round
 * it logs the rollup clock minus the observation's publish time, what came
 * of it, and the state the program then records: the market's status and
 * price health, or the guard's state. A price incident (a dislocated or
 * settling market, a depegged guard) counts as a failure even when the sync
 * that opened it succeeded, so the crank exits non-zero once one source has
 * failed or stayed in an incident `CRANK_GIVE_UP` rounds in a row, and its
 * supervisor tells someone.
 *
 * An error while reading or sending in a round (an endpoint's 5xx or 429, a
 * refused connection, a timeout) does not stop it: the round is logged, counts
 * as a failure for the source it hit (or for the rollup read), and the pause
 * before the next round doubles up to 60 s, back to `CRANK_EVERY` after a good
 * one. Only a wrong setup (a key file that cannot be read, an exchange not in the rollup, no
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
  keyPath,
  rollupIsRunBy,
  run,
  sendingAs,
  type Target,
} from "./deployment";
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
  afterOutcome,
  backoffMs,
  errorCode,
  givenUp,
  guardIncident,
  marketIncident,
  nameIn,
  positiveInteger,
  refusalOutcome,
  roundErrorKind,
  syncDecision,
  withIncident,
  type SyncOutcome,
} from "./upkeep";

const PUSH = "Hermes push";
const ROLLUP_READ = "Rollup read";

const at = () => new Date().toISOString();
const firstLine = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).split("\n")[0];

type Settings = { everySeconds: number; giveUpAfter: number; pushing: boolean };

function settings(on: Target): Settings {
  const pushing = process.env.CRANK_PUSH === "1";
  if (pushing && on.mainnet) {
    throw new Error(
      "CRANK_PUSH is for a test network: Pyth pushes mainnet's feeds itself. Nothing was sent.",
    );
  }
  return {
    everySeconds: positiveInteger("CRANK_EVERY", process.env.CRANK_EVERY, 10),
    giveUpAfter: positiveInteger("CRANK_GIVE_UP", process.env.CRANK_GIVE_UP, 6),
    pushing,
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

/** Every bound source as the exchange, its markets and their price feeds now say. */
async function sources(on: Target): Promise<Source[]> {
  const { addresses } = on.instructions;
  const exchangeAccount = await on.rollup.getAccountInfo(addresses.exchange);
  if (!exchangeAccount) {
    throw new SetupError("The exchange is not in the rollup.");
  }
  const exchange = decodeExchange(exchangeAccount.data);
  const found: Source[] = [];
  for (let id = 0; id < MAX_MARKETS; id += 1) {
    if (!((exchange.perpMarkets >> id) & 1)) continue;
    const [market, feed] = await Promise.all([
      on.rollup.getAccountInfo(addresses.market(id)),
      on.rollup.getAccountInfo(addresses.priceFeed(id)),
    ]);
    if (!market || !feed) continue;
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
  return found;
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
      console.log(`${at()} push failed: ${firstLine(error)}`);
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
        detail = `: ${firstLine(error)}`;
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
      `${at()} ${source.name.padEnd(11)} round failed: ${firstLine(error)}`,
    );
    return { outcome: "unreadable", errored: true };
  }
}

async function crank(on: Target): Promise<void> {
  const { everySeconds, giveUpAfter, pushing } = settings(on);
  if (on.profile === "mainnet") await deployedAsBuilt(on);
  await rollupIsRunBy(on);
  console.log(
    `cranking ${on.network} every ${everySeconds} s${pushing ? ", pushing Hermes updates to Solana when due" : ""}; giving up after ${giveUpAfter} failures or incident rounds in a row`,
  );
  const crankKey = keyAt(keyPath(on, "crank"));
  let streaks = new Map<string, number>();
  let erroredInARow = 0;
  for (;;) {
    let errored = false;
    let found: Source[] = [];
    try {
      found = await sources(on);
      if (found.length === 0) {
        throw new SetupError("No market or guard is bound to a Pyth account.");
      }
      streaks = afterOutcome(streaks, ROLLUP_READ, "synced");
    } catch (error) {
      if (roundErrorKind(error) === "fatal") throw error;
      console.log(`${at()} ${ROLLUP_READ} failed: ${firstLine(error)}`);
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
      const round = await syncedOrFailed(on, source, crankKey);
      streaks = afterOutcome(streaks, source.name, round.outcome);
      errored ||= round.errored;
    }
    const failing = givenUp(streaks, giveUpAfter);
    if (failing) {
      throw new Error(
        `${failing} failed or stayed in an incident ${giveUpAfter} rounds in a row. The crank stops.`,
      );
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

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
 * at the lowest free index, and nothing public counts them, so `KEEPER_SEATS`
 * is required: the seats the gate has ever opened plus the two reserved ones,
 * which bounds a sweep to the part of the table that can hold a position. A
 * sweep tries `ORDER_KEYS` seats at a time, so it takes about a round trip to
 * the rollup per four seats.
 *
 * A sweep fails when an attempt fails to send, a cover fails, or the keeper's
 * own margin cannot take a liquidatable seat, which is logged as an alert.
 * After `KEEPER_GIVE_UP` failed sweeps in a row the keeper exits non-zero, so
 * its supervisor tells someone. An error that stops a whole sweep (an
 * endpoint's 5xx or 429, a refused connection, a timeout) is logged, counts as
 * a failed sweep and doubles the pause before the next, up to 60 s, back to
 * `KEEPER_EVERY` after a good one. A wrong setup (a key file that cannot be
 * read, no seat, a seat without collateral on the first sweep, an exchange not
 * in the rollup) stops it at once: a takeover needs the keeper's own margin.
 *
 * The Makefile is the way in (`make rehearsal-keeper`).
 */
import { type Keypair } from "@solana/web3.js";
import {
  MARKET_STATUS,
  MAX_MARKETS,
  ORDER_KEYS,
  OrderKeyManager,
  SEATS,
  TraderClient,
  decodeExchange,
  decodeMarket,
  decodePriceFeed,
  decodeView,
  type MarketParams,
  type OrderResult,
} from "../sdk/dist/index.js";
import {
  keyPath,
  rollupIsRunBy,
  run,
  sendingAs,
  type Target,
} from "./deployment";
import { keyAt, readingAs } from "./keys";
import { deployedAsBuilt } from "./program";
import { send, sleep } from "./sending";
import {
  SetupError,
  attemptOf,
  backoffMs,
  emptySeatRefusal,
  endsSweep,
  marketsOwed,
  positiveInteger,
  roundErrorKind,
  sweepFailed,
  sweepTargets,
  worstPriceFor,
  type Attempt,
} from "./upkeep";

const at = () => new Date().toISOString();
const firstLine = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).split("\n")[0];

type Settings = { seats: number; everySeconds: number; giveUpAfter: number };

function settings(): Settings {
  const seats = positiveInteger("KEEPER_SEATS", process.env.KEEPER_SEATS, null);
  if (seats > SEATS) {
    throw new Error(`KEEPER_SEATS is ${seats}; the table has ${SEATS} seats.`);
  }
  return {
    seats,
    everySeconds: positiveInteger("KEEPER_EVERY", process.env.KEEPER_EVERY, 1),
    giveUpAfter: positiveInteger(
      "KEEPER_GIVE_UP",
      process.env.KEEPER_GIVE_UP,
      6,
    ),
  };
}

type PerpMarket = { id: number; params: MarketParams; mark: bigint };

const markOf = async (on: Target, id: number): Promise<bigint> => {
  const feed = await on.rollup.getAccountInfo(
    on.instructions.addresses.priceFeed(id),
  );
  if (!feed) throw new Error(`market ${id}'s price feed is unreadable`);
  return decodePriceFeed(feed.data).price;
};

/** Every perp market with its public settings and mark, as the rollup serves them. */
async function perpMarkets(on: Target): Promise<PerpMarket[]> {
  const { addresses } = on.instructions;
  const exchange = await on.rollup.getAccountInfo(addresses.exchange);
  if (!exchange) throw new SetupError("The exchange is not in the rollup.");
  const { perpMarkets: bits } = decodeExchange(exchange.data);
  const markets: PerpMarket[] = [];
  for (let id = 0; id < MAX_MARKETS; id += 1) {
    if (!((bits >> id) & 1)) continue;
    const [market, feed] = await Promise.all([
      on.rollup.getAccountInfo(addresses.market(id)),
      on.rollup.getAccountInfo(addresses.priceFeed(id)),
    ]);
    if (!market || !feed) continue;
    markets.push({
      id,
      params: decodeMarket(market.data).params,
      mark: decodePriceFeed(feed.data).price,
    });
  }
  return markets;
}

/**
 * The keeper as a trader, signed in afresh for each sweep, since a private
 * endpoint's sign-in runs out. Its order keys continue from its view.
 */
async function signedIn(on: Target, owner: Keypair) {
  const reader = await readingAs(on.privateUrl, owner);
  const view = await reader.getAccountInfo(
    on.instructions.addresses.view(owner.publicKey),
  );
  if (!view) {
    throw new SetupError(
      `The keeper ${owner.publicKey.toBase58()} has no seat. Run the setup target with KEEPER_DEPOSIT.`,
    );
  }
  const keys = OrderKeyManager.fromView(
    owner.secretKey.subarray(0, 32),
    decodeView(view.data),
  );
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
  if (attempt === "margin insufficient") {
    return `seat ${seat}: ALERT, liquidatable but the keeper's margin cannot take it; fund the keeper`;
  }
  if (attempt !== "liquidated") return `seat ${seat}: ${attempt}`;
  return (
    `seat ${seat}: liquidated, took ${result.filled} lots for ${result.filledNotional} quote atoms, ` +
    `cancelled ${result.cancelled} of its orders, insurance and fees paid ${result.fee}, ${result.rested} left uncovered`
  );
}

/**
 * One sweep of one market, `ORDER_KEYS` attempts at a time at the mark read
 * just before each batch, until done or a stale price ends it. Resolves to
 * what each attempt came to, counted.
 */
async function swept(
  on: Target,
  client: TraderClient,
  market: PerpMarket,
  targets: number[],
): Promise<Map<string, number>> {
  const began = Date.now();
  const counts = new Map<string, number>();
  const counted = (what: string) =>
    counts.set(what, (counts.get(what) ?? 0) + 1);
  let mark = market.mark;
  for (let first = 0; first < targets.length; first += ORDER_KEYS) {
    mark = await markOf(on, market.id);
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
            return attempt;
          })
          .catch((error: Error) => {
            counted("failed");
            console.log(
              `${at()} market ${market.id} seat ${seat}: failed, ${firstLine(error)}`,
            );
            return null;
          }),
      ),
    );
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
  return counts;
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
    console.log(`${at()} ${what} failed: ${firstLine(error)}`);
  };
  const shortfall = (of: PerpMarket[], id: number) =>
    of.find((market) => market.id === id)?.params.uncoveredShortfall;
  const sender = await sendingAs(on, owner);
  for (const id of owed) {
    console.log(
      `${at()} market ${id} records a shortfall of ${shortfall(markets, id)}: covering every seat`,
    );
    for (const seat of targets) {
      await send(sender, on.instructions.coverShortfall(id, seat), owner).catch(
        failure(`market ${id} cover of seat ${seat}`),
      );
    }
  }
  await send(
    sender,
    on.instructions.reconcileShortfall(markets.map(({ id }) => id)),
    owner,
  ).catch(failure("reconcile"));
  const after = await perpMarkets(on);
  for (const id of owed) {
    console.log(
      `${at()} market ${id} records ${shortfall(after, id)} after covering and reconciling`,
    );
  }
  return failed;
}

/**
 * One sweep of every perp market, then the covers. Resolves to whether it
 * failed, and throws when a read or a send outside an attempt does. On the
 * first sweep, a seat without collateral is refused.
 */
async function sweptAll(
  on: Target,
  owner: Keypair,
  seats: number,
  first: boolean,
): Promise<boolean> {
  const client = await signedIn(on, owner);
  try {
    const markets = await perpMarkets(on);
    if (markets.length > 0) await client.syncView(markets[0].id);
    const view = await client.view();
    const { collateral } = view.snapshot.seat;
    const refusal = first ? emptySeatRefusal(view.seat, collateral) : null;
    if (refusal) throw new SetupError(refusal);
    const targets = sweepTargets(seats, view.seat);
    console.log(
      `${at()} keeper seat ${view.seat}, collateral ${collateral} quote atoms`,
    );
    let failed = false;
    for (const market of markets) {
      if (market.params.status === MARKET_STATUS.paused) {
        console.log(
          `${at()} market ${market.id} is paused, so liquidation is refused there: skipped`,
        );
      } else if (market.mark === 0n) {
        console.log(`${at()} market ${market.id} has no mark yet: skipped`);
      } else if (sweepFailed(await swept(on, client, market, targets))) {
        failed = true;
      }
    }
    if (await covered(on, owner, markets, sweepTargets(seats, -1))) {
      failed = true;
    }
    return failed;
  } finally {
    client.close();
  }
}

async function keeper(on: Target): Promise<void> {
  const { seats, everySeconds, giveUpAfter } = settings();
  if (on.profile === "mainnet") await deployedAsBuilt(on);
  await rollupIsRunBy(on);
  const owner = keyAt(keyPath(on, "keeper"));
  console.log(
    `keeping ${on.network}: seats below ${seats}, a sweep every ${everySeconds} s, giving up after ${giveUpAfter} failed sweeps in a row`,
  );
  let failedInARow = 0;
  let erroredInARow = 0;
  let first = true;
  for (;;) {
    let failed: boolean;
    try {
      failed = await sweptAll(on, owner, seats, first);
      first = false;
      erroredInARow = 0;
    } catch (error) {
      if (roundErrorKind(error) === "fatal") throw error;
      console.log(`${at()} sweep failed: ${firstLine(error)}`);
      failed = true;
      erroredInARow += 1;
    }
    failedInARow = failed ? failedInARow + 1 : 0;
    if (failedInARow >= giveUpAfter) {
      throw new Error(
        `${giveUpAfter} sweeps in a row failed. The keeper stops.`,
      );
    }
    const pause = backoffMs(everySeconds * 1_000, erroredInARow);
    if (erroredInARow > 0) {
      console.log(`${at()} next sweep in ${pause / 1_000} s`);
    }
    await sleep(pause);
  }
}

run(keeper);

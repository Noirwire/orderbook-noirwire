/**
 * Drills for a rehearsal of the mainnet launch: each one makes the program
 * meet a price incident on purpose, proves it does what RULES says, then puts
 * back what it changed, so the market is left as it was found: active, the
 * USDC guard bound as launched and the market bound to its launch feed.
 *
 * - `guard-trip` (RULES 9a): binds the USDC guard with `depeg_bps` 1 and
 *   proves that while it does not pass, unread and then depegged, a perp order
 *   that grows a position is refused with `QuoteGuardTripped` and a
 *   reduce-only one is taken; then binds the launch's settings again and
 *   proves the guard passes. A crank that syncs the guard around a check
 *   makes that check a skip, not a failure.
 * - `stale-price` (RULES 9, Freshness): sends no `sync_price` until the mark
 *   is older than the market's max age, proves an increasing order and a
 *   withdrawal by a seat with a position are refused as stale, then syncs and
 *   proves orders are taken again. A crank that keeps the mark fresh
 *   meanwhile makes it a skip, not a failure.
 * - `rebind` (RULES 7 and 9, Rebinding): closes the smoke traders' positions
 *   against each other, pauses the market, rebinds it to the launch's feed,
 *   proves the mark, source record, incident and funding totals are cleared,
 *   syncs a first mark, checks it as the launch does and resumes.
 *
 * They trade as the smoke's traders a and b, whose seats must exist and hold
 * collateral, and act as the admin. They never run on mainnet, whatever the
 * Makefile says: the check is here. `DRILLS=a,b` picks drills by name; all of
 * them run by default. Each check prints an ok, FAIL or SKIP line. What a
 * drill changed is put back even when it stops, and a restore that fails
 * says how the market is left and stops the run there. The run exits non-zero
 * when a check failed, and also when a skip left a drill's claim unproven.
 *
 * The Makefile is the way in (`make rehearsal-drills`).
 */
import { existsSync } from "fs";
import type {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getMint } from "@solana/spl-token";
import {
  MARKET_STATUS,
  MarketReader,
  ORACLE_HEALTH,
  ORDER_TYPE,
  OrderKeyManager,
  QUOTE_STATE,
  SIDE,
  TraderClient,
  TransactionFailed,
  clockOf,
  decodeMarket,
  decodeView,
  pythPriceAccount,
  type MarketParams,
  type PriceFeed,
} from "../sdk/dist/index.js";
import {
  MAINNET_MARKET,
  MAINNET_QUOTE_SOURCE,
  MAINNET_QUOTE_TOKEN,
  adminKeyPath,
  depositingAs,
  errorLine,
  keyPath,
  rollupIsRunBy,
  run,
  sendingAs,
  type Target,
} from "./deployment";
import {
  DRILL_ERRORS,
  bookFunding,
  closingTrade,
  drillRefusal,
  drillsSelected,
  exitCodeFor,
  fundingReset,
  guardTrips,
  lineText,
  orderAttempt,
  quoteMoved,
  refusalShown,
  refusedWith,
  staleWait,
  syncWaitsOn,
  taken,
  unlessSyncedMeanwhile,
  unproven,
  type Attempt,
  type Drill,
  type Line,
  type Verdict,
} from "./drilling";
import { heldKey, readingAs } from "./keys";
import { resumeVerdict } from "./launch";
import {
  checkedMark,
  exchangeInRollup,
  launchedMarket,
  onTick,
  perpMarketIds,
  priceFeedInRollup,
  quoteBoundAsLaunched,
  quotePasses,
  smallestSize,
} from "./market";
import { deployedAsBuilt } from "./program";
import { observationIn } from "./pyth";
import { send, sleep } from "./sending";
import { minted, movedIntoRollup } from "./tokens";
import { errorCode, nameIn, syncDecision } from "./upkeep";

/** How long a drill waits for the Pyth observation it needs. */
const OBSERVATION_WAIT_MS = 6 * 60_000;
const POLL_MS = 2_000;
/** Beyond the market's max age, how long the stale drill waits for the mark to age. */
const STALE_WAIT_SLACK_SECONDS = 60;
/** A mark this close to the market's max age would go stale under an order. */
const MARK_AGE_MARGIN_SECONDS = 15n;
const FAR_FROM_THE_MARK_TICKS = 20n;
/** What the stale drill tries to withdraw: refused if RULES holds, and next to nothing if not. */
const WITHDRAWN_ATOMS = 1n;

type Trader = { name: string; owner: Keypair; client: TraderClient };

type Drilling = {
  on: Target;
  admin: Keypair;
  asAdmin: Connection;
  id: number;
  traders: [Trader, Trader];
  lines: Line[];
  /** What a drill could not put back as it found it; the run stops on the first. */
  unrestored: string[];
};

function reported(d: Drilling, line: Line) {
  d.lines.push(line);
  console.log(lineText(line));
}

const report = (d: Drilling, verdict: Verdict, what: string, detail = "") =>
  reported(d, { verdict, what, detail });

const firstLine = (error: unknown) => errorLine(error);

/**
 * Runs a drill's step that puts back what it changed, and never throws, so a
 * failed restore is reported in its own words instead of hiding the error
 * that stopped the drill. `step` says what it found in an ok line, or returns
 * null when there was nothing to put back; when it throws, the FAIL line says
 * how the market is `left` and the run stops after this drill.
 */
async function restoring(
  d: Drilling,
  what: string,
  left: string,
  step: () => Promise<string | null>,
): Promise<boolean> {
  try {
    const found = await step();
    if (found !== null) report(d, "ok", what, found);
    return true;
  } catch (error) {
    report(d, "FAIL", what, `${firstLine(error)}; ${left}`);
    d.unrestored.push(left);
    return false;
  }
}

async function trader(on: Target, name: string): Promise<Trader> {
  const path = keyPath(on, `smoke-${name}`);
  if (!existsSync(path)) {
    throw new Error(
      `${path} is missing: the drills trade as the smoke's traders. Run the smoke first.`,
    );
  }
  const owner = heldKey(path);
  const reader = await readingAs(on.privateUrl, owner);
  const view = await reader.getAccountInfo(
    on.instructions.addresses.view(owner.publicKey),
  );
  if (!view) {
    throw new Error(`Trader ${name} has no seat. Run the smoke first.`);
  }
  const client = new TraderClient(
    await sendingAs(on, owner),
    reader,
    owner.publicKey,
    OrderKeyManager.fromView(
      owner.secretKey.subarray(0, 32),
      decodeView(view.data),
    ),
    on.instructions.programId,
    { push: false },
  );
  await client.ready();
  return { name, owner, client };
}

type MarketNow = { params: MarketParams; feed: PriceFeed; clock: number };

async function marketNow(d: Drilling): Promise<MarketNow> {
  const [market, feed, clock] = await Promise.all([
    d.on.rollup.getAccountInfo(d.on.instructions.addresses.market(d.id)),
    priceFeedInRollup(d.on, d.id),
    clockOf(d.on.rollup),
  ]);
  if (!market || !feed) throw new Error(`market ${d.id} is not readable`);
  return { params: decodeMarket(market.data).params, feed, clock };
}

const isFresh = ({ params, feed, clock }: MarketNow) =>
  feed.price > 0n &&
  BigInt(clock) - feed.publishTime <=
    params.maxPriceAge - MARK_AGE_MARGIN_SECONDS;

type Order = {
  side: number;
  orderType: number;
  price: bigint;
  size: bigint;
  reduceOnly: boolean;
};

/** Places `order` and says what came of it, the program's refusal included. */
async function attempted(
  d: Drilling,
  who: Trader,
  order: Order,
): Promise<Attempt> {
  try {
    const placed = await who.client.placeOrder(d.id, order);
    const settled =
      placed.outcome === "unknown" ? await placed.settled : placed;
    if (settled.outcome !== "placed") {
      return { accepted: false, code: null, message: "expired with no result" };
    }
    return orderAttempt(settled.result, order.size);
  } catch (error) {
    if (error instanceof TransactionFailed) {
      return { accepted: false, code: error.code, message: error.message };
    }
    throw error;
  }
}

const sent = (sending: Promise<unknown>): Promise<Attempt> =>
  sending.then(
    () => ({ accepted: true, detail: "it landed" }),
    (error: Error) => ({
      accepted: false,
      code: errorCode(error.message),
      message: firstLine(error),
    }),
  );

const asAdmin = (d: Drilling, instruction: TransactionInstruction) =>
  send(d.asAdmin, instruction, d.admin);

async function positions(d: Drilling): Promise<[bigint, bigint]> {
  const read = async ({ client }: Trader) => {
    await client.syncView(d.id);
    return (await client.view()).snapshot.seat.perp[d.id].base;
  };
  return [await read(d.traders[0]), await read(d.traders[1])];
}

/**
 * `seller` rests a plain limit ask at the mark and `buyer` crosses it with a
 * market order, reduce-only when `buyerReduces`. A reduce-only order never
 * rests (RULES 2), so the resting side of a closing trade is a plain order no
 * larger than the position it shrinks.
 */
async function tradedBetween(
  d: Drilling,
  seller: Trader,
  buyer: Trader,
  size: bigint,
  buyerReduces: boolean,
): Promise<void> {
  const now = await marketNow(d);
  const mark = onTick(now.feed.price, now.params.tick);
  let crossed: Attempt;
  try {
    const rested = await attempted(d, seller, {
      side: SIDE.ask,
      orderType: ORDER_TYPE.limit,
      price: mark,
      size,
      reduceOnly: false,
    });
    if (!rested.accepted) {
      throw new Error(
        `trader ${seller.name}'s ask was refused with ${refusalShown(rested)}`,
      );
    }
    crossed = await attempted(d, buyer, {
      side: SIDE.bid,
      orderType: ORDER_TYPE.market,
      price: mark + now.params.tick,
      size,
      reduceOnly: buyerReduces,
    });
  } finally {
    await seller.client.cancelAll(d.id);
  }
  if (!crossed.accepted) {
    throw new Error(
      `trader ${buyer.name}'s bid was refused with ${refusalShown(crossed)}`,
    );
  }
}

/** The smoke traders' orders cancelled and their positions closed against each other as far as they offset. */
async function flattened(d: Drilling): Promise<[bigint, bigint]> {
  for (const { client } of d.traders) await client.cancelAll(d.id);
  const trade = closingTrade(await positions(d));
  if (trade) {
    await tradedBetween(
      d,
      d.traders[trade.long],
      d.traders[trade.short],
      trade.size,
      true,
    );
  }
  return positions(d);
}

type Held = { holder: Trader; base: bigint };

/** A trader of the two that holds a position, or null. */
async function holderOfAPosition(d: Drilling): Promise<Held | null> {
  const held = await positions(d);
  const at = held.findIndex((base) => base !== 0n);
  return at < 0 ? null : { holder: d.traders[at], base: held[at] };
}

/** The smallest position, trader a short against trader b, opened for a drill that needs one. */
async function openedForTheDrill(d: Drilling): Promise<Held> {
  const now = await marketNow(d);
  const size = smallestSize(
    now.params,
    onTick(now.feed.price, now.params.tick),
  );
  await tradedBetween(d, d.traders[0], d.traders[1], size, false);
  const [a, b] = await positions(d);
  if (a === 0n) throw new Error("the trade that opens a position did not fill");
  report(
    d,
    "ok",
    "a small position opened for the drill",
    `trader a ${a} lots, trader b ${b}`,
  );
  return { holder: d.traders[0], base: a };
}

const POSITION_LEFT_OPEN =
  "the drill's position may stay open: close trader a's and trader b's positions against each other";

/**
 * Closes a position the drill opened, or may have opened before something
 * threw, on a fresh mark, and reports where the two traders are left. With
 * `restored` false, the drill's mark or guard was not put back, so no close
 * could pass: nothing is sent and the position is reported as left open.
 */
const closedAgain = (d: Drilling, restored: boolean) =>
  restoring(
    d,
    "the drill's position closed again",
    POSITION_LEFT_OPEN,
    async () => {
      if (!restored) {
        const [a, b] = await positions(d);
        throw new Error(
          `trader a ${a} lots, trader b ${b}: the drill's change was not put back, so no close could pass and none was sent`,
        );
      }
      await freshened(d);
      const [a, b] = await flattened(d);
      const where = `trader a ${a} lots, trader b ${b}`;
      if (a !== 0n || b !== 0n) throw new Error(where);
      return where;
    },
  );

type Source = { address: PublicKey; recorded: bigint; maxAge: bigint };

type Sync = {
  what: string;
  source: () => Promise<Source>;
  instruction: (address: PublicKey) => TransactionInstruction;
  done: () => Promise<boolean>;
};

/**
 * Sends `sync` for each newer observation of its Pyth account until `done`,
 * polling the account and waiting at most `OBSERVATION_WAIT_MS`. A sync that
 * another sender beat, or whose observation aged out, waits for the next.
 */
async function syncedUntil(d: Drilling, sync: Sync): Promise<boolean> {
  const deadline = Date.now() + OBSERVATION_WAIT_MS;
  for (;;) {
    if (await sync.done()) return true;
    if (Date.now() > deadline) return false;
    const { address, recorded, maxAge } = await sync.source();
    const account = await d.on.rollup.getAccountInfo(address).catch(() => null);
    const observation = account ? observationIn(account.data) : null;
    const decision = syncDecision(
      observation?.publishTime ?? null,
      Number(recorded),
      await clockOf(d.on.rollup),
      Number(maxAge),
    );
    if (decision !== "send") {
      await sleep(POLL_MS);
      continue;
    }
    const outcome = await sent(asAdmin(d, sync.instruction(address)));
    if (outcome.accepted) continue;
    if (!syncWaitsOn(outcome.code)) {
      throw new Error(`${sync.what} was refused with ${refusalShown(outcome)}`);
    }
    await sleep(POLL_MS);
  }
}

const priceSync = (d: Drilling, done: Sync["done"]): Sync => ({
  what: "sync_price",
  source: async () => {
    const { feed, params } = await marketNow(d);
    return {
      address: feed.binding.account,
      recorded: feed.source.publishTime,
      maxAge: params.maxPriceAge,
    };
  },
  instruction: (address) => d.on.instructions.syncPrice(d.id, address),
  done,
});

const quoteSync = (d: Drilling, done: Sync["done"]): Sync => ({
  what: "sync_quote",
  source: async () => {
    const { quote } = await exchangeInRollup(d.on);
    return {
      address: quote.account,
      recorded: quote.publishTime,
      maxAge: quote.maxAge,
    };
  },
  instruction: (address) => d.on.instructions.syncQuote(address),
  done,
});

const guardPassing = async (d: Drilling) =>
  quotePasses(await exchangeInRollup(d.on), await clockOf(d.on.rollup));

/** Whether the guard passes, synced from newer USDC observations until it does. */
const guardSynced = (d: Drilling) =>
  syncedUntil(
    d,
    quoteSync(d, () => guardPassing(d)),
  );

/** The mark fresh and the guard passing, synced from a newer observation where either is not. */
async function freshened(d: Drilling): Promise<void> {
  if (
    !(await syncedUntil(
      d,
      priceSync(d, async () => isFresh(await marketNow(d))),
    ))
  ) {
    throw new Error("no fresh SOL/USD observation came within 6 minutes");
  }
  if (!(await guardSynced(d))) {
    throw new Error(
      "no USDC/USD observation that passes the guard came within 6 minutes",
    );
  }
}

/** Stops the drill unless the market is the launch's, active with a healthy source, and the USDC guard is bound as launched. */
async function asLaunched(d: Drilling): Promise<MarketNow> {
  await launchedMarket(d.on);
  const exchange = await exchangeInRollup(d.on);
  const { quote } = exchange;
  if (!quoteBoundAsLaunched(exchange)) {
    throw new Error(
      `the USDC guard is not bound as launched (depeg_bps ${quote.depegBps}, state ${nameIn(QUOTE_STATE, quote.state)}); the drills start from the launch's guard: run setup to bind it again`,
    );
  }
  const now = await marketNow(d);
  const { status, oracleHealth } = now.params;
  if (
    status !== MARKET_STATUS.active ||
    oracleHealth !== ORACLE_HEALTH.healthy
  ) {
    throw new Error(
      `the market is ${nameIn(MARKET_STATUS, status)} with its source ${nameIn(ORACLE_HEALTH, oracleHealth)}; the drills start from an active market with a healthy source`,
    );
  }
  return now;
}

/**
 * An order `ticks` away from the mark on its resting side: on the side that
 * grows `base`, post-only, or a reduce-only one that shrinks it, which never
 * rests and most likely meets nothing that far out.
 */
async function awayFromTheMark(
  d: Drilling,
  base: bigint,
  grows: boolean,
): Promise<Order> {
  const now = await marketNow(d);
  const long = base > 0n;
  const side = long === grows ? SIDE.bid : SIDE.ask;
  const mark = onTick(now.feed.price, now.params.tick);
  const distance = FAR_FROM_THE_MARK_TICKS * now.params.tick;
  const price = side === SIDE.ask ? mark + distance : mark - distance;
  return {
    side,
    orderType: grows ? ORDER_TYPE.postOnly : ORDER_TYPE.immediateOrCancel,
    price,
    size: smallestSize(now.params, price),
    reduceOnly: !grows,
  };
}

/** An increasing order by `who`, cancelled again if it was taken, so the book is left as found. */
async function increasing(
  d: Drilling,
  who: Trader,
  base: bigint,
): Promise<Attempt> {
  const attempt = await attempted(d, who, await awayFromTheMark(d, base, true));
  if (attempt.accepted) await who.client.cancelAll(d.id);
  return attempt;
}

const quoteNow = async (d: Drilling) => (await exchangeInRollup(d.on)).quote;

const guardCranked = (
  what: string,
  before: { state: number },
  after: { state: number; publishTime: bigint },
): Line => ({
  verdict: "SKIP",
  what,
  detail: `the guard was synced meanwhile, ${nameIn(QUOTE_STATE, before.state)} then ${nameIn(QUOTE_STATE, after.state)} at a publish time of ${after.publishTime}, while the drill sent no sync_quote: a crank is running. Stop it and run the drill again`,
});

/**
 * `check`, made while the guard reads `failing`, as a skip when someone
 * else synced the guard around it and it did not come out ok.
 */
async function whileGuardReads(
  d: Drilling,
  failing: number,
  check: () => Promise<Line>,
): Promise<Line> {
  const before = await quoteNow(d);
  const line = await check();
  const after = await quoteNow(d);
  return unlessSyncedMeanwhile(
    line,
    quoteMoved(before, after, failing),
    guardCranked(line.what, before, after),
  );
}

/** RULES 9a: while the guard reads `failing`, growth is refused and a reduce-only order is taken. */
async function provedWhileFailing(
  d: Drilling,
  held: Held,
  failing: number,
  when: string,
) {
  const { holder, base } = held;
  reported(
    d,
    await whileGuardReads(d, failing, async () =>
      refusedWith(
        `an order that grows trader ${holder.name}'s position, ${when}`,
        await increasing(d, holder, base),
        DRILL_ERRORS.QuoteGuardTripped,
      ),
    ),
  );
  reported(
    d,
    await whileGuardReads(d, failing, async () =>
      taken(
        `a reduce-only order of trader ${holder.name}, ${when}`,
        await attempted(d, holder, await awayFromTheMark(d, base, false)),
      ),
    ),
  );
}

const quoteShown = (quote: { price: bigint; expo: number }) =>
  `USDC at ${quote.price} x 10^${quote.expo}`;

const GUARD_LEFT_TRIPPED =
  "the USDC guard may still be at depeg_bps 1 or unbound, which refuses every order that grows a perp position: run setup to bind it as launched";

/** The launch's guard bound again and passing, as `restoring` reports it. */
const guardRestored = (d: Drilling) =>
  restoring(
    d,
    "the guard is bound as launched again and passes",
    GUARD_LEFT_TRIPPED,
    async () => {
      await asAdmin(
        d,
        d.on.instructions.setQuoteSource(
          d.admin.publicKey,
          MAINNET_QUOTE_SOURCE,
        ),
      );
      const passing = await guardSynced(d);
      const exchange = await exchangeInRollup(d.on);
      const { quote } = exchange;
      const found = `depeg_bps ${quote.depegBps}, state ${nameIn(QUOTE_STATE, quote.state)}, ${quoteShown(quote)}`;
      if (!passing || !quoteBoundAsLaunched(exchange)) throw new Error(found);
      return found;
    },
  );

async function guardTrip(d: Drilling): Promise<void> {
  await asLaunched(d);
  let opening = false;
  let tripping = false;
  try {
    let held = await holderOfAPosition(d);
    if (!held) {
      await freshened(d);
      opening = true;
      held = await openedForTheDrill(d);
    }
    tripping = true;
    await asAdmin(
      d,
      d.on.instructions.setQuoteSource(d.admin.publicKey, {
        ...MAINNET_QUOTE_SOURCE,
        depegBps: 1,
      }),
    );
    const unread = await quoteNow(d);
    const unreadLine: Line = {
      verdict: unread.state === QUOTE_STATE.unbound ? "ok" : "FAIL",
      what: "set_quote_source with depeg_bps 1 leaves the guard unread, so it fails closed",
      detail: `state ${nameIn(QUOTE_STATE, unread.state)}`,
    };
    reported(
      d,
      unlessSyncedMeanwhile(
        unreadLine,
        unread.publishTime !== 0n,
        guardCranked(unreadLine.what, { state: QUOTE_STATE.unbound }, unread),
      ),
    );
    await provedWhileFailing(
      d,
      held,
      QUOTE_STATE.unbound,
      "while the guard is unread",
    );

    const depegged = await syncedUntil(
      d,
      quoteSync(
        d,
        async () =>
          (await exchangeInRollup(d.on)).quote.state === QUOTE_STATE.depegged,
      ),
    );
    const { quote } = await exchangeInRollup(d.on);
    if (!depegged) {
      const read = quote.publishTime > 0n;
      report(
        d,
        read && guardTrips(quote.price, quote.expo, 1) ? "FAIL" : "SKIP",
        "sync_quote trips the guard",
        read
          ? `${quoteShown(quote)} reads ${nameIn(QUOTE_STATE, quote.state)}: no observation for 6 minutes was more than 1 bp from a dollar, and depeg_bps goes no lower`
          : "no USDC/USD observation young enough to sync came within 6 minutes",
      );
      return;
    }
    report(
      d,
      "ok",
      "sync_quote trips the guard",
      `${quoteShown(quote)}, more than 1 bp from a dollar, reads depegged`,
    );
    await provedWhileFailing(
      d,
      held,
      QUOTE_STATE.depegged,
      "while the guard is depegged",
    );
  } finally {
    const restored = !tripping || (await guardRestored(d));
    if (opening) await closedAgain(d, restored);
  }
}

/**
 * A token account of `who`'s in the rollup, which a withdrawal pays into and
 * the program checks before anything else. One the trader lacks is made with
 * one atom the admin mints, which only a test mint allows.
 */
async function holdingInRollup(d: Drilling, who: Trader) {
  const { on } = d;
  const token = (await exchangeInRollup(on)).tokens[MAINNET_QUOTE_TOKEN.index];
  const account = getAssociatedTokenAddressSync(
    token.mint,
    who.owner.publicKey,
    true,
  );
  const connection = await depositingAs(on, who.owner);
  if (await connection.getAccountInfo(account)) {
    return { token, account, connection };
  }
  const { mintAuthority } = await getMint(on.solana, token.mint);
  if (!mintAuthority?.equals(d.admin.publicKey)) {
    throw new Error(
      `trader ${who.name} has no token account in the rollup for a withdrawal to pay into, and the admin cannot mint it one atom of ${token.mint.toBase58()}`,
    );
  }
  await minted(on.solana, d.admin, token.mint, who.owner.publicKey, 1n);
  await movedIntoRollup(
    on.solana,
    connection,
    d.admin,
    who.owner,
    token.mint,
    1n,
    on.validator,
    token.custodyVisibility,
  );
  report(
    d,
    "ok",
    `trader ${who.name} given a token account in the rollup to withdraw to`,
    "one atom the admin minted",
  );
  return { token, account, connection };
}

/** The market once its mark has aged past the max age with no sync, or null when someone synced it meanwhile. */
async function wentStale(
  d: Drilling,
  startedAt: bigint,
): Promise<MarketNow | null> {
  const first = await marketNow(d);
  const deadline =
    Date.now() +
    (Number(first.params.maxPriceAge) + STALE_WAIT_SLACK_SECONDS) * 1_000;
  for (let now = first; ; now = await marketNow(d)) {
    const wait = staleWait(
      startedAt,
      now.feed.publishTime,
      now.clock,
      now.params.maxPriceAge,
    );
    if (wait === "synced meanwhile") return null;
    if (wait === "stale") return now;
    if (Date.now() > deadline) {
      throw new Error("the mark did not go stale in time");
    }
    await sleep(POLL_MS);
  }
}

const crankRunning = (startedAt: bigint, now: MarketNow): Line => ({
  verdict: "SKIP",
  what: "the stale-price drill",
  detail: `the mark was synced to a publish time of ${now.feed.publishTime}, after ${startedAt}, while the drill sent no sync_price: a crank is running. Stop it and run the drill again`,
});

const MARK_LEFT_STALE =
  "the mark may be left stale or the USDC guard not passing, which refuses growth, and on a stale mark withdrawals by any seat with a position: let the crank sync them";

/** The mark fresh and the guard passing again, as `restoring` reports it; silent when nothing needed it. */
const markRestored = (d: Drilling) =>
  restoring(
    d,
    "the mark is fresh and the guard passes after the drill",
    MARK_LEFT_STALE,
    async () => {
      if (isFresh(await marketNow(d)) && (await guardPassing(d))) return null;
      await freshened(d);
      const now = await marketNow(d);
      return `mark ${now.feed.price}, ${now.clock - Number(now.feed.publishTime)} s old`;
    },
  );

async function stalePrice(d: Drilling): Promise<void> {
  const start = await asLaunched(d);
  let opening = false;
  try {
    let held = await holderOfAPosition(d);
    if (!held && isFresh(start) && (await guardPassing(d))) {
      opening = true;
      held = await openedForTheDrill(d);
    }
    const holding = held && (await holdingInRollup(d, held.holder));
    const startedAt = (await marketNow(d)).feed.publishTime;
    const stale = await wentStale(d, startedAt);
    if (!stale) {
      reported(d, crankRunning(startedAt, await marketNow(d)));
      return;
    }
    report(
      d,
      "ok",
      "the mark goes stale with no sync_price",
      `${stale.clock - Number(stale.feed.publishTime)} s old against a max age of ${stale.params.maxPriceAge} s`,
    );
    /** `check` on the stale mark, or null once a crank was seen syncing it, which ends the drill as a skip. */
    const onTheStaleMark = async (check: () => Promise<Line>) => {
      const line = await check();
      const now = await marketNow(d);
      const cranked = crankRunning(startedAt, now);
      const kept = unlessSyncedMeanwhile(
        line,
        now.feed.publishTime > startedAt,
        cranked,
      );
      reported(d, kept);
      return kept !== cranked;
    };

    const who = held?.holder ?? d.traders[0];
    const base = held?.base ?? 1n;
    if (!(await guardSynced(d))) {
      report(
        d,
        "SKIP",
        "an increasing order on a stale mark",
        "the USDC guard is not passing, so QuoteGuardTripped would refuse it first",
      );
    } else if ((await marketNow(d)).feed.publishTime > startedAt) {
      reported(d, crankRunning(startedAt, await marketNow(d)));
      return;
    } else if (
      !(await onTheStaleMark(async () =>
        refusedWith(
          `an order that grows trader ${who.name}'s position, on a stale mark`,
          await increasing(d, who, base),
          DRILL_ERRORS.StalePrice,
        ),
      ))
    ) {
      return;
    }

    if (held && holding) {
      const holder = held;
      const withdrew = await onTheStaleMark(async () =>
        refusedWith(
          `a withdrawal by trader ${holder.holder.name}, who holds ${holder.base} lots, on a stale mark`,
          await sent(
            send(
              holding.connection,
              d.on.instructions.withdraw(
                holder.holder.owner.publicKey,
                holding.account,
                holding.token,
                { collateral: true },
                WITHDRAWN_ATOMS,
                await perpMarketIds(d.on),
              ),
              holder.holder.owner,
            ),
          ),
          DRILL_ERRORS.StalePrice,
        ),
      );
      if (!withdrew) return;
    } else {
      report(
        d,
        "SKIP",
        "a withdrawal by a seat with a position, on a stale mark",
        "neither trader holds a position, and none can be opened on a stale mark",
      );
    }

    const synced = await syncedUntil(
      d,
      priceSync(
        d,
        async () => (await marketNow(d)).feed.publishTime > startedAt,
      ),
    );
    const after = await marketNow(d);
    report(
      d,
      synced && after.params.oracleHealth === ORACLE_HEALTH.healthy
        ? "ok"
        : "FAIL",
      "sync_price takes a newer observation and the mark is fresh again",
      `mark ${after.feed.price}, ${after.clock - Number(after.feed.publishTime)} s old, source ${nameIn(ORACLE_HEALTH, after.params.oracleHealth)}`,
    );
    await freshened(d);
    reported(
      d,
      taken(
        "an increasing order once the mark is fresh again",
        await increasing(d, who, base),
      ),
    );
  } finally {
    const restored = await markRestored(d);
    if (opening) await closedAgain(d, restored);
  }
}

/** The book's funding state where the endpoint serves the book, or null where it is private. */
async function fundingRead(d: Drilling) {
  const book = await d.on.rollup
    .getAccountInfo(d.on.instructions.addresses.book(d.id))
    .catch(() => null);
  return book ? bookFunding(book.data) : null;
}

async function rebind(d: Drilling): Promise<void> {
  const { on, id } = d;
  await asLaunched(d);
  await freshened(d);
  const [a, b] = await flattened(d);
  report(
    d,
    a === 0n && b === 0n ? "ok" : "FAIL",
    "the smoke traders' orders cancelled and positions closed against each other",
    `trader a ${a} lots, trader b ${b}`,
  );
  const reader = new MarketReader(on.rollup, on.instructions.programId);
  const openInterest = (await reader.stats()).openInterest[id];
  if (openInterest !== 0n) {
    report(
      d,
      "FAIL",
      "no open interest before the rebind",
      `${openInterest} lots stay open on other seats; set_price_source needs none, so the market is left active`,
    );
    return;
  }
  report(d, "ok", "no open interest before the rebind");
  const perps = await perpMarketIds(on);
  const resume = () =>
    sent(
      asAdmin(d, on.instructions.resumeMarket(d.admin.publicKey, id, perps)),
    );

  try {
    await asAdmin(
      d,
      on.instructions.restrictMarket(
        d.admin.publicKey,
        id,
        MARKET_STATUS.paused,
      ),
    );
    report(d, "ok", "the market is paused, as set_price_source requires");
    await reboundAndResumed(d, resume);
  } finally {
    await marketRestored(d);
  }
}

const MARKET_LEFT_PAUSED =
  "the market may be left paused, perhaps with no mark, which refuses every order on it: run setup with RESTORE=resume once the crank has synced a mark that passes the check";

/** The market active again after the rebind drill paused it, as `restoring` reports it. */
const marketRestored = (d: Drilling) =>
  restoring(d, "the market is active again", MARKET_LEFT_PAUSED, async () => {
    const { params, feed } = await marketNow(d);
    const found = `status ${nameIn(MARKET_STATUS, params.status)}, mark ${feed.price}`;
    if (params.status !== MARKET_STATUS.active) throw new Error(found);
    return found;
  });

/** On the paused market: the rebind, its proof, a first mark checked as the launch does, and the resume. */
async function reboundAndResumed(
  d: Drilling,
  resume: () => Promise<Attempt>,
): Promise<void> {
  const { on, id } = d;
  const { feedId, expo } = MAINNET_MARKET.settings.priceSource;
  const rebindAt = await clockOf(on.rollup);
  const rebound = await sent(
    asAdmin(
      d,
      on.instructions.setPriceSource(d.admin.publicKey, id, feedId, expo),
    ),
  );
  if (!rebound.accepted) {
    report(
      d,
      "FAIL",
      "set_price_source with the launch's feed",
      rebound.code === DRILL_ERRORS.PriceSourceInUse
        ? `refused with ${refusalShown(rebound)}: the book still holds open interest or an order, which a seat other than the drill's traders may rest`
        : `refused with ${refusalShown(rebound)}`,
    );
    reported(
      d,
      taken("resume_market, back to the market as found", await resume()),
    );
    return;
  }
  const cleared = await marketNow(d);
  const { feed } = cleared;
  report(
    d,
    feed.price === 0n &&
      feed.source.publishTime === 0n &&
      feed.incident.reason === 0 &&
      cleared.params.oracleHealth === ORACLE_HEALTH.healthy &&
      feed.binding.account.equals(pythPriceAccount(feedId))
      ? "ok"
      : "FAIL",
    "set_price_source binds the launch's feed and clears the mark, the source record and the incident",
    `mark ${feed.price}, source publish time ${feed.source.publishTime}, incident ${feed.incident.reason}, health ${nameIn(ORACLE_HEALTH, cleared.params.oracleHealth)}`,
  );
  const funding = await fundingRead(d);
  if (funding) {
    report(
      d,
      fundingReset(funding, rebindAt) ? "ok" : "FAIL",
      "the funding totals are cleared and the funding clock restarts at the rebind",
      `premium ${funding.tradedPremium}, size ${funding.tradedSize}, last update ${funding.lastTime}, rebind at ${rebindAt} or later`,
    );
  } else {
    reported(d, {
      verdict: "SKIP",
      what: "the funding totals are cleared",
      detail: `${on.rollupUrl} does not serve the book as the program lays it out, so its funding totals cannot be read here`,
      aside: true,
    });
  }

  const marked = await syncedUntil(
    d,
    priceSync(d, async () => (await marketNow(d)).feed.price > 0n),
  );
  const first = await marketNow(d);
  if (!marked) {
    report(
      d,
      "FAIL",
      "sync_price sets the first mark after the rebind",
      "no SOL/USD observation young enough came within 6 minutes",
    );
    return;
  }
  report(
    d,
    first.params.status === MARKET_STATUS.paused ? "ok" : "FAIL",
    "sync_price sets the first mark after the rebind, and the market stays paused",
    `mark ${first.feed.price}, status ${nameIn(MARKET_STATUS, first.params.status)}`,
  );
  const { mark, reference, covered, openInterestCap } = await checkedMark(on);
  const verdict = resumeVerdict({
    mark,
    reference,
    confirmed: true,
    covered,
    openInterestCap,
    adminUpgrades: false,
    keeperWhy: null,
  });
  if (!verdict.resume) {
    report(
      d,
      "FAIL",
      "the first mark passes the launch's resume check",
      verdict.why,
    );
    return;
  }
  report(
    d,
    "ok",
    "the first mark passes the launch's resume check",
    `mark ${mark} against a reference of ${reference}`,
  );
  reported(d, taken("resume_market", await resume()));
}

const DRILLED: Record<Drill, (d: Drilling) => Promise<void>> = {
  "guard-trip": guardTrip,
  "stale-price": stalePrice,
  rebind,
};

async function drills(on: Target): Promise<void> {
  const refusal = drillRefusal(on);
  if (refusal) throw new Error(refusal);
  const selected = drillsSelected(process.env.DRILLS);
  await deployedAsBuilt(on);
  await rollupIsRunBy(on);
  const admin = heldKey(adminKeyPath(on));
  const d: Drilling = {
    on,
    admin,
    asAdmin: await sendingAs(on, admin),
    id: MAINNET_MARKET.id,
    traders: [await trader(on, "a"), await trader(on, "b")],
    lines: [],
    unrestored: [],
  };
  const notProven: Drill[] = [];
  for (const [at, drill] of selected.entries()) {
    console.log(`drill ${drill}`);
    const from = d.lines.length;
    await DRILLED[drill](d).catch((error) =>
      report(d, "FAIL", `the ${drill} drill stopped`, firstLine(error)),
    );
    if (unproven(d.lines.slice(from)).length > 0) notProven.push(drill);
    const left = selected.slice(at + 1);
    if (d.unrestored.length > 0 && left.length > 0) {
      report(
        d,
        "FAIL",
        `the drills after ${drill}`,
        `not run (${left.join(", ")}): ${drill} did not put the market back as it found it, so they would prove nothing`,
      );
      break;
    }
  }
  const count = (verdict: Verdict) =>
    d.lines.filter((line) => line.verdict === verdict).length;
  console.log(
    `${count("ok")} ok, ${count("SKIP")} skipped, ${count("FAIL")} failed`,
  );
  for (const drill of notProven) {
    console.log(
      `NOT PROVEN ${drill}: a check it rests on was skipped, as its SKIP lines say`,
    );
  }
  if (exitCodeFor(d.lines) !== 0) {
    throw new Error(
      count("FAIL") > 0
        ? "A drill failed: its FAIL lines say which check, and how the market was left."
        : "No check failed, but a drill's claim stays unproven: its SKIP lines say why, and what to change before running it again.",
    );
  }
}

run(drills);

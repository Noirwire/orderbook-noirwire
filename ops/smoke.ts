/**
 * Proves a deployment the way a trader meets it: two traders, a price, a
 * resting order filled by a crossing one, who can read what, a cancel, and
 * what an order costs: the requests it makes and the time from send to
 * result, with the result pushed and with it polled for, turn about.
 *
 * Under the test profile the price is the oracle key's, published again
 * whenever it is about to go stale, and the faucet funds the traders. Under
 * the mainnet profile nothing writes a price: the mark is whatever Pyth gave
 * through the crank's `sync_price`, the smoke refuses one too old to trade on,
 * and the admin funds the traders. On mainnet it runs only with its own
 * `MAINNET_SMOKE=yes`, since it deposits real USDC and trades on the public
 * tape.
 *
 * The Makefile is the way in (`make local-smoke`, `make devnet-smoke`,
 * `make rehearsal-smoke`). It reads the description `setup` wrote. The
 * traders' keys are kept under the keys folder and used again, so a run
 * opens no seat after the first.
 */
// First, before anything loads web3.js, which keeps the `fetch` it finds.
import {
  added,
  perCall,
  requestsSince,
  requestsSoFar,
  type Requests,
} from "./requests";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  ACCESS_ERROR,
  MARKET_STATUS,
  MarketReader,
  ORDER_TYPE,
  OrderKeyManager,
  QUOTE_STATE,
  RESULT_STATUS,
  SIDE,
  TraderClient,
  clockOf,
  decodeExchange,
  decodeMarket,
  decodeView,
  ownFills,
  type MarketParams,
  type PriceFeed,
  type Settled,
} from "../sdk/dist/index.js";
import {
  MAINNET_MARKET,
  MAINNET_QUOTE_TOKEN,
  adminKeyPath,
  depositingAs,
  keyPath,
  readDeployment,
  rollupIsRunBy,
  run,
  sendingAs,
  type DeploymentDescription,
  type Profile,
  type Target,
} from "./deployment";
import { heldKey, keyAt, readingAs } from "./keys";
import { smokeRefusal } from "./launch";
import { onTick, smallestSize } from "./market";
import { deployedAsBuilt } from "./program";
import { send, until } from "./sending";
import { median, spread } from "./stats";
import { heldInRollup, tokenBalance } from "./tokens";
import { errorCode } from "./upkeep";

/** What each profile's smoke trades on, and what each trader is given. */
const SMOKED: Record<
  Profile,
  { market: string; collateral: string; deposit: bigint }
> = {
  test: { market: "NSOL-PERP", collateral: "nUSD", deposit: 100_000_000n },
  mainnet: {
    market: MAINNET_MARKET.symbol,
    collateral: MAINNET_QUOTE_TOKEN.symbol,
    deposit: 10_000_000n,
  },
};
/** A Pyth mark this close to the market's `max_age` would go stale under an order. */
const MARK_AGE_MARGIN_SECONDS = 15n;
const TIMED_CALLS = 30;
const ROUND_TRIPS = 20;
const PRICE_REFRESH_MS = 1_500;
/** A trader holds at most 32 open orders. */
const CANCEL_EVERY = 20;
const FILL_ATTEMPTS = 6;
const FAR_FROM_THE_MARK_TICKS = 20n;
const BPS = 10_000n;

/**
 * `client` learns its results by subscription; `polling` is the same trader
 * with the same order keys, made to read the view for every result.
 */
type Trader = {
  name: string;
  owner: Keypair;
  client: TraderClient;
  polling: TraderClient;
};

/** The market the smoke trades on. */
type Market = {
  id: number;
  params: MarketParams;
};

type PlacedOrder = Settled & { outcome: "placed" };
type Order = { side: number; orderType: number; price: bigint; size: bigint };

function proven(what: string, detail = ""): void {
  console.log(`ok   ${what}${detail ? `: ${detail}` : ""}`);
}

const opposite = (side: number) => (side === SIDE.ask ? SIDE.bid : SIDE.ask);

/** A price `distance` from the mark, on the side of it an order of `side` rests on. */
const awayFromMark = (side: number, mark: bigint, distance: bigint) =>
  side === SIDE.ask ? mark + distance : mark - distance;

async function placed(
  client: TraderClient,
  market: Market,
  what: string,
  order: Order,
): Promise<PlacedOrder> {
  const outcome = await client.placeOrder(market.id, {
    ...order,
    reduceOnly: false,
  });
  if (outcome.outcome !== "placed") {
    throw new Error(`${what}: the outcome is ${outcome.outcome}`);
  }
  return outcome;
}

/**
 * A trader under a kept key. The owner's key seeds the order keys too. On a
 * test network these keys hold test money only; on mainnet they hold the
 * admin's USDC the smoke deposited, which stays in their seats, so they are
 * kept as carefully as the admin's key.
 */
async function opened(on: Target, gate: Keypair, name: string) {
  const { addresses, programId } = on.instructions;
  const owner = keyAt(keyPath(on, `smoke-${name}`));
  const orderKeySeed = owner.secretKey.subarray(0, 32);
  const reader = await readingAs(on.privateUrl, owner);
  const view = addresses.view(owner.publicKey);
  const existing = await reader.getAccountInfo(view);
  const keys = existing
    ? OrderKeyManager.fromView(orderKeySeed, decodeView(existing.data))
    : OrderKeyManager.fresh(orderKeySeed);
  if (!existing) {
    await send(
      await sendingAs(on, gate),
      on.instructions.openTrader(
        gate.publicKey,
        owner.publicKey,
        keys.publicKeys,
      ),
      gate,
      [owner],
    );
    await until(() => reader.getAccountInfo(view), `${name}'s view`, 30_000);
  }
  const sender = await sendingAs(on, owner);
  const clientThat = (push: boolean) =>
    new TraderClient(sender, reader, owner.publicKey, keys, programId, {
      push,
    });
  const client = clientThat(true);
  const polling = clientThat(false);
  await Promise.all([client.ready(), polling.ready()]);
  proven(
    `trader ${name}`,
    `${owner.publicKey.toBase58()}, seat ${(await client.view()).seat}, ${existing ? "seat reused" : "seat opened"}, ${client.pushing ? "results pushed over a websocket" : "NO SUBSCRIPTION: results are read by polling"}`,
  );
  return { name, owner, client, polling };
}

async function unreadable(
  what: string,
  address: PublicKey,
  readers: [string, Connection][],
): Promise<void> {
  for (const [who, connection] of readers) {
    if (await connection.getAccountInfo(address)) {
      throw new Error(`${what} is readable by ${who}`);
    }
  }
  proven(`${what} reads as nothing`, readers.map(([who]) => who).join(", "));
}

/**
 * The test profile's price: the oracle key publishes the one the feed holds
 * again, keeping it fresh, and it resolves to it. The program takes one price
 * a second of the rollup clock. Another holder of the oracle key may publish
 * in between, which serves just as well.
 */
async function publishing(
  on: Target,
  reader: MarketReader,
  marketId: number,
): Promise<() => Promise<bigint>> {
  const oracle = heldKey(keyPath(on, "oracle"));
  const asOracle = await sendingAs(on, oracle);
  return async () => {
    const time = BigInt(await clockOf(on.rollup));
    const current = (feed: PriceFeed) =>
      feed.publishTime >= time || feed.acceptedAt >= time;
    const feed = await reader.priceFeed(marketId);
    if (current(feed)) return feed.price;
    await send(
      asOracle,
      on.instructions.publishPrice(
        oracle.publicKey,
        marketId,
        feed.price,
        time,
      ),
      oracle,
    ).catch(async (error) => {
      if (!current(await reader.priceFeed(marketId))) {
        throw error;
      }
    });
    return feed.price;
  };
}

/**
 * The mainnet profile's price: the mark Pyth gave through `sync_price`, which
 * nothing here writes. Refused when it is about to go stale, when the market
 * is not active, or when the USDC guard is not passing, since each would
 * refuse the orders that follow.
 */
function syncedByTheCrank(
  on: Target,
  reader: MarketReader,
  marketId: number,
): () => Promise<bigint> {
  return async () => {
    const [feed, market, exchange, clock] = await Promise.all([
      reader.priceFeed(marketId),
      reader.connection.getAccountInfo(
        on.instructions.addresses.market(marketId),
      ),
      reader.connection.getAccountInfo(on.instructions.addresses.exchange),
      clockOf(on.rollup),
    ]);
    if (!market || !exchange) {
      throw new Error("The market is not readable. Run setup.");
    }
    const { params } = decodeMarket(market.data);
    const { quote } = decodeExchange(exchange.data);
    const age = BigInt(clock) - feed.publishTime;
    if (
      feed.price === 0n ||
      age > params.maxPriceAge - MARK_AGE_MARGIN_SECONDS
    ) {
      throw new Error(
        `The mark is ${age} s old against a max age of ${params.maxPriceAge} s. Run the crank.`,
      );
    }
    if (params.status !== MARKET_STATUS.active) {
      throw new Error(
        `The market's status is ${params.status}, not active. Resume it with setup.`,
      );
    }
    if (quote.state !== QUOTE_STATE.healthy || BigInt(clock) > quote.okUntil) {
      throw new Error(
        "The USDC guard is not passing, so perps take reduce-only orders. Run the crank.",
      );
    }
    return feed.price;
  };
}

async function smoke(on: Target): Promise<void> {
  const refusal = smokeRefusal(on.mainnet, process.env.MAINNET_SMOKE === "yes");
  if (refusal) throw new Error(refusal);
  if (on.profile === "mainnet") await deployedAsBuilt(on);
  const deployment = readDeployment(on.deploymentPath);
  if (!deployment) {
    throw new Error(
      `No deployment description at ${on.deploymentPath}. Run the setup target of this network first.`,
    );
  }
  const smoked = SMOKED[on.profile];
  const described = deployment.markets.find(
    ({ symbol }) => symbol === smoked.market,
  );
  if (!described) throw new Error(`${smoked.market} is not set up. Run setup.`);
  const collateral = deployment.tokens.find(
    ({ symbol }) => symbol === smoked.collateral,
  );
  if (!collateral) throw new Error(`${smoked.collateral} is not registered.`);
  await rollupIsRunBy(on);
  const { addresses } = on.instructions;
  const gate = heldKey(keyPath(on, "gate"));
  const anonymous = new Connection(on.privateUrl, "confirmed");
  const reader = new MarketReader(anonymous, on.instructions.programId);

  const maker = await opened(on, gate, "a");
  const taker = await opened(on, gate, "b");

  const rollupAhead =
    (await clockOf(on.rollup)) - Math.floor(Date.now() / 1000);
  proven("rollup clock", `${rollupAhead} s ahead of this machine's`);

  const marketAccount = await anonymous.getAccountInfo(
    addresses.market(described.id),
  );
  if (!marketAccount) {
    throw new Error(`${smoked.market} is not readable. Run setup.`);
  }
  const market: Market = {
    id: described.id,
    params: decodeMarket(marketAccount.data).params,
  };
  const markNow =
    on.profile === "mainnet"
      ? syncedByTheCrank(on, reader, market.id)
      : await publishing(on, reader, market.id);
  /** The mark on the market's tick, which every order here is priced from. */
  const publish = async () => onTick(await markNow(), market.params.tick);
  const mark = await publish();
  proven(
    on.profile === "mainnet"
      ? "mark synced from Pyth, fresh, market active and the USDC guard passing"
      : "price published by the oracle key, on the rollup clock",
    `${mark}`,
  );

  try {
    await smokedOn(on, market, collateral, [maker, taker], reader, {
      publish,
      mark,
    });
  } finally {
    await ended(on, market, [maker, taker], publish);
  }
}

/**
 * Whatever way the smoke ends, neither trader keeps an order on the book,
 * and under the mainnet profile neither keeps a position: on a live market
 * the smoke's orders can fill against other traders, so the two positions
 * need not net to zero. What cannot be closed is logged, not thrown, so the
 * error that ended the smoke, if any, is the one reported.
 */
async function ended(
  on: Target,
  market: Market,
  traders: Trader[],
  publish: () => Promise<bigint>,
): Promise<void> {
  for (const { name, client } of traders) {
    await client
      .cancelAll(market.id)
      .catch((error: Error) =>
        console.log(
          `trader ${name}'s orders were not cancelled: ${error.message}`,
        ),
      );
  }
  if (on.profile !== "mainnet") return;
  for (const trader of traders) {
    await flattened(market, trader, publish).catch((error: Error) =>
      console.log(
        `trader ${trader.name}'s position was not closed: ${error.message}`,
      ),
    );
  }
}

/**
 * Closes `trader`'s position with a reduce-only market order that reaches
 * half the price band past the mark, and says what is left: a book with
 * nothing to take within that reach leaves part of it.
 */
async function flattened(
  market: Market,
  trader: Trader,
  publish: () => Promise<bigint>,
): Promise<void> {
  const positionOf = async () => {
    await trader.client.syncView(market.id);
    return (await trader.client.view()).snapshot.seat.perp[market.id].base;
  };
  const base = await positionOf();
  if (base === 0n) return;
  const side = base > 0n ? SIDE.ask : SIDE.bid;
  const mark = await publish();
  await trader.client.placeOrder(market.id, {
    side,
    orderType: ORDER_TYPE.market,
    price: awayFromMark(opposite(side), mark, halfBandReach(market, mark)),
    size: base > 0n ? base : -base,
    reduceOnly: true,
  });
  const left = await positionOf();
  if (left !== 0n) {
    console.log(
      `trader ${trader.name} still holds ${left} lots: close them by hand`,
    );
    return;
  }
  proven(`trader ${trader.name}'s position closed`, `${base} lots`);
}

/** The smoke's deposit, fill, privacy checks and timed orders, from a first mark. */
async function smokedOn(
  on: Target,
  market: Market,
  collateral: DeploymentDescription["tokens"][number],
  [maker, taker]: Trader[],
  reader: MarketReader,
  first: { publish: () => Promise<bigint>; mark: bigint },
): Promise<void> {
  const { publish } = first;
  let { mark } = first;
  const smoked = SMOKED[on.profile];
  const { addresses } = on.instructions;
  const anonymous = new Connection(on.privateUrl, "confirmed");
  const stranger = await readingAs(on.privateUrl, Keypair.generate());
  await deposited(on, collateral, market.id, [maker, taker], smoked.deposit);
  await undisturbed(() => filled(market, maker, taker, reader, publish));

  const outsiders: [string, Connection][] = [
    ["anonymous", anonymous],
    ["a signed-in stranger", stranger],
  ];
  await unreadable("the ledger", addresses.ledger, outsiders);
  await unreadable("the book", addresses.book(market.id), outsiders);
  await unreadable("trader b's view", addresses.view(taker.owner.publicKey), [
    ...outsiders,
    ["trader a", maker.client.reader],
  ]);

  let publishedAt = 0;
  const cleared = async (number: number) => {
    if (number % CANCEL_EVERY === 0) await maker.client.cancelAll(market.id);
    if (Date.now() - publishedAt < PRICE_REFRESH_MS) return;
    mark = await publish();
    publishedAt = Date.now();
  };
  const roundTrip = await roundTripTo(maker.client.reader);
  await timed("post-only orders that rest", maker, cleared, (client) =>
    restingBid(market, mark, client),
  );
  await timed(
    "market orders that cross",
    taker,
    async (number) => {
      await cleared(number);
      await placed(maker.client, market, "an order for a timed one to cross", {
        side: sideOf(number),
        orderType: ORDER_TYPE.limit,
        price: mark,
        size: smallestSize(market.params, mark),
      });
    },
    (client, number) => crossing(market, mark, client, sideOf(number)),
  );
  await maker.client.cancelAll(market.id);
  console.log(
    `plain round trip to the endpoint: median ${roundTrip.toFixed(0)} ms over ${ROUND_TRIPS} getSlot calls.`,
  );
  console.log(
    "A getLatestBlockhash among an order's requests is a background refresh that fell in its time: one every 15 s for each of the four clients here.",
  );
  console.log(
    "All of it is this machine's connection to the endpoint, not the rollup's own speed.",
  );
}

/**
 * The side the maker rests on for timed call `number`. The two ways of
 * learning the result take turns, so a side lasts two calls; then it flips,
 * and the taker's position comes back to where it began.
 */
const sideOf = (number: number) =>
  Math.floor(number / 2) % 2 ? SIDE.bid : SIDE.ask;

async function roundTripTo(connection: Connection): Promise<number> {
  const took: number[] = [];
  for (let nth = 0; nth < ROUND_TRIPS; nth += 1) {
    const began = performance.now();
    await connection.getSlot();
    took.push(performance.now() - began);
  }
  return median(took.sort((a, b) => a - b));
}

/**
 * Who funds the traders: the faucet under the test profile, the admin under
 * the mainnet profile, from a balance in the rollup made to hold enough.
 */
async function funder(
  on: Target,
  mint: PublicKey,
  visibility: DeploymentDescription["tokens"][number]["custodyVisibility"],
  amount: bigint,
): Promise<{ key: Keypair; name: string; deposits: Connection }> {
  if (on.profile !== "mainnet") {
    const faucet = heldKey(keyPath(on, "faucet"));
    return {
      key: faucet,
      name: "the faucet",
      deposits: await depositingAs(on, faucet),
    };
  }
  const admin = heldKey(adminKeyPath(on));
  const deposits = await depositingAs(on, admin);
  await heldInRollup(
    on.solana,
    deposits,
    admin,
    mint,
    amount,
    on.validator,
    visibility,
  );
  return { key: admin, name: "the admin", deposits };
}

/** A trader's collateral, from its view synced on `marketId`. */
async function collateralOf(
  client: TraderClient,
  marketId: number,
): Promise<bigint> {
  await client.syncView(marketId);
  return (await client.view()).snapshot.seat.collateral;
}

/** What tops `held` up to `target`, nothing when it holds that already. */
const toppedUpBy = (target: bigint, held: bigint) =>
  held >= target ? 0n : target - (held > 0n ? held : 0n);

/**
 * Deposits `target` into each trader's seat. On mainnet, where the deposit
 * is the admin's real USDC and no step takes it back out, each seat is only
 * topped up to `target`, so a run after the first moves nothing more.
 */
async function deposited(
  on: Target,
  token: DeploymentDescription["tokens"][number],
  marketId: number,
  traders: Trader[],
  target: bigint,
): Promise<void> {
  const mint = new PublicKey(token.mint);
  const custodyNonce = BigInt(token.custodyNonce);
  const wanted = await Promise.all(
    traders.map(async ({ client }) =>
      on.mainnet
        ? toppedUpBy(target, await collateralOf(client, marketId))
        : target,
    ),
  );
  const total = wanted.reduce((sum, each) => sum + each, 0n);
  if (total === 0n) {
    proven(
      "both traders already hold the smoke's deposit",
      `${target} atoms each`,
    );
    return;
  }
  const from = await funder(on, mint, token.custodyVisibility, total);
  for (const [nth, { name, owner, client }] of traders.entries()) {
    const amount = wanted[nth];
    if (amount === 0n) {
      proven(`trader ${name} already holds the smoke's deposit`);
      continue;
    }
    const deposit = () =>
      send(
        from.deposits,
        on.instructions.deposit(
          from.key.publicKey,
          getAssociatedTokenAddressSync(mint, from.key.publicKey, true),
          { mint, custodyNonce },
          owner.publicKey,
          { collateral: true },
          amount,
        ),
        from.key,
      );
    await deposit();
    await client.syncView(marketId);
    proven(
      `deposit to trader ${name} from ${from.name}`,
      `collateral ${(await client.view()).snapshot.seat.collateral} atoms of ${token.symbol}, custody ${token.custodyVisibility}`,
    );
  }
}

const ACCESS_REFUSALS: ReadonlySet<number> = new Set(
  Object.values(ACCESS_ERROR),
);

/**
 * Other traders may quote on the same market and take the resting order
 * before the smoke's own taker does, so the fill is tried a few times. An
 * access list refusal is no race and is reported at once.
 */
async function undisturbed(fill: () => Promise<void>): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fill();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = errorCode(message);
      if (code !== null && ACCESS_REFUSALS.has(code)) {
        throw new Error(
          `the access lists refused the smoke's order (${code}): list both traders, or switch the market's lists off. ${message}`,
        );
      }
      if (attempt === FILL_ATTEMPTS) throw error;
      console.log(
        `again, another trader got in between: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}

/**
 * A resting order from the maker, filled by a market order from the taker,
 * and then a resting order cancelled. The maker sells unless it is already
 * short, so runs take turns and neither position grows.
 */
async function filled(
  market: Market,
  maker: Trader,
  taker: Trader,
  reader: MarketReader,
  publish: () => Promise<bigint>,
): Promise<void> {
  const positionOf = async (trader: Trader) => {
    await trader.client.syncView(market.id);
    return (await trader.client.view()).snapshot.seat.perp[market.id].base;
  };
  const position = await positionOf(maker);
  const makerSide = position < 0n ? SIDE.bid : SIDE.ask;
  const mark = await publish();
  const size = smallestSize(market.params, mark);
  const rested = await placed(maker.client, market, "the resting order", {
    side: makerSide,
    orderType: ORDER_TYPE.limit,
    price: mark,
    size,
  });
  if (rested.result.status !== RESULT_STATUS.rested) {
    throw new Error(`the resting order has status ${rested.result.status}`);
  }
  const crossed = await placed(taker.client, market, "the crossing order", {
    side: opposite(makerSide),
    orderType: ORDER_TYPE.market,
    price: awayFromMark(makerSide, mark, market.params.tick),
    size,
  });
  if (crossed.result.filled !== size) {
    throw new Error(
      `the crossing order filled ${crossed.result.filled} of ${size}, status ${crossed.result.status}, code ${crossed.result.code}`,
    );
  }
  proven("taker's private view shows the fill", `${size} lots at ${mark}`);

  const after = await positionOf(maker);
  const moved = makerSide === SIDE.ask ? position - after : after - position;
  if (moved !== size) {
    throw new Error(`the maker's position moved by ${moved}, not ${size}`);
  }
  proven(
    "maker's private view shows the fill",
    `position ${position} to ${after} lots`,
  );
  await shownOnTheTape(reader, market.id, rested, crossed);

  const far = awayFromMark(
    makerSide,
    mark,
    FAR_FROM_THE_MARK_TICKS * market.params.tick,
  );
  await publish();
  const resting = await placed(maker.client, market, "the order to cancel", {
    side: makerSide,
    orderType: ORDER_TYPE.postOnly,
    price: far,
    size: smallestSize(market.params, far),
  });
  const cancel = await maker.client.cancelOrder(
    market.id,
    resting.result.orderSeq,
  );
  if (cancel.cancelled === 0n) throw new Error("the cancel cancelled nothing");
  proven("resting order cancelled");
}

async function shownOnTheTape(
  reader: MarketReader,
  marketId: number,
  rested: PlacedOrder,
  crossed: PlacedOrder,
): Promise<void> {
  const { fills } = await reader.tape(marketId);
  const [own] = ownFills(fills, [crossed.secret]);
  const makers = ownFills(fills, [rested.secret]);
  if (
    !own ||
    own.role !== "taker" ||
    makers[0]?.fill.fillSeq !== own.fill.fillSeq
  ) {
    throw new Error("the public tape does not show the fill to both traders");
  }
  proven(
    "public tape shows the fill, and each trader's receipt matches it",
    `fill ${own.fill.fillSeq}, ${own.fill.size} lots at ${own.fill.price}`,
  );
}

/** A post-only bid below the mark that must rest. */
async function restingBid(
  market: Market,
  mark: bigint,
  client: TraderClient,
): Promise<PlacedOrder> {
  const price = mark - FAR_FROM_THE_MARK_TICKS * market.params.tick;
  const order = await placed(client, market, "a timed order", {
    side: SIDE.bid,
    orderType: ORDER_TYPE.postOnly,
    price,
    size: smallestSize(market.params, price),
  });
  if (order.result.status !== RESULT_STATUS.rested) {
    throw new Error(`a timed order has status ${order.result.status}`);
  }
  return order;
}

/**
 * A market order against the side the maker rested on. Another trader may
 * have taken that order first, so this one reaches half the price band past
 * the mark and fills whoever rests there; `timed` counts the ones that fill.
 */
function crossing(
  market: Market,
  mark: bigint,
  client: TraderClient,
  restingSide: number,
): Promise<PlacedOrder> {
  return placed(client, market, "a timed order", {
    side: opposite(restingSide),
    orderType: ORDER_TYPE.market,
    price: awayFromMark(restingSide, mark, halfBandReach(market, mark)),
    size: smallestSize(market.params, mark),
  });
}

/** Half the market's price band from `mark`, on its tick and at least one tick. */
function halfBandReach(market: Market, mark: bigint): bigint {
  const { tick, bandBps } = market.params;
  const band = (mark * BigInt(bandBps)) / BPS;
  const halfBand = (band / 2n / tick) * tick;
  return halfBand > tick ? halfBand : tick;
}

type Measured = {
  requests: Requests;
  sendToResult: number[];
  callToResult: number[];
  filled: number;
};

/**
 * Times `TIMED_CALLS` orders with the result pushed and as many with it
 * polled for, one after another and turn about, so both meet the same
 * network. The requests counted are all this process made while the order
 * was out, the background refreshes among them; `prepare` is not counted.
 */
async function timed(
  what: string,
  trader: Trader,
  prepare: (number: number) => Promise<void>,
  order: (client: TraderClient, number: number) => Promise<PlacedOrder>,
): Promise<void> {
  const measuring = (way: string, client: TraderClient) => {
    const measured: Measured = {
      requests: new Map(),
      sendToResult: [],
      callToResult: [],
      filled: 0,
    };
    return { way, client, measured };
  };
  const ways = [
    measuring("result pushed", trader.client),
    measuring("result polled for", trader.polling),
  ];
  for (let number = 0; number < TIMED_CALLS * ways.length; number += 1) {
    const { client, measured } = ways[number % ways.length];
    await prepare(number);
    const earlier = requestsSoFar();
    const calledAt = performance.now();
    const { sentAt, resultAt, result } = await order(client, number);
    added(measured.requests, requestsSince(earlier));
    measured.sendToResult.push(resultAt - sentAt);
    measured.callToResult.push(resultAt - calledAt);
    if (result.filled > 0n) measured.filled += 1;
  }
  for (const { way, client, measured } of ways) {
    const subscriptionDown = client === trader.client && !client.pushing;
    console.log(
      `${TIMED_CALLS} ${what}, ${way}${subscriptionDown ? " (THE SUBSCRIPTION IS DOWN)" : ""}, ${measured.filled} filled:`,
    );
    console.log(
      `  requests          ${perCall(measured.requests, TIMED_CALLS)}`,
    );
    console.log(`  send to result    ${spread(measured.sendToResult)}`);
    console.log(`  call to result    ${spread(measured.callToResult)}`);
  }
}

run(smoke);

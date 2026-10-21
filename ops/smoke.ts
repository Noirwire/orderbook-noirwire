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
 * and the admin funds the traders. On a rehearsal it raises the custody cap
 * when a deposit meets it. On mainnet it never does, since caps go up only by
 * the operator's decision, and it runs only with its own `MAINNET_SMOKE=yes`,
 * since it deposits real USDC and trades on the public tape.
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
import { smokeRaisesCap, smokeRefusal } from "./launch";
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
/** `CustodyCapReached`: the deposit would take custody above its cap. */
const CUSTODY_CAP_REACHED = 6150;
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

/** A Pyth mark is any atom; an order's price is a whole number of ticks. */
const onTick = (price: bigint, tick: bigint) => (price / tick) * tick;

/** A price `distance` from the mark, on the side of it an order of `side` rests on. */
const awayFromMark = (side: number, mark: bigint, distance: bigint) =>
  side === SIDE.ask ? mark + distance : mark - distance;

const smallestSize = (params: MarketParams, price: bigint) => {
  const forNotional = (params.minNotional + price - 1n) / price;
  return forNotional > params.minSize ? forNotional : params.minSize;
};

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
 * A trader under a kept key. The owner's key seeds the order keys too: these
 * are throwaway keys that hold test money only.
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
  const stranger = await readingAs(on.privateUrl, Keypair.generate());
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
  let mark = await publish();
  proven(
    on.profile === "mainnet"
      ? "mark synced from Pyth, fresh, market active and the USDC guard passing"
      : "price published by the oracle key, on the rollup clock",
    `${mark}`,
  );

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
 * Raises the custody cap of the token at `index` to what its custody account
 * already holds plus `amount`, for a deposit the cap refused on a rehearsal.
 * The cap counts the whole custody account, insurance included.
 */
async function capRaised(
  on: Target,
  admin: Keypair,
  deposits: Connection,
  index: number,
  amount: bigint,
): Promise<void> {
  const account = await on.rollup.getAccountInfo(
    on.instructions.addresses.exchange,
  );
  if (!account) throw new Error("The exchange is not in the rollup.");
  const { custodyCap: cap, custody } = decodeExchange(account.data).tokens[
    index
  ];
  const held = await tokenBalance(on.rollup, custody);
  const raised = (held > cap ? held : cap) + amount;
  await send(
    deposits,
    on.instructions.setCustodyCap(admin.publicKey, index, raised),
    admin,
  );
  proven(
    "custody cap raised for the smoke's deposit",
    `${cap} to ${raised} atoms, custody holding ${held}`,
  );
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

async function deposited(
  on: Target,
  token: DeploymentDescription["tokens"][number],
  marketId: number,
  traders: Trader[],
  amount: bigint,
): Promise<void> {
  const mint = new PublicKey(token.mint);
  const custodyNonce = BigInt(token.custodyNonce);
  const from = await funder(
    on,
    mint,
    token.custodyVisibility,
    amount * BigInt(traders.length),
  );
  for (const { name, owner, client } of traders) {
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
    await deposit().catch(async (error: Error) => {
      if (
        on.profile !== "mainnet" ||
        errorCode(error.message) !== CUSTODY_CAP_REACHED
      ) {
        throw error;
      }
      if (!smokeRaisesCap(on)) {
        throw new Error(
          `The custody cap refused the deposit to trader ${name}. On mainnet the smoke never raises a cap: ` +
            'it goes up only by the operator\'s decision (SECURITY.md, "Custody caps are small and raised in steps").',
        );
      }
      const refusedUnder = (await from.deposits.getLatestBlockhash()).blockhash;
      await capRaised(on, from.key, from.deposits, token.index, amount);
      await until(
        async () =>
          (await from.deposits.getLatestBlockhash()).blockhash !== refusedUnder,
        "a blockhash the refused deposit was not signed with",
      );
      await deposit();
    });
    await client.syncView(marketId);
    proven(
      `deposit to trader ${name} from ${from.name}`,
      `collateral ${(await client.view()).snapshot.seat.collateral} atoms of ${token.symbol}, custody ${token.custodyVisibility}`,
    );
  }
}

/**
 * Other traders may quote on the same market and take the resting order
 * before the smoke's own taker does, so the fill is tried a few times.
 */
async function undisturbed(fill: () => Promise<void>): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fill();
    } catch (error) {
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
  const { tick, bandBps } = market.params;
  const band = (mark * BigInt(bandBps)) / BPS;
  const halfBand = (band / 2n / tick) * tick;
  const reach = halfBand > tick ? halfBand : tick;
  return placed(client, market, "a timed order", {
    side: opposite(restingSide),
    orderType: ORDER_TYPE.market,
    price: awayFromMark(restingSide, mark, reach),
    size: smallestSize(market.params, mark),
  });
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

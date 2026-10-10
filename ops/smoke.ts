/**
 * Proves a deployment the way a trader meets it: two traders, a price, a
 * resting order filled by a crossing one, who can read what, a cancel, and
 * what an order costs: the requests it makes and the time from send to
 * result, with the result pushed and with it polled for, turn about.
 *
 * The Makefile is the way in (`make local-smoke`, `make devnet-smoke`). It
 * reads the description `setup` wrote. The traders' keys are kept under the
 * keys folder and used again, so a run opens no seat after the first.
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
  MarketReader,
  ORDER_TYPE,
  OrderKeyManager,
  RESULT_STATUS,
  SIDE,
  TraderClient,
  clockOf,
  decodeMarket,
  decodeView,
  ownFills,
  type MarketParams,
  type PlaceOrderOptions,
  type Settled,
} from "../sdk/dist/index.js";
import {
  depositingAs,
  keyPath,
  readDeployment,
  rollupIsRunBy,
  run,
  sendingAs,
  type DeploymentDescription,
  type Target,
} from "./deployment";
import { heldKey, keyAt, readingAs } from "./keys";
import { send, until } from "./sending";
import { median, spread } from "./stats";

const MARKET = "NSOL-PERP";
const COLLATERAL = "nUSD";
const DEPOSIT = 100_000_000n;
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

/** The market the smoke trades on, with what every order on it needs. */
type Market = {
  id: number;
  params: MarketParams;
  /** The margin check of an order reads every other perp market. */
  options: PlaceOrderOptions;
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
  const outcome = await client.placeOrder(
    market.id,
    { ...order, reduceOnly: false },
    market.options,
  );
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

async function smoke(on: Target): Promise<void> {
  const deployment = readDeployment(on.deploymentPath);
  if (!deployment) {
    throw new Error(
      `No deployment description at ${on.deploymentPath}. Run the setup target of this network first.`,
    );
  }
  const described = deployment.markets.find(({ symbol }) => symbol === MARKET);
  if (!described) throw new Error(`${MARKET} is not set up. Run setup.`);
  const collateral = deployment.tokens.find(
    ({ symbol }) => symbol === COLLATERAL,
  );
  if (!collateral) throw new Error(`${COLLATERAL} is not registered.`);
  await rollupIsRunBy(on);
  const { addresses } = on.instructions;
  const gate = heldKey(keyPath(on, "gate"));
  const oracle = heldKey(keyPath(on, "oracle"));
  const anonymous = new Connection(on.privateUrl, "confirmed");
  const stranger = await readingAs(on.privateUrl, Keypair.generate());
  const reader = new MarketReader(anonymous, on.instructions.programId);

  const maker = await opened(on, gate, "a");
  const taker = await opened(on, gate, "b");

  const rollupAhead =
    (await clockOf(on.rollup)) - Math.floor(Date.now() / 1000);
  proven("rollup clock", `${rollupAhead} s ahead of this machine's`);

  const asOracle = await sendingAs(on, oracle);
  /**
   * Keeps the price fresh by publishing the one the feed holds again, and
   * resolves to it. The program takes one price a second of the rollup clock.
   * Another holder of the oracle key may publish in between, which serves
   * just as well.
   */
  const publish = async () => {
    const time = BigInt(await clockOf(on.rollup));
    const { price, publishTime } = await reader.priceFeed(described.id);
    if (publishTime >= time) return price;
    await send(
      asOracle,
      on.instructions.publishPrice(oracle.publicKey, described.id, price, time),
      oracle,
    ).catch(async (error) => {
      if ((await reader.priceFeed(described.id)).publishTime < time) {
        throw error;
      }
    });
    return price;
  };
  let mark = await publish();
  proven("price published by the oracle key, on the rollup clock", `${mark}`);

  const marketAccount = await anonymous.getAccountInfo(
    addresses.market(described.id),
  );
  if (!marketAccount) throw new Error(`${MARKET} is not readable. Run setup.`);
  const market: Market = {
    id: described.id,
    params: decodeMarket(marketAccount.data).params,
    options: {
      riskMarkets: deployment.markets
        .filter(({ kind, id }) => kind === "perp" && id !== described.id)
        .map(({ id }) => id),
    },
  };
  await deposited(on, collateral, market.id, [maker, taker]);
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

async function deposited(
  on: Target,
  token: DeploymentDescription["tokens"][number],
  marketId: number,
  traders: Trader[],
): Promise<void> {
  const faucet = heldKey(keyPath(on, "faucet"));
  const mint = new PublicKey(token.mint);
  const deposits = await depositingAs(on, faucet);
  for (const { name, owner, client } of traders) {
    await send(
      deposits,
      on.instructions.deposit(
        faucet.publicKey,
        getAssociatedTokenAddressSync(mint, faucet.publicKey, true),
        mint,
        owner.publicKey,
        { collateral: true },
        DEPOSIT,
      ),
      faucet,
    );
    await client.syncView(marketId);
    proven(
      `deposit to trader ${name} from the faucet`,
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

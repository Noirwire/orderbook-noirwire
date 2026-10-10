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
import {
  added,
  perCall,
  requestsSince,
  requestsSoFar,
  type Requests,
} from "./requests";
import { join } from "path";
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
  type Placed,
  type Settled,
} from "../sdk/dist/index.js";
import {
  depositingAs,
  heldKey,
  keyAt,
  readDeployment,
  readingAs,
  rollupIsRunBy,
  send,
  sendingAs,
  target,
  until,
  type DeploymentDescription,
  type Target,
} from "./network";

const MARKET = "NSOL-PERP";
const COLLATERAL = "nUSD";
const DEPOSIT = 100_000_000n;
const TIMED_CALLS = 30;
const ROUND_TRIPS = 20;
const PRICE_REFRESH_MS = 1_500;
/** A trader holds at most 32 open orders. */
const CANCEL_EVERY = 20;

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

function proven(what: string, detail = ""): void {
  console.log(`ok   ${what}${detail ? `: ${detail}` : ""}`);
}

/**
 * A trader under a kept key. The owner's key seeds the order keys too: these
 * are throwaway keys that hold test money only.
 */
async function opened(on: Target, gate: Keypair, name: string) {
  const { addresses } = on.instructions;
  const owner = keyAt(join(on.keys, `${on.network}-smoke-${name}.json`));
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
  const { programId } = on.instructions;
  const client = new TraderClient(
    sender,
    reader,
    owner.publicKey,
    keys,
    programId,
  );
  const polling = new TraderClient(
    sender,
    reader,
    owner.publicKey,
    keys,
    programId,
    { push: false },
  );
  await Promise.all([client.ready(), polling.ready()]);
  proven(
    `trader ${name}`,
    `${owner.publicKey.toBase58()}, seat ${(await client.view()).seat}, ${existing ? "seat reused" : "seat opened"}, ${client.pushing ? "results pushed over a websocket" : "NO SUBSCRIPTION: results are read by polling"}`,
  );
  return { name, owner, client, polling };
}

function settled(
  placed: Placed,
  what: string,
): Settled & { outcome: "placed" } {
  if (placed.outcome !== "placed") {
    throw new Error(`${what}: the outcome is ${placed.outcome}`);
  }
  return placed;
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

function median(sorted: number[]): number {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function smoke(on: Target): Promise<void> {
  const deployment = readDeployment(on.deploymentPath);
  if (!deployment) throw new Error("No deployment description. Run setup.");
  const market = deployment.markets.find(({ symbol }) => symbol === MARKET);
  if (!market) throw new Error(`${MARKET} is not set up.`);
  await rollupIsRunBy(on);
  const { addresses } = on.instructions;
  const gate = heldKey(join(on.keys, `${on.network}-gate.json`));
  const oracle = heldKey(join(on.keys, `${on.network}-oracle.json`));
  const anonymous = new Connection(on.privateUrl, "confirmed");
  const stranger = await readingAs(on.privateUrl, Keypair.generate());
  const reader = new MarketReader(anonymous, on.instructions.programId);

  const maker = await opened(on, gate, "a");
  const taker = await opened(on, gate, "b");

  const rollupAhead =
    (await clockOf(on.rollup)) - Math.floor(Date.now() / 1000);
  // The margin check of an order reads every other perp market.
  const options: PlaceOrderOptions = {
    riskMarkets: deployment.markets
      .filter(({ kind, id }) => kind === "perp" && id !== market.id)
      .map(({ id }) => id),
  };
  proven("rollup clock", `${rollupAhead} s ahead of this machine's`);

  const asOracle = await sendingAs(on, oracle);
  // Keeps the price fresh by publishing the one the feed holds again, and
  // resolves to it. The program takes one price a second of the rollup clock.
  // Another holder of the oracle key may publish in between, which serves
  // just as well.
  const publish = async () => {
    const time = BigInt(await clockOf(on.rollup));
    const { price, publishTime } = await reader.priceFeed(market.id);
    if (publishTime >= time) return price;
    await send(
      asOracle,
      on.instructions.publishPrice(oracle.publicKey, market.id, price, time),
      oracle,
    ).catch(async (error) => {
      if ((await reader.priceFeed(market.id)).publishTime < time) throw error;
    });
    return price;
  };
  let mark = await publish();
  proven("price published by the oracle key, on the rollup clock", `${mark}`);

  const params = decodeMarket(
    (await anonymous.getAccountInfo(addresses.market(market.id)))!.data,
  ).params;
  const collateral = deployment.tokens.find(
    ({ symbol }) => symbol === COLLATERAL,
  );
  if (!collateral) throw new Error(`${COLLATERAL} is not registered.`);
  await deposited(on, collateral, market.id, [maker, taker]);
  await undisturbed(() =>
    filled(market.id, params, maker, taker, reader, publish, options),
  );

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
    restingBid(market.id, params, mark, client, options),
  );
  await timed(
    "market orders that cross",
    taker,
    async (number) => {
      await cleared(number);
      await rested(market.id, params, mark, maker, sideOf(number), options);
    },
    (client, number) =>
      crossing(market.id, params, mark, client, sideOf(number), options),
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
  const faucet = heldKey(join(on.keys, `${on.network}-faucet.json`));
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

const FILL_ATTEMPTS = 6;

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

const smallestSize = (params: MarketParams, price: bigint) => {
  const forNotional = (params.minNotional + price - 1n) / price;
  return forNotional > params.minSize ? forNotional : params.minSize;
};

/**
 * A resting order from the maker, filled by a market order from the taker.
 * The maker sells unless it is already short, so runs take turns and neither
 * position grows.
 */
async function filled(
  marketId: number,
  params: MarketParams,
  maker: Trader,
  taker: Trader,
  reader: MarketReader,
  publish: () => Promise<bigint>,
  options: PlaceOrderOptions,
): Promise<void> {
  const positionOf = async (trader: Trader) => {
    await trader.client.syncView(marketId);
    return (await trader.client.view()).snapshot.seat.perp[marketId].base;
  };
  const position = await positionOf(maker);
  const makerSide = position < 0n ? SIDE.bid : SIDE.ask;
  const mark = await publish();
  const size = smallestSize(params, mark);
  const worst =
    makerSide === SIDE.ask ? mark + params.tick : mark - params.tick;
  const rested = settled(
    await maker.client.placeOrder(
      marketId,
      {
        side: makerSide,
        orderType: ORDER_TYPE.limit,
        price: mark,
        size,
        reduceOnly: false,
      },
      options,
    ),
    "the resting order",
  );
  if (rested.result.status !== RESULT_STATUS.rested) {
    throw new Error(`the resting order has status ${rested.result.status}`);
  }
  const crossed = settled(
    await taker.client.placeOrder(
      marketId,
      {
        side: makerSide === SIDE.ask ? SIDE.bid : SIDE.ask,
        orderType: ORDER_TYPE.market,
        price: worst,
        size,
        reduceOnly: false,
      },
      options,
    ),
    "the crossing order",
  );
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

  const far =
    makerSide === SIDE.ask
      ? mark + 20n * params.tick
      : mark - 20n * params.tick;
  await publish();
  const resting = settled(
    await maker.client.placeOrder(
      marketId,
      {
        side: makerSide,
        orderType: ORDER_TYPE.postOnly,
        price: far,
        size: smallestSize(params, far),
        reduceOnly: false,
      },
      options,
    ),
    "the order to cancel",
  );
  const cancel = await maker.client.cancelOrder(
    marketId,
    resting.result.orderSeq,
  );
  if (cancel.cancelled === 0n) throw new Error("the cancel cancelled nothing");
  proven("resting order cancelled");
}

type PlacedOrder = Settled & { outcome: "placed" };

/** A post-only bid below the mark that must rest. */
async function restingBid(
  marketId: number,
  params: MarketParams,
  mark: bigint,
  client: TraderClient,
  options: PlaceOrderOptions,
): Promise<PlacedOrder> {
  const price = mark - 20n * params.tick;
  const placed = settled(
    await client.placeOrder(
      marketId,
      {
        side: SIDE.bid,
        orderType: ORDER_TYPE.postOnly,
        price,
        size: smallestSize(params, price),
        reduceOnly: false,
      },
      options,
    ),
    "a timed order",
  );
  if (placed.result.status !== RESULT_STATUS.rested) {
    throw new Error(`a timed order has status ${placed.result.status}`);
  }
  return placed;
}

/** The maker's limit order at the mark, for a timed market order to cross. */
async function rested(
  marketId: number,
  params: MarketParams,
  mark: bigint,
  maker: Trader,
  side: number,
  options: PlaceOrderOptions,
): Promise<void> {
  settled(
    await maker.client.placeOrder(
      marketId,
      {
        side,
        orderType: ORDER_TYPE.limit,
        price: mark,
        size: smallestSize(params, mark),
        reduceOnly: false,
      },
      options,
    ),
    "an order for a timed one to cross",
  );
}

/**
 * A market order against the side the maker rested on. Another trader may
 * have taken that order first, so this one reaches half the price band past
 * the mark and fills whoever rests there; `timed` counts the ones that fill.
 */
async function crossing(
  marketId: number,
  params: MarketParams,
  mark: bigint,
  client: TraderClient,
  restingSide: number,
  options: PlaceOrderOptions,
): Promise<PlacedOrder> {
  const band = (mark * BigInt(params.bandBps)) / 10_000n;
  const halfBand = (band / 2n / params.tick) * params.tick;
  const reach = halfBand > params.tick ? halfBand : params.tick;
  return settled(
    await client.placeOrder(
      marketId,
      {
        side: restingSide === SIDE.ask ? SIDE.bid : SIDE.ask,
        orderType: ORDER_TYPE.market,
        price: restingSide === SIDE.ask ? mark + reach : mark - reach,
        size: smallestSize(params, mark),
        reduceOnly: false,
      },
      options,
    ),
    "a timed order",
  );
}

function spread(took: number[]): string {
  const sorted = [...took].sort((a, b) => a - b);
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
  return `median ${median(sorted).toFixed(0)} ms, p95 ${p95.toFixed(0)} ms, worst ${sorted[sorted.length - 1].toFixed(0)} ms`;
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
  const ways: [string, TraderClient, Measured][] = [
    ["result pushed", trader.client],
    ["result polled for", trader.polling],
  ].map(([way, client]) => [
    way as string,
    client as TraderClient,
    { requests: new Map(), sendToResult: [], callToResult: [], filled: 0 },
  ]);
  for (let number = 0; number < TIMED_CALLS * ways.length; number += 1) {
    const [, client, measured] = ways[number % ways.length];
    await prepare(number);
    const earlier = requestsSoFar();
    const calledAt = performance.now();
    const { sentAt, resultAt, result } = await order(client, number);
    added(measured.requests, requestsSince(earlier));
    measured.sendToResult.push(resultAt - sentAt);
    measured.callToResult.push(resultAt - calledAt);
    if (result.filled > 0n) measured.filled += 1;
  }
  for (const [way, client, measured] of ways) {
    const pushing = client === trader.client && !client.pushing;
    console.log(
      `${TIMED_CALLS} ${what}, ${way}${pushing ? " (THE SUBSCRIPTION IS DOWN)" : ""}, ${measured.filled} filled:`,
    );
    console.log(
      `  requests          ${perCall(measured.requests, TIMED_CALLS)}`,
    );
    console.log(`  send to result    ${spread(measured.sendToResult)}`);
    console.log(`  call to result    ${spread(measured.callToResult)}`);
  }
}

target()
  .then(smoke)
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });

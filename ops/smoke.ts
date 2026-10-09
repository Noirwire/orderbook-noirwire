/**
 * Proves a deployment the way a trader meets it: two traders, a price, a
 * resting order filled by a crossing one, who can read what, a cancel, and
 * the time from send to result for twenty orders.
 *
 * The Makefile is the way in (`make local-smoke`, `make devnet-smoke`). It
 * reads the description `setup` wrote. The traders' keys are kept under the
 * keys folder and used again, so a run opens no seat after the first. Where
 * the deployment has no tokens nobody can deposit: the orders are then
 * refused for want of collateral, which still times the round trip, and the
 * run ends with an error naming what it could not check.
 */
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
  type Timing,
  type Settled,
} from "../sdk/dist/index.js";
import {
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
const TIMED_CALLS = 20;
const PRICE_REFRESH_EVERY = 5;

type Trader = { name: string; owner: Keypair; client: TraderClient };

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
  const client = new TraderClient(
    await sendingAs(on, owner),
    reader,
    owner.publicKey,
    keys,
    on.instructions.programId,
  );
  proven(
    `trader ${name}`,
    `${owner.publicKey.toBase58()}, seat ${(await client.view()).seat}, ${existing ? "seat reused" : "seat opened"}`,
  );
  return { name, owner, client };
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
    now: () => Math.floor(Date.now() / 1000) + rollupAhead,
    riskMarkets: deployment.markets
      .filter(({ kind, id }) => kind === "perp" && id !== market.id)
      .map(({ id }) => id),
  };
  proven("rollup clock", `${rollupAhead} s ahead of this machine's`);

  const asOracle = await sendingAs(on, oracle);
  const mark = (await reader.priceFeed(market.id)).price;
  // The program takes one price a second of the rollup clock.
  const publish = async () => {
    const time = BigInt(await clockOf(on.rollup));
    if ((await reader.priceFeed(market.id)).publishTime >= time) return;
    await send(
      asOracle,
      on.instructions.publishPrice(oracle.publicKey, market.id, mark, time),
      oracle,
    );
  };
  await publish();
  proven("price published by the oracle key, on the rollup clock", `${mark}`);

  const params = decodeMarket(
    (await anonymous.getAccountInfo(addresses.market(market.id)))!.data,
  ).params;
  const collateral = deployment.tokens.find(
    ({ symbol }) => symbol === COLLATERAL,
  );
  if (collateral && deployment.depositUrl) {
    await deposited(on, deployment.depositUrl, collateral, market.id, [
      maker,
      taker,
    ]);
    await filled(market.id, params, mark, maker, taker, reader, options);
  }

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

  if (!collateral) {
    await timed(
      "sync_view calls (no order passes the margin check without collateral; this call takes an order's path, signed by a one-time key and confirmed from the view)",
      () => maker.client.syncView(market.id),
    );
    throw new Error(
      "Incomplete: this deployment has no tokens, so nobody could deposit. The fill, the tape, the cancel and an order's own timing were not checked.",
    );
  }
  await timed("post-only orders that rest", async (number) => {
    if (number % PRICE_REFRESH_EVERY === 0) await publish();
    return restingBid(market.id, params, mark, maker, options);
  });
  await maker.client.cancelAll(market.id);
}

async function deposited(
  on: Target,
  depositUrl: string,
  token: DeploymentDescription["tokens"][number],
  marketId: number,
  traders: Trader[],
): Promise<void> {
  const faucet = heldKey(join(on.keys, `${on.network}-faucet.json`));
  const mint = new PublicKey(token.mint);
  const deposits = new Connection(depositUrl, "confirmed");
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
      `collateral ${(await client.view()).snapshot.seat.collateral} atoms of ${token.symbol}`,
    );
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
  mark: bigint,
  maker: Trader,
  taker: Trader,
  reader: MarketReader,
  options: PlaceOrderOptions,
): Promise<void> {
  const size = smallestSize(params, mark);
  const positionOf = async (trader: Trader) => {
    await trader.client.syncView(marketId);
    return (await trader.client.view()).snapshot.seat.perp[marketId].base;
  };
  const position = await positionOf(maker);
  const makerSide = position < 0n ? SIDE.bid : SIDE.ask;
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
      `the crossing order filled ${crossed.result.filled} of ${size}`,
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

/** A post-only bid below the mark that must rest, and its timing. */
async function restingBid(
  marketId: number,
  params: MarketParams,
  mark: bigint,
  trader: Trader,
  options: PlaceOrderOptions,
): Promise<Timing> {
  const price = mark - 20n * params.tick;
  const placed = settled(
    await trader.client.placeOrder(
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

/** Times `TIMED_CALLS` calls, one after another, from send to the result in the view. */
async function timed(
  what: string,
  call: (number: number) => Promise<Timing>,
): Promise<void> {
  const took: number[] = [];
  for (let number = 0; number < TIMED_CALLS; number += 1) {
    const { sentAt, resultAt } = await call(number);
    took.push(resultAt - sentAt);
  }
  const sorted = [...took].sort((a, b) => a - b);
  console.log(
    `time from send to result, ${TIMED_CALLS} ${what}: median ${median(sorted).toFixed(0)} ms, worst ${sorted[sorted.length - 1].toFixed(0)} ms.`,
  );
  console.log(
    "That is this machine's connection to the endpoint, not the rollup's own speed.",
  );
}

target()
  .then(smoke)
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });

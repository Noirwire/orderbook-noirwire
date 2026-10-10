/**
 * The cast, the settings and the helpers every part of the order book's
 * story shares. The parts run in the order `orderbook.test.ts` lists them, on
 * one network, and each builds on the state the ones before it left.
 */
import { expect } from "chai";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  ACCOUNT_LEN,
  MARKET_KIND,
  MARKET_STATUS,
  OrderKeyManager,
  TraderClient,
  decodeExchange,
  randomClientOrderId,
  randomSecret,
  rollupRent,
  type AssetKind,
  type Exchange,
  type MarketLimits,
  type MarketSettings,
  type OrderInput,
  type OrderKeyCall,
  type OrderKeyUse,
  type OrderResult,
  type Placed,
} from "../../sdk/dist/index.js";
import { minted, movedIntoRollup } from "../../ops/tokens";
import {
  PROGRAM_ID,
  VALIDATOR,
  addresses,
  admin,
  balanceOf,
  fundingThroughThePort,
  instructions,
  ledgerThroughThePort,
  nowSeconds,
  readingAs,
  refusal,
  rollup,
  send,
  solana,
  until,
} from "../support";

export const EXCHANGE_FLOAT = 0.2 * LAMPORTS_PER_SOL;
export const SEATS_PER_DAY = 1_000;
export const SECONDS_PER_DAY = 86_400n;

/** Market ids. `UNFINISHED` is created and never finalised. */
export const SPOT = 0;
export const PERP = 1;
export const TINY = 2;
export const UNFINISHED = 3;
export const NEVER_CREATED = 5;
export const VIA_FILTER = 6;

/** Token indices. `OPEN` is registered with public custody; nothing is ever registered at `UNREGISTERED`. */
export const NUSD = 0;
export const NSOL = 1;
export const OPEN = 2;
export const UNREGISTERED = 3;

export const USD = 1_000_000n;
export const SOL = 1_000_000_000n;
export const LOT = 1_000_000n;
export const MARK = 150_000n;
/** The mark the admin resets the perp to, low enough to put bob below maintenance. */
export const CRASHED_MARK = 136_000n;

export const SEAT_CLOSED = 0;
export const SEAT_OPEN = 1;
/** A seat index inside the ledger that this suite never opens. */
export const SEAT_NEVER_OPENED = 2_000;
export const ENGINE_ORDER_NOT_FOUND = 50;

const VIEW_PERMISSION_LEN = 35 + 2 * 33;
/** What the exchange pays for a trader's view and its permission, and gets back when they close. */
export const TRADER_RENT =
  rollupRent(ACCOUNT_LEN.view) + rollupRent(VIEW_PERMISSION_LEN);

export const COLLATERAL: AssetKind = { collateral: true };

export const gate = Keypair.generate();
export const oracle = Keypair.generate();
export const stranger = Keypair.generate();

/** `open` is the mint registered with public custody. */
export const mints = {} as {
  nUSD: PublicKey;
  nSOL: PublicKey;
  open: PublicKey;
};

export type Trader = {
  owner: Keypair;
  keys: OrderKeyManager;
  client: TraderClient;
  /** The private endpoint, signed in as the owner. */
  reader: Connection;
  tokenAccounts: Map<string, PublicKey>;
  seat: number;
};

/** The traders opened in `trader.ts`, who trade in every part after it. */
export const cast = {} as { alice: Trader; bob: Trader; carol: Trader };

export const settings = (
  over: Partial<{ maxSteps: number; collateralToken: number }> = {},
) => ({
  gate: gate.publicKey,
  oracle: oracle.publicKey,
  maxSteps: 16,
  collateralToken: NUSD,
  maxSeatsPerDay: SEATS_PER_DAY,
  ...over,
});

export const limits = (over: Partial<MarketLimits> = {}): MarketLimits => ({
  minSize: 1n,
  minNotional: 1_000_000n,
  bandBps: 400,
  imBps: 1_000,
  mmBps: 500,
  takerFeeBps: 5,
  liqPenaltyBps: 100,
  fundingCapBps: 10,
  maxMoveBps: 250,
  maxOpenOrders: 32,
  maxPriceAge: 3_600n,
  fundingInterval: 2n,
  status: MARKET_STATUS.active,
  minPublishGap: 1,
  maxAgeLiquidation: 3_600n,
  openInterestCap: 1_000_000n,
  liqBufferBps: 100,
  liqInsuranceShareBps: 0,
  feeInsuranceShareBps: 0,
  ...over,
});

export const spotMarket = (capacity = 1024): MarketSettings => ({
  kind: MARKET_KIND.spot,
  baseSymbol: "NSOL",
  quoteSymbol: "NUSD",
  baseToken: NSOL,
  quoteToken: NUSD,
  tick: 100n,
  baseLot: LOT,
  capacity,
  limits: limits(),
});

export const perpMarket = (): MarketSettings => ({
  kind: MARKET_KIND.perp,
  baseSymbol: "NSOL",
  quoteSymbol: "NUSD",
  baseToken: NUSD,
  quoteToken: NUSD,
  tick: 100n,
  baseLot: LOT,
  capacity: 1024,
  limits: limits(),
});

export async function exchangeOn(connection: Connection): Promise<Exchange> {
  const account = await connection.getAccountInfo(addresses.exchange);
  if (!account) throw new Error("the exchange is not served here");
  return decodeExchange(account.data);
}

export const exchangeBalance = () => rollup.getBalance(addresses.exchange);

/** The program's refusal of what `sending` sent names `error`. */
export async function refuses(
  sending: Promise<unknown>,
  error: string,
  what?: string,
): Promise<void> {
  expect(await refusal(sending), what).to.include(error);
}

/** The result of an order that landed. An order that did not is a failed test. */
export function landed(placed: Placed): OrderResult {
  if (placed.outcome !== "placed") {
    throw new Error(`the order's outcome is ${placed.outcome}`);
  }
  return placed.result;
}

export const orderKeySeed = () =>
  globalThis.crypto.getRandomValues(new Uint8Array(32));

export const newOrderKeys = () =>
  OrderKeyManager.fresh(orderKeySeed()).publicKeys;

const openClients: TraderClient[] = [];

// A client that made a call holds a websocket, which would keep the run alive.
after(() => openClients.forEach((client) => client.close()));

export async function openedTrader(): Promise<Trader> {
  const owner = Keypair.generate();
  const keys = OrderKeyManager.fresh(orderKeySeed());
  await send(
    rollup,
    instructions.openTrader(gate.publicKey, owner.publicKey, keys.publicKeys),
    gate,
    [owner],
  );
  const reader = await readingAs(owner);
  const client = new TraderClient(
    rollup,
    reader,
    owner.publicKey,
    keys,
    PROGRAM_ID,
  );
  openClients.push(client);
  const { seat } = await client.view();
  return { owner, keys, client, reader, tokenAccounts: new Map(), seat };
}

/** `amount` of `mint`, minted to `owner` on Solana and moved into the rollup as a private balance. */
export async function funded(
  owner: Keypair,
  mint: PublicKey,
  amount: bigint,
): Promise<PublicKey> {
  await minted(solana, admin, mint, owner.publicKey, amount);
  return movedIntoRollup(solana, rollup, admin, owner, mint, amount, VALIDATOR);
}

export async function fundedWith(
  trader: Trader,
  mint: PublicKey,
  amount: bigint,
): Promise<PublicKey> {
  const account = await funded(trader.owner, mint, amount);
  trader.tokenAccounts.set(mint.toBase58(), account);
  return account;
}

export function tokenAccount(trader: Trader, mint: PublicKey): PublicKey {
  const account = trader.tokenAccounts.get(mint.toBase58());
  if (!account) throw new Error("the trader was never funded with this mint");
  return account;
}

/** A deposit by the trader into its own seat. */
export async function deposited(
  trader: Trader,
  mint: PublicKey,
  asset: AssetKind,
  amount: bigint,
): Promise<void> {
  await send(
    rollup,
    instructions.deposit(
      trader.owner.publicKey,
      tokenAccount(trader, mint),
      mint,
      trader.owner.publicKey,
      asset,
      amount,
    ),
    trader.owner,
  );
}

export const call = (
  trader: Trader,
  use: OrderKeyUse,
  marketId: number,
  clientOrderId: bigint,
  expiresAt: bigint,
): OrderKeyCall => ({
  orderKey: use.keypair.publicKey,
  owner: trader.owner.publicKey,
  expiresAt,
  replacement: use.replacement.publicKey,
  clientOrderId,
  marketId,
  riskMarkets: [PERP],
});

export const order = (
  side: number,
  orderType: number,
  price: bigint,
  size: bigint,
) => ({
  side,
  orderType,
  price,
  size,
  secret: randomSecret(),
  reduceOnly: false,
  expiry: 0n,
});

/** Builds a `place_order` of `sample` by `trader`, for `attempted`. */
export const placing =
  (trader: Trader, marketId: number, sample: OrderInput): BuildKeyed =>
  (use, clientOrderId, expiresAt) =>
    instructions.placeOrder(
      call(trader, use, marketId, clientOrderId, expiresAt),
      sample,
    );

/** An expiry a few seconds ahead of this machine's clock, which the local rollup's clock follows. */
export const soon = () => BigInt(nowSeconds() + 5);

type BuildKeyed = (
  use: OrderKeyUse,
  clientOrderId: bigint,
  expiresAt: bigint,
) => TransactionInstruction;

/**
 * An order-key instruction built by hand and sent raw, so a refusal is seen as
 * the program's error. On success the key swap landed; on failure the key is
 * still live and goes back to the manager.
 */
export async function attempted(
  trader: Trader,
  build: BuildKeyed,
): Promise<{ clientOrderId: bigint; use: OrderKeyUse; signature: string }> {
  const use = trader.keys.take();
  const clientOrderId = randomClientOrderId();
  try {
    const signature = await send(
      rollup,
      build(use, clientOrderId, soon()),
      use.keypair,
    );
    trader.keys.confirm(use);
    return { clientOrderId, use, signature };
  } catch (error) {
    trader.keys.release(use);
    throw error;
  }
}

/** Reads the view as the trader and waits for a result for `clientOrderId`. */
export function resultFor(
  trader: Trader,
  clientOrderId: bigint,
): Promise<OrderResult> {
  return until(
    async () =>
      (await trader.client.view()).results.find(
        (result) => result.clientOrderId === clientOrderId,
      ),
    `a result for order ${clientOrderId}`,
    30_000,
    50,
  );
}

/**
 * RULES 13.1: custody equals the sum of seat balances, per token. The
 * collateral token also carries collateral and every perp position's quote,
 * with unpaid funding counted as paid. Read through the port, tests only.
 */
export async function custodyMatchesLedger(): Promise<void> {
  const ledger = await ledgerThroughThePort();
  const fundingIndex = new Map([
    [PERP, (await fundingThroughThePort(PERP)).index],
  ]);
  const open = ledger.seats.filter((seat) => seat.status === SEAT_OPEN);
  for (const [index, mint] of [
    [NUSD, mints.nUSD],
    [NSOL, mints.nSOL],
  ] as const) {
    let total = 0n;
    for (const seat of open) {
      total += seat.spot[index].available + seat.spot[index].locked;
      if (index === NUSD) {
        total += seat.collateral;
        for (const [market, slot] of seat.perp.entries()) {
          const unpaid =
            slot.base *
            ((fundingIndex.get(market) ?? 0n) - slot.fundingCheckpoint);
          total += slot.quote - unpaid;
        }
      }
    }
    expect(
      await balanceOf(addresses.custody(mint)),
      `custody of token ${index}`,
    ).to.equal(total);
  }
}

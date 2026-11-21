/**
 * What `make test-upgrade` needs to drive the build mainnet runs, the program
 * of the earlier commit, through the rollup: the instructions whose accounts or
 * bytes the current build changed, in the earlier form, a trader's client that
 * sends them, and the markets as the earlier build creates them. Everything
 * the two builds share is sent with the current client.
 *
 * The earlier build reads prices from Pyth: its markets and its USDC guard are
 * bound by a 32-byte feed id, an exponent and a confidence limit, and its
 * `create_market` and `update_market` carry a second price age for
 * liquidation. It has no trigger books, so no order-key instruction names one.
 */
import type { PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  ACCOUNT_LEN,
  GROW_KIND,
  Instructions,
  MARKET_KIND,
  TraderClient,
  decodePriceFeed,
  growToFullSize,
  instructionData,
  type MarketLimits,
  type MarketSettings,
  type OrderInput,
  type OrderKeyCall,
  type Writer,
} from "../../sdk/dist/index.js";
import {
  PROGRAM_ID,
  addresses,
  admin,
  inPublic,
  instructions,
  refusal,
  rollup,
  send,
} from "../support";
import {
  LOT,
  NUSD,
  SECONDS_PER_DAY,
  TICK,
  fundedTrader,
  limits,
  stranger,
  type Trader,
} from "../orderbook/world";
import { PYTH_SOL_FEED_ID } from "./price-fixtures";
import type { Snapshot } from "./snapshot";

const MAX_OPEN_INTEREST_CAP = 1n << 24n;
const DEFAULT_SETTLE_WINDOW = 900n;
const PYTH_EXPO = -8;
const FEED_ID_LEN = 32;
const SYMBOL_LEN = 8;

/**
 * A market's mark as the network serves it, rounded down to a tick. The story
 * never publishes a price again once the markets have their first: a later
 * publish time on the market that no source prices would make MagicBlock's
 * first observation arrive too soon after it.
 */
export async function markOf(marketId: number): Promise<bigint> {
  const { price } = decodePriceFeed(
    await inPublic(addresses.priceFeed(marketId)),
  );
  return price - (price % TICK);
}

/** The perp market the admin prices with the oracle key: bound to no source. */
export const UNBOUND_PERP = 1;
/** The perp market bound to Pyth's SOL/USD on the earlier build and to MagicBlock's on this one. */
export const BOUND_PERP = 2;
export const PERP_MARKETS = [UNBOUND_PERP, BOUND_PERP];

/** The earlier build's market limits: this build's, and the price age liquidation is held to. */
type EarlierLimits = MarketLimits & { maxAgeLiquidation: bigint };

/** How the earlier build binds a market: a Pyth feed id, its exponent and a confidence limit. */
type EarlierPriceSource = {
  feedId: Uint8Array;
  expo: number;
  maxConfBps: number;
  baseDecimals: number;
  quoteDecimals: number;
};

type EarlierMarket = Omit<MarketSettings, "limits" | "priceSource"> & {
  limits: EarlierLimits;
  priceSource: EarlierPriceSource;
};

/** The earlier build's USDC guard source. */
type EarlierQuote = {
  feedId: Uint8Array;
  expo: number;
  maxConfBps: number;
  depegBps: number;
  maxAge: bigint;
};

const UNBOUND_EARLIER: EarlierPriceSource = {
  feedId: new Uint8Array(FEED_ID_LEN),
  expo: 0,
  maxConfBps: 100,
  baseDecimals: 0,
  quoteDecimals: 0,
};

function earlierLimits(writer: Writer, limits: EarlierLimits): Writer {
  return writer
    .u64(limits.minSize)
    .u64(limits.minNotional)
    .u16(limits.bandBps)
    .u16(limits.imBps)
    .u16(limits.mmBps)
    .u16(limits.takerFeeBps)
    .u16(limits.liqPenaltyBps)
    .u16(limits.fundingCapBps)
    .u16(limits.maxMoveBps)
    .u16(limits.maxOpenOrders)
    .i64(limits.maxPriceAge)
    .i64(limits.fundingInterval)
    .u16(limits.minPublishGap ?? 1)
    .i64(limits.maxAgeLiquidation)
    .u64(limits.openInterestCap ?? MAX_OPEN_INTEREST_CAP)
    .u16(limits.liqBufferBps ?? 100)
    .u16(limits.liqInsuranceShareBps ?? 0)
    .u16(limits.feeInsuranceShareBps ?? 0)
    .i64(limits.settleWindow ?? DEFAULT_SETTLE_WINDOW)
    .u64(limits.positionCap);
}

/** Builds the earlier build's instructions from the current ones' accounts, with the earlier bytes. */
class EarlierInstructions extends Instructions {
  createEarlierMarket(
    admin: PublicKey,
    marketId: number,
    settings: EarlierMarket,
  ): TransactionInstruction {
    const { limits, priceSource, ...shared } = settings;
    const built = super.createMarket(admin, marketId, { ...shared, limits });
    const header = instructionData("create_market")
      .u8(marketId)
      .u8(settings.kind)
      .fixed(settings.baseSymbol, SYMBOL_LEN)
      .fixed(settings.quoteSymbol, SYMBOL_LEN)
      .u8(settings.baseToken)
      .u8(settings.quoteToken)
      .u64(settings.tick)
      .u64(settings.baseLot)
      .u16(settings.capacity);
    built.data = earlierLimits(header, limits)
      .fixed(priceSource.feedId, FEED_ID_LEN)
      .i32(priceSource.expo)
      .u16(priceSource.maxConfBps)
      .u8(priceSource.baseDecimals)
      .u8(priceSource.quoteDecimals)
      .build();
    return built;
  }

  setEarlierQuoteSource(
    admin: PublicKey,
    quote: EarlierQuote,
  ): TransactionInstruction {
    const built = super.setQuoteSource(admin, {
      feed: 1,
      depegBps: quote.depegBps,
      maxAge: quote.maxAge,
    });
    built.data = instructionData("set_quote_source")
      .fixed(quote.feedId, FEED_ID_LEN)
      .i32(quote.expo)
      .u16(quote.maxConfBps)
      .u16(quote.depegBps)
      .i64(quote.maxAge)
      .build();
    return built;
  }

  /** The earlier `update_market`: the limits carry the price age liquidation is held to, so every byte after the fundingInterval shifts. */
  updateEarlierMarket(
    admin: PublicKey,
    marketId: number,
    limits: EarlierLimits,
  ): TransactionInstruction {
    const built = super.updateMarket(admin, marketId, limits);
    built.data = earlierLimits(
      instructionData("update_market").u8(marketId),
      limits,
    ).build();
    return built;
  }

  /** The earlier `set_price_source`: a 32-byte feed id and an exponent. */
  setEarlierPriceSource(
    admin: PublicKey,
    marketId: number,
    feedId: Uint8Array,
    expo: number,
  ): TransactionInstruction {
    const built = super.setPriceSource(admin, marketId, 0);
    built.data = instructionData("set_price_source")
      .u8(marketId)
      .fixed(feedId, FEED_ID_LEN)
      .i32(expo)
      .build();
    return built;
  }

  /** The earlier `sync_price`: three accounts, the market, its price feed and the price account, with no exchange in front. */
  override syncPrice(marketId: number, oraclePrice: PublicKey) {
    const built = super.syncPrice(marketId, oraclePrice);
    built.keys = built.keys.slice(1);
    return built;
  }

  /** The earlier `set_order_keys`: the owner and the view only, with no exchange and no ledger. */
  override setOrderKeys(owner: PublicKey, orderKeys: PublicKey[]) {
    const built = super.setOrderKeys(owner, orderKeys);
    built.keys = built.keys.slice(0, 2);
    return built;
  }

  override placeOrder(call: OrderKeyCall, order: OrderInput) {
    return this.withoutTriggerBook(call, super.placeOrder(call, order));
  }

  override cancelOrder(call: OrderKeyCall, orderSeq: bigint) {
    return this.withoutTriggerBook(call, super.cancelOrder(call, orderSeq));
  }

  override cancelAll(call: OrderKeyCall, maxCancels: number) {
    return this.withoutTriggerBook(call, super.cancelAll(call, maxCancels));
  }

  override syncView(call: OrderKeyCall) {
    return this.withoutTriggerBook(call, super.syncView(call));
  }

  /** The earlier build has no trigger book, and names none. */
  private withoutTriggerBook(
    call: OrderKeyCall,
    built: TransactionInstruction,
  ): TransactionInstruction {
    const book = this.addresses.triggers(call.marketId);
    built.keys = built.keys.filter((meta) => !meta.pubkey.equals(book));
    return built;
  }
}

export const earlier = new EarlierInstructions(PROGRAM_ID);

/** A trader's client that sends the earlier build's instructions. */
export class EarlierTraderClient extends TraderClient {
  constructor(...parameters: ConstructorParameters<typeof TraderClient>) {
    super(...parameters);
    Object.assign(this, {
      instructions: new EarlierInstructions(parameters[4]),
    });
  }
}

/** The limits both markets are created with: prices may be a day old, so a fixture needs no refresh. */
const marketLimits = (): EarlierLimits => ({
  ...limits({ maxPriceAge: SECONDS_PER_DAY }),
  maxAgeLiquidation: SECONDS_PER_DAY,
});

const perpMarket = (priceSource: EarlierPriceSource): EarlierMarket => ({
  kind: MARKET_KIND.perp,
  baseSymbol: "NSOL",
  quoteSymbol: "NUSD",
  baseToken: NUSD,
  quoteToken: NUSD,
  tick: 100n,
  baseLot: LOT,
  capacity: 1024,
  limits: marketLimits(),
  priceSource,
});

export const unboundPerp = (): EarlierMarket => perpMarket(UNBOUND_EARLIER);

/** SOL/USD at eight decimals in a market of 0.001 SOL lots of six-decimal dollars. */
export const pythPerp = (): EarlierMarket =>
  perpMarket({
    feedId: PYTH_SOL_FEED_ID,
    expo: PYTH_EXPO,
    maxConfBps: 100,
    baseDecimals: 9,
    quoteDecimals: 6,
  });

/** What the earlier build's USDC guard is bound to, and how long one healthy observation lasts. */
export const pythQuote = (feedId: Uint8Array): EarlierQuote => ({
  feedId,
  expo: PYTH_EXPO,
  maxConfBps: 100,
  depegBps: 100,
  maxAge: SECONDS_PER_DAY,
});

/** Creates a market on the earlier build, grows its book and tape and finalises it. */
export async function createdOnEarlierBuild(
  marketId: number,
  settings: EarlierMarket,
): Promise<void> {
  await send(
    rollup,
    earlier.createEarlierMarket(admin.publicKey, marketId, settings),
    admin,
  );
  await growToFullSize(
    rollup,
    admin,
    GROW_KIND.book,
    marketId,
    addresses.book(marketId),
    ACCOUNT_LEN.book,
  );
  await growToFullSize(
    rollup,
    admin,
    GROW_KIND.tape,
    marketId,
    addresses.tape(marketId),
    ACCOUNT_LEN.tape,
  );
  await send(rollup, earlier.finalizeMarket(admin.publicKey, marketId), admin);
}

/** A trader on the earlier build whose first deposit, `collateral` of nUSD, took its seat. */
export const fundedOnEarlierBuild = (collateral: bigint): Promise<Trader> =>
  fundedTrader(collateral, EarlierTraderClient);

/** Hands a trader of the earlier build to this build's client, with the same keys and the same view. */
export function handedToThisBuild(trader: Trader): void {
  trader.client.close();
  trader.client = new TraderClient(
    rollup,
    trader.reader,
    trader.owner.publicKey,
    trader.keys,
    PROGRAM_ID,
  );
  thisBuildClients.push(trader.client);
}

const thisBuildClients: TraderClient[] = [];

/** Ends the subscriptions of every client made for this build's traders. */
function closeThisBuildClients(): void {
  thisBuildClients.splice(0).forEach((client) => client.close());
}

// A client that made a call holds a websocket, which would keep the run alive.
after(closeThisBuildClients);

/** What a program says of an instruction it has no handler for. */
export const NO_SUCH_INSTRUCTION = "InstructionFallbackNotFound";

/**
 * The text of the program's refusal of `set_price_source_v2` from a stranger.
 * The earlier build has no such instruction; this build reads the call and
 * refuses the signer.
 */
export function refusalOfSetPriceSource(): Promise<string> {
  return refusal(
    send(
      rollup,
      instructions.setPriceSource(stranger.publicKey, BOUND_PERP, 6),
      stranger,
    ),
  );
}

/** What the story left, which the compare after the upgrade reads. */
export const upgrade = {} as {
  alice: Trader;
  bob: Trader;
  /** A seat listed as maker and taker on every perp market. */
  listed: Trader;
  /** A seat the admin blocked. */
  blocked: Trader;
  /** The seat that was opened and closed between open ones, and the version it closed at. */
  closedSeat: { index: number; version: bigint };
  /** The lots the story trades on each market, by market id. */
  lots: Map<number, bigint>;
  /** The marks the story traded at, by market id. */
  marks: Map<number, bigint>;
  /** Every account as the earlier build left it, paused. */
  before: Snapshot;
};

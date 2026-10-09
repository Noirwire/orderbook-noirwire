import { PublicKey } from "@solana/web3.js";
import {
  ACCOUNT_LEN,
  ACCOUNT_TAG,
  HEADER_LEN,
  MAX_MARKETS,
  MAX_OPEN_ORDERS,
  ORDER_KEYS,
  RESULTS,
  SEATS,
  SEAT_LEN,
  TAPE_FILLS,
  TOKENS,
} from "./constants.js";
import { Reader } from "./bytes.js";

export type Header = {
  tag: string;
  ready: boolean;
  marketId: number;
  bump: number;
};

export type MarketParams = {
  tick: bigint;
  baseLot: bigint;
  minSize: bigint;
  minNotional: bigint;
  uncoveredShortfall: bigint;
  fundingInterval: bigint;
  maxPriceAge: bigint;
  bandBps: number;
  imBps: number;
  mmBps: number;
  takerFeeBps: number;
  liqPenaltyBps: number;
  fundingCapBps: number;
  maxMoveBps: number;
  maxOpenOrders: number;
  kind: number;
  status: number;
  marketId: number;
  baseToken: number;
  quoteToken: number;
  minPublishGap: number;
  maxAgeLiquidation: bigint;
  openInterestCap: bigint;
  liqBufferBps: number;
  liqInsuranceShareBps: number;
  feeInsuranceShareBps: number;
};

export type Market = {
  header: Header;
  params: MarketParams;
  baseSymbol: string;
  quoteSymbol: string;
  capacity: number;
};

export type TapeFill = {
  fillSeq: bigint;
  price: bigint;
  size: bigint;
  time: bigint;
  makerReceipt: Uint8Array;
  takerReceipt: Uint8Array;
  takerSide: number;
};

export type Tape = {
  header: Header;
  lastPrice: bigint;
  lastFillSeq: bigint;
  written: bigint;
  /** The fills still on the tape, newest first. */
  fills: TapeFill[];
};

export type PriceFeed = {
  header: Header;
  price: bigint;
  publishTime: bigint;
};

export type Stats = {
  header: Header;
  orders: bigint;
  fills: bigint;
  volume: bigint[];
  openInterest: bigint[];
};

export type TokenBalance = { available: bigint; locked: bigint };

export type PerpSlot = {
  base: bigint;
  quote: bigint;
  fundingCheckpoint: bigint;
  openBidLots: bigint;
  openAskLots: bigint;
};

export type Seat = {
  owner: PublicKey;
  version: bigint;
  collateral: bigint;
  spot: TokenBalance[];
  perp: PerpSlot[];
  openOrders: number[];
  status: number;
};

export type OrderView = {
  price: bigint;
  remaining: bigint;
  sequence: bigint;
  locked: bigint;
  /** RULES 4: unix seconds after which the order is cancelled when matching reaches it; 0 for never. */
  expiry: bigint;
  secret: Uint8Array;
  side: number;
};

export type SeatSnapshot = {
  seat: Seat;
  seatIndex: number;
  marketId: number;
  orders: OrderView[];
};

export type OrderResult = {
  clientOrderId: bigint;
  orderSeq: bigint;
  filled: bigint;
  filledNotional: bigint;
  rested: bigint;
  cancelled: bigint;
  fee: bigint;
  kind: number;
  status: number;
  code: number;
};

export type View = {
  header: Header;
  owner: PublicKey;
  orderKeys: PublicKey[];
  seat: number;
  resultsWritten: number;
  /** The results still in the ring, newest first. */
  results: OrderResult[];
  snapshot: SeatSnapshot;
};

export type Ledger = {
  header: Header;
  openSeats: number;
  seats: Seat[];
};

export type TokenInfo = { mint: PublicKey; custody: PublicKey };

export type Exchange = {
  bump: number;
  admin: PublicKey;
  pendingAdmin: PublicKey | null;
  gate: PublicKey;
  oracle: PublicKey;
  paused: boolean;
  maxSteps: number;
  collateralToken: number;
  tokens: TokenInfo[];
  /** One bit per perp market that exists, by market id. */
  perpMarkets: number;
};

function header(reader: Reader, tag: string, length: number): Header {
  if (reader.data.length !== length) {
    throw new Error(
      `expected ${length} bytes of account data, got ${reader.data.length}`,
    );
  }
  const found = new TextDecoder().decode(reader.bytes(8));
  if (found !== tag) {
    throw new Error(`expected a ${JSON.stringify(tag)} account`);
  }
  const ready = reader.bool();
  const marketId = reader.u8();
  const bump = reader.u8();
  reader.skip(5);
  return { tag, ready, marketId, bump };
}

function marketParams(reader: Reader): MarketParams {
  const params = {
    tick: reader.u64(),
    baseLot: reader.u64(),
    minSize: reader.u64(),
    minNotional: reader.u64(),
    uncoveredShortfall: reader.u64(),
    fundingInterval: reader.i64(),
    maxPriceAge: reader.i64(),
    maxAgeLiquidation: reader.i64(),
    openInterestCap: reader.u64(),
    bandBps: reader.u16(),
    imBps: reader.u16(),
    mmBps: reader.u16(),
    takerFeeBps: reader.u16(),
    liqPenaltyBps: reader.u16(),
    fundingCapBps: reader.u16(),
    maxMoveBps: reader.u16(),
    maxOpenOrders: reader.u16(),
    liqBufferBps: reader.u16(),
    liqInsuranceShareBps: reader.u16(),
    feeInsuranceShareBps: reader.u16(),
    minPublishGap: reader.u16(),
    kind: reader.u8(),
    status: reader.u8(),
    marketId: reader.u8(),
    baseToken: reader.u8(),
    quoteToken: reader.u8(),
  };
  reader.skip(3);
  return params;
}

export function decodeMarket(data: Uint8Array): Market {
  const reader = new Reader(data);
  const head = header(reader, ACCOUNT_TAG.market, ACCOUNT_LEN.market);
  const params = marketParams(reader);
  const baseSymbol = reader.symbol(8);
  const quoteSymbol = reader.symbol(8);
  const capacity = reader.u16();
  return { header: head, params, baseSymbol, quoteSymbol, capacity };
}

function tapeFill(reader: Reader): TapeFill {
  const fill = {
    fillSeq: reader.u64(),
    price: reader.u64(),
    size: reader.u64(),
    time: reader.i64(),
    makerReceipt: reader.bytes(8),
    takerReceipt: reader.bytes(8),
    takerSide: reader.u8(),
  };
  reader.skip(7);
  return fill;
}

/** The live entries of a ring of `capacity` slots, newest first. */
function ring<T>(
  written: bigint,
  capacity: number,
  readAt: (slot: number) => T,
): T[] {
  const count = Number(written < BigInt(capacity) ? written : BigInt(capacity));
  const entries: T[] = [];
  for (let back = 1; back <= count; back += 1) {
    const slot = Number((written - BigInt(back)) % BigInt(capacity));
    entries.push(readAt(slot));
  }
  return entries;
}

export function decodeTape(data: Uint8Array): Tape {
  const reader = new Reader(data);
  const head = header(reader, ACCOUNT_TAG.tape, ACCOUNT_LEN.tape);
  const lastPrice = reader.u64();
  const lastFillSeq = reader.u64();
  const written = reader.u64();
  const first = reader.offset;
  const fills = ring(written, TAPE_FILLS, (slot) =>
    tapeFill(reader.seek(first + slot * 56)),
  );
  return { header: head, lastPrice, lastFillSeq, written, fills };
}

export function decodePriceFeed(data: Uint8Array): PriceFeed {
  const reader = new Reader(data);
  const head = header(reader, ACCOUNT_TAG.priceFeed, ACCOUNT_LEN.priceFeed);
  return { header: head, price: reader.u64(), publishTime: reader.i64() };
}

export function decodeStats(data: Uint8Array): Stats {
  const reader = new Reader(data);
  const head = header(reader, ACCOUNT_TAG.stats, ACCOUNT_LEN.stats);
  const orders = reader.u64();
  const fills = reader.u64();
  const volume = Array.from({ length: MAX_MARKETS }, () => reader.u64());
  const openInterest = Array.from({ length: MAX_MARKETS }, () => reader.u64());
  return { header: head, orders, fills, volume, openInterest };
}

export function seat(reader: Reader): Seat {
  const start = reader.offset;
  const owner = reader.pubkey();
  const version = reader.u64();
  const collateral = reader.i64();
  const spot = Array.from({ length: TOKENS }, () => ({
    available: reader.u64(),
    locked: reader.u64(),
  }));
  const perp = Array.from({ length: MAX_MARKETS }, () => ({
    base: reader.i64(),
    quote: reader.i64(),
    fundingCheckpoint: reader.i64(),
    openBidLots: reader.u64(),
    openAskLots: reader.u64(),
  }));
  const openOrders = Array.from({ length: MAX_MARKETS }, () => reader.u8());
  const status = reader.u8();
  reader.seek(start + SEAT_LEN);
  return { owner, version, collateral, spot, perp, openOrders, status };
}

function orderView(reader: Reader): OrderView {
  const order = {
    price: reader.u64(),
    remaining: reader.u64(),
    sequence: reader.u64(),
    locked: reader.u64(),
    expiry: reader.i64(),
    secret: reader.bytes(16),
    side: reader.u8() & 1,
  };
  reader.skip(7);
  return order;
}

function seatSnapshot(reader: Reader): SeatSnapshot {
  const seatCopy = seat(reader);
  const seatIndex = reader.u32();
  const orderCount = reader.u32();
  const marketId = reader.u8();
  reader.skip(7);
  const orders: OrderView[] = [];
  for (let at = 0; at < MAX_OPEN_ORDERS; at += 1) {
    const order = orderView(reader);
    if (at < orderCount) orders.push(order);
  }
  return { seat: seatCopy, seatIndex, marketId, orders };
}

function orderResult(reader: Reader): OrderResult {
  const result = {
    clientOrderId: reader.u64(),
    orderSeq: reader.u64(),
    filled: reader.u64(),
    filledNotional: reader.u64(),
    rested: reader.u64(),
    cancelled: reader.u64(),
    fee: reader.u64(),
    kind: reader.u8(),
    status: reader.u8(),
    code: reader.u16(),
  };
  reader.skip(4);
  return result;
}

export function decodeView(data: Uint8Array): View {
  const reader = new Reader(data);
  const head = header(reader, ACCOUNT_TAG.view, ACCOUNT_LEN.view);
  const owner = reader.pubkey();
  const orderKeys = Array.from({ length: ORDER_KEYS }, () => reader.pubkey());
  const seatIndex = reader.u32();
  const resultsWritten = reader.u32();
  const first = reader.offset;
  const results = ring(BigInt(resultsWritten), RESULTS, (slot) =>
    orderResult(reader.seek(first + slot * 64)),
  );
  reader.seek(first + RESULTS * 64);
  const snapshot = seatSnapshot(reader);
  return {
    header: head,
    owner,
    orderKeys,
    seat: seatIndex,
    resultsWritten,
    results,
    snapshot,
  };
}

/** The whole ledger. Only the rollup's own port serves it; a test reads it there. */
export function decodeLedger(data: Uint8Array): Ledger {
  const reader = new Reader(data);
  const head = header(reader, ACCOUNT_TAG.ledger, ACCOUNT_LEN.ledger);
  const openSeats = reader.u32();
  reader.skip(4);
  const seats = Array.from({ length: SEATS }, () => seat(reader));
  return { header: head, openSeats, seats };
}

export function decodeExchange(data: Uint8Array): Exchange {
  const reader = new Reader(data, 8);
  const bump = reader.u8();
  const admin = reader.pubkey();
  const pendingAdmin = reader.bool() ? reader.pubkey() : null;
  const gate = reader.pubkey();
  const oracle = reader.pubkey();
  const paused = reader.bool();
  const maxSteps = reader.u8();
  const collateralToken = reader.u8();
  const tokens = Array.from({ length: TOKENS }, () => ({
    mint: reader.pubkey(),
    custody: reader.pubkey(),
  }));
  const perpMarkets = reader.u8();
  return {
    bump,
    admin,
    pendingAdmin,
    gate,
    oracle,
    paused,
    maxSteps,
    collateralToken,
    tokens,
    perpMarkets,
  };
}

/** Where the header ends and the body starts, for a reader that needs only the header. */
export function decodeHeader(data: Uint8Array): Header {
  const reader = new Reader(data);
  const tag = new TextDecoder().decode(reader.bytes(8));
  const ready = reader.bool();
  const marketId = reader.u8();
  const bump = reader.u8();
  return { tag, ready, marketId, bump };
}

export const headerLen = HEADER_LEN;

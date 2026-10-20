import { PublicKey } from "@solana/web3.js";
import {
  ACCOUNT_LEN,
  ACCOUNT_TAG,
  HEADER_LEN,
  MAX_MARKETS,
  MAX_OPEN_ORDERS,
  ORDER_KEYS,
  ORDER_RESULT_LEN,
  RESULTS,
  SEATS,
  SEAT_LEN,
  TAPE_FILLS,
  TAPE_FILL_LEN,
  TOKENS,
} from "./constants.js";
import { Reader } from "./bytes.js";
import {
  RECEIPT_LEN,
  SECRET_LEN,
  SYMBOL_LEN,
  TAG_LEN,
} from "./internal/sizes.js";

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
  /** RULES 9: seconds a settled gap keeps collateral from leaving any seat. */
  settleWindow: bigint;
  /** RULES 6: the largest position, long or short in lots, a fill may build on one seat. */
  positionCap: bigint;
  liqBufferBps: number;
  liqInsuranceShareBps: number;
  feeInsuranceShareBps: number;
  /** RULES 9: one of `ORACLE_HEALTH`. */
  oracleHealth: number;
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

/** RULES 9: the newest observation of the bound source, whether or not the mark followed it. */
export type SourceRecord = {
  rawPrice: bigint;
  conf: bigint;
  publishTime: bigint;
  /** `rawPrice` in quote atoms per lot. */
  target: bigint;
  /** The rollup time it was read. */
  observedAt: bigint;
};

/** RULES 9: the Pyth account a market reads and how its numbers become quote atoms per lot. */
export type SourceBinding = {
  /** The default key on a test network's market that is bound to nothing. */
  account: PublicKey;
  feedId: Uint8Array;
  expo: number;
  maxConfBps: number;
  baseDecimals: number;
  quoteDecimals: number;
};

/** RULES 9: the last incident; `MarketParams.oracleHealth` says whether it is still open. */
export type Incident = {
  since: bigint;
  /** The end of a settlement's window, kept through a dislocation during it; 0 for one that began healthy. */
  settleUntil: bigint;
  gapBps: number;
  /** One of `INCIDENT_REASON`, or 0 before the first incident. */
  reason: number;
};

export type PriceFeed = {
  header: Header;
  /** The mark every decision uses. */
  price: bigint;
  publishTime: bigint;
  /** The rollup time the price was accepted; the next change waits a gap from it. */
  acceptedAt: bigint;
  source: SourceRecord;
  binding: SourceBinding;
  incident: Incident;
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
  /**
   * Results the view has ever written. The program counts in 64 bits; a seat
   * would need 2^53 instructions before this number lost precision.
   */
  resultsWritten: number;
  /** The results still in the ring, newest first. */
  results: OrderResult[];
  snapshot: SeatSnapshot;
  /** The seat's version when it was opened; a seat still at it was never used. */
  openedVersion: bigint;
};

export type Ledger = {
  header: Header;
  openSeats: number;
  seats: Seat[];
};

/**
 * Who may read a token's custody balance, in the program's order. A public
 * one shows the token's total in custody to anyone, and so the size and time
 * of every deposit and withdrawal.
 */
export const CUSTODY_VISIBILITIES = ["sealed", "public"] as const;
export type CustodyVisibility = (typeof CUSTODY_VISIBILITIES)[number];

export type TokenInfo = {
  mint: PublicKey;
  custody: PublicKey;
  /** Names the token's custody authority. Chosen when the token was registered; it never changes. */
  custodyNonce: bigint;
  custodyBump: number;
  /** Chosen when the token was registered; it never changes. */
  custodyVisibility: CustodyVisibility;
  /**
   * The most the token's custody account may hold after a trader's deposit,
   * in atoms, as `setCustodyCap` set it. Zero takes no deposit.
   */
  custodyCap: bigint;
};

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
  /** The most seats `open_trader` opens in one UTC day of the rollup clock. */
  maxSeatsPerDay: number;
  /** The UTC day, in days since the epoch, that `seatsOpened` counts. */
  seatsDay: bigint;
  seatsOpened: number;
  /** RULES 9a: the USDC guard. */
  quote: QuoteGuard;
};

/** RULES 9a: the USDC guard every perp's increases depend on. */
export type QuoteGuard = {
  account: PublicKey;
  feedId: Uint8Array;
  expo: number;
  maxConfBps: number;
  depegBps: number;
  maxAge: bigint;
  price: bigint;
  conf: bigint;
  publishTime: bigint;
  /** The guard passes until this rollup time. */
  okUntil: bigint;
  /** One of `QUOTE_STATE`. */
  state: number;
};

function readHeader(reader: Reader): Header {
  const tag = new TextDecoder().decode(reader.bytes(TAG_LEN));
  const ready = reader.bool();
  const marketId = reader.u8();
  const bump = reader.u8();
  return { tag, ready, marketId, bump };
}

/** The header of an account of exactly `length` bytes tagged `tag`, leaving the reader at its body. */
function header(reader: Reader, tag: string, length: number): Header {
  if (reader.data.length !== length) {
    throw new Error(
      `expected ${length} bytes of account data, got ${reader.data.length}`,
    );
  }
  const head = readHeader(reader);
  if (head.tag !== tag) {
    throw new Error(`expected a ${JSON.stringify(tag)} account`);
  }
  reader.seek(HEADER_LEN);
  return head;
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
    settleWindow: reader.i64(),
    positionCap: reader.u64(),
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
    oracleHealth: reader.u8(),
  };
  reader.skip(2);
  return params;
}

export function decodeMarket(data: Uint8Array): Market {
  const reader = new Reader(data);
  const head = header(reader, ACCOUNT_TAG.market, ACCOUNT_LEN.market);
  const params = marketParams(reader);
  const baseSymbol = reader.symbol(SYMBOL_LEN);
  const quoteSymbol = reader.symbol(SYMBOL_LEN);
  const capacity = reader.u16();
  return { header: head, params, baseSymbol, quoteSymbol, capacity };
}

function tapeFill(reader: Reader): TapeFill {
  const fill = {
    fillSeq: reader.u64(),
    price: reader.u64(),
    size: reader.u64(),
    time: reader.i64(),
    makerReceipt: reader.bytes(RECEIPT_LEN),
    takerReceipt: reader.bytes(RECEIPT_LEN),
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
    tapeFill(reader.seek(first + slot * TAPE_FILL_LEN)),
  );
  return { header: head, lastPrice, lastFillSeq, written, fills };
}

export function decodePriceFeed(data: Uint8Array): PriceFeed {
  const reader = new Reader(data);
  const head = header(reader, ACCOUNT_TAG.priceFeed, ACCOUNT_LEN.priceFeed);
  const price = reader.u64();
  const publishTime = reader.i64();
  const acceptedAt = reader.i64();
  const source = {
    rawPrice: reader.i64(),
    conf: reader.u64(),
    publishTime: reader.i64(),
    target: reader.u64(),
    observedAt: reader.i64(),
  };
  const binding = {
    account: reader.pubkey(),
    feedId: reader.bytes(32),
    expo: reader.i32(),
    maxConfBps: reader.u16(),
    baseDecimals: reader.u8(),
    quoteDecimals: reader.u8(),
  };
  const incident = {
    since: reader.i64(),
    settleUntil: reader.i64(),
    gapBps: reader.u16(),
    reason: reader.u8(),
  };
  return {
    header: head,
    price,
    publishTime,
    acceptedAt,
    source,
    binding,
    incident,
  };
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
    secret: reader.bytes(SECRET_LEN),
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
  reader.skip(4);
  const written = reader.u64();
  const first = reader.offset;
  const results = ring(written, RESULTS, (slot) =>
    orderResult(reader.seek(first + slot * ORDER_RESULT_LEN)),
  );
  reader.seek(first + RESULTS * ORDER_RESULT_LEN);
  const snapshot = seatSnapshot(reader);
  const openedVersion = reader.u64();
  return {
    header: head,
    owner,
    orderKeys,
    seat: seatIndex,
    resultsWritten: Number(written),
    results,
    snapshot,
    openedVersion,
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
  const registered = Array.from({ length: TOKENS }, () => ({
    mint: reader.pubkey(),
    custody: reader.pubkey(),
    custodyNonce: reader.u64(),
    custodyBump: reader.u8(),
  }));
  const perpMarkets = reader.u8();
  const maxSeatsPerDay = reader.u32();
  const seatsDay = reader.i64();
  const seatsOpened = reader.u32();
  // One bit per token index.
  const publicCustody = reader.u8();
  const quote = {
    account: reader.pubkey(),
    feedId: reader.bytes(32),
    expo: reader.i32(),
    maxConfBps: reader.u16(),
    depegBps: reader.u16(),
    maxAge: reader.i64(),
    price: reader.i64(),
    conf: reader.u64(),
    publishTime: reader.i64(),
    okUntil: reader.i64(),
    state: reader.u8(),
  };
  const custodyCaps = Array.from({ length: TOKENS }, () => reader.u64());
  const tokens = registered.map((token, index) => ({
    ...token,
    custodyVisibility: CUSTODY_VISIBILITIES[(publicCustody >> index) & 1],
    custodyCap: custodyCaps[index],
  }));
  return {
    quote,
    maxSeatsPerDay,
    seatsDay,
    seatsOpened,
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

/** The header alone, whatever the account is and whether or not it is ready. */
export function decodeHeader(data: Uint8Array): Header {
  return readHeader(new Reader(data));
}

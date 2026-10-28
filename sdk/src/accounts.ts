import { PublicKey } from "@solana/web3.js";
import {
  ACCOUNT_LEN,
  ACCOUNT_TAG,
  HEADER_LEN,
  MAX_MARKETS,
  LEDGER_PREFIX,
  MAX_OPEN_ORDERS,
  NO_SEAT,
  ORDER_KEYS,
  ORDER_RESULT_LEN,
  RESULTS,
  SEAT_LEN,
  SEAT_SLOTS,
  SNAPSHOT_LAYOUT_SLOTS,
  SNAPSHOT_SEAT_RESERVE,
  ledgerSeats,
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
  /**
   * RULES 3a: the public switches, `MARKET_ACCESS.makersListed` and
   * `MARKET_ACCESS.takersListed`. Zero, as every market starts, lets every
   * seat make and take. Always zero on a spot market.
   */
  access: number;
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

/**
 * What a seat holds on one market: the slot tagged with that market. A tagged
 * slot that has gone flat is still listed; it reads as zero everywhere.
 */
export type Position = PerpSlot & {
  marketId: number;
  /** The seat's resting orders on the market. */
  openOrders: number;
};

export type Seat = {
  owner: PublicKey;
  version: bigint;
  collateral: bigint;
  spot: TokenBalance[];
  /**
   * The seat's tagged slots, in slot order, by the market each is tagged with.
   * Nobody indexes a slot by market number: use `positionOn`.
   */
  positions: Position[];
  /** The seat's state: 0 closed, 1 open. */
  status: number;
  /**
   * RULES 3a: bit `m` lists the seat as a maker on market `m`. Sealed in the
   * ledger; the owner reads its own in its view after a sync.
   */
  makerMarkets: bigint;
  /** RULES 3a: bit `m` lists the seat as a taker on market `m`. */
  takerMarkets: bigint;
  /** RULES 3a: a blocked seat may only cancel, reduce, move funds and close. */
  blocked: boolean;
  /** In a closed seat, the index plus one of the next free seat, or 0 at the end of the list; 0 in an open one. */
  nextFree: number;
};

const flatPosition = (marketId: number): Position => ({
  marketId,
  base: 0n,
  quote: 0n,
  fundingCheckpoint: 0n,
  openBidLots: 0n,
  openAskLots: 0n,
  openOrders: 0,
});

/** What `seat` holds on `marketId`: flat with no orders when no slot is tagged with it. */
export function positionOn(
  seat: Pick<Seat, "positions">,
  marketId: number,
): Position {
  return (
    seat.positions.find((position) => position.marketId === marketId) ??
    flatPosition(marketId)
  );
}

/** Whether the seat is open: a closed one is on the free list, or never used. */
export const seatIsOpen = (seat: Pick<Seat, "status">) => seat.status === 1;

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
  /** `SNAPSHOT_LAYOUT_SLOTS` once the program wrote it with tagged slots, 0 for one written before. */
  layout: number;
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
  /** The seat index the view records, or `NO_SEAT`. */
  seat: number;
  /**
   * Whether the view records a seat (`seat !== NO_SEAT`). Deliberately not
   * "seated": the release sweep may have given the seat back without touching
   * the view. Only `confirmSeat` (a `sync_view`) says whether the seat is held.
   */
  seatRecorded: boolean;
  /**
   * The snapshot was written before tagged slots: call `sync_view` to rewrite
   * it from the seat. It says nothing about whether the seat is held.
   */
  snapshotOld: boolean;
  ownerNonce: number;
  /**
   * Results the view has ever written. The program counts in 64 bits; a seat
   * would need 2^53 instructions before this number lost precision.
   */
  resultsWritten: number;
  /** The results still in the ring, newest first. */
  results: OrderResult[];
  snapshot: SeatSnapshot;
  /** Nonzero once a seat was ever taken for this view; it is never cleared. */
  used: bigint;
};

export type Ledger = {
  header: Header;
  openSeats: number;
  /** The index plus one of the first free seat, or 0 when none is free. */
  freeHead: number;
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
};

/** The little-endian u32 of the ASCII bytes "NWX2": what `layout` holds once the exchange is live. */
export const EXCHANGE_LAYOUT = 0x3258574e;
/** The little-endian u32 of the ASCII bytes "NWXR": what `layout` holds while the ledger is being copied. */
export const EXCHANGE_LAYOUT_RELAYOUT = 0x5258574e;

/**
 * `unmigrated` is any other word: the exchange has not been through
 * `migrate_exchange`, and the bytes are not a count.
 */
export type ExchangeLayoutState = "unmigrated" | "relayout" | "live";

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
  /** The most views `open_trader` opens in one UTC day of the rollup clock. */
  maxSeatsPerDay: number;
  /** The UTC day, in days since the epoch, that `seatsOpened` counts. */
  seatsDay: bigint;
  /** The views opened on `seatsDay`. */
  seatsOpened: number;
  /** The trader seats the ledger can hold, or null unless the exchange is live. */
  seatCapacity: number | null;
  /** The raw layout word; `EXCHANGE_LAYOUT` once live. */
  layout: number;
  layoutState: ExchangeLayoutState;
  /** The collateral atoms a seat-taking deposit must bring; 0 for no minimum. */
  minSeatDeposit: bigint;
  /** The seats copied so far while `layoutState` is "relayout"; 0 otherwise. */
  relayoutNext: number;
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
    access: reader.u8(),
  };
  reader.skip(1);
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

const readSpot = (reader: Reader): TokenBalance[] =>
  Array.from({ length: TOKENS }, () => ({
    available: reader.u64(),
    locked: reader.u64(),
  }));

const readSlot = (reader: Reader): PerpSlot => ({
  base: reader.i64(),
  quote: reader.i64(),
  fundingCheckpoint: reader.i64(),
  openBidLots: reader.u64(),
  openAskLots: reader.u64(),
});

/**
 * One seat of the ledger's layout, `SEAT_LEN` bytes at `offset`. Positions
 * come from the slot tags, so nobody indexes a slot by market: a slot is its
 * market's when it is tagged `market + 1`, empty or not. This is the one
 * function every client reads a seat through.
 */
export function decodeSeat(data: Uint8Array, offset = 0): Seat {
  const reader = new Reader(data, offset);
  const owner = reader.pubkey();
  const version = reader.u64();
  const collateral = reader.i64();
  const spot = readSpot(reader);
  const makerMarkets = reader.u64();
  const takerMarkets = reader.u64();
  const slots = Array.from({ length: SEAT_SLOTS }, () => readSlot(reader));
  const tags = Array.from({ length: SEAT_SLOTS }, () => reader.u8());
  const orders = Array.from({ length: SEAT_SLOTS }, () => reader.u8());
  const status = reader.u8();
  const blocked = reader.u8() !== 0;
  reader.skip(2);
  const nextFree = reader.u32();
  const positions = slots.flatMap((slot, at) =>
    tags[at] === 0
      ? []
      : [{ ...slot, marketId: tags[at] - 1, openOrders: orders[at] }],
  );
  return {
    owner,
    version,
    collateral,
    spot,
    positions,
    status,
    makerMarkets,
    takerMarkets,
    blocked,
    nextFree,
  };
}

/**
 * One seat of the layout the ledger was first built with, `LEGACY_SEAT_LEN`
 * bytes at `offset`: a slot for each of the eight markets. Only a view that
 * was not synced since the relayout still carries one. A market with nothing
 * on it is left out, as a slot nobody tagged.
 */
export function decodeLegacySeat(data: Uint8Array, offset = 0): Seat {
  const reader = new Reader(data, offset);
  const owner = reader.pubkey();
  const version = reader.u64();
  const collateral = reader.i64();
  const spot = readSpot(reader);
  const slots = Array.from({ length: MAX_MARKETS }, () => readSlot(reader));
  const orders = Array.from({ length: MAX_MARKETS }, () => reader.u8());
  const status = reader.u8();
  const makerMarkets = reader.u8();
  const takerMarkets = reader.u8();
  const blocked = reader.u8() !== 0;
  const positions = slots.flatMap((slot, marketId) => {
    const openOrders = orders[marketId];
    const used =
      slot.base !== 0n ||
      slot.quote !== 0n ||
      slot.openBidLots !== 0n ||
      slot.openAskLots !== 0n ||
      openOrders !== 0;
    return used ? [{ ...slot, marketId, openOrders }] : [];
  });
  return {
    owner,
    version,
    collateral,
    spot,
    positions,
    status,
    makerMarkets: BigInt(makerMarkets),
    takerMarkets: BigInt(takerMarkets),
    blocked,
    nextFree: 0,
  };
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

/** Where `SeatSnapshot.layout` sits, counted from the snapshot's start. */
const SNAPSHOT_LAYOUT_AT = SEAT_LEN + SNAPSHOT_SEAT_RESERVE + 4 + 4 + 1;

function seatSnapshot(reader: Reader): SeatSnapshot {
  const start = reader.offset;
  const layout = reader.data[start + SNAPSHOT_LAYOUT_AT];
  const seatCopy =
    layout === SNAPSHOT_LAYOUT_SLOTS
      ? decodeSeat(reader.data, start)
      : decodeLegacySeat(reader.data, start);
  reader.seek(start + SEAT_LEN + SNAPSHOT_SEAT_RESERVE);
  const seatIndex = reader.u32();
  const orderCount = reader.u32();
  const marketId = reader.u8();
  reader.skip(7);
  const orders: OrderView[] = [];
  for (let at = 0; at < MAX_OPEN_ORDERS; at += 1) {
    const order = orderView(reader);
    if (at < orderCount) orders.push(order);
  }
  return { seat: seatCopy, layout, seatIndex, marketId, orders };
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
  const ownerNonce = reader.u32();
  const written = reader.u64();
  const first = reader.offset;
  const results = ring(written, RESULTS, (slot) =>
    orderResult(reader.seek(first + slot * ORDER_RESULT_LEN)),
  );
  reader.seek(first + RESULTS * ORDER_RESULT_LEN);
  const snapshot = seatSnapshot(reader);
  const used = reader.u64();
  return {
    header: head,
    owner,
    orderKeys,
    seat: seatIndex,
    seatRecorded: seatIndex !== NO_SEAT,
    snapshotOld: snapshot.layout !== SNAPSHOT_LAYOUT_SLOTS,
    ownerNonce,
    resultsWritten: Number(written),
    results,
    snapshot,
    used,
  };
}

/**
 * The whole ledger, sized from its length. Only the rollup's own port serves
 * it; a test reads it there.
 */
export function decodeLedger(data: Uint8Array): Ledger {
  const count = ledgerSeats(data.length);
  if (count === null) {
    throw new Error(
      `${data.length} bytes are not a ledger: it is ${LEDGER_PREFIX} bytes and then whole seats of ${SEAT_LEN}`,
    );
  }
  const reader = new Reader(data);
  const head = readHeader(reader);
  if (head.tag !== ACCOUNT_TAG.ledger) {
    throw new Error(`expected a ${JSON.stringify(ACCOUNT_TAG.ledger)} account`);
  }
  reader.seek(HEADER_LEN);
  const openSeats = reader.u32();
  const freeHead = reader.u32();
  const seats = Array.from({ length: count }, (_, at) =>
    decodeSeat(data, LEDGER_PREFIX + at * SEAT_LEN),
  );
  return { header: head, openSeats, freeHead, seats };
}

/**
 * The seats on the free list, in the order a deposit takes them. Stops at a
 * repeat or an index outside the ledger, which a sound ledger never has.
 */
export function freeSeats(ledger: Ledger): number[] {
  const order: number[] = [];
  const seen = new Set<number>();
  for (
    let next = ledger.freeHead;
    next !== 0 && next <= ledger.seats.length && !seen.has(next);
    next = ledger.seats[next - 1].nextFree
  ) {
    seen.add(next);
    order.push(next - 1);
  }
  return order;
}

function layoutStateOf(word: number): ExchangeLayoutState {
  if (word === EXCHANGE_LAYOUT) return "live";
  if (word === EXCHANGE_LAYOUT_RELAYOUT) return "relayout";
  return "unmigrated";
}

/** The exchange's seat capacity, or an error that says which step of the migration it is waiting for. */
export function liveSeatCapacity(exchange: Exchange): number {
  if (exchange.seatCapacity !== null) return exchange.seatCapacity;
  throw new Error(
    exchange.layoutState === "relayout"
      ? `the exchange is copying its ledger (${exchange.relayoutNext} seats so far): finish the relayout first`
      : "the exchange has not been migrated: run migrate_exchange first",
  );
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
  const capacityWord = reader.u32();
  const layout = reader.u32();
  const minSeatDeposit = reader.u64();
  const relayoutWord = reader.u32();
  reader.skip(12);
  const layoutState = layoutStateOf(layout);
  const seatCapacity = layoutState === "live" ? capacityWord : null;
  const relayoutNext = layoutState === "relayout" ? relayoutWord : 0;
  const tokens = registered.map((token, index) => ({
    ...token,
    custodyVisibility: CUSTODY_VISIBILITIES[(publicCustody >> index) & 1],
  }));
  return {
    quote,
    seatCapacity,
    layout,
    layoutState,
    minSeatDeposit,
    relayoutNext,
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

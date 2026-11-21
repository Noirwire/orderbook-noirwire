import { PublicKey } from "@solana/web3.js";
import {
  ACCOUNT_LEN,
  ACCOUNT_TAG,
  HEADER_LEN,
  MAX_MARKETS,
  MAX_SEATS,
  LEDGER_PREFIX,
  MAX_OPEN_ORDERS,
  NO_SEAT,
  ORDER_KEYS,
  ORDER_RESULT_LEN,
  RESULTS,
  SEAT_LEN,
  SEAT_SLOTS,
  SNAPSHOT_LAYOUT_IDENTITY,
  SNAPSHOT_LAYOUT_SLOTS,
  SNAPSHOT_SEAT_RESERVE,
  LAYOUT_SCAN_VERSION,
  ledgerSeats,
  MARKET_RESERVED_AT,
  MARKET_RESERVED_LEN,
  TAPE_FILLS,
  TAPE_FILL_LEN,
  TOKENS,
  TRIGGER_BOOK_VERSION,
  TRIGGER_FLAG,
  TRIGGER_STATUS,
  TRIGGER_STATUS_TAG,
  TRIGGER_TAG,
  triggerAccountLen,
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
  publishTime: bigint;
  /** `rawPrice` in quote atoms per lot. */
  target: bigint;
  /** The rollup time it was read. */
  observedAt: bigint;
};

/** RULES 9: the MagicBlock price account a market reads and how its numbers become quote atoms per lot. */
export type SourceBinding = {
  /** The default key on a test network's market that is bound to nothing. */
  account: PublicKey;
  /** MagicBlock's feed number, 0 for a market bound to nothing. */
  feed: number;
  /** Fixed at -8. */
  expo: number;
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
  /**
   * How many positions the slot has ended since the seat's epoch began (24
   * bits). Past `GENERATION_MAX` the seat moves to its next epoch and every
   * slot starts again at zero, so (`Seat.seatEpoch`, `generation`) never
   * repeats. A seat read at layout 1 holds an 8-bit count that stops at 255,
   * and one read at layout 0 has none (0).
   */
  generation: number;
  /** The physical slot (0 to `SEAT_SLOTS - 1`) tagged with the market; null when no slot is tagged with it. */
  slot: number | null;
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
  /**
   * How many positions each physical slot (0 to `SEAT_SLOTS - 1`) has ended
   * in the seat's current epoch, tagged or not. `Position.generation` is the
   * same number for a tagged slot.
   */
  slotGenerations: number[];
  /**
   * Counts the owner's key resets of the seat and the generation rollovers.
   * A trigger set under one epoch never acts under another. 0 in a seat read
   * at a layout before 2.
   */
  seatEpoch: number;
  /** The seat's state: 0 closed, 1 open. */
  status: number;
  /**
   * RULES 3a: bit `m` lists the seat as a maker on market `m` (8 bits from
   * layout 2, 64 before). Sealed in the ledger; the owner reads its own in
   * its view after a sync.
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
  generation: 0,
  slot: null,
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

/**
 * One of the trader's triggers as of the last `sync_view`. `gone` is a record
 * that is missing or no longer belongs to the position; `unfillable` is one
 * whose size is below the market's minimum order, tried again at
 * `nextAttempt` (unix seconds). `nextAttempt` is absent when no fire attempt
 * has been made yet: the minimum was raised past the size after it was set.
 * `blockedByRestingOrders` is one whose last attempt to close was refused for
 * margin the seat's own resting orders hold: the orders are left alone, so
 * cancel one to let the attempt at `nextAttempt` through.
 */
export type TriggerState =
  | { state: "armed" }
  | { state: "gone" }
  | { state: "unfillable"; nextAttempt?: bigint }
  | { state: "blockedByRestingOrders"; nextAttempt?: bigint };

/** The trader's two triggers on one market, as the last `sync_view` found them. */
export type TriggerStatus = {
  marketId: number;
  takeProfit: TriggerState;
  stopLoss: TriggerState;
};

export type SeatSnapshot = {
  seat: Seat;
  /**
   * `SNAPSHOT_LAYOUT_IDENTITY` once the program wrote it with the seat epoch
   * and the 24-bit generations, `SNAPSHOT_LAYOUT_SLOTS` for one written with
   * tagged slots before them, 0 for one written before that.
   */
  layout: number;
  seatIndex: number;
  marketId: number;
  orders: OrderView[];
  /**
   * The status of the trader's triggers on one market as of the last
   * `sync_view`, or null when the snapshot was written by any other call since
   * or the market has no triggers: unknown, so sync again. Null is never
   * "gone".
   */
  triggerStatus: TriggerStatus | null;
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
   * The snapshot was written before the current seat layout (its `layout` is
   * not `SNAPSHOT_LAYOUT_IDENTITY`): call `sync_view` to rewrite it from the
   * seat. It still decodes, and says nothing about whether the seat is held.
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

/** The little-endian u32 of the ASCII bytes "NWX3": what `layout` holds once the exchange is active. */
export const EXCHANGE_LAYOUT = 0x3358574e;

/**
 * The little-endian u32 of the ASCII bytes "NWX2": what `layout` holds on an
 * exchange the earlier build made, until `scan_seat_layout` has read every
 * seat and `activate_layout` has run.
 */
export const EXCHANGE_LAYOUT_PRE_ACTIVATION = 0x3258574e;

/**
 * `preActivation` is NWX2: the seats are the earlier build's, only the
 * migration instructions and a few others run. `live` is NWX3. `unmigrated`
 * is any other word: the bytes are not a seat count.
 */
export type ExchangeLayoutState = "unmigrated" | "preActivation" | "live";

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
  /** The trader seats the ledger can hold, or null unless the exchange is pre-activation or live. */
  seatCapacity: number | null;
  /** The raw layout word; `EXCHANGE_LAYOUT` once live, `EXCHANGE_LAYOUT_PRE_ACTIVATION` before. */
  layout: number;
  layoutState: ExchangeLayoutState;
  /** The collateral atoms a seat-taking deposit must bring; 0 for no minimum. */
  minSeatDeposit: bigint;
  /** RULES 9a: the USDC guard. */
  quote: QuoteGuard;
};

/** RULES 9a: the USDC guard every perp's increases depend on. */
export type QuoteGuard = {
  account: PublicKey;
  /** MagicBlock's feed number, 0 while unbound. */
  feed: number;
  depegBps: number;
  maxAge: bigint;
  price: bigint;
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
    openInterestCap: (reader.skip(8), reader.u64()),
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

/**
 * Whether a market account still holds the earlier build's liquidation age in
 * its reserved parameter bytes. It does until `set_price_source_v2` rebinds the
 * market, and `resume_market` refuses it (`MarketNotRebound`) meanwhile.
 */
export function marketHoldsEarlierBytes(data: Uint8Array): boolean {
  return data
    .subarray(MARKET_RESERVED_AT, MARKET_RESERVED_AT + MARKET_RESERVED_LEN)
    .some((byte) => byte !== 0);
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
    publishTime: (reader.skip(8), reader.i64()),
    target: reader.u64(),
    observedAt: reader.i64(),
  };
  const account = reader.pubkey();
  const feed = reader.u32();
  reader.skip(28);
  const expo = reader.i32();
  reader.skip(2);
  const binding = {
    account,
    feed,
    expo,
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

/** Where the seat's epoch sits, counted from the seat's start. */
const SEAT_EPOCH_AT = 124;
/**
 * The two higher bytes of each slot's generation, least significant first:
 * slot 0 at 113 and 114, slot 1 at 115 and 116, slot 2 at 117 and 118, slot 3
 * at 119 and 121. The lowest byte sits beside the free list link, at 298, 299,
 * 302 and 303.
 */
const GENERATION_EXTENSION_AT = [
  [113, 114],
  [115, 116],
  [117, 118],
  [119, 121],
] as const;

/** The seat layout a ledger holds, from the exchange's layout word: NWX2 holds layout 1 seats, NWX3 layout 2. */
export function seatLayoutOf(exchangeLayout: number): number {
  if (exchangeLayout === EXCHANGE_LAYOUT) return SNAPSHOT_LAYOUT_IDENTITY;
  if (exchangeLayout === EXCHANGE_LAYOUT_PRE_ACTIVATION) {
    return SNAPSHOT_LAYOUT_SLOTS;
  }
  throw new Error(
    `the exchange layout ${exchangeLayout.toString(16)} holds no seat layout this client reads`,
  );
}

/**
 * One seat, `SEAT_LEN` bytes at `offset`, read as `layout` says: a ledger's
 * seats are layout 1 until the exchange is activated and layout 2 after
 * (`seatLayoutOf`), and a view snapshot's own `layout` names its seat's.
 * Layout 0 is the eight-market seat of the oldest snapshots
 * (`LEGACY_SEAT_LEN`). Layouts 0 and 1 read the access lists as 64-bit masks
 * and the generations as bytes; layout 2 reads the lists as one byte each,
 * with the seat epoch and the 24-bit generations. Positions come from the slot
 * tags, so nobody indexes a slot by market: a slot is its market's when it is
 * tagged `market + 1`, empty or not. This is the one function every client
 * reads a seat through.
 */
export function decodeSeat(data: Uint8Array, layout: number, offset = 0): Seat {
  if (layout === 0) return decodeLegacySeat(data, offset);
  if (layout !== SNAPSHOT_LAYOUT_SLOTS && layout !== SNAPSHOT_LAYOUT_IDENTITY) {
    throw new Error(`no seat layout ${layout}`);
  }
  const identity = layout === SNAPSHOT_LAYOUT_IDENTITY;
  const reader = new Reader(data, offset);
  const owner = reader.pubkey();
  const version = reader.u64();
  const collateral = reader.i64();
  const spot = readSpot(reader);
  const makerMarkets = identity ? BigInt(reader.u8()) : reader.u64();
  if (identity) reader.skip(7);
  const takerMarkets = identity ? BigInt(reader.u8()) : reader.u64();
  if (identity) reader.skip(7);
  const slots = Array.from({ length: SEAT_SLOTS }, () => readSlot(reader));
  const tags = Array.from({ length: SEAT_SLOTS }, () => reader.u8());
  const orders = Array.from({ length: SEAT_SLOTS }, () => reader.u8());
  const status = reader.u8();
  const blocked = reader.u8() !== 0;
  const lowBytes = [reader.u8(), reader.u8()];
  const nextFree = reader.u16();
  lowBytes.push(reader.u8(), reader.u8());
  const byteAt = (at: number) => data[offset + at];
  const generations = identity
    ? lowBytes.map(
        (low, slot) =>
          low |
          (byteAt(GENERATION_EXTENSION_AT[slot][0]) << 8) |
          (byteAt(GENERATION_EXTENSION_AT[slot][1]) << 16),
      )
    : lowBytes;
  const seatEpoch = identity
    ? new DataView(
        data.buffer,
        data.byteOffset + offset + SEAT_EPOCH_AT,
        4,
      ).getUint32(0, true)
    : 0;
  const positions = slots.flatMap((slot, at) =>
    tags[at] === 0
      ? []
      : [
          {
            ...slot,
            marketId: tags[at] - 1,
            openOrders: orders[at],
            generation: generations[at],
            slot: at,
          },
        ],
  );
  return {
    owner,
    version,
    collateral,
    spot,
    positions,
    slotGenerations: generations,
    seatEpoch,
    status,
    makerMarkets,
    takerMarkets,
    blocked,
    nextFree,
  };
}

/**
 * One seat of the layout a view snapshot held before tagged slots,
 * `LEGACY_SEAT_LEN` bytes at `offset`: a slot for each of the eight markets.
 * Only a view that was not synced since still carries one. A market with
 * nothing on it is left out, as a slot nobody tagged.
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
    return used
      ? [{ ...slot, marketId, openOrders, generation: 0, slot: marketId }]
      : [];
  });
  return {
    owner,
    version,
    collateral,
    spot,
    positions,
    slotGenerations: Array.from({ length: SEAT_SLOTS }, () => 0),
    seatEpoch: 0,
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
  const known =
    layout === SNAPSHOT_LAYOUT_SLOTS || layout === SNAPSHOT_LAYOUT_IDENTITY;
  const seatCopy = decodeSeat(reader.data, known ? layout : 0, start);
  const triggerStatus = known
    ? triggerStatusIn(reader.seek(start + SEAT_LEN))
    : null;
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
  return { seat: seatCopy, layout, seatIndex, marketId, orders, triggerStatus };
}

function triggerState(code: number, nextAttempt: bigint): TriggerState | null {
  switch (code) {
    case TRIGGER_STATUS.gone:
      return { state: "gone" };
    case TRIGGER_STATUS.armed:
      return { state: "armed" };
    case TRIGGER_STATUS.unfillable:
      return nextAttempt === 0n
        ? { state: "unfillable" }
        : { state: "unfillable", nextAttempt };
    case TRIGGER_STATUS.blockedByRestingOrders:
      return nextAttempt === 0n
        ? { state: "blockedByRestingOrders" }
        : { state: "blockedByRestingOrders", nextAttempt };
    default:
      return null;
  }
}

/** The status block at the start of the snapshot's reserve, or null when it is unwritten or not one this client knows. */
function triggerStatusIn(reader: Reader): TriggerStatus | null {
  if (reader.u8() !== TRIGGER_STATUS_TAG) return null;
  const marketId = reader.u8();
  const takeProfitCode = reader.u8();
  const stopLossCode = reader.u8();
  reader.skip(4);
  const takeProfit = triggerState(takeProfitCode, reader.i64());
  const stopLoss = triggerState(stopLossCode, reader.i64());
  return takeProfit && stopLoss ? { marketId, takeProfit, stopLoss } : null;
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
    snapshotOld: snapshot.layout !== SNAPSHOT_LAYOUT_IDENTITY,
    ownerNonce,
    resultsWritten: Number(written),
    results,
    snapshot,
    used,
  };
}

/**
 * The whole ledger, sized from its length, its seats read as the exchange's
 * layout word says (`seatLayoutOf`). Only the rollup's own port serves it; a
 * test reads it there.
 */
export function decodeLedger(data: Uint8Array, exchangeLayout: number): Ledger {
  const layout = seatLayoutOf(exchangeLayout);
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
    decodeSeat(data, layout, LEDGER_PREFIX + at * SEAT_LEN),
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
  if (word === EXCHANGE_LAYOUT_PRE_ACTIVATION) return "preActivation";
  return "unmigrated";
}

/**
 * The exchange's seat capacity, or an error when the exchange does not carry
 * a layout with one (`preActivation` and `live` do).
 */
export function liveSeatCapacity(exchange: Exchange): number {
  if (exchange.seatCapacity !== null) return exchange.seatCapacity;
  throw new Error("the exchange does not have the current layout");
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
  const quoteAccount = reader.pubkey();
  const quoteFeed = reader.u32();
  reader.skip(34);
  const quote = {
    account: quoteAccount,
    feed: quoteFeed,
    depegBps: reader.u16(),
    maxAge: reader.i64(),
    price: reader.i64(),
    publishTime: (reader.skip(8), reader.i64()),
    okUntil: reader.i64(),
    state: reader.u8(),
  };
  const capacityWord = reader.u32();
  const layout = reader.u32();
  const minSeatDeposit = reader.u64();
  reader.skip(16);
  const layoutState = layoutStateOf(layout);
  const seatCapacity = layoutState === "unmigrated" ? null : capacityWord;
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

/** Every perp market the exchange has, by rising id: the set bits of its `perpMarkets` mask. */
export function perpMarketIdsOf({
  perpMarkets,
}: Pick<Exchange, "perpMarkets">): number[] {
  return Array.from({ length: MAX_MARKETS }, (_, id) => id).filter(
    (id) => (perpMarkets >> id) & 1,
  );
}

/** The header alone, whatever the account is and whether or not it is ready. */
export function decodeHeader(data: Uint8Array): Header {
  return readHeader(new Reader(data));
}

/**
 * How far `scan_seat_layout` has read the ledger: the seats before `cursor`
 * hold the bytes the active layout expects, and `capacity` is the ledger's
 * seat capacity when the scan started. `activate_layout` runs only once
 * `cursor` equals the ledger's capacity as it stands.
 */
export type LayoutScan = {
  header: Header;
  version: number;
  cursor: number;
  capacity: number;
};

export function decodeLayoutScan(data: Uint8Array): LayoutScan {
  const reader = new Reader(data);
  const head = header(reader, ACCOUNT_TAG.layoutScan, ACCOUNT_LEN.layoutScan);
  const version = reader.u32();
  if (version !== LAYOUT_SCAN_VERSION) {
    throw new Error(
      `the layout scan is version ${version}, not ${LAYOUT_SCAN_VERSION}`,
    );
  }
  const cursor = reader.u32();
  const capacity = reader.u32();
  return { header: head, version, cursor, capacity };
}

/** One take-profit or stop-loss as a trigger book keeps it. */
export type TriggerRecord = {
  triggerPrice: bigint;
  /** The worst price of the reduce-only market order the record places. */
  worstPrice: bigint;
  /** Lots of a fixed-size record; meaningless while `wholePosition`. */
  size: bigint;
  /** Unix seconds after which the record is dropped; 0 for never. */
  expiry: bigint;
  /** The earliest time of the next attempt; 0 for now. */
  nextAttempt: bigint;
  /** The seat's epoch the record was set under. */
  seatEpoch: number;
  /** The seat's position generation (24 bits) the record was set on. */
  generation: number;
  /** Changes whenever the record is set, re-armed or dropped. */
  recordVersion: number;
  /** The record's place in its heap. */
  heapPosition: number;
  sequence: number;
  /** `TRIGGER_FLAG` bits, as stored. */
  flags: number;
  /** The seat's position slot the record was set on. */
  perpSlot: number;
  /** Zero for a record in no heap, otherwise the heap's index plus one. */
  heap: number;
  /** The secret the trader drew when setting the record; all zero once it is dropped or cancelled. */
  secret: Uint8Array;
  active: boolean;
  /** Fires when the mark is at or below `triggerPrice`, and above it when false. */
  firesBelow: boolean;
  wholePosition: boolean;
  /** The position was long when the record was set, so the record closes by selling. */
  long: boolean;
  /** The last attempt placed nothing for want of size. */
  unfillable: boolean;
  /** The last attempt was refused for margin the seat's own resting orders hold. */
  blockedByRestingOrders: boolean;
};

/** `TRIGGER_RECORD_LEN` bytes from the reader's place, read as the book's record. */
export function decodeTriggerRecord(reader: Reader): TriggerRecord {
  const record = {
    triggerPrice: reader.u64(),
    worstPrice: reader.u64(),
    size: reader.u64(),
    expiry: reader.i64(),
    nextAttempt: reader.i64(),
    seatEpoch: reader.u32(),
    generation: reader.u32(),
    recordVersion: reader.u32(),
    heapPosition: reader.u32(),
    sequence: reader.u32(),
    flags: reader.u8(),
    perpSlot: reader.u8(),
    heap: reader.u8(),
    secret: (reader.skip(1), reader.bytes(SECRET_LEN)),
  };
  return {
    ...record,
    active: (record.flags & TRIGGER_FLAG.active) !== 0,
    firesBelow: (record.flags & TRIGGER_FLAG.firesBelow) !== 0,
    wholePosition: (record.flags & TRIGGER_FLAG.wholePosition) !== 0,
    long: (record.flags & TRIGGER_FLAG.long) !== 0,
    unfillable: (record.flags & TRIGGER_FLAG.unfillable) !== 0,
    blockedByRestingOrders:
      (record.flags & TRIGGER_FLAG.blockedByRestingOrders) !== 0,
  };
}

/** What a trigger book keeps before its first slot (the engine's header). */
export type TriggerBookHeader = {
  header: Header;
  /** `TRIGGER_BOOK_VERSION` in a book this client reads. */
  version: number;
  /** The market the engine's book is for. */
  bookMarketId: number;
  /** The seats the book holds, one slot each. A perp market's is `MAX_SEATS`, whatever the ledger holds. */
  seatCapacity: number;
  /** Entries in the above, below and time heaps. */
  heapLen: number[];
  nextSequence: number;
  /** The next seat a `sweep_triggers` call reads: where the sweep will resume. */
  sweepCursor: number;
  fairCursor: number;
  /** The account's length, which `triggerAccountLen(seatCapacity)` must equal. */
  length: number;
};

/**
 * The header of a trigger book: the account header and the engine's, which
 * need only the first `HEADER_LEN + TRIGGER_BOOK_HEADER_LEN` bytes. `length`
 * is the full account's length, which the caller knows from the read.
 * Whether the book is one the program accepts is `triggerBookIsCurrent`.
 */
export function decodeTriggerBookHeader(
  data: Uint8Array,
  length: number = data.length,
): TriggerBookHeader {
  const reader = new Reader(data);
  const head = readHeader(reader);
  if (head.tag !== TRIGGER_TAG) {
    throw new Error(`expected a ${JSON.stringify(TRIGGER_TAG)} account`);
  }
  reader.seek(HEADER_LEN);
  const version = reader.u32();
  const bookMarketId = reader.u32();
  const seatCapacity = reader.u32();
  const heapLen = [reader.u32(), reader.u32(), reader.u32()];
  const nextSequence = reader.u32();
  const sweepCursor = reader.u32();
  const fairCursor = reader.u32();
  return {
    header: head,
    version,
    bookMarketId,
    seatCapacity,
    heapLen,
    nextSequence,
    sweepCursor,
    fairCursor,
    length,
  };
}

/**
 * Whether a perp market's trigger book is one the program accepts: the
 * current version, sized for `MAX_SEATS` seats whatever the ledger holds, and
 * exactly the length that capacity gives.
 */
export function triggerBookIsCurrent(
  book: Pick<TriggerBookHeader, "version" | "seatCapacity" | "length">,
): boolean {
  return (
    book.version === TRIGGER_BOOK_VERSION &&
    book.seatCapacity === MAX_SEATS &&
    book.length === triggerAccountLen(MAX_SEATS)
  );
}

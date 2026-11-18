/**
 * A market's trigger book as a test reads it through the rollup's own port.
 * The account is sealed, so no client can read one and the SDK does not
 * decode it.
 */
import { PublicKey } from "@solana/web3.js";
import {
  HEADER_LEN,
  Reader,
  TRIGGER_BOOK_HEADER_LEN,
  TRIGGER_FLAG,
  TRIGGER_TAG,
  triggerAccountLen,
  type Header,
} from "../sdk/dist/index.js";

const TAG_LEN = 8;
const SECRET_LEN = 16;
const OWNER_LEN = 32;

/** One take-profit or stop-loss as a trigger book keeps it. */
export type TriggerRecord = {
  triggerPrice: bigint;
  /** The worst price of the reduce-only market order the record places. */
  worstPrice: bigint;
  /** Lots of a fixed-size record; meaningless while `wholePosition`. */
  size: bigint;
  /** The `clientOrderId` of the `set_trigger` call. */
  clientId: bigint;
  /** Unix seconds after which the record is dropped; 0 for never. */
  expiry: bigint;
  /** The earliest time of the next attempt; 0 for now. */
  nextAttempt: bigint;
  /** Changes whenever the record is set, re-armed or dropped. */
  recordVersion: number;
  /** The record's place in its heap. */
  heapPosition: number;
  /** `TRIGGER_FLAG` bits, as stored. */
  flags: number;
  /** The seat's position generation the record was set on. */
  generation: number;
  /** The seat's position slot the record was set on. */
  perpSlot: number;
  /** Zero for a record in no heap, otherwise the heap's index plus one. */
  heap: number;
  sequence: number;
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
};

/** A seat's place in a trigger book: its owner and its two records. */
export type TriggerSlot = {
  /** Null while no record ever named the slot. */
  owner: PublicKey | null;
  takeProfit: TriggerRecord;
  stopLoss: TriggerRecord;
};

export type TriggerBook = {
  header: Header;
  version: number;
  /** The market the engine's book is for. */
  bookMarketId: number;
  /** The seats the book holds, one slot each; 0 for a spot market's. */
  seatCapacity: number;
  /** Entries in the above, below and time heaps. */
  heapLen: number[];
  nextSequence: number;
  sweepCursor: number;
  fairCursor: number;
  /** One per seat, by seat index. */
  slots: TriggerSlot[];
};

function triggerRecord(reader: Reader): TriggerRecord {
  const record = {
    triggerPrice: reader.u64(),
    worstPrice: reader.u64(),
    size: reader.u64(),
    clientId: reader.u64(),
    expiry: reader.i64(),
    nextAttempt: reader.i64(),
    recordVersion: reader.u32(),
    heapPosition: reader.u32(),
    flags: reader.u8(),
    generation: reader.u8(),
    perpSlot: reader.u8(),
    heap: reader.u8(),
    sequence: reader.u32(),
    secret: reader.bytes(SECRET_LEN),
  };
  return {
    ...record,
    active: (record.flags & TRIGGER_FLAG.active) !== 0,
    firesBelow: (record.flags & TRIGGER_FLAG.firesBelow) !== 0,
    wholePosition: (record.flags & TRIGGER_FLAG.wholePosition) !== 0,
    long: (record.flags & TRIGGER_FLAG.long) !== 0,
    unfillable: (record.flags & TRIGGER_FLAG.unfillable) !== 0,
  };
}

/**
 * A market's trigger book as the program lays it out: the account header, the
 * engine's header and one slot per seat. The three heaps that follow the
 * slots only index them and are not read.
 */
export function decodeTriggerBook(data: Uint8Array): TriggerBook {
  const reader = new Reader(data);
  const tag = new TextDecoder().decode(reader.bytes(TAG_LEN));
  const header: Header = {
    tag,
    ready: reader.bool(),
    marketId: reader.u8(),
    bump: reader.u8(),
  };
  if (header.tag !== TRIGGER_TAG) {
    throw new Error(`expected a ${JSON.stringify(TRIGGER_TAG)} account`);
  }
  reader.seek(HEADER_LEN);
  const version = reader.u32();
  const bookMarketId = reader.u32();
  const seatCapacity = reader.u32();
  const length = triggerAccountLen(seatCapacity);
  if (data.length !== length) {
    throw new Error(
      `expected ${length} bytes of account data, got ${data.length}`,
    );
  }
  const heapLen = [reader.u32(), reader.u32(), reader.u32()];
  const nextSequence = reader.u32();
  const sweepCursor = reader.u32();
  const fairCursor = reader.u32();
  reader.seek(HEADER_LEN + TRIGGER_BOOK_HEADER_LEN);
  const slots = Array.from({ length: seatCapacity }, (): TriggerSlot => {
    const owner = reader.bytes(OWNER_LEN);
    return {
      owner: owner.some((byte) => byte !== 0) ? new PublicKey(owner) : null,
      takeProfit: triggerRecord(reader),
      stopLoss: triggerRecord(reader),
    };
  });
  return {
    header,
    version,
    bookMarketId,
    seatCapacity,
    heapLen,
    nextSequence,
    sweepCursor,
    fairCursor,
    slots,
  };
}

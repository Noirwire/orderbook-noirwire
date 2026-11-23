/**
 * A market's trigger book as a test reads it through the rollup's own port.
 * The account is sealed, so no client can read one; the SDK decodes its
 * header and a record, and this reads every slot with them.
 */
import { PublicKey } from "@solana/web3.js";
import {
  HEADER_LEN,
  Reader,
  TRIGGER_BOOK_HEADER_LEN,
  decodeTriggerBookHeader,
  decodeTriggerRecord,
  triggerAccountLen,
  type Header,
  type TriggerRecord,
} from "../sdk/dist/index.js";

const OWNER_LEN = 32;

export type { TriggerRecord };

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

/**
 * A market's trigger book as the program lays it out: the account header, the
 * engine's header and one slot per seat. The three heaps that follow the
 * slots only index them and are not read.
 */
export function decodeTriggerBook(data: Uint8Array): TriggerBook {
  const head = decodeTriggerBookHeader(data);
  const length = triggerAccountLen(head.seatCapacity);
  if (data.length !== length) {
    throw new Error(
      `expected ${length} bytes of account data, got ${data.length}`,
    );
  }
  const reader = new Reader(data);
  reader.seek(HEADER_LEN + TRIGGER_BOOK_HEADER_LEN);
  const slots = Array.from({ length: head.seatCapacity }, (): TriggerSlot => {
    const owner = reader.bytes(OWNER_LEN);
    return {
      owner: owner.some((byte) => byte !== 0) ? new PublicKey(owner) : null,
      takeProfit: decodeTriggerRecord(reader),
      stopLoss: decodeTriggerRecord(reader),
    };
  });
  return {
    header: head.header,
    version: head.version,
    bookMarketId: head.bookMarketId,
    seatCapacity: head.seatCapacity,
    heapLen: head.heapLen,
    nextSequence: head.nextSequence,
    sweepCursor: head.sweepCursor,
    fairCursor: head.fairCursor,
    slots,
  };
}

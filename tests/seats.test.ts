import { expect } from "chai";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  ACCOUNT_LEN,
  ACCOUNT_TAG,
  EXCHANGE_LAYOUT,
  EXCHANGE_LAYOUT_PRE_ACTIVATION,
  EXTEND_SEATS_PER_CALL,
  GROWTH_STEP,
  Instructions,
  LEDGER_PREFIX,
  LEGACY_SEAT_LEN,
  MARKET_KIND,
  MAX_SEATS,
  MIN_SEATS,
  NO_SEAT,
  NotSeated,
  PERP_TRIGGER_BOOK_LEN,
  PROGRAM_ID,
  RECONCILE_SEATS_PER_CALL,
  RESULT_KIND,
  SEAT_LEN,
  SEAT_SLOTS,
  SEAT_SNAPSHOT_LEN,
  SNAPSHOT_LAYOUT_IDENTITY,
  SNAPSHOT_LAYOUT_SLOTS,
  TransactionFailed,
  Writer,
  decodeExchange,
  decodeLedger,
  decodeLegacySeat,
  decodeSeat,
  decodeView,
  discriminator,
  extendLedgerTo,
  freeSeats,
  ledgerLen,
  ledgerSeats,
  liveSeatCapacity,
  positionOn,
  seatDepositRefusal,
  seatLayoutOf,
  setupTriggerBook,
  transactionFailure,
  triggerAccountLen,
} from "../sdk/dist/index.js";
import { errorCode } from "./idl";

const key = (fill: number) => new PublicKey(new Uint8Array(32).fill(fill));
const OWNER = key(21);

type SlotFields = {
  tag: number;
  base?: bigint;
  quote?: bigint;
  checkpoint?: bigint;
  bids?: bigint;
  asks?: bigint;
  orders?: number;
};

type SeatFields = {
  collateral?: bigint;
  version?: bigint;
  maker?: bigint;
  taker?: bigint;
  slots?: SlotFields[];
  status?: number;
  blocked?: boolean;
  nextFree?: number;
  /** Layout 2 only: the seat epoch. */
  epoch?: number;
  /** Layout 2 only: each slot's 24-bit generation; layout 1 has bytes 7 to 10. */
  generations?: number[];
};

/**
 * A seat as the ledger lays it out: 304 bytes, four tagged slots. At layout 1
 * (`SNAPSHOT_LAYOUT_SLOTS`) the access lists are two 64-bit masks and the
 * generations are the bytes 7 to 10; at layout 2 (`SNAPSHOT_LAYOUT_IDENTITY`)
 * the lists are the bytes at 112 and 120, the generations' higher bytes sit in
 * 113 to 119 and 121, the epoch at 124 and the lowest bytes at 298, 299, 302
 * and 303.
 */
function seatBytes(
  fields: SeatFields = {},
  layout: number = SNAPSHOT_LAYOUT_SLOTS,
): Uint8Array {
  if (layout === SNAPSHOT_LAYOUT_IDENTITY) return identitySeatBytes(fields);
  const slots = Array.from(
    { length: SEAT_SLOTS },
    (_, at) => fields.slots?.[at] ?? { tag: 0 },
  );
  const writer = new Writer()
    .pubkey(OWNER)
    .u64(fields.version ?? 1n)
    .i64(fields.collateral ?? 0n);
  for (let token = 0; token < 4; token += 1) {
    writer.u64(BigInt(token + 1) * 10n).u64(BigInt(token));
  }
  writer.u64(fields.maker ?? 0n).u64(fields.taker ?? 0n);
  for (const slot of slots) {
    writer
      .i64(slot.base ?? 0n)
      .i64(slot.quote ?? 0n)
      .i64(slot.checkpoint ?? 0n)
      .u64(slot.bids ?? 0n)
      .u64(slot.asks ?? 0n);
  }
  for (const slot of slots) writer.u8(slot.tag);
  for (const slot of slots) writer.u8(slot.orders ?? 0);
  writer
    .u8(fields.status ?? 1)
    .u8(fields.blocked ? 1 : 0)
    .bytes(new Uint8Array([7, 8]))
    .u16(fields.nextFree ?? 0)
    .bytes(new Uint8Array([9, 10]));
  const bytes = writer.build();
  expect(bytes.length).to.equal(SEAT_LEN);
  return bytes;
}

/** The seat at layout 2, written byte by byte at the offsets the program asserts. */
function identitySeatBytes(fields: SeatFields): Uint8Array {
  const bytes = new Uint8Array(SEAT_LEN);
  const view = new DataView(bytes.buffer);
  bytes.set(OWNER.toBytes(), 0);
  view.setBigUint64(32, fields.version ?? 1n, true);
  view.setBigInt64(40, fields.collateral ?? 0n, true);
  for (let token = 0; token < 4; token += 1) {
    view.setBigUint64(48 + token * 16, BigInt(token + 1) * 10n, true);
    view.setBigUint64(56 + token * 16, BigInt(token), true);
  }
  bytes[112] = Number(fields.maker ?? 0n);
  bytes[120] = Number(fields.taker ?? 0n);
  view.setUint32(124, fields.epoch ?? 0, true);
  const slots = Array.from(
    { length: SEAT_SLOTS },
    (_, at) => fields.slots?.[at] ?? { tag: 0 },
  );
  slots.forEach((slot, at) => {
    const first = 128 + at * 40;
    view.setBigInt64(first, slot.base ?? 0n, true);
    view.setBigInt64(first + 8, slot.quote ?? 0n, true);
    view.setBigInt64(first + 16, slot.checkpoint ?? 0n, true);
    view.setBigUint64(first + 24, slot.bids ?? 0n, true);
    view.setBigUint64(first + 32, slot.asks ?? 0n, true);
    bytes[288 + at] = slot.tag;
    bytes[292 + at] = slot.orders ?? 0;
  });
  bytes[296] = fields.status ?? 1;
  bytes[297] = fields.blocked ? 1 : 0;
  const generations = fields.generations ?? [0, 0, 0, 0];
  const lowAt = [298, 299, 302, 303];
  const extensionAt = [
    [113, 114],
    [115, 116],
    [117, 118],
    [119, 121],
  ];
  generations.forEach((generation, slot) => {
    bytes[lowAt[slot]] = generation & 0xff;
    bytes[extensionAt[slot][0]] = (generation >> 8) & 0xff;
    bytes[extensionAt[slot][1]] = (generation >> 16) & 0xff;
  });
  view.setUint16(300, fields.nextFree ?? 0, true);
  return bytes;
}

/** A seat as the first ledger laid it out: 448 bytes, a slot for each of eight markets. */
function legacySeatBytes(
  held: Record<number, { base: bigint; orders?: number }>,
): Uint8Array {
  const writer = new Writer().pubkey(OWNER).u64(7n).i64(500n);
  for (let token = 0; token < 4; token += 1) writer.u64(0n).u64(0n);
  for (let market = 0; market < 8; market += 1) {
    writer
      .i64(held[market]?.base ?? 0n)
      .i64(0n)
      .i64(0n)
      .u64(0n)
      .u64(0n);
  }
  for (let market = 0; market < 8; market += 1) {
    writer.u8(held[market]?.orders ?? 0);
  }
  writer.u8(1).u8(0b101).u8(0b11).u8(0).bytes(new Uint8Array(4));
  const bytes = writer.build();
  expect(bytes.length).to.equal(LEGACY_SEAT_LEN);
  return bytes;
}

function header(tag: string): Uint8Array {
  return new Writer()
    .fixed(tag, 8)
    .u8(1)
    .u8(0)
    .u8(255)
    .bytes(new Uint8Array(5))
    .build();
}

/** The trigger status block the program lays at the start of a snapshot's reserve. */
function statusBlock(fields: {
  tag: number;
  market: number;
  takeProfit: number;
  stopLoss: number;
  retry?: bigint;
}): Uint8Array {
  return new Writer()
    .u8(fields.tag)
    .u8(fields.market)
    .u8(fields.takeProfit)
    .u8(fields.stopLoss)
    .bytes(new Uint8Array(4))
    .i64(0n)
    .i64(fields.retry ?? 0n)
    .build();
}

/** A view whose snapshot holds `seat` in the layout `layout` names. */
function viewBytes(
  seatIndex: number,
  snapshotSeat: Uint8Array,
  layout: number,
  used = 1n,
  reserve: Uint8Array = new Uint8Array(0),
): Uint8Array {
  const writer = new Writer()
    .bytes(header(ACCOUNT_TAG.view))
    .pubkey(OWNER)
    .pubkey(key(1))
    .pubkey(key(2))
    .pubkey(key(3))
    .pubkey(key(4))
    .u32(seatIndex)
    .u32(5)
    .u64(0n)
    .bytes(new Uint8Array(1024));
  const padded = new Uint8Array(SEAT_LEN + 144);
  const legacy = snapshotSeat.length === LEGACY_SEAT_LEN;
  const seatArea = legacy ? new Uint8Array(448) : padded;
  seatArea.set(snapshotSeat);
  if (!legacy) seatArea.set(reserve, SEAT_LEN);
  writer
    .bytes(seatArea)
    .u32(seatIndex === NO_SEAT ? 0 : seatIndex)
    .u32(0)
    .u8(0)
    .u8(layout)
    .bytes(new Uint8Array(6))
    .bytes(new Uint8Array(SEAT_SNAPSHOT_LEN - 448 - 16))
    .u64(used);
  const bytes = writer.build();
  expect(bytes.length).to.equal(ACCOUNT_LEN.view);
  return bytes;
}

function ledgerBytes(
  seats: Uint8Array[],
  openSeats: number,
  freeHead: number,
): Uint8Array {
  const out = new Uint8Array(ledgerLen(seats.length));
  out.set(header(ACCOUNT_TAG.ledger));
  const prefix = new DataView(out.buffer);
  prefix.setUint32(16, openSeats, true);
  prefix.setUint32(20, freeHead, true);
  seats.forEach((seat, at) => out.set(seat, LEDGER_PREFIX + at * SEAT_LEN));
  return out;
}

describe("the seat layout", () => {
  it("has the sizes the program is built with", () => {
    expect(SEAT_LEN).to.equal(304);
    expect(SEAT_SLOTS).to.equal(4);
    expect(LEDGER_PREFIX).to.equal(48);
    expect(ledgerLen(MIN_SEATS)).to.equal(622_640);
    expect(ACCOUNT_LEN.ledger).to.equal(622_640);
    expect(ledgerLen(8_192)).to.equal(2_490_416);
    expect(ledgerLen(MAX_SEATS)).to.equal(10_485_616);
    expect(ledgerLen(MAX_SEATS + 1)).to.be.greaterThan(10_485_760);
    expect(EXTEND_SEATS_PER_CALL * SEAT_LEN).to.be.at.most(10_240);
    expect((EXTEND_SEATS_PER_CALL + 1) * SEAT_LEN).to.be.greaterThan(10_240);
    expect(RECONCILE_SEATS_PER_CALL).to.equal(8_192);
    expect(ledgerLen(12_288)).to.equal(3_735_600);
    expect(SEAT_SNAPSHOT_LEN).to.equal(2_512);
    expect(ACCOUNT_LEN.view).to.equal(3_736);
    expect(NO_SEAT).to.equal(0xffff_ffff);
  });

  it("counts the seats of a ledger from its length, and only whole ones", () => {
    expect(ledgerSeats(ledgerLen(2_048))).to.equal(2_048);
    expect(ledgerSeats(ledgerLen(2_081))).to.equal(2_081);
    expect(ledgerSeats(LEDGER_PREFIX)).to.equal(0);
    expect(ledgerSeats(ledgerLen(5) + 1)).to.equal(null);
    expect(ledgerSeats(LEDGER_PREFIX - 1)).to.equal(null);
  });
});

describe("decodeSeat", () => {
  it("reads a 304-byte seat and keys its positions by the market each slot is tagged with", () => {
    const seat = decodeSeat(
      seatBytes({
        collateral: -250n,
        version: 9n,
        maker: (1n << 63n) | 0b100n,
        taker: 1n << 40n,
        blocked: true,
        slots: [
          {
            tag: 6,
            base: -40n,
            quote: 4_000n,
            checkpoint: 3n,
            asks: 5n,
            orders: 2,
          },
          { tag: 0 },
          { tag: 3, base: 0n, orders: 0 },
          { tag: 1, base: 12n, bids: 7n, orders: 1 },
        ],
      }),
      SNAPSHOT_LAYOUT_SLOTS,
    );
    expect(seat.owner.equals(OWNER)).to.equal(true);
    expect(seat.version).to.equal(9n);
    expect(seat.collateral).to.equal(-250n);
    expect(seat.spot[2]).to.deep.equal({ available: 30n, locked: 2n });
    expect(seat.makerMarkets).to.equal((1n << 63n) | 0b100n);
    expect(seat.takerMarkets).to.equal(1n << 40n);
    expect(seat.blocked).to.equal(true);
    expect(seat.status).to.equal(1);
    expect(seat.positions.map(({ marketId }) => marketId)).to.deep.equal([
      5, 2, 0,
    ]);
    expect(positionOn(seat, 5)).to.include({
      base: -40n,
      quote: 4_000n,
      fundingCheckpoint: 3n,
      openAskLots: 5n,
      openOrders: 2,
    });
    expect(positionOn(seat, 0)).to.include({
      base: 12n,
      openBidLots: 7n,
      openOrders: 1,
    });
  });

  it("reads a market with no slot as flat with no orders, and keeps an empty tagged slot", () => {
    const seat = decodeSeat(
      seatBytes({ slots: [{ tag: 4 }] }),
      SNAPSHOT_LAYOUT_SLOTS,
    );
    expect(seat.positions).to.have.length(1);
    expect(positionOn(seat, 4).base).to.equal(0n);
    const flat = positionOn(seat, 7);
    expect(flat).to.deep.equal({
      marketId: 7,
      base: 0n,
      quote: 0n,
      fundingCheckpoint: 0n,
      openBidLots: 0n,
      openAskLots: 0n,
      openOrders: 0,
      generation: 0,
      slot: null,
    });
    expect(positionOn(seat, 3).slot, "tag 4 is market 3's").to.equal(0);
  });

  it("reads each slot's generation from the bytes either side of the free list link", () => {
    const seat = decodeSeat(
      seatBytes({
        slots: [{ tag: 5 }, { tag: 0 }, { tag: 6 }, { tag: 3 }],
      }),
      SNAPSHOT_LAYOUT_SLOTS,
    );
    expect(positionOn(seat, 4).generation).to.equal(7);
    expect(positionOn(seat, 5).generation).to.equal(9);
    expect(positionOn(seat, 2).generation).to.equal(10);
  });

  it("lists the generation of every physical slot, an untagged one included", () => {
    const seat = decodeSeat(
      seatBytes({ slots: [{ tag: 5 }, { tag: 0 }, { tag: 0 }, { tag: 3 }] }),
      SNAPSHOT_LAYOUT_SLOTS,
    );
    expect(seat.slotGenerations).to.deep.equal([7, 8, 9, 10]);
    expect(seat.positions).to.have.length(2);
  });

  it("gives an old seat no generations, since it never had any", () => {
    const seat = decodeLegacySeat(legacySeatBytes({ 1: { base: 1n } }));
    expect(seat.slotGenerations).to.deep.equal([0, 0, 0, 0]);
  });

  it("reads the free list link of a closed seat", () => {
    const closed = decodeSeat(
      seatBytes({ status: 0, nextFree: 41 }),
      SNAPSHOT_LAYOUT_SLOTS,
    );
    expect(closed.status).to.equal(0);
    expect(closed.nextFree).to.equal(41);
    expect(closed.positions).to.deep.equal([]);
  });

  it("reads a seat at an offset inside a larger buffer", () => {
    const first = seatBytes({ collateral: 1n });
    const second = seatBytes({ collateral: 2n });
    const both = new Uint8Array(2 * SEAT_LEN);
    both.set(first);
    both.set(second, SEAT_LEN);
    expect(
      decodeSeat(both, SNAPSHOT_LAYOUT_SLOTS, SEAT_LEN).collateral,
    ).to.equal(2n);
    expect(
      decodeSeat(both, SNAPSHOT_LAYOUT_IDENTITY, SEAT_LEN).collateral,
    ).to.equal(2n);
  });

  it("reads a layout 1 seat's masks as 64 bits and its generations as bytes, with no epoch", () => {
    const seat = decodeSeat(
      seatBytes({ maker: 1n << 63n, taker: 0b101n }),
      SNAPSHOT_LAYOUT_SLOTS,
    );
    expect(seat.makerMarkets).to.equal(1n << 63n);
    expect(seat.takerMarkets).to.equal(0b101n);
    expect(seat.seatEpoch).to.equal(0);
    expect(seat.slotGenerations).to.deep.equal([7, 8, 9, 10]);
  });

  it("reads a layout 2 seat's one-byte lists, its epoch and its 24-bit generations from the bytes the program reuses", () => {
    const seat = decodeSeat(
      seatBytes(
        {
          collateral: -250n,
          version: 9n,
          maker: 0b1000_0100n,
          taker: 0b0100_0001n,
          blocked: true,
          epoch: 4_000_000_001,
          generations: [0x0000_0102, 0x00ff_ffff, 0x0001_0000, 0x0080_0001],
          nextFree: 41,
          slots: [
            { tag: 6, base: -40n, orders: 2 },
            { tag: 0 },
            { tag: 3 },
            { tag: 1, base: 12n },
          ],
        },
        SNAPSHOT_LAYOUT_IDENTITY,
      ),
      SNAPSHOT_LAYOUT_IDENTITY,
    );
    expect(seat.collateral).to.equal(-250n);
    expect(seat.version).to.equal(9n);
    expect(seat.makerMarkets).to.equal(0b1000_0100n);
    expect(seat.takerMarkets).to.equal(0b0100_0001n);
    expect(seat.blocked).to.equal(true);
    expect(seat.seatEpoch).to.equal(4_000_000_001);
    expect(seat.slotGenerations).to.deep.equal([
      0x0000_0102, 0x00ff_ffff, 0x0001_0000, 0x0080_0001,
    ]);
    expect(seat.nextFree, "the link sits between the lowest bytes").to.equal(
      41,
    );
    expect(positionOn(seat, 5)).to.include({
      base: -40n,
      openOrders: 2,
      generation: 0x0000_0102,
      slot: 0,
    });
    expect(positionOn(seat, 0)).to.include({
      base: 12n,
      generation: 0x0080_0001,
      slot: 3,
    });
    expect(positionOn(seat, 2).generation).to.equal(0x0001_0000);
  });

  it("puts each generation byte of layout 2 at its own offset, so no byte of one slot reads as another's", () => {
    for (let slot = 0; slot < SEAT_SLOTS; slot += 1) {
      const generations = [0, 0, 0, 0];
      generations[slot] = 0x00ab_cdef;
      const seat = decodeSeat(
        seatBytes({ generations }, SNAPSHOT_LAYOUT_IDENTITY),
        SNAPSHOT_LAYOUT_IDENTITY,
      );
      expect(seat.slotGenerations, `slot ${slot}`).to.deep.equal(generations);
    }
  });

  it("reads layout 0 through the same call", () => {
    const seat = decodeSeat(legacySeatBytes({ 1: { base: 1n } }), 0);
    expect(positionOn(seat, 1).base).to.equal(1n);
    expect(seat.seatEpoch).to.equal(0);
  });

  it("refuses a layout it does not know", () => {
    expect(() => decodeSeat(seatBytes(), 3)).to.throw(/no seat layout 3/);
  });

  it("reads the same seat the same at layout 1 and layout 2 when it holds no mask above a byte and no generation above one", () => {
    const fields = {
      collateral: 5n,
      maker: 0b11n,
      taker: 0b10n,
      slots: [{ tag: 2, base: 3n }],
      nextFree: 9,
    };
    const one = decodeSeat(seatBytes(fields), SNAPSHOT_LAYOUT_SLOTS);
    const two = decodeSeat(
      seatBytes(fields, SNAPSHOT_LAYOUT_IDENTITY),
      SNAPSHOT_LAYOUT_IDENTITY,
    );
    expect({ ...one, slotGenerations: [], positions: [] }).to.deep.equal({
      ...two,
      slotGenerations: [],
      positions: [],
    });
    expect(positionOn(one, 1).base).to.equal(positionOn(two, 1).base);
  });
});

describe("decodeLegacySeat", () => {
  it("reads a 448-byte seat into the same shape, leaving out the markets with nothing on them", () => {
    const seat = decodeLegacySeat(
      legacySeatBytes({ 0: { base: 5n }, 6: { base: 0n, orders: 3 } }),
    );
    expect(seat.collateral).to.equal(500n);
    expect(seat.makerMarkets).to.equal(0b101n);
    expect(seat.takerMarkets).to.equal(0b11n);
    expect(seat.positions.map(({ marketId }) => marketId)).to.deep.equal([
      0, 6,
    ]);
    expect(positionOn(seat, 6).openOrders).to.equal(3);
    expect(positionOn(seat, 3).base).to.equal(0n);
  });
});

describe("decodeView", () => {
  it("reads a view that records a seat and was written with the current seat layout", () => {
    const view = decodeView(
      viewBytes(
        12,
        seatBytes(
          { collateral: 77n, slots: [{ tag: 3, base: 4n }] },
          SNAPSHOT_LAYOUT_IDENTITY,
        ),
        SNAPSHOT_LAYOUT_IDENTITY,
      ),
    );
    expect(view.seat).to.equal(12);
    expect(view.seatRecorded).to.equal(true);
    expect(view.snapshotOld).to.equal(false);
    expect(view.snapshot.layout).to.equal(2);
    expect(view.snapshot.seat.collateral).to.equal(77n);
    expect(positionOn(view.snapshot.seat, 2).base).to.equal(4n);
    expect(view.used).to.equal(1n);
  });

  it("reads the trigger status a sync laid at the start of the reserve", () => {
    const view = decodeView(
      viewBytes(
        12,
        seatBytes(),
        SNAPSHOT_LAYOUT_SLOTS,
        1n,
        statusBlock({
          tag: 1,
          market: 3,
          takeProfit: 1,
          stopLoss: 2,
          retry: 99n,
        }),
      ),
    );
    expect(view.snapshot.triggerStatus).to.deep.equal({
      marketId: 3,
      takeProfit: { state: "armed" },
      stopLoss: { state: "unfillable", nextAttempt: 99n },
    });
  });

  it("reads an unfillable record with no fire attempt yet without a next attempt", () => {
    const view = decodeView(
      viewBytes(
        12,
        seatBytes(),
        SNAPSHOT_LAYOUT_SLOTS,
        1n,
        statusBlock({ tag: 1, market: 3, takeProfit: 1, stopLoss: 2 }),
      ),
    );
    expect(view.snapshot.triggerStatus).to.deep.equal({
      marketId: 3,
      takeProfit: { state: "armed" },
      stopLoss: { state: "unfillable" },
    });
  });

  it("reads a snapshot written at layout 2 with the epoch and the 24-bit generations, and does not call it old", () => {
    const view = decodeView(
      viewBytes(
        12,
        seatBytes(
          {
            collateral: 88n,
            maker: 0b10n,
            epoch: 7,
            generations: [0x00ab_cdef, 0, 0, 0],
            slots: [{ tag: 3, base: 4n }],
          },
          SNAPSHOT_LAYOUT_IDENTITY,
        ),
        SNAPSHOT_LAYOUT_IDENTITY,
      ),
    );
    expect(view.snapshot.layout).to.equal(2);
    expect(view.snapshotOld).to.equal(false);
    expect(view.snapshot.seat.seatEpoch).to.equal(7);
    expect(view.snapshot.seat.makerMarkets).to.equal(0b10n);
    expect(positionOn(view.snapshot.seat, 2)).to.include({
      base: 4n,
      generation: 0x00ab_cdef,
    });
  });

  it("calls a snapshot written at layout 1 old, and still reads it with its 64-bit masks", () => {
    const view = decodeView(
      viewBytes(12, seatBytes({ maker: 1n << 40n }), SNAPSHOT_LAYOUT_SLOTS),
    );
    expect(view.snapshotOld).to.equal(true);
    expect(view.snapshot.seat.makerMarkets).to.equal(1n << 40n);
  });

  it("reads a record blocked by the seat's own resting orders, with its retry time", () => {
    const view = decodeView(
      viewBytes(
        12,
        seatBytes({}, SNAPSHOT_LAYOUT_IDENTITY),
        SNAPSHOT_LAYOUT_IDENTITY,
        1n,
        statusBlock({
          tag: 1,
          market: 3,
          takeProfit: 1,
          stopLoss: 3,
          retry: 120n,
        }),
      ),
    );
    expect(view.snapshot.triggerStatus).to.deep.equal({
      marketId: 3,
      takeProfit: { state: "armed" },
      stopLoss: { state: "blockedByRestingOrders", nextAttempt: 120n },
    });
  });

  it("reads a record that is gone as gone, and a zero tag as unknown, never as gone", () => {
    const gone = decodeView(
      viewBytes(
        12,
        seatBytes(),
        SNAPSHOT_LAYOUT_SLOTS,
        1n,
        statusBlock({ tag: 1, market: 0, takeProfit: 0, stopLoss: 0 }),
      ),
    );
    expect(gone.snapshot.triggerStatus).to.deep.equal({
      marketId: 0,
      takeProfit: { state: "gone" },
      stopLoss: { state: "gone" },
    });
    const unwritten = decodeView(
      viewBytes(12, seatBytes(), SNAPSHOT_LAYOUT_SLOTS),
    );
    expect(unwritten.snapshot.triggerStatus).to.equal(null);
    const zeroTag = decodeView(
      viewBytes(
        12,
        seatBytes(),
        SNAPSHOT_LAYOUT_SLOTS,
        1n,
        statusBlock({ tag: 0, market: 3, takeProfit: 1, stopLoss: 1 }),
      ),
    );
    expect(zeroTag.snapshot.triggerStatus).to.equal(null);
  });

  it("reads a status it does not know, or one in an old snapshot, as unknown", () => {
    const strange = decodeView(
      viewBytes(
        12,
        seatBytes(),
        SNAPSHOT_LAYOUT_SLOTS,
        1n,
        statusBlock({ tag: 1, market: 3, takeProfit: 7, stopLoss: 1 }),
      ),
    );
    expect(strange.snapshot.triggerStatus).to.equal(null);
    const unknownTag = decodeView(
      viewBytes(
        12,
        seatBytes(),
        SNAPSHOT_LAYOUT_SLOTS,
        1n,
        statusBlock({ tag: 9, market: 3, takeProfit: 1, stopLoss: 1 }),
      ),
    );
    expect(unknownTag.snapshot.triggerStatus).to.equal(null);
    const old = decodeView(
      viewBytes(8, legacySeatBytes({ 1: { base: -9n } }), 0),
    );
    expect(old.snapshot.triggerStatus).to.equal(null);
  });

  it("reads a view that records no seat, with a zero snapshot, and still knows its owner", () => {
    const view = decodeView(
      viewBytes(
        NO_SEAT,
        seatBytes({ status: 0, version: 0n }, SNAPSHOT_LAYOUT_IDENTITY),
        SNAPSHOT_LAYOUT_IDENTITY,
        0n,
      ),
    );
    expect(view.seat).to.equal(NO_SEAT);
    expect(view.seatRecorded).to.equal(false);
    expect(view.snapshotOld).to.equal(false);
    expect(view.snapshot.seat.collateral).to.equal(0n);
    expect(view.used).to.equal(0n);
    expect(view.owner.equals(OWNER)).to.equal(true);
  });

  it("reads a snapshot written before tagged slots as the old seat, and calls it old, not unseated", () => {
    const view = decodeView(
      viewBytes(8, legacySeatBytes({ 1: { base: -9n } }), 0),
    );
    expect(view.snapshotOld).to.equal(true);
    expect(view.seatRecorded).to.equal(true);
    expect(view.snapshot.seat.collateral).to.equal(500n);
    expect(positionOn(view.snapshot.seat, 1).base).to.equal(-9n);
  });
});

describe("decodeLedger", () => {
  it("is sized from its length, at the creation size and past it", () => {
    for (const count of [MIN_SEATS, MIN_SEATS + EXTEND_SEATS_PER_CALL]) {
      const seats = Array.from({ length: count }, () =>
        seatBytes({ status: 0, version: 0n }),
      );
      seats[2] = seatBytes({ collateral: 5n });
      const ledger = decodeLedger(
        ledgerBytes(seats, 3, 0),
        EXCHANGE_LAYOUT_PRE_ACTIVATION,
      );
      expect(ledger.seats).to.have.length(count);
      expect(ledger.openSeats).to.equal(3);
      expect(ledger.seats[2].collateral).to.equal(5n);
      expect(ledger.header.tag).to.equal(ACCOUNT_TAG.ledger);
    }
  });

  it("walks the free list from the header and stops at a repeat", () => {
    const seats = Array.from({ length: 6 }, () =>
      seatBytes({ status: 0, version: 0n }),
    );
    seats[4] = seatBytes({ status: 0, nextFree: 4 });
    seats[3] = seatBytes({ status: 0, nextFree: 3 });
    seats[2] = seatBytes({ status: 0, nextFree: 0 });
    const ledger = decodeLedger(
      ledgerBytes(seats, 2, 5),
      EXCHANGE_LAYOUT_PRE_ACTIVATION,
    );
    expect(ledger.freeHead).to.equal(5);
    expect(freeSeats(ledger)).to.deep.equal([4, 3, 2]);
    seats[2] = seatBytes({ status: 0, nextFree: 5 });
    expect(
      freeSeats(
        decodeLedger(ledgerBytes(seats, 2, 5), EXCHANGE_LAYOUT_PRE_ACTIVATION),
      ),
    ).to.deep.equal([4, 3, 2]);
  });

  it("refuses a length that is not whole seats, and an account that is not a ledger", () => {
    const good = ledgerBytes([seatBytes()], 1, 0);
    expect(() =>
      decodeLedger(
        good.subarray(0, good.length - 1),
        EXCHANGE_LAYOUT_PRE_ACTIVATION,
      ),
    ).to.throw(/not a ledger/);
    const wrong = new Uint8Array(good);
    wrong.set(header(ACCOUNT_TAG.view));
    expect(() => decodeLedger(wrong, EXCHANGE_LAYOUT_PRE_ACTIVATION)).to.throw(
      /nwledger/,
    );
  });

  it("reads its seats at the layout the exchange's word names: layout 1 before activation, layout 2 after, and none for another word", () => {
    const seats = [
      seatBytes(
        { collateral: 3n, epoch: 12, generations: [0x0102_03, 0, 0, 9] },
        SNAPSHOT_LAYOUT_IDENTITY,
      ),
    ];
    const ledger = decodeLedger(ledgerBytes(seats, 1, 0), EXCHANGE_LAYOUT);
    expect(ledger.seats[0].seatEpoch).to.equal(12);
    expect(ledger.seats[0].slotGenerations).to.deep.equal([0x0102_03, 0, 0, 9]);
    expect(seatLayoutOf(EXCHANGE_LAYOUT)).to.equal(SNAPSHOT_LAYOUT_IDENTITY);
    expect(seatLayoutOf(EXCHANGE_LAYOUT_PRE_ACTIVATION)).to.equal(
      SNAPSHOT_LAYOUT_SLOTS,
    );
    expect(() => seatLayoutOf(0)).to.throw(/no seat layout/);
    expect(() => decodeLedger(ledgerBytes(seats, 1, 0), 0)).to.throw(
      /no seat layout/,
    );
  });
});

type Layout = "unmigrated" | "preActivation" | "live";

function exchangeBytes(state: {
  layout: Layout;
  capacity: number;
  minSeatDeposit?: bigint;
  paused?: boolean;
}): Uint8Array {
  const word = {
    unmigrated: 0,
    preActivation: EXCHANGE_LAYOUT_PRE_ACTIVATION,
    live: EXCHANGE_LAYOUT,
  }[state.layout];
  const writer = new Writer()
    .bytes(new Uint8Array(8))
    .u8(254)
    .pubkey(key(1))
    .bool(false)
    .pubkey(key(2))
    .pubkey(key(3))
    .bool(state.paused ?? false)
    .u8(16)
    .u8(0);
  for (let token = 0; token < 4; token += 1) {
    writer
      .pubkey(key(40 + token))
      .pubkey(key(50 + token))
      .u64(0n)
      .u8(0);
  }
  writer
    .u8(0b11)
    .u32(1_000)
    .i64(20_000n)
    .u32(7)
    .u8(0)
    .pubkey(key(60))
    .bytes(new Uint8Array(32))
    .i32(-8)
    .u16(100)
    .u16(100)
    .i64(180n)
    .i64(1_000_000n)
    .u64(0n)
    .i64(0n)
    .i64(0n)
    .u8(0)
    .u32(state.layout === "unmigrated" ? 0 : state.capacity)
    .u32(word)
    .u64(state.minSeatDeposit ?? 0n)
    .bytes(new Uint8Array(16));
  return writer.build();
}

describe("decodeExchange", () => {
  it("reads the seat capacity and the minimum seat deposit of a live layout", () => {
    const live = decodeExchange(
      exchangeBytes({
        layout: "live",
        capacity: 4_096,
        minSeatDeposit: 10_000_000n,
      }),
    );
    expect(live.layoutState).to.equal("live");
    expect(live.seatCapacity).to.equal(4_096);
    expect(liveSeatCapacity(live)).to.equal(4_096);
    expect(live.minSeatDeposit).to.equal(10_000_000n);
    expect(live.maxSeatsPerDay).to.equal(1_000);
  });

  it("reads the earlier build's layout word as pre-activation, with its capacity, and the new word as live", () => {
    const before = decodeExchange(
      exchangeBytes({ layout: "preActivation", capacity: 2_048, paused: true }),
    );
    expect(before.layoutState).to.equal("preActivation");
    expect(before.layout).to.equal(EXCHANGE_LAYOUT_PRE_ACTIVATION);
    expect(before.seatCapacity).to.equal(2_048);
    expect(before.paused).to.equal(true);
    expect(liveSeatCapacity(before)).to.equal(2_048);
    expect(EXCHANGE_LAYOUT_PRE_ACTIVATION).to.equal(
      new DataView(new TextEncoder().encode("NWX2").buffer).getUint32(0, true),
    );
    expect(EXCHANGE_LAYOUT).to.equal(
      new DataView(new TextEncoder().encode("NWX3").buffer).getUint32(0, true),
    );
  });

  it("reads any other layout word as not live, with no capacity, rather than refusing the account", () => {
    const other = decodeExchange(
      exchangeBytes({ layout: "unmigrated", capacity: 0 }),
    );
    expect(other.layoutState).to.equal("unmigrated");
    expect(other.seatCapacity).to.equal(null);
    expect(() => liveSeatCapacity(other)).to.throw(/current layout/);
  });
});

describe("seat-taking deposits", () => {
  it("lets a held seat take any deposit", () => {
    expect(seatDepositRefusal(10n, true, { spot: 1 }, 1n)).to.equal(null);
  });

  it("asks only collateral of a deposit that takes a seat, and a minimum only when the exchange sets one", () => {
    expect(seatDepositRefusal(0n, false, { collateral: true }, 1n)).to.equal(
      null,
    );
    expect(seatDepositRefusal(0n, false, { spot: 1 }, 1n)).to.match(
      /must be collateral/,
    );
    expect(seatDepositRefusal(10n, false, { collateral: true }, 9n)).to.match(
      /at least 10 atoms/,
    );
    expect(seatDepositRefusal(10n, false, { collateral: true }, 10n)).to.equal(
      null,
    );
  });

  it("types the refusal of a call on a view with no seat", () => {
    const err = { InstructionError: [0, { Custom: 6155 }] };
    const failed = transactionFailure("s", err);
    expect(failed).to.be.instanceOf(NotSeated);
    expect(failed).to.be.instanceOf(TransactionFailed);
    expect(failed.code).to.equal(6155);
    const other = transactionFailure("s", {
      InstructionError: [0, { Custom: 6156 }],
    });
    expect(other).to.not.be.instanceOf(NotSeated);
    expect(other.code).to.equal(6156);
  });
});

describe("the builders of the seat upgrade", () => {
  const instructions = new Instructions(PROGRAM_ID);
  const admin = key(1);
  const accounts = (built: { keys: { pubkey: PublicKey }[] }) =>
    built.keys.map(({ pubkey }) => pubkey.toBase58());

  it("open a view without touching the ledger, and deposit with the view writable", () => {
    const ledger = instructions.addresses.ledger.toBase58();
    const keys = [3, 4, 5, 6].map(key);
    const open = instructions.openTrader(admin, OWNER, keys);
    expect(accounts(open)).to.not.include(ledger);
    const signed = instructions.openTraderSigned(admin, OWNER, keys, 1n);
    expect(accounts(signed)).to.not.include(ledger);
    const deposit = instructions.deposit(
      admin,
      key(9),
      { mint: key(7), custodyNonce: 1n },
      OWNER,
      { collateral: true },
      1n,
    );
    const view = deposit.keys.find(({ pubkey }) =>
      pubkey.equals(instructions.addresses.view(OWNER)),
    );
    expect(view?.isWritable).to.equal(true);
  });

  it("send set_seat_access with the owner's view and 64-bit lists", () => {
    const call = instructions.setSeatAccess(
      admin,
      OWNER,
      { makerMarkets: 1n << 63n, takerMarkets: 5n, blocked: false },
      [0, 1],
    );
    const view = instructions.addresses.view(OWNER).toBase58();
    expect(accounts(call)).to.include(view);
    expect(
      call.keys.find(({ pubkey }) => pubkey.toBase58() === view)?.isWritable,
    ).to.equal(true);
    expect(call.keys).to.have.length(4 + 2);
    const data = call.data;
    expect(data.length).to.equal(8 + 32 + 8 + 8 + 1);
    expect(data.readBigUInt64LE(8 + 32)).to.equal(1n << 63n);
    expect(data.readBigUInt64LE(8 + 32 + 8)).to.equal(5n);
  });

  it("carry liquidate_range's request after the order-key fields, with liquidate's accounts", () => {
    const use = {
      orderKey: key(10),
      owner: OWNER,
      expiresAt: 5n,
      replacement: key(12),
      clientOrderId: 6n,
      marketId: 1,
    };
    const range = instructions.liquidateRange(use, {
      start: 258,
      count: 256,
      size: 1_000n,
      worstPrice: 150_000n,
      maxTakeovers: 4,
    });
    expect(accounts(range)).to.deep.equal(
      accounts(instructions.liquidate(use, 2, 1n, 1n)),
    );
    expect(Array.from(range.data.subarray(0, 8))).to.deep.equal(
      Array.from(discriminator("liquidate_range")),
    );
    const request = range.data.subarray(8 + 8 + 32 + 8 + 1);
    expect(request.readUInt32LE(0)).to.equal(258);
    expect(request.readUInt16LE(4)).to.equal(256);
    expect(request.readBigUInt64LE(6)).to.equal(1_000n);
    expect(request.readBigUInt64LE(14)).to.equal(150_000n);
    expect(request[22]).to.equal(4);
    expect(request).to.have.length(23);
    expect(RESULT_KIND.liquidateRange).to.equal(9);
  });

  it("build the ranged instructions with their arguments", () => {
    const cover = instructions.coverShortfallRange(2, 300, 256);
    expect(cover.keys).to.have.length(3);
    expect(cover.data.readUInt8(8)).to.equal(2);
    expect(cover.data.readUInt32LE(9)).to.equal(300);
    expect(cover.data.readUInt16LE(13)).to.equal(256);

    const release = instructions.releaseEmptySeats(admin, 2, 2_048);
    expect(release.keys.map(({ isSigner }) => isSigner)).to.deep.equal([
      true,
      false,
      false,
    ]);
    expect(release.keys[2].isWritable).to.equal(true);
    expect(release.data.readUInt32LE(8)).to.equal(2);
    expect(release.data.readUInt16LE(12)).to.equal(2_048);

    expect(instructions.extendLedger(admin, 33).data.readUInt16LE(8)).to.equal(
      33,
    );
  });

  it("send the minimum seat deposit with the exchange's settings", () => {
    const settings = {
      gate: key(8),
      oracle: key(9),
      maxSteps: 16,
      collateralToken: 0,
    };
    const without = instructions.initializeExchange(admin, settings);
    const withMinimum = instructions.initializeExchange(admin, {
      ...settings,
      minSeatDeposit: 10_000_000n,
    });
    const tail = (data: Buffer) => data.readBigUInt64LE(data.length - 8);
    expect(tail(without.data)).to.equal(0n);
    expect(tail(withMinimum.data)).to.equal(10_000_000n);
    const update = instructions.updateExchange(admin, {
      gate: key(8),
      oracle: key(9),
      maxSteps: 16,
      minSeatDeposit: 3n,
    });
    expect(tail(update.data)).to.equal(3n);
  });
});

/** A rollup that keeps just enough of the exchange and the ledger to follow its growth. */
function fakeRollup(start: {
  layout: Layout;
  capacity: number;
  ledger: number;
}) {
  const state = { ...start };
  const calls: string[] = [];
  const addresses = new Instructions(PROGRAM_ID).addresses;
  const named = new Map(
    ["extend_ledger"].map((name) => [
      Buffer.from(discriminator(name)).toString("hex"),
      name,
    ]),
  );
  const handle = (name: string, data: Buffer) => {
    calls.push(name);
    if (name === "extend_ledger") {
      state.capacity += data.readUInt16LE(8);
    }
  };
  const connection = {
    getLatestBlockhash: async () => ({
      blockhash: PublicKey.default.toBase58(),
      lastValidBlockHeight: 100,
    }),
    sendRawTransaction: async (raw: Buffer) => {
      const transaction = Transaction.from(raw);
      for (const step of transaction.instructions) {
        if (!step.programId.equals(PROGRAM_ID)) continue;
        const name = named.get(step.data.subarray(0, 8).toString("hex"));
        if (name) handle(name, step.data);
      }
      return "signature";
    },
    getSignatureStatus: async () => ({
      value: { confirmationStatus: "confirmed", err: null },
    }),
    getAccountInfo: async (address: PublicKey) => {
      if (address.equals(addresses.exchange)) {
        return { data: exchangeBytes({ ...state, paused: true }) };
      }
      if (address.equals(addresses.ledger) && state.ledger > 0) {
        return { data: new Uint8Array(state.ledger) };
      }
      return null;
    },
  };
  return { connection, state, calls };
}

describe("the ledger growth helper", () => {
  const admin = Keypair.generate();

  it("grows the ledger to a target in calls of at most 33 seats, and refuses what the layout cannot hold", async () => {
    const { connection, calls } = fakeRollup({
      layout: "live",
      capacity: 2_048,
      ledger: ACCOUNT_LEN.ledger,
    });
    const capacity = await extendLedgerTo(
      connection as never,
      admin,
      4_096,
      PROGRAM_ID,
    );
    expect(capacity).to.equal(4_096);
    expect(calls).to.have.length(Math.ceil(2_048 / EXTEND_SEATS_PER_CALL));
    expect(
      await extendLedgerTo(connection as never, admin, 100, PROGRAM_ID),
      "a smaller target changes nothing",
    ).to.equal(4_096);
    let refused: unknown;
    await extendLedgerTo(
      connection as never,
      admin,
      MAX_SEATS + 1,
      PROGRAM_ID,
    ).catch((error: Error) => {
      refused = error;
    });
    expect(String(refused)).to.match(/up to 34492/);
  });
});

/**
 * A rollup that keeps a sealed trigger book as the program does: the account
 * cannot be read, it is created at its first growth step, grown a step at a
 * time and finalised once it has its full size.
 */
function triggerRollup(
  start: { created: boolean; length: number; ready: boolean },
  fullLength: number,
) {
  const state = { ...start };
  const calls: string[] = [];
  const results = new Map<string, unknown>();
  const addresses = new Instructions(PROGRAM_ID).addresses;
  const named = new Map(
    ["create_trigger_book", "grow_account", "finalize_trigger_book"].map(
      (name) => [Buffer.from(discriminator(name)).toString("hex"), name],
    ),
  );
  const refusal = (code: number) => ({
    InstructionError: [0, { Custom: code }],
  });
  const run = (name: string, data: Buffer): unknown => {
    if (name === "create_trigger_book") {
      if (state.created) return refusal(errorCode("AccountExists"));
      Object.assign(state, {
        created: true,
        length: Math.min(fullLength, GROWTH_STEP),
      });
    } else if (name === "grow_account") {
      const target = data.readUInt32LE(10);
      if (state.ready) return refusal(errorCode("AlreadyReady"));
      const oneStep =
        target > state.length &&
        target - state.length <= GROWTH_STEP &&
        target <= fullLength;
      if (!oneStep) return refusal(errorCode("InvalidGrowth"));
      state.length = target;
    } else {
      if (state.ready) return refusal(errorCode("AlreadyReady"));
      if (state.length !== fullLength) return refusal(errorCode("WrongSize"));
      state.ready = true;
    }
    return null;
  };
  const connection = {
    getLatestBlockhash: async () => ({
      blockhash: PublicKey.default.toBase58(),
      lastValidBlockHeight: 100,
    }),
    sendRawTransaction: async (raw: Buffer) => {
      const signature = `signature-${results.size + 1}`;
      let outcome: unknown = null;
      for (const step of Transaction.from(raw).instructions) {
        if (!step.programId.equals(PROGRAM_ID) || outcome !== null) continue;
        const name = named.get(step.data.subarray(0, 8).toString("hex"))!;
        calls.push(name);
        outcome = run(name, step.data);
      }
      results.set(signature, outcome);
      return signature;
    },
    getSignatureStatus: async (signature: string) => ({
      value: {
        confirmationStatus: "confirmed",
        err: results.get(signature) ?? null,
      },
    }),
    getTransaction: async () => null,
    getAccountInfo: async (address: PublicKey) =>
      address.equals(addresses.exchange)
        ? {
            data: exchangeBytes({
              layout: "live",
              capacity: MIN_SEATS,
            }),
          }
        : null,
  };
  return { connection, state, calls };
}

describe("the trigger book set-up", () => {
  const admin = Keypair.generate();
  const fresh = { created: false, length: 0, ready: false };

  it("creates a perp market's book, grows it to the size for the most seats a ledger can hold, whatever the ledger holds, and finalises it", async () => {
    const full = PERP_TRIGGER_BOOK_LEN;
    expect(full).to.equal(triggerAccountLen(MAX_SEATS));
    const { connection, state, calls } = triggerRollup(fresh, full);
    await setupTriggerBook(
      connection as never,
      admin,
      1,
      MARKET_KIND.perp,
      PROGRAM_ID,
    );
    expect(state).to.deep.equal({ created: true, length: full, ready: true });
    expect(calls[0]).to.equal("create_trigger_book");
    expect(calls.at(-1)).to.equal("finalize_trigger_book");
    expect(calls.filter((name) => name === "grow_account")).to.have.length(
      Math.ceil((full - GROWTH_STEP) / GROWTH_STEP),
    );
  });

  it("creates and finalises a spot market's book without growing it", async () => {
    const { connection, state, calls } = triggerRollup(
      fresh,
      triggerAccountLen(0),
    );
    await setupTriggerBook(
      connection as never,
      admin,
      2,
      MARKET_KIND.spot,
      PROGRAM_ID,
    );
    expect(state.ready).to.equal(true);
    expect(calls).to.deep.equal([
      "create_trigger_book",
      "finalize_trigger_book",
    ]);
  });

  it("does nothing more for a book that is already finalised, though it cannot read the account", async () => {
    const full = PERP_TRIGGER_BOOK_LEN;
    const { connection, calls } = triggerRollup(
      { created: true, length: full, ready: true },
      full,
    );
    await setupTriggerBook(
      connection as never,
      admin,
      1,
      MARKET_KIND.perp,
      PROGRAM_ID,
    );
    expect(calls).to.deep.equal([
      "create_trigger_book",
      "finalize_trigger_book",
    ]);
  });

  it("goes on from a book grown part of the way, and stops at any refusal that is not the book's own progress", async () => {
    const full = PERP_TRIGGER_BOOK_LEN;
    const partway = triggerRollup(
      { created: true, length: 2 * GROWTH_STEP, ready: false },
      full,
    );
    await setupTriggerBook(
      partway.connection as never,
      admin,
      1,
      MARKET_KIND.perp,
      PROGRAM_ID,
    );
    expect(partway.state).to.deep.equal({
      created: true,
      length: full,
      ready: true,
    });
    const refused = triggerRollup(fresh, full);
    const failing = {
      ...refused.connection,
      getSignatureStatus: async () => ({
        value: {
          confirmationStatus: "confirmed",
          err: { InstructionError: [0, { Custom: errorCode("NotAdmin") }] },
        },
      }),
    };
    let error: unknown;
    await setupTriggerBook(
      failing as never,
      admin,
      1,
      MARKET_KIND.perp,
      PROGRAM_ID,
    ).catch((caught: Error) => {
      error = caught;
    });
    expect(String(error)).to.include(String(errorCode("NotAdmin")));
    expect(refused.calls).to.deep.equal(["create_trigger_book"]);
  });
});

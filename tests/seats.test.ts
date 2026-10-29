import { expect } from "chai";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  ACCOUNT_LEN,
  ACCOUNT_TAG,
  EXCHANGE_LAYOUT,
  EXCHANGE_LAYOUT_RELAYOUT,
  EXTEND_SEATS_PER_CALL,
  Instructions,
  LEDGER_PREFIX,
  LEGACY_LEDGER_LEN,
  LEGACY_SEATS,
  LEGACY_SEAT_LEN,
  MAX_SEATS,
  MIN_SEATS,
  NO_SEAT,
  NotSeated,
  PROGRAM_ID,
  RECONCILE_SEATS_PER_CALL,
  RESULT_KIND,
  SEAT_LEN,
  SEAT_SLOTS,
  SEAT_SNAPSHOT_LEN,
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
  relayoutLedger,
  seatDepositRefusal,
  transactionFailure,
} from "../sdk/dist/index.js";

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
};

/** A seat as the ledger lays it out: 304 bytes, four tagged slots. */
function seatBytes(fields: SeatFields = {}): Uint8Array {
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
    .bytes(new Uint8Array(2))
    .u32(fields.nextFree ?? 0);
  const bytes = writer.build();
  expect(bytes.length).to.equal(SEAT_LEN);
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

/** A view whose snapshot holds `seat` in the layout `layout` names. */
function viewBytes(
  seatIndex: number,
  snapshotSeat: Uint8Array,
  layout: number,
  used = 1n,
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
    expect(LEGACY_LEDGER_LEN).to.equal(917_528);
    expect(LEGACY_SEATS).to.equal(2_048);
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
    const seat = decodeSeat(seatBytes({ slots: [{ tag: 4 }] }));
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
    });
  });

  it("reads the free list link of a closed seat", () => {
    const closed = decodeSeat(seatBytes({ status: 0, nextFree: 41 }));
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
    expect(decodeSeat(both, SEAT_LEN).collateral).to.equal(2n);
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
  it("reads a view that records a seat and was written with tagged slots", () => {
    const view = decodeView(
      viewBytes(
        12,
        seatBytes({ collateral: 77n, slots: [{ tag: 3, base: 4n }] }),
        SNAPSHOT_LAYOUT_SLOTS,
      ),
    );
    expect(view.seat).to.equal(12);
    expect(view.seatRecorded).to.equal(true);
    expect(view.snapshotOld).to.equal(false);
    expect(view.snapshot.layout).to.equal(1);
    expect(view.snapshot.seat.collateral).to.equal(77n);
    expect(positionOn(view.snapshot.seat, 2).base).to.equal(4n);
    expect(view.used).to.equal(1n);
  });

  it("reads a view that records no seat, with a zero snapshot, and still knows its owner", () => {
    const view = decodeView(
      viewBytes(
        NO_SEAT,
        seatBytes({ status: 0, version: 0n }),
        SNAPSHOT_LAYOUT_SLOTS,
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

  it("reads a snapshot written before the relayout as the old seat, and calls it old, not unseated", () => {
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
      const ledger = decodeLedger(ledgerBytes(seats, 3, 0));
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
    const ledger = decodeLedger(ledgerBytes(seats, 2, 5));
    expect(ledger.freeHead).to.equal(5);
    expect(freeSeats(ledger)).to.deep.equal([4, 3, 2]);
    seats[2] = seatBytes({ status: 0, nextFree: 5 });
    expect(freeSeats(decodeLedger(ledgerBytes(seats, 2, 5)))).to.deep.equal([
      4, 3, 2,
    ]);
  });

  it("refuses a length that is not whole seats, and an account that is not a ledger", () => {
    const good = ledgerBytes([seatBytes()], 1, 0);
    expect(() => decodeLedger(good.subarray(0, good.length - 1))).to.throw(
      /not a ledger/,
    );
    const wrong = new Uint8Array(good);
    wrong.set(header(ACCOUNT_TAG.view));
    expect(() => decodeLedger(wrong)).to.throw(/nwledger/);
  });
});

type Layout = "unmigrated" | "relayout" | "live";

function exchangeBytes(state: {
  layout: Layout;
  capacity: number;
  relayoutNext: number;
  minSeatDeposit?: bigint;
  paused?: boolean;
}): Uint8Array {
  const word = {
    unmigrated: 0,
    relayout: EXCHANGE_LAYOUT_RELAYOUT,
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
    .u32(state.layout === "live" ? state.capacity : 0)
    .u32(word)
    .u64(state.minSeatDeposit ?? 0n)
    .u32(state.relayoutNext)
    .bytes(new Uint8Array(12));
  return writer.build();
}

describe("decodeExchange", () => {
  it("reads the seat capacity, the minimum seat deposit and the copy progress by layout", () => {
    const live = decodeExchange(
      exchangeBytes({
        layout: "live",
        capacity: 4_096,
        relayoutNext: 0,
        minSeatDeposit: 10_000_000n,
      }),
    );
    expect(live.layoutState).to.equal("live");
    expect(live.seatCapacity).to.equal(4_096);
    expect(liveSeatCapacity(live)).to.equal(4_096);
    expect(live.minSeatDeposit).to.equal(10_000_000n);
    expect(live.relayoutNext).to.equal(0);
    expect(live.maxSeatsPerDay).to.equal(1_000);

    const copying = decodeExchange(
      exchangeBytes({ layout: "relayout", capacity: 0, relayoutNext: 512 }),
    );
    expect(copying.layoutState).to.equal("relayout");
    expect(copying.seatCapacity).to.equal(null);
    expect(copying.relayoutNext).to.equal(512);
    expect(() => liveSeatCapacity(copying)).to.throw(/512 seats so far/);
  });

  it("reads any other layout word as not migrated, with no capacity, rather than refusing the account", () => {
    const old = decodeExchange(
      exchangeBytes({ layout: "unmigrated", capacity: 0, relayoutNext: 99 }),
    );
    expect(old.layoutState).to.equal("unmigrated");
    expect(old.seatCapacity).to.equal(null);
    expect(old.relayoutNext).to.equal(0);
    expect(() => liveSeatCapacity(old)).to.throw(/migrate_exchange/);
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

  it("build the ranged and relayout instructions with their arguments", () => {
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

    const relayout = instructions.relayoutSeats(admin, 256);
    expect(accounts(relayout)).to.include(
      instructions.addresses.legacyLedger.toBase58(),
    );
    expect(accounts(relayout)).to.include(
      instructions.addresses.ledger.toBase58(),
    );
    expect(
      instructions.addresses.legacyLedger.equals(instructions.addresses.ledger),
    ).to.equal(false);
    expect(accounts(instructions.finishRelayout(admin))).to.deep.equal(
      accounts(relayout),
    );
    expect(accounts(instructions.migrateExchange(admin))).to.have.length(2);
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

/** A rollup that keeps just enough of the exchange and the ledger to follow a migration. */
function fakeRollup(start: {
  layout: Layout;
  capacity: number;
  relayoutNext: number;
  ledger: number;
}) {
  const state = { ...start };
  const calls: string[] = [];
  const addresses = new Instructions(PROGRAM_ID).addresses;
  const names = [
    "migrate_exchange",
    "create_relayout_ledger",
    "grow_account",
    "relayout_seats",
    "finish_relayout",
    "extend_ledger",
  ];
  const named = new Map(
    names.map((name) => [
      Buffer.from(discriminator(name)).toString("hex"),
      name,
    ]),
  );
  const handle = (name: string, data: Buffer) => {
    calls.push(name);
    if (name === "migrate_exchange") {
      state.layout = "relayout";
      state.relayoutNext = 0;
    } else if (name === "create_relayout_ledger") {
      state.ledger = 10_240;
    } else if (name === "grow_account") {
      state.ledger = data.readUInt32LE(8 + 2);
    } else if (name === "relayout_seats") {
      state.relayoutNext += data.readUInt16LE(8);
    } else if (name === "finish_relayout") {
      state.layout = "live";
      state.capacity = state.relayoutNext;
      state.relayoutNext = 0;
    } else if (name === "extend_ledger") {
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

describe("the ledger migration helpers", () => {
  const admin = Keypair.generate();

  it("migrate, create, grow, copy in ranges of 256 and finish, in that order", async () => {
    const { connection, state, calls } = fakeRollup({
      layout: "unmigrated",
      capacity: 0,
      relayoutNext: 0,
      ledger: 0,
    });
    const said: string[] = [];
    const exchange = await relayoutLedger(
      connection as never,
      admin,
      PROGRAM_ID,
      (line) => said.push(line),
    );
    expect(exchange.layoutState).to.equal("live");
    expect(exchange.seatCapacity).to.equal(2_048);
    expect(state.ledger).to.equal(ACCOUNT_LEN.ledger);
    const order = calls.filter((name, at) => name !== calls[at - 1]);
    expect(order).to.deep.equal([
      "migrate_exchange",
      "create_relayout_ledger",
      "grow_account",
      "relayout_seats",
      "finish_relayout",
    ]);
    expect(calls.filter((name) => name === "relayout_seats")).to.have.length(8);
    expect(said.at(-1)).to.match(/finish_relayout.*2048 seats/);
  });

  it("picks up where the exchange says the copy stopped, and does nothing once it is live", async () => {
    const resumed = fakeRollup({
      layout: "relayout",
      capacity: 0,
      relayoutNext: 1_536,
      ledger: ACCOUNT_LEN.ledger,
    });
    await relayoutLedger(resumed.connection as never, admin, PROGRAM_ID);
    expect(resumed.calls).to.deep.equal([
      "relayout_seats",
      "relayout_seats",
      "finish_relayout",
    ]);

    const done = fakeRollup({
      layout: "live",
      capacity: 2_048,
      relayoutNext: 0,
      ledger: ACCOUNT_LEN.ledger,
    });
    const exchange = await relayoutLedger(
      done.connection as never,
      admin,
      PROGRAM_ID,
    );
    expect(done.calls).to.deep.equal([]);
    expect(exchange.seatCapacity).to.equal(2_048);
  });

  it("grows the ledger to a target in calls of at most 33 seats, and refuses what the layout cannot hold", async () => {
    const { connection, calls } = fakeRollup({
      layout: "live",
      capacity: 2_048,
      relayoutNext: 0,
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

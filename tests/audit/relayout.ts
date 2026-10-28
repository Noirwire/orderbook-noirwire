/**
 * The relayout of the earlier ledger, on the state the earlier build made
 * (`make test-upgrade`), after the new build is deployed over it. It proves:
 *
 * 1. Before `migrate_exchange` and without a pause the relayout instructions
 *    refuse, and `migrate_exchange` refuses an exchange that is not paused or
 *    is migrated already.
 * 2. While the exchange reads NWXR, with part of the seats copied and with the
 *    exchange unpaused as well as paused, a deposit, a withdrawal, a
 *    withdrawal by key, a cancel, a cancel-all, an order and a close are all
 *    refused and change nothing: custody and both ledgers stay byte for byte.
 * 3. `finish_relayout` refuses before every seat is copied and on an unpaused
 *    exchange; afterwards every seat and every total equals the old ledger's,
 *    the free list is whole, the books are untouched, and the old ledger is
 *    byte for byte as it was, which is what a rollback relies on.
 * 4. The ledger then grows, the views sync to what the old ledger held, and an
 *    existing trader with a position and a new trader trade, and the sweeps
 *    leave every funded seat as it was.
 *
 * It ends with the lists of the seats it kept cleared, as the access audit
 * after it expects state with no list set.
 */
import { expect } from "chai";
import type { PublicKey } from "@solana/web3.js";
import {
  ACCOUNT_LEN,
  GROW_KIND,
  LEGACY_LEDGER_LEN,
  LEGACY_SEATS,
  NO_SEAT,
  ORDER_TYPE,
  RELAYOUT_SEATS_PER_CALL,
  RESULT_STATUS,
  SIDE,
  decodeLedger,
  extendLedgerTo,
  freeSeats,
  growToFullSize,
  positionOn,
  type Ledger,
  type Seat,
} from "../../sdk/dist/index.js";
import {
  PROGRAM_ID,
  addresses,
  admin,
  balanceOf,
  computeUnits,
  instructions,
  ledgerThroughThePort,
  refusal,
  reportUnits,
  rollup,
  send,
  throughThePort,
  viewThroughThePort,
} from "../support";
import { decodeEarlierLedger } from "../legacy";
import {
  COLLATERAL,
  NSOL,
  NUSD,
  PERP,
  SPOT,
  USD,
  attempted,
  call,
  cast,
  custodyMatchesLedger,
  custodyOf,
  deposited,
  exchangeOn,
  freshMark,
  fundedWith,
  landed,
  leastLots,
  mints,
  openedTrader,
  order,
  placing,
  refuses,
  settings,
  stranger,
  tokenAccount,
  NOBODY,
  type Trader,
} from "../orderbook/world";
import { earlierState } from "./earlier-state";

const deposit = (trader: Trader, amount: bigint) =>
  deposited(trader, mints.nUSD, COLLATERAL, amount);

const pause = (paused: boolean) =>
  send(rollup, instructions.setPaused(admin.publicKey, paused), admin);

const kept = (): Trader[] => [
  earlierState.maker,
  earlierState.holder,
  earlierState.listed,
  earlierState.blocked,
  cast.alice,
  cast.bob,
  cast.carol,
];

const accountBytes = async (address: PublicKey) => {
  const account = await rollup.getAccountInfo(address);
  return account ? Buffer.from(account.data) : null;
};

/** Whatever the old and the new ledger and the custody of both tokens hold, as bytes and balances. */
async function worldNow() {
  return {
    legacy: await accountBytes(addresses.legacyLedger),
    current: await accountBytes(addresses.ledger),
    nUSD: await balanceOf(addresses.custody(custodyOf(mints.nUSD))),
    nSOL: await balanceOf(addresses.custody(custodyOf(mints.nSOL))),
  };
}

/** The old seat and the new seat hold the same thing, market by market. */
function sameSeat(index: number, old: Seat, now: Seat): void {
  const where = `seat ${index}`;
  expect(now.status, where).to.equal(old.status);
  expect(now.version, `${where} version`).to.equal(old.version);
  if (old.status !== 1) {
    expect(now.collateral, where).to.equal(0n);
    return;
  }
  expect(now.owner.equals(old.owner), `${where} owner`).to.equal(true);
  expect(now.collateral, `${where} collateral`).to.equal(old.collateral);
  expect(now.spot, `${where} spot`).to.deep.equal(old.spot);
  expect(now.blocked, `${where} blocked`).to.equal(old.blocked);
  expect(now.makerMarkets, `${where} maker list`).to.equal(old.makerMarkets);
  expect(now.takerMarkets, `${where} taker list`).to.equal(old.takerMarkets);
  for (let market = 0; market < 8; market += 1) {
    expect(positionOn(now, market), `${where} market ${market}`).to.deep.equal(
      positionOn(old, market),
    );
  }
}

function totals(ledger: Ledger) {
  const open = ledger.seats.filter((seat) => seat.status === 1);
  const sum = (pick: (seat: Seat) => bigint) =>
    open.reduce((total, seat) => total + pick(seat), 0n);
  return {
    openSeats: ledger.openSeats,
    open: open.length,
    collateral: sum((seat) => seat.collateral),
    available: [NUSD, NSOL].map((token) =>
      sum((seat) => seat.spot[token].available),
    ),
    locked: [NUSD, NSOL].map((token) => sum((seat) => seat.spot[token].locked)),
    base: Array.from({ length: 8 }, (_, market) =>
      sum((seat) => positionOn(seat, market).base),
    ),
    quote: Array.from({ length: 8 }, (_, market) =>
      sum((seat) => positionOn(seat, market).quote),
    ),
    lots: Array.from({ length: 8 }, (_, market) =>
      sum(
        (seat) =>
          positionOn(seat, market).openBidLots +
          positionOn(seat, market).openAskLots,
      ),
    ),
    orders: Array.from({ length: 8 }, (_, market) =>
      open.reduce(
        (total, seat) => total + positionOn(seat, market).openOrders,
        0,
      ),
    ),
  };
}

describe("the relayout of the earlier ledger", () => {
  let oldBytes: Buffer;
  let oldLedger: Ledger;
  let books: [number, Buffer | null][];
  let custodyBefore: { nUSD: bigint; nSOL: bigint };
  let legacyViews: Map<string, Seat>;
  let firstNew = 0;

  before(async () => {
    oldBytes = Buffer.from(await throughThePort(addresses.legacyLedger));
    oldLedger = decodeEarlierLedger(oldBytes);
    books = [];
    for (let id = 0; id < 8; id += 1) {
      books.push([id, await accountBytes(addresses.book(id))]);
    }
    custodyBefore = {
      nUSD: await balanceOf(addresses.custody(custodyOf(mints.nUSD))),
      nSOL: await balanceOf(addresses.custody(custodyOf(mints.nSOL))),
    };
    legacyViews = new Map(
      kept().map((trader) => [
        trader.owner.publicKey.toBase58(),
        oldLedger.seats[trader.seat],
      ]),
    );
  });

  it("starts from the earlier ledger, with positions, orders, lists and a closed seat in it, and no new ledger", async () => {
    expect(oldBytes.length).to.equal(LEGACY_LEDGER_LEN);
    expect(await rollup.getAccountInfo(addresses.ledger)).to.equal(null);
    const seats = oldLedger.seats;
    const holding = (seat: Seat) =>
      seat.status === 1 && seat.positions.some((p) => p.base !== 0n);
    expect(seats.some(holding), "a position").to.equal(true);
    expect(
      seats.some(
        (seat) =>
          seat.status === 1 && seat.positions.some((p) => p.openOrders > 0),
      ),
      "a resting order",
    ).to.equal(true);
    expect(
      seats.some((seat) => seat.status === 1 && seat.takerMarkets !== 0n),
      "a listed taker",
    ).to.equal(true);
    expect(
      seats.some((seat) => seat.status === 1 && seat.blocked),
      "a blocked seat",
    ).to.equal(true);
    const closedAfterOpen = seats.findIndex(
      (seat, index) => index > 1 && seat.status === 0 && seat.version > 1n,
    );
    expect(
      closedAfterOpen,
      "a closed seat with a bumped version",
    ).to.be.greaterThan(1);
    const holder = positionOn(oldLedger.seats[earlierState.holder.seat], PERP);
    expect(holder.base > 0n, "the holder is long").to.equal(true);
    expect(
      positionOn(oldLedger.seats[earlierState.holder.seat], SPOT).openOrders,
      "and rests a spot order on another market",
    ).to.equal(1);
  });

  it("refuses the relayout before the exchange is migrated and migrating an exchange that is not paused", async () => {
    const before = await worldNow();
    for (const attempt of [
      instructions.createRelayoutLedger(admin.publicKey),
      instructions.relayoutSeats(admin.publicKey, 1),
      instructions.finishRelayout(admin.publicKey),
    ]) {
      await refuses(send(rollup, attempt, admin), "RelayoutOutOfOrder");
    }
    expect((await exchangeOn(rollup)).paused).to.equal(false);
    await refuses(
      send(rollup, instructions.migrateExchange(admin.publicKey), admin),
      "RelayoutOutOfOrder",
    );
    expect(await worldNow()).to.deep.equal(before);
  });

  it("migrates the paused exchange once and refuses a second migration", async () => {
    await pause(true);
    await send(rollup, instructions.migrateExchange(admin.publicKey), admin);
    const migrating = await exchangeOn(rollup);
    expect(migrating.layoutState).to.equal("relayout");
    expect(migrating.relayoutNext).to.equal(0);
    await refuses(
      send(rollup, instructions.migrateExchange(admin.publicKey), admin),
      "AlreadyMigrated",
    );
  });

  it("copies the seats in ranges, and while it does nothing that needs the new ledger runs, paused or not", async () => {
    await send(
      rollup,
      instructions.createRelayoutLedger(admin.publicKey),
      admin,
    );
    await growToFullSize(
      rollup,
      admin,
      GROW_KIND.ledger,
      0,
      addresses.ledger,
      ACCOUNT_LEN.ledger,
      PROGRAM_ID,
    );
    const first = await send(
      rollup,
      instructions.relayoutSeats(admin.publicKey, RELAYOUT_SEATS_PER_CALL),
      admin,
    );
    reportUnits(
      `relayout_seats(${RELAYOUT_SEATS_PER_CALL})`,
      LEGACY_SEATS,
      await computeUnits(first),
    );
    expect((await exchangeOn(rollup)).relayoutNext).to.equal(
      RELAYOUT_SEATS_PER_CALL,
    );
    await refuses(
      send(rollup, instructions.finishRelayout(admin.publicKey), admin),
      "RelayoutIncomplete",
    );

    const { alice } = cast;
    const owner = alice.owner.publicKey;
    const to = tokenAccount(alice, mints.nUSD);
    const refusals: [string, () => Promise<unknown>][] = [
      [
        "deposit",
        () =>
          send(
            rollup,
            instructions.deposit(
              owner,
              to,
              custodyOf(mints.nUSD),
              owner,
              COLLATERAL,
              1n,
            ),
            alice.owner,
          ),
      ],
      [
        "withdraw",
        () =>
          send(
            rollup,
            instructions.withdraw(
              owner,
              to,
              custodyOf(mints.nUSD),
              COLLATERAL,
              1n,
              [PERP],
            ),
            alice.owner,
          ),
      ],
      [
        "withdraw by key",
        () =>
          attempted(alice, (use, _id, expiresAt) =>
            instructions.withdrawByKey(
              use.keypair.publicKey,
              owner,
              use.replacement.publicKey,
              expiresAt,
              to,
              custodyOf(mints.nUSD),
              COLLATERAL,
              1n,
              [PERP],
            ),
          ),
      ],
      [
        "cancel",
        () =>
          attempted(alice, (use, id, expiresAt) =>
            instructions.cancelOrder(call(alice, use, SPOT, id, expiresAt), 1n),
          ),
      ],
      [
        "cancel all",
        () =>
          attempted(alice, (use, id, expiresAt) =>
            instructions.cancelAll(call(alice, use, PERP, id, expiresAt), 4),
          ),
      ],
      [
        "place",
        () =>
          attempted(
            alice,
            placing(
              alice,
              PERP,
              order(SIDE.bid, ORDER_TYPE.immediateOrCancel, 1n, 1n),
            ),
          ),
      ],
      [
        "sync view",
        () =>
          attempted(alice, (use, id, expiresAt) =>
            instructions.syncView(call(alice, use, PERP, id, expiresAt)),
          ),
      ],
      [
        "close",
        () => send(rollup, instructions.closeTrader(owner), alice.owner),
      ],
      [
        "release empty seats",
        () =>
          send(
            rollup,
            instructions.releaseEmptySeats(stranger.publicKey, 2, 16),
            stranger,
          ),
      ],
    ];
    for (const unpaused of [false, true]) {
      if (unpaused) await pause(false);
      const before = await worldNow();
      for (const [what, attempt] of refusals) {
        const why = await refusal(attempt());
        expect(why.length, `${what} is refused`).to.be.greaterThan(0);
      }
      expect(
        await worldNow(),
        `nothing changed (exchange ${unpaused ? "unpaused" : "paused"})`,
      ).to.deep.equal(before);
      if (unpaused) await pause(true);
    }
  });

  it("copies the rest, refuses a copy past the end, and refuses to finish an unpaused exchange", async () => {
    let next = (await exchangeOn(rollup)).relayoutNext;
    while (next < LEGACY_SEATS) {
      await send(
        rollup,
        instructions.relayoutSeats(admin.publicKey, RELAYOUT_SEATS_PER_CALL),
        admin,
      );
      next = (await exchangeOn(rollup)).relayoutNext;
    }
    expect(next).to.equal(LEGACY_SEATS);
    await refuses(
      send(rollup, instructions.relayoutSeats(admin.publicKey, 1), admin),
      "RelayoutOutOfOrder",
    );
    await pause(false);
    const before = await worldNow();
    await refuses(
      send(rollup, instructions.finishRelayout(admin.publicKey), admin),
      "RelayoutOutOfOrder",
    );
    expect(await worldNow()).to.deep.equal(before);
    expect((await exchangeOn(rollup)).layoutState).to.equal("relayout");
    await pause(true);
  });

  it("finishes with every seat and every total identical, the old ledger untouched and the books as they were", async () => {
    const done = await send(
      rollup,
      instructions.finishRelayout(admin.publicKey),
      admin,
    );
    reportUnits("finish_relayout", LEGACY_SEATS, await computeUnits(done));
    const exchange = await exchangeOn(rollup);
    expect(exchange.layoutState).to.equal("live");
    expect(exchange.seatCapacity).to.equal(LEGACY_SEATS);
    expect(exchange.relayoutNext).to.equal(0);

    const current = await ledgerThroughThePort();
    expect(current.seats.length).to.equal(LEGACY_SEATS);
    current.seats.forEach((seat, index) =>
      sameSeat(index, oldLedger.seats[index], seat),
    );
    expect(totals(current)).to.deep.equal(totals(oldLedger));

    const listed = freeSeats(current);
    expect(listed.length).to.equal(LEGACY_SEATS - current.openSeats);
    expect(new Set(listed).size).to.equal(listed.length);
    for (const index of listed) {
      expect(index).to.be.at.least(2);
      expect(current.seats[index].status).to.equal(0);
    }
    for (let index = 2; index < LEGACY_SEATS; index += 1) {
      if (current.seats[index].status === 0) {
        expect(listed, `closed seat ${index} is free`).to.include(index);
      }
    }

    const unchanged = await accountBytes(addresses.legacyLedger);
    expect(
      unchanged?.equals(oldBytes),
      "the old ledger is byte for byte as it was, so the earlier program could be put back",
    ).to.equal(true);
    for (const [id, bytes] of books) {
      const now = await accountBytes(addresses.book(id));
      expect(
        now?.equals(bytes ?? Buffer.alloc(0)) ?? bytes === null,
        `book ${id}`,
      ).to.equal(true);
    }
    expect(await balanceOf(addresses.custody(custodyOf(mints.nUSD)))).to.equal(
      custodyBefore.nUSD,
    );
    expect(await balanceOf(addresses.custody(custodyOf(mints.nSOL)))).to.equal(
      custodyBefore.nSOL,
    );
    await custodyMatchesLedger();

    await refuses(
      send(rollup, instructions.relayoutSeats(admin.publicKey, 1), admin),
      "RelayoutOutOfOrder",
    );
    await refuses(
      send(rollup, instructions.finishRelayout(admin.publicKey), admin),
      "RelayoutOutOfOrder",
    );
    await refuses(
      send(rollup, instructions.migrateExchange(admin.publicKey), admin),
      "AlreadyMigrated",
    );
  });

  it("grows the ledger, and the next seat taken is in the new region", async () => {
    const capacity = await extendLedgerTo(rollup, admin, 4_096, PROGRAM_ID);
    expect(capacity).to.equal(4_096);
    const exchange = await exchangeOn(rollup);
    expect(exchange.seatCapacity).to.equal(4_096);
    const ledger = decodeLedger(await throughThePort(addresses.ledger));
    expect(ledger.seats.length).to.equal(4_096);
    const listed = freeSeats(ledger);
    firstNew = listed[0];
    expect(
      firstNew,
      "the head of the list is in the new region",
    ).to.be.at.least(LEGACY_SEATS);
    for (let index = LEGACY_SEATS; index < 4_096; index += 1) {
      expect(listed, `new seat ${index}`).to.include(index);
    }
    expect(ledger.openSeats).to.equal(oldLedger.openSeats);
  });

  it("serves the kept views what the old ledger held, once synced, and keeps their seats", async () => {
    await pause(false);
    for (const trader of kept()) {
      const old = legacyViews.get(trader.owner.publicKey.toBase58())!;
      const before = await viewThroughThePort(trader.owner.publicKey);
      expect(before.seat).to.equal(trader.seat);
      const { seated, view } = await trader.client.confirmSeat();
      expect(seated).to.equal(true);
      expect(view.seat).to.equal(trader.seat);
      expect(view.snapshotOld).to.equal(false);
      sameSeat(trader.seat, old, view.snapshot.seat);
    }
  });

  it("lets a maker requote and be filled, a trader close its position, and the sweeps find nothing to do", async () => {
    const { maker, holder, listed } = earlierState;
    const price = await freshMark(PERP);
    const lots = leastLots(price);
    await maker.client.cancelAll(PERP);
    const rested = landed(
      await maker.client.placeOrder(
        PERP,
        order(SIDE.ask, ORDER_TYPE.postOnly, price, 3n * lots),
      ),
    );
    expect(rested.status).to.equal(RESULT_STATUS.rested);
    const filled = landed(
      await listed.client.placeOrder(
        PERP,
        order(SIDE.bid, ORDER_TYPE.immediateOrCancel, price, lots),
      ),
    );
    expect(filled.filled).to.equal(lots);
    await maker.client.cancelAll(PERP);

    const held = positionOn(
      (await ledgerThroughThePort()).seats[holder.seat],
      PERP,
    ).base;
    expect(held > 0n).to.equal(true);
    await listed.client.placeOrder(
      PERP,
      order(SIDE.bid, ORDER_TYPE.postOnly, price, held),
    );
    const closed = landed(
      await holder.client.placeOrder(PERP, {
        ...order(SIDE.ask, ORDER_TYPE.immediateOrCancel, price, held),
        reduceOnly: true,
      }),
    );
    expect(closed.filled).to.equal(held);
    await listed.client.cancelAll(PERP);
    expect(
      positionOn((await ledgerThroughThePort()).seats[holder.seat], PERP).base,
    ).to.equal(0n);

    const swept = await maker.client.liquidateRange(PERP, {
      start: 2,
      count: 256,
      size: 1_000n,
      worstPrice: price * 2n,
      maxTakeovers: 4,
    });
    expect(swept.status, "a sweep that stopped for nothing").to.equal(0);
    expect(swept.code, "takeovers made").to.equal(0);
    await send(
      rollup,
      instructions.coverShortfallRange(PERP, 2, 256),
      stranger,
    );
    await custodyMatchesLedger();
  });

  it("refuses a first deposit below the minimum, takes a seat at the minimum, and gives it back when the seat is emptied", async () => {
    const minimum = 10n * USD;
    await send(
      rollup,
      instructions.updateExchange(admin.publicKey, {
        ...settings(),
        minSeatDeposit: minimum,
      }),
      admin,
    );
    try {
      const fresh = await openedTrader();
      await fundedWith(fresh, mints.nUSD, 30n * USD);
      const custody = () => balanceOf(addresses.custody(custodyOf(mints.nUSD)));
      const before = await custody();
      const ledgerBefore = await ledgerThroughThePort();
      await refuses(
        deposit(fresh, 5n * USD),
        "SeatDepositTooSmall",
        "below the minimum",
      );
      await refuses(
        send(
          rollup,
          instructions.deposit(
            fresh.owner.publicKey,
            tokenAccount(fresh, mints.nUSD),
            custodyOf(mints.nUSD),
            fresh.owner.publicKey,
            { spot: NUSD },
            minimum,
          ),
          fresh.owner,
        ),
        "SeatDepositTooSmall",
        "spot",
      );
      expect(await custody(), "no token moved").to.equal(before);
      expect((await ledgerThroughThePort()).openSeats).to.equal(
        ledgerBefore.openSeats,
      );

      await deposit(fresh, minimum);
      const taken = (await viewThroughThePort(fresh.owner.publicKey)).seat;
      expect(taken).to.not.equal(NO_SEAT);
      expect(taken, "the head of the free list").to.equal(firstNew);
      fresh.seat = taken;
      const price = await freshMark(PERP);
      const placed = landed(
        await fresh.client.placeOrder(
          PERP,
          order(
            SIDE.bid,
            ORDER_TYPE.postOnly,
            price - 10n * 100n,
            leastLots(price),
          ),
        ),
      );
      expect(placed.status).to.equal(RESULT_STATUS.rested);
      await fresh.client.cancelAll(PERP);

      await send(
        rollup,
        instructions.withdraw(
          fresh.owner.publicKey,
          tokenAccount(fresh, mints.nUSD),
          custodyOf(mints.nUSD),
          COLLATERAL,
          minimum,
          [PERP],
        ),
        fresh.owner,
      );
      expect(
        (await viewThroughThePort(fresh.owner.publicKey)).seat,
        "the withdrawal that empties the seat gives it back",
      ).to.equal(NO_SEAT);
      expect((await ledgerThroughThePort()).openSeats).to.equal(
        ledgerBefore.openSeats,
      );
      await refuses(
        attempted(
          fresh,
          placing(
            fresh,
            PERP,
            order(
              SIDE.bid,
              ORDER_TYPE.postOnly,
              price - 1_000n,
              leastLots(price),
            ),
          ),
        ),
        "NotSeated",
      );
      await deposit(fresh, minimum);
      expect((await viewThroughThePort(fresh.owner.publicKey)).seat).to.equal(
        taken,
      );
    } finally {
      await send(
        rollup,
        instructions.updateExchange(admin.publicKey, {
          ...settings(),
          minSeatDeposit: 0n,
        }),
        admin,
      );
    }
    await custodyMatchesLedger();
  });

  it("sweeps the whole capacity for empty seats and leaves every funded or pinned seat as it was", async () => {
    const before = await ledgerThroughThePort();
    const capacity = before.seats.length;
    for (let start = 2; start < capacity; start += 2_048) {
      await send(
        rollup,
        instructions.releaseEmptySeats(
          stranger.publicKey,
          start,
          Math.min(2_048, capacity - start),
        ),
        stranger,
      );
    }
    const after = await ledgerThroughThePort();
    before.seats.forEach((seat, index) => {
      const holds =
        seat.collateral !== 0n ||
        seat.spot.some((s) => s.available !== 0n || s.locked !== 0n) ||
        seat.positions.some(
          (p) => p.base !== 0n || p.quote !== 0n || p.openOrders > 0,
        );
      const pinned =
        seat.makerMarkets !== 0n || seat.takerMarkets !== 0n || seat.blocked;
      if (index < 2 || (seat.status === 1 && (holds || pinned))) {
        expect(after.seats[index], `seat ${index}`).to.deep.equal(seat);
      }
    });
    await custodyMatchesLedger();
  });

  it("clears the lists of the seats it kept, which the access audit after it expects clear", async () => {
    for (const trader of [earlierState.listed, earlierState.blocked]) {
      await send(
        rollup,
        instructions.setSeatAccess(
          admin.publicKey,
          trader.owner.publicKey,
          NOBODY,
          [PERP],
        ),
        admin,
      );
    }
    const { seats } = await ledgerThroughThePort();
    for (const trader of [earlierState.listed, earlierState.blocked]) {
      expect(seats[trader.seat].takerMarkets).to.equal(0n);
      expect(seats[trader.seat].blocked).to.equal(false);
    }
  });
});

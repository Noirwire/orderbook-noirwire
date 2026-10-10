import { expect } from "chai";
import {
  FEE_SEAT,
  ORDER_TYPE,
  RESULT_STATUS,
  SIDE,
  ownFills,
  randomSecret,
} from "../../sdk/dist/index.js";
import {
  addresses,
  balanceOf,
  instructions,
  ledgerThroughThePort,
  publicStats,
  publicTape,
  rollup,
  rollupNow,
  send,
  until,
} from "../support";
import {
  ENGINE_ORDER_NOT_FOUND,
  LOT,
  MARK,
  NSOL,
  NUSD,
  PERP,
  SOL,
  SPOT,
  USD,
  cast,
  custodyMatchesLedger,
  landed,
  mints,
  order,
  refuses,
  tokenAccount,
} from "./world";

describe("spot money, end to end", () => {
  let askSeq: bigint;

  it("fills a bid against the resting ask at the ask's price, pays the fee to the fee seat, and prints receipts both sides recognise", async () => {
    const { alice, bob } = cast;
    const ledgerBefore = await ledgerThroughThePort();
    const ask = await bob.client.placeOrder(
      SPOT,
      order(SIDE.ask, ORDER_TYPE.limit, MARK, 1_000n),
    );
    askSeq = landed(ask).orderSeq;
    const bid = await alice.client.placeOrder(
      SPOT,
      order(SIDE.bid, ORDER_TYPE.limit, MARK + 1_000n, 400n),
    );
    const filled = landed(bid);
    expect(filled.status).to.equal(RESULT_STATUS.filled);
    expect(filled.filled).to.equal(400n);
    expect(filled.filledNotional).to.equal(400n * MARK);
    expect(filled.fee).to.equal(30_000n);

    const ledger = await ledgerThroughThePort();
    const before = (seat: number) => ledgerBefore.seats[seat];
    expect(ledger.seats[alice.seat].spot[NUSD].available).to.equal(
      before(alice.seat).spot[NUSD].available - 400n * MARK - 30_000n,
    );
    expect(ledger.seats[alice.seat].spot[NSOL].available).to.equal(400n * LOT);
    expect(ledger.seats[bob.seat].spot[NSOL].locked).to.equal(600n * LOT);
    expect(ledger.seats[bob.seat].spot[NSOL].available).to.equal(
      before(bob.seat).spot[NSOL].available - 1_000n * LOT,
    );
    expect(ledger.seats[bob.seat].spot[NUSD].available).to.equal(
      before(bob.seat).spot[NUSD].available + 400n * MARK,
    );
    expect(ledger.seats[FEE_SEAT].spot[NUSD].available).to.equal(
      before(FEE_SEAT).spot[NUSD].available + 30_000n,
    );

    const tape = await publicTape(SPOT);
    expect(tape.fills[0].price).to.equal(MARK);
    expect(tape.fills[0].size).to.equal(400n);
    expect(
      ownFills(tape.fills, [bid.secret]).map((own) => own.role),
    ).to.deep.equal(["taker"]);
    expect(
      ownFills(tape.fills, [ask.secret]).map((own) => own.role),
    ).to.deep.equal(["maker"]);
    expect(ownFills(tape.fills, [randomSecret()])).to.have.length(0);
    const stats = await publicStats();
    expect(stats.fills).to.equal(1n);
    expect(stats.volume[SPOT]).to.equal(400n * MARK);
    await custodyMatchesLedger();
  });

  it("shows the maker the fill only after a sync, with the seat's version moved on", async () => {
    const { bob } = cast;
    const stale = await bob.client.view();
    expect(stale.snapshot.seat.spot[NUSD].available).to.not.equal(
      (await ledgerThroughThePort()).seats[bob.seat].spot[NUSD].available,
    );
    await bob.client.syncView(SPOT);
    const synced = await bob.client.view();
    expect(synced.snapshot.seat.version > stale.snapshot.seat.version).to.equal(
      true,
    );
    expect(synced.snapshot.seat.spot[NUSD].available).to.equal(
      (await ledgerThroughThePort()).seats[bob.seat].spot[NUSD].available,
    );
    expect(
      synced.snapshot.orders.map((entry) => entry.remaining),
    ).to.deep.equal([600n]);
  });

  it("cancels the resting remainder and releases exactly what was locked, and reports a gone order as an outcome", async () => {
    const { bob } = cast;
    const cancelled = await bob.client.cancelOrder(SPOT, askSeq);
    expect(cancelled.cancelled).to.equal(1n);
    const seat = (await ledgerThroughThePort()).seats[bob.seat];
    expect(seat.spot[NSOL].locked).to.equal(0n);
    expect(seat.spot[NSOL].available).to.equal(10n * SOL - 400n * LOT);
    const gone = await bob.client.cancelOrder(SPOT, askSeq);
    expect(gone.status).to.equal(RESULT_STATUS.refused);
    expect(gone.code).to.equal(ENGINE_ORDER_NOT_FOUND);
    await custodyMatchesLedger();
  });

  it("cancels a resting order whose own expiry has passed when matching reaches it, instead of filling it", async () => {
    const { alice, bob } = cast;
    const expiry = BigInt((await rollupNow()) + 1);
    const restingBid = () =>
      order(SIDE.bid, ORDER_TYPE.limit, MARK - 2_000n, 10n);
    const untimed = landed(
      await alice.client.placeOrder(SPOT, restingBid(), {
        secret: randomSecret(),
      }),
    );
    expect(untimed.status).to.equal(RESULT_STATUS.rested);
    await alice.client.cancelOrder(SPOT, untimed.orderSeq);
    const timed = landed(
      await alice.client.placeOrder(SPOT, { ...restingBid(), expiry }),
    );
    expect(timed.status).to.equal(RESULT_STATUS.rested);
    expect((await alice.client.view()).snapshot.orders[0].expiry).to.equal(
      expiry,
    );
    await until(
      async () => (await rollupNow()) > Number(expiry),
      "the rollup clock to pass the order's expiry",
      30_000,
      50,
    );
    const ask = landed(
      await bob.client.placeOrder(
        SPOT,
        order(SIDE.ask, ORDER_TYPE.immediateOrCancel, MARK - 2_000n, 10n),
      ),
    );
    expect(ask.filled).to.equal(0n);
    await alice.client.syncView(SPOT);
    expect((await alice.client.view()).snapshot.orders).to.have.length(0);
    expect(
      (await ledgerThroughThePort()).seats[alice.seat].spot[NUSD].locked,
    ).to.equal(0n);
    await custodyMatchesLedger();
  });

  it("sells into a resting bid, and a cancel of what is left returns the lock", async () => {
    const { alice, bob } = cast;
    const bid = landed(
      await alice.client.placeOrder(
        SPOT,
        order(SIDE.bid, ORDER_TYPE.limit, MARK - 1_000n, 100n),
      ),
    );
    expect(bid.status).to.equal(RESULT_STATUS.rested);
    const ask = landed(
      await bob.client.placeOrder(
        SPOT,
        order(SIDE.ask, ORDER_TYPE.immediateOrCancel, MARK - 1_000n, 40n),
      ),
    );
    expect(ask.filled).to.equal(40n);
    expect(ask.fee).to.equal(2_980n);
    const left = await alice.client.cancelAll(SPOT);
    expect(left.cancelled).to.equal(1n);
    const seat = (await ledgerThroughThePort()).seats[alice.seat];
    expect(seat.spot[NUSD].locked).to.equal(0n);
    expect(seat.spot[NSOL].available).to.equal(440n * LOT);
    await custodyMatchesLedger();
  });

  it("withdraws inside the rollup, to the owner's own token account, what the seat has available", async () => {
    const { alice, bob } = cast;
    const to = tokenAccount(alice, mints.nUSD);
    const withdrawal = (amount: bigint, into = to) =>
      send(
        rollup,
        instructions.withdraw(
          alice.owner.publicKey,
          into,
          mints.nUSD,
          { spot: NUSD },
          amount,
          [PERP],
        ),
        alice.owner,
      );
    const before = await balanceOf(to);
    const custodyBefore = await balanceOf(addresses.custody(mints.nUSD));
    await withdrawal(50n * USD);
    expect((await balanceOf(to)) - before).to.equal(50n * USD);
    expect(
      custodyBefore - (await balanceOf(addresses.custody(mints.nUSD))),
    ).to.equal(50n * USD);
    expect(
      (await alice.client.view()).snapshot.seat.spot[NUSD].available,
    ).to.equal(
      (await ledgerThroughThePort()).seats[alice.seat].spot[NUSD].available,
    );
    await refuses(
      withdrawal(1n, tokenAccount(bob, mints.nUSD)),
      "WrongTokenAccountOwner",
    );
    await refuses(withdrawal(10_000n * USD), "InsufficientBalance");
    await custodyMatchesLedger();
  });
});

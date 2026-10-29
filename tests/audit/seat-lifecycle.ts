/**
 * The seat's life and the market slots, on the local network. It proves:
 *
 * 1. A seat holds orders on four markets at once: a fifth is refused with
 *    `SlotsFull` and leaves the seat byte for byte as it was, and a market
 *    whose orders are gone gives its slot to the fifth.
 * 2. A view with no seat is refused every order with `NotSeated`, `sync_view`
 *    repairs it, and a deposit gives it a seat.
 * 3. The withdrawal that empties a seat gives it back, and the next trader's
 *    first deposit takes the same index with a higher version.
 * 4. A seat that is pinned stays through the sweep and the withdrawal; once
 *    its lists are cleared the sweep gives it back, and the owner's view is
 *    repaired by `sync_view` while the index it records may be someone else's.
 *
 * Runs after the story and leaves its seats funded as it found them.
 */
import { expect } from "chai";
import {
  NO_SEAT,
  ORDER_TYPE,
  RESULT_STATUS,
  SIDE,
  freeSeats,
  setupMarket,
  type Seat,
} from "../../sdk/dist/index.js";
import {
  PROGRAM_ID,
  addresses,
  admin,
  balanceOf,
  instructions,
  ledgerThroughThePort,
  rollup,
  rollupNow,
  send,
  viewThroughThePort,
} from "../support";
import {
  COLLATERAL,
  MARK,
  NUSD,
  PERP,
  SPOT,
  TICK,
  TINY,
  USD,
  VIA_FILTER,
  attempted,
  custodyMatchesLedger,
  custodyOf,
  deposited,
  freshMark,
  fundedTrader,
  fundedWith,
  landed,
  leastLots,
  mints,
  openedTrader,
  order,
  placing,
  refuses,
  seatRecorded,
  spotMarket,
  stranger,
  tokenAccount,
  withdrawCollateral,
  PERP_BIT,
  type Trader,
} from "../orderbook/world";

const FIFTH_SPOT = 7;

const seatOf = async (trader: Trader): Promise<Seat> =>
  (await ledgerThroughThePort()).seats[await seatRecorded(trader)];

const seatAccess = (trader: Trader, access: object) =>
  send(
    rollup,
    instructions.setSeatAccess(
      admin.publicKey,
      trader.owner.publicKey,
      {
        makerMarkets: 0n,
        takerMarkets: 0n,
        blocked: false,
        ...access,
      },
      [PERP],
    ),
    admin,
  );

const priced = async (marketId: number) =>
  send(
    rollup,
    [
      instructions.resetPrice(
        admin.publicKey,
        marketId,
        MARK,
        BigInt(await rollupNow()),
      ),
      instructions.resumeMarket(admin.publicKey, marketId, [PERP]),
    ],
    admin,
  );

/**
 * Funds new traders with one deposit each until one takes seat `index`: the
 * free list hands out the seat freed last, so a sweep that gave several back
 * puts the one wanted somewhere down the list. The others hold `1 USD` each.
 */
async function takenUntil(
  index: number,
  amount: bigint,
): Promise<{ taker: Trader; others: Trader[] }> {
  const others: Trader[] = [];
  for (let tries = 0; tries < 64; tries += 1) {
    const candidate = await fundedTrader(tries === 0 ? amount : 1n * USD);
    if (candidate.seat === index) return { taker: candidate, others };
    others.push(candidate);
  }
  throw new Error(`no deposit took seat ${index}`);
}

describe("audit: the seat's life and the market slots", () => {
  it("holds orders on four markets, refuses a fifth with SlotsFull and the seat unchanged, and gives a emptied market's slot to it", async () => {
    await setupMarket(rollup, admin, FIFTH_SPOT, spotMarket(), PROGRAM_ID);
    for (const marketId of [VIA_FILTER, FIFTH_SPOT]) await priced(marketId);

    const price = await freshMark(PERP);
    const trader = await fundedTrader(100n * USD);
    await fundedWith(trader, mints.nUSD, 60n * USD);
    await deposited(trader, mints.nUSD, { spot: NUSD }, 60n * USD);
    const bidAt = MARK - 5n * TICK;
    const resting = [SPOT, TINY, VIA_FILTER, FIFTH_SPOT];
    for (const marketId of resting) {
      const rested = landed(
        await trader.client.placeOrder(
          marketId,
          order(SIDE.bid, ORDER_TYPE.postOnly, bidAt, 10n),
        ),
      );
      expect(rested.status, `market ${marketId}`).to.equal(
        RESULT_STATUS.rested,
      );
    }

    const before = await seatOf(trader);
    expect(
      before.positions.filter((position) => position.openOrders > 0),
    ).to.have.length(4);
    await refuses(
      attempted(
        trader,
        placing(
          trader,
          PERP,
          order(
            SIDE.bid,
            ORDER_TYPE.postOnly,
            price - 10n * TICK,
            leastLots(price),
          ),
        ),
      ),
      "SlotsFull",
      "a fifth market",
    );
    expect(
      await seatOf(trader),
      "a refused order leaves the seat as it was",
    ).to.deep.equal(before);

    expect((await trader.client.cancelAll(FIFTH_SPOT)).cancelled).to.equal(1n);
    const taken = landed(
      await trader.client.placeOrder(
        PERP,
        order(
          SIDE.bid,
          ORDER_TYPE.postOnly,
          price - 10n * TICK,
          leastLots(price),
        ),
      ),
    );
    expect(
      taken.status,
      "the emptied market's slot goes to the fifth",
    ).to.equal(RESULT_STATUS.rested);
    for (const marketId of [SPOT, TINY, VIA_FILTER, PERP]) {
      await trader.client.cancelAll(marketId);
    }
    await custodyMatchesLedger();
  });

  it("refuses an order from a view with no seat, repairs it with sync_view, and seats it on a deposit", async () => {
    const trader = await openedTrader();
    await fundedWith(trader, mints.nUSD, 3n * USD);
    const price = await freshMark(PERP);
    const rest = () =>
      attempted(
        trader,
        placing(
          trader,
          PERP,
          order(
            SIDE.bid,
            ORDER_TYPE.postOnly,
            price - 10n * TICK,
            leastLots(price),
          ),
        ),
      );
    await refuses(rest(), "NotSeated");
    await refuses(withdrawCollateral(trader, 1n), "NotSeated");
    const unseated = await trader.client.confirmSeat();
    expect(unseated.seated).to.equal(false);
    expect(unseated.view.seat).to.equal(NO_SEAT);

    await deposited(trader, mints.nUSD, COLLATERAL, 3n * USD);
    const seated = await trader.client.confirmSeat();
    expect(seated.seated).to.equal(true);
    expect(seated.view.snapshot.seat.collateral).to.equal(3n * USD);
    const accepted = landed(
      await trader.client.placeOrder(
        PERP,
        order(
          SIDE.bid,
          ORDER_TYPE.postOnly,
          price - 10n * TICK,
          leastLots(price),
        ),
      ),
    );
    expect(accepted.status).to.equal(RESULT_STATUS.rested);
    await trader.client.cancelAll(PERP);
  });

  it("gives a seat back when the withdrawal empties it, and the next trader's first deposit takes the same index", async () => {
    const leaver = await fundedTrader(5n * USD);
    const index = leaver.seat;
    const held = (await ledgerThroughThePort()).seats[index];
    await withdrawCollateral(leaver, 5n * USD);
    const ledger = await ledgerThroughThePort();
    expect(ledger.seats[index].status).to.equal(0);
    expect(ledger.seats[index].version > held.version).to.equal(true);
    expect(freeSeats(ledger)[0]).to.equal(index);
    expect((await viewThroughThePort(leaver.owner.publicKey)).seat).to.equal(
      NO_SEAT,
    );
    expect(await balanceOf(tokenAccount(leaver, mints.nUSD))).to.equal(
      5n * USD,
    );

    const arrival = await fundedTrader(5n * USD);
    expect(arrival.seat).to.equal(index);
    const retaken = (await ledgerThroughThePort()).seats[index];
    expect(retaken.version > held.version + 1n).to.equal(true);
    expect(retaken.owner.equals(arrival.owner.publicKey)).to.equal(true);
    await withdrawCollateral(arrival, 5n * USD);
    await custodyMatchesLedger();
  });

  it("keeps a pinned seat through the withdrawal and the sweep, gives it back once unpinned, and repairs the owner's view by sync_view", async () => {
    const sweep = () =>
      send(
        rollup,
        instructions.releaseEmptySeats(stranger.publicKey, 2, 2_046),
        stranger,
      );
    const pinned = await fundedTrader(5n * USD);
    const index = pinned.seat;
    await seatAccess(pinned, { makerMarkets: PERP_BIT });
    await withdrawCollateral(pinned, 5n * USD);
    expect(
      (await ledgerThroughThePort()).seats[index].status,
      "pinned: the withdrawal keeps the seat",
    ).to.equal(1);
    await sweep();
    expect((await ledgerThroughThePort()).seats[index].status).to.equal(1);

    await seatAccess(pinned, {});
    expect(
      (await ledgerThroughThePort()).seats[index].status,
      "unpinning alone releases nothing",
    ).to.equal(1);
    const owner = pinned.owner.publicKey;
    await refuses(
      send(
        rollup,
        instructions.closeUnusedTrader(admin.publicKey, owner),
        admin,
      ),
      "SeatUsed",
    );
    await sweep();
    expect((await ledgerThroughThePort()).seats[index].status).to.equal(0);
    expect(
      (await viewThroughThePort(owner)).seat,
      "the sweep cannot write the view",
    ).to.equal(index);

    const { taker: newcomer, others } = await takenUntil(index, 4n * USD);
    expect(newcomer.seat, "the sweep gave the index back").to.equal(index);
    const theirs = (await ledgerThroughThePort()).seats[index];
    await fundedWith(pinned, mints.nUSD, 1n * USD);
    const small = () => deposited(pinned, mints.nUSD, COLLATERAL, 1n * USD);
    const before = await balanceOf(addresses.custody(custodyOf(mints.nUSD)));
    await small();
    expect(
      (await ledgerThroughThePort()).seats[index],
      "a deposit into a stale view never credits the index's new owner",
    ).to.deep.equal(theirs);
    expect(await seatRecorded(pinned)).to.not.equal(index);
    expect(await balanceOf(addresses.custody(custodyOf(mints.nUSD)))).to.equal(
      before + 1n * USD,
    );
    await custodyMatchesLedger();

    await withdrawCollateral(newcomer, 4n * USD);
    await withdrawCollateral(pinned, 1n * USD);
    for (const other of others) await withdrawCollateral(other, 1n * USD);
  });

  it("closes a view whose seat the sweep gave away without touching the new owner's seat, and syncs it to no seat", async () => {
    const left = await fundedTrader(5n * USD);
    const index = left.seat;
    await seatAccess(left, { blocked: true });
    await withdrawCollateral(left, 5n * USD);
    await seatAccess(left, {});
    await send(
      rollup,
      instructions.releaseEmptySeats(stranger.publicKey, 2, 2_046),
      stranger,
    );
    const { taker: holder, others } = await takenUntil(index, 6n * USD);
    expect(holder.seat).to.equal(index);
    const mine = (await ledgerThroughThePort()).seats[index];
    await send(
      rollup,
      instructions.closeTrader(left.owner.publicKey),
      left.owner,
    );
    expect(
      (await ledgerThroughThePort()).seats[index],
      "the new owner's seat is untouched",
    ).to.deep.equal(mine);
    expect(
      await rollup.getAccountInfo(addresses.view(left.owner.publicKey)),
    ).to.equal(null);
    await withdrawCollateral(holder, 6n * USD);
    for (const other of others) await withdrawCollateral(other, 1n * USD);
    await custodyMatchesLedger();
  });

  it("closes no funded seat: close_trader on a funded view is refused with SeatNotEmpty", async () => {
    const funded = await fundedTrader(2n * USD);
    await refuses(
      send(
        rollup,
        instructions.closeTrader(funded.owner.publicKey),
        funded.owner,
      ),
      "SeatNotEmpty",
    );
    await withdrawCollateral(funded, 2n * USD);
  });
});

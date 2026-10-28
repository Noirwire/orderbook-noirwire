/**
 * What the earlier build holds when the new one is deployed over it, beyond
 * what the story left: a maker with a resting order, a trader with a position
 * on one market and a resting order on another, a listed maker and taker, a
 * blocked seat. The story already closed a seat on the earlier build, which
 * leaves a closed seat with a bumped version between open ones. Runs on the
 * earlier build, before `upgrade-in-place`; the relayout part reads the old
 * ledger itself.
 */
import { expect } from "chai";
import { ORDER_TYPE, RESULT_STATUS, SIDE } from "../../sdk/dist/index.js";
import {
  admin,
  instructions,
  ledgerThroughThePort,
  rollup,
  send,
} from "../support";
import {
  NUSD,
  PERP,
  SPOT,
  TICK,
  USD,
  deposited,
  exchangeOn,
  freshMark,
  fundedTrader,
  fundedWith,
  landed,
  leastLots,
  mints,
  openedTrader,
  order,
  PERP_BIT,
  type Trader,
} from "../orderbook/world";

export const earlierState = {} as {
  maker: Trader;
  holder: Trader;
  listed: Trader;
  blocked: Trader;
};

describe("the earlier build before the upgrade", () => {
  it("holds a resting perp order, a position beside a resting spot order, a listed seat and a blocked seat", async () => {
    const price = await freshMark(PERP);
    const lots = leastLots(price);
    const maker = await fundedTrader(200n * USD);
    const holder = await fundedTrader(100n * USD);
    const listed = await fundedTrader(20n * USD);
    const blocked = await fundedTrader(10n * USD);

    const rested = landed(
      await maker.client.placeOrder(
        PERP,
        order(SIDE.ask, ORDER_TYPE.postOnly, price, 4n * lots),
      ),
    );
    expect(rested.status).to.equal(RESULT_STATUS.rested);
    const bought = landed(
      await holder.client.placeOrder(
        PERP,
        order(SIDE.bid, ORDER_TYPE.immediateOrCancel, price, 2n * lots),
      ),
    );
    expect(bought.filled).to.equal(2n * lots);

    const spotMark = await freshMark(SPOT);
    await fundedWith(holder, mints.nUSD, 20n * USD);
    await deposited(holder, mints.nUSD, { spot: NUSD }, 20n * USD);
    const bid = landed(
      await holder.client.placeOrder(
        SPOT,
        order(SIDE.bid, ORDER_TYPE.postOnly, spotMark - 5n * TICK, 10n),
      ),
    );
    expect(bid.status).to.equal(RESULT_STATUS.rested);

    const { perpMarkets } = await exchangeOn(rollup);
    const perpMarketIds = [0, 1, 2, 3, 4, 5, 6, 7].filter(
      (id) => (perpMarkets >> id) & 1,
    );
    await send(
      rollup,
      instructions.setSeatAccess(
        admin.publicKey,
        listed.owner.publicKey,
        { makerMarkets: PERP_BIT, takerMarkets: PERP_BIT, blocked: false },
        perpMarketIds,
      ),
      admin,
    );
    await send(
      rollup,
      instructions.setSeatAccess(
        admin.publicKey,
        blocked.owner.publicKey,
        { makerMarkets: 0n, takerMarkets: 0n, blocked: true },
        perpMarketIds,
      ),
      admin,
    );
    const gap = await openedTrader();
    const behind = await openedTrader();
    expect(behind.seat).to.be.greaterThan(gap.seat);
    await send(
      rollup,
      instructions.closeTrader(gap.owner.publicKey),
      gap.owner,
    );
    Object.assign(earlierState, { maker, holder, listed, blocked });

    const { seats } = await ledgerThroughThePort();
    expect(seats[listed.seat].takerMarkets).to.equal(PERP_BIT);
    expect(seats[blocked.seat].blocked).to.equal(true);
    expect(
      seats.some((seat) => seat.status === 0 && seat.version > 1n),
      "a closed seat with a bumped version",
    ).to.equal(true);
  });
});

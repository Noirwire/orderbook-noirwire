import { expect } from "chai";
import { ComputeBudgetProgram } from "@solana/web3.js";
import {
  MAX_COMPUTE_UNITS,
  MAX_FIRES_PER_PASS,
  ORDER_TYPE,
  RESULT_STATUS,
  SIDE,
  TRIGGER_KIND,
  decodePriceFeed,
  decodeTriggerBook,
  ownFills,
  positionOn,
  randomSecret,
} from "../../sdk/dist/index.js";
import { send as sentAsBuilt } from "../../ops/sending";
import {
  addresses,
  computeUnits,
  inPublic,
  instructions,
  ledgerThroughThePort,
  publicTape,
  rollup,
  rollupNow,
  send,
  throughThePort,
  until,
} from "../support";
import {
  PERP,
  USD,
  custodyMatchesLedger,
  exchangeOn,
  freshMark,
  fundedTrader,
  landed,
  leastLots,
  openInterestMatchesBook,
  oracle,
  order,
  stranger,
  type Trader,
} from "./world";

/** How far under the mark a stop sits, and how far under it the stop's order will sell. */
const STOP_BELOW = 1_000n;
const WORST_BELOW = 3_000n;
/** Where the resting bids sit, between the stop and the worst price. */
const BID_BELOW = 500n;
/** How far past the stop the mark is moved, and how far past the take-profit. */
const PAST = 1_500n;
const BIDS_PER_MAKER = 24;
/** The resting bids each fired order crosses in the compute measurement. */
const DEPTH = 16n;
/** The seats of the fairness cursor's window, which sets how many passes drain a book. */
const FAIR_WINDOW = 64;
/** The compute units a pass must stay under, well inside the 1.4 million a transaction may ask for. */
const MAX_PASS_COMPUTE_UNITS = 1_000_000;

const triggerBook = async () =>
  decodeTriggerBook(await throughThePort(addresses.triggers(PERP)));

const baseOf = async (trader: Trader) =>
  positionOn((await ledgerThroughThePort()).seats[trader.seat], PERP).base;

/** Moves the perp's mark to `price` once the rollup clock has passed the last accepted price. */
async function markMovedTo(price: bigint): Promise<void> {
  const { acceptedAt } = decodePriceFeed(
    await inPublic(addresses.priceFeed(PERP)),
  );
  await until(
    async () => (await rollupNow()) > Number(acceptedAt),
    "the rollup clock to pass the last accepted price",
    30_000,
    50,
  );
  await send(
    rollup,
    instructions.publishPrice(
      oracle.publicKey,
      PERP,
      price,
      BigInt(await rollupNow()),
    ),
    oracle,
  );
}

const fired = () =>
  send(
    rollup,
    instructions.fireTriggers(PERP, MAX_FIRES_PER_PASS, [PERP]),
    stranger,
  );

const stop = (mark: bigint, trigger = mark - STOP_BELOW) => ({
  kind: TRIGGER_KIND.stopLoss,
  triggerPrice: trigger,
  worstPrice: mark - WORST_BELOW,
  size: 0n,
});

describe("take-profit and stop-loss triggers, end to end", () => {
  let seller: Trader;
  let buyer: Trader;
  let holder: Trader;
  let later: Trader;
  let mark: bigint;
  let lots: bigint;
  let stopSecret: Uint8Array;
  let takeProfitSecret: Uint8Array;

  const longOpened = async (trader: Trader) => {
    const ask = landed(
      await seller.client.placeOrder(
        PERP,
        order(SIDE.ask, ORDER_TYPE.postOnly, mark, lots),
      ),
    );
    expect(ask.status).to.equal(RESULT_STATUS.rested);
    const bid = landed(
      await trader.client.placeOrder(
        PERP,
        order(SIDE.bid, ORDER_TYPE.limit, mark, lots),
      ),
    );
    expect(bid.status).to.equal(RESULT_STATUS.filled);
    expect(await baseOf(trader)).to.equal(lots);
  };

  const bidRested = async (size = lots) => {
    const bid = order(SIDE.bid, ORDER_TYPE.postOnly, mark - BID_BELOW, size);
    const rested = landed(await buyer.client.placeOrder(PERP, bid));
    expect(rested.status).to.equal(RESULT_STATUS.rested);
    return bid;
  };

  before(async () => {
    seller = await fundedTrader(100n * USD);
    buyer = await fundedTrader(100n * USD);
    holder = await fundedTrader(20n * USD);
    later = await fundedTrader(20n * USD);
  });

  beforeEach(async () => {
    mark = await freshMark(PERP);
    lots = leastLots(mark) * 4n;
  });

  it("sets a take-profit and a stop-loss on an open position, replaces one, and cancels one", async () => {
    await longOpened(holder);
    const set = await holder.client.setTrigger(PERP, stop(mark));
    expect(set.status, `refused with error ${set.code}`).to.not.equal(
      RESULT_STATUS.refused,
    );
    expect(set.cancelled).to.equal(0n);
    const takeProfit = await holder.client.setTrigger(PERP, {
      kind: TRIGGER_KIND.takeProfit,
      triggerPrice: mark + STOP_BELOW,
      worstPrice: mark - WORST_BELOW,
      size: 0n,
    });
    expect(
      takeProfit.status,
      `refused with error ${takeProfit.code}`,
    ).to.not.equal(RESULT_STATUS.refused);
    takeProfitSecret = takeProfit.secret;
    const held = (await triggerBook()).slots[holder.seat];
    expect(held.stopLoss.active).to.equal(true);
    expect(held.stopLoss.triggerPrice).to.equal(mark - STOP_BELOW);
    expect(held.takeProfit.active).to.equal(true);
    expect(held.takeProfit.triggerPrice).to.equal(mark + STOP_BELOW);

    const replaced = await holder.client.setTrigger(
      PERP,
      stop(mark, mark - STOP_BELOW - 200n),
    );
    expect(
      replaced.cancelled,
      "a trigger of the same kind was replaced",
    ).to.equal(1n);
    stopSecret = replaced.secret;
    expect(
      (await triggerBook()).slots[holder.seat].stopLoss.triggerPrice,
    ).to.equal(mark - STOP_BELOW - 200n);

    const cancelled = await holder.client.cancelTrigger(
      PERP,
      TRIGGER_KIND.takeProfit,
    );
    expect(cancelled.cancelled).to.equal(1n);
    const after = (await triggerBook()).slots[holder.seat];
    expect(after.takeProfit.active).to.equal(false);
    expect(after.stopLoss.active).to.equal(true);
    const again = await holder.client.cancelTrigger(
      PERP,
      TRIGGER_KIND.takeProfit,
    );
    expect(again.cancelled, "nothing was there to cancel").to.equal(0n);
  });

  it("never fires a cancelled take-profit, fires the stop when the mark moves through it, and prints the fill with the trigger's receipt", async () => {
    const bid = await bidRested();
    const before = await publicTape(PERP);

    await markMovedTo(mark + PAST);
    await fired();
    expect(await baseOf(holder), "the cancelled take-profit").to.equal(lots);
    expect((await publicTape(PERP)).lastFillSeq).to.equal(before.lastFillSeq);

    await markMovedTo(mark - PAST);
    await fired();
    expect(await baseOf(holder), "the stop closed the position").to.equal(0n);

    const tape = await publicTape(PERP);
    const own = ownFills(tape.fills, [stopSecret]);
    expect(own).to.have.length(1);
    expect(own[0].role).to.equal("taker");
    expect(own[0].fill.size).to.equal(lots);
    expect(own[0].fill.price).to.equal(mark - BID_BELOW);
    expect(own[0].fill.fillSeq > before.lastFillSeq).to.equal(true);
    const resting = ownFills(tape.fills, [bid.secret]);
    expect(resting.map(({ role }) => role)).to.deep.equal(["maker"]);
    expect(resting[0].fill.fillSeq).to.equal(own[0].fill.fillSeq);
    expect(ownFills(tape.fills, [randomSecret()])).to.have.length(0);
    expect(ownFills(tape.fills, [takeProfitSecret])).to.have.length(0);

    await markMovedTo(mark);
    await openInterestMatchesBook();
    await custodyMatchesLedger();
  });

  it("does not fire a trigger set on one position on a later position of the same seat", async () => {
    await longOpened(later);
    const set = await later.client.setTrigger(PERP, stop(mark));
    expect(set.status, `refused with error ${set.code}`).to.not.equal(
      RESULT_STATUS.refused,
    );
    await bidRested();
    const closed = landed(
      await later.client.placeOrder(
        PERP,
        order(SIDE.ask, ORDER_TYPE.limit, mark - BID_BELOW, lots),
      ),
    );
    expect(closed.status).to.equal(RESULT_STATUS.filled);
    expect(await baseOf(later)).to.equal(0n);

    await longOpened(later);
    await bidRested();
    const before = await publicTape(PERP);
    await markMovedTo(mark - PAST);
    await fired();
    expect(await baseOf(later), "the new position is untouched").to.equal(lots);
    const tape = await publicTape(PERP);
    expect(tape.lastFillSeq).to.equal(before.lastFillSeq);
    expect(ownFills(tape.fills, [set.secret])).to.have.length(0);

    await markMovedTo(mark);
    await buyer.client.cancelAll(PERP);
    await openInterestMatchesBook();
    await custodyMatchesLedger();
  });

  it("closes 4 due stops that each cross many resting orders in passes that each stay under a million compute units", async function () {
    this.timeout(1_800_000);
    const fires = MAX_FIRES_PER_PASS;
    const unit = leastLots(mark);
    const position = unit * DEPTH;
    const bids = BigInt(fires) * DEPTH;
    const makerCount = Math.ceil(Number(bids) / BIDS_PER_MAKER);

    const ask = landed(
      await seller.client.placeOrder(
        PERP,
        order(SIDE.ask, ORDER_TYPE.postOnly, mark, position * BigInt(fires)),
      ),
    );
    expect(ask.status).to.equal(RESULT_STATUS.rested);
    const traders: Trader[] = [];
    for (let nth = 0; nth < fires; nth += 1) {
      const trader = await fundedTrader(5n * USD);
      const bought = landed(
        await trader.client.placeOrder(
          PERP,
          order(SIDE.bid, ORDER_TYPE.limit, mark, position),
        ),
      );
      expect(bought.status).to.equal(RESULT_STATUS.filled);
      const set = await trader.client.setTrigger(PERP, stop(mark));
      expect(set.status, `stop ${nth} refused with ${set.code}`).to.not.equal(
        RESULT_STATUS.refused,
      );
      traders.push(trader);
    }

    let resting = 0n;
    for (let nth = 0; nth < makerCount; nth += 1) {
      const maker = await fundedTrader(30n * USD);
      for (
        let placed = 0;
        placed < BIDS_PER_MAKER && resting < bids;
        placed += 1
      ) {
        const rested = landed(
          await maker.client.placeOrder(
            PERP,
            order(SIDE.bid, ORDER_TYPE.postOnly, mark - BID_BELOW, unit),
          ),
        );
        expect(rested.status).to.equal(RESULT_STATUS.rested);
        resting += 1n;
      }
    }

    const { seatCapacity } = await exchangeOn(rollup);
    if (seatCapacity === null) throw new Error("the exchange is not live");
    const mostPasses = Math.ceil(seatCapacity / FAIR_WINDOW) + 2;
    await markMovedTo(mark - PAST);
    const allFlat = async () => {
      const { seats } = await ledgerThroughThePort();
      return traders.every(
        (trader) => positionOn(seats[trader.seat], PERP).base === 0n,
      );
    };
    for (let pass = 1; pass <= mostPasses; pass += 1) {
      const signature = await sentAsBuilt(
        rollup,
        [
          ComputeBudgetProgram.setComputeUnitLimit({
            units: MAX_COMPUTE_UNITS,
          }),
          instructions.fireTriggers(PERP, fires, [PERP]),
        ],
        stranger,
      );
      const units = await computeUnits(signature);
      console.log(`fire_triggers pass ${pass}: ${units} compute units`);
      expect(units, `pass ${pass} compute units`).to.be.lessThan(
        MAX_PASS_COMPUTE_UNITS,
      );
      if (await allFlat()) break;
    }
    expect(await allFlat(), "every stop closed its position").to.equal(true);
    await markMovedTo(mark);
    await openInterestMatchesBook();
    await custodyMatchesLedger();
  });
});

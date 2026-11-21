import { expect } from "chai";
import { ComputeBudgetProgram, Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import {
  MAX_COMPUTE_UNITS,
  MAX_FIRES_PER_PASS,
  MAX_SEATS,
  ORDER_TYPE,
  OrderKeyManager,
  PERP_TRIGGER_BOOK_LEN,
  RESULT_STATUS,
  SIDE,
  TRIGGER_KIND,
  TraderClient,
  decodePriceFeed,
  decodeTriggerBookHeader,
  ownFills,
  ownerActionMessage,
  positionOn,
  randomSecret,
} from "../../sdk/dist/index.js";
import { send as sentAsBuilt } from "../../ops/sending";
import {
  PROGRAM_ID,
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
  viewThroughThePort,
} from "../support";
import {
  PERP,
  TICK,
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
  orderKeySeed,
  refuses,
  soon,
  stranger,
  type Trader,
} from "./world";
import { decodeTriggerBook } from "../trigger-book";

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

const seatEpochOf = async (trader: Trader) =>
  (await ledgerThroughThePort()).seats[trader.seat].seatEpoch;

const triggerStatusOf = async (trader: Trader) => {
  await trader.client.syncView(PERP);
  const { triggerStatus } = (await trader.client.view()).snapshot;
  if (!triggerStatus) throw new Error("the view carries no trigger status");
  return triggerStatus;
};

const rekeyedClients: TraderClient[] = [];

// A client that made a call holds a websocket, which would keep the run alive.
after(() => rekeyedClients.forEach((client) => client.close()));

/** Hands `trader` the client that signs with `keys`, once a key reset has replaced the ones it had. */
function rekeyed(trader: Trader, keys: OrderKeyManager): void {
  trader.client.close();
  trader.keys = keys;
  trader.client = new TraderClient(
    rollup,
    trader.reader,
    trader.owner.publicKey,
    keys,
    PROGRAM_ID,
  );
  rekeyedClients.push(trader.client);
}

/** The owner resets all four order keys with its own signature on the transaction. */
async function resetByOwner(trader: Trader): Promise<OrderKeyManager> {
  const fresh = OrderKeyManager.fresh(orderKeySeed());
  await send(
    rollup,
    instructions.setOrderKeys(trader.owner.publicKey, fresh.publicKeys),
    trader.owner,
  );
  return fresh;
}

/** The owner resets all four order keys with an Ed25519 signature over the reset, which anyone may send. */
async function resetBySignature(trader: Trader): Promise<OrderKeyManager> {
  const fresh = OrderKeyManager.fresh(orderKeySeed());
  const owner = trader.owner.publicKey;
  const { ownerNonce } = await viewThroughThePort(owner);
  const expiresAt = BigInt((await rollupNow()) + 90);
  const message = ownerActionMessage(
    "replace",
    PROGRAM_ID,
    owner,
    fresh.publicKeys,
    expiresAt,
    ownerNonce,
  );
  await send(
    rollup,
    [
      instructions.setOrderKeysProof(
        owner,
        fresh.publicKeys,
        ownerNonce,
        expiresAt,
        nacl.sign.detached(message, trader.owner.secretKey),
      ),
      instructions.setOrderKeysSigned(
        owner,
        fresh.publicKeys,
        ownerNonce,
        expiresAt,
      ),
    ],
    stranger,
  );
  return fresh;
}

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

  it("refuses a pass that asks to fire none and one that asks for more than the most a pass may", async () => {
    for (const budget of [0, MAX_FIRES_PER_PASS + 1]) {
      await refuses(
        send(rollup, instructions.fireTriggers(PERP, budget, [PERP]), stranger),
        "InvalidSettings",
        `a budget of ${budget}`,
      );
    }
  });

  it("keeps the trigger book at the size for the most seats a ledger holds, whatever the ledger holds now", async () => {
    const data = await throughThePort(addresses.triggers(PERP));
    expect(data.length).to.equal(PERP_TRIGGER_BOOK_LEN);
    const head = decodeTriggerBookHeader(data);
    expect(head.seatCapacity).to.equal(MAX_SEATS);
    expect(head.header.ready).to.equal(true);
    expect(
      (await exchangeOn(rollup)).seatCapacity,
      "the ledger is smaller than its largest",
    ).to.be.lessThan(MAX_SEATS);
  });

  const resetEndsTheTriggers =
    (reset: (trader: Trader) => Promise<OrderKeyManager>) => async () => {
      const trader = await fundedTrader(20n * USD);
      await longOpened(trader);
      const set = await trader.client.setTrigger(PERP, stop(mark));
      expect(set.status, `refused with error ${set.code}`).to.not.equal(
        RESULT_STATUS.refused,
      );
      expect((await triggerStatusOf(trader)).stopLoss).to.deep.equal({
        state: "armed",
      });
      const epoch = await seatEpochOf(trader);

      rekeyed(trader, await reset(trader));
      expect(
        await seatEpochOf(trader),
        "the reset moved the seat to its next epoch",
      ).to.equal(epoch + 1);
      expect(await triggerStatusOf(trader)).to.deep.equal({
        marketId: PERP,
        takeProfit: { state: "gone" },
        stopLoss: { state: "gone" },
      });

      await bidRested();
      const before = await publicTape(PERP);
      await markMovedTo(mark - PAST);
      await fired();
      expect(await baseOf(trader), "the stop no longer fires").to.equal(lots);
      expect((await publicTape(PERP)).lastFillSeq).to.equal(before.lastFillSeq);

      await markMovedTo(mark);
      const closed = landed(
        await trader.client.placeOrder(
          PERP,
          order(SIDE.ask, ORDER_TYPE.limit, mark - BID_BELOW, lots),
        ),
      );
      expect(closed.status).to.equal(RESULT_STATUS.filled);
      expect(await baseOf(trader)).to.equal(0n);
      await openInterestMatchesBook();
      await custodyMatchesLedger();
    };

  it(
    "ends every trigger of a seat when its owner resets the order keys: the epoch rises, the stop does not fire and reads as gone",
    resetEndsTheTriggers(resetByOwner),
  );

  it(
    "ends every trigger of a seat the same way when the reset is signed off the chain by the owner",
    resetEndsTheTriggers(resetBySignature),
  );

  it("reads a stop as blocked by resting orders when the seat's own resting orders hold the margin the close needs, and closes it once they are cancelled", async function () {
    this.timeout(180_000);
    const collateral = 600_000n;
    const trader = await fundedTrader(collateral);
    await longOpened(trader);
    const set = await trader.client.setTrigger(PERP, stop(mark));
    expect(set.status, `refused with error ${set.code}`).to.not.equal(
      RESULT_STATUS.refused,
    );
    const resting = landed(
      await trader.client.placeOrder(
        PERP,
        order(SIDE.ask, ORDER_TYPE.postOnly, mark + 10n * TICK, 2n * lots),
      ),
    );
    expect(resting.status).to.equal(RESULT_STATUS.rested);
    await bidRested();

    await markMovedTo(mark - PAST);
    await fired();
    expect(await baseOf(trader), "the stop could not close").to.equal(lots);
    const blocked = (await triggerStatusOf(trader)).stopLoss;
    expect(blocked.state).to.equal("blockedByRestingOrders");
    if (blocked.state !== "blockedByRestingOrders")
      throw new Error("unreachable");
    const retryAt = blocked.nextAttempt;
    if (retryAt === undefined) throw new Error("no retry time");

    const cancelled = await trader.client.cancelAll(PERP);
    expect(cancelled.cancelled, "the owner's own order").to.equal(1n);
    await until(
      async () => BigInt(await rollupNow()) >= retryAt,
      "the retry time of the blocked stop",
      60_000,
      500,
    );
    await markMovedTo(mark - PAST);
    await fired();
    expect(await baseOf(trader), "the next pass closed it").to.equal(0n);

    await markMovedTo(mark);
    await openInterestMatchesBook();
    await custodyMatchesLedger();
  });

  it("drops a dead trigger in a sweep that reads a few seats a call and carries on from its cursor", async function () {
    this.timeout(180_000);
    const trader = await fundedTrader(20n * USD);
    await longOpened(trader);
    const set = await trader.client.setTrigger(PERP, stop(mark));
    expect(set.status, `refused with error ${set.code}`).to.not.equal(
      RESULT_STATUS.refused,
    );
    rekeyed(trader, await resetByOwner(trader));
    expect(
      (await triggerBook()).slots[trader.seat].stopLoss.active,
      "the dead record is still in the book until something drops it",
    ).to.equal(true);

    const seats = (await exchangeOn(rollup)).seatCapacity ?? 0;
    const cursor = async () =>
      decodeTriggerBookHeader(await throughThePort(addresses.triggers(PERP)))
        .sweepCursor;
    const start = await cursor();
    for (const calls of [1, 2]) {
      await send(rollup, instructions.sweepTriggers(PERP, 3), stranger);
      expect(await cursor(), `after ${calls} small sweeps`).to.equal(
        (start + 3 * calls) % seats,
      );
    }

    const perCall = 64;
    for (let call = 0; call <= Math.ceil(seats / perCall); call += 1) {
      await send(rollup, instructions.sweepTriggers(PERP, perCall), stranger);
    }
    expect(
      (await triggerBook()).slots[trader.seat].stopLoss.active,
      "a whole turn of the cursor dropped it",
    ).to.equal(false);

    await bidRested();
    const closed = landed(
      await trader.client.placeOrder(
        PERP,
        order(SIDE.ask, ORDER_TYPE.limit, mark - BID_BELOW, lots),
      ),
    );
    expect(closed.status).to.equal(RESULT_STATUS.filled);
    await openInterestMatchesBook();
    await custodyMatchesLedger();
  });
});

describe("a slot's generation, and seeing a trigger's status", () => {
  it("rises with each position the slot ends, and the owner sees a trigger armed on the position after", async function () {
    this.timeout(180_000);
    const counterparty = await fundedTrader(100n * USD);
    const trader = await fundedTrader(50n * USD);
    const perpSlot = async () =>
      positionOn((await ledgerThroughThePort()).seats[trader.seat], PERP);
    let slot = 0;
    const generation = async () =>
      (await ledgerThroughThePort()).seats[trader.seat].slotGenerations[slot];
    const triggerStatus = async () => {
      await trader.client.syncView(PERP);
      return (await trader.client.view()).snapshot.triggerStatus;
    };

    const opened = async (mark: bigint, lots: bigint) => {
      const ask = landed(
        await counterparty.client.placeOrder(
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
    };
    const closed = async (mark: bigint, lots: bigint) => {
      const bid = landed(
        await counterparty.client.placeOrder(
          PERP,
          order(SIDE.bid, ORDER_TYPE.postOnly, mark, lots),
        ),
      );
      expect(bid.status).to.equal(RESULT_STATUS.rested);
      const ask = landed(
        await trader.client.placeOrder(
          PERP,
          order(SIDE.ask, ORDER_TYPE.limit, mark, lots),
        ),
      );
      expect(ask.status).to.equal(RESULT_STATUS.filled);
    };

    let mark = await freshMark(PERP);
    const lots = leastLots(mark) * 4n;
    await opened(mark, lots);
    const tagged = (await perpSlot()).slot;
    expect(tagged, "the market's slot").to.be.a("number");
    slot = Number(tagged);
    await closed(mark, lots);
    expect(await generation(), "one position ended").to.equal(1);

    mark = await freshMark(PERP);
    await opened(mark, lots);
    await closed(mark, lots);
    expect(await generation(), "two positions ended").to.equal(2);

    mark = await freshMark(PERP);
    await opened(mark, lots);
    const set = await trader.client.setTrigger(PERP, stop(mark));
    expect(set.status, `refused with error ${set.code}`).to.not.equal(
      RESULT_STATUS.refused,
    );
    expect(await triggerStatus()).to.deep.equal({
      marketId: PERP,
      takeProfit: { state: "gone" },
      stopLoss: { state: "armed" },
    });

    await trader.client.cancelTrigger(PERP, TRIGGER_KIND.stopLoss);
    expect(await triggerStatus()).to.deep.equal({
      marketId: PERP,
      takeProfit: { state: "gone" },
      stopLoss: { state: "gone" },
    });
    await closed(mark, lots);
    await openInterestMatchesBook();
    await custodyMatchesLedger();
  });
});

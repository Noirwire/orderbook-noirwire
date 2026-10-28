/**
 * The ledger's growth and what the hot instructions cost at each size, on the
 * local network. It proves:
 *
 * 1. `extend_ledger` takes the ledger from 2,048 to 8,192 seats and the next
 *    seat taken is a new one, then to 12,288, and a call past that is refused
 *    with `LedgerTooLarge`.
 * 2. At 2,048, 8,192 and 12,288 seats the order, deposit, withdrawal, sweep
 *    and reconcile instructions land within the compute a transaction can ask
 *    for (1,400,000), and each prints what it used as `CU | name | seats | n`.
 * 3. `liquidate_range` over 256, 128 and 64 seats, with nobody to take over
 *    and with four takeovers, is sent as the client sends it, with the
 *    compute `extend_compute` gives, and prints whether it fits.
 * 4. A reconcile over a table that holds debtors costs more by a fixed amount
 *    a debtor; the table of 12,288 seats with every seat a debtor is then
 *    that many times more than the one measured, and is printed as such.
 *
 * Runs last: it leaves the ledger at 12,288 seats and the perp market with a
 * recorded shortfall.
 */
import { expect } from "chai";
import {
  ORDER_TYPE,
  RELEASE_SEATS_PER_CALL,
  SIDE,
  extendLedgerTo,
  freeSeats,
  randomClientOrderId,
} from "../../sdk/dist/index.js";
import { send as sendAsBuilt } from "../../ops/sending";
import {
  PROGRAM_ID,
  admin,
  computeUnits,
  instructions,
  ledgerThroughThePort,
  reportUnits,
  rollup,
  rollupNow,
  send,
} from "../support";
import {
  COLLATERAL,
  PERP,
  TICK,
  USD,
  attempted,
  call,
  custodyMatchesLedger,
  custodyOf,
  exchangeOn,
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
  resultFor,
  soon,
  stranger,
  tokenAccount,
  withdrawCollateral,
  type Trader,
} from "../orderbook/world";

const BUDGET = 1_400_000;
const RANGE = 256;
const MAX_TAKEOVERS = 4;

const SWEEP_COUNTS = [256, 128, 64];
const TARGETS = 4;
const POPULATION = 272;
const COLLATERAL_EACH = 300n * USD;
/** What `extend_compute` gives a transaction that names no compute budget. */
const DEFAULT_COMPUTE = 400_000;

/** `count` funded traders, opened a few at a time. */
async function populated(count: number): Promise<Trader[]> {
  const traders: Trader[] = [];
  for (let at = 0; at < count; at += 6) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(6, count - at) }, () =>
        fundedTrader(COLLATERAL_EACH),
      ),
    );
    traders.push(...batch);
  }
  return traders;
}

/** The first `length` traders of the longest run of consecutive seats among `traders`. */
function consecutive(traders: Trader[], length: number): Trader[] {
  const sorted = [...traders].sort((a, b) => a.seat - b.seat);
  let best: Trader[] = [];
  let run: Trader[] = [];
  for (const trader of sorted) {
    const last = run[run.length - 1];
    run = last && trader.seat === last.seat + 1 ? [...run, trader] : [trader];
    if (run.length > best.length) best = run;
  }
  if (best.length < length) {
    throw new Error(`only ${best.length} consecutive seats among the traders`);
  }
  return best.slice(0, length);
}

describe("audit: the ledger's growth, and what the hot instructions cost at each size", () => {
  const worst: [string, number, number][] = [];
  const note = (name: string, seats: number, units: number) => {
    reportUnits(name, seats, units);
    worst.push([name, seats, units]);
    expect(units, `${name} at ${seats} seats`).to.be.lessThan(BUDGET);
  };

  /**
   * `liquidate_range` over 256, 128 and 64 seats with nobody to take over and
   * with four takeovers, each sent as the client sends it: followed by
   * `extend_compute` and naming no compute budget. A sweep that does not fit
   * is run again with the whole budget to say what it needed.
   */
  async function sweepGrid(seats: number): Promise<void> {
    const price = await freshMark(PERP);
    const lots = leastLots(price);
    const pool = await populated(POPULATION);
    const window = consecutive(pool, SWEEP_COUNTS[0]);
    // The sweep ends after its fourth takeover, so the targets sit last in
    // each range, where the sweep has looked at every other seat first.
    const groups = SWEEP_COUNTS.map((count) =>
      window.slice(count - TARGETS, count),
    );
    const start = window[0].seat;
    const seller = await fundedTrader(20_000n * USD);
    const liquidator = await fundedTrader(40_000n * USD);
    const bigLots = (COLLATERAL_EACH * 10n * 80n) / (100n * price);

    const buy = async (trader: Trader, size: bigint) => {
      const bought = landed(
        await trader.client.placeOrder(
          PERP,
          order(SIDE.bid, ORDER_TYPE.immediateOrCancel, price, size),
        ),
      );
      expect(bought.filled).to.equal(size);
    };
    const armed = async (group: Trader[]) => {
      await freshMark(PERP);
      await seller.client.placeOrder(
        PERP,
        order(SIDE.ask, ORDER_TYPE.postOnly, price, BigInt(TARGETS) * bigLots),
      );
      await Promise.all(group.map((target) => buy(target, bigLots)));
      await seller.client.cancelAll(PERP);
    };

    await seller.client.placeOrder(
      PERP,
      order(SIDE.ask, ORDER_TYPE.postOnly, price, BigInt(window.length) * lots),
    );
    for (let at = 0; at < window.length; at += 8) {
      await Promise.all(
        window.slice(at, at + 8).map((trader) => buy(trader, lots)),
      );
    }
    await seller.client.cancelAll(PERP);

    const sweep = async (count: number, takeovers: string) => {
      const range = {
        start,
        count,
        size: bigLots,
        worstPrice: price * 2n,
        maxTakeovers: TARGETS,
      };
      const use = liquidator.keys.take();
      const id = randomClientOrderId();
      const build = (extra: boolean) => [
        instructions.liquidateRange(
          call(liquidator, use, PERP, id, soon()),
          range,
        ),
        ...(extra ? [instructions.extendCompute()] : []),
      ];
      let why = `fits the ${DEFAULT_COMPUTE} default`;
      let signature: string;
      let orderId = id;
      try {
        signature = await sendAsBuilt(rollup, build(true), use.keypair);
        liquidator.keys.confirm(use);
      } catch (error) {
        liquidator.keys.release(use);
        const text = error instanceof Error ? error.message : String(error);
        why = `does NOT fit the ${DEFAULT_COMPUTE} default (${/exceeded|budget/i.test(text) ? "compute exhausted" : text.slice(0, 80)}); needed`;
        const retried = await attempted(liquidator, (key, orderId, expiresAt) =>
          instructions.liquidateRange(
            call(liquidator, key, PERP, orderId, expiresAt),
            range,
          ),
        );
        signature = retried.signature;
        orderId = retried.clientOrderId;
      }
      const units = await computeUnits(signature);
      const result = await resultFor(liquidator, orderId);
      reportUnits(
        `liquidate_range(${count} seats, ${takeovers}, ${why}; result status ${result.status}, takeovers ${result.code})`,
        seats,
        units,
      );
      return result.code;
    };

    for (const count of SWEEP_COUNTS) await sweep(count, "0 takeovers");

    const crashed = (price * 90n) / 100n;
    for (const [round, count] of SWEEP_COUNTS.entries()) {
      await armed(groups[round]);
      await send(
        rollup,
        instructions.resetPrice(
          admin.publicKey,
          PERP,
          crashed - (crashed % TICK),
          BigInt(await rollupNow()),
        ),
        admin,
      );
      expect(
        await sweep(count, "4 takeovers"),
        `takeovers made by the ${count}-seat sweep`,
      ).to.equal(TARGETS);
      await send(
        rollup,
        [
          instructions.resetPrice(
            admin.publicKey,
            PERP,
            price,
            BigInt(await rollupNow()),
          ),
          instructions.resumeMarket(admin.publicKey, PERP, [PERP]),
        ],
        admin,
      );
    }
  }

  /** Measures the hot instructions on the ledger as it is, with `seats` seats. */
  async function measure(seats: number): Promise<void> {
    const price = await freshMark(PERP);
    const lots = leastLots(price);

    const newcomer = await openedTrader();
    await fundedWith(newcomer, mints.nUSD, 20n * USD);
    const deposit = await send(
      rollup,
      instructions.deposit(
        newcomer.owner.publicKey,
        tokenAccount(newcomer, mints.nUSD),
        custodyOf(mints.nUSD),
        newcomer.owner.publicKey,
        COLLATERAL,
        20n * USD,
      ),
      newcomer.owner,
    );
    note("deposit that takes a seat", seats, await computeUnits(deposit));

    const maker = await fundedTrader(200n * USD);
    const taker = await fundedTrader(200n * USD);
    const rested = await attempted(
      maker,
      placing(
        maker,
        PERP,
        order(SIDE.ask, ORDER_TYPE.postOnly, price, 2n * lots),
      ),
    );
    note("place_order (rests)", seats, await computeUnits(rested.signature));
    const filled = await attempted(
      taker,
      placing(
        taker,
        PERP,
        order(SIDE.bid, ORDER_TYPE.immediateOrCancel, price, lots),
      ),
    );
    note(
      "place_order (fills one maker)",
      seats,
      await computeUnits(filled.signature),
    );
    const cancelled = await attempted(maker, (use, id, expiresAt) =>
      instructions.cancelAll(call(maker, use, PERP, id, expiresAt), 4),
    );
    note(
      "cancel_all (one order)",
      seats,
      await computeUnits(cancelled.signature),
    );

    const swept = await attempted(maker, (use, id, expiresAt) =>
      instructions.liquidateRange(call(maker, use, PERP, id, expiresAt), {
        start: 2,
        count: RANGE,
        size: 1_000n,
        worstPrice: price * 2n,
        maxTakeovers: MAX_TAKEOVERS,
      }),
    );
    note(
      `liquidate_range(${RANGE}), whole budget`,
      seats,
      await computeUnits(swept.signature),
    );

    const released = await send(
      rollup,
      instructions.releaseEmptySeats(
        stranger.publicKey,
        2,
        Math.min(RELEASE_SEATS_PER_CALL, seats - 2),
      ),
      stranger,
    );
    note(
      `release_empty_seats(${Math.min(RELEASE_SEATS_PER_CALL, seats - 2)})`,
      seats,
      await computeUnits(released),
    );

    const covered = await send(
      rollup,
      instructions.coverShortfallRange(PERP, 2, RANGE),
      stranger,
    );
    note(`cover_shortfall_range(${RANGE})`, seats, await computeUnits(covered));

    const reconciled = await send(
      rollup,
      instructions.reconcileShortfall([PERP]),
      stranger,
    );
    note(
      "reconcile_shortfall (no debtor)",
      seats,
      await computeUnits(reconciled),
    );

    const closing = await send(
      rollup,
      instructions.withdraw(
        newcomer.owner.publicKey,
        tokenAccount(newcomer, mints.nUSD),
        custodyOf(mints.nUSD),
        COLLATERAL,
        20n * USD,
        [PERP],
      ),
      newcomer.owner,
    );
    note("withdraw that releases the seat", seats, await computeUnits(closing));

    await maker.client.cancelAll(PERP);
  }

  it("measures the hot instructions at 2,048 seats", async () => {
    expect((await exchangeOn(rollup)).seatCapacity).to.equal(2_048);
    await sweepGrid(2_048);
    await measure(2_048);
    await custodyMatchesLedger();
  });

  it("measures one extend_ledger call, grows to 8,192 seats, and the next seat taken is a new one", async () => {
    const one = await send(
      rollup,
      instructions.extendLedger(admin.publicKey, 33),
      admin,
    );
    note("extend_ledger (33 seats)", 2_048, await computeUnits(one));
    expect(await extendLedgerTo(rollup, admin, 8_192, PROGRAM_ID)).to.equal(
      8_192,
    );
    const ledger = await ledgerThroughThePort();
    expect(ledger.seats.length).to.equal(8_192);
    const head = freeSeats(ledger)[0];
    expect(head, "the head of the list is a new seat").to.be.at.least(2_048);

    const above = await fundedTrader(2n * USD);
    expect(above.seat, "a seat above the first 2,048").to.equal(head);
    const price = await freshMark(PERP);
    const placed = landed(
      await above.client.placeOrder(
        PERP,
        order(
          SIDE.bid,
          ORDER_TYPE.postOnly,
          price - 10n * TICK,
          leastLots(price),
        ),
      ),
    );
    expect(placed.filled).to.equal(0n);
    await above.client.cancelAll(PERP);
    await withdrawCollateral(above, 2n * USD);
    await custodyMatchesLedger();
  });

  it("measures the hot instructions at 8,192 seats", async () => {
    await measure(8_192);
    const one = await send(
      rollup,
      instructions.extendLedger(admin.publicKey, 33),
      admin,
    );
    note("extend_ledger (33 seats)", 8_192, await computeUnits(one));
  });

  it("grows to 12,288 seats, refuses to go further, and measures the hot instructions there", async () => {
    expect(await extendLedgerTo(rollup, admin, 12_288, PROGRAM_ID)).to.equal(
      12_288,
    );
    await refuses(
      send(rollup, instructions.extendLedger(admin.publicKey, 1), admin),
      "LedgerTooLarge",
    );
    expect((await exchangeOn(rollup)).seatCapacity).to.equal(12_288);
    await sweepGrid(12_288);
    await measure(12_288);
    await custodyMatchesLedger();
  });

  it("measures a reconcile over debtors, and what it would cost with every seat a debtor", async () => {
    const DEBTORS = 3n;
    const LOTS = 60_000n;
    const price = await freshMark(PERP);
    const baseline = worst.find(
      ([name, seats]) =>
        name === "reconcile_shortfall (no debtor)" && seats === 12_288,
    );
    if (!baseline) throw new Error("no baseline reconcile");

    const seller = await fundedTrader(5_000n * USD);
    const liquidator = await fundedTrader(5_000n * USD);
    const targets: Trader[] = [];
    for (let at = 0n; at < DEBTORS; at += 1n) {
      targets.push(await fundedTrader(1_000n * USD));
    }
    await seller.client.placeOrder(
      PERP,
      order(SIDE.ask, ORDER_TYPE.postOnly, price, DEBTORS * LOTS),
    );
    for (const target of targets) {
      const bought = landed(
        await target.client.placeOrder(
          PERP,
          order(SIDE.bid, ORDER_TYPE.immediateOrCancel, price, LOTS),
        ),
      );
      expect(bought.filled).to.equal(LOTS);
    }
    await seller.client.cancelAll(PERP);

    const crashed = (price * 55n) / 100n;
    await send(
      rollup,
      instructions.resetPrice(
        admin.publicKey,
        PERP,
        crashed - (crashed % TICK),
        BigInt(await rollupNow()),
      ),
      admin,
    );
    for (const target of targets) {
      const done = await liquidator.client.liquidate(
        PERP,
        target.seat,
        LOTS,
        price,
      );
      expect(done.filled, "the takeover").to.equal(LOTS);
    }
    const { seats } = await ledgerThroughThePort();
    const indebted = targets.filter(
      (target) => seats[target.seat].collateral < 0n,
    );
    expect(indebted.length, "debtors the liquidation left").to.equal(
      Number(DEBTORS),
    );

    const reconciled = await send(
      rollup,
      instructions.reconcileShortfall([PERP]),
      stranger,
    );
    const withDebtors = await computeUnits(reconciled);
    reportUnits(
      `reconcile_shortfall (${DEBTORS} debtors)`,
      12_288,
      withDebtors,
    );
    const perDebtor = Math.max(
      0,
      Math.ceil((withDebtors - baseline[2]) / Number(DEBTORS)),
    );
    const allDebtors = baseline[2] + perDebtor * (12_288 - 2);
    reportUnits(
      `reconcile_shortfall (every seat a debtor, ${perDebtor} CU each, extrapolated)`,
      12_288,
      allDebtors,
    );
    expect(withDebtors).to.be.lessThan(BUDGET);
  });
});

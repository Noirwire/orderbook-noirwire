import { expect } from "chai";
import type { Keypair } from "@solana/web3.js";
import {
  FEE_SEAT,
  INSURANCE_SEAT,
  LIQUIDATION_STATUS,
  MARKET_STATUS,
  ORDER_TYPE,
  RESULT_KIND,
  RESULT_STATUS,
  SIDE,
} from "../../sdk/dist/index.js";
import {
  addresses,
  admin,
  anonymous,
  balanceOf,
  fundingThroughThePort,
  inPublic,
  instructions,
  ledgerThroughThePort,
  publicMarket,
  publicStats,
  rollup,
  rollupNow,
  send,
  shownBy,
  until,
} from "../support";
import {
  COLLATERAL,
  CRASHED_MARK,
  MARK,
  PERP,
  SEAT_NEVER_OPENED,
  SEAT_OPEN,
  SPOT,
  USD,
  attempted,
  call,
  cast,
  custodyMatchesLedger,
  deposited,
  landed,
  limits,
  mints,
  order,
  placing,
  refuses,
  resultFor,
  stranger,
  tokenAccount,
} from "./world";

const BPS = 10_000n;
const WORST_PRICE = 200_000n;
const LONG_AGO = 100_000n;

const perpStatus = async () => (await publicMarket(PERP)).params.status;

const resetPrice = (price: bigint, publishTime: bigint) =>
  send(
    rollup,
    instructions.resetPrice(admin.publicKey, PERP, price, publishTime),
    admin,
  );

const resumed = () =>
  send(rollup, instructions.resumeMarket(admin.publicKey, PERP), admin);

describe("perpetual money, end to end", () => {
  before(async () => {
    const { alice, bob, carol } = cast;
    await deposited(alice, mints.nUSD, COLLATERAL, 100n * USD);
    await deposited(bob, mints.nUSD, COLLATERAL, 10n * USD);
    await deposited(carol, mints.nUSD, COLLATERAL, 100n * USD);
  });

  it("opens a long against a short, takes the fee from the taker's collateral, and counts open interest", async () => {
    const { alice, bob } = cast;
    const short = landed(
      await alice.client.placeOrder(
        PERP,
        order(SIDE.ask, ORDER_TYPE.postOnly, MARK, 500n),
        { riskMarkets: [PERP] },
      ),
    );
    expect(short.status).to.equal(RESULT_STATUS.rested);
    const long = landed(
      await bob.client.placeOrder(
        PERP,
        order(SIDE.bid, ORDER_TYPE.limit, MARK, 500n),
        { riskMarkets: [PERP] },
      ),
    );
    expect(long.status).to.equal(RESULT_STATUS.filled);
    expect(long.fee).to.equal(37_500n);
    const ledger = await ledgerThroughThePort();
    expect(ledger.seats[bob.seat].perp[PERP].base).to.equal(500n);
    expect(ledger.seats[bob.seat].perp[PERP].quote).to.equal(-500n * MARK);
    expect(ledger.seats[bob.seat].collateral).to.equal(10n * USD - 37_500n);
    expect(ledger.seats[alice.seat].perp[PERP].base).to.equal(-500n);
    expect(ledger.seats[FEE_SEAT].collateral).to.equal(37_500n);
    expect((await publicStats()).openInterest[PERP]).to.equal(500n);
    await custodyMatchesLedger();
  });

  it("refuses an order that would take equity below initial margin", async () => {
    const { bob } = cast;
    const more = placing(
      bob,
      PERP,
      order(SIDE.bid, ORDER_TYPE.limit, MARK, 2_000n),
    );
    await refuses(attempted(bob, more), "InsufficientMargin");
    await custodyMatchesLedger();
  });

  it("applies funding once per interval from what traded, capped, and a position that is touched pays it", async () => {
    const { alice, bob } = cast;
    await alice.client.placeOrder(
      PERP,
      order(SIDE.ask, ORDER_TYPE.postOnly, MARK + 2_000n, 10n),
      { riskMarkets: [PERP] },
    );
    const lifted = landed(
      await bob.client.placeOrder(
        PERP,
        order(SIDE.bid, ORDER_TYPE.immediateOrCancel, MARK + 2_000n, 10n),
        { riskMarkets: [PERP] },
      ),
    );
    expect(lifted.filled).to.equal(10n);
    const bobBefore = (await ledgerThroughThePort()).seats[bob.seat].perp[PERP];
    const before = await fundingThroughThePort(PERP);
    const after = await until(
      async () => {
        await send(rollup, instructions.updateFunding(PERP), stranger);
        const now = await fundingThroughThePort(PERP);
        return now.lastTime > before.lastTime && now;
      },
      "the funding interval to pass",
      20_000,
      250,
    );
    expect(before.tradedSize > 0n).to.equal(true);
    const atMark = MARK * before.tradedSize;
    const above = before.tradedNotional >= atMark;
    const distance = above
      ? before.tradedNotional - atMark
      : atMark - before.tradedNotional;
    const capBps = BigInt(limits().fundingCapBps);
    const magnitude =
      distance * BPS > atMark * capBps
        ? (MARK * capBps) / BPS
        : distance / before.tradedSize;
    expect(magnitude).to.not.equal(0n);
    expect(after.index - before.index).to.equal(above ? magnitude : -magnitude);
    expect(after.tradedSize).to.equal(0n);
    await send(rollup, instructions.updateFunding(PERP), admin);
    expect((await fundingThroughThePort(PERP)).index).to.equal(after.index);
    await bob.client.syncView(PERP);
    const synced = await bob.client.view();
    expect(synced.snapshot.seat.perp[PERP].fundingCheckpoint).to.equal(
      bobBefore.fundingCheckpoint,
    );
    const bidLater = landed(
      await bob.client.placeOrder(
        PERP,
        order(SIDE.bid, ORDER_TYPE.immediateOrCancel, MARK - 10_000n, 10n),
        { riskMarkets: [PERP] },
      ),
    );
    expect(bidLater.filled).to.equal(0n);
    const touched = (await ledgerThroughThePort()).seats[bob.seat].perp[PERP];
    expect(touched.fundingCheckpoint).to.equal(after.index);
    expect(touched.quote).to.equal(
      bobBefore.quote -
        bobBefore.base * (after.index - bobBefore.fundingCheckpoint),
    );
    await custodyMatchesLedger();
  });

  it("advances funding on its own once the admin schedules it, and nobody else can", async () => {
    const schedule = (
      by: Keypair,
      marketId: number,
      taskId: bigint,
      runs = 10n,
    ) =>
      send(
        rollup,
        instructions.scheduleFunding(
          by.publicKey,
          marketId,
          taskId,
          500n,
          runs,
        ),
        by,
      );
    await refuses(schedule(stranger, PERP, 7n), "NotAdmin");
    await refuses(schedule(admin, SPOT, 8n), "NotPerpMarket");
    const before = await fundingThroughThePort(PERP);
    await schedule(admin, PERP, 9n, 30n);
    const appliedAfter = (earlier: { lastTime: bigint }, what: string) =>
      until(
        async () => {
          const now = await fundingThroughThePort(PERP);
          return now.lastTime > earlier.lastTime && now;
        },
        what,
        20_000,
        100,
      );
    const first = await appliedAfter(
      before,
      "the scheduler to apply one interval",
    );
    const second = await appliedAfter(
      first,
      "the scheduler to apply a second interval",
    );
    expect(second.lastTime - first.lastTime >= 2n).to.equal(true);
  });

  it("gives a stranger the same public result for a healthy seat, a missing seat and a seat with no position, and the liquidator one recorded result for all three", async () => {
    const { bob, carol } = cast;
    const publicAccounts = async () =>
      Promise.all(
        [
          addresses.stats,
          addresses.market(PERP),
          addresses.tape(PERP),
          addresses.priceFeed(PERP),
        ].map(async (address) => (await inPublic(address)).toString("hex")),
      );
    const seenByAStranger = async (target: number) => {
      const before = await publicAccounts();
      const { clientOrderId, signature } = await attempted(
        carol,
        (use, id, expiresAt) =>
          instructions.liquidate(
            call(carol, use, PERP, id, expiresAt),
            target,
            1_000n,
            WORST_PRICE,
          ),
      );
      const shown = await shownBy(anonymous, signature);
      const status = (await rollup.getSignatureStatus(signature)).value;
      const recorded = await resultFor(carol, clientOrderId);
      const mine = await carol.client.view();
      return {
        recorded: { ...recorded, clientOrderId: 0n },
        snapshot: mine.snapshot,
        public: {
          error: status?.err ?? null,
          accounts: shown.accounts.length,
          logs: shown.logs,
          changed: (await publicAccounts()).map(
            (data, index) => data !== before[index],
          ),
        },
      };
    };
    const flatSeat = (await ledgerThroughThePort()).seats.findIndex(
      (seat, index) =>
        index > INSURANCE_SEAT &&
        index !== carol.seat &&
        seat.status === SEAT_OPEN &&
        seat.perp.every((slot) => slot.base === 0n),
    );
    const healthy = await seenByAStranger(bob.seat);
    const missing = await seenByAStranger(SEAT_NEVER_OPENED);
    const flat = await seenByAStranger(flatSeat);
    expect(healthy.recorded).to.deep.equal({
      clientOrderId: 0n,
      orderSeq: 0n,
      filled: 0n,
      filledNotional: 0n,
      rested: 0n,
      cancelled: 0n,
      fee: 0n,
      kind: RESULT_KIND.liquidate,
      status: LIQUIDATION_STATUS.nothingToLiquidate,
      code: 0,
    });
    expect(missing.recorded).to.deep.equal(healthy.recorded);
    expect(flat.recorded).to.deep.equal(healthy.recorded);
    expect(missing.snapshot).to.deep.equal(healthy.snapshot);
    expect(flat.snapshot).to.deep.equal(healthy.snapshot);
    expect(healthy.public).to.deep.equal({
      error: null,
      accounts: 0,
      logs: [],
      changed: [false, false, false, false],
    });
    expect(missing.public).to.deep.equal(healthy.public);
    expect(flat.public).to.deep.equal(healthy.public);
  });

  it("liquidates only below maintenance margin with a fresh price, at the penalised price and the size that restores margin, moving no public volume, fill counter or tape", async () => {
    const { bob, carol } = cast;
    const liquidate = (target: number, worstPrice = WORST_PRICE) =>
      carol.client.liquidate(PERP, target, 1_000n, worstPrice, [PERP]);
    const now = BigInt(await rollupNow());
    await resetPrice(CRASHED_MARK, now - LONG_AGO);
    const stale = await liquidate(bob.seat);
    expect(stale.status).to.equal(LIQUIDATION_STATUS.stalePrice);
    await resetPrice(CRASHED_MARK, now);

    const before = await ledgerThroughThePort();
    const bobBefore = before.seats[bob.seat];
    const lots = bobBefore.perp[PERP].base;
    const tooCheap = await liquidate(bob.seat, CRASHED_MARK - 2_000n);
    expect(tooCheap.status).to.equal(LIQUIDATION_STATUS.nothingToLiquidate);
    const statsBefore = await publicStats();
    const tapeBefore = await inPublic(addresses.tape(PERP));
    const done = await liquidate(bob.seat);
    expect(done.status).to.equal(LIQUIDATION_STATUS.liquidated);
    expect(await publicStats(), "public counters").to.deep.equal(statsBefore);
    expect(
      (await inPublic(addresses.tape(PERP))).equals(tapeBefore),
      "the public tape",
    ).to.equal(true);
    const taken = done.filled;
    const price = CRASHED_MARK - 1_360n;
    expect(done.filledNotional).to.equal(taken * price);
    expect(done.fee).to.equal(0n);
    const ledger = await ledgerThroughThePort();
    const bobAfter = ledger.seats[bob.seat];
    expect(bobAfter.perp[PERP].base).to.equal(lots - taken);
    const funding =
      lots *
      (bobAfter.perp[PERP].fundingCheckpoint -
        bobBefore.perp[PERP].fundingCheckpoint);
    const { mmBps, liqBufferBps, liqPenaltyBps } = (await publicMarket(PERP))
      .params;
    const equity =
      bobBefore.collateral +
      lots * CRASHED_MARK +
      bobBefore.perp[PERP].quote -
      funding;
    const shortage =
      lots * CRASHED_MARK * BigInt(mmBps + liqBufferBps) - equity * BPS;
    const freedPerLot =
      CRASHED_MARK * BigInt(mmBps + liqBufferBps - liqPenaltyBps);
    const restoring = (shortage + freedPerLot - 1n) / freedPerLot;
    expect(restoring > 0n && restoring < lots).to.equal(true);
    expect(taken).to.equal(restoring);
    const settled = bobBefore.perp[PERP].quote - funding + taken * price;
    if (taken === lots) {
      expect(bobAfter.collateral).to.equal(bobBefore.collateral + settled);
    } else {
      expect(bobAfter.perp[PERP].quote).to.equal(settled);
    }
    expect(ledger.seats[carol.seat].perp[PERP].base).to.equal(taken);
    expect(ledger.seats[carol.seat].perp[PERP].quote).to.equal(-taken * price);
    expect((await publicStats()).openInterest[PERP]).to.equal(lots);
    await custodyMatchesLedger();
  });

  it("goes reduce-only on a reset, and only the admin returns it to normal", async () => {
    const { carol } = cast;
    expect(await perpStatus()).to.equal(MARKET_STATUS.reduceOnly);
    const grow = placing(
      carol,
      PERP,
      order(SIDE.bid, ORDER_TYPE.limit, CRASHED_MARK, 1n),
    );
    await refuses(attempted(carol, grow), "MarketReduceOnly");
    await refuses(
      send(
        rollup,
        instructions.resumeMarket(stranger.publicKey, PERP),
        stranger,
      ),
      "NotAdmin",
    );
    await send(
      rollup,
      instructions.updateMarket(admin.publicKey, PERP, limits()),
      admin,
    );
    expect(await perpStatus(), "after a limits update").to.equal(
      MARKET_STATUS.reduceOnly,
    );
    expect(() =>
      instructions.updateMarket(
        admin.publicKey,
        PERP,
        limits({ status: MARKET_STATUS.paused }),
      ),
    ).to.throw("restrictMarket");
    const restrict = (by: Keypair, to: number) =>
      send(rollup, instructions.restrictMarket(by.publicKey, PERP, to), by);
    await refuses(restrict(stranger, MARKET_STATUS.paused), "NotAdmin");
    await refuses(restrict(admin, MARKET_STATUS.active), "ResumeOnly");
    await restrict(admin, MARKET_STATUS.paused);
    expect(await perpStatus()).to.equal(MARKET_STATUS.paused);
    await resetPrice(CRASHED_MARK, BigInt(await rollupNow()));
    expect(await perpStatus(), "after a reset while paused").to.equal(
      MARKET_STATUS.paused,
    );
    await restrict(admin, MARKET_STATUS.reduceOnly);
    expect(await perpStatus()).to.equal(MARKET_STATUS.reduceOnly);
    await resumed();
    expect(await perpStatus()).to.equal(MARKET_STATUS.active);
  });

  it("withdraws collateral only down to initial margin, and never when the feed is stale", async () => {
    const { carol } = cast;
    const to = tokenAccount(carol, mints.nUSD);
    const withdrawal = (amount: bigint) =>
      send(
        rollup,
        instructions.withdraw(
          carol.owner.publicKey,
          to,
          mints.nUSD,
          COLLATERAL,
          amount,
          [PERP],
        ),
        carol.owner,
      );
    await refuses(withdrawal(100n * USD - 1n), "InsufficientMargin");
    const before = await balanceOf(to);
    await withdrawal(50n * USD);
    expect((await balanceOf(to)) - before).to.equal(50n * USD);
    await resetPrice(CRASHED_MARK, BigInt(await rollupNow()) - LONG_AGO);
    await refuses(withdrawal(1n * USD), "StalePrice");
    await resetPrice(CRASHED_MARK, BigInt(await rollupNow()));
    await resumed();
    await custodyMatchesLedger();
  });
});

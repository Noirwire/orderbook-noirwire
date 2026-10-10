import { expect } from "chai";
import type { Keypair } from "@solana/web3.js";
import {
  FEE_SEAT,
  INSURANCE_SEAT,
  LIQUIDATION_STATUS,
  MARKET_STATUS,
  ORDER_TYPE,
  RESULT_STATUS,
  SIDE,
  type MarketLimits,
} from "../../sdk/dist/index.js";
import {
  addresses,
  admin,
  balanceOf,
  instructions,
  ledgerThroughThePort,
  publicMarket,
  publicStats,
  rollup,
  rollupNow,
  send,
} from "../support";
import {
  COLLATERAL,
  CRASHED_MARK,
  NUSD,
  PERP,
  USD,
  attempted,
  call,
  custodyMatchesLedger,
  deposited,
  fundedWith,
  gate,
  landed,
  limits,
  mints,
  openedTrader,
  oracle,
  order,
  refuses,
  stranger,
  type Trader,
} from "./world";

describe("margin at the fill, caps, fee shares and bad debt", () => {
  const PRICE = CRASHED_MARK;
  let dave: Trader;
  let erin: Trader;
  let frank: Trader;

  const perpLimits = (over: Partial<MarketLimits>) =>
    send(
      rollup,
      instructions.updateMarket(admin.publicKey, PERP, limits(over)),
      admin,
    );
  const rests = async (trader: Trader, price: bigint, size: bigint) => {
    const rested = landed(
      await trader.client.placeOrder(
        PERP,
        order(SIDE.ask, ORDER_TYPE.postOnly, price, size),
        { riskMarkets: [PERP] },
      ),
    );
    expect(rested.status).to.equal(RESULT_STATUS.rested);
  };
  const buys = async (trader: Trader, price: bigint, size: bigint) =>
    landed(
      await trader.client.placeOrder(
        PERP,
        order(SIDE.bid, ORDER_TYPE.limit, price, size),
        { riskMarkets: [PERP] },
      ),
    );
  const seat = async (trader: Trader) =>
    (await ledgerThroughThePort()).seats[trader.seat];
  const perp = async () => (await publicMarket(PERP)).params;
  const resumed = () =>
    send(rollup, instructions.resumeMarket(admin.publicKey, PERP), admin);

  before(async () => {
    dave = await openedTrader();
    erin = await openedTrader();
    frank = await openedTrader();
    await fundedWith(dave, mints.nUSD, 40n * USD);
    await fundedWith(erin, mints.nUSD, 100n * USD);
    await fundedWith(frank, mints.nUSD, 15n * USD);
    await deposited(dave, mints.nUSD, { spot: NUSD }, 20n * USD);
    await deposited(erin, mints.nUSD, COLLATERAL, 100n * USD);
    await deposited(frank, mints.nUSD, COLLATERAL, 15n * USD);
  });

  it("moves value between the spot balance and collateral in both directions, and not when it would break margin", async () => {
    const transfer = (toCollateral: boolean, amount: bigint) =>
      dave.client.transferBetweenBalances(toCollateral, NUSD, amount, [PERP]);
    const custody = await balanceOf(addresses.custody(mints.nUSD));
    const posted = await transfer(true, 20n * USD);
    expect(posted.filled).to.equal(20n * USD);
    expect((await seat(dave)).collateral).to.equal(20n * USD);
    expect((await seat(dave)).spot[NUSD].available).to.equal(0n);
    const out = await transfer(false, 5n * USD);
    expect(out.filled).to.equal(5n * USD);
    expect((await seat(dave)).collateral).to.equal(15n * USD);
    expect((await seat(dave)).spot[NUSD].available).to.equal(5n * USD);
    expect(
      (await dave.client.view()).snapshot.seat.spot[NUSD].available,
    ).to.equal(5n * USD);
    expect(await balanceOf(addresses.custody(mints.nUSD))).to.equal(custody);

    await rests(erin, PRICE, 1_000n);
    expect((await buys(dave, PRICE, 1_000n)).filled).to.equal(1_000n);
    const before = await seat(dave);
    await refuses(
      attempted(dave, (use, id, expiresAt) =>
        instructions.transferBetweenBalances(
          call(dave, use, PERP, id, expiresAt),
          false,
          NUSD,
          2n * USD,
        ),
      ),
      "InsufficientMargin",
    );
    expect(await seat(dave)).to.deep.equal(before);
    await custodyMatchesLedger();
  });

  it("writes a fill the fill check refuses as an outcome in the taker's view, with nothing traded", async () => {
    const above = PRICE + 4_000n;
    await rests(erin, above, 1_000n);
    const before = await seat(frank);
    const refused = await buys(frank, above, 1_000n);
    expect(refused.status).to.equal(RESULT_STATUS.remainderCancelledFillCheck);
    expect(refused.filled).to.equal(0n);
    expect(refused.cancelled).to.equal(1_000n);
    const after = await seat(frank);
    expect(after.collateral).to.equal(before.collateral);
    expect(after.perp[PERP].base).to.equal(0n);
    expect(after.perp[PERP].quote).to.equal(0n);
    expect((await erin.client.cancelAll(PERP)).cancelled).to.equal(1n);
    await custodyMatchesLedger();
  });

  it("stops matching at the open interest cap and cancels the remainder", async () => {
    const openInterest = async () => (await publicStats()).openInterest[PERP];
    const cap = (await openInterest()) + 10n;
    await perpLimits({ openInterestCap: cap });
    await rests(erin, PRICE, 10n);
    await rests(erin, PRICE + 100n, 20n);
    const capped = await buys(frank, PRICE + 100n, 30n);
    expect(capped.status).to.equal(RESULT_STATUS.remainderCancelledFillCheck);
    expect(capped.filled).to.equal(10n);
    expect(capped.cancelled).to.equal(20n);
    expect(await openInterest()).to.equal(cap);
    expect((await erin.client.cancelAll(PERP)).cancelled).to.equal(1n);
    await perpLimits({});
    await custodyMatchesLedger();
  });

  it("sends the set share of a taker fee to the insurance seat and the rest to the fee seat", async () => {
    await perpLimits({ feeInsuranceShareBps: 5_000 });
    const before = await ledgerThroughThePort();
    await rests(erin, PRICE, 100n);
    const bought = await buys(frank, PRICE, 100n);
    expect(bought.fee).to.equal(6_800n);
    const after = await ledgerThroughThePort();
    expect(
      after.seats[INSURANCE_SEAT].collateral -
        before.seats[INSURANCE_SEAT].collateral,
    ).to.equal(3_400n);
    expect(
      after.seats[FEE_SEAT].collateral - before.seats[FEE_SEAT].collateral,
    ).to.equal(3_400n);
    await perpLimits({});
    await custodyMatchesLedger();
  });

  it("lowers a recorded shortfall to what the debtor still owes once it repays, for anyone who asks, and never raises it", async () => {
    const reset = async (price: bigint) =>
      send(
        rollup,
        instructions.resetPrice(
          admin.publicKey,
          PERP,
          price,
          BigInt(await rollupNow()),
        ),
        admin,
      );
    const reconcile = (by: Keypair) =>
      send(rollup, instructions.reconcileShortfall([PERP]), by);
    const repays = (amount: bigint) =>
      deposited(dave, mints.nUSD, COLLATERAL, amount);

    await reset(110_000n);
    const insurance = (await ledgerThroughThePort()).seats[INSURANCE_SEAT]
      .collateral;
    const done = await erin.client.liquidate(
      PERP,
      dave.seat,
      1_000n,
      200_000n,
      [PERP],
    );
    expect(done.status).to.equal(LIQUIDATION_STATUS.liquidated);
    expect(done.filled).to.equal(1_000n);
    expect(done.fee).to.equal(insurance);
    const owed = done.rested;
    expect(owed > 10n * USD).to.equal(true);
    expect((await seat(dave)).perp[PERP].base).to.equal(0n);
    expect((await seat(dave)).collateral).to.equal(-owed);
    expect((await perp()).uncoveredShortfall).to.equal(owed);
    expect((await perp()).status).to.equal(MARKET_STATUS.reduceOnly);
    await perpLimits({});
    expect(
      (await perp()).status,
      "a limits update while a shortfall is recorded",
    ).to.equal(MARKET_STATUS.reduceOnly);
    await refuses(resumed(), "ShortfallOutstanding");

    await reconcile(stranger);
    expect((await perp()).uncoveredShortfall).to.equal(owed);
    await repays(5n * USD);
    await reconcile(oracle);
    expect((await perp()).uncoveredShortfall).to.equal(owed - 5n * USD);
    await repays(owed - 5n * USD);
    await reconcile(gate);
    expect((await perp()).uncoveredShortfall).to.equal(0n);
    expect((await seat(dave)).collateral).to.equal(0n);

    await reset(PRICE);
    await resumed();
    expect((await perp()).status).to.equal(MARKET_STATUS.active);
    await custodyMatchesLedger();
  });
});

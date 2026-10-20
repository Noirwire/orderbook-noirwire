/**
 * Audit, limits for a small market before real deposits. Three proofs that
 * need the local network:
 *
 * 1. RULES 11: a trader's deposit that would take a token's custody above
 *    the admin's cap is refused, whoever it is for, and changes nothing, and
 *    a cap below what custody holds stops deposits only. That the admin's
 *    `fund_insurance` is not held to it is shown in
 *    `../orderbook/reserved-seats`.
 * 2. RULES 3 and 6: an order that could take one seat's position past the
 *    market's `position_cap` is refused with a public error whatever the
 *    book holds, a resting order that a lowered cap would let fill past it
 *    fails its owner's fill check, and a position above the cap still
 *    shrinks.
 * 3. RULES 8.5: a deficit the insurance seat cannot cover is paid from the
 *    fee seat's collateral before anything is recorded, so no shortfall
 *    freezes anyone.
 *
 * Runs after the story in `tests/orderbook.test.ts` (it needs its tokens,
 * custody caps and perp market). It leaves the perp market active at the
 * mark it found, with the story's limits, and every custody cap as the
 * story set it.
 */
import { expect } from "chai";
import type { PublicKey } from "@solana/web3.js";
import {
  FEE_SEAT,
  INSURANCE_SEAT,
  LIQUIDATION_STATUS,
  MARKET_STATUS,
  ORDER_TYPE,
  RESULT_STATUS,
  SIDE,
  decodePriceFeed,
  type MarketLimits,
} from "../../sdk/dist/index.js";
import {
  addresses,
  admin,
  balanceOf,
  inPublic,
  instructions,
  ledgerThroughThePort,
  publicMarket,
  rollup,
  rollupNow,
  send,
  until,
} from "../support";
import {
  COLLATERAL,
  CUSTODY_CAP,
  NUSD,
  PERP,
  USD,
  attempted,
  cast,
  custodyMatchesLedger,
  custodyOf,
  deposited,
  fundedWith,
  landed,
  limits,
  mints,
  openInterestMatchesBook,
  openedTrader,
  oracle,
  order,
  placing,
  refuses,
  tokenAccount,
  type Trader,
} from "../orderbook/world";

const TICK = 100n;
const BPS = 10_000n;
const TAKER_FEE_BPS = BigInt(limits().takerFeeBps);
const IM_BPS = BigInt(limits().imBps);
/** The part of the deficit the insurance seat cannot cover, in quote atoms. */
const PAST_INSURANCE = 5_000n;

const custody = () => balanceOf(addresses.custody(custodyOf(mints.nUSD)));
const seatOf = async (trader: Trader) =>
  (await ledgerThroughThePort()).seats[trader.seat];
const feeSeat = async () =>
  (await ledgerThroughThePort()).seats[FEE_SEAT].collateral;
const feed = async () =>
  decodePriceFeed(await inPublic(addresses.priceFeed(PERP)));
const perpParams = async () => (await publicMarket(PERP)).params;

const setCap = (cap: bigint) =>
  send(rollup, instructions.setCustodyCap(admin.publicKey, NUSD, cap), admin);
const perpLimits = (over: Partial<MarketLimits>) =>
  send(
    rollup,
    instructions.updateMarket(admin.publicKey, PERP, limits(over)),
    admin,
  );
const resetTo = async (price: bigint) =>
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

/** A deposit of the collateral token by `depositor` into the seat of `owner`. */
const depositFor = (depositor: Trader, owner: PublicKey, amount: bigint) =>
  send(
    rollup,
    instructions.deposit(
      depositor.owner.publicKey,
      tokenAccount(depositor, mints.nUSD),
      custodyOf(mints.nUSD),
      owner,
      COLLATERAL,
      amount,
    ),
    depositor.owner,
  );

const withdrawn = (trader: Trader, amount: bigint) =>
  send(
    rollup,
    instructions.withdraw(
      trader.owner.publicKey,
      tokenAccount(trader, mints.nUSD),
      custodyOf(mints.nUSD),
      COLLATERAL,
      amount,
      [PERP],
    ),
    trader.owner,
  );

/** The perp mark, republished at the rollup's clock so orders can use it. */
async function freshMark(): Promise<bigint> {
  const { price, acceptedAt } = await feed();
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
  return price - (price % TICK);
}

async function trader(collateral: bigint): Promise<Trader> {
  const opened = await openedTrader();
  await fundedWith(opened, mints.nUSD, collateral);
  await deposited(opened, mints.nUSD, COLLATERAL, collateral);
  return opened;
}

const rests = async (seat: Trader, side: number, price: bigint, size: bigint) =>
  expect(
    landed(
      await seat.client.placeOrder(
        PERP,
        order(side, ORDER_TYPE.postOnly, price, size),
      ),
    ).status,
  ).to.equal(RESULT_STATUS.rested);

const takes = async (
  seat: Trader,
  side: number,
  price: bigint,
  size: bigint,
  reduceOnly = false,
) =>
  landed(
    await seat.client.placeOrder(PERP, {
      ...order(side, ORDER_TYPE.immediateOrCancel, price, size),
      reduceOnly,
    }),
  );

/** An immediate-or-cancel order sent raw, so a refusal is the program's error. */
const sentRaw = (seat: Trader, side: number, price: bigint, size: bigint) =>
  attempted(
    seat,
    placing(seat, PERP, order(side, ORDER_TYPE.immediateOrCancel, price, size)),
  );

describe("audit: limits for a small market before real deposits", () => {
  it("refuses a deposit past the token's custody cap whoever it is for, and a cap below custody stops deposits only", async () => {
    const depositor = await openedTrader();
    await fundedWith(depositor, mints.nUSD, 10n * USD);
    const cap = (await custody()) + 5n * USD;
    await setCap(cap);
    const before = await ledgerThroughThePort();

    for (const owner of [depositor.owner, cast.alice.owner]) {
      await refuses(
        depositFor(depositor, owner.publicKey, 5n * USD + 1n),
        "CustodyCapReached",
        "the same refusal for an empty seat and a funded one",
      );
    }
    expect(await ledgerThroughThePort()).to.deep.equal(before);
    expect(await custody()).to.equal(cap - 5n * USD);

    await depositFor(depositor, depositor.owner.publicKey, 5n * USD);
    expect(await custody()).to.equal(cap);
    expect((await seatOf(depositor)).collateral).to.equal(5n * USD);
    await refuses(
      depositFor(depositor, depositor.owner.publicKey, 1n),
      "CustodyCapReached",
    );

    await setCap(cap - 3n * USD);
    await withdrawn(depositor, 2n * USD);
    expect((await seatOf(depositor)).collateral).to.equal(3n * USD);
    expect(
      await custody(),
      "custody still above the lowered cap after a withdrawal",
    ).to.equal(cap - 2n * USD);
    await refuses(
      depositFor(depositor, depositor.owner.publicKey, 1n),
      "CustodyCapReached",
      "a cap lowered below custody stops deposits and nothing else",
    );

    await setCap(CUSTODY_CAP);
    await depositFor(depositor, depositor.owner.publicKey, 1n * USD);
    expect((await seatOf(depositor)).collateral).to.equal(4n * USD);
    await custodyMatchesLedger();
  });

  it("refuses an order that could pass the position cap whatever the book, fails a resting order a lowered cap stops, and lets a position above it shrink", async () => {
    const price = await freshMark();
    const taker = await trader(100n * USD);
    const [first, second] = [
      await trader(100n * USD),
      await trader(100n * USD),
    ];
    await perpLimits({ positionCap: 150n });
    expect((await perpParams()).positionCap).to.equal(150n);

    await refuses(
      sentRaw(taker, SIDE.bid, price, 151n),
      "PositionCapExceeded",
      "with nothing to match",
    );
    await rests(first, SIDE.ask, price, 100n);
    await rests(second, SIDE.ask, price, 100n);
    const before = await ledgerThroughThePort();
    await refuses(
      sentRaw(taker, SIDE.bid, price, 200n),
      "PositionCapExceeded",
      "the same refusal with asks to match",
    );
    expect(await ledgerThroughThePort()).to.deep.equal(before);

    const toTheCap = await takes(taker, SIDE.bid, price, 150n);
    expect(toTheCap.status).to.equal(RESULT_STATUS.filled);
    expect((await seatOf(taker)).perp[PERP].base).to.equal(150n);
    await refuses(
      sentRaw(taker, SIDE.bid, price, 50n),
      "PositionCapExceeded",
      "at the cap, an order big enough to pass the minimum notional",
    );

    await perpLimits({ positionCap: 60n });
    const stopped = await takes(first, SIDE.bid, price, 50n);
    expect(stopped.filled, "the resting ask past the lowered cap").to.equal(0n);
    const maker = (await seatOf(second)).perp[PERP];
    expect([maker.base, maker.openAskLots]).to.deep.equal([-50n, 0n]);

    await rests(first, SIDE.bid, price, 30n);
    const shrunk = await takes(taker, SIDE.ask, price, 30n, true);
    expect(shrunk.filled, "a position above the cap shrinks").to.equal(30n);
    expect((await seatOf(taker)).perp[PERP].base).to.equal(120n);
    expect((await seatOf(first)).perp[PERP].base).to.equal(-70n);
    await refuses(
      sentRaw(taker, SIDE.bid, price, 1n),
      "PositionCapExceeded",
      "above the lowered cap",
    );

    await perpLimits({});
    await openInterestMatchesBook();
    await custodyMatchesLedger();
  });

  it("pays a deficit insurance cannot cover from the fee seat's collateral, and records no shortfall", async () => {
    const price = await freshMark();
    const insurance = (await ledgerThroughThePort()).seats[INSURANCE_SEAT]
      .collateral;
    const deficit = insurance + PAST_INSURANCE;
    const lots = (() => {
      const halfMarkDrop =
        ((deficit + 1_000n) * BPS) / ((BPS / 2n - IM_BPS) * price) + 1n;
      return halfMarkDrop > 100n ? halfMarkDrop : 100n;
    })();
    const notional = lots * price;
    const fee = (notional * TAKER_FEE_BPS + BPS - 1n) / BPS;
    const initial = (notional * IM_BPS) / BPS;
    const left = initial + 1_000n;

    const [buyer, seller] = [
      await trader(1_000n * USD),
      await trader(1_000n * USD),
    ];
    while ((await feeSeat()) < 2n * PAST_INSURANCE + lots) {
      await rests(seller, SIDE.ask, price, 1_000n);
      await takes(buyer, SIDE.bid, price, 1_000n);
      await rests(buyer, SIDE.ask, price, 1_000n);
      await takes(seller, SIDE.bid, price, 1_000n);
    }

    const maker = await trader(2n * initial + 10n * USD);
    const liquidator = await trader(2n * initial + 10n * USD);
    const target = await trader(left + fee);
    await rests(maker, SIDE.ask, price, lots);
    expect((await takes(target, SIDE.bid, price, lots)).filled).to.equal(lots);
    expect((await seatOf(target)).collateral).to.equal(left);

    const before = await ledgerThroughThePort();
    expect(before.seats[INSURANCE_SEAT].collateral).to.equal(insurance);
    const fees = before.seats[FEE_SEAT].collateral;
    const drop = (left + deficit + lots - 1n) / lots;
    expect(drop < price, "the reset mark stays above zero").to.equal(true);
    await resetTo(price - drop);
    const done = await liquidator.client.liquidate(
      PERP,
      target.seat,
      lots,
      price,
    );

    expect(done.status).to.equal(LIQUIDATION_STATUS.liquidated);
    expect(done.filled).to.equal(lots);
    expect(done.rested, "nothing left uncovered").to.equal(0n);
    const fromFees = done.fee - insurance;
    expect(fromFees > 0n, "the fee seat paid the rest").to.equal(true);
    const after = await ledgerThroughThePort();
    expect(after.seats[INSURANCE_SEAT].collateral).to.equal(0n);
    expect(after.seats[FEE_SEAT].collateral).to.equal(fees - fromFees);
    expect(after.seats[target.seat].collateral).to.equal(0n);
    expect(after.seats[target.seat].perp[PERP].base).to.equal(0n);
    expect((await perpParams()).uncoveredShortfall).to.equal(0n);

    await resetTo(price);
    await send(rollup, instructions.resumeMarket(admin.publicKey, PERP), admin);
    expect((await perpParams()).status).to.equal(MARKET_STATUS.active);
    await withdrawn(buyer, 1n * USD);
    await openInterestMatchesBook();
    await custodyMatchesLedger();
  });
});

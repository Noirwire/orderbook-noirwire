/**
 * This build, deployed over the earlier one, with the exchange and both
 * markets still paused: the market and the USDC guard rebound to MagicBlock's
 * oracle with the steps `make mainnet-set-price-source` takes, the settlement
 * that rebind leaves, the first accepted price, the market's limits written
 * again, the resume and the unpause, the trigger books every market needs, and
 * then trades, a stop on a position the earlier build opened, withdrawals and
 * closed views on the state the earlier build left.
 */
import { expect } from "chai";
import {
  INCIDENT_REASON,
  MARKET_KIND,
  MARKET_STATUS,
  MAX_FIRES_PER_PASS,
  NO_SEAT,
  ORACLE_HEALTH,
  ORDER_TYPE,
  QUOTE_STATE,
  RESULT_STATUS,
  SIDE,
  TRIGGER_KIND,
  clockOf,
  decodePriceFeed,
  liveSeatCapacity,
  positionOn,
  setupTriggerBook,
  triggerAccountLen,
} from "../../sdk/dist/index.js";
import {
  checkedObservation,
  firstSyncFailure,
} from "../../sdk/dist/operator/index.js";
import {
  MAINNET_PRICE_FEEDS,
  MAINNET_QUOTE_SOURCE,
} from "../../ops/deployment";
import { limitsOf } from "../../ops/limits";
import { rebindRefusal } from "../../ops/pricesource";
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
  solana,
  throughThePort,
  until,
  viewThroughThePort,
} from "../support";
import {
  COLLATERAL,
  TICK,
  attempted,
  placing,
  USD,
  custodyMatchesLedger,
  custodyOf,
  exchangeOn,
  freshMark,
  fundedTrader,
  landed,
  mints,
  NOBODY,
  openInterestMatchesBook,
  oracle,
  order,
  perpMarketIdsOn,
  refuses,
  SECONDS_PER_DAY,
  stranger,
  tokenAccount,
  type Trader,
} from "../orderbook/world";
import {
  BOUND_PERP,
  PERP_MARKETS,
  UNBOUND_PERP,
  handedToThisBuild,
  upgrade,
} from "./earlier-build";
import { MARKS, PRICES } from "./price-fixtures";
import {
  fixturesOnSolana,
  notServed,
  sentWith,
  type PriceFixtures,
} from "./served-prices";
import { bookCounts, positionOf, snapshotOf } from "./snapshot";
import { unitOf } from "./story-facts";

/** How far under the mark a stop sits, and how far under it the stop's order will sell. */
const STOP_BELOW = 1_000n;
const WORST_BELOW = 3_000n;
/** Where the resting bid a stop sells into sits, and how far past the stop the mark is moved. */
const BID_BELOW = 500n;
const PAST = 1_500n;

const owners = () => [
  upgrade.alice.owner.publicKey,
  upgrade.bob.owner.publicKey,
];

const feedOf = async (marketId: number) =>
  decodePriceFeed(await inPublic(addresses.priceFeed(marketId)));

const baseOf = async (trader: Trader, marketId: number) =>
  positionOn((await ledgerThroughThePort()).seats[trader.seat], marketId).base;

const marketOf = async (marketId: number) =>
  (await publicMarket(marketId)).params;

/** Moves the unbound market's mark to `price` once the rollup clock has passed the last accepted price. */
async function markMovedTo(price: bigint): Promise<void> {
  const { acceptedAt } = await feedOf(UNBOUND_PERP);
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
      UNBOUND_PERP,
      price,
      BigInt(await rollupNow()),
    ),
    oracle,
  );
}

/** A reduce-only order, which never rests: what it cannot fill is cancelled. */
const reducing = (
  side: number,
  orderType: number,
  price: bigint,
  size: bigint,
) => ({
  ...order(side, orderType, price, size),
  reduceOnly: true,
});

/** `trader`'s nUSD collateral taken out to its token account, and its view closed. */
async function withdrawnAndClosed(trader: Trader): Promise<void> {
  const owner = trader.owner.publicKey;
  const { collateral } = (await ledgerThroughThePort()).seats[trader.seat];
  expect(
    collateral > 0n,
    "a seat that traded to flat holds collateral",
  ).to.equal(true);
  const before = await balanceOf(tokenAccount(trader, mints.nUSD));
  await send(
    rollup,
    instructions.withdraw(
      owner,
      tokenAccount(trader, mints.nUSD),
      custodyOf(mints.nUSD),
      COLLATERAL,
      collateral,
      PERP_MARKETS,
    ),
    trader.owner,
  );
  expect(await balanceOf(tokenAccount(trader, mints.nUSD))).to.equal(
    before + collateral,
  );
  expect(
    (await viewThroughThePort(owner)).seat,
    "emptying the seat gives it back",
  ).to.equal(NO_SEAT);
  await send(rollup, instructions.closeTrader(owner), trader.owner);
  expect(await rollup.getAccountInfo(addresses.view(owner))).to.equal(null);
}

describe("upgrade: MagicBlock's oracle, and trading on the state the earlier build left", () => {
  let fixtures: PriceFixtures;

  before(async () => {
    fixtures = await fixturesOnSolana();
  });

  it("checks both MagicBlock accounts as the program reads them, then rebinds the market and the guard while both are paused", async () => {
    const params = await marketOf(BOUND_PERP);
    expect(rebindRefusal(params.status), "the market is paused").to.equal(null);
    const clock = await clockOf(rollup);
    for (const [name, fixture] of [
      ["magicblockSol", fixtures.magicblockSol],
      ["magicblockUsdc", fixtures.magicblockUsdc],
    ] as const) {
      const served =
        (await rollup.getAccountInfo(fixture.address)) ??
        (await solana.getAccountInfo(fixture.address));
      if (!served) throw notServed(name, fixture, "no account is served");
      const observation = checkedObservation(
        fixture.address,
        served,
        fixture.address,
      );
      if (name === "magicblockSol") {
        expect(
          firstSyncFailure(observation, clock, {
            maxPriceAge: Number(params.maxPriceAge),
            markPublishTime: Number((await feedOf(BOUND_PERP)).publishTime),
          }),
          "the first sync would not be refused",
        ).to.equal(null);
      }
    }

    await send(
      rollup,
      instructions.setPriceSource(
        admin.publicKey,
        BOUND_PERP,
        MAINNET_PRICE_FEEDS.solUsd.feed,
      ),
      admin,
    );
    await send(
      rollup,
      instructions.setQuoteSource(admin.publicKey, MAINNET_QUOTE_SOURCE),
      admin,
    );
  });

  it("keeps the mark, every position and every resting order, and reads as settling", async () => {
    const before = upgrade.before;
    const after = await snapshotOf(owners(), PERP_MARKETS);
    const feed = after.feeds.get(BOUND_PERP);
    const market = after.markets.get(BOUND_PERP);
    if (!feed || !market) throw new Error("the market is missing");
    expect(feed.price, "positions stay valued").to.equal(MARKS.pyth);
    expect(
      feed.binding.account.equals(MAINNET_PRICE_FEEDS.solUsd.account),
      "the market reads MagicBlock's account",
    ).to.equal(true);
    expect(feed.binding.feed).to.equal(MAINNET_PRICE_FEEDS.solUsd.feed);
    expect(feed.binding.expo).to.equal(-8);
    expect(feed.binding.baseDecimals).to.equal(9);
    expect(feed.binding.quoteDecimals).to.equal(6);
    expect(feed.source.rawPrice, "the source record starts again").to.equal(0n);
    expect(feed.incident.reason).to.equal(INCIDENT_REASON.settledGap);
    expect(market.params.oracleHealth).to.equal(ORACLE_HEALTH.settling);
    expect(market.params.status).to.equal(MARKET_STATUS.paused);

    expect(
      after.exchange.quote.account.equals(MAINNET_PRICE_FEEDS.usdcUsd.account),
    ).to.equal(true);
    expect(after.exchange.quote.feed).to.equal(
      MAINNET_PRICE_FEEDS.usdcUsd.feed,
    );
    expect(after.exchange.quote.depegBps).to.equal(100);
    expect(after.exchange.quote.state).to.equal(QUOTE_STATE.unbound);
    expect(after.exchange.quote.okUntil).to.equal(0n);

    for (const name of [
      "ledger",
      "stats",
      `view ${upgrade.alice.owner.publicKey.toBase58()}`,
      `view ${upgrade.bob.owner.publicKey.toBase58()}`,
      `book ${UNBOUND_PERP}`,
      `market ${UNBOUND_PERP}`,
      `price feed ${UNBOUND_PERP}`,
      `tape ${UNBOUND_PERP}`,
      `tape ${BOUND_PERP}`,
    ]) {
      const kept = before.bytes.get(name);
      if (!kept) throw new Error(`the snapshot has no ${name}`);
      expect(after.bytes.get(name)?.equals(kept), `${name} changed`).to.equal(
        true,
      );
    }
    expect(bookCounts(after, BOUND_PERP)).to.deep.equal(
      bookCounts(before, BOUND_PERP),
    );
    for (const trader of [upgrade.alice, upgrade.bob]) {
      expect(
        positionOf(after, trader.owner.publicKey, BOUND_PERP),
      ).to.deep.equal(positionOf(before, trader.owner.publicKey, BOUND_PERP));
    }
  });

  it("refuses to resume the market, to change its limits and to pay out collateral while the settlement stands", async () => {
    const ids = await perpMarketIdsOn(rollup);
    await refuses(
      send(
        rollup,
        instructions.resumeMarket(admin.publicKey, BOUND_PERP, ids),
        admin,
      ),
      "OracleIncident",
    );
    await refuses(
      send(
        rollup,
        instructions.updateMarket(
          admin.publicKey,
          BOUND_PERP,
          limitsOf(await marketOf(BOUND_PERP)),
        ),
        admin,
      ),
      "OracleIncident",
    );
    const { bob } = upgrade;
    await refuses(
      send(
        rollup,
        instructions.withdraw(
          bob.owner.publicKey,
          tokenAccount(bob, mints.nUSD),
          custodyOf(mints.nUSD),
          COLLATERAL,
          1n,
          PERP_MARKETS,
        ),
        bob.owner,
      ),
      "OracleIncident",
    );
  });

  it("refuses the USDC price as stale under mainnet's guard window, since the fixtures were stamped ten minutes before the run, then widens the window to a day so the story can go on", async () => {
    await refuses(
      send(
        rollup,
        instructions.syncQuote(fixtures.magicblockUsdc.address),
        stranger,
      ),
      "PriceTooOld",
    );
    expect(
      (await exchangeOn(rollup)).quote.state,
      "a refused sync writes nothing",
    ).to.equal(QUOTE_STATE.unbound);
    await send(
      rollup,
      instructions.setQuoteSource(admin.publicKey, {
        ...MAINNET_QUOTE_SOURCE,
        maxAge: SECONDS_PER_DAY,
      }),
      admin,
    );
  });

  it("heals on the first MagicBlock price the program accepts, and the guard passes on its first", async () => {
    await sentWith(
      "magicblockSol",
      fixtures.magicblockSol,
      send(
        rollup,
        instructions.syncPrice(BOUND_PERP, fixtures.magicblockSol.address),
        stranger,
      ),
    );
    await sentWith(
      "magicblockUsdc",
      fixtures.magicblockUsdc,
      send(
        rollup,
        instructions.syncQuote(fixtures.magicblockUsdc.address),
        stranger,
      ),
    );
    const feed = await feedOf(BOUND_PERP);
    expect(feed.price).to.equal(MARKS.magicblock);
    expect(feed.source.rawPrice).to.equal(PRICES.magicblockSol);
    const params = await marketOf(BOUND_PERP);
    expect(params.oracleHealth).to.equal(ORACLE_HEALTH.healthy);
    expect(params.status, "a sync never opens a paused market").to.equal(
      MARKET_STATUS.paused,
    );
    const { quote } = await exchangeOn(rollup);
    expect(quote.state).to.equal(QUOTE_STATE.healthy);
    expect(quote.price).to.equal(PRICES.magicblockUsdc);
    expect(quote.okUntil - quote.publishTime).to.equal(SECONDS_PER_DAY);
  });

  it("takes the market's limits back whole in this build's layout, and every one is as it was", async () => {
    const before = await marketOf(BOUND_PERP);
    await send(
      rollup,
      instructions.updateMarket(admin.publicKey, BOUND_PERP, limitsOf(before)),
      admin,
    );
    expect(await marketOf(BOUND_PERP)).to.deep.equal(before);
  });

  it("resumes both markets, then unpauses the exchange", async () => {
    const ids = await perpMarketIdsOn(rollup);
    for (const id of PERP_MARKETS) {
      await send(
        rollup,
        instructions.resumeMarket(admin.publicKey, id, ids),
        admin,
      );
      expect((await marketOf(id)).status).to.equal(MARKET_STATUS.active);
    }
    await send(rollup, instructions.setPaused(admin.publicKey, false), admin);
    expect((await exchangeOn(rollup)).paused).to.equal(false);
  });

  it("creates each market's trigger book, sized for the ledger's seats", async () => {
    const exchange = await exchangeOn(rollup);
    for (const id of PERP_MARKETS) {
      await setupTriggerBook(rollup, admin, id, MARKET_KIND.perp);
      expect(
        (await throughThePort(addresses.triggers(id))).length,
        `market ${id}'s trigger book`,
      ).to.equal(triggerAccountLen(liveSeatCapacity(exchange)));
    }
  });

  it("cancels the orders the earlier build rested, which this build's client finds in the book", async () => {
    handedToThisBuild(upgrade.alice);
    handedToThisBuild(upgrade.bob);
    for (const id of PERP_MARKETS) {
      await upgrade.alice.client.cancelAll(id);
      await upgrade.bob.client.cancelAll(id);
      const ledger = await ledgerThroughThePort();
      expect(
        positionOn(ledger.seats[upgrade.alice.seat], id).openAskLots,
      ).to.equal(0n);
      expect(
        positionOn(ledger.seats[upgrade.bob.seat], id).openBidLots,
      ).to.equal(0n);
      expect(bookCounts(await snapshotOf(owners(), [id]), id)).to.include({
        bids: 0,
        asks: 0,
      });
    }
  });

  it("still lets the listed seat rest an order and still refuses the blocked seat's", async () => {
    const { listed, blocked } = upgrade;
    handedToThisBuild(listed);
    handedToThisBuild(blocked);
    const unit = unitOf(UNBOUND_PERP);
    const mark = await freshMark(UNBOUND_PERP);
    const bid = order(SIDE.bid, ORDER_TYPE.postOnly, mark - 5n * TICK, unit);
    const rested = landed(await listed.client.placeOrder(UNBOUND_PERP, bid));
    expect(rested.status).to.equal(RESULT_STATUS.rested);
    await listed.client.cancelAll(UNBOUND_PERP);
    await refuses(
      attempted(
        blocked,
        placing(blocked, UNBOUND_PERP, bid, await perpMarketIdsOn(rollup)),
      ),
      "SeatBlocked",
    );
  });

  it("clears the listed and the blocked seat's access, so the access lists' audit starts from clear seats", async () => {
    const { listed, blocked } = upgrade;
    const perpMarketIds = await perpMarketIdsOn(rollup);
    for (const trader of [listed, blocked]) {
      await send(
        rollup,
        instructions.setSeatAccess(
          admin.publicKey,
          trader.owner.publicKey,
          NOBODY,
          perpMarketIds,
        ),
        admin,
      );
      const seat = (await ledgerThroughThePort()).seats[trader.seat];
      expect([
        seat.makerMarkets,
        seat.takerMarkets,
        seat.blocked,
      ]).to.deep.equal([0n, 0n, false]);
    }
  });

  it("sets, cancels and sets again a stop on the long the earlier build opened, and fires it into a resting bid", async () => {
    const { alice, bob } = upgrade;
    const unit = unitOf(UNBOUND_PERP);
    const mark = await freshMark(UNBOUND_PERP);
    const stop = (trigger: bigint) => ({
      kind: TRIGGER_KIND.stopLoss,
      triggerPrice: trigger,
      worstPrice: mark - WORST_BELOW,
      size: 0n,
    });
    const first = await bob.client.setTrigger(
      UNBOUND_PERP,
      stop(mark - STOP_BELOW),
    );
    expect(first.status, `refused with error ${first.code}`).to.not.equal(
      RESULT_STATUS.refused,
    );
    const cancelled = await bob.client.cancelTrigger(
      UNBOUND_PERP,
      TRIGGER_KIND.stopLoss,
    );
    expect(cancelled.cancelled).to.equal(1n);
    const set = await bob.client.setTrigger(
      UNBOUND_PERP,
      stop(mark - STOP_BELOW),
    );
    expect(set.status, `refused with error ${set.code}`).to.not.equal(
      RESULT_STATUS.refused,
    );

    const maker = await fundedTrader(100n * USD);
    const bid = landed(
      await maker.client.placeOrder(
        UNBOUND_PERP,
        order(SIDE.bid, ORDER_TYPE.postOnly, mark - BID_BELOW, 2n * unit),
      ),
    );
    expect(bid.status).to.equal(RESULT_STATUS.rested);
    await markMovedTo(mark - PAST);
    await send(
      rollup,
      instructions.fireTriggers(
        UNBOUND_PERP,
        MAX_FIRES_PER_PASS,
        await perpMarketIdsOn(rollup),
      ),
      stranger,
    );
    expect(
      await baseOf(bob, UNBOUND_PERP),
      "the stop closed the long",
    ).to.equal(0n);
    expect(await baseOf(maker, UNBOUND_PERP)).to.equal(2n * unit);

    await markMovedTo(mark);
    const sold = landed(
      await maker.client.placeOrder(
        UNBOUND_PERP,
        order(SIDE.ask, ORDER_TYPE.limit, mark, 2n * unit),
      ),
    );
    expect(sold.status).to.equal(RESULT_STATUS.rested);
    const covered = landed(
      await alice.client.placeOrder(
        UNBOUND_PERP,
        reducing(SIDE.bid, ORDER_TYPE.immediateOrCancel, mark, 2n * unit),
      ),
    );
    expect(covered.filled, "the short buys back from the maker").to.equal(
      2n * unit,
    );
    expect(await baseOf(alice, UNBOUND_PERP)).to.equal(0n);
    expect(await baseOf(maker, UNBOUND_PERP)).to.equal(0n);
    await openInterestMatchesBook(UNBOUND_PERP);
  });

  it("closes the long and the short on the market that now reads MagicBlock's price", async () => {
    const { alice, bob } = upgrade;
    const unit = unitOf(BOUND_PERP);
    const { price } = await feedOf(BOUND_PERP);
    const mark = price - (price % TICK);
    const rested = landed(
      await bob.client.placeOrder(
        BOUND_PERP,
        order(SIDE.ask, ORDER_TYPE.limit, mark, 2n * unit),
      ),
    );
    expect(rested.status).to.equal(RESULT_STATUS.rested);
    const bought = landed(
      await alice.client.placeOrder(
        BOUND_PERP,
        reducing(SIDE.bid, ORDER_TYPE.immediateOrCancel, mark, 2n * unit),
      ),
    );
    expect(bought.filled).to.equal(2n * unit);
    expect(await baseOf(alice, BOUND_PERP)).to.equal(0n);
    expect(await baseOf(bob, BOUND_PERP)).to.equal(0n);
    await openInterestMatchesBook(BOUND_PERP);
    await custodyMatchesLedger();
  });

  it("pays both traders' collateral out and closes their views", async () => {
    await withdrawnAndClosed(upgrade.alice);
    await withdrawnAndClosed(upgrade.bob);
    await custodyMatchesLedger();
  });
});

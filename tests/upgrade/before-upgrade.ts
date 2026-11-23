/**
 * The earlier build, the program mainnet runs, loaded at the program's address:
 * an exchange, two tokens, a ledger, a perp market bound to nothing and one
 * bound to Pyth's SOL/USD, the USDC guard bound to Pyth's USDC/USD, and a story
 * on both markets. Then, as the upgrade procedure does first, the exchange and
 * both markets are paused, and every account is read.
 */
import { expect } from "chai";
import {
  MARKET_STATUS,
  ORDER_TYPE,
  ORACLE_HEALTH,
  QUOTE_STATE,
  RESULT_STATUS,
  SIDE,
  decodePriceFeed,
  setupLedger,
} from "../../sdk/dist/index.js";
import { airdropped } from "../../ops/sending";
import { ensureExchange } from "../../ops/exchange";
import {
  createMint,
  ensureCustody,
  fundRentPda,
  registeredToken,
} from "../../ops/tokens";
import {
  PROGRAM_ID,
  VALIDATOR,
  addresses,
  admin,
  inPublic,
  instructions,
  ledgerThroughThePort,
  publicMarket,
  refusal,
  rollup,
  send,
  solana,
} from "../support";
import {
  COLLATERAL,
  EXCHANGE_FLOAT,
  MARK,
  SEAT_CLOSED,
  NSOL,
  NUSD,
  SEATS_PER_DAY,
  TICK,
  USD,
  custodyOf,
  exchangeOn,
  gate,
  landed,
  leastLots,
  mints,
  oracle,
  order,
  perpMarketIdsOn,
  stranger,
  tokenAccount,
} from "../orderbook/world";
import {
  BOUND_PERP,
  NO_SUCH_INSTRUCTION,
  PERP_MARKETS,
  UNBOUND_PERP,
  createdOnEarlierBuild,
  earlier,
  fundedOnEarlierBuild,
  markOf,
  pythPerp,
  pythQuote,
  refusalOfSetPriceSource,
  unboundPerp,
  upgrade,
} from "./earlier-build";
import {
  MARKS,
  PRICES,
  PUBLISH_TIME_AT,
  PYTH_SOL_FEED_ID,
  PYTH_USDC_FEED_ID,
  pythPriceAccount,
} from "./price-fixtures";
import {
  fixturesOnSolana,
  notServed,
  sentWith,
  type PriceFixtures,
} from "./served-prices";
import { snapshotOf } from "./snapshot";
import { expectTheStory } from "./story-facts";

describe("upgrade: the earlier build, set up and left in a story", () => {
  let fixtures: PriceFixtures;

  before(async () => {
    await airdropped(solana, admin.publicKey, 100);
    await airdropped(solana, stranger.publicKey, 5);
  });

  it("starts from a program deployed at the program's address and the price accounts the validator loaded", async () => {
    expect(
      process.env.UPGRADE_SO,
      "UPGRADE_SO names the build to deploy over it",
    ).to.be.a("string");
    expect((await solana.getAccountInfo(PROGRAM_ID))?.executable).to.equal(
      true,
    );
    fixtures = await fixturesOnSolana();
    for (const [name, fixture] of Object.entries(fixtures)) {
      const account = await solana.getAccountInfo(fixture.address);
      expect(account, name).to.not.equal(null);
      expect(account?.owner.equals(fixture.owner), `${name}'s owner`).to.equal(
        true,
      );
      expect(
        Buffer.from(account?.data ?? []).equals(fixture.data),
        `${name}'s bytes`,
      ).to.equal(true);
    }
  });

  it("sets up the exchange, delegated to the rollup", async () => {
    await ensureExchange({
      solana,
      rollup,
      admin,
      gate: gate.publicKey,
      oracle: oracle.publicKey,
      validator: VALIDATOR,
      floatLamports: EXCHANGE_FLOAT,
      maxSeatsPerDay: SEATS_PER_DAY,
    });
    expect(
      (await rollup.getAccountInfo(addresses.exchange))?.owner.equals(
        PROGRAM_ID,
      ),
    ).to.equal(true);
  });

  it("registers the two tokens, grows the ledger to its full size and finalises it", async () => {
    await fundRentPda(solana, admin);
    mints.nUSD = await createMint(solana, admin, 6);
    mints.nSOL = await createMint(solana, admin, 9);
    for (const [index, mint] of [
      [NUSD, mints.nUSD],
      [NSOL, mints.nSOL],
    ] as const) {
      await ensureCustody(solana, admin, addresses, custodyOf(mint), VALIDATOR);
      await registeredToken(
        rollup,
        instructions,
        admin,
        index,
        custodyOf(mint),
      );
    }
    await setupLedger(rollup, admin);
  });

  it("creates a perp market bound to nothing and one bound to Pyth's SOL/USD", async () => {
    await createdOnEarlierBuild(UNBOUND_PERP, unboundPerp());
    await createdOnEarlierBuild(BOUND_PERP, pythPerp());
    expect((await publicMarket(UNBOUND_PERP)).header.ready).to.equal(true);
    expect((await publicMarket(BOUND_PERP)).header.ready).to.equal(true);
    const feed = decodePriceFeed(
      await inPublic(addresses.priceFeed(BOUND_PERP)),
    );
    expect(
      feed.binding.account.equals(pythPriceAccount(PYTH_SOL_FEED_ID)),
    ).to.equal(true);
    expect(feed.price, "no mark until the first sync").to.equal(0n);
  });

  it("runs the earlier build, which has no set_price_source_v2", async () => {
    expect(await refusalOfSetPriceSource()).to.include(NO_SUCH_INSTRUCTION);
  });

  it("is served each price account by the rollup", async () => {
    for (const [name, fixture] of Object.entries(fixtures)) {
      const refused = await refusal(
        send(
          rollup,
          earlier.syncPrice(UNBOUND_PERP, fixture.address),
          stranger,
        ),
      );
      if (!refused.includes("Error Code: WrongPriceAccount.")) {
        throw notServed(name, fixture, refused);
      }
    }
  });

  it("gives the Pyth market its first mark from the Pyth account, and the other market its mark from the admin, and opens both", async () => {
    await sentWith(
      "pythSol",
      fixtures.pythSol,
      send(
        rollup,
        earlier.syncPrice(BOUND_PERP, fixtures.pythSol.address),
        stranger,
      ),
    );
    const feed = decodePriceFeed(
      await inPublic(addresses.priceFeed(BOUND_PERP)),
    );
    expect(feed.price).to.equal(MARKS.pyth);
    expect((await publicMarket(BOUND_PERP)).params.status).to.equal(
      MARKET_STATUS.reduceOnly,
    );
    await send(
      rollup,
      instructions.resetPrice(
        admin.publicKey,
        UNBOUND_PERP,
        MARK,
        fixtures.pythSol.data.readBigInt64LE(PUBLISH_TIME_AT),
      ),
      admin,
    );
    const perpMarketIds = await perpMarketIdsOn(rollup);
    expect(perpMarketIds).to.deep.equal(PERP_MARKETS);
    for (const id of PERP_MARKETS) {
      await send(
        rollup,
        instructions.resumeMarket(admin.publicKey, id, perpMarketIds),
        admin,
      );
      expect((await publicMarket(id)).params.status).to.equal(
        MARKET_STATUS.active,
      );
    }
  });

  it("binds the USDC guard to Pyth's USDC/USD and syncs it", async () => {
    await send(
      rollup,
      earlier.setEarlierQuoteSource(
        admin.publicKey,
        pythQuote(PYTH_USDC_FEED_ID),
      ),
      admin,
    );
    await sentWith(
      "pythUsdc",
      fixtures.pythUsdc,
      send(rollup, instructions.syncQuote(fixtures.pythUsdc.address), stranger),
    );
    const { quote } = await exchangeOn(rollup);
    expect(quote.state).to.equal(QUOTE_STATE.healthy);
    expect(quote.price).to.equal(PRICES.pythUsdc);
  });

  it("trades on the market bound to Pyth: a resting ask, a fill that makes a long and a short, and a resting bid, while the other market holds nothing", async () => {
    const alice = await fundedOnEarlierBuild(200n * USD);
    const bob = await fundedOnEarlierBuild(200n * USD);
    upgrade.alice = alice;
    upgrade.bob = bob;
    upgrade.lots = new Map();
    upgrade.marks = new Map();
    for (const id of PERP_MARKETS) {
      const price = await markOf(id);
      upgrade.lots.set(id, leastLots(price));
      upgrade.marks.set(id, price);
    }
    const price = await markOf(BOUND_PERP);
    const lots = leastLots(price);
    const ask = landed(
      await alice.client.placeOrder(
        BOUND_PERP,
        order(SIDE.ask, ORDER_TYPE.postOnly, price, 4n * lots),
      ),
    );
    expect(ask.status).to.equal(RESULT_STATUS.rested);
    const bought = landed(
      await bob.client.placeOrder(
        BOUND_PERP,
        order(SIDE.bid, ORDER_TYPE.immediateOrCancel, price, 2n * lots),
      ),
    );
    expect(bought.filled).to.equal(2n * lots);
    const bid = landed(
      await bob.client.placeOrder(
        BOUND_PERP,
        order(SIDE.bid, ORDER_TYPE.postOnly, price - 5n * TICK, lots),
      ),
    );
    expect(bid.status).to.equal(RESULT_STATUS.rested);
  });

  it("lists one seat as maker and taker, blocks another, and closes a seat between two open ones", async () => {
    const listed = await fundedOnEarlierBuild(10n * USD);
    const gap = await fundedOnEarlierBuild(10n * USD);
    const blocked = await fundedOnEarlierBuild(10n * USD);
    expect(gap.seat).to.be.greaterThan(listed.seat);
    expect(blocked.seat).to.be.greaterThan(gap.seat);

    const perpMarketIds = await perpMarketIdsOn(rollup);
    const everyPerp = PERP_MARKETS.reduce(
      (bits, id) => bits | (1n << BigInt(id)),
      0n,
    );
    await send(
      rollup,
      instructions.setSeatAccess(
        admin.publicKey,
        listed.owner.publicKey,
        { makerMarkets: everyPerp, takerMarkets: everyPerp, blocked: false },
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

    const { collateral } = (await ledgerThroughThePort()).seats[gap.seat];
    await send(
      rollup,
      instructions.withdraw(
        gap.owner.publicKey,
        tokenAccount(gap, mints.nUSD),
        custodyOf(mints.nUSD),
        COLLATERAL,
        collateral,
        PERP_MARKETS,
      ),
      gap.owner,
    );
    await send(
      rollup,
      instructions.closeTrader(gap.owner.publicKey),
      gap.owner,
    );

    const closed = (await ledgerThroughThePort()).seats[gap.seat];
    expect(closed.status).to.equal(SEAT_CLOSED);
    expect(closed.version > 1n, "a closed seat with a bumped version").to.equal(
      true,
    );
    upgrade.listed = listed;
    upgrade.blocked = blocked;
    upgrade.closedSeat = { index: gap.seat, version: closed.version };
  });

  it("pauses the exchange and both markets, and every account is read", async () => {
    await send(rollup, instructions.setPaused(admin.publicKey, true), admin);
    for (const id of PERP_MARKETS) {
      await send(
        rollup,
        instructions.restrictMarket(admin.publicKey, id, MARKET_STATUS.paused),
        admin,
      );
    }
    upgrade.before = await snapshotOf(
      [upgrade.alice.owner.publicKey, upgrade.bob.owner.publicKey],
      PERP_MARKETS,
    );
    for (const id of PERP_MARKETS) {
      expect(upgrade.before.markets.get(id)?.params.oracleHealth).to.equal(
        ORACLE_HEALTH.healthy,
      );
    }
    expectTheStory(upgrade.before);
  });
});

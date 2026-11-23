/**
 * The upgrade runbook from the deploy to the activation, run on the state the
 * earlier build left with the exchange and both markets still paused: each
 * perp market's trigger book is created and finalised, the seats are scanned
 * in ranges, and the layout is activated. Before the activation it proves the
 * abort: the earlier build is redeployed over this one and finds every account
 * it reads as it left it, resumes its markets, trades and withdraws; then this
 * build is deployed again and the runbook goes on from where it stood.
 */
import { expect } from "chai";
import {
  MARKET_STATUS,
  MAX_SEATS,
  ORDER_TYPE,
  PERP_TRIGGER_BOOK_LEN,
  RESULT_STATUS,
  SIDE,
  TRIGGER_BOOK_VERSION,
  decodeLayoutScan,
  decodeTriggerBookHeader,
  MARKET_KIND,
  NO_SEAT,
  setupTriggerBook,
} from "../../sdk/dist/index.js";
import { scanLedger } from "../../ops/layouting";
import {
  addresses,
  admin,
  balanceOf,
  instructions,
  ledgerThroughThePort,
  publicMarket,
  rollup,
  send,
  throughThePort,
  viewThroughThePort,
} from "../support";
import {
  COLLATERAL,
  SEAT_CLOSED,
  TICK,
  USD,
  custodyOf,
  exchangeOn,
  landed,
  leastLots,
  mints,
  order,
  perpMarketIdsOn,
  refuses,
  stranger,
  tokenAccount,
} from "../orderbook/world";
import { deployed, EARLIER_BUILD_FILE, rollupRuns } from "./deploy";
import {
  PERP_MARKETS,
  UNBOUND_PERP,
  fundedOnEarlierBuild,
  markOf,
  upgrade,
} from "./earlier-build";
import { snapshotOf } from "./snapshot";
import { expectTheStory } from "./story-facts";

/** The seats of the first, partial scan call. */
const PARTIAL_SCAN_SEATS = 100;
/** The seats a scan call reads in the full scan, so that it takes several calls. */
const SCAN_SEATS_PER_CALL = 700;

const owners = () =>
  [upgrade.alice, upgrade.bob, upgrade.listed, upgrade.blocked].map(
    (trader) => trader.owner.publicKey,
  );

const scanOnTheNetwork = async () => {
  const account = await rollup.getAccountInfo(addresses.layoutScan);
  return account ? decodeLayoutScan(account.data) : null;
};

const bookOf = async (marketId: number) => {
  const data = await throughThePort(addresses.triggers(marketId));
  return { ...decodeTriggerBookHeader(data), size: data.length };
};

/** Every perp market's trigger book as the runbook's readback finds it. */
async function expectBooksReady(): Promise<void> {
  for (const id of PERP_MARKETS) {
    const book = await bookOf(id);
    expect(book.size, `market ${id}'s trigger book`).to.equal(
      PERP_TRIGGER_BOOK_LEN,
    );
    expect(
      book.header.ready,
      `market ${id}'s trigger book is finalised`,
    ).to.equal(true);
    expect(book.version).to.equal(TRIGGER_BOOK_VERSION);
    expect(book.seatCapacity).to.equal(MAX_SEATS);
    expect(book.bookMarketId).to.equal(id);
  }
}

/**
 * The balance of each registered token's custody account. The insurance is a seat of
 * the ledger, so the ledger's bytes already hold it.
 */
async function custodyBalances(): Promise<Map<string, bigint>> {
  const balances = new Map<string, bigint>();
  for (const [name, mint] of [
    ["nUSD", mints.nUSD],
    ["nSOL", mints.nSOL],
  ] as const) {
    balances.set(
      `custody of ${name}`,
      await balanceOf(addresses.custody(custodyOf(mint))),
    );
  }
  return balances;
}

/** The custody balances that went with `upgrade.before`, read at the same point of the story. */
let custodyBefore: Map<string, bigint> | undefined;

/** The name and bytes of every account the earlier build reads, as the deploy found them, must be as they were, and no custody balance may have moved. */
async function expectEarlierAccountsAsTheyWere(): Promise<void> {
  const after = await snapshotOf(owners(), PERP_MARKETS);
  for (const [name, bytes] of upgrade.before.bytes) {
    expect(after.bytes.get(name)?.equals(bytes), `${name} changed`).to.equal(
      true,
    );
  }
  if (!custodyBefore) throw new Error("the custody balances were not read");
  const custodyAfter = await custodyBalances();
  for (const [name, balance] of custodyBefore) {
    expect(custodyAfter.get(name), `${name} changed`).to.equal(balance);
  }
}

describe("upgrade: the runbook before the layout is activated", () => {
  it("creates and finalises each perp market's trigger book at the size for the most seats, whatever the ledger holds", async () => {
    custodyBefore = await custodyBalances();
    const exchange = await exchangeOn(rollup);
    expect(exchange.layoutState).to.equal("preActivation");
    const capacity = exchange.seatCapacity ?? 0;
    expect(capacity, "the ledger is smaller than its largest").to.be.lessThan(
      MAX_SEATS,
    );
    for (const id of PERP_MARKETS) {
      expect(
        await rollup.getAccountInfo(addresses.triggers(id)),
        `market ${id} has no trigger book yet`,
      ).to.equal(null);
    }
    for (const id of PERP_MARKETS) {
      await setupTriggerBook(rollup, admin, id, MARKET_KIND.perp);
    }
    await expectBooksReady();
    expect((await exchangeOn(rollup)).seatCapacity).to.equal(capacity);
  });

  it("scans part of the ledger, and refuses to activate on a scan that has not covered it", async () => {
    expect(await scanOnTheNetwork(), "no scan account yet").to.equal(null);
    await send(
      rollup,
      instructions.scanSeatLayout(admin.publicKey, PARTIAL_SCAN_SEATS),
      admin,
    );
    const scan = await scanOnTheNetwork();
    expect(scan?.cursor).to.equal(PARTIAL_SCAN_SEATS);
    expect(scan?.capacity).to.equal((await exchangeOn(rollup)).seatCapacity);
    await refuses(
      send(rollup, instructions.activateLayout(admin.publicKey), admin),
      "LayoutScanIncomplete",
    );
    expect((await exchangeOn(rollup)).layoutState).to.equal("preActivation");
  });

  it("scans the rest of the ledger in ranges from the cursor the scan keeps, and reads the scan back complete", async () => {
    const capacity = (await exchangeOn(rollup)).seatCapacity ?? 0;
    let calls = 0;
    const end = await scanLedger({
      cursor: (await scanOnTheNetwork())?.cursor ?? 0,
      capacity,
      perCall: SCAN_SEATS_PER_CALL,
      send: async (count) => {
        calls += 1;
        await send(
          rollup,
          instructions.scanSeatLayout(admin.publicKey, count),
          admin,
        );
      },
      read: async () => (await scanOnTheNetwork())?.cursor ?? 0,
      say: () => undefined,
    });
    expect(end).to.equal(capacity);
    expect(calls, "the rest took several calls").to.be.greaterThan(1);
    expect((await scanOnTheNetwork())?.cursor).to.equal(capacity);
  });

  it("has changed no account the earlier build reads, so that it can still run on them", async () => {
    await expectEarlierAccountsAsTheyWere();
    await expectBooksReady();
  });

  it("aborts by redeploying the earlier build, which finds every account it reads byte for byte as it left it", async () => {
    await deployed(EARLIER_BUILD_FILE);
    await rollupRuns("earlier");
    await expectEarlierAccountsAsTheyWere();
  });

  it("runs the earlier build's own resume_market and unpause, and a trader of the earlier build trades and withdraws on it", async () => {
    const ids = await perpMarketIdsOn(rollup);
    for (const id of PERP_MARKETS) {
      await send(
        rollup,
        instructions.resumeMarket(admin.publicKey, id, ids),
        admin,
      );
      expect((await publicMarket(id)).params.status).to.equal(
        MARKET_STATUS.active,
      );
    }
    await send(rollup, instructions.setPaused(admin.publicKey, false), admin);
    expect((await exchangeOn(rollup)).paused).to.equal(false);

    const trader = await fundedOnEarlierBuild(20n * USD);
    const mark = await markOf(UNBOUND_PERP);
    const price = mark - 20n * TICK;
    const bid = landed(
      await trader.client.placeOrder(
        UNBOUND_PERP,
        order(SIDE.bid, ORDER_TYPE.postOnly, price, leastLots(price)),
      ),
    );
    expect(bid.status).to.equal(RESULT_STATUS.rested);
    await trader.client.cancelAll(UNBOUND_PERP);

    const { collateral } = (await ledgerThroughThePort()).seats[trader.seat];
    const before = await balanceOf(tokenAccount(trader, mints.nUSD));
    await send(
      rollup,
      instructions.withdraw(
        trader.owner.publicKey,
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
    expect((await viewThroughThePort(trader.owner.publicKey)).seat).to.equal(
      NO_SEAT,
    );
    await send(
      rollup,
      instructions.closeTrader(trader.owner.publicKey),
      trader.owner,
    );
  });

  it("pauses the exchange and both markets again on the earlier build, and reads the state it leaves", async () => {
    await send(rollup, instructions.setPaused(admin.publicKey, true), admin);
    for (const id of PERP_MARKETS) {
      await send(
        rollup,
        instructions.restrictMarket(admin.publicKey, id, MARKET_STATUS.paused),
        admin,
      );
    }
    upgrade.before = await snapshotOf(owners(), PERP_MARKETS);
    custodyBefore = await custodyBalances();
    const { index } = upgrade.closedSeat;
    const closed = upgrade.before.ledger.seats[index];
    expect(closed.status).to.equal(SEAT_CLOSED);
    expect(
      closed.version >= upgrade.closedSeat.version,
      "a closed seat's version never falls",
    ).to.equal(true);
    upgrade.closedSeat = { index, version: closed.version };
    expectTheStory(upgrade.before);
  });

  it("deploys this build again, and finds the trigger books and the complete scan where they were left", async () => {
    const built = process.env.UPGRADE_SO;
    if (!built) throw new Error("UPGRADE_SO must name the program to deploy");
    await deployed(built);
    await rollupRuns("this");
    const exchange = await exchangeOn(rollup);
    expect(exchange.layoutState).to.equal("preActivation");
    expect((await scanOnTheNetwork())?.cursor).to.equal(exchange.seatCapacity);
    await expectBooksReady();
    await expectEarlierAccountsAsTheyWere();
  });

  it("refuses to activate while the exchange is not paused, and unpauses and pauses it again under this build", async () => {
    await send(rollup, instructions.setPaused(admin.publicKey, false), admin);
    await refuses(
      send(rollup, instructions.activateLayout(admin.publicKey), admin),
      "ExchangeNotPaused",
    );
    await refuses(
      send(rollup, instructions.scanSeatLayout(admin.publicKey, 1), admin),
      "ExchangeNotPaused",
    );
    await send(rollup, instructions.setPaused(admin.publicKey, true), admin);
    expect((await exchangeOn(rollup)).layoutState).to.equal("preActivation");
  });

  it("refuses to activate for anyone but the admin", async () => {
    await refuses(
      send(rollup, instructions.activateLayout(stranger.publicKey), stranger),
      "NotAdmin",
    );
    expect((await exchangeOn(rollup)).layoutState).to.equal("preActivation");
  });

  it("activates the layout once the scan has read the whole ledger, and the exchange then reads as active", async () => {
    await send(rollup, instructions.activateLayout(admin.publicKey), admin);
    const exchange = await exchangeOn(rollup);
    expect(exchange.layoutState).to.equal("live");
    expect(exchange.paused, "activation does not unpause").to.equal(true);
  });

  it("refuses the scan and the activation once the layout is active", async () => {
    await refuses(
      send(rollup, instructions.scanSeatLayout(admin.publicKey, 1), admin),
      "LayoutAlreadyActive",
    );
    await refuses(
      send(rollup, instructions.activateLayout(admin.publicKey), admin),
      "LayoutAlreadyActive",
    );
  });

  it("reads each ready trigger book as the program does now that the layout is active", async () => {
    await expectBooksReady();
    for (const id of PERP_MARKETS) {
      await send(rollup, instructions.sweepTriggers(id, 1), stranger);
    }
  });
});

/**
 * What the story on the earlier build left, as this build's decoders read it.
 * It is asserted twice, on what the earlier build wrote and on what this build
 * serves after being deployed over it.
 */
import { expect } from "chai";
import {
  MARKET_KIND,
  MARKET_STATUS,
  ORACLE_HEALTH,
  QUOTE_STATE,
} from "../../sdk/dist/index.js";
import { PublicKey } from "@solana/web3.js";
import {
  LOT,
  SEAT_CLOSED,
  SEAT_OPEN,
  SECONDS_PER_DAY,
} from "../orderbook/world";
import {
  BOUND_PERP,
  PERP_MARKETS,
  UNBOUND_PERP,
  upgrade,
} from "./earlier-build";
import {
  PRICES,
  PYTH_SOL_FEED_ID,
  PYTH_USDC_FEED_ID,
  pythPriceAccount,
} from "./price-fixtures";
import { bookCounts, positionOf, type Snapshot } from "./snapshot";

/** The mark of a market's price feed, as the story traded at it. */
const markOf = (marketId: number) => {
  const mark = upgrade.marks.get(marketId);
  if (mark === undefined) throw new Error(`no mark for market ${marketId}`);
  return mark;
};

export const unitOf = (marketId: number) => {
  const unit = upgrade.lots.get(marketId);
  if (unit === undefined) throw new Error(`no lots for market ${marketId}`);
  return unit;
};

export function expectTheStory(snapshot: Snapshot): void {
  const { exchange, stats } = snapshot;
  expect(exchange.paused, "the exchange is paused").to.equal(true);
  expect(
    exchange.layoutState,
    "the layout is the earlier build's until it is activated",
  ).to.equal("preActivation");
  expect(exchange.perpMarkets).to.equal(
    (1 << UNBOUND_PERP) | (1 << BOUND_PERP),
  );
  expect(
    exchange.quote.account.equals(pythPriceAccount(PYTH_USDC_FEED_ID)),
    "the USDC guard is bound to Pyth's account",
  ).to.equal(true);
  expect(exchange.quote.depegBps).to.equal(100);
  expect(exchange.quote.maxAge).to.equal(SECONDS_PER_DAY);
  expect(exchange.quote.price).to.equal(PRICES.pythUsdc);
  expect(exchange.quote.state).to.equal(QUOTE_STATE.healthy);
  expect(stats.fills, "one fill, on the market bound to Pyth").to.equal(1n);

  for (const id of PERP_MARKETS) {
    const unit = unitOf(id);
    const market = snapshot.markets.get(id);
    const feed = snapshot.feeds.get(id);
    const tape = snapshot.tapes.get(id);
    if (!market || !feed || !tape) throw new Error(`market ${id} is missing`);
    const { params } = market;
    expect(params.kind, `market ${id}`).to.equal(MARKET_KIND.perp);
    expect(params.status, `market ${id} is paused`).to.equal(
      MARKET_STATUS.paused,
    );
    expect(params.oracleHealth).to.equal(ORACLE_HEALTH.healthy);
    expect(params.tick).to.equal(100n);
    expect(params.baseLot).to.equal(LOT);
    expect(params.maxPriceAge).to.equal(SECONDS_PER_DAY);
    expect(params.openInterestCap).to.equal(1_000_000n);
    expect(params.positionCap).to.equal(1_000_000n);
    expect(params.settleWindow).to.equal(900n);
    expect(params.access).to.equal(0);
    expect(feed.price, `market ${id}'s mark`).to.equal(markOf(id));

    const alice = positionOf(snapshot, upgrade.alice.owner.publicKey, id);
    const bob = positionOf(snapshot, upgrade.bob.owner.publicKey, id);
    if (id !== BOUND_PERP) {
      expect([alice.base, bob.base], `nobody holds market ${id}`).to.deep.equal(
        [0n, 0n],
      );
      expect(bookCounts(snapshot, id)).to.deep.equal({
        bids: 0,
        asks: 0,
        openInterest: 0n,
      });
      expect(stats.openInterest[id]).to.equal(0n);
      expect(tape.fills, "nothing on the tape").to.have.length(0);
      continue;
    }
    expect(alice.base, "alice is short").to.equal(-2n * unit);
    expect(alice.openAskLots, "alice's ask rests").to.equal(2n * unit);
    expect(bob.base, "bob is long").to.equal(2n * unit);
    expect(bob.openBidLots, "bob's bid rests").to.equal(unit);
    expect(bookCounts(snapshot, id)).to.deep.equal({
      bids: 1,
      asks: 1,
      openInterest: 2n * unit,
    });
    expect(stats.openInterest[id]).to.equal(2n * unit);
    expect(tape.fills, "one fill on the tape").to.have.length(1);
  }

  const bound = snapshot.feeds.get(BOUND_PERP);
  const unbound = snapshot.feeds.get(UNBOUND_PERP);
  if (!bound || !unbound) throw new Error("a price feed is missing");
  expect(
    bound.binding.account.equals(pythPriceAccount(PYTH_SOL_FEED_ID)),
    "the market is still bound to Pyth's account",
  ).to.equal(true);
  expect(bound.binding.expo).to.equal(-8);
  expect(bound.binding.baseDecimals).to.equal(9);
  expect(bound.binding.quoteDecimals).to.equal(6);
  expect(bound.source.rawPrice).to.equal(PRICES.pythSol);
  expect(unbound.binding.account.equals(PublicKey.default)).to.equal(true);

  const open = snapshot.ledger.seats.filter(
    (seat) => seat.status === SEAT_OPEN,
  );
  expect(open.length).to.be.greaterThan(2);
  const { seats } = snapshot.ledger;
  const everyPerp = PERP_MARKETS.reduce(
    (bits, id) => bits | (1n << BigInt(id)),
    0n,
  );
  const access = (seat: (typeof seats)[number]) => [
    seat.makerMarkets,
    seat.takerMarkets,
    seat.blocked,
  ];
  const { listed, blocked, closedSeat } = upgrade;
  expect(access(seats[listed.seat]), "the listed seat").to.deep.equal([
    everyPerp,
    everyPerp,
    false,
  ]);
  expect(access(seats[blocked.seat]), "the blocked seat").to.deep.equal([
    0n,
    0n,
    true,
  ]);
  const closed = seats[closedSeat.index];
  expect(closed.status, "the closed seat").to.equal(SEAT_CLOSED);
  expect(closed.version, "the closed seat's version").to.equal(
    closedSeat.version,
  );
  expect(closed.version > 1n).to.equal(true);
  expect(
    [listed.seat, blocked.seat].map((index) => seats[index].status),
    "the open seats around the closed one",
  ).to.deep.equal([SEAT_OPEN, SEAT_OPEN]);
  expect(listed.seat).to.be.lessThan(closedSeat.index);
  expect(blocked.seat).to.be.greaterThan(closedSeat.index);
  const kept = new Set([listed.seat, blocked.seat, closedSeat.index]);
  for (const [index, seat] of seats.entries()) {
    if (kept.has(index) || seat.status !== SEAT_OPEN) continue;
    expect(access(seat), `seat ${index}`).to.deep.equal([0n, 0n, false]);
  }
}

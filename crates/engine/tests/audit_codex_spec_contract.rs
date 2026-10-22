//! These assertions pin the written specification at the points where an earlier
//! reading of it and the engine disagreed. Each disagreement was settled by stating the
//! engine's behaviour in `docs/RULES.md`; the tests hold the two together.

mod common;

use common::*;
use noirwire_orderbook_engine::*;

/// RULES 7: an interval whose step does not fit the arithmetic moves neither `F` nor
/// the carry, and still clears the totals and starts the next interval.
#[test]
fn spec_a_step_that_does_not_fit_moves_nothing_and_still_ends_the_interval() {
    let mut w = World::new(8, 16);
    w.add_market(perp_params(0));
    w.set_funding_index(0, i64::MAX);
    // 5/8 of an atom per lot at the cap, plus a carry that takes it past a whole atom.
    w.markets[0].book.funding_carry = 30_000;
    w.markets[0].book.traded_premium = 50;
    w.markets[0].book.traded_size = 1;
    w.now += 3_600;
    w.set_price(0, 1_000);
    let before = w.markets[0].book;
    assert_eq!(w.fund(0), Ok(true));
    let after = w.markets[0].book;
    assert_eq!(after.funding_index, before.funding_index);
    assert_eq!(after.funding_carry, before.funding_carry);
    assert_eq!(after.traded_premium, 0);
    assert_eq!(after.traded_size, 0);
    assert_eq!(after.last_funding_time, w.now);
    assert_eq!(w.fund(0), Ok(false));
}

/// RULES 3.6 and 5: a bid that can take on a market with a taker fee holds one atom
/// per step on top of its lock; a post-only bid needs the lock alone.
#[test]
fn spec_a_taking_bid_holds_one_atom_per_step_beyond_its_lock() {
    let mut w = World::new(8, 16);
    w.add_market(spot_params(0));
    let trader = w.open();
    let lock = bid_lock(1_000, 1, 30) as u64;
    assert_eq!(lock, 1_003);
    w.deposit(trader, Asset::Spot(QUOTE), lock).unwrap();
    assert_eq!(
        w.place(0, trader, limit(Side::Bid, 1_000, 1)),
        Err(EngineError::InsufficientBalance)
    );
    w.place(0, trader, post_only(Side::Bid, 1_000, 1)).unwrap();
    assert_eq!(w.spot(trader, QUOTE).locked, lock);

    let other = w.open();
    let headroom = u64::from(w.max_steps);
    w.deposit(other, Asset::Spot(QUOTE), lock + headroom)
        .unwrap();
    w.place(0, other, limit(Side::Bid, 1_000, 1)).unwrap();
    assert_eq!(w.spot(other, QUOTE).locked, lock);
    assert_eq!(w.spot(other, QUOTE).available, headroom);
}

/// RULES 3.4: a reduce-only order that, filled in full, would leave same-side resting
/// orders standing alone raises the worst-case size, so it needs a fresh feed.
/// Cancelling those orders first lets it through on a stale one.
#[test]
fn spec_a_reduce_only_order_that_raises_the_worst_case_needs_a_fresh_feed() {
    let mut w = World::new(8, 16);
    w.add_market(perp_params(0));
    let trader = w.open();
    let counterparty = w.open();
    w.deposit(trader, Asset::Collateral, 10_000).unwrap();
    w.deposit(counterparty, Asset::Collateral, 10_000).unwrap();
    w.place(0, trader, post_only(Side::Bid, 1_000, 10)).unwrap();
    w.place(0, counterparty, ioc(Side::Ask, 1_000, 10)).unwrap();
    w.place(0, trader, post_only(Side::Ask, 1_050, 20)).unwrap();
    w.place(0, counterparty, post_only(Side::Bid, 1_000, 10))
        .unwrap();
    w.now += 61;
    assert_eq!(
        w.place(0, trader, reduce_only(ioc(Side::Ask, 1_000, 10))),
        Err(EngineError::StalePrice)
    );
    assert_eq!(w.slot(trader, 0).base, 10);

    assert_eq!(w.cancel_all(0, trader, 32), Ok(1));
    let closed = w
        .place(0, trader, reduce_only(ioc(Side::Ask, 1_000, 10)))
        .unwrap();
    assert_eq!(closed.filled, 10);
    assert_eq!(w.slot(trader, 0).base, 0);
}

/// RULES 11: the collateral's custody holds the spot balances kept in it plus, for
/// perps, collateral and every position's `quote` less its unsettled funding.
#[test]
fn spec_custody_equation_includes_collateral_deposits() {
    let mut w = World::new(8, 16);
    w.add_market(perp_params(0));
    let trader = w.open();
    w.deposit(trader, Asset::Collateral, 100).unwrap();
    let perp_total = settled_collateral_and_quote(&w);
    assert_eq!(perp_total, 100);
    assert_eq!(w.custody_collateral, perp_total);
}

fn settled_collateral_and_quote(w: &World) -> i128 {
    let index = |market: usize| {
        w.markets
            .get(market)
            .map_or(0, |state| i128::from(state.book.funding_index))
    };
    w.seats
        .iter()
        .map(|seat| {
            let positions: i128 = seat
                .perp
                .iter()
                .enumerate()
                .map(|(market, slot)| {
                    let unpaid = i128::from(slot.base)
                        * (index(market) - i128::from(slot.funding_checkpoint));
                    i128::from(slot.quote) - unpaid
                })
                .sum();
            i128::from(seat.collateral) + positions
        })
        .sum()
}

/// RULES 13.7: the sum of collateral and every position's `quote` less its unsettled
/// funding changes only by deposits, withdrawals and transfers. Stored `quote` alone
/// does not add up while one seat has settled funding and its counterparty has not.
#[test]
fn spec_settled_quote_conservation_survives_one_seat_settlement() {
    let mut w = World::new(8, 16);
    w.add_market(perp_params(0));
    let short = w.open();
    let long = w.open();
    w.deposit(short, Asset::Collateral, 1_000).unwrap();
    w.deposit(long, Asset::Collateral, 1_000).unwrap();
    w.place(0, short, post_only(Side::Ask, 1_010, 1)).unwrap();
    w.place(0, long, ioc(Side::Bid, 1_010, 1)).unwrap();
    w.set_funding_index(0, 5);
    let before = settled_collateral_and_quote(&w);
    w.withdraw(short, Asset::Collateral, 1).unwrap();
    assert_eq!(w.slot(short, 0).funding_checkpoint, 5);
    assert_eq!(w.slot(long, 0).funding_checkpoint, 0);
    assert_eq!(settled_collateral_and_quote(&w), before - 1);
}

#[test]
fn spec_liquidation_requested_above_restoring_size_restores_maintenance() {
    let mut w = World::new(8, 16);
    let mut params = perp_params(0);
    params.tick = 1;
    params.taker_fee_bps = 0;
    params.funding_cap_bps = 0;
    w.add_market(params);
    w.set_price(0, 41);
    let target = w.open();
    let counterparty = w.open();
    let liquidator = w.open();
    w.deposit(target, Asset::Collateral, 410).unwrap();
    w.deposit(counterparty, Asset::Collateral, 10_000).unwrap();
    w.deposit(liquidator, Asset::Collateral, 10_000).unwrap();
    w.place(0, target, post_only(Side::Bid, 41, 100)).unwrap();
    w.place(0, counterparty, ioc(Side::Ask, 41, 100)).unwrap();
    for price in [40, 39, 38] {
        w.now += 1;
        w.publish(0, price, w.now).unwrap();
    }
    w.liquidate(0, liquidator, target, 100).unwrap();
    let (equity, _, maintenance_scaled) = margins(&w.seats[target as usize], &w.risks());
    assert!(
        equity * 10_000 >= maintenance_scaled,
        "RULES 8.3 restoring-size postcondition"
    );
}

#[test]
fn spec_funding_one_interval_and_toward_zero_hold() {
    let mut w = World::new(8, 16);
    w.add_market(perp_params(0));
    // An average premium of -1/3 atom per lot: a negative sub-atom step rounds toward zero.
    w.markets[0].book.traded_premium = -1;
    w.markets[0].book.traded_size = 3;
    w.now += 7_200;
    w.set_price(0, 1_000);
    assert_eq!(w.fund(0), Ok(true));
    assert_eq!(w.markets[0].book.funding_index, 0);
    assert_eq!(w.markets[0].book.last_funding_time, w.now);
    assert_eq!(w.markets[0].book.traded_size, 0);
    assert_eq!(w.fund(0), Ok(false));
}

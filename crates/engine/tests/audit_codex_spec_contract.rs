mod common;

use common::*;
use noirwire_orderbook_engine::*;

// These assertions pin the written specification, including known disagreements.
// Failing tests are review evidence, not proposed production changes.

#[test]
fn spec_overflow_fails_funding_without_consuming_interval() {
    let mut w = World::new(8, 16);
    w.add_market(perp_params(0));
    w.set_funding_index(0, i64::MAX);
    w.markets[0].book.traded_notional = 1_050;
    w.markets[0].book.traded_size = 1;
    w.now += 3_600;
    w.set_price(0, 1_000);
    let before = w.markets[0].book;
    let result = w.fund(0);
    println!("SPEC-01: result={result:?}, old_time={}, new_time={}, old_volume={}, new_volume={}",
        before.last_funding_time, w.markets[0].book.last_funding_time,
        before.traded_notional, w.markets[0].book.traded_notional);
    assert_eq!(result, Err(EngineError::MathOverflow));
    assert_eq!(w.markets[0].book, before);
}

#[test]
fn spec_exact_spot_lock_suffices_on_empty_book() {
    let mut w = World::new(8, 16);
    w.add_market(spot_params(0));
    let trader = w.open();
    w.deposit(trader, Asset::Spot(QUOTE), 1_003).unwrap();
    let result = w.place(0, trader, limit(Side::Bid, 1_000, 1));
    println!("SPEC-02: available=1003, documented_lock=1003, result={result:?}");
    assert!(result.is_ok(), "RULES 3.6 and 5 require only the documented lock");
}

#[test]
fn spec_reduce_only_is_not_blocked_by_stale_feed() {
    let mut w = World::new(8, 16);
    w.add_market(perp_params(0));
    let trader = w.open();
    let counterparty = w.open();
    w.deposit(trader, Asset::Collateral, 10_000).unwrap();
    w.deposit(counterparty, Asset::Collateral, 10_000).unwrap();
    w.place(0, trader, post_only(Side::Bid, 1_000, 10)).unwrap();
    w.place(0, counterparty, ioc(Side::Ask, 1_000, 10)).unwrap();
    w.place(0, trader, post_only(Side::Ask, 1_050, 20)).unwrap();
    w.now += 61;
    let result = w.place(0, trader, reduce_only(ioc(Side::Ask, 1_000, 10)));
    println!("SPEC-04: long=10, resting_asks=20, reduce_only=10, result={result:?}");
    assert!(result.is_ok(), "RULES 9 says stale feeds never block shrinking orders");
}

#[test]
fn spec_custody_equation_includes_collateral_deposits() {
    let mut w = World::new(8, 16);
    w.add_market(perp_params(0));
    let trader = w.open();
    w.deposit(trader, Asset::Collateral, 100).unwrap();
    let documented_sum: i128 = w.seats.iter().map(|seat| {
        i128::from(seat.spot[QUOTE as usize].available)
            + i128::from(seat.spot[QUOTE as usize].locked)
    }).sum();
    println!("SPEC-06a: custody={}, sum_available_locked={documented_sum}", w.custody_collateral);
    assert_eq!(w.custody_collateral, documented_sum, "Literal RULES 11 equation");
}

fn raw_collateral_and_quote(w: &World) -> i128 {
    w.seats.iter().map(|seat| {
        i128::from(seat.collateral)
            + seat.perp.iter().map(|slot| i128::from(slot.quote)).sum::<i128>()
    }).sum()
}

#[test]
fn spec_raw_quote_conservation_survives_one_seat_settlement() {
    let mut w = World::new(8, 16);
    w.add_market(perp_params(0));
    let short = w.open();
    let long = w.open();
    w.deposit(short, Asset::Collateral, 1_000).unwrap();
    w.deposit(long, Asset::Collateral, 1_000).unwrap();
    w.place(0, short, post_only(Side::Ask, 1_010, 1)).unwrap();
    w.place(0, long, ioc(Side::Bid, 1_010, 1)).unwrap();
    w.now += 3_600;
    w.publish(0, 1_000, w.now).unwrap();
    assert_eq!(w.fund(0), Ok(true));
    assert_eq!(w.markets[0].book.funding_index, 5);
    let before = raw_collateral_and_quote(&w);
    w.withdraw(short, Asset::Collateral, 1).unwrap();
    let after = raw_collateral_and_quote(&w);
    println!("SPEC-06b: before={before}, after={after}, withdrawal=1, unsettled_long_payment=5");
    assert_eq!(after, before - 1, "Literal RULES 13.7 stored-quote conservation");
}

#[test]
fn spec_liquidation_requested_above_restoring_size_restores_maintenance() {
    let mut w = World::new(8, 16);
    let mut params = perp_params(0);
    params.tick = 1;
    params.taker_fee_bps = 0;
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
    let outcome = w.liquidate(0, liquidator, target, 100).unwrap();
    let (equity, _, maintenance_scaled) = margins(&w.seats[target as usize], &w.risks());
    println!("CODEX-02 spec: size={}, equity={equity}, maintenance_scaled={maintenance_scaled}",
        outcome.liquidated);
    assert!(equity * 10_000 >= maintenance_scaled, "RULES 8.3 restoring-size postcondition");
}

#[test]
fn spec_funding_one_interval_and_toward_zero_hold() {
    let mut w = World::new(8, 16);
    w.add_market(perp_params(0));
    // Average fill price 1000 - 1/3: a negative sub-atom step rounds toward zero.
    w.markets[0].book.traded_notional = 2_999;
    w.markets[0].book.traded_size = 3;
    w.now += 7_200;
    w.set_price(0, 1_000);
    assert_eq!(w.fund(0), Ok(true));
    assert_eq!(w.markets[0].book.funding_index, 0);
    assert_eq!(w.markets[0].book.last_funding_time, w.now);
    assert_eq!(w.markets[0].book.traded_size, 0);
    assert_eq!(w.fund(0), Ok(false));
}

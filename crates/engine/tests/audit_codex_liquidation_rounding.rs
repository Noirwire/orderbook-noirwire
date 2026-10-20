mod common;

use common::*;
use noirwire_orderbook_engine::*;

#[test]
fn purported_restoring_liquidation_leaves_target_below_maintenance() {
    let mut w = World::new(8, 16);
    let mut params = perp_params(0);
    params.tick = 1;
    params.taker_fee_bps = 0;
    params.check().unwrap();
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
    assert_eq!(w.equity(target), 110);
    assert_eq!(w.maintenance_margin(target), 190);
    let outcome = w.liquidate(0, liquidator, target, 100).unwrap();
    assert_eq!(outcome.status, LiquidationStatus::Liquidated);
    assert_eq!(outcome.price, 37);
    assert_eq!(outcome.liquidated, 53);
    assert_eq!(w.slot(target, 0).base, 47);
    assert_eq!(w.equity(target), 57);
    assert_eq!(w.maintenance_margin(target), 90);
    assert!(w.is_liquidatable(target, 0));

    // Actual per-lot penalty is ceil(38 * 100 / 10_000) = 1.
    // The least restoring size solves 110 - n >= (100 - n) * 38 * 500 / 10_000.
    let restoring_size = (1_i128..=100)
        .find(|n| (110 - n) * 10_000 >= (100 - n) * 38 * 500)
        .unwrap();
    assert_eq!(restoring_size, 89);
    println!(
        "CODEX-02: requested=100, actual=53, required=89; remaining equity=57 < maintenance=89.3"
    );
}

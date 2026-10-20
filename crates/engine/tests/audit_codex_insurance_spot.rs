mod common;

use common::*;
use noirwire_orderbook_engine::*;

#[test]
fn spot_insurance_cannot_cover_a_smaller_collateral_shortfall() {
    let mut w = World::new(12, 16);
    let mut spot = spot_params(0);
    spot.fee_insurance_share_bps = 10_000;
    w.add_market(spot);
    let mut perp = perp_params(1);
    perp.taker_fee_bps = 0;
    w.add_market(perp);
    let buyer = w.open();
    let seller = w.open();
    let target = w.open();
    let counterparty = w.open();
    let liquidator = w.open();
    w.deposit(buyer, Asset::Spot(QUOTE), 101_000).unwrap();
    w.deposit(seller, Asset::Spot(BASE), 10_000).unwrap();
    w.place(0, seller, post_only(Side::Ask, 1_000, 100)).unwrap();
    w.place(0, buyer, ioc(Side::Bid, 1_000, 100)).unwrap();
    assert_eq!(w.spot(INSURANCE_SEAT, QUOTE).available, 300);
    assert_eq!(w.collateral(INSURANCE_SEAT), 0);

    w.deposit(target, Asset::Collateral, 100).unwrap();
    w.deposit(counterparty, Asset::Collateral, 10_000).unwrap();
    w.deposit(liquidator, Asset::Collateral, 10_000).unwrap();
    w.place(1, target, post_only(Side::Bid, 1_000, 1)).unwrap();
    w.place(1, counterparty, ioc(Side::Ask, 1_000, 1)).unwrap();
    for price in [970, 941, 913, 886, 860, 835, 810, 800] {
        w.now += 1;
        w.publish(1, price, w.now).unwrap();
    }
    let outcome = w.liquidate(1, liquidator, target, 1).unwrap();
    assert_eq!(outcome.status, LiquidationStatus::Liquidated);
    assert_eq!(outcome.insurance_paid, 0);
    assert_eq!(outcome.uncovered, 108);
    assert_eq!(w.cover_shortfall(1, target).unwrap(), 0);
    assert_eq!(w.spot(INSURANCE_SEAT, QUOTE).available, 300);
    assert_eq!(
        w.withdraw(liquidator, Asset::Collateral, 1),
        Err(EngineError::ShortfallOutstanding)
    );
    assert_eq!(
        w.withdraw(INSURANCE_SEAT, Asset::Spot(QUOTE), 108),
        Err(EngineError::ReservedSeat)
    );
    println!(
        "CODEX-01: insurance spot=300, collateral=0, debt=108, paid=0; collateral withdrawal blocked"
    );
}

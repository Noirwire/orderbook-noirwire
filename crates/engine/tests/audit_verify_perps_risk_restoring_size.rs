//! Audit verification, perps risk: the restoring size counts the penalty rounded up as
//! it is charged, so one liquidation restores the target with or without a buffer.

mod common;

use common::*;
use noirwire_orderbook_engine::*;

fn funded(w: &mut World, collateral: u64) -> u32 {
    let seat = w.open();
    w.deposit(seat, Asset::Collateral, collateral).unwrap();
    seat
}

fn buy_from(w: &mut World, m: usize, buyer: u32, seller: u32, price: u64, size: u64) {
    w.place(m, seller, limit(Side::Ask, price, size)).unwrap();
    let outcome = w.place(m, buyer, ioc(Side::Bid, price, size)).unwrap();
    assert_eq!(outcome.filled, size);
}

fn scenario(buffer_bps: u16) -> (World, usize, u32, u32) {
    let mut params = perp_params(0);
    params.liq_buffer_bps = buffer_bps;
    assert!(params.check().is_ok());
    let mut w = World::new(10, 8);
    let m = w.add_market(params);
    let maker = funded(&mut w, 1_000_000);
    let liquidator = funded(&mut w, 1_000_000);
    let target = funded(&mut w, 14_000);
    buy_from(&mut w, m, target, maker, 1_000, 100);
    w.set_price(m, 905);
    (w, m, liquidator, target)
}

#[test]
fn audit_verify_zero_buffer_restores_the_target_in_one_liquidation() {
    let (mut w, m, liquidator, target) = scenario(0);
    let first = w.liquidate(m, liquidator, target, 100).unwrap();
    assert_eq!(first.status, LiquidationStatus::Liquidated);
    assert_eq!(
        first.liquidated, 10,
        "ceil(3,250,000 / (905 * 500 - 10 * 10,000))"
    );
    assert_eq!(first.price, 895);
    assert!(!w.is_liquidatable(target, m));

    let second = w.liquidate(m, liquidator, target, 100).unwrap();
    assert_eq!(second.status, LiquidationStatus::NotLiquidatable);
    assert_eq!(w.slot(target, m).base, 90);
}

#[test]
fn audit_verify_a_100_bps_buffer_absorbs_the_rounding_here() {
    let (mut w, m, liquidator, target) = scenario(100);
    let first = w.liquidate(m, liquidator, target, 100).unwrap();
    assert_eq!(first.status, LiquidationStatus::Liquidated);
    assert!(!w.is_liquidatable(target, m));
}

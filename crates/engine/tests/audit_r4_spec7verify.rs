//! Checks the RULES 8.3a fallback: an insurance seat that cannot take its share of the
//! penalty leaves the whole penalty to the liquidator.

mod common;

use common::*;
use noirwire_orderbook_engine::*;

fn liquidatable_long(insurance: u64) -> (World, usize, u32, u32) {
    let mut params = free_perp();
    params.liq_insurance_share_bps = 5_000;
    let (mut w, m) = perp_world(params);
    let long = funded(&mut w, 1_000);
    let short = funded(&mut w, 1_000_000);
    let keeper = funded(&mut w, 1_000_000);
    buy_from(&mut w, m, long, short, MARK, 10);
    w.deposit(INSURANCE_SEAT, Asset::Collateral, insurance)
        .unwrap();
    w.set_price(m, 940);
    assert!(w.is_liquidatable(long, m));
    (w, m, long, keeper)
}

#[test]
fn fallback_with_harness_checks_off() {
    let (mut w, m, long, keeper) = liquidatable_long(BALANCE_CAP);
    let keeper_before = w.equity(keeper);
    w.sane_numbers = false;
    let outcome = w.liquidate(m, keeper, long, 10).unwrap();
    assert_eq!(outcome.status, LiquidationStatus::Liquidated);
    let penalty = i128::from(940 - outcome.price) * i128::from(outcome.liquidated);
    assert!(penalty > 0);
    assert_eq!(outcome.penalty_to_insurance, 0);
    assert_eq!(w.equity(keeper) - keeper_before, penalty);
    assert_eq!(w.collateral(INSURANCE_SEAT), BALANCE_CAP as i64);
    println!("penalty {penalty} liquidated {}", outcome.liquidated);
}

#[test]
fn fallback_with_harness_checks_on_agrees_with_the_harness() {
    let (mut w, m, long, keeper) = liquidatable_long(BALANCE_CAP);
    assert!(w.sane_numbers);
    let outcome = w.liquidate(m, keeper, long, 10).unwrap();
    assert_eq!(outcome.status, LiquidationStatus::Liquidated);
    assert_eq!(outcome.penalty_to_insurance, 0);
}

#[test]
fn control_below_the_cap_pays_the_formula_share() {
    let (mut w, m, long, keeper) = liquidatable_long(1_000);
    let outcome = w.liquidate(m, keeper, long, 10).unwrap();
    let penalty = (940 - outcome.price) * outcome.liquidated;
    assert_eq!(outcome.penalty_to_insurance, penalty / 2);
    assert!(outcome.penalty_to_insurance > 0);
}

//! The deployed market settings against the price bound of RULES 12. A position at the
//! deployed open interest cap stays liquidatable at every price a feed accepts, and a
//! winner can withdraw until a shortfall is recorded, which is the designed freeze.

mod common;

use common::*;
use noirwire_orderbook_engine::EngineError as E;
use noirwire_orderbook_engine::*;

const DEPLOYED_CAP: u64 = 10_000_000;

fn funded(w: &mut World, collateral: u64) -> u32 {
    let seat = w.open();
    w.deposit(seat, Asset::Collateral, collateral).unwrap();
    seat
}

fn deployed_perp() -> MarketParams {
    let mut params = perp_params(0);
    params.tick = 100;
    params.base_lot = 1_000_000;
    params.min_size = 1;
    params.min_notional = 1_000_000;
    params.band_bps = 400;
    params.im_bps = 1_000;
    params.mm_bps = 500;
    params.taker_fee_bps = 5;
    params.liq_penalty_bps = 200;
    params.funding_cap_bps = 50;
    params.max_move_bps = 250;
    params.max_open_orders = 32;
    params.max_price_age = 10;
    params.funding_interval = 60;
    params.min_publish_gap = 1;
    params.max_age_liquidation = 60;
    params.open_interest_cap = DEPLOYED_CAP;
    params.liq_buffer_bps = 100;
    params.liq_insurance_share_bps = 5_000;
    params.fee_insurance_share_bps = 5_000;
    params.check().unwrap();
    params
}

/// A short at the deployed cap, opened at the deployed initial mark, with the mark
/// then reset to `mark`. Returns the world, the market, the loser, the winner and a
/// liquidator.
fn short_at_the_cap_then_reset(mark: u64) -> (World, usize, u32, u32, u32) {
    let mut w = World::new(16, 8);
    let m = w.add_market(deployed_perp());
    w.set_price(m, 150_000);
    let loser = funded(&mut w, 1_000_000_000_000);
    let winner = funded(&mut w, 1_000_000_000_000);
    let liquidator = funded(&mut w, 4_000_000_000_000_000_000);
    w.place(m, winner, limit(Side::Bid, 150_000, DEPLOYED_CAP))
        .unwrap();
    let opened = w
        .place(m, loser, ioc(Side::Ask, 150_000, DEPLOYED_CAP))
        .unwrap();
    assert_eq!(opened.filled, DEPLOYED_CAP);
    w.now += 5;
    let at = w.now;
    w.reset(m, mark, at).unwrap();
    (w, m, loser, winner, liquidator)
}

#[test]
fn deployed_max_move_is_far_below_ten_thousand() {
    let mut params = perp_params(0);
    params.im_bps = 10_000;
    params.mm_bps = 9_999;
    params.liq_penalty_bps = 1;
    params.taker_fee_bps = 1;
    params.band_bps = 1;
    params.funding_cap_bps = 0;
    params.max_move_bps = 10_000;
    assert_eq!(params.check(), Err(E::InvalidMarketParams));
    params.max_move_bps = 9_997;
    params.check().unwrap();
}

#[test]
fn the_deployed_marks_and_cap_sit_far_inside_the_bounds() {
    assert!(deployed_perp().open_interest_cap <= MAX_OPEN_INTEREST_CAP);
    for initial_mark in [150_000u64, 1_800_000] {
        assert!(initial_mark.saturating_mul(10_000) <= MAX_PRICE);
    }
}

#[test]
fn a_position_at_the_deployed_cap_stays_liquidatable_at_the_highest_price() {
    let (mut w, m, loser, winner, liquidator) = short_at_the_cap_then_reset(MAX_PRICE);
    assert!(w.equity(loser) < 0);
    assert!(w.maintenance_margin(loser) > 0);

    let one_lot = w.liquidate(m, liquidator, loser, 1).unwrap();
    assert_eq!(one_lot.status, LiquidationStatus::Liquidated);
    assert_eq!(one_lot.liquidated, 1);
    w.withdraw(winner, Asset::Collateral, 1).unwrap();

    let rest = w.liquidate(m, liquidator, loser, DEPLOYED_CAP).unwrap();
    assert_eq!(rest.status, LiquidationStatus::Liquidated);
    assert_eq!(rest.liquidated, DEPLOYED_CAP - 1);
    assert!(rest.uncovered > 0);
    assert_eq!(
        w.withdraw(winner, Asset::Collateral, 1),
        Err(E::ShortfallOutstanding)
    );
}

#[test]
fn every_accepted_mark_leaves_a_position_at_the_deployed_cap_liquidatable() {
    for mark in [
        1_000_000u64,
        1_000_000_000,
        10_000_000_000,
        MAX_PRICE / 2,
        MAX_PRICE,
    ] {
        let (mut w, m, loser, _, liquidator) = short_at_the_cap_then_reset(mark);
        let outcome = w.liquidate(m, liquidator, loser, DEPLOYED_CAP).unwrap();
        assert_eq!(outcome.status, LiquidationStatus::Liquidated, "mark {mark}");
        assert_eq!(outcome.liquidated, DEPLOYED_CAP, "mark {mark}");
        assert!(w.collateral(loser).unsigned_abs() <= BALANCE_CAP);
    }
    let (mut w, m, ..) = short_at_the_cap_then_reset(MAX_PRICE);
    let at = w.now;
    assert_eq!(w.reset(m, MAX_PRICE + 1, at), Err(E::PriceTooHigh));
}

#[test]
fn the_largest_deployed_resting_order_is_refused_withdrawal_by_margin_not_overflow() {
    let mut w = World::new(16, 8);
    let m = w.add_market(deployed_perp());
    w.set_price(m, 100);
    let whale = funded(&mut w, 10_000_000_000_000_000);
    let other = funded(&mut w, 1_000_000_000_000);
    assert_eq!(
        w.place(m, whale, limit(Side::Bid, 100, MAX_OPEN_INTEREST_CAP + 1)),
        Err(E::PositionCapExceeded),
        "the position cap bounds what may rest"
    );
    let order = w
        .place(m, whale, limit(Side::Bid, 100, MAX_OPEN_INTEREST_CAP))
        .unwrap();

    w.now += 5;
    let at = w.now;
    w.reset(m, MAX_PRICE, at).unwrap();
    assert_eq!(
        w.withdraw(whale, Asset::Collateral, 1),
        Err(E::InsufficientMargin)
    );
    assert_eq!(w.withdraw(other, Asset::Collateral, 1), Ok(()));

    w.cancel(m, whale, seq(&order)).unwrap();
    assert_eq!(w.withdraw(whale, Asset::Collateral, 1), Ok(()));
}

mod common;

use common::*;
use noirwire_orderbook_engine::EngineError as E;
use noirwire_orderbook_engine::*;

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
    params.open_interest_cap = 10_000_000;
    params.liq_buffer_bps = 100;
    params.liq_insurance_share_bps = 5_000;
    params.fee_insurance_share_bps = 5_000;
    params.check().unwrap();
    params
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
fn deployed_settings_position_at_oi_cap_survives_mark_at_u64_max() {
    let mut w = World::new(16, 8);
    let m = w.add_market(deployed_perp());
    w.set_price(m, 150_000);
    let loser = funded(&mut w, 1_000_000_000_000);
    let winner = funded(&mut w, 1_000_000_000_000);
    let liquidator = funded(&mut w, 4_000_000_000_000_000_000);

    w.place(m, winner, limit(Side::Bid, 150_000, 10_000_000)).unwrap();
    let opened = w.place(m, loser, ioc(Side::Ask, 150_000, 10_000_000)).unwrap();
    assert_eq!(opened.filled, 10_000_000);

    w.set_price(m, u64::MAX);
    assert!(w.equity(loser) < 0);

    let attempt = w.liquidate(m, liquidator, loser, 1).unwrap();
    assert_ne!(attempt.status, LiquidationStatus::NotLiquidatable);
    println!("liquidation at u64::MAX mark: {:?}", attempt.status);

    assert_ne!(w.withdraw(winner, Asset::Collateral, 1), Err(E::MathOverflow));
}

#[test]
fn deployed_settings_resting_order_overflow_only_locks_its_own_seat() {
    let mut w = World::new(16, 8);
    let m = w.add_market(deployed_perp());
    w.set_price(m, 100);
    let whale = funded(&mut w, 4_600_000_000_000_000_000);
    let other = funded(&mut w, 1_000_000_000_000);
    let order = w.place(m, whale, limit(Side::Bid, 100, 400_000_000_000_000_000)).unwrap();

    w.set_price(m, u64::MAX);
    assert_eq!(w.withdraw(whale, Asset::Collateral, 1), Err(E::MathOverflow));
    assert_eq!(w.withdraw(other, Asset::Collateral, 1), Ok(()));

    w.cancel(m, whale, seq(&order)).unwrap();
    assert_eq!(w.withdraw(whale, Asset::Collateral, 1), Ok(()));
}

fn probe(mark: u64, request: u64) -> (LiquidationStatus, bool, bool) {
    let mut w = World::new(16, 8);
    let m = w.add_market(deployed_perp());
    w.set_price(m, 150_000);
    let loser = funded(&mut w, 1_000_000_000_000);
    let winner = funded(&mut w, 1_000_000_000_000);
    let liquidator = funded(&mut w, 4_000_000_000_000_000_000);
    w.place(m, winner, limit(Side::Bid, 150_000, 10_000_000)).unwrap();
    w.place(m, loser, ioc(Side::Ask, 150_000, 10_000_000)).unwrap();
    w.set_price(m, mark);
    let status = w.liquidate(m, liquidator, loser, request).unwrap().status;
    let winner_ok = w.withdraw(winner, Asset::Collateral, 1).is_ok();
    let below = w.equity(loser) < 0;
    (status, winner_ok, below)
}

#[test]
fn deployed_settings_threshold_probe() {
    for exp in [6u32, 9, 11, 12, 13, 14, 15, 16, 17, 18] {
        let mark = 10u64.pow(exp);
        println!("mark 1e{exp}: one lot {:?} | full {:?}", probe(mark, 1), probe(mark, 10_000_000));
    }
    for mark in [4_000_000_000_000_000_000u64, 9_000_000_000_000_000_000, u64::MAX] {
        println!("mark {mark}: one lot {:?} | full {:?}", probe(mark, 1), probe(mark, 10_000_000));
    }
}

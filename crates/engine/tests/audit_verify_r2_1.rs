mod common;

use common::*;
use noirwire_orderbook_engine::EngineError as E;
use noirwire_orderbook_engine::*;

fn funded(w: &mut World, collateral: u64) -> u32 {
    let seat = w.open();
    w.deposit(seat, Asset::Collateral, collateral).unwrap();
    seat
}

fn deployed_params() -> MarketParams {
    let mut params = perp_params(0);
    params.tick = 1;
    params.band_bps = 400;
    params.im_bps = 1_000;
    params.mm_bps = 500;
    params.taker_fee_bps = 5;
    params.liq_penalty_bps = 200;
    params.funding_cap_bps = 50;
    params.max_move_bps = 250;
    params.open_interest_cap = 10_000_000;
    params.check().unwrap();
    params
}

fn extreme_params() -> MarketParams {
    let mut params = perp_params(0);
    params.tick = 1;
    params.im_bps = 10_000;
    params.mm_bps = 9_999;
    params.liq_penalty_bps = 1;
    params.taker_fee_bps = 1;
    params.band_bps = 1;
    params.funding_cap_bps = 1;
    params.max_move_bps = 9_000;
    params.open_interest_cap = 1 << 62;
    params
}

#[test]
fn v1_max_move_10000_is_refused_by_check() {
    let mut params = extreme_params();
    params.max_move_bps = 10_000;
    assert_eq!(params.check(), Err(E::InvalidMarketParams));
    params.max_move_bps = 9_998;
    assert_eq!(params.check(), Err(E::InvalidMarketParams));
    params.max_move_bps = 9_997;
    assert!(params.check().is_ok());
}

#[test]
fn v2_deployed_settings_cannot_overflow_even_at_u64_max_mark() {
    let mut w = World::new(16, 8);
    let m = w.add_market(deployed_params());
    let short = funded(&mut w, 2_000_000_000_000);
    let long = funded(&mut w, 2_000_000_000_000);
    let liquidator = funded(&mut w, 4_000_000_000_000_000_000);

    w.place(m, long, limit(Side::Bid, 1000, 10_000_000)).unwrap();
    let opened = w.place(m, short, ioc(Side::Ask, 1000, 10_000_000)).unwrap();
    assert_eq!(opened.filled, 10_000_000);

    w.now += 5;
    w.reset(m, u64::MAX, w.now).unwrap();
    assert!(w.equity(short) < 0);

    assert!(w.maintenance_margin(short) > 0);
    let attempt = w.liquidate(m, liquidator, short, 1).unwrap();
    println!("deployed, mark u64::MAX: liquidation status {:?}", attempt.status);
    assert_eq!(attempt.status, LiquidationStatus::NotLiquidatable);

    let withdrawn = w.withdraw(long, Asset::Collateral, 1);
    println!("deployed, mark u64::MAX: winner withdraw {:?}", withdrawn);
    assert_ne!(withdrawn, Err(E::MathOverflow));
}

#[test]
fn v3_publishes_needed_under_extreme_settings() {
    let params = extreme_params();
    params.check().unwrap();
    let mut w = World::new(16, 8);
    let m = w.add_market(params);
    w.set_price(m, 1000);
    let mut steps = 0u32;
    while w.markets[m].price.price < 4_300_000_000_000_000_000 {
        let current = w.markets[m].price.price;
        let next = (u128::from(current) * 19_000 / 10_000) as u64;
        w.now += 1;
        let at = w.now;
        w.publish(m, next, at).unwrap();
        steps += 1;
    }
    println!("extreme settings: {steps} publishes (1 s gap) from 1000 to overflow");
    assert_eq!(steps, 57);
}

#[test]
fn v4_admin_reset_reaches_the_freeze_in_one_call_under_extreme_settings() {
    let params = extreme_params();
    params.check().unwrap();
    let mut w = World::new(16, 8);
    let m = w.add_market(params);
    let rich = 4_600_000_000_000_000_000u64;
    let loser = funded(&mut w, rich);
    let winner = funded(&mut w, rich);
    let liquidator = funded(&mut w, rich);
    w.place(m, winner, limit(Side::Bid, 1000, 4_000_000_000_000_000)).unwrap();
    w.place(m, loser, ioc(Side::Ask, 1000, 4_000_000_000_000_000)).unwrap();

    w.now += 5;
    w.reset(m, 5_000_000_000_000_000_000, w.now).unwrap();
    let attempt = w.liquidate(m, liquidator, loser, 1_000).unwrap();
    assert_eq!(attempt.status, LiquidationStatus::NotLiquidatable);
    assert_eq!(w.withdraw(winner, Asset::Collateral, 1), Err(E::MathOverflow));
}

#[test]
fn v5_deployed_settings_probe_marks() {
    for mark in [1_000_000_000u64, 1_000_000_000_000, 1_000_000_000_000_000, 5_000_000_000_000_000_000, 18_000_000_000_000_000_000, u64::MAX] {
        for size in [1u64] {
            let mut w = World::new(16, 8);
            let m = w.add_market(deployed_params());
            let short = funded(&mut w, 2_000_000_000_000);
            let long = funded(&mut w, 2_000_000_000_000);
            let liquidator = funded(&mut w, 4_000_000_000_000_000_000);
            w.place(m, long, limit(Side::Bid, 1000, 10_000_000)).unwrap();
            w.place(m, short, ioc(Side::Ask, 1000, 10_000_000)).unwrap();
            w.now += 5;
            w.reset(m, mark, w.now).unwrap();
            let mm = w.maintenance_margin(short);
            let eq = w.equity(short);
            let attempt = w.liquidate(m, liquidator, short, size).map(|o| (o.status, o.liquidated));
            let wd = w.withdraw(long, Asset::Collateral, 1);
            println!("mark {mark:>20} req {size:>9}: mm {mm} eq {eq} liq {attempt:?} winner_withdraw {wd:?}");
        }
    }
}

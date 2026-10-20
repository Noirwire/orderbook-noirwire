//! Audit verification: funding premium measured against the mark at update time.
//! Checks how large the effect is for small, ordinary moves, and that it needs a fill.

mod common;

use bytemuck::Zeroable;
use common::*;
use noirwire_orderbook_engine::*;

fn deployed_perp(market_id: u8) -> MarketParams {
    MarketParams {
        tick: 100,
        base_lot: 1_000_000,
        min_size: 1,
        min_notional: 1_000_000,
        funding_interval: 60,
        max_price_age: 10,
        max_age_liquidation: 60,
        open_interest_cap: 10_000_000,
        band_bps: 400,
        im_bps: 1_000,
        mm_bps: 500,
        taker_fee_bps: 5,
        liq_penalty_bps: 200,
        funding_cap_bps: 100,
        max_move_bps: 250,
        min_publish_gap: 1,
        max_open_orders: 32,
        liq_buffer_bps: 100,
        liq_insurance_share_bps: 5_000,
        fee_insurance_share_bps: 5_000,
        kind: KIND_PERP,
        market_id,
        ..MarketParams::zeroed()
    }
}

const SOL: u64 = 150_000;

fn funded(w: &mut World, collateral: u64) -> u32 {
    let seat = w.open();
    w.deposit(seat, Asset::Collateral, collateral).unwrap();
    seat
}

#[test]
fn audit_verify_small_drift_is_charged_one_for_one_per_interval() {
    let mut w = World::new(16, 64);
    let m = w.add_market(deployed_perp(0));
    w.set_price(m, SOL);
    let long = funded(&mut w, 30_000_000);
    let short = funded(&mut w, 30_000_000);
    w.place(m, short, limit(Side::Ask, SOL, 1_000)).unwrap();
    assert_eq!(
        w.place(m, long, ioc(Side::Bid, SOL, 1_000)).unwrap().filled,
        1_000
    );

    w.now += 60;
    let drift = SOL + SOL * 30 / 10_000;
    assert_eq!(w.publish(m, drift, w.now), Ok(()));
    assert_eq!(w.fund(m), Ok(true));
    let index = w.markets[m].book.funding_index;
    println!(
        "0.30% drift after the only fill moved F by {index} per lot (mark step {})",
        drift - SOL
    );
    assert_eq!(index, -i64::try_from(drift - SOL).unwrap());
}

#[test]
fn audit_verify_no_fill_in_the_interval_means_no_funding() {
    let mut w = World::new(16, 64);
    let m = w.add_market(deployed_perp(0));
    w.set_price(m, SOL);
    let long = funded(&mut w, 30_000_000);
    let short = funded(&mut w, 30_000_000);
    w.place(m, short, limit(Side::Ask, SOL, 1_000)).unwrap();
    w.place(m, long, ioc(Side::Bid, SOL, 1_000)).unwrap();
    w.now += 60;
    w.set_price(m, SOL);
    assert_eq!(w.fund(m), Ok(true));
    w.now += 60;
    let step = SOL + SOL * 250 / 10_000;
    assert_eq!(w.publish(m, step, w.now), Ok(()));
    assert_eq!(w.fund(m), Ok(true));
    println!(
        "no fill in the interval: F = {}",
        w.markets[m].book.funding_index
    );
    assert_eq!(w.markets[m].book.funding_index, 0);
}

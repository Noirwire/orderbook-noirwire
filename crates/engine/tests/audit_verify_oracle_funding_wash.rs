//! Independent check of the funding wash: with the minimum notional and tick of the
//! perp market in `ops/deployment.ts`, and with honest volume at the mark in the same
//! interval, a band-edge wash between two seats still sets funding to the cap.

mod common;

use common::*;
use noirwire_orderbook_engine::*;

const MARK: u64 = 150_000;

fn params() -> MarketParams {
    let mut p = perp_params(0);
    p.tick = 100;
    p.min_notional = 1_000_000;
    p.band_bps = 400;
    p.im_bps = 1_000;
    p.mm_bps = 500;
    p.taker_fee_bps = 5;
    p.liq_penalty_bps = 200;
    p.funding_cap_bps = 100;
    p.max_move_bps = 250;
    p.max_price_age = 10;
    p.funding_interval = 60;
    p.max_age_liquidation = 60;
    p.open_interest_cap = 10_000_000;
    p.liq_buffer_bps = 100;
    p.liq_insurance_share_bps = 5_000;
    p.fee_insurance_share_bps = 5_000;
    p.max_open_orders = 32;
    assert!(p.check().is_ok());
    p
}

fn funded(w: &mut World, collateral: u64) -> u32 {
    let seat = w.open();
    w.deposit(seat, Asset::Collateral, collateral).unwrap();
    seat
}

fn run(wash_lots: u64, honest_lots: u64) -> (i64, u64) {
    let mut w = World::new(12, 16);
    let m = w.add_market(params());
    w.set_price(m, MARK);
    let victim = funded(&mut w, 1_600_000);
    let attacker = funded(&mut w, 100_000_000);
    let honest_a = funded(&mut w, 100_000_000);
    let honest_b = funded(&mut w, 100_000_000);
    let wash_a = funded(&mut w, 10_000_000);
    let wash_b = funded(&mut w, 10_000_000);
    w.place(m, attacker, limit(Side::Ask, MARK, 100)).unwrap();
    assert_eq!(
        w.place(m, victim, ioc(Side::Bid, MARK, 100))
            .unwrap()
            .filled,
        100
    );
    w.now += 60;
    w.publish(m, MARK, w.now).unwrap();
    assert_eq!(w.fund(m), Ok(true));
    let f0 = w.markets[m].book.funding_index;

    w.now += 60;
    w.publish(m, MARK, w.now).unwrap();
    if honest_lots > 0 {
        w.place(m, honest_a, limit(Side::Ask, MARK, honest_lots))
            .unwrap();
        assert_eq!(
            w.place(m, honest_b, ioc(Side::Bid, MARK, honest_lots))
                .unwrap()
                .filled,
            honest_lots
        );
    }
    let edge = MARK + MARK * 400 / 10_000;
    w.place(m, wash_a, limit(Side::Ask, edge, wash_lots))
        .unwrap();
    let out = w.place(m, wash_b, ioc(Side::Bid, edge, wash_lots)).unwrap();
    assert_eq!(out.filled, wash_lots);
    assert_eq!(w.fund(m), Ok(true));
    (w.markets[m].book.funding_index - f0, out.fee_paid)
}

#[test]
fn verify_seven_lot_wash_alone_hits_the_cap_for_546_in_fees() {
    let (step, fee) = run(7, 0);
    assert_eq!(step, 1_500);
    assert_eq!(fee, 546);
}

#[test]
fn verify_wash_still_hits_the_cap_against_honest_volume_equal_to_open_interest() {
    let (step, fee) = run(34, 100);
    assert_eq!(step, 1_500);
    println!(
        "34-lot wash vs 100 honest lots: step {step}, fee {fee}, victim pays {}",
        step * 100
    );
}

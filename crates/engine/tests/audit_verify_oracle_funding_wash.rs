//! Independent check of the funding wash: with the minimum notional and tick of the
//! perp market in `ops/deployment.ts`, alone and with honest volume at the mark in the
//! same interval, a band-edge wash between two seats moves less funding than it pays.

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

/// Returns the funding step in 1/65536 of an atom per lot, the wash's fee and the open
/// interest at the update.
fn run(wash_lots: u64, honest_lots: u64) -> (i128, u64, u64) {
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
    let f0 = w.funding_units(m);

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
    let mut fee = 0;
    if wash_lots > 0 {
        let edge = MARK + MARK * 400 / 10_000;
        w.place(m, wash_a, limit(Side::Ask, edge, wash_lots))
            .unwrap();
        let out = w.place(m, wash_b, ioc(Side::Bid, edge, wash_lots)).unwrap();
        assert_eq!(out.filled, wash_lots);
        fee = out.fee_paid;
    }
    let open_interest = w.markets[m].book.open_interest;
    assert_eq!(w.fund(m), Ok(true));
    (w.funding_units(m) - f0, fee, open_interest)
}

#[test]
fn verify_seven_lot_wash_alone_moves_at_most_a_quarter_of_its_546_in_fees() {
    let (step, fee, open_interest) = run(7, 0);
    assert_eq!(fee, 546);
    assert_eq!(open_interest, 107);
    assert_eq!(
        step, 83_604,
        "7 * 1560 * 60 * 5 / (107 * 4 * 100 * 60), about 1.3 atoms"
    );
    assert!(step * i128::from(open_interest) * 4 <= i128::from(fee) * FUNDING_CARRY_SCALE);
}

#[test]
fn verify_wash_against_honest_volume_equal_to_open_interest_moves_at_most_half_its_fee() {
    let (step, fee, open_interest) = run(34, 100);
    let (honest_step, _, _) = run(0, 100);
    assert_eq!(honest_step, 0);
    assert!(
        (step - honest_step) * i128::from(open_interest) * 2
            <= i128::from(fee) * FUNDING_CARRY_SCALE
    );
    println!("34-lot wash vs 100 honest lots: step {step}/65536, fee {fee}, open interest {open_interest}");
}

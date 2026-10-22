//! Audit verification: how far dead resting orders at the top of the book block a taker.

mod common;

use common::*;
use noirwire_orderbook_engine::*;

const MARK: u64 = 150_000;
const STEPS: u32 = 16;

fn world(seats: usize) -> (World, usize) {
    let mut w = World::new(seats, ORDERS_PER_SIDE);
    w.max_steps = STEPS;
    let params = MarketParams {
        tick: 100,
        base_lot: 1_000_000,
        min_size: 1,
        min_notional: 1_000_000,
        band_bps: 400,
        im_bps: 1_000,
        mm_bps: 500,
        taker_fee_bps: 5,
        liq_penalty_bps: 200,
        funding_cap_bps: 100,
        max_move_bps: 250,
        max_open_orders: 32,
        max_price_age: 10,
        funding_interval: 60,
        min_publish_gap: 1,
        max_age_liquidation: 60,
        open_interest_cap: 10_000_000,
        liq_buffer_bps: 100,
        liq_insurance_share_bps: 5_000,
        fee_insurance_share_bps: 5_000,
        ..perp_params(0)
    };
    let m = w.add_market(params);
    w.set_price(m, MARK);
    (w, m)
}

fn arm(w: &mut World, m: usize, attacker: u32, price: u64, expiry: i64, count: u32) {
    for _ in 0..count {
        let junk = expiring(limit(Side::Bid, price, 7), expiry);
        assert_eq!(
            w.place(m, attacker, junk).unwrap().status,
            PlaceStatus::Rested
        );
    }
}

#[test]
fn a_blocked_taker_fills_on_the_next_attempt_unless_the_attacker_rearms_sixteen_orders() {
    let (mut w, m) = world(16);
    let honest = funded(&mut w, 100_000_000);
    let honest_bid = MARK - 1_000;
    w.place(m, honest, limit(Side::Bid, honest_bid, 100))
        .unwrap();
    let attacker = funded(&mut w, 10_000_000);
    let start = w.now;
    arm(&mut w, m, attacker, honest_bid + 100, start + 1, STEPS);
    w.now += 2;

    let seller = funded(&mut w, 100_000_000);
    let first = w.place(m, seller, ioc(Side::Ask, honest_bid, 100)).unwrap();
    assert_eq!(first.filled, 0);
    assert_eq!(
        w.markets[m].book.bid_count, 1,
        "the first attempt cleared every dead bid"
    );

    let second = w.place(m, seller, ioc(Side::Ask, honest_bid, 100)).unwrap();
    assert_eq!(second.filled, 100, "a plain retry reaches the live bid");
}

#[test]
fn thirty_two_dead_orders_from_one_seat_cost_the_taker_two_empty_attempts() {
    let (mut w, m) = world(16);
    let honest = funded(&mut w, 100_000_000);
    let honest_bid = MARK - 1_000;
    w.place(m, honest, limit(Side::Bid, honest_bid, 100))
        .unwrap();
    let attacker = funded(&mut w, 10_000_000);
    let start = w.now;
    arm(&mut w, m, attacker, honest_bid + 100, start, 32);
    let over_cap = w.place(
        m,
        attacker,
        expiring(limit(Side::Bid, honest_bid + 100, 7), start),
    );
    assert!(over_cap.is_err(), "the 33rd order of one seat is refused");
    w.now += 1;

    let seller = funded(&mut w, 100_000_000);
    let mut attempts = 0;
    loop {
        attempts += 1;
        let sold = w.place(m, seller, ioc(Side::Ask, honest_bid, 100)).unwrap();
        if sold.filled == 100 {
            break;
        }
        assert_eq!(sold.filled, 0);
    }
    assert_eq!(
        attempts, 3,
        "32 dead orders cost the taker two empty attempts, then it fills"
    );
}

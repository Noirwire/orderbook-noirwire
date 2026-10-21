//! Audit round 4, spec gaps: small behaviours of the engine that RULES.md now states.
//! Each test pins one, next to the RULES line it matches.

mod common;

use common::*;
use noirwire_orderbook_engine::*;

/// RULES 1 and 5: the insurance seat's share of a perp fee rounds down and the fee seat
/// takes the rest: a 3 atom fee at a 50% share gives the insurance seat 1 and the fee
/// seat 2.
#[test]
fn the_insurance_share_of_a_perp_fee_rounds_down_toward_the_fee_seat() {
    let mut params = perp_params(0);
    params.fee_insurance_share_bps = 5_000;
    params.taker_fee_bps = 30;
    let (mut w, m) = perp_world(params);
    w.set_price(m, MARK);
    let maker = funded(&mut w, 100_000);
    let taker = funded(&mut w, 100_000);
    let fee_before = w.collateral(FEE_SEAT);
    let insurance_before = w.collateral(INSURANCE_SEAT);

    w.place(m, maker, limit(Side::Ask, 1_000, 1)).unwrap();
    let outcome = w.place(m, taker, ioc(Side::Bid, 1_000, 1)).unwrap();

    assert_eq!(outcome.filled, 1);
    assert_eq!(outcome.fee_paid, 3, "1000 * 30 bps = 3 atoms exactly");
    assert_eq!(
        w.collateral(INSURANCE_SEAT) - insurance_before,
        1,
        "1.5 floored"
    );
    assert_eq!(w.collateral(FEE_SEAT) - fee_before, 2, "the remainder");
}

/// RULES 3, check 2: an order whose own expiry has already passed is refused with an
/// error.
#[test]
fn an_order_already_past_its_own_expiry_is_refused_with_an_error() {
    let (mut w, m) = perp_world(perp_params(0));
    w.set_price(m, MARK);
    let a = funded(&mut w, 100_000);
    let past = expiring(limit(Side::Bid, 990, 1), w.now - 1);
    assert_eq!(w.place(m, a, past), Err(EngineError::OrderExpired));
}

/// RULES 2: a reduce-only order never rests, so pairing it with post only is an error,
/// not an outcome.
#[test]
fn reduce_only_post_only_is_an_error_even_with_a_position_to_reduce() {
    let (mut w, m) = perp_world(perp_params(0));
    w.set_price(m, MARK);
    let long = funded(&mut w, 100_000);
    let short = funded(&mut w, 100_000);
    buy_from(&mut w, m, long, short, 1_000, 5);
    let order = reduce_only(post_only(Side::Ask, 1_010, 1));
    assert_eq!(w.place(m, long, order), Err(EngineError::InvalidOrderFlags));
}

/// RULES 12: the program refuses a zero move limit and a zero open-order limit; the
/// engine's own check accepts zero for both, so the bound is the program's alone.
#[test]
fn the_engine_check_accepts_a_zero_move_limit_and_a_zero_open_order_limit() {
    let mut zero_move = perp_params(0);
    zero_move.max_move_bps = 0;
    assert!(zero_move.check().is_ok());

    let mut zero_orders = perp_params(0);
    zero_orders.max_open_orders = 0;
    assert!(zero_orders.check().is_ok());
}

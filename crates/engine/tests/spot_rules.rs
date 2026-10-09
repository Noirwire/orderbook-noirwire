//! RULES sections 2 to 5, pinned on a spot market. Every call goes through `World`,
//! which also asserts RULES 13 after it.

mod common;

use common::*;
use noirwire_orderbook_engine::EngineError as E;
use noirwire_orderbook_engine::*;

const FUNDS: u64 = 1_000_000;
const LOTS: u64 = 100_000;

struct Spot {
    w: World,
    m: usize,
    a: u32,
    b: u32,
    c: u32,
}

fn spot_with(params: MarketParams, book_capacity: usize) -> Spot {
    let mut w = World::new(8, book_capacity);
    let m = w.add_market(params);
    let traders = [w.open(), w.open(), w.open()];
    for trader in traders {
        w.deposit(trader, Asset::Spot(QUOTE), FUNDS).unwrap();
        w.deposit(trader, Asset::Spot(BASE), LOTS).unwrap();
    }
    let [a, b, c] = traders;
    Spot { w, m, a, b, c }
}

fn spot() -> Spot {
    spot_with(spot_params(0), 8)
}

fn balance(available: u64, locked: u64) -> TokenBalance {
    TokenBalance { available, locked }
}

fn fill_summary(w: &World) -> Vec<(u64, u64, u32)> {
    w.fills
        .as_slice()
        .iter()
        .map(|fill| (fill.price, fill.size, fill.maker_seat))
        .collect()
}

#[test]
fn s2_limit_matches_while_price_is_at_or_better_then_rests_the_remainder() {
    let Spot { mut w, m, a, b, .. } = spot();
    w.place(m, b, limit(Side::Ask, 990, 2)).unwrap();
    w.place(m, b, limit(Side::Ask, 1_000, 2)).unwrap();
    w.place(m, b, limit(Side::Ask, 1_010, 2)).unwrap();

    let outcome = w.place(m, a, limit(Side::Bid, 1_000, 7)).unwrap();

    assert_eq!(sizes(&outcome), (4, 3, 0));
    assert_eq!(fill_summary(&w), vec![(990, 2, b), (1_000, 2, b)]);
    let bids = w.markets[m].resting(Side::Bid);
    assert_eq!(bids.len(), 1);
    let rest = bids[0];
    assert_eq!((rest.price, rest.remaining, rest.seat), (1_000, 3, a));
    assert_eq!(w.markets[m].resting(Side::Ask).len(), 1);
}

const REFUSED_POST_ONLY: PlaceOutcome = PlaceOutcome {
    status: PlaceStatus::RefusedPostOnlyWouldMatch,
    filled: 0,
    filled_notional: 0,
    rested: 0,
    cancelled: 5,
    fee_paid: 0,
    resting_order_seq: None,
    truncated: false,
};

#[test]
fn s3_7_post_only_that_would_match_is_refused_whole_as_an_outcome_and_changes_nothing() {
    let Spot { mut w, m, a, b, .. } = spot();
    w.place(m, b, limit(Side::Ask, 1_000, 2)).unwrap();
    let before = w.bytes();

    let crossing = w.place(m, a, post_only(Side::Bid, 1_000, 5));

    assert_eq!(crossing, Ok(REFUSED_POST_ONLY));
    assert!(before == w.bytes());
    assert!(w.fills.as_slice().is_empty());
    assert_eq!(w.spot(a, QUOTE), balance(FUNDS, 0));
    assert_eq!(w.markets[m].book.next_order_seq, 1);
}

#[test]
fn s3_7_post_only_that_would_only_hit_its_own_order_is_still_refused() {
    let Spot { mut w, m, a, .. } = spot();
    w.place(m, a, limit(Side::Ask, 1_000, 5)).unwrap();

    let crossing = w.place(m, a, post_only(Side::Bid, 1_000, 5));

    assert_eq!(crossing, Ok(REFUSED_POST_ONLY));
    assert_eq!(w.markets[m].resting(Side::Ask).len(), 1);
}

#[test]
fn s3_7_the_post_only_outcome_comes_after_every_check_on_the_traders_own_state() {
    let Spot { mut w, m, b, .. } = spot();
    w.place(m, b, limit(Side::Ask, 1_000, 2)).unwrap();
    let poor = w.open();
    w.deposit(poor, Asset::Spot(QUOTE), 5_014).unwrap();

    let crossing = w.place(m, poor, post_only(Side::Bid, 1_000, 5));
    assert_eq!(crossing, Err(E::InsufficientBalance));
    let not_crossing = w.place(m, poor, post_only(Side::Bid, 990, 5));
    assert_eq!(not_crossing.map(|o| o.status), Ok(PlaceStatus::Rested));
}

#[test]
fn s3_an_error_never_depends_on_what_the_book_holds() {
    let orders = [
        limit(Side::Bid, 1_000, 5),
        limit(Side::Ask, 1_000, 5),
        post_only(Side::Bid, 1_000, 5),
        ioc(Side::Bid, 1_010, 9),
        market(Side::Ask, 990, 9),
        limit(Side::Bid, 5, 1),
        limit(Side::Bid, 1_000, 2_000),
        limit(Side::Ask, 1_000, 2_000),
    ];
    for new_order in orders {
        let mut verdicts = Vec::new();
        for book_is_loaded in [false, true] {
            let Spot { mut w, m, a, b, c } = spot_with(spot_params(0), 4);
            if book_is_loaded {
                for price in [1_000, 1_000, 1_010, 1_020] {
                    w.place(m, b, limit(Side::Ask, price, 1)).unwrap();
                }
                for price in [990, 990, 980, 970] {
                    w.place(m, c, limit(Side::Bid, price, 1)).unwrap();
                }
            }
            verdicts.push(w.place(m, a, new_order).err());
        }
        assert_eq!(verdicts[0], verdicts[1], "{new_order:?}");
    }
}

#[test]
fn s2_post_only_that_does_not_match_rests_in_full() {
    let Spot { mut w, m, a, b, .. } = spot();
    w.place(m, b, limit(Side::Ask, 1_010, 2)).unwrap();

    let outcome = w.place(m, a, post_only(Side::Bid, 1_000, 5)).unwrap();

    assert_eq!(sizes(&outcome), (0, 5, 0));
    assert!(w.fills.as_slice().is_empty());
}

#[test]
fn s2_immediate_or_cancel_matches_as_limit_and_cancels_the_remainder() {
    let Spot { mut w, m, a, b, .. } = spot();
    w.place(m, b, limit(Side::Ask, 1_000, 2)).unwrap();
    w.place(m, b, limit(Side::Ask, 1_010, 2)).unwrap();

    let outcome = w.place(m, a, ioc(Side::Bid, 1_000, 5)).unwrap();

    assert_eq!(sizes(&outcome), (2, 0, 3));
    assert!(w.markets[m].resting(Side::Bid).is_empty());
    assert_eq!(w.spot(a, QUOTE).locked, 0);
    assert_eq!(w.seat(a).open_orders[m], 0);
}

#[test]
fn s2_market_order_matches_to_its_worst_price_and_cancels_the_remainder() {
    let Spot { mut w, m, a, b, .. } = spot();
    w.place(m, b, limit(Side::Ask, 1_000, 2)).unwrap();
    w.place(m, b, limit(Side::Ask, 1_010, 2)).unwrap();
    w.place(m, b, limit(Side::Ask, 1_030, 2)).unwrap();

    let outcome = w.place(m, a, market(Side::Bid, 1_020, 10)).unwrap();

    assert_eq!(sizes(&outcome), (4, 0, 6));
    assert_eq!(fill_summary(&w), vec![(1_000, 2, b), (1_010, 2, b)]);
    assert_eq!(w.markets[m].resting(Side::Ask).len(), 1);
}

#[test]
fn s2_market_order_that_exhausts_the_book_cancels_what_is_left() {
    let Spot { mut w, m, a, b, .. } = spot();
    w.place(m, b, limit(Side::Ask, 1_000, 2)).unwrap();
    w.place(m, b, limit(Side::Ask, 1_010, 3)).unwrap();

    let outcome = w.place(m, a, market(Side::Bid, 1_200, 50)).unwrap();

    assert_eq!(sizes(&outcome), (5, 0, 45));
    assert!(!outcome.truncated);
    assert!(w.markets[m].resting(Side::Ask).is_empty());
    assert!(w.markets[m].resting(Side::Bid).is_empty());
    assert_eq!(w.spot(b, BASE), balance(LOTS - 500, 0));
}

#[test]
fn s2_reduce_only_is_refused_on_a_spot_market() {
    let Spot { mut w, m, a, .. } = spot();

    let refused = w.place(m, a, reduce_only(ioc(Side::Ask, 1_000, 1)));

    assert_eq!(refused, Err(E::InvalidOrderFlags));
}

#[test]
fn s3_1_a_paused_exchange_or_market_rejects_orders_but_not_cancels() {
    let Spot { mut w, m, a, .. } = spot();
    let resting = w.place(m, a, limit(Side::Bid, 990, 1)).unwrap();

    w.paused = true;
    assert_eq!(
        w.place(m, a, limit(Side::Bid, 990, 1)),
        Err(E::ExchangePaused)
    );
    w.paused = false;
    w.markets[m].params.status = STATUS_PAUSED;
    assert_eq!(
        w.place(m, a, limit(Side::Bid, 990, 1)),
        Err(E::MarketPaused)
    );

    assert_eq!(w.cancel(m, a, seq(&resting)), Ok(()));
    assert_eq!(w.spot(a, QUOTE), balance(FUNDS, 0));
}

#[test]
fn s3_1_a_reduce_only_spot_market_accepts_no_order() {
    let Spot { mut w, m, a, .. } = spot();
    w.markets[m].params.status = STATUS_REDUCE_ONLY;

    assert_eq!(
        w.place(m, a, limit(Side::Bid, 990, 1)),
        Err(E::MarketReduceOnly)
    );
}

#[test]
fn s3_2_size_below_the_minimum_is_rejected() {
    let mut params = spot_params(0);
    params.min_size = 3;
    let Spot { mut w, m, a, .. } = spot_with(params, 8);

    assert_eq!(
        w.place(m, a, limit(Side::Bid, 1_000, 2)),
        Err(E::SizeTooSmall)
    );
    assert_eq!(
        w.place(m, a, limit(Side::Bid, 1_000, 0)),
        Err(E::SizeTooSmall)
    );
    assert!(w.place(m, a, limit(Side::Bid, 1_000, 3)).is_ok());
}

#[test]
fn s3_2_price_off_the_tick_or_zero_is_rejected() {
    let Spot { mut w, m, a, .. } = spot();

    assert_eq!(
        w.place(m, a, limit(Side::Bid, 1_005, 1)),
        Err(E::PriceOffTick)
    );
    assert_eq!(w.place(m, a, limit(Side::Bid, 0, 1)), Err(E::PriceOffTick));
}

#[test]
fn s3_2_notional_at_the_order_price_below_the_minimum_is_rejected() {
    let mut params = spot_params(0);
    params.min_notional = 3_000;
    let Spot { mut w, m, a, .. } = spot_with(params, 8);

    assert_eq!(
        w.place(m, a, limit(Side::Bid, 990, 3)),
        Err(E::NotionalTooSmall)
    );
    assert!(w.place(m, a, limit(Side::Bid, 1_000, 3)).is_ok());
}

#[test]
fn s3_3_price_outside_the_band_is_rejected_for_every_order_type() {
    let Spot { mut w, m, a, .. } = spot();
    let types = [
        OrderType::Limit,
        OrderType::PostOnly,
        OrderType::ImmediateOrCancel,
        OrderType::Market,
    ];

    for order_type in types {
        for (side, price) in [(Side::Bid, 790), (Side::Ask, 1_210)] {
            let refused = w.place(m, a, order(side, order_type, price, 1));
            assert_eq!(refused, Err(E::PriceOutsideBand));
        }
    }
    assert!(w.place(m, a, limit(Side::Bid, 800, 1)).is_ok());
    assert!(w.place(m, a, limit(Side::Ask, 1_200, 1)).is_ok());
}

#[test]
fn s3_4_a_stale_feed_rejects_a_spot_order_and_never_blocks_cancels() {
    let Spot { mut w, m, a, .. } = spot();
    let resting = w.place(m, a, limit(Side::Bid, 990, 1)).unwrap();
    w.place(m, a, limit(Side::Ask, 1_010, 1)).unwrap();

    w.now += 60;
    assert!(w.place(m, a, limit(Side::Bid, 980, 1)).is_ok());
    w.now += 1;
    assert_eq!(w.place(m, a, limit(Side::Bid, 980, 1)), Err(E::StalePrice));
    assert_eq!(w.place(m, a, ioc(Side::Ask, 990, 1)), Err(E::StalePrice));

    assert_eq!(w.cancel(m, a, seq(&resting)), Ok(()));
    assert_eq!(w.cancel_all(m, a, 10), Ok(2));
    assert_eq!(w.withdraw(a, Asset::Spot(QUOTE), FUNDS), Ok(()));
    assert_eq!(w.deposit(a, Asset::Spot(QUOTE), 5), Ok(()));
}

#[test]
fn s3_4_a_price_stamped_in_the_future_counts_as_stale() {
    let Spot { mut w, m, a, .. } = spot();
    w.markets[m].price.publish_time = w.now + 1;

    assert_eq!(w.place(m, a, limit(Side::Bid, 990, 1)), Err(E::StalePrice));
}

#[test]
fn s3_5_the_open_order_limit_applies_only_to_orders_that_could_rest() {
    let Spot { mut w, m, a, b, .. } = spot();
    for price in [960, 970, 980, 990] {
        w.place(m, a, limit(Side::Bid, price, 1)).unwrap();
    }
    w.place(m, b, limit(Side::Bid, 1_000, 1)).unwrap();

    assert_eq!(
        w.place(m, a, limit(Side::Bid, 950, 1)),
        Err(E::TooManyOpenOrders)
    );
    assert_eq!(
        w.place(m, a, post_only(Side::Ask, 1_010, 1)),
        Err(E::TooManyOpenOrders)
    );
    let taking = w.place(m, a, ioc(Side::Ask, 1_000, 1)).unwrap();
    assert_eq!(taking.filled, 1);
    assert_eq!(w.seat(a).open_orders[m], 4);
}

#[test]
fn s3_6_spot_available_balance_must_cover_the_lock() {
    let Spot { mut w, m, .. } = spot();
    let poor = w.open();
    w.deposit(poor, Asset::Spot(QUOTE), 5_014).unwrap();
    w.deposit(poor, Asset::Spot(BASE), 499).unwrap();

    assert_eq!(
        w.place(m, poor, limit(Side::Bid, 1_000, 5)),
        Err(E::InsufficientBalance)
    );
    assert_eq!(
        w.place(m, poor, limit(Side::Ask, 1_000, 5)),
        Err(E::InsufficientBalance)
    );
    w.deposit(poor, Asset::Spot(QUOTE), 1).unwrap();
    w.deposit(poor, Asset::Spot(BASE), 1).unwrap();
    assert!(w.place(m, poor, limit(Side::Bid, 990, 5)).is_ok());
    assert!(w.place(m, poor, limit(Side::Ask, 1_010, 5)).is_ok());
}

#[test]
fn s3_6_the_lock_is_measured_at_the_order_price_not_the_fill_price() {
    let Spot { mut w, m, b, .. } = spot();
    w.place(m, b, limit(Side::Ask, 900, 5)).unwrap();
    let poor = w.open();
    w.deposit(poor, Asset::Spot(QUOTE), 5_000).unwrap();

    let refused = w.place(m, poor, ioc(Side::Bid, 1_000, 5));

    assert_eq!(refused, Err(E::InsufficientBalance));
}

#[test]
fn s3_8_an_order_that_would_rest_on_a_full_side_is_cancelled_as_an_outcome_and_evicts_nothing() {
    let Spot { mut w, m, a, b, c } = spot_with(spot_params(0), 2);
    w.place(m, a, limit(Side::Bid, 990, 1)).unwrap();
    w.place(m, b, limit(Side::Bid, 980, 1)).unwrap();
    let before = w.markets[m].resting(Side::Bid);

    for new_order in [limit(Side::Bid, 1_000, 3), post_only(Side::Bid, 970, 3)] {
        let outcome = w.place(m, c, new_order).unwrap();

        assert_eq!(outcome.status, PlaceStatus::RemainderCancelledBookFull);
        assert_eq!(sizes(&outcome), (0, 0, 3));
        assert_eq!(outcome.resting_order_seq, None);
    }
    assert_eq!(w.markets[m].resting(Side::Bid), before);
    assert_eq!(w.spot(c, QUOTE), balance(FUNDS, 0));
    assert_eq!(w.seat(c).open_orders[m], 0);

    let taking = w.place(m, c, ioc(Side::Ask, 990, 1)).unwrap();
    assert_eq!(taking.filled, 1);
    let resting = w.place(m, c, limit(Side::Bid, 1_000, 1)).unwrap();
    assert_eq!(resting.status, PlaceStatus::Rested);
}

#[test]
fn s3_8_fills_made_before_a_full_side_stand_and_the_remainder_holds_no_lock() {
    let Spot { mut w, m, a, b, c } = spot_with(spot_params(0), 2);
    w.place(m, a, limit(Side::Ask, 1_010, 1)).unwrap();
    w.place(m, b, limit(Side::Ask, 1_020, 1)).unwrap();
    w.place(m, a, limit(Side::Bid, 990, 1)).unwrap();
    w.place(m, b, limit(Side::Bid, 980, 1)).unwrap();

    let whole = w.place(m, c, limit(Side::Bid, 1_010, 1)).unwrap();
    assert_eq!(whole.status, PlaceStatus::Filled);
    assert_eq!(sizes(&whole), (1, 0, 0));

    let outcome = w.place(m, c, limit(Side::Bid, 1_020, 3)).unwrap();

    assert_eq!(outcome.status, PlaceStatus::RemainderCancelledBookFull);
    assert_eq!(sizes(&outcome), (1, 0, 2));
    assert_eq!(outcome.filled_notional, 1_020);
    assert_eq!(outcome.fee_paid, 4);
    assert_eq!(w.fills.as_slice().len(), 1);
    assert!(w.markets[m].resting(Side::Ask).is_empty());
    assert_eq!(w.markets[m].resting(Side::Bid).len(), 2);
    let spent = 1_010 + 4 + 1_020 + 4;
    assert_eq!(w.spot(c, QUOTE), balance(FUNDS - spent, 0));
    assert_eq!(w.spot(c, BASE), balance(LOTS + 200, 0));
    assert_eq!(w.seat(c).open_orders[m], 0);
}

#[test]
fn s3_an_immediate_or_market_order_that_finds_nothing_succeeds_with_nothing_filled() {
    let Spot { mut w, m, a, b, .. } = spot();
    w.place(m, b, limit(Side::Ask, 1_010, 2)).unwrap();
    let book_before = w.markets[m].resting(Side::Ask);

    for new_order in [ioc(Side::Bid, 1_000, 4), market(Side::Bid, 1_000, 4)] {
        let outcome = w.place(m, a, new_order).unwrap();

        assert_eq!(outcome.status, PlaceStatus::RemainderCancelled);
        assert_eq!(sizes(&outcome), (0, 0, 4));
        assert_eq!((outcome.filled_notional, outcome.fee_paid), (0, 0));
        assert!(w.fills.as_slice().is_empty());
    }
    assert_eq!(w.markets[m].resting(Side::Ask), book_before);
    assert_eq!(w.spot(a, QUOTE), balance(FUNDS, 0));
    assert_eq!(w.spot(a, BASE), balance(LOTS, 0));
}

#[test]
fn the_outcome_reports_what_a_private_order_record_needs() {
    let Spot { mut w, m, a, b, .. } = spot();
    w.place(m, b, limit(Side::Ask, 990, 2)).unwrap();
    w.place(m, b, limit(Side::Ask, 1_000, 1)).unwrap();

    let outcome = w.place(m, a, limit(Side::Bid, 1_000, 5)).unwrap();

    let expected = PlaceOutcome {
        status: PlaceStatus::Rested,
        filled: 3,
        filled_notional: 2 * 990 + 1_000,
        rested: 2,
        cancelled: 0,
        fee_paid: 6 + 3,
        resting_order_seq: Some(2),
        truncated: false,
    };
    assert_eq!(outcome, expected);
    assert_eq!(w.markets[m].resting(Side::Bid)[0].sequence, 2);
    let codes = [
        PlaceStatus::Filled.code(),
        PlaceStatus::Rested.code(),
        PlaceStatus::RemainderCancelled.code(),
        PlaceStatus::RemainderCancelledStepLimit.code(),
        PlaceStatus::RemainderCancelledBookFull.code(),
        PlaceStatus::RefusedPostOnlyWouldMatch.code(),
    ];
    assert_eq!(codes, [1, 2, 3, 4, 5, 6]);
}

#[test]
fn s3_checks_run_in_the_documented_order() {
    let mut params = spot_params(0);
    params.min_size = 2;
    let Spot { mut w, m, .. } = spot_with(params, 8);
    let poor = w.open();
    let bad_everything = limit(Side::Bid, 5, 1);

    w.paused = true;
    w.now += 1_000;
    assert_eq!(w.place(m, poor, bad_everything), Err(E::ExchangePaused));
    w.paused = false;
    assert_eq!(w.place(m, poor, bad_everything), Err(E::SizeTooSmall));
    let off_tick = limit(Side::Bid, 5, 2);
    assert_eq!(w.place(m, poor, off_tick), Err(E::PriceOffTick));
    let outside_band = limit(Side::Bid, 10, 2);
    assert_eq!(w.place(m, poor, outside_band), Err(E::PriceOutsideBand));
    let in_band = limit(Side::Bid, 1_000, 2);
    assert_eq!(w.place(m, poor, in_band), Err(E::StalePrice));
    w.now -= 1_000;
    assert_eq!(w.place(m, poor, in_band), Err(E::InsufficientBalance));
}

#[test]
fn s4_priority_is_best_price_first_then_lowest_sequence() {
    let Spot { mut w, m, a, b, c } = spot();
    w.place(m, b, limit(Side::Ask, 1_010, 1)).unwrap();
    w.place(m, c, limit(Side::Ask, 1_000, 1)).unwrap();
    w.place(m, b, limit(Side::Ask, 1_000, 1)).unwrap();

    w.place(m, a, limit(Side::Bid, 1_010, 3)).unwrap();

    assert_eq!(
        fill_summary(&w),
        vec![(1_000, 1, c), (1_000, 1, b), (1_010, 1, b)]
    );
}

#[test]
fn s4_bids_are_matched_highest_price_first_then_lowest_sequence() {
    let Spot { mut w, m, a, b, c } = spot();
    w.place(m, b, limit(Side::Bid, 990, 1)).unwrap();
    w.place(m, c, limit(Side::Bid, 1_000, 1)).unwrap();
    w.place(m, b, limit(Side::Bid, 1_000, 1)).unwrap();

    w.place(m, a, limit(Side::Ask, 990, 3)).unwrap();

    assert_eq!(
        fill_summary(&w),
        vec![(1_000, 1, c), (1_000, 1, b), (990, 1, b)]
    );
}

#[test]
fn s4_a_fill_executes_at_the_resting_price_and_the_taker_keeps_the_improvement() {
    let Spot { mut w, m, a, b, .. } = spot();
    w.place(m, b, limit(Side::Ask, 990, 5)).unwrap();

    let outcome = w.place(m, a, ioc(Side::Bid, 1_000, 5)).unwrap();

    assert_eq!(fill_summary(&w), vec![(990, 5, b)]);
    assert_eq!(outcome.fee_paid, 15);
    assert_eq!(w.spot(a, QUOTE), balance(FUNDS - 4_950 - 15, 0));
    assert_eq!(w.spot(a, BASE), balance(LOTS + 500, 0));
}

#[test]
fn s4_a_partly_filled_resting_order_keeps_its_place_in_the_queue() {
    let Spot { mut w, m, a, b, c } = spot();
    w.place(m, b, limit(Side::Ask, 1_000, 5)).unwrap();
    w.place(m, c, limit(Side::Ask, 1_000, 5)).unwrap();

    w.place(m, a, ioc(Side::Bid, 1_000, 2)).unwrap();
    w.place(m, a, ioc(Side::Bid, 1_000, 4)).unwrap();

    assert_eq!(fill_summary(&w), vec![(1_000, 3, b), (1_000, 1, c)]);
}

#[test]
fn s4_self_trade_cancels_the_resting_order_and_matching_continues() {
    let Spot { mut w, m, a, b, .. } = spot();
    w.place(m, a, limit(Side::Ask, 1_000, 2)).unwrap();
    w.place(m, b, limit(Side::Ask, 1_010, 2)).unwrap();
    assert_eq!(w.spot(a, BASE), balance(LOTS - 200, 200));

    let outcome = w.place(m, a, limit(Side::Bid, 1_010, 2)).unwrap();

    assert_eq!(fill_summary(&w), vec![(1_010, 2, b)]);
    assert_eq!(sizes(&outcome), (2, 0, 0));
    assert_eq!(w.spot(a, BASE), balance(LOTS + 200, 0));
    assert_eq!(w.seat(a).open_orders[m], 0);
    assert!(w.markets[m].resting(Side::Ask).is_empty());
}

#[test]
fn s4_a_self_cancel_counts_as_one_step_toward_the_limit() {
    let Spot { mut w, m, a, b, .. } = spot();
    w.max_steps = 2;
    w.place(m, a, limit(Side::Ask, 1_000, 1)).unwrap();
    w.place(m, b, limit(Side::Ask, 1_000, 1)).unwrap();
    w.place(m, b, limit(Side::Ask, 1_000, 1)).unwrap();

    let outcome = w.place(m, a, limit(Side::Bid, 1_000, 5)).unwrap();

    assert_eq!(fill_summary(&w), vec![(1_000, 1, b)]);
    assert!(outcome.truncated);
    assert_eq!(sizes(&outcome), (1, 0, 4));
    assert_eq!(w.markets[m].resting(Side::Ask).len(), 1);
}

#[test]
fn s4_step_limit_reached_with_a_crossing_remainder_cancels_it_whatever_the_type() {
    for order_type in [OrderType::Limit, OrderType::Market] {
        let Spot { mut w, m, a, b, .. } = spot();
        w.max_steps = 2;
        for _ in 0..3 {
            w.place(m, b, limit(Side::Ask, 1_000, 1)).unwrap();
        }

        let outcome = w
            .place(m, a, order(Side::Bid, order_type, 1_000, 5))
            .unwrap();

        assert!(outcome.truncated);
        assert_eq!(sizes(&outcome), (2, 0, 3));
        assert_eq!(w.fills.as_slice().len(), 2);
        assert!(w.markets[m].resting(Side::Bid).is_empty());
        assert_eq!(w.markets[m].resting(Side::Ask).len(), 1);
        assert_eq!(w.spot(a, QUOTE), balance(FUNDS - 2_000 - 6, 0));
    }
}

#[test]
fn s4_step_limit_reached_with_nothing_left_to_match_still_rests_the_remainder() {
    let Spot { mut w, m, a, b, .. } = spot();
    w.max_steps = 2;
    w.place(m, b, limit(Side::Ask, 1_000, 1)).unwrap();
    w.place(m, b, limit(Side::Ask, 1_000, 1)).unwrap();
    w.place(m, b, limit(Side::Ask, 1_010, 1)).unwrap();

    let outcome = w.place(m, a, limit(Side::Bid, 1_000, 5)).unwrap();

    assert!(!outcome.truncated);
    assert_eq!(sizes(&outcome), (2, 3, 0));
}

#[test]
fn s4_a_step_limit_of_zero_cancels_any_crossing_order() {
    let Spot { mut w, m, a, b, .. } = spot();
    w.max_steps = 0;
    w.place(m, b, limit(Side::Ask, 1_000, 1)).unwrap();

    let outcome = w.place(m, a, limit(Side::Bid, 1_000, 1)).unwrap();

    assert!(outcome.truncated);
    assert_eq!(sizes(&outcome), (0, 0, 1));
}

#[test]
fn s4_a_step_limit_above_the_fill_list_capacity_is_refused() {
    let Spot { mut w, m, a, .. } = spot();
    w.max_steps = MAX_FILLS as u32 + 1;

    assert_eq!(
        w.place(m, a, limit(Side::Bid, 990, 1)),
        Err(E::StepLimitTooLarge)
    );
}

#[test]
fn s4_each_fill_takes_the_next_fill_sequence_and_each_order_the_next_order_sequence() {
    let Spot { mut w, m, a, b, .. } = spot();
    let first = w.place(m, b, limit(Side::Ask, 1_000, 1)).unwrap();
    let second = w.place(m, b, limit(Side::Ask, 1_000, 1)).unwrap();
    let taking = w.place(m, a, ioc(Side::Bid, 1_000, 2)).unwrap();
    let sequences: Vec<u64> = w.fills.as_slice().iter().map(|f| f.fill_seq).collect();
    let third = w.place(m, b, limit(Side::Ask, 1_000, 1)).unwrap();
    w.place(m, a, ioc(Side::Bid, 1_000, 1)).unwrap();

    assert_eq!((seq(&first), seq(&second), seq(&third)), (0, 1, 3));
    assert_eq!(taking.resting_order_seq, None);
    assert_eq!(sequences, vec![0, 1]);
    assert_eq!(w.fills.as_slice()[0].fill_seq, 2);
    assert_eq!(w.markets[m].book.next_fill_seq, 3);
}

#[test]
fn s5_a_bid_locks_notional_plus_the_taker_fee_and_an_ask_locks_its_lots() {
    let Spot { mut w, m, a, b, .. } = spot();

    w.place(m, a, limit(Side::Bid, 1_000, 5)).unwrap();
    w.place(m, b, limit(Side::Ask, 1_010, 5)).unwrap();

    assert_eq!(w.spot(a, QUOTE), balance(FUNDS - 5_015, 5_015));
    assert_eq!(w.spot(a, BASE), balance(LOTS, 0));
    assert_eq!(w.spot(b, BASE), balance(LOTS - 500, 500));
    assert_eq!(w.spot(b, QUOTE), balance(FUNDS, 0));
    assert_eq!(w.markets[m].resting(Side::Bid)[0].locked, 5_015);
}

#[test]
fn s5_buyer_fill_as_maker_releases_the_reserved_amount_and_pays_only_the_notional() {
    let Spot { mut w, m, a, b, .. } = spot();
    w.place(m, a, limit(Side::Bid, 1_000, 5)).unwrap();

    w.place(m, b, ioc(Side::Ask, 1_000, 2)).unwrap();

    let still_locked = 3_000 + 9;
    assert_eq!(
        w.spot(a, QUOTE),
        balance(FUNDS - 2_000 - still_locked, still_locked)
    );
    assert_eq!(w.spot(a, BASE), balance(LOTS + 200, 0));
    assert_eq!(w.markets[m].resting(Side::Bid)[0].locked, still_locked);

    w.place(m, b, ioc(Side::Ask, 1_000, 3)).unwrap();

    assert_eq!(w.spot(a, QUOTE), balance(FUNDS - 5_000, 0));
    assert_eq!(w.spot(a, BASE), balance(LOTS + 500, 0));
}

#[test]
fn s5_seller_fill_moves_locked_base_out_and_quote_in() {
    let Spot { mut w, m, a, b, .. } = spot();
    w.place(m, b, limit(Side::Ask, 1_000, 5)).unwrap();

    w.place(m, a, ioc(Side::Bid, 1_000, 2)).unwrap();

    assert_eq!(w.spot(b, BASE), balance(LOTS - 500, 300));
    assert_eq!(w.spot(b, QUOTE), balance(FUNDS + 2_000, 0));
}

#[test]
fn s5_the_taker_pays_the_fee_rounded_up_to_the_fee_seat_and_the_maker_pays_nothing() {
    let Spot { mut w, m, a, b, .. } = spot();
    w.place(m, b, limit(Side::Ask, 990, 1)).unwrap();
    w.place(m, b, limit(Side::Bid, 970, 1)).unwrap();

    let buying = w.place(m, a, ioc(Side::Bid, 990, 1)).unwrap();
    let selling = w.place(m, a, ioc(Side::Ask, 970, 1)).unwrap();

    assert_eq!((buying.fee_paid, selling.fee_paid), (3, 3));
    assert_eq!(w.spot(FEE_SEAT, QUOTE), balance(6, 0));
    assert_eq!(w.spot(a, QUOTE), balance(FUNDS - 990 - 3 + 970 - 3, 0));
    assert_eq!(w.spot(b, QUOTE), balance(FUNDS + 990 - 970, 0));
    assert_eq!(w.spot(a, BASE), balance(LOTS, 0));
}

#[test]
fn s5_a_fee_of_zero_bps_charges_nothing_and_needs_no_fee_seat_credit() {
    let mut params = spot_params(0);
    params.taker_fee_bps = 0;
    let Spot { mut w, m, a, b, .. } = spot_with(params, 8);
    w.place(m, b, limit(Side::Ask, 1_000, 1)).unwrap();

    let outcome = w.place(m, a, ioc(Side::Bid, 1_000, 1)).unwrap();

    assert_eq!(outcome.fee_paid, 0);
    assert_eq!(w.spot(FEE_SEAT, QUOTE), balance(0, 0));
}

#[test]
fn s5_cancel_returns_whatever_the_order_still_has_locked() {
    let Spot { mut w, m, a, b, .. } = spot();
    let bid = w.place(m, a, limit(Side::Bid, 1_000, 5)).unwrap();
    let ask = w.place(m, a, limit(Side::Ask, 1_010, 4)).unwrap();
    w.place(m, b, ioc(Side::Ask, 1_000, 2)).unwrap();

    w.cancel(m, a, seq(&bid)).unwrap();
    w.cancel(m, a, seq(&ask)).unwrap();

    assert_eq!(w.spot(a, QUOTE), balance(FUNDS - 2_000, 0));
    assert_eq!(w.spot(a, BASE), balance(LOTS + 200, 0));
    assert_eq!(w.seat(a).open_orders[m], 0);
    assert_eq!(w.cancel(m, a, seq(&bid)), Err(E::OrderNotFound));
}

#[test]
fn s5_a_resting_bid_survives_a_fee_change_without_losing_or_inventing_tokens() {
    let Spot { mut w, m, a, b, .. } = spot();
    w.place(m, a, limit(Side::Bid, 1_000, 5)).unwrap();
    w.markets[m].params.taker_fee_bps = 100;
    let mut ledger = LedgerMut {
        header: &mut w.header,
        seats: &mut w.seats,
    };
    let state = &mut w.markets[m];
    let mut view = MarketMut {
        params: &mut state.params,
        book: &mut state.book,
        bids: &mut state.bids,
        asks: &mut state.asks,
        price: &state.price,
    };
    let risks = [MarketRisk::NONE; MARKETS];
    let env = Env {
        now: w.now,
        exchange_paused: false,
        max_steps: 8,
        markets: &risks,
        hash: sha,
    };
    let mut journal = Journal::new(&mut w.journal);
    let taker = Trader {
        seat: b,
        owner: &w.keys[b as usize],
    };
    let sell = ioc(Side::Ask, 1_000, 2);

    place_order(
        &mut ledger,
        &mut view,
        &mut journal,
        &env,
        taker,
        &sell,
        &mut w.fills,
    )
    .unwrap();

    let buyer = w.seats[a as usize].spot[usize::from(QUOTE)];
    assert_eq!(buyer.locked, 3_015);
    assert_eq!(buyer.available + buyer.locked, FUNDS - 2_000);
    assert_eq!(w.markets[m].bids[0].locked, 3_015);
}

#[test]
fn cancel_all_cancels_at_most_the_asked_number_best_bids_first() {
    let Spot { mut w, m, a, b, .. } = spot();
    w.place(m, a, limit(Side::Bid, 970, 1)).unwrap();
    w.place(m, a, limit(Side::Bid, 990, 1)).unwrap();
    w.place(m, a, limit(Side::Ask, 1_010, 1)).unwrap();
    w.place(m, b, limit(Side::Bid, 980, 1)).unwrap();

    assert_eq!(w.cancel_all(m, a, 1), Ok(1));
    let bids = w.markets[m].resting(Side::Bid);
    let prices: Vec<(u64, u32)> = bids.iter().map(|o| (o.price, o.seat)).collect();
    assert_eq!(prices, vec![(980, b), (970, a)]);

    assert_eq!(w.cancel_all(m, a, 0), Ok(0));
    assert_eq!(w.cancel_all(m, a, 10), Ok(2));
    assert_eq!(w.spot(a, QUOTE), balance(FUNDS, 0));
    assert_eq!(w.spot(a, BASE), balance(LOTS, 0));
    assert_eq!(w.markets[m].resting(Side::Bid).len(), 1);
    assert!(w.markets[m].resting(Side::Ask).is_empty());
}

#[test]
fn cancelling_another_traders_order_reports_it_as_not_found() {
    let Spot { mut w, m, a, b, .. } = spot();
    let resting = w.place(m, a, limit(Side::Bid, 990, 1)).unwrap();

    assert_eq!(w.cancel(m, b, seq(&resting)), Err(E::OrderNotFound));
    assert_eq!(w.cancel(m, b, 999), Err(E::OrderNotFound));
    assert_eq!(w.markets[m].resting(Side::Bid).len(), 1);
}

#[test]
fn s3_6_a_bid_that_can_take_needs_one_atom_per_step_above_its_lock_for_per_fill_fee_rounding() {
    let mut params = spot_params(0);
    params.taker_fee_bps = 1;
    let Spot { mut w, m, b, c, .. } = spot_with(params, 8);
    let trader = w.open();
    let lock = bid_lock(1_000, 2, 1) as u64;
    assert_eq!(lock, 2_000 + 1);
    let headroom = u64::from(w.max_steps);
    w.deposit(trader, Asset::Spot(QUOTE), lock + headroom - 1)
        .unwrap();

    let on_an_empty_book = w.place(m, trader, ioc(Side::Bid, 1_000, 2));
    w.place(m, b, limit(Side::Ask, 1_000, 1)).unwrap();
    w.place(m, c, limit(Side::Ask, 1_000, 1)).unwrap();
    let on_a_loaded_book = w.place(m, trader, ioc(Side::Bid, 1_000, 2));

    assert_eq!(on_an_empty_book, Err(E::InsufficientBalance));
    assert_eq!(on_a_loaded_book, Err(E::InsufficientBalance));
    w.deposit(trader, Asset::Spot(QUOTE), 1).unwrap();
    let outcome = w.place(m, trader, ioc(Side::Bid, 1_000, 2)).unwrap();
    assert_eq!(outcome.fee_paid, 2);
    assert_eq!(w.spot(trader, QUOTE), balance(headroom - 1, 0));
}

#[test]
fn s3_6_a_post_only_bid_needs_exactly_its_lock() {
    let Spot { mut w, m, .. } = spot();
    let trader = w.open();
    w.deposit(trader, Asset::Spot(QUOTE), 5_015).unwrap();

    assert_eq!(
        w.place(m, trader, limit(Side::Bid, 1_000, 5)),
        Err(E::InsufficientBalance)
    );
    let outcome = w.place(m, trader, post_only(Side::Bid, 1_000, 5)).unwrap();

    assert_eq!(outcome.status, PlaceStatus::Rested);
    assert_eq!(w.spot(trader, QUOTE), balance(0, 5_015));
}

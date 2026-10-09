//! RULES sections 2 and 6 to 9, pinned on perpetual markets. Every call goes through
//! `World`, which also asserts RULES 13 after it.

mod common;

use common::*;
use noirwire_orderbook_engine::EngineError as E;
use noirwire_orderbook_engine::*;

const COLLATERAL: u64 = 100_000;
const RICH: i64 = 100_000;

struct Perp {
    w: World,
    m: usize,
    a: u32,
    b: u32,
    c: u32,
}

fn perp_with(params: MarketParams) -> Perp {
    let mut w = World::new(10, 8);
    let m = w.add_market(params);
    let traders = [w.open(), w.open(), w.open()];
    for trader in traders {
        w.deposit(trader, Asset::Collateral, COLLATERAL).unwrap();
    }
    let [a, b, c] = traders;
    Perp { w, m, a, b, c }
}

fn perp() -> Perp {
    perp_with(perp_params(0))
}

fn funded(w: &mut World, collateral: u64) -> u32 {
    let trader = w.open();
    w.deposit(trader, Asset::Collateral, collateral).unwrap();
    trader
}

/// `taker` buys `size` lots from `maker` at `price`. The taker pays the fee.
fn go_long(w: &mut World, m: usize, taker: u32, maker: u32, price: u64, size: u64) {
    w.place(m, maker, limit(Side::Ask, price, size)).unwrap();
    let outcome = w.place(m, taker, ioc(Side::Bid, price, size)).unwrap();
    assert_eq!(outcome.filled, size);
}

/// `taker` sells `size` lots to `maker` at `price`. The taker pays the fee.
fn go_short(w: &mut World, m: usize, taker: u32, maker: u32, price: u64, size: u64) {
    w.place(m, maker, limit(Side::Bid, price, size)).unwrap();
    let outcome = w.place(m, taker, ioc(Side::Ask, price, size)).unwrap();
    assert_eq!(outcome.filled, size);
}

fn position(w: &World, seat: u32, m: usize) -> (i64, i64) {
    let slot = w.slot(seat, m);
    (slot.base, slot.quote)
}

/// Moves the clock and republishes the same mark, so only the time changes.
fn advance(w: &mut World, m: usize, seconds: i64) {
    w.now += seconds;
    let mark = w.markets[m].price.price;
    w.set_price(m, mark);
}

#[test]
fn s6_a_fill_moves_base_and_quote_and_the_taker_fee_leaves_collateral() {
    let Perp { mut w, m, a, b, .. } = perp();

    go_long(&mut w, m, a, b, 1_000, 10);

    assert_eq!(position(&w, a, m), (10, -10_000));
    assert_eq!(position(&w, b, m), (-10, 10_000));
    assert_eq!(w.collateral(a), RICH - 30);
    assert_eq!(w.collateral(b), RICH);
    assert_eq!(w.collateral(FEE_SEAT), 30);
}

#[test]
fn s6_quote_is_added_to_collateral_and_reset_when_base_returns_to_zero() {
    let Perp { mut w, m, a, b, .. } = perp();
    go_long(&mut w, m, a, b, 1_000, 10);
    w.set_price(m, 1_100);

    go_short(&mut w, m, a, b, 1_100, 10);

    assert_eq!(position(&w, a, m), (0, 0));
    assert_eq!(position(&w, b, m), (0, 0));
    assert_eq!(w.collateral(a), RICH - 30 + 1_000 - 33);
    assert_eq!(w.collateral(b), RICH - 1_000);
    assert_eq!(w.collateral(FEE_SEAT), 63);
}

#[test]
fn s6_a_position_can_flip_in_one_order_without_folding_quote() {
    let Perp { mut w, m, a, b, .. } = perp();
    go_long(&mut w, m, a, b, 1_000, 10);

    go_short(&mut w, m, a, b, 1_000, 25);

    assert_eq!(position(&w, a, m), (-15, 15_000));
    assert_eq!(position(&w, b, m), (15, -15_000));
    assert_eq!(w.collateral(a), RICH - 30 - 75);
    assert_eq!(w.collateral(b), RICH);
}

#[test]
fn s6_equity_is_collateral_plus_base_times_mark_plus_quote() {
    let Perp { mut w, m, a, b, .. } = perp();
    go_long(&mut w, m, a, b, 1_000, 10);

    w.set_price(m, 1_100);

    assert_eq!(w.equity(a), i128::from(RICH) - 30 + 11_000 - 10_000);
    assert_eq!(w.equity(b), i128::from(RICH) - 11_000 + 10_000);
}

#[test]
fn s6_initial_margin_uses_worst_case_size_and_maintenance_uses_the_position() {
    let Perp { mut w, m, a, b, .. } = perp();
    go_long(&mut w, m, a, b, 1_000, 10);
    w.set_price(m, 1_100);
    assert_eq!(w.initial_margin(a), 1_100);

    w.place(m, a, limit(Side::Bid, 1_000, 5)).unwrap();
    assert_eq!(w.initial_margin(a), 15 * 1_100 / 10);

    w.place(m, a, limit(Side::Ask, 1_200, 30)).unwrap();
    assert_eq!(w.initial_margin(a), 20 * 1_100 / 10);
    assert_eq!(w.maintenance_margin(a), 10 * 1_100 / 20);
    assert_eq!(w.maintenance_margin(b), 10 * 1_100 / 20);
    assert_eq!(w.initial_margin(b), 10 * 1_100 / 10);
}

#[test]
fn s6_margin_helpers_round_up_to_a_whole_atom() {
    let mut params = perp_params(0);
    params.im_bps = 1_333;
    params.mm_bps = 777;
    let Perp { mut w, m, a, b, .. } = perp_with(params);

    go_long(&mut w, m, a, b, 1_000, 1);

    assert_eq!(w.initial_margin(a), 134);
    assert_eq!(w.maintenance_margin(a), 78);
}

#[test]
fn s6_an_order_needs_equity_for_initial_margin_counting_it_resting_in_full_plus_its_fee() {
    let Perp { mut w, m, .. } = perp();
    let d = funded(&mut w, 1_029);

    assert_eq!(
        w.place(m, d, limit(Side::Bid, 1_000, 10)),
        Err(E::InsufficientMargin)
    );
    assert_eq!(
        w.place(m, d, ioc(Side::Bid, 1_000, 10)),
        Err(E::InsufficientMargin)
    );
    w.deposit(d, Asset::Collateral, 1).unwrap();
    let outcome = w.place(m, d, limit(Side::Bid, 1_000, 10)).unwrap();

    assert_eq!(outcome.rested, 10);
    assert_eq!(w.slot(d, m).open_bid_lots, 10);
    assert_eq!(w.collateral(d), 1_030);
}

#[test]
fn s6_opposite_resting_orders_are_margined_on_the_larger_side_not_the_sum() {
    let Perp { mut w, m, .. } = perp();
    let d = funded(&mut w, 1_031);
    w.place(m, d, limit(Side::Bid, 1_000, 10)).unwrap();

    let opposite = w.place(m, d, limit(Side::Ask, 1_010, 10));
    let one_more = w.place(m, d, limit(Side::Bid, 990, 1));

    assert!(opposite.is_ok());
    assert_eq!(one_more, Err(E::InsufficientMargin));
    assert_eq!(w.initial_margin(d), 1_000);
}

#[test]
fn s6_a_withdrawal_needs_collateral_that_covers_it_and_initial_margin_afterwards() {
    let Perp { mut w, m, a, b, c } = perp();
    go_long(&mut w, m, a, b, 1_000, 10);
    let free = RICH as u64 - 30 - 1_000;

    assert_eq!(
        w.withdraw(a, Asset::Collateral, free + 1),
        Err(E::InsufficientMargin)
    );
    assert_eq!(w.withdraw(a, Asset::Collateral, free), Ok(()));
    assert_eq!(w.collateral(a), 1_000);

    assert_eq!(
        w.withdraw(c, Asset::Collateral, COLLATERAL + 1),
        Err(E::InsufficientCollateral)
    );
    assert_eq!(w.withdraw(c, Asset::Collateral, COLLATERAL), Ok(()));
    assert_eq!(w.withdraw(c, Asset::Collateral, 0), Err(E::ZeroAmount));
}

#[test]
fn s6_unrealised_profit_is_not_withdrawable_beyond_collateral() {
    let Perp { mut w, m, a, b, .. } = perp();
    go_long(&mut w, m, a, b, 1_000, 10);
    w.withdraw(a, Asset::Collateral, RICH as u64 - 30 - 1_000)
        .unwrap();
    w.set_price(m, 1_200);
    assert_eq!(w.equity(a), 3_000);

    assert_eq!(
        w.withdraw(a, Asset::Collateral, 1_001),
        Err(E::InsufficientCollateral)
    );
}

#[test]
fn s4_a_maker_is_checked_as_it_would_be_after_the_fill_not_as_it_rests() {
    let Perp { mut w, m, a, .. } = perp();
    let d = funded(&mut w, 1_030);
    w.place(m, d, limit(Side::Bid, 1_000, 10)).unwrap();
    w.set_price(m, 1_040);
    assert!(w.equity(d) < w.initial_margin(d));

    let outcome = w.place(m, a, ioc(Side::Ask, 1_000, 10)).unwrap();

    assert_eq!(outcome.filled, 10);
    assert_eq!(position(&w, d, m), (10, -10_000));
    assert_eq!(w.slot(d, m).open_bid_lots, 0);
}

#[test]
fn s2_reduce_only_size_is_capped_to_the_position_at_placement() {
    let Perp { mut w, m, a, b, .. } = perp();
    go_long(&mut w, m, a, b, 1_000, 10);
    w.place(m, b, limit(Side::Bid, 1_000, 20)).unwrap();

    let outcome = w
        .place(m, a, reduce_only(ioc(Side::Ask, 1_000, 15)))
        .unwrap();

    assert_eq!(sizes(&outcome), (10, 0, 5));
    assert_eq!(position(&w, a, m), (0, 0));
    assert_eq!(w.markets[m].resting(Side::Bid)[0].remaining, 10);
}

#[test]
fn s2_reduce_only_is_capped_again_at_each_fill_and_never_flips_the_position() {
    let Perp { mut w, m, a, b, c } = perp();
    go_long(&mut w, m, a, b, 1_000, 3);
    w.place(m, b, limit(Side::Bid, 1_000, 2)).unwrap();
    w.place(m, c, limit(Side::Bid, 1_000, 2)).unwrap();

    let outcome = w
        .place(m, a, reduce_only(market(Side::Ask, 950, 10)))
        .unwrap();

    let sizes: Vec<u64> = w.fills.as_slice().iter().map(|f| f.size).collect();
    assert_eq!(sizes, vec![2, 1]);
    assert_eq!((outcome.filled, outcome.cancelled), (3, 7));
    assert_eq!(w.slot(a, m).base, 0);
    assert_eq!(w.markets[m].resting(Side::Bid)[0].remaining, 1);
}

#[test]
fn s2_reduce_only_never_rests() {
    let Perp { mut w, m, a, b, .. } = perp();
    go_long(&mut w, m, a, b, 1_000, 10);

    let outcome = w
        .place(m, a, reduce_only(limit(Side::Ask, 1_010, 5)))
        .unwrap();

    assert_eq!(sizes(&outcome), (0, 0, 5));
    assert!(w.markets[m].resting(Side::Ask).is_empty());
    assert_eq!(w.slot(a, m).open_ask_lots, 0);
}

#[test]
fn s2_reduce_only_that_would_not_shrink_the_position_is_rejected() {
    let Perp { mut w, m, a, b, c } = perp();
    go_long(&mut w, m, a, b, 1_000, 10);

    let same_side = w.place(m, a, reduce_only(ioc(Side::Bid, 1_000, 1)));
    let flat = w.place(m, c, reduce_only(ioc(Side::Ask, 1_000, 1)));
    let resting = w.place(m, a, reduce_only(post_only(Side::Ask, 1_010, 1)));

    assert_eq!(same_side, Err(E::ReduceOnlyWouldIncrease));
    assert_eq!(flat, Err(E::ReduceOnlyWouldIncrease));
    assert_eq!(resting, Err(E::InvalidOrderFlags));
}

#[test]
fn s9_a_stale_feed_blocks_orders_that_increase_exposure_but_not_reduce_only_or_cancels() {
    let Perp { mut w, m, b, .. } = perp();
    let d = funded(&mut w, 1_100);
    go_long(&mut w, m, d, b, 1_000, 10);
    let resting = w.place(m, b, limit(Side::Bid, 950, 10)).unwrap();
    w.set_price(m, 950);
    assert!(w.equity(d) < w.initial_margin(d));
    w.now += 61;

    assert_eq!(w.place(m, d, ioc(Side::Ask, 950, 5)), Err(E::StalePrice));
    assert_eq!(w.place(m, b, limit(Side::Bid, 940, 1)), Err(E::StalePrice));
    let shrinking = w.place(m, d, reduce_only(ioc(Side::Ask, 950, 5))).unwrap();

    assert_eq!(shrinking.filled, 5);
    assert_eq!(w.slot(d, m).base, 5);
    assert_eq!(w.cancel(m, b, seq(&resting)), Ok(()));
}

#[test]
fn s9_a_stale_feed_blocks_withdrawals_only_for_a_trader_with_a_perp_position() {
    let Perp { mut w, m, a, b, c } = perp();
    go_long(&mut w, m, a, b, 1_000, 10);
    w.deposit(a, Asset::Spot(QUOTE), 50).unwrap();
    w.now += 61;

    assert_eq!(w.withdraw(a, Asset::Collateral, 1), Err(E::StalePrice));
    assert_eq!(w.withdraw(a, Asset::Spot(QUOTE), 1), Err(E::StalePrice));
    assert_eq!(w.withdraw(c, Asset::Collateral, 1), Ok(()));
    assert_eq!(w.deposit(a, Asset::Collateral, 1), Ok(()));
}

#[test]
fn s9_a_stale_feed_on_another_market_blocks_decisions_that_depend_on_that_position() {
    let mut w = World::new(10, 8);
    let m0 = w.add_market(perp_params(0));
    let m1 = w.add_market(perp_params(1));
    let a = funded(&mut w, COLLATERAL);
    let b = funded(&mut w, COLLATERAL);
    go_long(&mut w, m1, a, b, 1_000, 10);
    w.now += 61;
    w.set_price(m0, MARK);

    assert_eq!(w.place(m0, a, limit(Side::Bid, 990, 1)), Err(E::StalePrice));
    assert_eq!(w.withdraw(a, Asset::Collateral, 1), Err(E::StalePrice));
    w.set_price(m1, MARK);
    assert!(w.place(m0, a, limit(Side::Bid, 990, 1)).is_ok());
}

#[test]
fn s2_reduce_only_skips_the_margin_check_while_worst_case_size_does_not_grow() {
    let Perp { mut w, m, b, .. } = perp();
    let d = funded(&mut w, 600);
    go_long(&mut w, m, d, b, 1_000, 5);
    w.place(m, d, limit(Side::Ask, 1_100, 8)).unwrap();
    w.place(m, b, limit(Side::Bid, 1_000, 5)).unwrap();
    assert_eq!(w.initial_margin(d), 500);

    let would_leave_bare_asks = w.place(m, d, reduce_only(ioc(Side::Ask, 1_000, 5)));
    assert_eq!(would_leave_bare_asks, Err(E::InsufficientMargin));

    w.cancel_all(m, d, 10).unwrap();
    let outcome = w
        .place(m, d, reduce_only(ioc(Side::Ask, 1_000, 5)))
        .unwrap();
    assert_eq!(outcome.filled, 5);
    assert_eq!(w.collateral(d), 600 - 15 - 15);
}

#[test]
fn s3_7_a_refused_post_only_perp_order_does_not_even_settle_funding() {
    let Perp { mut w, m, a, b, c } = perp();
    go_long(&mut w, m, a, b, 1_000, 10);
    w.place(m, c, limit(Side::Ask, 1_000, 1)).unwrap();
    w.markets[m].book.funding_index = 5;
    let before = w.bytes();

    let outcome = w.place(m, a, post_only(Side::Bid, 1_000, 1)).unwrap();

    assert_eq!(outcome.status, PlaceStatus::RefusedPostOnlyWouldMatch);
    assert!(before == w.bytes());
    assert_eq!(w.slot(a, m).funding_checkpoint, 0);
}

#[test]
fn s3_8_a_perp_remainder_cancelled_on_a_full_side_holds_no_margin() {
    let mut w = World::new(10, 1);
    let m = w.add_market(perp_params(0));
    let a = funded(&mut w, COLLATERAL);
    let b = funded(&mut w, COLLATERAL);
    let c = funded(&mut w, COLLATERAL);
    w.place(m, b, limit(Side::Ask, 1_000, 2)).unwrap();
    w.place(m, c, limit(Side::Bid, 990, 1)).unwrap();

    let outcome = w.place(m, a, limit(Side::Bid, 1_000, 5)).unwrap();

    assert_eq!(outcome.status, PlaceStatus::RemainderCancelledBookFull);
    assert_eq!(sizes(&outcome), (2, 0, 3));
    assert_eq!(position(&w, a, m), (2, -2_000));
    assert_eq!(w.slot(a, m).open_bid_lots, 0);
    assert_eq!(w.initial_margin(a), 200);
    assert_eq!(w.markets[m].resting(Side::Bid)[0].seat, c);
}

#[test]
fn s3_a_perp_error_never_depends_on_what_the_book_holds() {
    let orders = [
        reduce_only(ioc(Side::Ask, 1_000, 5)),
        reduce_only(market(Side::Ask, 900, 2)),
        limit(Side::Bid, 1_000, 1),
        limit(Side::Bid, 1_000, 100),
        post_only(Side::Ask, 990, 100),
        ioc(Side::Ask, 990, 3),
    ];
    for new_order in orders {
        let mut verdicts = Vec::new();
        for book_is_loaded in [false, true] {
            let Perp { mut w, m, b, c, .. } = perp();
            let d = funded(&mut w, 600);
            go_long(&mut w, m, d, b, 1_000, 5);
            w.place(m, d, limit(Side::Ask, 1_100, 8)).unwrap();
            if book_is_loaded {
                w.place(m, b, limit(Side::Bid, 1_000, 5)).unwrap();
                w.place(m, c, limit(Side::Bid, 990, 5)).unwrap();
                w.place(m, c, limit(Side::Ask, 1_010, 5)).unwrap();
            }
            verdicts.push(w.place(m, d, new_order).err());
        }
        assert_eq!(verdicts[0], verdicts[1], "{new_order:?}");
    }
}

#[test]
fn s3_1_a_reduce_only_market_accepts_only_orders_that_shrink_a_position_and_cancels() {
    let Perp { mut w, m, a, b, .. } = perp();
    go_long(&mut w, m, a, b, 1_000, 10);
    let resting = w.place(m, b, limit(Side::Bid, 1_000, 4)).unwrap();
    let other = w.place(m, b, limit(Side::Bid, 990, 4)).unwrap();
    w.markets[m].params.status = STATUS_REDUCE_ONLY;

    assert_eq!(
        w.place(m, a, limit(Side::Bid, 990, 1)),
        Err(E::MarketReduceOnly)
    );
    assert_eq!(
        w.place(m, a, ioc(Side::Ask, 1_000, 1)),
        Err(E::MarketReduceOnly)
    );
    let shrinking = w
        .place(m, a, reduce_only(ioc(Side::Ask, 1_000, 4)))
        .unwrap();

    assert_eq!(shrinking.filled, 4);
    assert_eq!(w.slot(a, m).base, 6);
    assert_eq!(w.cancel(m, b, seq(&resting)), Err(E::OrderNotFound));
    assert_eq!(w.cancel(m, b, seq(&other)), Ok(()));
}

#[test]
fn s7_update_funding_does_nothing_until_the_interval_has_passed() {
    let Perp { mut w, m, a, b, .. } = perp();
    go_long(&mut w, m, a, b, 1_010, 1);

    advance(&mut w, m, 3_599);
    assert_eq!(w.fund(m), Ok(false));
    assert_eq!(w.markets[m].book.funding_index, 0);
    assert_eq!(w.markets[m].book.last_funding_time, START);

    advance(&mut w, m, 1);
    assert_eq!(w.fund(m), Ok(true));
    assert_eq!(w.markets[m].book.funding_index, 5);
    assert_eq!(w.markets[m].book.last_funding_time, START + 3_600);
}

#[test]
fn s7_exactly_one_interval_is_applied_and_missed_intervals_are_not_caught_up() {
    let Perp { mut w, m, a, b, .. } = perp();
    go_long(&mut w, m, a, b, 1_010, 1);

    advance(&mut w, m, 3 * 3_600 + 7);

    assert_eq!(w.fund(m), Ok(true));
    assert_eq!(w.markets[m].book.funding_index, 5);
    assert_eq!(w.markets[m].book.last_funding_time, w.now);
    assert_eq!(w.fund(m), Ok(false));
    assert_eq!(w.markets[m].book.funding_index, 5);
}

#[test]
fn s7_the_rate_is_the_traded_premium_clamped_to_the_cap_and_rounded_toward_zero() {
    let cases: [(&[(u64, u64)], i64); 11] = [
        (&[(1_010, 1)], 5),
        (&[(990, 1)], -5),
        (&[(1_005, 2)], 5),
        (&[(995, 2)], -5),
        (&[(1_003, 1)], 3),
        (&[(998, 4)], -2),
        (&[(1_001, 1), (1_004, 2)], 3),
        (&[(1_001, 1), (1_000, 1)], 0),
        (&[(999, 1), (1_000, 1)], 0),
        (&[(1_003, 1), (1_000, 1)], 1),
        (&[(997, 1), (1_000, 1)], -1),
    ];
    for (trades, expected) in cases {
        let mut params = perp_params(0);
        params.tick = 1;
        let Perp { mut w, m, a, b, .. } = perp_with(params);
        for (price, size) in trades {
            go_long(&mut w, m, a, b, *price, *size);
        }
        advance(&mut w, m, 3_600);

        assert_eq!(w.fund(m), Ok(true));

        assert_eq!(w.markets[m].book.funding_index, expected, "{trades:?}");
    }
}

#[test]
fn s7_the_premium_is_zero_when_nothing_traded_and_the_interval_is_still_consumed() {
    let Perp { mut w, m, a, b, c } = perp();
    go_long(&mut w, m, a, b, 1_010, 1);
    advance(&mut w, m, 3_600);
    assert_eq!(w.fund(m), Ok(true));
    w.place(m, c, limit(Side::Bid, 1_040, 1)).unwrap();
    advance(&mut w, m, 3_600);

    assert_eq!(w.fund(m), Ok(true));

    assert_eq!(w.markets[m].book.funding_index, 5);
    assert_eq!(w.markets[m].book.last_funding_time, w.now);
    assert_eq!(w.fund(m), Ok(false));
}

#[test]
fn s7_update_funding_is_refused_on_a_stale_feed_a_paused_market_and_a_spot_market() {
    let Perp { mut w, m, .. } = perp();
    let spot_market = w.add_market(spot_params(1));
    assert_eq!(w.fund(spot_market), Err(E::NotPerpMarket));

    w.now += 3_600;
    assert_eq!(w.fund(m), Err(E::StalePrice));
    w.set_price(m, MARK);
    w.markets[m].params.status = STATUS_PAUSED;
    assert_eq!(w.fund(m), Err(E::MarketPaused));
    w.markets[m].params.status = STATUS_ACTIVE;
    w.paused = true;
    assert_eq!(w.fund(m), Err(E::ExchangePaused));
    w.paused = false;
    assert_eq!(w.fund(m), Ok(true));
}

#[test]
fn s7_longs_pay_and_shorts_receive_when_the_index_rose() {
    let Perp { mut w, m, a, b, .. } = perp();
    go_long(&mut w, m, a, b, 1_000, 10);
    let equity_before = (w.equity(a), w.equity(b));

    w.markets[m].book.funding_index = 5;
    w.check_invariants();

    assert_eq!(w.equity(a), equity_before.0 - 50);
    assert_eq!(w.equity(b), equity_before.1 + 50);
    w.withdraw(a, Asset::Collateral, 1).unwrap();
    w.withdraw(b, Asset::Collateral, 1).unwrap();
    assert_eq!(position(&w, a, m), (10, -10_050));
    assert_eq!(position(&w, b, m), (-10, 10_050));
    assert_eq!(w.slot(a, m).funding_checkpoint, 5);
    assert_eq!(w.equity(a), equity_before.0 - 50 - 1);
}

#[test]
fn s7_longs_receive_and_shorts_pay_when_the_index_fell() {
    let Perp { mut w, m, a, b, .. } = perp();
    go_long(&mut w, m, a, b, 1_000, 10);

    w.markets[m].book.funding_index = -3;
    w.withdraw(a, Asset::Collateral, 1).unwrap();
    w.withdraw(b, Asset::Collateral, 1).unwrap();

    assert_eq!(position(&w, a, m), (10, -9_970));
    assert_eq!(position(&w, b, m), (-10, 9_970));
}

#[test]
fn s7_funding_is_paid_once_per_seat_checkpoint() {
    let Perp { mut w, m, a, b, .. } = perp();
    go_long(&mut w, m, a, b, 1_000, 10);
    w.markets[m].book.funding_index = 5;

    w.withdraw(a, Asset::Collateral, 1).unwrap();
    w.withdraw(a, Asset::Collateral, 1).unwrap();
    w.place(m, a, limit(Side::Bid, 990, 1)).unwrap();

    assert_eq!(position(&w, a, m), (10, -10_050));
}

#[test]
fn s7_funding_keeps_the_right_sign_across_a_position_flip() {
    let Perp { mut w, m, a, b, .. } = perp();
    go_long(&mut w, m, a, b, 1_000, 10);
    w.markets[m].book.funding_index = 5;

    go_short(&mut w, m, a, b, 1_000, 25);

    assert_eq!(position(&w, a, m), (-15, -10_050 + 25_000));
    assert_eq!(position(&w, b, m), (15, 10_050 - 25_000));
    assert_eq!(w.slot(a, m).funding_checkpoint, 5);
    assert_eq!(w.slot(b, m).funding_checkpoint, 5);

    w.markets[m].book.funding_index = 8;
    w.withdraw(a, Asset::Collateral, 1).unwrap();
    w.withdraw(b, Asset::Collateral, 1).unwrap();

    assert_eq!(position(&w, a, m), (-15, 14_950 + 45));
    assert_eq!(position(&w, b, m), (15, -14_950 - 45));
}

#[test]
fn s7_a_new_position_starts_at_the_current_index_and_owes_nothing_for_the_past() {
    let Perp { mut w, m, a, b, .. } = perp();
    w.markets[m].book.funding_index = 5;

    go_long(&mut w, m, a, b, 1_000, 10);

    assert_eq!(position(&w, a, m), (10, -10_000));
    assert_eq!(w.slot(a, m).funding_checkpoint, 5);
    assert_eq!(w.slot(b, m).funding_checkpoint, 5);
}

#[test]
fn s7_funding_sums_to_zero_across_all_seats() {
    let Perp { mut w, m, a, b, c } = perp();
    go_long(&mut w, m, a, b, 1_000, 10);
    go_long(&mut w, m, c, b, 1_000, 7);
    let total_before = w.equity(a) + w.equity(b) + w.equity(c);

    w.markets[m].book.funding_index = 13;
    for trader in [a, b, c] {
        w.deposit(trader, Asset::Collateral, 1).unwrap();
        w.withdraw(trader, Asset::Collateral, 1).unwrap();
    }

    assert_eq!(w.equity(a) + w.equity(b) + w.equity(c), total_before);
    assert_eq!(w.slot(b, m).quote, 17_000 + 17 * 13);
}

/// A trader with 1,070 of collateral left who is long 10 lots from 1,000.
fn thin_long(w: &mut World, m: usize, maker: u32) -> u32 {
    let d = funded(w, 1_100);
    go_long(w, m, d, maker, 1_000, 10);
    assert_eq!(w.collateral(d), 1_070);
    d
}

/// A trader with 1,070 of collateral left who is short 10 lots from 1,000.
fn thin_short(w: &mut World, m: usize, maker: u32) -> u32 {
    let d = funded(w, 1_100);
    go_short(w, m, d, maker, 1_000, 10);
    assert_eq!(w.collateral(d), 1_070);
    d
}

#[test]
fn s8_a_trader_at_or_above_maintenance_margin_cannot_be_liquidated() {
    let Perp { mut w, m, b, c, .. } = perp();
    let d = thin_long(&mut w, m, b);
    w.set_price(m, 940);
    assert_eq!(w.equity(d), 470);
    assert_eq!(w.maintenance_margin(d), 470);

    assert!(!w.is_liquidatable(d, m));
    let outcome = w.liquidate(m, c, d, 1).unwrap();
    assert_eq!(outcome.status, LiquidationStatus::NotLiquidatable);
    assert_eq!(w.slot(d, m).base, 10);
}

#[test]
fn s8_liquidation_needs_a_fresh_price() {
    let Perp { mut w, m, b, c, .. } = perp();
    let d = thin_long(&mut w, m, b);
    w.set_price(m, 930);
    assert!(w.is_liquidatable(d, m));

    w.now += 301;

    assert!(!w.is_liquidatable(d, m));
    let outcome = w.liquidate(m, c, d, 1).unwrap();
    assert_eq!(outcome.status, LiquidationStatus::StalePrice);
    assert_eq!(w.slot(d, m).base, 10);
}

#[test]
fn s9_liquidation_tolerates_a_feed_too_old_for_new_orders_up_to_max_age_liquidation() {
    let Perp { mut w, m, b, c, .. } = perp();
    let d = thin_long(&mut w, m, b);
    w.set_price(m, 930);

    w.now += 300;

    assert_eq!(w.place(m, c, limit(Side::Bid, 900, 1)), Err(E::StalePrice));
    assert!(w.is_liquidatable(d, m));
    let outcome = w.liquidate(m, c, d, 1).unwrap();
    assert_eq!(outcome.status, LiquidationStatus::Liquidated);
}

#[test]
fn s8_a_long_is_taken_over_at_mark_less_the_penalty_up_to_the_requested_size() {
    let Perp { mut w, m, b, c, .. } = perp();
    let d = thin_long(&mut w, m, b);
    w.set_price(m, 930);
    let liquidator_equity = w.equity(c);

    let outcome = w.liquidate(m, c, d, 2).unwrap();

    assert_eq!(
        outcome,
        LiquidationOutcome {
            status: LiquidationStatus::Liquidated,
            liquidated: 2,
            price: 920,
            orders_cancelled: 0,
            penalty_to_insurance: 0,
            insurance_paid: 0,
            uncovered: 0,
        }
    );
    assert_eq!(position(&w, d, m), (8, -10_000 + 2 * 920));
    assert_eq!(position(&w, c, m), (2, -2 * 920));
    assert_eq!(w.equity(c), liquidator_equity + 2 * 10);
    assert_eq!(w.collateral(d), 1_070);
}

#[test]
fn s8_a_short_is_taken_over_at_mark_plus_the_penalty() {
    let Perp { mut w, m, b, c, .. } = perp();
    let d = thin_short(&mut w, m, b);
    w.set_price(m, 1_070);
    assert_eq!(w.equity(d), 370);
    let liquidator_equity = w.equity(c);

    let outcome = w.liquidate(m, c, d, 4).unwrap();

    assert_eq!((outcome.liquidated, outcome.price), (4, 1_081));
    assert_eq!(position(&w, d, m), (-6, 10_000 - 4 * 1_081));
    assert_eq!(position(&w, c, m), (-4, 4 * 1_081));
    assert_eq!(w.equity(c), liquidator_equity + 4 * 11);
}

#[test]
fn s8_the_size_is_capped_to_the_position() {
    let Perp { mut w, m, b, c, .. } = perp();
    w.deposit(INSURANCE_SEAT, Asset::Collateral, 100).unwrap();
    let d = thin_long(&mut w, m, b);
    w.set_price(m, 900);
    assert_eq!(w.equity(d), 70);

    let outcome = w.liquidate(m, c, d, u64::MAX).unwrap();

    assert_eq!((outcome.liquidated, outcome.price), (10, 891));
    assert_eq!((outcome.insurance_paid, outcome.uncovered), (20, 0));
    assert_eq!(position(&w, d, m), (0, 0));
    assert_eq!(w.collateral(d), 0);
    assert_eq!(w.slot(c, m).base, 10);
    assert_eq!(w.markets[m].params.status, STATUS_ACTIVE);
}

#[test]
fn s8_liquidation_first_cancels_every_open_order_of_the_target_on_that_market() {
    let Perp { mut w, m, b, c, .. } = perp();
    let d = funded(&mut w, 2_000);
    go_long(&mut w, m, d, b, 1_000, 10);
    w.place(m, d, limit(Side::Bid, 900, 5)).unwrap();
    w.place(m, c, limit(Side::Bid, 890, 1)).unwrap();
    w.set_price(m, 840);
    assert!(w.is_liquidatable(d, m));

    let outcome = w.liquidate(m, c, d, 1).unwrap();

    assert_eq!(outcome.orders_cancelled, 1);
    assert_eq!(w.slot(d, m).open_bid_lots, 0);
    assert_eq!(w.seat(d).open_orders[m], 0);
    let bids = w.markets[m].resting(Side::Bid);
    assert_eq!(bids.len(), 1);
    assert_eq!(bids[0].seat, c);
}

#[test]
fn s8_the_liquidator_must_meet_initial_margin_afterwards() {
    let Perp { mut w, m, b, .. } = perp();
    let d = thin_long(&mut w, m, b);
    w.set_price(m, 930);
    let poor = funded(&mut w, 100);

    let too_much = w.liquidate(m, poor, d, 10).unwrap();
    let short_of_margin = LiquidationStatus::LiquidatorMarginInsufficient;
    assert_eq!(too_much.status, short_of_margin);
    assert_eq!(w.slot(d, m).base, 10);

    let one_lot = w.liquidate(m, poor, d, 1).unwrap();
    assert_eq!((one_lot.liquidated, one_lot.price), (1, 920));
    assert_eq!(w.equity(poor), 100 + 10);
    assert_eq!(w.initial_margin(poor), 93);
}

#[test]
fn s8_self_liquidation_and_a_market_without_a_position_are_refused() {
    let mut w = World::new(10, 8);
    let m0 = w.add_market(perp_params(0));
    let m1 = w.add_market(perp_params(1));
    let b = funded(&mut w, COLLATERAL);
    let c = funded(&mut w, COLLATERAL);
    let d = thin_long(&mut w, m0, b);
    w.set_price(m0, 930);

    assert_eq!(w.liquidate(m0, d, d, 1), Err(E::SelfLiquidation));
    assert_eq!(w.liquidate(m0, c, d, 0), Err(E::ZeroAmount));
    let elsewhere = w.liquidate(m1, c, d, 1).unwrap();
    assert_eq!(elsewhere.status, LiquidationStatus::NoPosition);
    let nobody = w.liquidate(m0, c, 99, 1).unwrap();
    assert_eq!(nobody.status, LiquidationStatus::TargetSeatNotOpen);
}

#[test]
fn s8_liquidation_is_refused_on_a_spot_market_and_while_paused() {
    let Perp { mut w, m, b, c, .. } = perp();
    let spot_market = w.add_market(spot_params(1));
    let d = thin_long(&mut w, m, b);
    w.set_price(m, 930);

    assert_eq!(w.liquidate(spot_market, c, d, 1), Err(E::NotPerpMarket));
    w.paused = true;
    assert_eq!(w.liquidate(m, c, d, 1), Err(E::ExchangePaused));
    w.paused = false;
    w.markets[m].params.status = STATUS_PAUSED;
    assert_eq!(w.liquidate(m, c, d, 1), Err(E::MarketPaused));
}

#[test]
fn s8_a_flat_target_with_negative_equity_is_covered_by_the_insurance_seat() {
    let Perp { mut w, m, b, c, .. } = perp();
    w.deposit(INSURANCE_SEAT, Asset::Collateral, 1_000).unwrap();
    let d = thin_long(&mut w, m, b);
    w.set_price(m, 850);
    assert_eq!(w.equity(d), -430);

    let outcome = w.liquidate(m, c, d, 10).unwrap();

    assert_eq!(outcome.price, 841);
    assert_eq!((outcome.insurance_paid, outcome.uncovered), (520, 0));
    assert_eq!(w.collateral(d), 0);
    assert_eq!(w.collateral(INSURANCE_SEAT), 480);
    assert_eq!(w.markets[m].params.status, STATUS_ACTIVE);
    assert_eq!(w.markets[m].params.uncovered_shortfall, 0);
}

#[test]
fn s8_no_shortfall_is_settled_while_the_target_still_holds_a_position() {
    let Perp { mut w, m, b, c, .. } = perp();
    w.deposit(INSURANCE_SEAT, Asset::Collateral, 1_000).unwrap();
    let d = thin_long(&mut w, m, b);
    w.set_price(m, 850);

    let outcome = w.liquidate(m, c, d, 4).unwrap();

    assert_eq!((outcome.insurance_paid, outcome.uncovered), (0, 0));
    assert_eq!(w.collateral(INSURANCE_SEAT), 1_000);
    assert_eq!(w.slot(d, m).base, 6);
}

#[test]
fn s8_exhausted_insurance_puts_the_market_in_reduce_only_and_records_the_uncovered_amount() {
    let Perp { mut w, m, b, c, .. } = perp();
    w.deposit(INSURANCE_SEAT, Asset::Collateral, 200).unwrap();
    let d = thin_long(&mut w, m, b);
    let resting = w.place(m, b, limit(Side::Bid, 810, 3)).unwrap();
    w.set_price(m, 850);

    let outcome = w.liquidate(m, c, d, 10).unwrap();

    assert_eq!((outcome.insurance_paid, outcome.uncovered), (200, 320));
    assert_eq!(w.collateral(INSURANCE_SEAT), 0);
    assert_eq!(w.collateral(d), -320);
    assert_eq!(w.markets[m].params.uncovered_shortfall, 320);
    assert_eq!(w.markets[m].params.status, STATUS_REDUCE_ONLY);

    assert_eq!(
        w.place(m, c, limit(Side::Bid, 840, 1)),
        Err(E::MarketReduceOnly)
    );
    let shrinking = w.place(m, c, reduce_only(ioc(Side::Ask, 810, 2))).unwrap();
    assert_eq!(shrinking.filled, 2);
    assert_eq!(w.cancel(m, b, seq(&resting)), Ok(()));
    assert_eq!(
        w.withdraw(d, Asset::Collateral, 1),
        Err(E::ShortfallOutstanding)
    );
    assert_eq!(w.close(d), Err(E::SeatNotEmpty));
}

#[test]
fn s8_a_second_uncovered_shortfall_adds_to_the_recorded_amount() {
    let Perp { mut w, m, b, c, .. } = perp();
    let first = thin_long(&mut w, m, b);
    let second = thin_long(&mut w, m, b);
    w.set_price(m, 850);

    w.liquidate(m, c, first, 10).unwrap();
    w.liquidate(m, c, second, 10).unwrap();

    assert_eq!(w.markets[m].params.uncovered_shortfall, 1_040);
    assert_eq!(w.collateral(first), -520);
    assert_eq!(w.collateral(second), -520);
}

#[test]
fn s9_publish_time_must_be_later_than_the_previous_one() {
    let Perp { mut w, m, .. } = perp();
    w.now += 10;
    let earlier = w.publish(m, 1_010, START - 1);
    let same = w.publish(m, 1_010, START);

    assert_eq!(earlier, Err(E::PriceTimeWentBackwards));
    assert_eq!(same, Err(E::PriceTimeWentBackwards));
    assert_eq!(w.publish(m, 1_020, START + 5), Ok(()));
    assert_eq!(w.markets[m].price.price, 1_020);
    assert_eq!(w.markets[m].price.publish_time, START + 5);
}

#[test]
fn s9_a_price_that_moves_more_than_max_move_bps_is_rejected() {
    let Perp { mut w, m, .. } = perp();
    w.now += 10;

    assert_eq!(w.publish(m, 1_031, START + 1), Err(E::PriceMoveTooLarge));
    assert_eq!(w.publish(m, 969, START + 1), Err(E::PriceMoveTooLarge));
    assert_eq!(w.publish(m, 0, START + 1), Err(E::ZeroPrice));
    assert_eq!(w.publish(m, 1_030, START + 1), Ok(()));
    assert_eq!(w.publish(m, 1_000, START + 2), Ok(()));
}

#[test]
fn s9_the_first_price_of_a_feed_is_accepted_as_published() {
    let mut params = perp_params(0);
    params.min_publish_gap = 30;
    let mut feed = Price {
        price: 0,
        publish_time: 0,
    };

    assert_eq!(publish_price(&mut feed, &params, 123_450, 77, 77), Ok(()));
    assert_eq!(
        reset_price(&mut feed, &mut params, 0, 78),
        Err(E::ZeroPrice)
    );
    assert_eq!(feed.price, 123_450);
    assert_eq!(params.status, STATUS_ACTIVE);
}

#[test]
fn s3_4_an_order_on_a_market_that_never_had_a_price_is_rejected() {
    let Perp { mut w, m, a, .. } = perp();
    w.markets[m].price.price = 0;

    assert_eq!(
        w.place(m, a, limit(Side::Bid, 1_000, 1)),
        Err(E::PriceUnavailable)
    );
}

//! One test per finding of the security review, each built from the reviewer's
//! reproducing sequence, in the order of the review.

mod common;

use common::*;
use noirwire_orderbook_engine::EngineError as E;
use noirwire_orderbook_engine::*;

fn free_perp() -> MarketParams {
    let mut params = perp_params(0);
    params.taker_fee_bps = 0;
    params
}

fn perp_world(params: MarketParams) -> (World, usize) {
    let mut w = World::new(10, 8);
    let m = w.add_market(params);
    (w, m)
}

fn funded(w: &mut World, collateral: u64) -> u32 {
    let trader = w.open();
    w.deposit(trader, Asset::Collateral, collateral).unwrap();
    trader
}

fn buy_from(w: &mut World, m: usize, buyer: u32, seller: u32, price: u64, size: u64) {
    w.place(m, seller, limit(Side::Ask, price, size)).unwrap();
    let outcome = w.place(m, buyer, ioc(Side::Bid, price, size)).unwrap();
    assert_eq!(outcome.filled, size);
}

#[test]
fn finding_1_a_fill_cannot_leave_the_taker_owing_more_than_it_has() {
    let (mut w, m) = perp_world(free_perp());
    let a = funded(&mut w, 100);
    let b = funded(&mut w, 100);
    let bystander = funded(&mut w, 100);
    buy_from(&mut w, m, b, a, 1_000, 1);
    w.place(m, a, limit(Side::Bid, 800, 1)).unwrap();
    let as_reported = w.place(m, b, reduce_only(ioc(Side::Ask, 800, 1)));
    assert_eq!(as_reported, Err(E::PriceOutsideBand));
    w.set_price(m, 840);

    let outcome = w.place(m, b, reduce_only(ioc(Side::Ask, 800, 1))).unwrap();

    assert_eq!(outcome.status, PlaceStatus::RemainderCancelledFillCheck);
    assert_eq!(sizes(&outcome), (0, 0, 1));
    assert!(w.fills.as_slice().is_empty());
    assert_eq!((w.collateral(a), w.collateral(b)), (100, 100));
    assert_eq!(w.slot(b, m).base, 1);
    assert_eq!(w.markets[m].resting(Side::Bid).len(), 1);
    assert_eq!(
        w.withdraw(a, Asset::Collateral, 300),
        Err(E::InsufficientCollateral)
    );
    assert_eq!(w.withdraw(bystander, Asset::Collateral, 100), Ok(()));
    assert_eq!(w.custody_collateral, 200);
}

#[test]
fn finding_1_the_same_sale_at_a_price_the_taker_can_afford_goes_through() {
    let (mut w, m) = perp_world(free_perp());
    let a = funded(&mut w, 100);
    let b = funded(&mut w, 100);
    buy_from(&mut w, m, b, a, 1_000, 1);
    w.place(m, a, limit(Side::Bid, 960, 1)).unwrap();

    let outcome = w.place(m, b, reduce_only(ioc(Side::Ask, 960, 1))).unwrap();

    assert_eq!(outcome.status, PlaceStatus::Filled);
    assert_eq!((w.collateral(a), w.collateral(b)), (140, 60));
}

#[test]
fn finding_2_a_fill_that_grows_the_takers_position_needs_initial_margin_at_the_fill_price() {
    let (mut w, m) = perp_world(free_perp());
    let taker = funded(&mut w, 100);
    let as_reported = w.place(m, taker, ioc(Side::Bid, 1_200, 1));
    assert_eq!(as_reported, Err(E::PriceOutsideBand));

    for (collateral, filled) in [(100, 0), (149, 0), (150, 1)] {
        let (mut w, m) = perp_world(free_perp());
        let maker = funded(&mut w, 100_000);
        let taker = funded(&mut w, collateral);
        w.place(m, maker, limit(Side::Ask, 1_050, 1)).unwrap();

        let outcome = w.place(m, taker, ioc(Side::Bid, 1_050, 1)).unwrap();

        assert_eq!(outcome.filled, filled, "collateral {collateral}");
        assert!(w.equity(taker) >= 0);
        if filled == 0 {
            assert_eq!(outcome.status, PlaceStatus::RemainderCancelledFillCheck);
            assert_eq!(w.collateral(taker), collateral as i64);
            assert_eq!(w.markets[m].resting(Side::Ask).len(), 1);
        } else {
            assert_eq!(w.equity(taker), w.initial_margin(taker));
        }
    }
}

#[test]
fn finding_2_a_limit_order_stopped_by_the_fill_check_never_rests_its_remainder() {
    let (mut w, m) = perp_world(free_perp());
    let maker = funded(&mut w, 100_000);
    let taker = funded(&mut w, 240);
    w.place(m, maker, limit(Side::Ask, 1_000, 1)).unwrap();
    w.place(m, maker, limit(Side::Ask, 1_050, 1)).unwrap();

    let outcome = w.place(m, taker, limit(Side::Bid, 1_050, 2)).unwrap();

    assert_eq!(outcome.status, PlaceStatus::RemainderCancelledFillCheck);
    assert_eq!(sizes(&outcome), (1, 0, 1));
    assert!(!outcome.truncated);
    assert_eq!(w.slot(taker, m).open_bid_lots, 0);
    assert!(w.markets[m].resting(Side::Bid).is_empty());
}

#[test]
fn finding_3_a_resting_order_outside_the_band_of_the_current_mark_is_cancelled_not_filled() {
    let (mut w, m) = perp_world(free_perp());
    let a = funded(&mut w, 100_000);
    let b = funded(&mut w, 100_000);
    let as_reported = w.place(m, a, limit(Side::Bid, 1_200, 1));
    assert_eq!(as_reported, Err(E::PriceOutsideBand));
    w.place(m, a, limit(Side::Bid, 1_040, 1)).unwrap();
    w.set_price(m, 950);

    let outcome = w.place(m, b, ioc(Side::Ask, 950, 1)).unwrap();

    assert_eq!(outcome.status, PlaceStatus::RemainderCancelled);
    assert_eq!(sizes(&outcome), (0, 0, 1));
    assert!(w.markets[m].resting(Side::Bid).is_empty());
    assert_eq!(w.slot(a, m).open_bid_lots, 0);
    assert_eq!(w.seat(a).open_orders[m], 0);
    assert_eq!((w.slot(a, m).base, w.slot(b, m).base), (0, 0));
}

#[test]
fn finding_3_a_stale_spot_order_outside_the_band_is_cancelled_and_its_lock_returned() {
    let mut w = World::new(8, 8);
    let m = w.add_market(spot_params(0));
    let a = w.open();
    let b = w.open();
    w.deposit(a, Asset::Spot(QUOTE), 10_000).unwrap();
    w.deposit(b, Asset::Spot(BASE), 1_000).unwrap();
    w.place(m, a, limit(Side::Bid, 1_200, 1)).unwrap();
    w.place(m, a, limit(Side::Bid, 900, 1)).unwrap();
    w.set_price(m, 800);

    let outcome = w.place(m, b, ioc(Side::Ask, 800, 2)).unwrap();

    assert_eq!(sizes(&outcome), (1, 0, 1));
    assert_eq!(w.fills.as_slice()[0].price, 900);
    assert_eq!(w.spot(a, QUOTE).locked, 0);
    assert_eq!(w.spot(a, QUOTE).available, 10_000 - 900);
}

#[test]
fn finding_3_a_maker_that_would_fail_its_check_is_cancelled_and_matching_continues() {
    let (mut w, m) = perp_world(free_perp());
    let thin = funded(&mut w, 100);
    let solid = funded(&mut w, 100_000);
    let seller = funded(&mut w, 100_000);
    w.place(m, thin, limit(Side::Bid, 990, 1)).unwrap();
    w.place(m, solid, limit(Side::Bid, 980, 1)).unwrap();
    w.set_price(m, 945);
    w.max_steps = 2;

    let outcome = w.place(m, seller, ioc(Side::Ask, 940, 1)).unwrap();

    assert_eq!(outcome.status, PlaceStatus::Filled);
    let fill = w.fills.as_slice()[0];
    assert_eq!((fill.price, fill.maker_seat), (980, solid));
    assert_eq!(w.slot(thin, m).base, 0);
    assert_eq!(w.slot(thin, m).open_bid_lots, 0);
    assert_eq!(w.seat(thin).open_orders[m], 0);
    assert_eq!(w.collateral(thin), 100);
}

#[test]
fn finding_3_each_cancelled_maker_counts_as_one_step() {
    let (mut w, m) = perp_world(free_perp());
    let thin = funded(&mut w, 100);
    let solid = funded(&mut w, 100_000);
    let seller = funded(&mut w, 100_000);
    w.place(m, thin, limit(Side::Bid, 990, 1)).unwrap();
    w.place(m, solid, limit(Side::Bid, 980, 1)).unwrap();
    w.set_price(m, 945);
    w.max_steps = 1;

    let outcome = w.place(m, seller, ioc(Side::Ask, 940, 1)).unwrap();

    assert_eq!(outcome.status, PlaceStatus::RemainderCancelledStepLimit);
    assert_eq!(outcome.filled, 0);
    assert_eq!(w.markets[m].resting(Side::Bid).len(), 1);
}

#[test]
fn finding_3_a_maker_growing_its_position_needs_the_midpoint_of_the_two_margins() {
    for (collateral, filled) in [(115, 0), (116, 1)] {
        let (mut w, m) = perp_world(free_perp());
        let maker = funded(&mut w, 1_000);
        let seller = funded(&mut w, 100_000);
        w.place(m, maker, limit(Side::Bid, 990, 1)).unwrap();
        w.withdraw(maker, Asset::Collateral, 1_000 - collateral)
            .unwrap();
        w.set_price(m, 945);

        let outcome = w.place(m, seller, ioc(Side::Ask, 940, 1)).unwrap();

        assert_eq!(outcome.filled, filled, "collateral {collateral}");
    }
}

#[test]
fn finding_4_a_price_must_wait_for_the_publish_gap_and_cannot_come_from_the_future() {
    let mut params = perp_params(0);
    params.min_publish_gap = 5;
    let (mut w, m) = perp_world(params);
    w.now = START + 100;

    assert_eq!(w.publish(m, 1_010, START), Err(E::PriceTimeWentBackwards));
    let too_soon = Err(E::PricePublishedTooSoon);
    assert_eq!(w.publish(m, 1_010, START + 4), too_soon);
    assert_eq!(w.publish(m, 1_010, START + 101), Err(E::PriceFromTheFuture));
    assert_eq!(w.publish(m, 1_010, START + 5), Ok(()));
    assert_eq!(w.publish(m, 1_020, START + 9), too_soon);
    assert_eq!(w.publish(m, 1_020, START + 100), Ok(()));
    assert_eq!(w.markets[m].price.price, 1_020);
}

#[test]
fn finding_4_a_reset_puts_the_market_in_reduce_only_until_the_admin_resumes_it() {
    let (mut w, m) = perp_world(perp_params(0));
    let a = funded(&mut w, 100_000);

    assert_eq!(w.reset(m, 5_000, START), Ok(()));

    assert_eq!(w.markets[m].price.price, 5_000);
    assert_eq!(w.markets[m].params.status, STATUS_REDUCE_ONLY);
    assert_eq!(
        w.place(m, a, limit(Side::Bid, 5_000, 1)),
        Err(E::MarketReduceOnly)
    );
    assert_eq!(w.resume(m), Ok(()));
    assert_eq!(w.markets[m].params.status, STATUS_ACTIVE);
    assert!(w.place(m, a, limit(Side::Bid, 5_000, 1)).is_ok());
    assert_eq!(w.reset(m, 0, START), Err(E::ZeroPrice));
}

#[test]
fn finding_5_resting_quotes_that_never_trade_do_not_move_funding() {
    let (mut w, m) = perp_world(perp_params(0));
    let a = funded(&mut w, 100_000);
    w.place(m, a, limit(Side::Bid, 1_040, 1)).unwrap();
    w.place(m, a, limit(Side::Ask, 1_200, 1)).unwrap();
    w.now += 3_600;
    w.set_price(m, MARK);

    assert_eq!(w.fund(m), Ok(true));

    assert_eq!(w.markets[m].book.funding_index, 0);
    assert_eq!(w.markets[m].book.last_funding_time, w.now);
}

#[test]
fn finding_5_funding_follows_the_size_weighted_price_of_fills_since_the_last_update() {
    let (mut w, m) = perp_world(perp_params(0));
    let a = funded(&mut w, 100_000);
    let b = funded(&mut w, 100_000);
    buy_from(&mut w, m, a, b, 1_000, 3);
    buy_from(&mut w, m, a, b, 1_010, 1);
    assert_eq!(w.markets[m].book.traded_notional, 4_010);
    assert_eq!(w.markets[m].book.traded_size, 4);
    w.now += 3_600;
    w.set_price(m, MARK);

    assert_eq!(w.fund(m), Ok(true));

    assert_eq!(w.markets[m].book.funding_index, 2);
    assert_eq!(w.markets[m].book.traded_notional, 0);
    assert_eq!(w.markets[m].book.traded_size, 0);
    w.now += 3_600;
    w.set_price(m, MARK);
    assert_eq!(w.fund(m), Ok(true));
    assert_eq!(w.markets[m].book.funding_index, 2);
}

#[test]
fn finding_6_a_blind_liquidation_that_finds_nothing_succeeds_and_changes_nothing() {
    let mut w = World::new(10, 8);
    let m0 = w.add_market(perp_params(0));
    let m1 = w.add_market(perp_params(1));
    let healthy = funded(&mut w, 100_000);
    let maker = funded(&mut w, 100_000);
    let liquidator = funded(&mut w, 100_000);
    buy_from(&mut w, m0, healthy, maker, 1_000, 10);
    let before = w.bytes();
    let status = |w: &mut World, m: usize, target: u32| {
        let outcome = w.liquidate(m, liquidator, target, 5).unwrap();
        outcome.status
    };

    let (not_open, healthy_seat) = (
        LiquidationStatus::TargetSeatNotOpen,
        LiquidationStatus::NotLiquidatable,
    );
    assert_eq!(status(&mut w, m0, 9), not_open);
    assert_eq!(status(&mut w, m0, 4_000), not_open);
    assert_eq!(status(&mut w, m1, healthy), LiquidationStatus::NoPosition);
    assert_eq!(status(&mut w, m0, FEE_SEAT), LiquidationStatus::NoPosition);
    assert_eq!(status(&mut w, m0, healthy), healthy_seat);
    w.now += 301;
    assert_eq!(status(&mut w, m0, healthy), LiquidationStatus::StalePrice);
    assert!(before == w.bytes());
    let codes = [
        LiquidationStatus::Liquidated.code(),
        LiquidationStatus::TargetSeatNotOpen.code(),
        LiquidationStatus::NoPosition.code(),
        LiquidationStatus::NotLiquidatable.code(),
        LiquidationStatus::StalePrice.code(),
    ];
    assert_eq!(codes, [1, 2, 3, 4, 5]);
}

#[test]
fn finding_6_only_the_liquidators_own_state_produces_an_error() {
    let (mut w, m) = perp_world(perp_params(0));
    let maker = funded(&mut w, 100_000);
    let target = funded(&mut w, 1_100);
    let poor = funded(&mut w, 10);
    let liquidator = funded(&mut w, 100_000);
    buy_from(&mut w, m, target, maker, 1_000, 10);
    w.set_price(m, 900);

    let stranger = [0xAB; 32];
    assert_eq!(
        w.liquidate_as(m, liquidator, stranger, target, 1),
        Err(E::NotSeatOwner)
    );
    let before = w.bytes();
    let beyond_its_means = w.liquidate(m, poor, target, 10).unwrap();
    let short_of_margin = LiquidationStatus::LiquidatorMarginInsufficient;
    assert_eq!(beyond_its_means.status, short_of_margin);
    assert_eq!(short_of_margin.code(), 7);
    assert!(before == w.bytes());
    assert_eq!(
        w.liquidate(m, liquidator, liquidator, 1),
        Err(E::SelfLiquidation)
    );
    assert_eq!(w.liquidate(m, liquidator, target, 0), Err(E::ZeroAmount));
    for reserved in [FEE_SEAT, INSURANCE_SEAT] {
        assert_eq!(w.liquidate(m, reserved, target, 1), Err(E::ReservedSeat));
    }
    w.paused = true;
    assert_eq!(
        w.liquidate(m, liquidator, target, 1),
        Err(E::ExchangePaused)
    );
    w.paused = false;

    let outcome = w.liquidate(m, liquidator, target, 1).unwrap();
    assert_eq!(outcome.status, LiquidationStatus::Liquidated);
    assert_eq!((outcome.liquidated, outcome.price), (1, 891));
}

#[test]
fn finding_7_a_stale_feed_on_another_market_does_not_shield_a_trader_from_liquidation() {
    let mut w = World::new(10, 8);
    let m0 = w.add_market(perp_params(0));
    let m1 = w.add_market(perp_params(1));
    let maker = funded(&mut w, 100_000);
    let liquidator = funded(&mut w, 100_000);
    let target = funded(&mut w, 1_200);
    buy_from(&mut w, m0, target, maker, 1_000, 10);
    buy_from(&mut w, m1, target, maker, 1_000, 1);
    buy_from(&mut w, m1, liquidator, maker, 1_000, 1);
    w.now += 301;
    w.set_price(m0, 900);
    assert!(w.is_liquidatable(target, m0));
    assert!(!w.is_liquidatable(target, m1));

    let on_the_fresh_market = w.liquidate(m0, liquidator, target, 10).unwrap();
    let on_the_stale_market = w.liquidate(m1, liquidator, target, 1).unwrap();

    assert_eq!(on_the_fresh_market.status, LiquidationStatus::Liquidated);
    assert_eq!(on_the_fresh_market.liquidated, 10);
    assert_eq!(on_the_stale_market.status, LiquidationStatus::StalePrice);
    assert_eq!(w.slot(target, m1).base, 1);
}

#[test]
fn finding_8_market_settings_outside_section_12_are_refused() {
    let refused: [fn(&mut MarketParams); 20] = [
        |p| p.mm_bps = 0,
        |p| p.mm_bps = p.im_bps,
        |p| p.im_bps = 10_001,
        |p| p.liq_penalty_bps = p.mm_bps - p.taker_fee_bps,
        |p| p.band_bps = 0,
        |p| p.band_bps = p.im_bps - p.mm_bps + 1,
        |p| p.max_move_bps = p.mm_bps - p.liq_penalty_bps,
        |p| p.funding_cap_bps = p.im_bps - p.mm_bps + 1,
        |p| p.taker_fee_bps = 101,
        |p| p.liq_insurance_share_bps = 10_001,
        |p| p.fee_insurance_share_bps = 10_001,
        |p| p.max_age_liquidation = p.max_price_age - 1,
        |p| p.max_price_age = 0,
        |p| p.tick = 0,
        |p| p.base_lot = 0,
        |p| p.min_size = 0,
        |p| p.funding_interval = 0,
        |p| p.min_publish_gap = 0,
        |p| p.open_interest_cap = 0,
        |p| p.funding_interval = -1,
    ];
    let accepted: [fn(&mut MarketParams); 9] = [
        |p| p.im_bps = 10_000,
        |p| p.liq_penalty_bps = p.mm_bps - p.taker_fee_bps - 1,
        |p| p.band_bps = p.im_bps - p.mm_bps,
        |p| p.max_move_bps = p.mm_bps - p.liq_penalty_bps - 1,
        |p| p.funding_cap_bps = p.im_bps - p.mm_bps,
        |p| p.taker_fee_bps = 100,
        |p| p.liq_insurance_share_bps = 10_000,
        |p| p.fee_insurance_share_bps = 10_000,
        |p| p.max_age_liquidation = p.max_price_age,
    ];
    for kind in [spot_params(0), perp_params(0)] {
        assert!(kind.check().is_ok());
        for break_it in refused {
            let mut params = kind;
            break_it(&mut params);
            assert_eq!(params.check(), Err(E::InvalidMarketParams));
        }
        for allow_it in accepted {
            let mut params = kind;
            params.max_move_bps = 0;
            allow_it(&mut params);
            assert!(params.check().is_ok());
        }
    }
}

/// A liquidation that leaves `debtor` flat, owing 520, with 200 of it paid by insurance.
fn uncovered_shortfall() -> (World, usize, u32) {
    let (mut w, m) = perp_world(perp_params(0));
    w.deposit(INSURANCE_SEAT, Asset::Collateral, 200).unwrap();
    let maker = funded(&mut w, 100_000);
    let liquidator = funded(&mut w, 100_000);
    let debtor = funded(&mut w, 1_100);
    buy_from(&mut w, m, debtor, maker, 1_000, 10);
    w.set_price(m, 850);
    let outcome = w.liquidate(m, liquidator, debtor, 10).unwrap();
    assert_eq!((outcome.insurance_paid, outcome.uncovered), (200, 320));
    (w, m, debtor)
}

#[test]
fn finding_9_cover_shortfall_pays_what_insurance_has_and_lowers_the_recorded_amount() {
    let (mut w, m, debtor) = uncovered_shortfall();
    assert_eq!(w.resume(m), Err(E::ShortfallOutstanding));
    assert_eq!(w.cover_shortfall(m, debtor), Ok(0));

    w.deposit(INSURANCE_SEAT, Asset::Collateral, 120).unwrap();
    assert_eq!(w.cover_shortfall(m, debtor), Ok(120));
    assert_eq!(w.collateral(debtor), -200);
    assert_eq!(w.collateral(INSURANCE_SEAT), 0);
    assert_eq!(w.markets[m].params.uncovered_shortfall, 200);
    assert_eq!(w.resume(m), Err(E::ShortfallOutstanding));

    w.deposit(INSURANCE_SEAT, Asset::Collateral, 1_000).unwrap();
    assert_eq!(w.cover_shortfall(m, debtor), Ok(200));
    assert_eq!(w.collateral(debtor), 0);
    assert_eq!(w.collateral(INSURANCE_SEAT), 800);
    assert_eq!(w.markets[m].params.uncovered_shortfall, 0);
    assert_eq!(w.markets[m].params.status, STATUS_REDUCE_ONLY);
    assert_eq!(w.resume(m), Ok(()));
    assert_eq!(w.markets[m].params.status, STATUS_ACTIVE);
    assert_eq!(w.close(debtor), Ok(()));
}

#[test]
fn finding_9_cover_shortfall_does_nothing_and_reveals_nothing_for_a_seat_that_does_not_qualify() {
    let (mut w, m, debtor) = uncovered_shortfall();
    w.deposit(INSURANCE_SEAT, Asset::Collateral, 1_000).unwrap();
    let solvent = funded(&mut w, 50);
    let other_market = w.add_market(perp_params(1));
    let before = w.bytes();

    for seat in [solvent, FEE_SEAT, INSURANCE_SEAT, 9, 4_000] {
        assert_eq!(w.cover_shortfall(m, seat), Ok(0));
    }
    assert_eq!(w.cover_shortfall(other_market, debtor), Ok(0));

    assert!(before == w.bytes());
}

#[test]
fn finding_9_reconcile_shortfall_lowers_the_records_to_what_flat_seats_still_owe() {
    let (mut w, m, debtor) = uncovered_shortfall();
    let other = w.add_market(perp_params(1));
    w.markets[other].params.uncovered_shortfall = 50;
    assert_eq!(w.collateral(debtor), -320);

    assert_eq!(w.reconcile(), 50);
    let records = |w: &World| {
        let recorded = |market: usize| w.markets[market].params.uncovered_shortfall;
        (recorded(m), recorded(other))
    };
    assert_eq!(records(&w), (270, 50));
    assert_eq!(w.reconcile(), 0);

    w.deposit(debtor, Asset::Collateral, 300).unwrap();
    assert_eq!(w.reconcile(), 300);
    assert_eq!(records(&w), (0, 20));
    assert_eq!(w.resume(m), Ok(()));
    assert_eq!(w.resume(other), Err(E::ShortfallOutstanding));
    w.deposit(debtor, Asset::Collateral, 500).unwrap();
    assert_eq!(w.reconcile(), 20);
    assert_eq!(records(&w), (0, 0));
    assert_eq!(w.resume(other), Ok(()));
}

#[test]
fn finding_3_a_trader_held_below_initial_margin_by_resting_orders_can_still_close_completely() {
    let (mut w, m) = perp_world(free_perp());
    let maker = funded(&mut w, 100_000);
    let trader = funded(&mut w, 3_000);
    buy_from(&mut w, m, trader, maker, 1_000, 10);
    w.place(m, trader, limit(Side::Bid, 700, 15)).unwrap();
    w.set_price(m, 800);
    w.place(m, maker, limit(Side::Bid, 760, 10)).unwrap();
    assert_eq!(w.equity(trader), 1_000);

    let outcome = w
        .place(m, trader, reduce_only(ioc(Side::Ask, 760, 10)))
        .unwrap();

    assert_eq!(outcome.status, PlaceStatus::Filled);
    assert_eq!(w.slot(trader, m).base, 0);
    assert_eq!(w.equity(trader), 600);
    assert!(w.equity(trader) < w.initial_margin(trader));
}

#[test]
fn finding_10_a_deposit_cannot_take_a_balance_above_the_cap() {
    let mut w = World::new(8, 8);
    let a = w.open();
    for asset in [Asset::Collateral, Asset::Spot(QUOTE)] {
        let over_the_cap = Err(E::BalanceCapExceeded);
        assert_eq!(w.deposit(a, asset, BALANCE_CAP + 1), over_the_cap);
        assert_eq!(w.deposit(a, asset, BALANCE_CAP), Ok(()));
        assert_eq!(w.deposit(a, asset, 1), over_the_cap);
    }
    assert_eq!(BALANCE_CAP, 1 << 62);
}

#[test]
fn finding_10_a_maker_at_the_cap_is_cancelled_and_matching_continues_without_an_error() {
    let mut w = World::new(8, 8);
    let m = w.add_market(spot_params(0));
    let full = w.open();
    let normal = w.open();
    let buyer = w.open();
    w.deposit(full, Asset::Spot(QUOTE), BALANCE_CAP - 500)
        .unwrap();
    for seller in [full, normal] {
        w.deposit(seller, Asset::Spot(BASE), 100).unwrap();
        w.place(m, seller, limit(Side::Ask, 1_000, 1)).unwrap();
    }
    w.deposit(buyer, Asset::Spot(QUOTE), 10_000).unwrap();

    let outcome = w.place(m, buyer, ioc(Side::Bid, 1_000, 1)).unwrap();

    assert_eq!(outcome.status, PlaceStatus::Filled);
    assert_eq!(w.fills.as_slice()[0].maker_seat, normal);
    let base = w.spot(full, BASE);
    assert_eq!((base.available, base.locked), (100, 0));
    assert_eq!(w.spot(full, QUOTE).available, BALANCE_CAP - 500);
    assert!(w.markets[m].resting(Side::Ask).is_empty());
}

#[test]
fn finding_11_no_key_can_trade_liquidate_withdraw_or_close_for_a_reserved_seat() {
    let (mut w, m) = perp_world(perp_params(0));
    for reserved in [FEE_SEAT, INSURANCE_SEAT] {
        w.deposit(reserved, Asset::Collateral, 50_000).unwrap();
        let key = w.key(reserved);

        let placing = w.place_as(m, reserved, key, limit(Side::Bid, 990, 1));
        assert_eq!(placing, Err(E::ReservedSeat));
        let withdrawing = w.withdraw_as(reserved, key, Asset::Collateral, 1);
        assert_eq!(withdrawing, Err(E::ReservedSeat));
        assert_eq!(w.close_as(reserved, key), Err(E::ReservedSeat));
        assert_eq!(w.liquidate_as(m, reserved, key, 5, 1), Err(E::ReservedSeat));
        assert_eq!(w.collateral(reserved), 50_000);
    }
}

#[test]
fn finding_11_fees_leave_the_fee_seat_only_through_the_two_admin_calls() {
    let mut w = World::new(10, 8);
    let perp = w.add_market(perp_params(0));
    let spot = w.add_market(spot_params(1));
    let a = funded(&mut w, 100_000);
    let b = funded(&mut w, 100_000);
    buy_from(&mut w, perp, a, b, 1_000, 10);
    w.deposit(a, Asset::Spot(QUOTE), 10_000).unwrap();
    w.deposit(b, Asset::Spot(BASE), 1_000).unwrap();
    buy_from(&mut w, spot, a, b, 1_000, 1);
    assert_eq!(w.collateral(FEE_SEAT), 30);
    assert_eq!(w.spot(FEE_SEAT, QUOTE).available, 3);
    let custody = w.custody_collateral;

    assert_eq!(w.move_fees_to_insurance(31), Err(E::InsufficientCollateral));
    assert_eq!(w.move_fees_to_insurance(0), Err(E::ZeroAmount));
    assert_eq!(w.move_fees_to_insurance(20), Ok(()));
    assert_eq!(w.collateral(FEE_SEAT), 10);
    assert_eq!(w.collateral(INSURANCE_SEAT), 20);
    assert_eq!(w.custody_collateral, custody);

    assert_eq!(
        w.collect_fees(Asset::Collateral, 11),
        Err(E::InsufficientCollateral)
    );
    assert_eq!(w.collect_fees(Asset::Collateral, 10), Ok(()));
    assert_eq!(w.custody_collateral, custody - 10);
    assert_eq!(
        w.collect_fees(Asset::Spot(QUOTE), 4),
        Err(E::InsufficientBalance)
    );
    assert_eq!(w.collect_fees(Asset::Spot(QUOTE), 3), Ok(()));
    assert_eq!(w.spot(FEE_SEAT, QUOTE).available, 0);
}

#[test]
fn finding_12_with_a_zero_taker_fee_a_spot_bid_needs_exactly_its_notional() {
    let mut params = spot_params(0);
    params.taker_fee_bps = 0;
    let mut w = World::new(8, 8);
    let m = w.add_market(params);
    let seller = w.open();
    let buyer = w.open();
    w.deposit(seller, Asset::Spot(BASE), 500).unwrap();
    w.deposit(buyer, Asset::Spot(QUOTE), 5_000).unwrap();
    w.place(m, seller, limit(Side::Ask, 1_000, 2)).unwrap();

    let outcome = w.place(m, buyer, limit(Side::Bid, 1_000, 5)).unwrap();

    assert_eq!(sizes(&outcome), (2, 3, 0));
    let quote = w.spot(buyer, QUOTE);
    assert_eq!((quote.available, quote.locked), (0, 3_000));
}

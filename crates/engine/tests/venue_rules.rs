//! The rules taken over from established venues: two price bands, resting-order
//! expiry, the stricter fill checks, the open interest cap, withdrawals during a
//! shortfall, the liquidation size and price limits, and the fee and penalty splits.
//! RULES sections 3.3, 4, 5, 6, 8 and 9.

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

/// A trader with 1,070 of collateral left who is long 10 lots from 1,000, and the
/// seats of the maker and a well-funded liquidator.
fn thin_long(params: MarketParams) -> (World, usize, u32, u32) {
    let (mut w, m) = perp_world(params);
    let maker = funded(&mut w, 100_000);
    let liquidator = funded(&mut w, 100_000);
    let target = funded(&mut w, 1_100);
    buy_from(&mut w, m, target, maker, 1_000, 10);
    assert_eq!(w.collateral(target), 1_070);
    (w, m, target, liquidator)
}

#[test]
fn s3_3_the_crossing_band_is_one_sided_and_the_outer_band_is_fifty_percent_both_ways() {
    let (mut w, m) = perp_world(perp_params(0));
    let a = funded(&mut w, 1_000_000);
    let refused = [
        (Side::Bid, 1_060),
        (Side::Ask, 940),
        (Side::Bid, 490),
        (Side::Ask, 1_510),
    ];
    let accepted = [
        (Side::Bid, 1_050),
        (Side::Ask, 950),
        (Side::Bid, 500),
        (Side::Ask, 1_500),
    ];

    for (side, price) in refused {
        let placing = w.place(m, a, ioc(side, price, 1));
        assert_eq!(placing, Err(E::PriceOutsideBand), "{side:?} {price}");
    }
    for (side, price) in accepted {
        let placing = w.place(m, a, ioc(side, price, 1));
        assert!(placing.is_ok(), "{side:?} {price}");
    }
}

#[test]
fn s4_a_resting_order_that_now_breaches_the_crossing_band_is_cancelled_when_reached() {
    let (mut w, m) = perp_world(perp_params(0));
    let a = funded(&mut w, 100_000);
    let b = funded(&mut w, 100_000);
    w.place(m, a, limit(Side::Ask, 960, 2)).unwrap();
    w.place(m, a, limit(Side::Ask, 1_000, 2)).unwrap();
    w.set_price(m, 1_020);

    let outcome = w.place(m, b, ioc(Side::Bid, 1_000, 3)).unwrap();

    assert_eq!(sizes(&outcome), (2, 0, 1));
    assert_eq!(w.fills.as_slice()[0].price, 1_000);
    assert_eq!(w.slot(a, m).open_ask_lots, 0);
    assert!(w.markets[m].resting(Side::Ask).is_empty());
}

#[test]
fn s4_a_resting_order_far_on_the_passive_side_of_the_mark_is_not_cancelled() {
    let (mut w, m) = perp_world(perp_params(0));
    let a = funded(&mut w, 100_000);
    let b = funded(&mut w, 100_000);
    w.place(m, a, limit(Side::Ask, 1_000, 2)).unwrap();
    w.set_price(m, 960);

    let outcome = w.place(m, b, ioc(Side::Bid, 1_000, 2)).unwrap();

    assert_eq!(outcome.filled, 2);
    assert_eq!(w.fills.as_slice()[0].price, 1_000);
}

#[test]
fn s4_a_resting_order_past_its_own_expiry_is_removed_when_matching_reaches_it() {
    let (mut w, m) = perp_world(perp_params(0));
    let a = funded(&mut w, 100_000);
    let b = funded(&mut w, 100_000);
    let expiry = w.now + 10;
    w.place(m, a, expiring(limit(Side::Ask, 1_000, 2), expiry))
        .unwrap();
    w.place(m, a, limit(Side::Ask, 1_010, 2)).unwrap();
    assert_eq!(w.markets[m].resting(Side::Ask)[0].expiry, expiry);

    w.now += 10;
    w.set_price(m, MARK);
    let on_time = w.place(m, b, ioc(Side::Bid, 1_000, 1)).unwrap();
    w.now += 1;
    w.set_price(m, MARK);
    assert_eq!(w.markets[m].resting(Side::Ask).len(), 2);
    w.max_steps = 2;
    let too_late = w.place(m, b, ioc(Side::Bid, 1_010, 3)).unwrap();

    assert_eq!(on_time.filled, 1);
    assert_eq!(sizes(&too_late), (2, 0, 1));
    assert_eq!(w.fills.as_slice()[0].price, 1_010);
    assert_eq!(w.slot(a, m).open_ask_lots, 0);
    assert_eq!(w.seat(a).open_orders[m], 0);
}

#[test]
fn s4_an_order_whose_resting_expiry_has_already_passed_is_refused_and_zero_means_none() {
    let (mut w, m) = perp_world(perp_params(0));
    let a = funded(&mut w, 100_000);
    let past = expiring(limit(Side::Bid, 990, 1), w.now - 1);
    let present = expiring(limit(Side::Bid, 990, 1), w.now);

    assert_eq!(w.place(m, a, past), Err(E::OrderExpired));
    assert!(w.place(m, a, present).is_ok());
    assert!(w.place(m, a, limit(Side::Bid, 990, 1)).is_ok());
    let snapshot = w.snapshot_as(m, a, w.key(a)).unwrap();
    assert_eq!(snapshot.orders[0].expiry, w.now);
    assert_eq!(snapshot.orders[1].expiry, 0);
}

/// A trader long 10 from 1,000 with exactly 1,000 of collateral, on a market with no
/// fee, and a maker bidding `size` lots at `bid` after the mark has moved to `mark`.
fn reducing_sale(mark: u64, bid: u64, size: u64) -> (World, usize, u32, PlaceOutcome) {
    let (mut w, m) = perp_world(free_perp());
    let maker = funded(&mut w, 100_000);
    let trader = funded(&mut w, 1_000);
    buy_from(&mut w, m, trader, maker, 1_000, 10);
    w.set_price(m, mark);
    w.place(m, maker, limit(Side::Bid, bid, size)).unwrap();
    let outcome = w
        .place(m, trader, reduce_only(ioc(Side::Ask, bid, size)))
        .unwrap();
    (w, m, trader, outcome)
}

#[test]
fn s6_a_reducing_fill_below_initial_margin_passes_when_it_leaves_the_account_no_riskier() {
    let (w, m, trader, outcome) = reducing_sale(950, 910, 5);

    assert_eq!(outcome.status, PlaceStatus::Filled);
    assert_eq!(w.slot(trader, m).base, 5);
    assert_eq!(w.equity(trader), 300);
    assert!(w.equity(trader) < w.initial_margin(trader));
}

#[test]
fn s6_a_reducing_fill_that_lowers_equity_per_unit_of_maintenance_margin_is_stopped() {
    let (w, m, trader, outcome) = reducing_sale(925, 880, 1);

    assert_eq!(outcome.status, PlaceStatus::RemainderCancelledFillCheck);
    assert_eq!(w.slot(trader, m).base, 10);
    assert_eq!(w.equity(trader), 250);

    let (w, m, trader, outcome) = reducing_sale(925, 920, 1);
    assert_eq!(outcome.status, PlaceStatus::Filled);
    assert_eq!(w.slot(trader, m).base, 9);
}

#[test]
fn s6_a_fill_that_would_raise_total_long_size_above_the_cap_stops_matching() {
    let mut params = free_perp();
    params.open_interest_cap = 10;
    let (mut w, m) = perp_world(params);
    let a = funded(&mut w, 100_000);
    let b = funded(&mut w, 100_000);
    let c = funded(&mut w, 100_000);
    buy_from(&mut w, m, a, b, 1_000, 6);
    w.place(m, b, limit(Side::Ask, 1_000, 6)).unwrap();

    let over = w.place(m, c, ioc(Side::Bid, 1_000, 6)).unwrap();
    let up_to_the_cap = w.place(m, c, ioc(Side::Bid, 1_000, 4)).unwrap();

    assert_eq!(over.status, PlaceStatus::RemainderCancelledFillCheck);
    assert_eq!(over.filled, 0);
    assert_eq!(up_to_the_cap.filled, 4);
    assert_eq!(w.markets[m].book.open_interest, 10);

    w.cancel_all(m, b, 10).unwrap();
    w.place(m, a, limit(Side::Ask, 1_000, 2)).unwrap();
    let handed_over = w.place(m, c, ioc(Side::Bid, 1_000, 2)).unwrap();
    assert_eq!(handed_over.filled, 2);
    assert_eq!(w.markets[m].book.open_interest, 10);
    w.place(m, c, limit(Side::Ask, 1_000, 3)).unwrap();
    let closing = w
        .place(m, b, reduce_only(ioc(Side::Bid, 1_000, 3)))
        .unwrap();
    assert_eq!(closing.filled, 3);
    assert_eq!(w.markets[m].book.open_interest, 7);
}

#[test]
fn s6_collateral_withdrawals_stop_for_everyone_while_a_shortfall_is_recorded() {
    let (mut w, m, target, liquidator) = thin_long(perp_params(0));
    let bystander = funded(&mut w, 500);
    w.deposit(bystander, Asset::Spot(QUOTE), 40).unwrap();
    w.set_price(m, 850);
    let outcome = w.liquidate(m, liquidator, target, 10).unwrap();
    assert_eq!(outcome.uncovered, 520);

    let blocked = w.withdraw(bystander, Asset::Collateral, 1);
    let spot_tokens = w.withdraw(bystander, Asset::Spot(QUOTE), 40);
    let wrong_key = w.withdraw_as(bystander, [9; 32], Asset::Collateral, 1);

    assert_eq!(blocked, Err(E::ShortfallOutstanding));
    assert_eq!(wrong_key, Err(E::ShortfallOutstanding));
    assert_eq!(spot_tokens, Ok(()));
    w.deposit(INSURANCE_SEAT, Asset::Collateral, 520).unwrap();
    assert_eq!(w.cover_shortfall(m, target), Ok(520));
    assert_eq!(w.withdraw(bystander, Asset::Collateral, 500), Ok(()));
}

#[test]
fn s8_3_a_liquidation_takes_no_more_than_restores_maintenance_margin() {
    let (mut w, m, target, liquidator) = thin_long(perp_params(0));
    w.set_price(m, 930);
    assert_eq!((w.equity(target), w.maintenance_margin(target)), (370, 465));

    let outcome = w.liquidate(m, liquidator, target, 10).unwrap();

    assert_eq!((outcome.liquidated, outcome.price), (3, 920));
    assert_eq!(w.slot(target, m).base, 7);
    assert_eq!(w.equity(target), 340);
    assert!(w.equity(target) >= w.maintenance_margin(target));
    let again = w.liquidate(m, liquidator, target, 10).unwrap();
    assert_eq!(again.status, LiquidationStatus::NotLiquidatable);
}

#[test]
fn s8_3_the_liquidation_buffer_takes_the_target_that_far_above_maintenance_margin() {
    let mut params = perp_params(0);
    params.liq_buffer_bps = 100;
    let (mut w, m, target, liquidator) = thin_long(params);
    w.set_price(m, 930);

    let outcome = w.liquidate(m, liquidator, target, 10).unwrap();

    assert_eq!(outcome.liquidated, 5);
    let left = 5 * 930;
    assert_eq!(w.equity(target), 370 - 5 * 10);
    assert!(w.equity(target) * 10_000 >= left * (500 + 100));
}

#[test]
fn s8_3_the_whole_position_is_taken_when_less_than_the_minimum_size_would_remain() {
    let mut params = perp_params(0);
    params.min_size = 8;
    let (mut w, m, target, liquidator) = thin_long(params);
    w.deposit(INSURANCE_SEAT, Asset::Collateral, 1_000).unwrap();
    w.set_price(m, 930);

    let outcome = w.liquidate(m, liquidator, target, 3).unwrap();

    assert_eq!(outcome.liquidated, 10);
    assert_eq!(w.slot(target, m).base, 0);
    assert_eq!(w.collateral(target), 1_070 - 800);
}

#[test]
fn s8_3_a_liquidation_price_worse_than_the_liquidators_worst_price_does_nothing() {
    let (mut w, m, target, liquidator) = thin_long(perp_params(0));
    w.set_price(m, 930);
    let key = w.key(liquidator);
    let request = |worst_price| LiquidationRequest {
        target,
        size: 1,
        worst_price,
    };
    let before = w.bytes();

    let too_dear = w.liquidate_with(m, liquidator, key, request(919)).unwrap();
    assert_eq!(too_dear.status, LiquidationStatus::WorstPriceExceeded);
    assert!(before == w.bytes());
    let acceptable = w.liquidate_with(m, liquidator, key, request(920)).unwrap();
    assert_eq!(acceptable.status, LiquidationStatus::Liquidated);
    assert_eq!(LiquidationStatus::WorstPriceExceeded.code(), 6);
}

#[test]
fn s8_3_the_worst_price_of_a_liquidator_selling_into_a_short_is_a_floor() {
    let (mut w, m) = perp_world(perp_params(0));
    let maker = funded(&mut w, 100_000);
    let liquidator = funded(&mut w, 100_000);
    let target = funded(&mut w, 1_100);
    w.place(m, maker, limit(Side::Bid, 1_000, 10)).unwrap();
    w.place(m, target, ioc(Side::Ask, 1_000, 10)).unwrap();
    w.set_price(m, 1_070);
    let key = w.key(liquidator);
    let request = |worst_price| LiquidationRequest {
        target,
        size: 1,
        worst_price,
    };

    let too_cheap = w
        .liquidate_with(m, liquidator, key, request(1_082))
        .unwrap();
    let acceptable = w
        .liquidate_with(m, liquidator, key, request(1_081))
        .unwrap();

    assert_eq!(too_cheap.status, LiquidationStatus::WorstPriceExceeded);
    assert_eq!((acceptable.liquidated, acceptable.price), (1, 1_081));
}

#[test]
fn s8_3a_the_penalty_is_split_between_the_insurance_seat_and_the_liquidator() {
    let mut params = perp_params(0);
    params.liq_insurance_share_bps = 2_500;
    let (mut w, m, target, liquidator) = thin_long(params);
    w.set_price(m, 930);
    let liquidator_equity = w.equity(liquidator);

    let outcome = w.liquidate(m, liquidator, target, 2).unwrap();

    assert_eq!(outcome.penalty_to_insurance, 5);
    assert_eq!(w.collateral(INSURANCE_SEAT), 5);
    assert_eq!(w.equity(liquidator), liquidator_equity + 20 - 5);
    assert_eq!(w.equity(target), 370 - 20);
}

#[test]
fn s5_each_taker_fee_is_split_between_the_insurance_seat_and_the_fee_seat() {
    let mut w = World::new(10, 8);
    let mut perp = perp_params(0);
    perp.fee_insurance_share_bps = 2_500;
    let mut spot = spot_params(1);
    spot.fee_insurance_share_bps = 2_500;
    let (perp, spot) = (w.add_market(perp), w.add_market(spot));
    let a = funded(&mut w, 100_000);
    let b = funded(&mut w, 100_000);
    w.deposit(a, Asset::Spot(QUOTE), 100_000).unwrap();
    w.deposit(b, Asset::Spot(BASE), 10_000).unwrap();

    buy_from(&mut w, perp, a, b, 1_000, 10);
    buy_from(&mut w, spot, a, b, 1_000, 10);
    buy_from(&mut w, spot, a, b, 1_000, 1);

    assert_eq!(w.collateral(a), 100_000 - 30);
    assert_eq!(w.collateral(INSURANCE_SEAT), 7);
    assert_eq!(w.collateral(FEE_SEAT), 23);
    let in_quote = |seat| w.spot(seat, QUOTE).available;
    assert_eq!((in_quote(INSURANCE_SEAT), in_quote(FEE_SEAT)), (7, 23 + 3));
}

#[test]
fn s5_a_full_insurance_share_sends_every_fee_to_the_insurance_seat() {
    let mut params = perp_params(0);
    params.fee_insurance_share_bps = 10_000;
    let (mut w, m) = perp_world(params);
    let a = funded(&mut w, 100_000);
    let b = funded(&mut w, 100_000);

    buy_from(&mut w, m, a, b, 1_000, 10);

    assert_eq!(w.collateral(INSURANCE_SEAT), 30);
    assert_eq!(w.collateral(FEE_SEAT), 0);
}

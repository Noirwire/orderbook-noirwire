//! The limits a small market needs before real deposits: the per-seat position cap of
//! RULES 3 and 6, a liquidation at the open interest cap (RULES 8), and the fee seat
//! paying a deficit after insurance and before anything is recorded (RULES 8.5 and
//! 8.6). The custody cap is the program's, in its deposit.

mod common;

use common::*;
use noirwire_orderbook_engine::EngineError as E;
use noirwire_orderbook_engine::*;

fn capped(position_cap: u64) -> MarketParams {
    MarketParams {
        position_cap,
        ..perp_params(0)
    }
}

#[test]
fn s12_a_position_cap_is_refused_at_zero_and_above_the_open_interest_bound() {
    for mut params in [perp_params(0), spot_params(0)] {
        for refused in [0, MAX_OPEN_INTEREST_CAP + 1, u64::MAX] {
            params.position_cap = refused;
            assert_eq!(params.check(), Err(E::InvalidMarketParams), "{refused}");
        }
        for accepted in [1, params.open_interest_cap, MAX_OPEN_INTEREST_CAP] {
            params.position_cap = accepted;
            assert!(params.check().is_ok(), "{accepted}");
        }
    }
}

#[test]
fn s3_6_an_order_that_could_take_the_position_past_the_cap_is_refused_whatever_the_book() {
    let (mut w, m) = perp_world(capped(10));
    let trader = funded(&mut w, 100_000);
    let seller = funded(&mut w, 100_000);
    buy_from(&mut w, m, trader, seller, 1_000, 6);
    w.place(m, trader, limit(Side::Bid, 990, 3)).unwrap();
    let slot = w.slot(trader, m);

    for order in [limit(Side::Bid, 990, 2), ioc(Side::Bid, 1_000, 2)] {
        assert_eq!(w.place(m, trader, order), Err(E::PositionCapExceeded));
    }
    w.place(m, seller, limit(Side::Ask, 1_000, 4)).unwrap();
    assert_eq!(
        w.place(m, trader, ioc(Side::Bid, 1_000, 2)),
        Err(E::PositionCapExceeded),
        "the same refusal with an ask to match"
    );
    assert_eq!(
        w.place(m, trader, ioc(Side::Ask, 1_000, 11)),
        Err(E::PositionCapExceeded),
        "an ask counts in full: the long it would close first does not offset it"
    );
    assert_eq!(w.slot(trader, m), slot);
    assert_eq!(w.seat(trader).open_orders[m], 1);
    let nothing_to_match = w.place(m, trader, ioc(Side::Ask, 1_000, 10)).unwrap();
    assert_eq!(nothing_to_match.filled, 0);

    let to_the_cap = w.place(m, trader, ioc(Side::Bid, 1_000, 1)).unwrap();
    assert_eq!(to_the_cap.filled, 1);
    assert_eq!(w.slot(trader, m).base, 7);
    assert_eq!(w.slot(trader, m).open_bid_lots, 3);
}

#[test]
fn s3_6_an_order_the_cap_let_rest_fills_in_full_after_its_owner_closes_the_other_way() {
    let (mut w, m) = perp_world(capped(10));
    let trader = funded(&mut w, 100_000);
    let other = funded(&mut w, 100_000);
    buy_from(&mut w, m, other, trader, 1_000, 10);
    assert_eq!(
        w.place(m, trader, limit(Side::Bid, 990, 11)),
        Err(E::PositionCapExceeded),
        "the short does not make room for more bids"
    );
    w.place(m, trader, limit(Side::Bid, 990, 10)).unwrap();
    w.place(m, other, limit(Side::Ask, 1_000, 10)).unwrap();
    let closed = w
        .place(m, trader, reduce_only(ioc(Side::Bid, 1_000, 10)))
        .unwrap();
    assert_eq!(closed.filled, 10);
    assert_eq!(w.slot(trader, m).base, 0);

    let seller = funded(&mut w, 100_000);
    let hit = w.place(m, seller, ioc(Side::Ask, 990, 10)).unwrap();
    assert_eq!(hit.status, PlaceStatus::Filled);
    assert_eq!(
        w.slot(trader, m).base,
        10,
        "the resting bid filled to the cap"
    );
}

#[test]
fn s6_a_maker_whose_fill_would_pass_a_lowered_cap_is_cancelled_and_matching_continues() {
    let (mut w, m) = perp_world(capped(15));
    let near_cap = funded(&mut w, 100_000);
    let other_maker = funded(&mut w, 100_000);
    let taker = funded(&mut w, 100_000);
    let buyer = funded(&mut w, 100_000);
    buy_from(&mut w, m, buyer, near_cap, 1_000, 8);
    assert_eq!(w.slot(near_cap, m).base, -8);
    w.place(m, near_cap, limit(Side::Ask, 1_000, 5)).unwrap();
    w.place(m, other_maker, limit(Side::Ask, 1_010, 5)).unwrap();
    w.markets[m].params.position_cap = 10;

    let outcome = w.place(m, taker, ioc(Side::Bid, 1_010, 5)).unwrap();

    assert_eq!(outcome.status, PlaceStatus::Filled);
    assert_eq!(outcome.filled, 5);
    assert_eq!(w.slot(near_cap, m).base, -8);
    assert_eq!(w.seat(near_cap).open_orders[m], 0);
    assert_eq!(w.slot(near_cap, m).open_ask_lots, 0);
    assert_eq!(w.slot(other_maker, m).base, -5);
}

#[test]
fn s6_reducing_and_closing_above_the_cap_always_pass_and_a_plain_order_past_it_does_not() {
    let (mut w, m) = perp_world(perp_params(0));
    let holder = funded(&mut w, 100_000);
    let counter = funded(&mut w, 1_000_000);
    buy_from(&mut w, m, holder, counter, 1_000, 20);
    w.markets[m].params.position_cap = 10;
    let bidders = [10, 5, 10, 5].map(|size| {
        let bidder = funded(&mut w, 100_000);
        w.place(m, bidder, limit(Side::Bid, 1_000, size)).unwrap();
        bidder
    });

    assert_eq!(
        w.place(m, holder, ioc(Side::Ask, 1_000, 15)),
        Err(E::PositionCapExceeded),
        "a plain order counts in full, not net of the position it shrinks"
    );
    let reduced = w
        .place(m, holder, reduce_only(ioc(Side::Ask, 1_000, 15)))
        .unwrap();
    assert_eq!(reduced.filled, 15);
    assert_eq!(w.slot(holder, m).base, 5);

    let flip = w.place(m, holder, ioc(Side::Ask, 1_000, 10)).unwrap();
    assert_eq!(flip.status, PlaceStatus::Filled);
    assert_eq!(flip.filled, 10, "flat, then short 5");
    assert_eq!(w.slot(holder, m).base, -5);
    assert_eq!(
        w.place(m, holder, ioc(Side::Ask, 1_000, 6)),
        Err(E::PositionCapExceeded),
        "short 5 and 6 more"
    );

    assert_eq!(
        w.cancel_all(m, bidders[3], 1),
        Ok(1),
        "the bid the flip left"
    );
    w.place(m, bidders[0], limit(Side::Ask, 1_000, 5)).unwrap();
    let closed = w
        .place(m, holder, reduce_only(ioc(Side::Bid, 1_000, 5)))
        .unwrap();
    assert_eq!(closed.filled, 5);
    assert_eq!(w.slot(holder, m).base, 0);
}

#[test]
fn s8_a_liquidation_takes_over_a_position_whatever_the_cap() {
    let (mut w, m) = perp_world(capped(10));
    let makers = [funded(&mut w, 1_000_000), funded(&mut w, 1_000_000)];
    let liquidator = funded(&mut w, 1_000_000);
    let target = funded(&mut w, 1_100);
    buy_from(&mut w, m, liquidator, makers[0], 1_000, 10);
    buy_from(&mut w, m, target, makers[1], 1_000, 10);
    w.set_price(m, 930);

    let outcome = w.liquidate(m, liquidator, target, 10).unwrap();

    assert_eq!(outcome.status, LiquidationStatus::Liquidated);
    assert_eq!(outcome.liquidated, 3);
    assert_eq!(w.slot(liquidator, m).base, 13, "above the cap of 10");
    assert_eq!(
        w.place(m, liquidator, limit(Side::Bid, 930, 1)),
        Err(E::PositionCapExceeded)
    );
    let shrinking = w.place(m, liquidator, limit(Side::Ask, 930, 10)).unwrap();
    assert_eq!(shrinking.status, PlaceStatus::Rested);
}

#[test]
fn s8_a_liquidation_takes_over_a_long_while_open_interest_is_at_its_cap() {
    let (mut w, m) = perp_world(MarketParams {
        open_interest_cap: 20,
        ..perp_params(0)
    });
    let makers = [funded(&mut w, 1_000_000), funded(&mut w, 1_000_000)];
    let other_long = funded(&mut w, 1_000_000);
    let liquidator = funded(&mut w, 1_000_000);
    let target = funded(&mut w, 1_100);
    buy_from(&mut w, m, other_long, makers[0], 1_000, 10);
    buy_from(&mut w, m, target, makers[1], 1_000, 10);
    assert_eq!(w.markets[m].book.open_interest, 20);
    w.set_price(m, 930);

    let outcome = w.liquidate(m, liquidator, target, 10).unwrap();

    assert_eq!(outcome.status, LiquidationStatus::Liquidated);
    assert_eq!(outcome.liquidated, 3);
    assert_eq!(w.slot(liquidator, m).base, 3);
    assert_eq!(
        w.markets[m].book.open_interest, 20,
        "the long changed hands at the cap"
    );
}

/// `buyer` buys `size` lots from `seller` at the mark and sells them back, so the fee
/// seat earns two taker fees and both end flat.
fn round_trip(w: &mut World, m: usize, buyer: u32, seller: u32, size: u64) {
    buy_from(w, m, buyer, seller, MARK, size);
    buy_from(w, m, seller, buyer, MARK, size);
    assert_eq!(w.slot(buyer, m).base, 0);
}

#[test]
fn s8_5_a_deficit_the_fee_seat_covers_records_nothing_and_freezes_nobody() {
    let (mut w, m) = perp_world(perp_params(0));
    let maker = funded(&mut w, 100_000);
    let liquidator = funded(&mut w, 100_000);
    let (a, b) = (funded(&mut w, 1_000_000), funded(&mut w, 1_000_000));
    round_trip(&mut w, m, a, b, 1_000);
    let target = funded(&mut w, 1_100);
    buy_from(&mut w, m, target, maker, 1_000, 10);
    let fees = w.collateral(FEE_SEAT);
    assert_eq!(fees, 3_000 + 3_000 + 30);
    w.set_price(m, 850);

    let outcome = w.liquidate(m, liquidator, target, 10).unwrap();

    let paid = (
        outcome.insurance_paid,
        outcome.fee_seat_paid,
        outcome.uncovered,
    );
    assert_eq!(paid, (0, 430, 0));
    assert_eq!(w.collateral(FEE_SEAT), fees - 430);
    assert_eq!(w.collateral(target), 0);
    assert_eq!(w.markets[m].params.uncovered_shortfall, 0);
    assert_eq!(w.markets[m].params.status, STATUS_ACTIVE);
    assert_eq!(w.withdraw(a, Asset::Collateral, 1), Ok(()));
}

#[test]
fn s8_5_insurance_pays_first_and_the_fee_seat_only_what_insurance_could_not() {
    let (mut w, m) = perp_world(perp_params(0));
    w.deposit(INSURANCE_SEAT, Asset::Collateral, 100).unwrap();
    let maker = funded(&mut w, 100_000);
    let liquidator = funded(&mut w, 100_000);
    let (a, b) = (funded(&mut w, 1_000_000), funded(&mut w, 1_000_000));
    round_trip(&mut w, m, a, b, 1_000);
    let target = funded(&mut w, 1_100);
    buy_from(&mut w, m, target, maker, 1_000, 10);
    let fees = w.collateral(FEE_SEAT);
    w.set_price(m, 850);

    let outcome = w.liquidate(m, liquidator, target, 10).unwrap();

    assert_eq!(outcome.insurance_paid, 100);
    assert_eq!(outcome.fee_seat_paid, 330);
    assert_eq!(w.collateral(INSURANCE_SEAT), 0);
    assert_eq!(w.collateral(FEE_SEAT), fees - 330);
}

#[test]
fn s8_6_cover_shortfall_draws_the_fee_seat_after_insurance() {
    let (mut w, m) = perp_world(perp_params(0));
    let other = w.add_market(perp_params(1));
    let maker = funded(&mut w, 100_000);
    let liquidator = funded(&mut w, 100_000);
    let target = funded(&mut w, 1_100);
    buy_from(&mut w, m, target, maker, 1_000, 10);
    w.set_price(m, 850);
    let outcome = w.liquidate(m, liquidator, target, 10).unwrap();
    assert_eq!((outcome.fee_seat_paid, outcome.uncovered), (30, 400));
    assert_eq!(w.collateral(FEE_SEAT), 0);

    let (a, b) = (funded(&mut w, 1_000_000), funded(&mut w, 1_000_000));
    round_trip(&mut w, other, a, b, 100);
    assert_eq!(w.collateral(FEE_SEAT), 600);
    w.deposit(INSURANCE_SEAT, Asset::Collateral, 150).unwrap();

    assert_eq!(w.cover_shortfall(m, target), Ok(400));

    assert_eq!(w.collateral(INSURANCE_SEAT), 0);
    assert_eq!(w.collateral(FEE_SEAT), 600 - 250);
    assert_eq!(w.collateral(target), 0);
    assert_eq!(w.markets[m].params.uncovered_shortfall, 0);
    assert_eq!(w.resume(m), Ok(()));
}

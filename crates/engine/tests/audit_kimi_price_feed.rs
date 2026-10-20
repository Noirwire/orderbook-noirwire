//! Audit replay, price feed: hypotheses H2, H3, H7, H8, H9, H11 and H41 of the
//! exploit catalogue, replayed against the engine through the public harness.
//! Each test asserts the defensive behavior; a failure demonstrates the attack.

mod common;

use common::*;
use noirwire_orderbook_engine::EngineError as E;
use noirwire_orderbook_engine::*;

fn funded(w: &mut World, collateral: u64) -> u32 {
    let seat = w.open();
    w.deposit(seat, Asset::Collateral, collateral).unwrap();
    seat
}

fn buy_from(w: &mut World, m: usize, buyer: u32, seller: u32, price: u64, size: u64) {
    w.place(m, seller, limit(Side::Ask, price, size)).unwrap();
    let outcome = w.place(m, buyer, ioc(Side::Bid, price, size)).unwrap();
    assert_eq!(outcome.filled, size);
}

/// H2. Future-dated, non-monotonic and too-frequent oracle reports.
#[test]
fn h02_future_and_backdated_prices_are_rejected() {
    let mut w = World::new(4, 8);
    let m = w.add_market(perp_params(0));
    assert_eq!(w.publish(m, 1010, w.now + 1), Err(E::PriceFromTheFuture));
    assert_eq!(w.publish(m, 1010, i64::MAX), Err(E::PriceFromTheFuture));
    assert_eq!(w.publish(m, 1010, w.now), Err(E::PriceTimeWentBackwards));
    w.now += 1;
    assert_eq!(w.publish(m, 1010, w.now), Ok(()));
    assert_eq!(w.publish(m, 1010, w.now), Err(E::PriceTimeWentBackwards));
    w.now += 1;
    assert_eq!(w.publish(m, 1000, w.now - 1), Err(E::PriceTimeWentBackwards));

    let mut params = perp_params(1);
    params.min_publish_gap = 10;
    let m2 = w.add_market(params);
    w.now += 10;
    assert_eq!(w.publish(m2, 1000, w.now), Ok(()));
    w.now += 5;
    assert_eq!(w.publish(m2, 1000, w.now), Err(E::PricePublishedTooSoon));
    w.now += 5;
    assert_eq!(w.publish(m2, 1000, w.now), Ok(()));
}

/// H3. A stale feed blocks everything that adds exposure, blocks withdrawals by
/// position holders, and blocks nothing that only reduces risk.
#[test]
fn h03_stale_feed_blocks_exposure_but_not_risk_reduction() {
    let mut w = World::new(10, 8);
    let m = w.add_market(perp_params(0));
    let maker = funded(&mut w, 1_000_000);
    let trader = funded(&mut w, 2_000);
    let flat = funded(&mut w, 500);
    w.place(m, maker, limit(Side::Ask, 1000, 10)).unwrap();
    assert_eq!(w.place(m, trader, ioc(Side::Bid, 1000, 10)).unwrap().filled, 10);
    w.place(m, maker, limit(Side::Bid, 990, 10)).unwrap();
    let resting = w.place(m, trader, limit(Side::Bid, 950, 1)).unwrap();
    let resting_seq = seq(&resting);

    w.now += 61; // older than max_price_age (60 s)
    assert_eq!(w.place(m, trader, limit(Side::Bid, 960, 1)), Err(E::StalePrice));
    assert_eq!(w.place(m, trader, ioc(Side::Bid, 990, 1)), Err(E::StalePrice));
    assert_eq!(w.withdraw(trader, Asset::Collateral, 1), Err(E::StalePrice));
    assert_eq!(w.withdraw(flat, Asset::Collateral, 1), Ok(()));
    assert_eq!(w.deposit(trader, Asset::Collateral, 100), Ok(()));
    assert_eq!(w.cancel(m, trader, resting_seq), Ok(()));

    let reduced = w
        .place(m, trader, reduce_only(ioc(Side::Ask, 980, 5)))
        .unwrap();
    assert_eq!(reduced.filled, 5, "risk reduction works on a stale feed");
    assert_eq!(w.slot(trader, m).base, 5);
}

/// H3. Liquidation keeps working on a feed too stale for orders, up to
/// `max_age_liquidation`, and stops past it.
#[test]
fn h03_liquidation_uses_the_longer_staleness_window() {
    for (age, expect_liquidated) in [(299i64, true), (301, false)] {
        let mut w = World::new(10, 8);
        let m = w.add_market(perp_params(0));
        let maker = funded(&mut w, 1_000_000);
        let liquidator = funded(&mut w, 1_000_000);
        let target = funded(&mut w, 1_100);
        buy_from(&mut w, m, target, maker, 1000, 10);
        w.set_price(m, 900);
        w.now += age;
        let outcome = w.liquidate(m, liquidator, target, 10).unwrap();
        if expect_liquidated {
            assert_eq!(outcome.status, LiquidationStatus::Liquidated);
        } else {
            assert_eq!(outcome.status, LiquidationStatus::StalePrice);
            assert_eq!(outcome.liquidated, 0);
        }
    }
}

/// H7. Trades never move the mark; the only thing self-dealt fills can steer is
/// the funding premium, which is clamped to `funding_cap_bps` and costs fees.
#[test]
fn h07_trades_do_not_move_the_mark_and_funding_premium_is_capped() {
    let mut w = World::new(10, 8);
    let m = w.add_market(perp_params(0));
    let a = funded(&mut w, 500_000);
    let b = funded(&mut w, 500_000);
    w.place(m, a, limit(Side::Ask, 1050, 100)).unwrap();
    let wash = w.place(m, b, ioc(Side::Bid, 1050, 100)).unwrap();
    assert_eq!(wash.filled, 100);
    assert!(wash.fee_paid > 0);
    assert_eq!(w.markets[m].price.price, 1000, "fills never move the mark");
    w.now += 3_600;
    w.set_price(m, 1000);
    assert_eq!(w.fund(m), Ok(true));
    assert_eq!(
        w.markets[m].book.funding_index,
        5,
        "a 5% wash premium is clamped to the 0.5% cap: 1000 * 50 / 10000"
    );
}

/// H8. The per-update move limit rejects jumps, accepts the exact edge, and one
/// maximum update cannot push a seat margined at exactly initial margin below
/// maintenance (RULES 12: max_move_bps < mm_bps - liq_penalty_bps).
#[test]
fn h08_move_limit_and_margin_gap_contain_single_updates() {
    let mut w = World::new(10, 8);
    let m = w.add_market(perp_params(0));
    w.now += 1;
    assert_eq!(w.publish(m, 1300, w.now), Err(E::PriceMoveTooLarge));
    assert_eq!(w.publish(m, 100, w.now), Err(E::PriceMoveTooLarge));
    assert_eq!(w.publish(m, 1030, w.now), Ok(()));

    // A zero-fee market, so a seat can be margined at exactly initial margin.
    let mut params = perp_params(1);
    params.taker_fee_bps = 0;
    let m1 = w.add_market(params);
    w.now += 1;
    w.publish(m1, 1030, w.now).unwrap();
    let maker = funded(&mut w, 1_000_000);
    let trader = funded(&mut w, 1_030);
    w.place(m1, trader, limit(Side::Bid, 1030, 10)).unwrap();
    assert_eq!(w.place(m1, maker, ioc(Side::Ask, 1030, 10)).unwrap().filled, 10);
    assert_eq!(w.equity(trader), 1_030, "margined at exactly initial margin");

    w.now += 1;
    assert_eq!(w.publish(m1, 1000, w.now), Ok(())); // one maximum step down
    assert_eq!(w.equity(trader), 730);
    assert_eq!(w.maintenance_margin(trader), 500);
    assert!(
        !w.is_liquidatable(trader, m1),
        "RULES 12: one allowed update must not make a healthy seat liquidatable"
    );
}

/// H9. Zero prices, off-tick prices, dust sizes and dust notionals are refused.
#[test]
fn h09_zero_off_tick_and_dust_are_refused() {
    let mut w = World::new(10, 8);
    let m = w.add_market(perp_params(0));
    assert_eq!(w.publish(m, 0, w.now), Err(E::ZeroPrice));
    let trader = funded(&mut w, 100_000);
    assert_eq!(w.place(m, trader, limit(Side::Bid, 0, 1)), Err(E::PriceOffTick));
    assert_eq!(w.place(m, trader, limit(Side::Bid, 1005, 1)), Err(E::PriceOffTick));
    assert_eq!(w.place(m, trader, limit(Side::Bid, 1000, 0)), Err(E::SizeTooSmall));

    let mut params = perp_params(1);
    params.min_notional = 200_000;
    let m2 = w.add_market(params);
    assert_eq!(
        w.place(m2, trader, limit(Side::Bid, 1000, 1)),
        Err(E::NotionalTooSmall)
    );
}

/// H11. An order expired at placement is refused; a resting order past its own
/// expiry is cancelled when matching reaches it, never filled, and its margin
/// is released exactly once.
#[test]
fn h11_an_expired_order_never_fills() {
    let mut w = World::new(10, 8);
    let m = w.add_market(perp_params(0));
    let maker = funded(&mut w, 1_000_000);
    let taker = funded(&mut w, 1_000_000);
    assert_eq!(
        w.place(m, maker, expiring(limit(Side::Bid, 990, 1), w.now - 1)),
        Err(E::OrderExpired)
    );
    let rested = w
        .place(m, maker, expiring(limit(Side::Bid, 990, 1), w.now))
        .unwrap();
    assert_eq!(rested.rested, 1, "expiry equal to now is still live");
    let resting_seq = seq(&rested);

    w.now += 1;
    let sweep = w.place(m, taker, ioc(Side::Ask, 980, 1)).unwrap();
    assert_eq!(sizes(&sweep), (0, 0, 1), "the expired maker is cancelled, not filled");
    assert_eq!(w.markets[m].book.bid_count, 0);
    assert_eq!(w.slot(maker, m).open_bid_lots, 0);
    assert_eq!(w.cancel(m, maker, resting_seq), Err(E::OrderNotFound));
}

/// H41. After a rollup outage nothing trades and nothing liquidates on the
/// stale mark; risk reduction still works; a fresh price resumes the market.
#[test]
fn h41_after_a_gap_the_market_waits_for_a_fresh_price() {
    let mut w = World::new(10, 8);
    let m = w.add_market(perp_params(0));
    let maker = funded(&mut w, 1_000_000);
    let trader = funded(&mut w, 2_000);
    let liquidator = funded(&mut w, 1_000_000);
    w.place(m, maker, limit(Side::Ask, 1000, 10)).unwrap();
    assert_eq!(w.place(m, trader, ioc(Side::Bid, 1000, 10)).unwrap().filled, 10);
    w.place(m, maker, limit(Side::Bid, 990, 10)).unwrap();

    w.now += 100_000; // the rollup stood still; the world did not
    assert_eq!(w.place(m, trader, limit(Side::Bid, 960, 1)), Err(E::StalePrice));
    let attempt = w.liquidate(m, liquidator, trader, 10).unwrap();
    assert_eq!(attempt.status, LiquidationStatus::StalePrice);
    assert_eq!(attempt.liquidated, 0);
    let reduced = w
        .place(m, trader, reduce_only(ioc(Side::Ask, 980, 10)))
        .unwrap();
    assert_eq!(reduced.filled, 10, "risk reduction is never blocked");

    assert_eq!(w.publish(m, 1000, w.now), Ok(()));
    assert!(w.place(m, trader, limit(Side::Bid, 960, 1)).is_ok());
}

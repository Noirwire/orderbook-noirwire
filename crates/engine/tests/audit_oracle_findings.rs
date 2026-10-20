//! Audit of the price feed, the reset and funding. Each test states the broken
//! invariant in its final assertion, so a failing run names the finding. The market
//! settings mirror the perp market in `ops/deployment.ts`.

mod common;

use common::*;
use noirwire_orderbook_engine::EngineError as E;
use noirwire_orderbook_engine::*;

const SOL_MARK: u64 = 150_000;

fn deployed_perp() -> MarketParams {
    let mut params = perp_params(0);
    params.band_bps = 400;
    params.im_bps = 1_000;
    params.mm_bps = 500;
    params.taker_fee_bps = 5;
    params.liq_penalty_bps = 200;
    params.funding_cap_bps = 100;
    params.max_move_bps = 250;
    params.max_price_age = 10;
    params.funding_interval = 60;
    params.min_publish_gap = 1;
    params.max_age_liquidation = 60;
    params.open_interest_cap = 10_000_000;
    params.liq_buffer_bps = 100;
    params.liq_insurance_share_bps = 5_000;
    params.fee_insurance_share_bps = 5_000;
    params.max_open_orders = 32;
    assert!(params.check().is_ok());
    params
}

fn deployed_world() -> (World, usize) {
    let mut w = World::new(12, 16);
    let m = w.add_market(deployed_perp());
    w.set_price(m, SOL_MARK);
    (w, m)
}

fn funded(w: &mut World, collateral: u64) -> u32 {
    let seat = w.open();
    w.deposit(seat, Asset::Collateral, collateral).unwrap();
    seat
}

/// The largest step down the move limit allows, kept on the tick.
fn one_step_down(price: u64, params: &MarketParams) -> u64 {
    let step = price * u64::from(params.max_move_bps) / 10_000;
    price - step / params.tick * params.tick
}

/// Tries to publish `steps` prices, all while the rollup clock stands at `w.now`,
/// each stamped one publish gap after the previous one and each the largest allowed
/// move down, never stamped after `w.now`. Returns how many were accepted; a refusal
/// can only be the publish gap.
fn burst_down(w: &mut World, m: usize, steps: i64) -> i64 {
    let params = w.markets[m].params;
    let first_stamp = w.markets[m].price.publish_time;
    let gap = i64::from(params.min_publish_gap);
    let mut accepted = 0;
    for step in 1..=steps {
        let next = one_step_down(w.markets[m].price.price, &params);
        let stamp = first_stamp + (accepted + 1) * gap;
        if stamp > w.now {
            break;
        }
        match w.publish(m, next, stamp) {
            Ok(()) => accepted += 1,
            Err(error) => assert_eq!(error, E::PricePublishedTooSoon, "step {step}"),
        }
    }
    accepted
}

#[test]
fn oracle_1_the_move_limit_is_per_stamped_second_so_one_instant_can_carry_many_steps() {
    let (mut w, m) = deployed_world();
    let params = w.markets[m].params;
    w.now += 10;
    let before = w.markets[m].price.price;

    burst_down(&mut w, m, 10);

    let after = w.markets[m].price.price;
    let moved_bps = (before - after) * 10_000 / before;
    assert!(
        moved_bps <= u64::from(params.max_move_bps),
        "RULES 9: the move limit with the publish gap must bound how fast the mark moves, \
         but with the rollup clock standing still at {} the oracle key moved the mark \
         {before} -> {after} ({moved_bps} bps, limit {} bps per {} s) by stamping ten \
         prices one second apart in the past",
        w.now,
        params.max_move_bps,
        params.min_publish_gap,
    );
}

#[test]
fn oracle_1_a_burst_turns_a_healthy_account_into_bad_debt_with_no_chance_to_liquidate() {
    let (mut w, m) = deployed_world();
    let victim = funded(&mut w, 1_600_000);
    let counterparty = funded(&mut w, 100_000_000);
    let liquidator = funded(&mut w, 100_000_000);
    let bystander = funded(&mut w, 1_000_000);
    w.place(m, victim, limit(Side::Bid, SOL_MARK, 100)).unwrap();
    let opened = w
        .place(m, counterparty, ioc(Side::Ask, SOL_MARK, 100))
        .unwrap();
    assert_eq!(opened.filled, 100);
    assert!(w.equity(victim) >= w.initial_margin(victim));
    w.now += 10;
    assert!(!w.is_liquidatable(victim, m));

    let mut lowest_equity = i128::MAX;
    for _ in 0..10 {
        burst_down(&mut w, m, 10);
        lowest_equity = lowest_equity.min(w.equity(victim));
        if w.is_liquidatable(victim, m) {
            w.liquidate(m, liquidator, victim, 100).unwrap();
        }
        w.now += 1;
    }

    let shortfall = w.markets[m].params.uncovered_shortfall;
    let bystander_withdrawal = w.withdraw(bystander, Asset::Collateral, 1);
    assert_eq!(
        (shortfall, bystander_withdrawal),
        (0, Ok(())),
        "RULES 12: max_move_bps < mm_bps - liq_penalty_bps is meant to stop one price \
         update from taking a healthy account past insolvency before a liquidator can \
         act, but an account at initial margin went down to equity {lowest_equity} \
         between two liquidation chances, the market recorded an uncovered shortfall of \
         {shortfall}, and the bystander's collateral withdrawal returned \
         {bystander_withdrawal:?}"
    );
}

/// One wash fill of `size` lots at the edge of the band between two seats the
/// attacker owns, then the funding update. Returns the taker fee paid.
fn wash_and_fund(w: &mut World, m: usize, maker: u32, taker: u32, size: u64) -> u64 {
    let params = w.markets[m].params;
    let mark = w.markets[m].price.price;
    let edge = mark + mark * u64::from(params.band_bps) / 10_000;
    w.place(m, maker, limit(Side::Ask, edge, size)).unwrap();
    let outcome = w.place(m, taker, ioc(Side::Bid, edge, size)).unwrap();
    assert_eq!(outcome.filled, size);
    assert_eq!(w.fund(m), Ok(true));
    outcome.fee_paid
}

#[test]
fn oracle_2_a_one_lot_wash_per_interval_sets_funding_to_the_cap_for_the_whole_market() {
    let (mut w, m) = deployed_world();
    let victim = funded(&mut w, 1_600_000);
    let attacker = funded(&mut w, 100_000_000);
    let wash_a = funded(&mut w, 1_000_000);
    let wash_b = funded(&mut w, 1_000_000);
    w.place(m, attacker, limit(Side::Ask, SOL_MARK, 100))
        .unwrap();
    let opened = w.place(m, victim, ioc(Side::Bid, SOL_MARK, 100)).unwrap();
    assert_eq!(opened.filled, 100);
    w.now += 60;
    w.publish(m, SOL_MARK, w.now).unwrap();
    assert_eq!(w.fund(m), Ok(true));
    assert_eq!(w.markets[m].book.funding_index, 0);
    let attacker_seats = [attacker, wash_a, wash_b];
    let worth = |w: &World| -> i128 { attacker_seats.iter().map(|s| w.equity(*s)).sum() };
    let attacker_before = worth(&w);
    let victim_before = w.equity(victim);

    let mut fees = 0u64;
    for interval in 0..6 {
        w.now += 60;
        w.publish(m, SOL_MARK, w.now).unwrap();
        let (maker, taker) = if interval % 2 == 0 {
            (wash_a, wash_b)
        } else {
            (wash_b, wash_a)
        };
        fees += wash_and_fund(&mut w, m, maker, taker, 1);
    }

    let per_interval = SOL_MARK as i64 * 100 / 10_000;
    assert_eq!(w.markets[m].book.funding_index, 6 * per_interval);
    let gained = worth(&w) - attacker_before;
    let victim_lost = victim_before - w.equity(victim);
    assert_eq!(victim_lost, 100 * 6 * i128::from(per_interval));
    assert!(w.is_liquidatable(victim, m));
    assert!(
        gained <= i128::from(fees),
        "RULES 7 says moving funding costs taker fees, but a {}-lot wash per interval \
         (fees {fees} in total) drove the premium to the {} bps cap six times; the victim's \
         100-lot long paid {victim_lost} and is now liquidatable, and the attacker's seats \
         gained {gained}",
        1,
        w.markets[m].params.funding_cap_bps,
    );
}

#[test]
fn oracle_2_a_fill_at_its_own_mark_carries_a_premium_once_the_mark_moves() {
    let (mut w, m) = deployed_world();
    let params = w.markets[m].params;
    let long = funded(&mut w, 10_000_000);
    let short = funded(&mut w, 10_000_000);
    w.place(m, short, limit(Side::Ask, SOL_MARK, 10)).unwrap();
    w.place(m, long, ioc(Side::Bid, SOL_MARK, 10)).unwrap();
    let up_one = SOL_MARK + SOL_MARK * u64::from(params.max_move_bps) / 10_000;
    let up_two = up_one + (up_one * u64::from(params.max_move_bps) / 10_000) / 10 * 10;
    w.now += 30;
    w.publish(m, up_one, w.now).unwrap();
    w.now += 30;
    w.publish(m, up_two, w.now).unwrap();

    assert_eq!(w.fund(m), Ok(true));

    let index = w.markets[m].book.funding_index;
    assert_eq!(
        index, 0,
        "RULES 7: funding is meant to follow the premium of trades over the mark, but \
         the only fill was at exactly the mark of its moment ({SOL_MARK}); the mark then \
         rose to {up_two} and the update compared the old fill with the new mark, moving \
         F by {index} per lot (the cap), so shorts paid longs for a premium nobody traded"
    );
}

#[test]
fn oracle_3_a_reset_stamped_in_the_future_freezes_the_feed_and_liquidation() {
    let mut w = World::new(10, 8);
    let m = w.add_market(perp_params(0));
    let maker = funded(&mut w, 100_000);
    let liquidator = funded(&mut w, 100_000);
    let target = funded(&mut w, 1_100);
    w.place(m, maker, limit(Side::Ask, 1_000, 10)).unwrap();
    w.place(m, target, ioc(Side::Bid, 1_000, 10)).unwrap();
    let in_milliseconds = w.now * 1_000;
    let feed_before = w.markets[m].price;

    let future_reset = w.reset(m, 900, in_milliseconds);
    let feed_after_future_reset = w.markets[m].price;
    assert_eq!(w.reset(m, 900, w.now), Ok(()));

    assert!(w.equity(target) * 10_000 < 10 * 900 * 500);
    w.now += 1;
    assert_eq!(w.publish(m, 900, w.now), Ok(()));
    assert!(w.is_liquidatable(target, m));
    let outcome = w.liquidate(m, liquidator, target, 10).unwrap();
    assert_eq!(outcome.status, LiquidationStatus::Liquidated);
    assert_eq!(
        (future_reset, feed_after_future_reset),
        (Err(E::PriceFromTheFuture), feed_before),
        "RULES 9: a reset is the admin's way to restore a usable price, but one stamped \
         in the future ({in_milliseconds}, now {}) was accepted; it makes the feed stale \
         for trading, funding and liquidation until the clock reaches that time, and \
         refuses every publish by the oracle",
        w.now
    );
}

//! RULES 9 and 9a: the price source. Observations, scaling, the incident machine, the
//! USDC guard, and what an open incident blocks across the exchange.

mod common;

use bytemuck::Zeroable;
use common::*;
use noirwire_orderbook_engine::*;
use proptest::prelude::*;

type E = EngineError;

/// SOL/USD as Pyth publishes it, priced per lot of 0.001 SOL in a 6-decimal quote token.
fn sol_binding() -> SourceBinding {
    SourceBinding {
        expo: -8,
        max_conf_bps: 100,
        base_decimals: 9,
        quote_decimals: 6,
        ..SourceBinding::zeroed()
    }
}

/// A source quoted directly in quote atoms per lot of one atom, so a target equals the
/// raw price and the numbers below read as marks.
fn unit_binding() -> SourceBinding {
    SourceBinding {
        max_conf_bps: 100,
        ..SourceBinding::zeroed()
    }
}

const SOL_LOT: u64 = 1_000_000;
const WINDOW: i64 = 900;

fn seen(price: i64, publish_time: i64) -> Observation {
    Observation {
        price,
        conf: 0,
        publish_time,
    }
}

/// One market's feed and settings, outside any exchange.
struct Feed {
    feed: PriceFeed,
    params: MarketParams,
    now: i64,
}

impl Feed {
    fn new() -> Feed {
        let mut params = perp_params(0);
        params.settle_window = WINDOW;
        let mut feed = PriceFeed::zeroed();
        feed.binding = unit_binding();
        Feed {
            feed,
            params,
            now: START,
        }
    }

    /// A feed whose mark is `mark`, taken from the source at `START`, on a market the
    /// admin then resumed.
    fn at(mark: i64) -> Feed {
        let mut feed = Feed::new();
        feed.sync(mark, START).unwrap();
        resume_market(&mut feed.params, &[]).unwrap();
        feed
    }

    fn mark(&self) -> u64 {
        self.feed.price.price
    }

    fn health(&self) -> u8 {
        self.params.oracle_health
    }

    fn after(&mut self, seconds: i64) -> &mut Feed {
        self.now += seconds;
        self
    }

    /// Syncs, and checks that a refusal wrote nothing.
    fn sync_seen(&mut self, observed: Observation) -> EngineResult<()> {
        let before = (self.feed, self.params);
        let result = sync_source(&mut self.feed, &mut self.params, &observed, self.now);
        if result.is_err() {
            assert_eq!((self.feed, self.params), before, "a refused sync wrote");
        }
        result
    }

    fn sync(&mut self, price: i64, publish_time: i64) -> EngineResult<()> {
        self.sync_seen(seen(price, publish_time))
    }

    /// The next observation, stamped now.
    fn next(&mut self, price: i64) -> EngineResult<()> {
        self.sync(price, self.now)
    }
}

#[test]
fn sol_at_103_85_is_103_850_atoms_per_lot_and_150_dollars_is_the_deployed_mark() {
    let binding = sol_binding();
    assert_eq!(price_scale(-8, 9, 6), Ok(-11));
    assert_eq!(
        observed_mark(10_385_000_000, SOL_LOT, &binding),
        Ok(103_850)
    );
    assert_eq!(
        observed_mark(15_000_000_000, SOL_LOT, &binding),
        Ok(150_000)
    );
    assert_eq!(
        observed_mark(10_384_799_999, SOL_LOT, &binding),
        Ok(103_847),
        "rounded down, less than one atom low"
    );
}

#[test]
fn a_positive_scale_multiplies_and_a_negative_one_divides() {
    let up = SourceBinding {
        expo: 0,
        base_decimals: 0,
        quote_decimals: 6,
        ..unit_binding()
    };
    assert_eq!(observed_mark(3, 2, &up), Ok(6_000_000));
    let down = SourceBinding {
        expo: -2,
        ..unit_binding()
    };
    assert_eq!(observed_mark(12_345, 1, &down), Ok(123));
}

#[test]
fn a_scale_beyond_thirty_is_refused_and_thirty_is_not() {
    assert_eq!(price_scale(-30, 0, 0), Ok(-30));
    assert_eq!(price_scale(24, 0, 6), Ok(30));
    assert_eq!(price_scale(-31, 0, 0), Err(E::InvalidMarketParams));
    assert_eq!(price_scale(-12, 25, 6), Err(E::InvalidMarketParams));
    assert_eq!(price_scale(i32::MAX, 0, 6), Err(E::MathOverflow));
}

#[test]
fn a_mark_of_zero_or_above_the_highest_price_is_refused_and_so_is_an_overflow() {
    let sol = sol_binding();
    assert_eq!(observed_mark(1, SOL_LOT, &sol), Err(E::ZeroPrice));
    assert_eq!(observed_mark(0, SOL_LOT, &sol), Err(E::ZeroPrice));
    let unit = unit_binding();
    assert_eq!(observed_mark(MAX_PRICE, 1, &unit), Ok(MAX_PRICE));
    assert_eq!(observed_mark(MAX_PRICE + 1, 1, &unit), Err(E::PriceTooHigh));
    let huge = SourceBinding {
        expo: 30,
        ..unit_binding()
    };
    assert_eq!(
        observed_mark(u64::MAX, u64::MAX, &huge),
        Err(E::PriceTooHigh),
        "an overflow is a price too high, not a failure of the arithmetic"
    );
}

#[test]
fn the_first_observation_becomes_the_mark() {
    let mut feed = Feed::new();
    feed.sync(1_000, START - 5).unwrap();
    assert_eq!(
        feed.feed.price,
        Price {
            price: 1_000,
            publish_time: START - 5,
            accepted_at: START,
        }
    );
    assert_eq!(
        feed.feed.source,
        SourceRecord {
            raw_price: 1_000,
            conf: 0,
            publish_time: START - 5,
            target: 1_000,
            observed_at: START,
        }
    );
    assert_eq!(feed.health(), ORACLE_HEALTHY);
    assert_eq!(
        feed.params.status, STATUS_REDUCE_ONLY,
        "nothing bounds a first mark, so it opens nothing until resume_market"
    );
}

#[test]
fn a_first_mark_on_a_paused_market_leaves_it_paused() {
    let mut feed = Feed::new();
    feed.params.status = STATUS_PAUSED;
    feed.sync(1_000, START).unwrap();
    assert_eq!(feed.mark(), 1_000);
    assert_eq!(feed.params.status, STATUS_PAUSED);
}

#[test]
fn the_confidence_interval_may_reach_max_conf_bps_of_the_price_and_no_further() {
    let mut feed = Feed::new();
    let edge = Observation {
        price: 1_000_000,
        conf: 10_000,
        publish_time: START,
    };
    let wider = Observation {
        conf: 10_001,
        ..edge
    };
    assert_eq!(feed.sync_seen(wider), Err(E::PriceConfidenceTooWide));
    assert_eq!(feed.sync_seen(edge), Ok(()));
}

#[test]
fn an_observation_that_is_not_newer_or_from_the_future_or_too_old_is_refused() {
    let mut feed = Feed::at(1_000);
    feed.after(5);
    assert_eq!(feed.sync(1_000, START), Err(E::PriceTimeWentBackwards));
    assert_eq!(feed.sync(1_000, START - 1), Err(E::PriceTimeWentBackwards));
    assert_eq!(feed.sync(1_000, feed.now + 1), Err(E::PriceFromTheFuture));
    let max_age = feed.params.max_price_age;
    feed.after(max_age);
    assert_eq!(feed.sync(1_000, START + 4), Err(E::PriceTooOld));
    assert_eq!(
        feed.sync(1_000, START + 5),
        Ok(()),
        "exactly max_price_age old"
    );
    assert_eq!(feed.sync(0, feed.now), Err(E::ZeroPrice));
    assert_eq!(feed.sync(-1_000, feed.now), Err(E::ZeroPrice));
}

#[test]
fn a_mark_change_waits_the_gap_in_both_clocks() {
    let mut feed = Feed::at(1_000);
    feed.params.min_publish_gap = 3;
    feed.after(2);
    assert_eq!(feed.next(1_010), Err(E::PricePublishedTooSoon));
    feed.after(1);
    assert_eq!(
        feed.sync(1_010, START + 2),
        Err(E::PricePublishedTooSoon),
        "stamped too close to the mark"
    );
    assert_eq!(feed.next(1_010), Ok(()));
    assert_eq!(feed.mark(), 1_010);
}

#[test]
fn healthy_within_the_limit_follows_the_source() {
    let mut feed = Feed::at(1_000);
    feed.after(1).next(1_030).unwrap();
    assert_eq!(feed.mark(), 1_030, "3% is the limit itself");
    assert_eq!(feed.health(), ORACLE_HEALTHY);
}

#[test]
fn healthy_beyond_the_limit_keeps_the_mark_and_opens_an_incident() {
    let mut feed = Feed::at(1_000);
    let mark_before = feed.feed.price;
    feed.after(1).next(800).unwrap();
    assert_eq!(feed.feed.price, mark_before, "the mark does not move");
    assert_eq!(feed.health(), ORACLE_DISLOCATED);
    assert_eq!(
        feed.feed.incident,
        Incident {
            since: START + 1,
            settle_until: 0,
            gap_bps: 2_000,
            reason: INCIDENT_MOVE_BEYOND_LIMIT,
            _padding: [0; 5],
        }
    );
    assert_eq!(feed.feed.source.target, 800, "the observation is recorded");
    assert_eq!(feed.params.status, STATUS_ACTIVE);
}

#[test]
fn dislocated_then_within_the_frozen_mark_is_a_transient_print() {
    let mut feed = Feed::at(1_000);
    feed.after(1).next(800).unwrap();
    feed.after(1).next(1_020).unwrap();
    assert_eq!(feed.mark(), 1_020);
    assert_eq!(feed.health(), ORACLE_HEALTHY);
    assert_eq!(feed.params.status, STATUS_ACTIVE);
}

#[test]
fn a_confirmed_gap_settles_at_the_source_and_turns_the_market_reduce_only() {
    let mut feed = Feed::at(1_000);
    feed.after(1).next(800).unwrap();
    let since = feed.now;
    feed.after(1).next(790).unwrap();
    assert_eq!(feed.mark(), 790);
    assert_eq!(feed.feed.price.publish_time, feed.now);
    assert_eq!(feed.health(), ORACLE_SETTLING);
    assert_eq!(feed.params.status, STATUS_REDUCE_ONLY);
    assert_eq!(
        feed.feed.incident,
        Incident {
            since,
            settle_until: feed.now + WINDOW,
            gap_bps: 2_100,
            reason: INCIDENT_SETTLED_GAP,
            _padding: [0; 5],
        }
    );
}

#[test]
fn a_gap_is_not_confirmed_sooner_than_min_publish_gap_after_it_opened() {
    let mut feed = Feed::at(1_000);
    feed.params.min_publish_gap = 3;
    feed.after(3).next(800).unwrap();
    feed.after(2);
    assert_eq!(feed.next(790), Err(E::PricePublishedTooSoon));
    feed.after(1).next(790).unwrap();
    assert_eq!(feed.health(), ORACLE_SETTLING);
}

#[test]
fn a_paused_market_stays_paused_through_a_settlement() {
    let mut feed = Feed::at(1_000);
    feed.params.status = STATUS_PAUSED;
    feed.after(1).next(1_500).unwrap();
    feed.after(1).next(1_500).unwrap();
    assert_eq!(feed.health(), ORACLE_SETTLING);
    assert_eq!(feed.params.status, STATUS_PAUSED);
    assert_eq!(feed.mark(), 1_500);
}

#[test]
fn settling_follows_the_source_and_turns_healthy_only_after_the_window() {
    let mut feed = Feed::at(1_000);
    feed.after(1).next(800).unwrap();
    feed.after(1).next(800).unwrap();
    let ends = feed.feed.incident.settle_until;
    feed.after(1).next(810).unwrap();
    assert_eq!((feed.mark(), feed.health()), (810, ORACLE_SETTLING));
    feed.now = ends - 1;
    feed.next(812).unwrap();
    assert_eq!(feed.health(), ORACLE_SETTLING);
    feed.now = ends;
    feed.next(815).unwrap();
    assert_eq!((feed.mark(), feed.health()), (815, ORACLE_HEALTHY));
    assert_eq!(
        feed.params.status, STATUS_REDUCE_ONLY,
        "only resume_market lifts reduce-only"
    );
}

#[test]
fn settling_beyond_the_limit_is_dislocated_again() {
    let mut feed = Feed::at(1_000);
    feed.after(1).next(800).unwrap();
    feed.after(1).next(800).unwrap();
    let ends = feed.feed.incident.settle_until;
    feed.after(1).next(600).unwrap();
    assert_eq!((feed.mark(), feed.health()), (800, ORACLE_DISLOCATED));
    assert_eq!(feed.feed.incident.since, feed.now);
    assert_eq!(feed.feed.incident.reason, INCIDENT_MOVE_BEYOND_LIMIT);
    assert_eq!(
        feed.feed.incident.settle_until, ends,
        "the settlement's window still runs"
    );
}

#[test]
fn a_dislocation_during_a_settlement_cannot_end_its_window_early() {
    let mut feed = Feed::at(1_000);
    feed.after(1).next(800).unwrap();
    feed.after(1).next(800).unwrap();
    let ends = feed.feed.incident.settle_until;
    feed.after(10).next(600).unwrap();
    assert_eq!(feed.health(), ORACLE_DISLOCATED);
    feed.after(1).next(810).unwrap();
    assert_eq!((feed.mark(), feed.health()), (810, ORACLE_SETTLING));
    feed.now = ends - 1;
    feed.next(600).unwrap();
    feed.now = ends;
    feed.next(812).unwrap();
    assert_eq!((feed.mark(), feed.health()), (812, ORACLE_HEALTHY));
}

#[test]
fn a_dislocation_that_outlives_the_window_ends_healthy() {
    let mut feed = Feed::at(1_000);
    feed.after(1).next(800).unwrap();
    feed.after(1).next(800).unwrap();
    let ends = feed.feed.incident.settle_until;
    feed.after(1).next(600).unwrap();
    feed.now = ends;
    feed.next(805).unwrap();
    assert_eq!((feed.mark(), feed.health()), (805, ORACLE_HEALTHY));
}

#[test]
fn settling_again_keeps_the_later_end() {
    let mut feed = Feed::at(1_000);
    feed.after(1).next(800).unwrap();
    feed.after(1).next(800).unwrap();
    let ends = feed.feed.incident.settle_until;
    feed.after(1).next(600).unwrap();
    feed.after(1).next(600).unwrap();
    assert_eq!((feed.mark(), feed.health()), (600, ORACLE_SETTLING));
    assert_eq!(feed.feed.incident.settle_until, feed.now + WINDOW);
    let later = feed.feed.incident.settle_until;
    feed.params.settle_window = 10;
    feed.after(1).next(400).unwrap();
    feed.after(1).next(400).unwrap();
    assert_eq!(feed.feed.incident.settle_until, later, "never shortened");
    assert!(later > ends);
}

#[test]
fn a_fresh_dislocation_after_a_finished_settlement_has_no_window() {
    let mut feed = Feed::at(1_000);
    feed.after(1).next(800).unwrap();
    feed.after(1).next(800).unwrap();
    feed.now = feed.feed.incident.settle_until;
    feed.next(805).unwrap();
    assert_eq!(feed.health(), ORACLE_HEALTHY);
    feed.after(1).next(600).unwrap();
    assert_eq!(feed.feed.incident.settle_until, 0);
    feed.after(1).next(805).unwrap();
    assert_eq!(feed.health(), ORACLE_HEALTHY, "a transient print");
}

#[test]
fn a_duplicate_cannot_renew_freshness_or_end_an_incident() {
    let mut feed = Feed::at(1_000);
    feed.after(1).next(800).unwrap();
    let published = feed.now;
    feed.after(1);
    assert_eq!(feed.sync(800, published), Err(E::PriceTimeWentBackwards));
    assert_eq!(feed.sync(1_000, published), Err(E::PriceTimeWentBackwards));
    assert_eq!(feed.health(), ORACLE_DISLOCATED);
}

#[test]
fn the_sol_fixture_becomes_a_mark_through_the_sol_binding() {
    let mut feed = Feed::new();
    feed.feed.binding = sol_binding();
    feed.params.base_lot = SOL_LOT;
    feed.now = 1_792_525_160;
    let fixture = Observation {
        price: 10_565_598_655,
        conf: 2_539_594,
        publish_time: 1_792_525_157,
    };
    feed.sync_seen(fixture).unwrap();
    assert_eq!(feed.mark(), 105_655);
}

#[derive(Clone, Debug)]
struct Step {
    wait: i64,
    stamped_back: i64,
    move_bps: i64,
}

fn step() -> impl Strategy<Value = Step> {
    (0i64..4, 0i64..3, -2_500i64..2_500).prop_map(|(wait, stamped_back, move_bps)| Step {
        wait,
        stamped_back,
        move_bps,
    })
}

proptest! {
    #[test]
    fn while_healthy_the_mark_moves_at_most_one_limit_per_gap_and_only_a_settlement_moves_it_further(
        steps in prop::collection::vec(step(), 1..60),
        paused in any::<bool>(),
    ) {
        let mut feed = Feed::at(100_000);
        if paused {
            feed.params.status = STATUS_PAUSED;
        }
        let mut window_end = i64::MIN;
        for step in steps {
            feed.after(step.wait);
            let base = i64::try_from(feed.feed.source.target).unwrap();
            let price = (base + base * step.move_bps / 10_000).max(1);
            let before = (feed.feed, feed.params);
            let result = feed.sync(price, feed.now - step.stamped_back);
            let (old, old_params) = before;
            let new = feed.feed.price;
            if result.is_err() {
                continue;
            }
            if feed.feed.incident.reason == INCIDENT_SETTLED_GAP {
                window_end = window_end.max(feed.feed.incident.settle_until);
            }
            if feed.health() == ORACLE_HEALTHY {
                prop_assert!(feed.now >= window_end, "a settlement's window ended early");
            }
            prop_assert!(feed.feed.source.publish_time > old.source.publish_time);
            prop_assert!(new.publish_time <= feed.feed.source.publish_time);
            prop_assert!(feed.feed.source.publish_time <= feed.now);
            prop_assert!(new.price > 0 && new.price <= MAX_PRICE);
            if new == old.price {
                continue;
            }
            let gap = i64::from(feed.params.min_publish_gap);
            prop_assert!(new.publish_time - old.price.publish_time >= gap);
            prop_assert!(new.accepted_at - old.price.accepted_at >= gap);
            let moved = u128::from(new.price.abs_diff(old.price.price)) * 10_000;
            let limit = u128::from(old.price.price) * u128::from(feed.params.max_move_bps);
            if moved > limit {
                prop_assert_eq!(old_params.oracle_health, ORACLE_DISLOCATED);
                prop_assert_eq!(feed.health(), ORACLE_SETTLING);
                let expected = if paused { STATUS_PAUSED } else { STATUS_REDUCE_ONLY };
                prop_assert_eq!(feed.params.status, expected);
            } else {
                prop_assert_ne!(feed.health(), ORACLE_DISLOCATED);
            }
        }
    }
}

/// A perp exchange with no fees and no funding, so equity is exact, and two markets.
fn two_perps() -> World {
    let mut w = World::new(10, 8);
    for id in 0..2 {
        let mut params = free_perp();
        params.market_id = id;
        params.settle_window = WINDOW;
        let m = w.add_market(params);
        w.set_price(m, 100);
    }
    w
}

fn dislocate(w: &mut World, m: usize) {
    w.markets[m].params.oracle_health = ORACLE_DISLOCATED;
}

#[test]
fn a_dislocation_blocks_withdrawals_orders_and_liquidation_and_the_settlement_realises_the_gap() {
    let mut w = two_perps();
    let long = funded(&mut w, 500);
    let short = funded(&mut w, 10_000);
    let liquidator = funded(&mut w, 10_000);
    buy_from(&mut w, 0, long, short, 100, 10);
    assert_eq!(w.equity(long), 500);

    let mut feed = PriceFeed::zeroed();
    feed.binding = unit_binding();
    feed.source.publish_time = START;
    w.now += 1;
    w.sync(0, &mut feed, seen(80, w.now)).unwrap();
    assert_eq!(w.markets[0].params.oracle_health, ORACLE_DISLOCATED);
    assert_eq!(w.markets[0].price.price, 100, "the mark does not follow");

    assert_eq!(
        w.withdraw(long, Asset::Collateral, 1),
        Err(E::OracleIncident)
    );
    assert_eq!(
        w.withdraw(liquidator, Asset::Collateral, 1),
        Err(E::OracleIncident),
        "exchange-wide"
    );
    assert_eq!(
        w.place(0, long, reduce_only(ioc(Side::Ask, 100, 10))),
        Err(E::OracleDislocated)
    );
    assert_eq!(
        w.place(0, liquidator, limit(Side::Bid, 100, 1)),
        Err(E::OracleDislocated)
    );
    let outcome = w.liquidate(0, liquidator, long, 10).unwrap();
    assert_eq!(outcome.status, LiquidationStatus::StalePrice);

    w.now += 1;
    w.sync(0, &mut feed, seen(80, w.now)).unwrap();
    assert_eq!(w.markets[0].params.oracle_health, ORACLE_SETTLING);
    assert_eq!(w.markets[0].price.price, 80);
    assert_eq!(w.equity(long), 300);
    assert_eq!(w.markets[0].params.status, STATUS_REDUCE_ONLY);
    assert_eq!(
        w.withdraw(short, Asset::Collateral, 1),
        Err(E::OracleIncident),
        "still settling"
    );
    w.deposit(long, Asset::Collateral, 1).unwrap();
}

#[test]
fn withdrawals_stay_shut_for_the_whole_window_through_a_second_dislocation() {
    let mut w = two_perps();
    let seat = funded(&mut w, 1_000);
    let mut feed = PriceFeed::zeroed();
    feed.binding = unit_binding();
    feed.source.publish_time = START;
    w.now += 1;
    w.sync(0, &mut feed, seen(80, w.now)).unwrap();
    w.now += 1;
    w.sync(0, &mut feed, seen(80, w.now)).unwrap();
    let ends = feed.incident.settle_until;
    w.now += 10;
    w.sync(0, &mut feed, seen(60, w.now)).unwrap();
    w.now += 1;
    w.sync(0, &mut feed, seen(81, w.now)).unwrap();
    assert_eq!(w.markets[0].params.oracle_health, ORACLE_SETTLING);
    assert_eq!(
        w.withdraw(seat, Asset::Collateral, 1),
        Err(E::OracleIncident),
        "before settle_until"
    );
    w.now = ends;
    w.sync(0, &mut feed, seen(82, w.now)).unwrap();
    assert_eq!(w.markets[0].params.oracle_health, ORACLE_HEALTHY);
    assert_eq!(w.withdraw(seat, Asset::Collateral, 1), Ok(()));
}

#[test]
fn a_resting_order_of_a_seat_holding_a_dislocated_market_is_cancelled_when_reached() {
    let mut w = two_perps();
    let maker = funded(&mut w, 10_000);
    let other = funded(&mut w, 10_000);
    let taker = funded(&mut w, 10_000);
    buy_from(&mut w, 0, maker, other, 100, 1);
    w.place(1, maker, limit(Side::Ask, 100, 5)).unwrap();
    dislocate(&mut w, 0);
    let outcome = w.place(1, taker, ioc(Side::Bid, 100, 5)).unwrap();
    assert_eq!(outcome.filled, 0);
    assert!(w.markets[1].resting(Side::Ask).is_empty());
}

#[test]
fn a_seat_holding_a_dislocated_market_cannot_trade_be_liquidated_or_liquidate_elsewhere() {
    let mut w = two_perps();
    let holder = funded(&mut w, 2_000);
    let other = funded(&mut w, 10_000);
    let target = funded(&mut w, 120);
    let maker = funded(&mut w, 10_000);
    buy_from(&mut w, 0, holder, other, 100, 5);
    buy_from(&mut w, 1, holder, other, 100, 5);
    buy_from(&mut w, 0, target, other, 100, 1);
    buy_from(&mut w, 1, target, other, 100, 10);
    w.set_price(1, 92);
    assert!(w.is_liquidatable(target, 1));
    w.place(1, maker, limit(Side::Ask, 100, 5)).unwrap();
    dislocate(&mut w, 0);

    assert_eq!(
        w.place(1, holder, limit(Side::Bid, 90, 1)),
        Err(E::OracleDislocated)
    );
    assert_eq!(
        w.place(1, holder, reduce_only(ioc(Side::Ask, 90, 1))),
        Err(E::OracleDislocated),
        "refused up front, not by the fill checks"
    );
    let as_target = w.liquidate(1, maker, target, 10).unwrap();
    assert_eq!(as_target.status, LiquidationStatus::NotLiquidatable);
    let as_liquidator = w.liquidate(1, holder, target, 10).unwrap();
    assert_eq!(as_liquidator.status, LiquidationStatus::StalePrice);
    w.cancel_all(1, maker, 8).unwrap();
}

#[test]
fn a_settling_market_blocks_collateral_and_fee_payouts_but_not_spot_withdrawals() {
    let mut w = two_perps();
    let spot = w.add_market(spot_params(2));
    w.set_price(spot, 1_000);
    let seat = funded(&mut w, 1_000);
    w.deposit(seat, Asset::Spot(BASE), 100).unwrap();
    w.markets[1].params.oracle_health = ORACLE_SETTLING;
    assert_eq!(
        w.withdraw(seat, Asset::Collateral, 1),
        Err(E::OracleIncident)
    );
    assert_eq!(w.withdraw(seat, Asset::Spot(BASE), 1), Ok(()));
    assert_eq!(w.collect_fees(Asset::Collateral, 1), Err(E::OracleIncident));
    w.markets[1].params.oracle_health = ORACLE_HEALTHY;
    assert_eq!(w.withdraw(seat, Asset::Collateral, 1), Ok(()));
}

#[test]
fn a_dislocated_spot_market_takes_no_orders() {
    let mut w = World::new(10, 8);
    let spot = w.add_market(spot_params(0));
    let seat = w.open();
    w.deposit(seat, Asset::Spot(QUOTE), 1_000_000).unwrap();
    dislocate(&mut w, spot);
    assert_eq!(
        w.place(spot, seat, limit(Side::Bid, 1_000, 1)),
        Err(E::OracleDislocated)
    );
}

#[test]
fn resume_market_waits_for_a_healthy_source() {
    let mut w = two_perps();
    w.markets[0].params.status = STATUS_REDUCE_ONLY;
    for health in [ORACLE_DISLOCATED, ORACLE_SETTLING] {
        w.markets[0].params.oracle_health = health;
        assert_eq!(w.resume(0), Err(E::OracleIncident));
    }
    w.markets[0].params.oracle_health = ORACLE_HEALTHY;
    assert_eq!(w.resume(0), Ok(()));
    assert_eq!(w.markets[0].params.status, STATUS_ACTIVE);
}

#[test]
fn an_interval_that_ends_during_an_incident_is_discarded() {
    let mut w = World::new(10, 8);
    let m = w.add_market(perp_params(0));
    let long = funded(&mut w, 10_000);
    let short = funded(&mut w, 10_000);
    buy_from(&mut w, m, long, short, 1_020, 2);
    let index = w.markets[m].book.funding_index;
    assert!(w.markets[m].book.traded_size > 0);
    w.markets[m].params.oracle_health = ORACLE_SETTLING;
    w.now += w.markets[m].params.funding_interval;
    assert_eq!(w.fund(m), Ok(true));
    let book = w.markets[m].book;
    assert_eq!(book.funding_index, index);
    assert_eq!((book.traded_premium, book.traded_size), (0, 0));
    assert_eq!(book.last_funding_time, w.now);
}

#[test]
fn a_fill_while_settling_adds_nothing_to_the_funding_totals() {
    let mut w = World::new(10, 8);
    let m = w.add_market(perp_params(0));
    let long = funded(&mut w, 10_000);
    let short = funded(&mut w, 10_000);
    buy_from(&mut w, m, long, short, 1_000, 4);
    let totals = (
        w.markets[m].book.traded_premium,
        w.markets[m].book.traded_size,
    );
    w.markets[m].params.oracle_health = ORACLE_SETTLING;
    w.place(m, short, limit(Side::Bid, 1_000, 2)).unwrap();
    let outcome = w
        .place(m, long, reduce_only(ioc(Side::Ask, 1_000, 2)))
        .unwrap();
    assert_eq!(outcome.filled, 2);
    let after = (
        w.markets[m].book.traded_premium,
        w.markets[m].book.traded_size,
    );
    assert_eq!(after, totals);
}

#[test]
fn a_tripped_usdc_guard_blocks_increases_on_perps_only_and_never_exits() {
    let mut w = World::new(10, 8);
    let m = w.add_market(perp_params(0));
    let spot = w.add_market(spot_params(1));
    let long = funded(&mut w, 10_000);
    let short = funded(&mut w, 10_000);
    buy_from(&mut w, m, long, short, 1_000, 2);
    w.deposit(long, Asset::Spot(QUOTE), 1_000_000).unwrap();
    w.quote_ok = false;

    assert_eq!(
        w.place(m, long, limit(Side::Bid, 1_000, 1)),
        Err(E::QuoteGuardTripped)
    );
    w.place(m, short, limit(Side::Bid, 1_000, 1)).unwrap_err();
    w.place(spot, long, limit(Side::Bid, 1_000, 1)).unwrap();
    w.place(m, short, reduce_only(ioc(Side::Bid, 1_000, 1)))
        .unwrap();
    assert_eq!(w.withdraw(long, Asset::Collateral, 100), Ok(()));
    let liquidation = w.liquidate(m, short, long, 1).unwrap();
    assert_eq!(liquidation.status, LiquidationStatus::NotLiquidatable);
}

fn usdc_rules() -> QuoteRules {
    QuoteRules {
        expo: -8,
        max_conf_bps: 100,
        depeg_bps: 100,
        max_age: 180,
    }
}

#[test]
fn the_usdc_fixture_passes_the_guard_until_its_age_runs_out() {
    let fixture = Observation {
        price: 99_979_885,
        conf: 9_197,
        publish_time: 1_792_525_146,
    };
    let now = 1_792_525_160;
    assert_eq!(
        check_quote(&usdc_rules(), 0, &fixture, now),
        Ok(QuoteVerdict::Healthy {
            ok_until: 1_792_525_146 + 180
        })
    );
    assert_eq!(
        check_quote(&usdc_rules(), fixture.publish_time, &fixture, now),
        Err(E::PriceTimeWentBackwards)
    );
    assert_eq!(
        check_quote(&usdc_rules(), 0, &fixture, fixture.publish_time + 181),
        Err(E::PriceTooOld)
    );
}

#[test]
fn a_usdc_price_more_than_depeg_bps_from_one_dollar_is_a_depeg() {
    let at = |price: i64| Observation {
        price,
        conf: 0,
        publish_time: START,
    };
    let healthy = Ok(QuoteVerdict::Healthy {
        ok_until: START + 180,
    });
    assert_eq!(
        check_quote(&usdc_rules(), 0, &at(99_000_000), START),
        healthy
    );
    assert_eq!(
        check_quote(&usdc_rules(), 0, &at(101_000_000), START),
        healthy
    );
    for price in [98_999_999, 101_000_001, 95_000_000] {
        assert_eq!(
            check_quote(&usdc_rules(), 0, &at(price), START),
            Ok(QuoteVerdict::Depegged)
        );
    }
    let positive_expo = QuoteRules {
        expo: 1,
        ..usdc_rules()
    };
    assert_eq!(
        check_quote(&positive_expo, 0, &at(1), START),
        Err(E::InvalidMarketParams)
    );
}

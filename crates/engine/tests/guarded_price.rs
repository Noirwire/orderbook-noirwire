//! RULES 9b: a primary price with Pyth beside it as a circuit breaker. The mark follows the
//! primary; Pyth's latest observation freezes it past one fixed limit, with no allowance for
//! age; while Pyth is silent the mark moves in steps and never further than that limit from
//! the last Pyth price; and nothing is settled at the mark unless a fresh Pyth observation
//! agrees with it within the tighter liquidation band. Every call goes through the world, so a
//! refusal that wrote anything fails and every invariant is checked after each call.

mod common;

use bytemuck::Zeroable;
use common::*;
use noirwire_orderbook_engine::*;

type E = EngineError;

const BREAKER: Breaker = Breaker {
    bps: 400,
    max_age: 90,
};
const LIQUIDATION_BAND: u16 = 150;
const NOW: i64 = START + 10;

fn unit_binding() -> SourceBinding {
    SourceBinding {
        max_conf_bps: 100,
        ..SourceBinding::zeroed()
    }
}

fn obs(price: i64, publish_time: i64) -> Observation {
    Observation {
        price,
        conf: 0,
        publish_time,
    }
}

struct Setup {
    w: World,
    m: usize,
    feed: PriceFeed,
}

/// A market whose mark is `MARK` (1,000), healthy, whose bound Pyth account was last read
/// at `START` and said 1,000; `max_move_bps` is 300, `min_publish_gap` 1 and
/// `max_price_age` 60.
fn setup() -> Setup {
    let mut w = World::new(10, 8);
    let m = w.add_market(perp_params(0));
    let mut feed = PriceFeed::zeroed();
    feed.binding = unit_binding();
    feed.source = SourceRecord {
        raw_price: 1_000,
        conf: 0,
        publish_time: START,
        target: 1_000,
        observed_at: START,
    };
    w.now = NOW;
    Setup { w, m, feed }
}

impl Setup {
    fn sync(&mut self, primary: Observation, pyth: Option<Observation>) -> EngineResult<()> {
        self.w
            .sync_guarded(self.m, &mut self.feed, primary, pyth, BREAKER)
    }

    fn mark(&self) -> u64 {
        self.w.markets[self.m].price.price
    }

    fn health(&self) -> u8 {
        self.w.markets[self.m].params.oracle_health
    }

    /// What the program hands the engine after a sync: Pyth's latest observation, the
    /// breaker's age and the liquidation band.
    fn arm_gate(&mut self) {
        self.w.markets[self.m].gate = Some(LiquidationGate {
            reference: self.feed.source.target,
            published: self.feed.source.publish_time,
            max_age: i64::from(BREAKER.max_age),
            band_bps: LIQUIDATION_BAND,
        });
    }

    /// A long that is one step from liquidation at the first price below 940, and a
    /// counterparty, both opened at the mark. Returns (long, short).
    fn positions(&mut self) -> (u32, u32) {
        let long = funded(&mut self.w, 10_400);
        let short = funded(&mut self.w, 1_000_000);
        self.w
            .place(self.m, long, limit(Side::Bid, MARK, 100))
            .unwrap();
        self.w
            .place(self.m, short, ioc(Side::Ask, MARK, 100))
            .unwrap();
        (long, funded(&mut self.w, 1_000_000))
    }

    fn follow(&mut self, second: i64, price: i64, pyth: Option<Observation>) -> EngineResult<()> {
        self.w.now = NOW + second;
        let now = self.w.now;
        self.sync(obs(price, now), pyth)
    }
}

#[test]
fn a_primary_inside_the_limit_moves_the_mark_to_the_primarys_price() {
    let mut s = setup();
    s.sync(obs(1_012, NOW), Some(obs(1_010, NOW))).unwrap();
    assert_eq!(s.mark(), 1_012, "the primary's price, not Pyth's");
    assert_eq!(s.health(), ORACLE_HEALTHY);
    assert_eq!(s.w.markets[s.m].price.publish_time, NOW);
    assert_eq!(
        s.feed.source,
        SourceRecord {
            raw_price: 1_010,
            conf: 0,
            publish_time: NOW,
            target: 1_010,
            observed_at: NOW,
        },
        "the source record is Pyth's latest, not the primary's"
    );
}

#[test]
fn the_limit_is_one_fixed_band_from_pyths_price() {
    for (price, ok) in [(1_040, true), (960, true), (1_041, false), (959, false)] {
        let mut s = setup();
        let before = s.mark();
        let result = s.sync(obs(price, NOW), Some(obs(1_000, NOW)));
        assert_eq!(result.is_ok(), ok, "primary {price}, Pyth 1,000");
        if !ok {
            assert_eq!(result, Err(E::GuardDisagrees));
            assert_eq!(s.mark(), before);
        }
    }
}

#[test]
fn a_pyth_observation_nine_seconds_old_gets_no_wider_a_limit_for_its_age() {
    for age in [0, 8, 9, 30, 60, 65, 70, 90] {
        let mut s = setup();
        let pyth = Some(obs(1_000, NOW - age));
        assert_eq!(
            s.sync(obs(1_200, NOW), pyth),
            Err(E::GuardDisagrees),
            "a 20% jump against Pyth {age} s old"
        );
        s.w.now += 1;
        let now = s.w.now;
        assert_eq!(
            s.sync(obs(1_201, now), pyth),
            Err(E::GuardDisagrees),
            "and a second print one second later"
        );
        assert_eq!(s.mark(), 1_000);
        assert_eq!(s.health(), ORACLE_HEALTHY, "no incident, no settlement");
    }
}

#[test]
fn the_p1_sequence_freezes_the_mark_and_no_liquidation_follows() {
    let mut s = setup();
    let (long, liquidator) = s.positions();
    s.arm_gate();
    let pyth = Some(obs(1_000, NOW - 8));
    assert_eq!(s.sync(obs(1_200, NOW), pyth), Err(E::GuardDisagrees));
    s.w.now += 1;
    let now = s.w.now;
    assert_eq!(s.sync(obs(1_200, now), pyth), Err(E::GuardDisagrees));
    assert_eq!(s.mark(), 1_000);
    let before = s.w.collateral(long);
    s.w.now += 100;
    assert_eq!(
        s.w.liquidate(s.m, liquidator, long, 100),
        Err(E::LiquidationUnconfirmed)
    );
    assert_eq!(s.w.collateral(long), before);
}

#[test]
fn a_fast_real_crash_is_followed_nothing_freezes_and_liquidation_proceeds_once_the_band_agrees() {
    let mut s = setup();
    let (long, liquidator) = s.positions();
    for second in 1..=7 {
        let down = 1_000 - 10 * second;
        s.follow(second, down, Some(obs(down + 4, NOW + second - 1)))
            .unwrap_or_else(|e| panic!("second {second}: {e:?}"));
        assert_eq!(s.mark(), u64::try_from(down).unwrap());
        assert_eq!(s.health(), ORACLE_HEALTHY);
    }
    assert_eq!(s.mark(), 930, "seven percent down in seven seconds");
    s.arm_gate();
    let outcome = s.w.liquidate(s.m, liquidator, long, 100).unwrap();
    assert_eq!(outcome.status, LiquidationStatus::Liquidated);
}

#[test]
fn a_pyth_that_lags_beyond_the_liquidation_band_lets_the_mark_move_but_not_liquidate() {
    let mut s = setup();
    let (long, liquidator) = s.positions();
    for second in 1..=7 {
        let down = 1_000 - 10 * second;
        s.follow(second, down, Some(obs(down + 30, NOW + second - 1)))
            .unwrap();
    }
    s.arm_gate();
    assert_eq!(s.mark(), 930);
    assert_eq!(
        s.w.liquidate(s.m, liquidator, long, 100),
        Err(E::LiquidationUnconfirmed),
        "960 against 930 is 322 bps"
    );
    let range = RangeRequest {
        start: 2,
        count: 8,
        size: 100,
        worst_price: u64::MAX,
        max_takeovers: 4,
    };
    assert_eq!(
        s.w.liquidate_range(s.m, liquidator, &range),
        Err(E::LiquidationUnconfirmed)
    );
    s.follow(8, 925, Some(obs(929, NOW + 7))).unwrap();
    s.arm_gate();
    let outcome = s.w.liquidate(s.m, liquidator, long, 100).unwrap();
    assert_eq!(outcome.status, LiquidationStatus::Liquidated);
}

#[test]
fn many_small_bad_steps_while_pyth_is_stale_stop_at_the_cumulative_limit_and_never_liquidate() {
    let mut s = setup();
    let (long, liquidator) = s.positions();
    s.w.now = NOW + 200;
    let mut seen = Vec::new();
    for (second, price) in (1..).zip([990, 980, 970, 960, 950, 940, 930, 920]) {
        let result = s.follow(200 + second, price, None);
        seen.push((price, result));
    }
    for (price, result) in &seen {
        if *price >= 960 {
            assert_eq!(result, &Ok(()), "{price}");
        } else if *price >= 940 {
            assert_eq!(result, &Err(E::UnguardedDriftTooLarge), "{price}");
        } else {
            assert_eq!(result, &Err(E::UnguardedMoveTooLarge), "{price}");
        }
    }
    assert_eq!(s.mark(), 960, "400 bps from the last Pyth price, 1,000");
    s.arm_gate();
    s.w.now += 1;
    assert_eq!(
        s.w.liquidate(s.m, liquidator, long, 100),
        Err(E::LiquidationUnconfirmed)
    );
}

#[test]
fn an_unguarded_step_beyond_the_move_limit_is_refused_and_a_first_mark_has_no_anchor() {
    let mut s = setup();
    s.w.now = NOW + 200;
    let now = s.w.now;
    assert_eq!(
        s.sync(obs(1_031, now), None),
        Err(E::UnguardedMoveTooLarge),
        "310 bps in one step against 300"
    );
    s.sync(obs(1_030, now), None).unwrap();
    assert_eq!(s.mark(), 1_030);
    assert_eq!(s.health(), ORACLE_HEALTHY, "no dislocation without Pyth");

    let mut params = perp_params(0);
    let mut feed = PriceFeed::zeroed();
    feed.binding = unit_binding();
    assert_eq!(
        sync_guarded(
            &mut feed,
            &mut params,
            &obs(1_000, START),
            None,
            &BREAKER,
            START
        ),
        Err(E::UnguardedMoveTooLarge),
        "nothing bounds a first mark without Pyth"
    );
}

#[test]
fn a_market_with_no_pyth_price_ever_taken_has_nothing_to_measure_drift_from() {
    let mut s = setup();
    s.feed.source = SourceRecord::zeroed();
    s.w.now = NOW + 200;
    let now = s.w.now;
    assert_eq!(
        s.sync(obs(1_001, now), None),
        Err(E::UnguardedDriftTooLarge)
    );
    assert_eq!(s.mark(), 1_000);
}

#[test]
fn a_pyth_that_could_not_be_read_never_freezes_the_mark_and_is_never_taken_as_a_price() {
    let mut s = setup();
    s.sync(obs(1_020, NOW), None).unwrap();
    assert_eq!(
        s.mark(),
        1_020,
        "the kept observation is 10 s old and agrees"
    );
    assert_eq!(s.feed.source.publish_time, START, "nothing new was kept");
    s.w.now += 1;
    let now = s.w.now;
    assert_eq!(
        s.sync(obs(1_200, now), None),
        Err(E::GuardDisagrees),
        "the kept observation, 11 s old, still stands as the breaker's reference"
    );
}

#[test]
fn a_pyth_observation_that_is_not_usable_is_not_kept() {
    let wide = Observation {
        conf: 11,
        ..obs(1_005, NOW)
    };
    for (name, unusable) in [
        ("no price", obs(0, NOW)),
        ("negative price", obs(-5, NOW)),
        ("from the future", obs(1_005, NOW + 1)),
        ("older than the one kept", obs(1_005, START - 1)),
        ("too wide", wide),
    ] {
        let mut s = setup();
        s.sync(obs(1_001, NOW), Some(unusable)).unwrap();
        assert_eq!(
            s.feed.source,
            SourceRecord {
                raw_price: 1_000,
                conf: 0,
                publish_time: START,
                target: 1_000,
                observed_at: START,
            },
            "{name}"
        );
    }
    let mut s = setup();
    let edge = Observation {
        conf: 10,
        ..obs(1_005, NOW)
    };
    s.sync(obs(1_001, NOW), Some(edge)).unwrap();
    assert_eq!(
        s.feed.source.raw_price, 1_005,
        "a confidence at the limit is kept"
    );
}

#[test]
fn a_stale_primary_freezes_the_mark_whatever_pyth_says() {
    let mut s = setup();
    let max_age = s.w.markets[s.m].params.max_price_age;
    s.w.markets[s.m].price.publish_time = NOW - 2 * max_age;
    s.w.markets[s.m].price.accepted_at = NOW - 2 * max_age;
    assert_eq!(
        s.sync(obs(1_001, NOW - max_age - 1), Some(obs(1_001, NOW))),
        Err(E::PriceTooOld)
    );
    assert_eq!(s.mark(), 1_000);
    s.sync(obs(1_001, NOW - max_age), Some(obs(1_001, NOW)))
        .unwrap();
    assert_eq!(s.mark(), 1_001);
}

#[test]
fn the_mark_never_falls_back_to_pyths_price() {
    let mut s = setup();
    let max_age = s.w.markets[s.m].params.max_price_age;
    s.w.now = START + 2 * max_age;
    let now = s.w.now;
    assert_eq!(
        s.sync(obs(1_005, START), Some(obs(1_005, now))),
        Err(E::PriceTooOld)
    );
    assert_eq!(s.mark(), 1_000);
    let seat = funded(&mut s.w, 1_000_000);
    assert_eq!(
        s.w.place(s.m, seat, limit(Side::Bid, 1_000, 1))
            .unwrap_err(),
        E::StalePrice,
        "the frozen mark goes stale like any other: no exposure is added"
    );
}

#[test]
fn a_dislocation_is_settled_only_by_a_newer_print_beside_an_agreeing_pyth() {
    let mut s = setup();
    s.sync(obs(1_100, NOW), Some(obs(1_100, NOW))).unwrap();
    assert_eq!(s.health(), ORACLE_DISLOCATED);
    assert_eq!(s.mark(), 1_000);
    s.w.now += 5;
    let now = s.w.now;
    let before = (s.feed, s.mark());
    assert_eq!(
        s.sync(obs(1_100, NOW), Some(obs(1_100, now))),
        Err(E::PriceTimeWentBackwards),
        "the print that opened it cannot confirm it"
    );
    assert_eq!(
        s.sync(obs(1_105, now), Some(obs(1_000, now))),
        Err(E::GuardDisagrees)
    );
    assert_eq!((s.feed, s.mark()), before);
    let mut quiet = setup();
    quiet.sync(obs(1_100, NOW), Some(obs(1_100, NOW))).unwrap();
    quiet.w.now += 100;
    let later = quiet.w.now;
    assert_eq!(
        quiet.sync(obs(1_105, later), None),
        Err(E::UnguardedMoveTooLarge),
        "a settlement needs a fresh Pyth"
    );
    assert_eq!(quiet.health(), ORACLE_DISLOCATED);
    s.sync(obs(1_105, now), Some(obs(1_105, now))).unwrap();
    assert_eq!(s.health(), ORACLE_SETTLING);
    assert_eq!(s.mark(), 1_105);
}

#[test]
fn the_primarys_confidence_is_not_judged_and_does_not_replace_pyths_record() {
    let mut s = setup();
    let unmeasured = Observation {
        conf: u64::MAX,
        ..obs(1_001, NOW)
    };
    s.sync(unmeasured, Some(obs(1_001, NOW))).unwrap();
    assert_eq!(s.mark(), 1_001);
    assert_eq!(s.feed.source.conf, 0);
}

#[test]
fn the_primary_has_to_be_newer_than_the_mark_and_a_price_has_to_be_above_zero() {
    let mut s = setup();
    s.sync(obs(1_001, NOW), Some(obs(1_001, NOW))).unwrap();
    s.w.now += 5;
    let now = s.w.now;
    assert_eq!(
        s.sync(obs(1_002, NOW), Some(obs(1_002, now))),
        Err(E::PriceTimeWentBackwards)
    );
    assert_eq!(
        s.sync(obs(0, now), Some(obs(1_002, now))),
        Err(E::ZeroPrice)
    );
    assert_eq!(
        s.sync(obs(1_002, now + 1), Some(obs(1_002, now))),
        Err(E::PriceFromTheFuture)
    );
    assert_eq!(s.mark(), 1_001);
}

#[test]
fn a_breaker_of_zero_bps_or_zero_seconds_is_refused() {
    let mut s = setup();
    for breaker in [
        Breaker { bps: 0, ..BREAKER },
        Breaker {
            max_age: 0,
            ..BREAKER
        },
    ] {
        let mut feed = s.feed;
        assert_eq!(
            s.w.sync_guarded(
                s.m,
                &mut feed,
                obs(1_000, NOW),
                Some(obs(1_000, NOW)),
                breaker
            ),
            Err(E::InvalidMarketParams)
        );
    }
    assert_eq!(s.mark(), 1_000);
}

#[test]
fn a_first_mark_needs_a_fresh_agreeing_pyth_and_leaves_the_market_reduce_only() {
    let mut params = perp_params(0);
    let mut feed = PriceFeed::zeroed();
    feed.binding = unit_binding();
    let mut first = |p: Observation, g: Option<Observation>| {
        sync_guarded(&mut feed, &mut params, &p, g.as_ref(), &BREAKER, START)
    };
    assert_eq!(
        first(obs(1_000, START), Some(obs(1_100, START))),
        Err(E::GuardDisagrees)
    );
    assert_eq!(
        first(obs(1_000, START), None),
        Err(E::UnguardedMoveTooLarge)
    );
    first(obs(1_000, START), Some(obs(1_001, START))).unwrap();
    assert_eq!(feed.price.price, 1_000);
    assert_eq!(params.status, STATUS_REDUCE_ONLY);
}

#[test]
fn the_gate_confirms_only_a_fresh_observation_within_the_band() {
    let gate = LiquidationGate {
        reference: 1_000,
        published: 100,
        max_age: 75,
        band_bps: 150,
    };
    assert!(gate.confirms(1_015, 175));
    assert!(gate.confirms(986, 100));
    assert!(!gate.confirms(1_016, 175), "157 bps of the mark");
    assert!(!gate.confirms(984, 175));
    assert!(!gate.confirms(1_000, 176), "76 s old");
    assert!(!gate.confirms(1_000, 99), "from the future");
    let none = LiquidationGate {
        reference: 0,
        ..gate
    };
    assert!(!none.confirms(1_000, 100), "no observation ever");
}

#[test]
fn a_pyth_outage_of_300_seconds_keeps_the_mark_moving_refuses_liquidation_and_resumes_with_pyth() {
    let mut s = setup();
    let (long, liquidator) = s.positions();
    let mut updates = 0;
    for tick in 1..=30 {
        let wobble = [-20, 0, 20, -10, -30, -25][tick as usize % 6];
        s.follow(tick * 10, 1_000 + wobble, None)
            .unwrap_or_else(|e| panic!("tick {tick}: {e:?}"));
        assert_eq!(s.mark(), u64::try_from(1_000 + wobble).unwrap());
        updates += 1;
    }
    assert_eq!(updates, 30, "the mark followed MagicBlock all 300 s");
    s.arm_gate();
    assert_eq!(
        s.w.liquidate(s.m, liquidator, long, 100),
        Err(E::LiquidationUnconfirmed),
        "no Pyth for 300 s, no liquidation"
    );
    s.follow(301, 960, None).unwrap();
    s.follow(310, 935, Some(obs(934, NOW + 309))).unwrap();
    assert_eq!(s.mark(), 935, "Pyth is back and the mark followed");
    s.arm_gate();
    let outcome = s.w.liquidate(s.m, liquidator, long, 100).unwrap();
    assert_eq!(outcome.status, LiquidationStatus::Liquidated);
}

#[test]
fn pyth_at_sixty_to_seventy_seconds_old_is_normal_for_the_breaker_and_the_gate() {
    let mut s = setup();
    for (n, age) in [60, 65, 70, 90].into_iter().enumerate() {
        s.w.now = NOW + 100 * (n as i64 + 1);
        let now = s.w.now;
        let mark = i64::try_from(s.mark()).unwrap();
        let pyth = obs(mark, now - age);
        assert_eq!(
            s.sync(obs(mark + 500, now), Some(pyth)),
            Err(E::GuardDisagrees),
            "a jump against a Pyth {age} s old is stopped"
        );
        s.sync(obs(mark + 1, now), Some(pyth)).unwrap();
        s.arm_gate();
        assert!(
            s.w.markets[s.m].gate.unwrap().confirms(s.mark(), now),
            "age {age}"
        );
    }
    let published = s.feed.source.publish_time;
    let gate = s.w.markets[s.m].gate.unwrap();
    assert!(gate.confirms(s.mark(), published + 90));
    assert!(!gate.confirms(s.mark(), published + 91));
}

#[test]
fn a_market_with_no_gate_liquidates_as_before() {
    let mut s = setup();
    let (long, liquidator) = s.positions();
    for second in 1..=7 {
        let down = 1_000 - 10 * second;
        s.follow(second, down, Some(obs(down + 4, NOW + second - 1)))
            .unwrap();
    }
    let outcome = s.w.liquidate(s.m, liquidator, long, 100).unwrap();
    assert_eq!(outcome.status, LiquidationStatus::Liquidated);
}

#[test]
fn the_new_codes_are_fixed() {
    assert_eq!(E::GuardDisagrees.code(), 82);
    assert_eq!(E::UnguardedMoveTooLarge.code(), 83);
    assert_eq!(E::UnguardedDriftTooLarge.code(), 84);
    assert_eq!(E::LiquidationUnconfirmed.code(), 85);
}

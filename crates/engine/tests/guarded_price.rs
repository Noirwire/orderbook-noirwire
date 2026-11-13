//! RULES 9b: a primary price with a guard beside it. A fresh guard that disagrees beyond
//! its band freezes the mark; a stale or unusable guard is no evidence and the primary
//! moves the mark alone, but only within the move limit. Every call goes through the
//! world, so a refusal that wrote anything fails and every invariant is checked after
//! each call.

mod common;

use bytemuck::Zeroable;
use common::*;
use noirwire_orderbook_engine::*;

type E = EngineError;

/// The base band and the guard's freshness window the tests run with.
const BAND: u16 = 100;
const WINDOW: u16 = 10;
const NOW: i64 = START + 10;

fn unit_binding() -> SourceBinding {
    SourceBinding {
        max_conf_bps: 100,
        ..SourceBinding::zeroed()
    }
}

/// The primary as the oracle reports it: a price and a stamp, and no confidence.
fn primary(price: i64, publish_time: i64) -> Observation {
    Observation {
        price,
        conf: 0,
        publish_time,
    }
}

fn guard(price: i64, publish_time: i64) -> Observation {
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

/// A market whose mark is `MARK` (1,000), healthy, last read from the source at `START`;
/// `max_move_bps` is 300, `min_publish_gap` 1 and `max_price_age` 60.
fn setup() -> Setup {
    let mut w = World::new(10, 8);
    let m = w.add_market(perp_params(0));
    let mut feed = PriceFeed::zeroed();
    feed.binding = unit_binding();
    feed.source.publish_time = START;
    w.now = NOW;
    Setup { w, m, feed }
}

impl Setup {
    fn sync(&mut self, primary: Observation, guard: Observation) -> EngineResult<()> {
        self.w
            .sync_guarded(self.m, &mut self.feed, primary, guard, BAND, WINDOW)
    }

    fn mark(&self) -> u64 {
        self.w.markets[self.m].price.price
    }

    fn health(&self) -> u8 {
        self.w.markets[self.m].params.oracle_health
    }
}

#[test]
fn a_primary_inside_the_band_moves_the_mark_to_the_primarys_price() {
    let mut s = setup();
    s.sync(primary(1_012, NOW), guard(1_010, NOW)).unwrap();
    assert_eq!(s.mark(), 1_012, "the primary's price, not the guard's");
    assert_eq!(s.health(), ORACLE_HEALTHY);
    assert_eq!(s.w.markets[s.m].price.publish_time, NOW);
    assert_eq!(
        s.feed.source,
        SourceRecord {
            raw_price: 1_012,
            conf: 0,
            publish_time: NOW,
            target: 1_012,
            observed_at: NOW,
        }
    );
}

#[test]
fn the_band_is_the_base_plus_pyths_push_threshold_measured_from_the_guard() {
    assert_eq!(PYTH_PUSH_BPS, 50);
    for (price, ok) in [(1_015, true), (985, true), (1_016, false), (984, false)] {
        let mut s = setup();
        let before = s.mark();
        let result = s.sync(primary(price, NOW), guard(1_000, NOW));
        assert_eq!(result.is_ok(), ok, "primary {price}, guard 1,000, same age");
        if !ok {
            assert_eq!(result, Err(E::GuardDisagrees));
            assert_eq!(s.mark(), before);
        }
    }
}

#[test]
fn the_band_grows_with_the_guards_age_by_the_marks_own_speed_limit() {
    // 300 bps a second: a guard 3 s old may be 100 + 50 + 900 bps behind.
    // The mark already stands at 1,100, so a primary there is a repeat of it; what is
    // tested is the guard's band, 150 bps plus 300 for each second of its age.
    for (age, price, ok) in [(3, 1_105, true), (3, 1_106, false), (0, 1_016, false)] {
        let mut s = setup();
        s.w.markets[s.m].price.price = 1_100;
        let result = s.sync(primary(price, NOW), guard(1_000, NOW - age));
        let near = price == 1_016;
        if near {
            assert_eq!(result, Err(E::GuardDisagrees), "age {age}");
        } else {
            assert_eq!(result.is_ok(), ok, "age {age}, primary {price}");
            if !ok {
                assert_eq!(result, Err(E::GuardDisagrees));
            }
        }
    }
}

#[test]
fn a_fast_crash_while_pyth_has_not_pushed_is_followed_and_never_frozen() {
    let mut s = setup();
    for second in 1..=5 {
        s.w.now = START + second;
        let down = 1_000 - 10 * second;
        s.sync(primary(down, s.w.now), guard(1_000, START))
            .unwrap_or_else(|e| panic!("second {second}: {e:?}"));
        assert_eq!(s.mark(), u64::try_from(down).unwrap());
    }
    assert_eq!(s.mark(), 950, "five percent down in five seconds");
    assert_eq!(s.health(), ORACLE_HEALTHY);
}

#[test]
fn the_same_crash_after_pyth_is_stale_is_followed_within_the_move_limit() {
    let mut s = setup();
    s.w.now = START + 100;
    s.w.markets[s.m].price.publish_time = START + 99;
    s.w.markets[s.m].price.accepted_at = START + 99;
    s.sync(primary(980, s.w.now), guard(1_000, START)).unwrap();
    assert_eq!(s.mark(), 980, "stale Pyth is no evidence against it");
    s.w.now += 1;
    s.sync(primary(960, s.w.now), guard(1_000, START)).unwrap();
    assert_eq!(s.mark(), 960);
}

#[test]
fn a_rogue_primary_against_a_fresh_guard_is_frozen() {
    let mut s = setup();
    assert_eq!(
        s.sync(primary(1_200, NOW), guard(1_000, NOW - 1)),
        Err(E::GuardDisagrees)
    );
    assert_eq!(s.mark(), 1_000);
    assert_eq!(s.health(), ORACLE_HEALTHY);
    assert_eq!(s.feed.source.publish_time, START, "nothing was recorded");
    assert_eq!(s.feed.incident, Incident::zeroed());
}

#[test]
fn a_rogue_primary_against_a_stale_guard_is_frozen_by_the_move_limit() {
    let mut s = setup();
    assert_eq!(
        s.sync(
            primary(1_200, NOW),
            guard(1_000, NOW - i64::from(WINDOW) - 1)
        ),
        Err(E::UnguardedMoveTooLarge)
    );
    assert_eq!(s.mark(), 1_000);
    assert_eq!(s.health(), ORACLE_HEALTHY, "no dislocation without a guard");
    assert_eq!(s.feed.incident, Incident::zeroed());
    assert_eq!(
        s.sync(primary(1_031, NOW), guard(1_000, 0)),
        Err(E::UnguardedMoveTooLarge),
        "the step is 310 bps and the limit is 300"
    );
    s.sync(primary(1_030, NOW), guard(1_000, 0)).unwrap();
    assert_eq!(s.mark(), 1_030);
}

#[test]
fn a_stale_primary_freezes_the_mark_beside_a_fresh_guard() {
    let mut s = setup();
    let max_age = s.w.markets[s.m].params.max_price_age;
    s.feed.source.publish_time = NOW - 2 * max_age;
    s.w.markets[s.m].price.publish_time = NOW - 2 * max_age;
    s.w.markets[s.m].price.accepted_at = NOW - 2 * max_age;
    assert_eq!(
        s.sync(primary(1_001, NOW - max_age - 1), guard(1_001, NOW)),
        Err(E::PriceTooOld)
    );
    assert_eq!(s.mark(), 1_000);
    s.sync(primary(1_001, NOW - max_age), guard(1_001, NOW))
        .unwrap();
    assert_eq!(s.mark(), 1_001);
}

#[test]
fn a_guard_that_cannot_be_used_as_evidence_leaves_the_primary_to_the_move_limit() {
    let wide = Observation {
        conf: 11,
        ..guard(1_000, NOW)
    };
    let edge = Observation {
        conf: 10,
        ..guard(1_000, NOW)
    };
    for (name, unusable) in [
        ("no price", guard(0, NOW)),
        ("negative price", guard(-5, NOW)),
        ("from the future", guard(1_000, NOW + 1)),
        ("too wide", wide),
    ] {
        let mut s = setup();
        assert_eq!(
            s.sync(primary(1_200, NOW), unusable),
            Err(E::UnguardedMoveTooLarge),
            "{name}"
        );
        s.sync(primary(1_020, NOW), unusable).unwrap();
        assert_eq!(s.mark(), 1_020, "{name}");
    }
    let mut s = setup();
    assert_eq!(
        s.sync(primary(1_200, NOW), edge),
        Err(E::GuardDisagrees),
        "a confidence at the limit still guards"
    );
}

#[test]
fn the_mark_never_falls_back_to_the_guards_price() {
    let mut s = setup();
    let max_age = s.w.markets[s.m].params.max_price_age;
    s.w.now = START + 2 * max_age;
    assert_eq!(
        s.sync(primary(1_005, START), guard(1_005, s.w.now)),
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
fn a_guarded_dislocation_is_recorded_and_settled_but_an_unguarded_one_is_refused() {
    let mut s = setup();
    let far = 1_100;
    s.sync(primary(far, NOW), guard(far, NOW)).unwrap();
    assert_eq!(
        s.health(),
        ORACLE_DISLOCATED,
        "a guard that agrees lets it be seen"
    );
    assert_eq!(s.mark(), 1_000);
    s.w.now += 5;
    let before = (s.feed, s.mark());
    assert_eq!(
        s.sync(primary(far + 5, s.w.now), guard(1_000, s.w.now)),
        Err(E::GuardDisagrees)
    );
    assert_eq!(
        s.sync(primary(far + 5, s.w.now), guard(far, 0)),
        Err(E::UnguardedMoveTooLarge),
        "a settlement needs the guard"
    );
    assert_eq!((s.feed, s.mark()), before);
    s.sync(primary(far + 5, s.w.now), guard(far + 5, s.w.now))
        .unwrap();
    assert_eq!(s.health(), ORACLE_SETTLING);
    assert_eq!(s.mark(), 1_105);
}

#[test]
fn the_primarys_confidence_is_not_judged_and_is_recorded_as_given() {
    let mut s = setup();
    let unmeasured = Observation {
        conf: u64::MAX,
        ..primary(1_001, NOW)
    };
    s.sync(unmeasured, guard(1_001, NOW)).unwrap();
    assert_eq!(s.mark(), 1_001);
    assert_eq!(s.feed.source.conf, u64::MAX);
}

#[test]
fn the_primary_has_to_be_newer_than_the_last_one_taken_and_a_price_has_to_be_above_zero() {
    let mut s = setup();
    s.sync(primary(1_001, NOW), guard(1_001, NOW)).unwrap();
    s.w.now += 5;
    assert_eq!(
        s.sync(primary(1_002, NOW), guard(1_002, s.w.now)),
        Err(E::PriceTimeWentBackwards)
    );
    assert_eq!(
        s.sync(primary(0, s.w.now), guard(1_002, s.w.now)),
        Err(E::ZeroPrice)
    );
    assert_eq!(
        s.sync(primary(1_002, s.w.now + 1), guard(1_002, s.w.now)),
        Err(E::PriceFromTheFuture)
    );
    assert_eq!(s.mark(), 1_001);
}

#[test]
fn a_band_or_a_window_of_zero_is_refused() {
    let mut s = setup();
    for (bps, window) in [(0, WINDOW), (BAND, 0)] {
        let mut feed = s.feed;
        assert_eq!(
            s.w.sync_guarded(
                s.m,
                &mut feed,
                primary(1_000, NOW),
                guard(1_000, NOW),
                bps,
                window
            ),
            Err(E::InvalidMarketParams)
        );
    }
    assert_eq!(s.mark(), 1_000);
}

#[test]
fn a_first_mark_needs_a_fresh_agreeing_guard_and_leaves_the_market_reduce_only() {
    let mut params = perp_params(0);
    let mut feed = PriceFeed::zeroed();
    feed.binding = unit_binding();
    let mut try_first = |p: Observation, g: Observation| {
        sync_guarded(&mut feed, &mut params, &p, &g, BAND, WINDOW, START)
    };
    assert_eq!(
        try_first(primary(1_000, START), guard(1_100, START)),
        Err(E::GuardDisagrees)
    );
    assert_eq!(
        try_first(primary(1_000, START), guard(1_000, START - 11)),
        Err(E::UnguardedMoveTooLarge),
        "nothing bounds a first mark without a guard"
    );
    try_first(primary(1_000, START), guard(1_001, START)).unwrap();
    assert_eq!(feed.price.price, 1_000);
    assert_eq!(params.status, STATUS_REDUCE_ONLY);
}

#[test]
fn the_guarded_path_and_the_plain_path_move_the_mark_alike_for_the_same_observation() {
    let mut guarded = setup();
    let mut plain = setup();
    let observed = primary(1_030, NOW);
    guarded.sync(observed, guard(1_030, NOW)).unwrap();
    plain.w.sync(plain.m, &mut plain.feed, observed).unwrap();
    assert_eq!(guarded.w.markets[0].price, plain.w.markets[0].price);
    assert_eq!(guarded.feed, plain.feed);
    assert_eq!(guarded.w.markets[0].params, plain.w.markets[0].params);
}

#[test]
fn the_new_codes_are_fixed() {
    assert_eq!(E::GuardDisagrees.code(), 82);
    assert_eq!(E::UnguardedMoveTooLarge.code(), 83);
}

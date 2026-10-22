//! Round 4 audit, the Pyth price source: the incident machine under clock rollback,
//! the settlement window against withdrawals, scaling edges, the USDC guard, and how
//! funding totals cross an incident or a rebind.

mod common;

use bytemuck::Zeroable;
use common::*;
use noirwire_orderbook_engine::*;
use proptest::prelude::*;

type E = EngineError;

const WINDOW: i64 = 900;

fn unit_binding() -> SourceBinding {
    SourceBinding {
        max_conf_bps: 100,
        ..SourceBinding::zeroed()
    }
}

fn seen(price: i64, publish_time: i64) -> Observation {
    Observation {
        price,
        conf: 0,
        publish_time,
    }
}

fn source_at(publish_time: i64) -> PriceFeed {
    let mut feed = PriceFeed::zeroed();
    feed.binding = unit_binding();
    feed.source.publish_time = publish_time;
    feed
}

fn perp_with_window() -> MarketParams {
    let mut params = perp_params(0);
    params.settle_window = WINDOW;
    params
}

/// RULES 7: an interval the source was dislocated or settling in at any time is
/// discarded, even when the source is healthy again by the update. A dislocation that
/// heals inside the interval takes the interval's pre-incident premium with it.
#[test]
fn f1_an_interval_with_a_healed_dislocation_is_discarded() {
    let mut w = World::new(10, 8);
    let m = w.add_market(perp_with_window());
    let long = funded(&mut w, 100_000);
    let short = funded(&mut w, 100_000);
    buy_from(&mut w, m, long, short, 1_040, 10);
    assert!(w.markets[m].book.traded_premium > 0);
    let before = w.funding_units(m);

    let mut feed = source_at(START);
    w.now = START + 10;
    w.sync(m, &mut feed, seen(1_100, w.now)).unwrap();
    assert_eq!(w.markets[m].params.oracle_health, ORACLE_DISLOCATED);
    w.now = START + 20;
    w.sync(m, &mut feed, seen(1_010, w.now)).unwrap();
    assert_eq!(w.markets[m].params.oracle_health, ORACLE_HEALTHY);

    w.now = START + w.markets[m].params.funding_interval;
    w.sync(m, &mut feed, seen(1_020, w.now)).unwrap();
    assert_eq!(w.fund(m), Ok(true));
    assert_eq!(
        w.funding_units(m),
        before,
        "the interval the source was dislocated in moved no funding"
    );
    let book = w.markets[m].book;
    assert_eq!((book.traded_premium, book.traded_size), (0, 0));
    assert_eq!(book.last_funding_time, w.now);
}

/// The same across a settlement: the gap settles, the window passes and the source is
/// healthy again before the interval ends. The premium recorded at the pre-gap mark is
/// discarded with the interval.
#[test]
fn f1_an_interval_spanning_a_whole_settlement_is_discarded() {
    let mut w = World::new(10, 8);
    let m = w.add_market(perp_with_window());
    let long = funded(&mut w, 100_000);
    let short = funded(&mut w, 100_000);
    buy_from(&mut w, m, long, short, 1_040, 10);
    let before = w.funding_units(m);

    let mut feed = source_at(START);
    w.now = START + 10;
    w.sync(m, &mut feed, seen(1_100, w.now)).unwrap();
    w.now = START + 11;
    w.sync(m, &mut feed, seen(1_100, w.now)).unwrap();
    assert_eq!(w.markets[m].params.oracle_health, ORACLE_SETTLING);
    assert_eq!(w.markets[m].price.price, 1_100);

    w.now = feed.incident.settle_until + 1;
    w.sync(m, &mut feed, seen(1_110, w.now)).unwrap();
    assert_eq!(w.markets[m].params.oracle_health, ORACLE_HEALTHY);

    w.now = START + w.markets[m].params.funding_interval;
    w.sync(m, &mut feed, seen(1_120, w.now)).unwrap();
    assert_eq!(w.fund(m), Ok(true));
    assert_eq!(
        w.funding_units(m),
        before,
        "premium measured before the settled jump paid no funding after it"
    );

    w.now += w.markets[m].params.funding_interval;
    w.sync(m, &mut feed, seen(1_120, w.now)).unwrap();
    w.resume(m).unwrap();
    buy_from(&mut w, m, long, short, 1_150, 1);
    let clean = w.funding_units(m);
    assert_eq!(w.fund(m), Ok(true));
    assert!(
        w.funding_units(m) > clean,
        "the next interval, with no incident in it, pays again"
    );
}

/// `set_price_source` zeroes the feed and sets the market healthy, and also clears the
/// book's funding totals and restarts its clock (price_source.rs, emulated here as it
/// writes). The market is paused through the rebind, so `update_funding` could not
/// clear them itself. After the first mark and `resume_market`, the first update
/// charges nothing measured against the old source.
#[test]
fn f1_funding_totals_from_the_old_source_are_cleared_by_a_rebind() {
    let mut w = World::new(10, 8);
    let m = w.add_market(perp_with_window());
    let a = funded(&mut w, 1_000_000);
    let b = funded(&mut w, 1_000_000);
    buy_from(&mut w, m, a, b, 1_040, 10);
    buy_from(&mut w, m, b, a, 1_000, 10);
    assert_eq!(w.markets[m].book.open_interest, 0);
    assert!(w.markets[m].book.traded_premium > 0, "premium left behind");

    w.markets[m].params.status = STATUS_PAUSED;
    assert_eq!(
        w.fund(m),
        Err(E::MarketPaused),
        "update_funding cannot clear them"
    );
    w.now = START + 50;
    let state = &mut w.markets[m];
    state.price = Price::zeroed();
    state.incident = Incident::zeroed();
    state.params.oracle_health = ORACLE_HEALTHY;
    state.book.traded_premium = 0;
    state.book.traded_size = 0;
    state.book.last_funding_time = w.now;
    let mut feed = source_at(0);

    w.now = START + 100;
    w.sync(m, &mut feed, seen(2_000, w.now)).unwrap();
    assert_eq!(w.markets[m].params.status, STATUS_PAUSED);
    w.resume(m).unwrap();
    let c = funded(&mut w, 1_000_000);
    let d = funded(&mut w, 1_000_000);
    buy_from(&mut w, m, c, d, 2_000, 10);
    let before = w.funding_units(m);

    w.now = START + 50 + w.markets[m].params.funding_interval;
    w.sync(m, &mut feed, seen(2_000, w.now)).unwrap();
    assert_eq!(w.fund(m), Ok(true));
    assert_eq!(
        w.funding_units(m),
        before,
        "the new source's longs pay nothing for premium recorded under the old one"
    );
}

/// RULES 9a: while the guard does not pass, no fill grows a perp position, a resting
/// maker's included. A resting bid placed before the trip that would open a position
/// fails its fill check when matching reaches it and is cancelled, and matching goes on
/// to a resting bid that only shrinks its owner's short.
#[test]
fn f2_a_tripped_usdc_guard_stops_a_resting_maker_from_growing_its_position() {
    let mut w = World::new(10, 8);
    let m = w.add_market(perp_params(0));
    let maker = funded(&mut w, 100_000);
    let closer = funded(&mut w, 100_000);
    let other = funded(&mut w, 100_000);
    buy_from(&mut w, m, closer, other, 1_000, 5);
    w.place(m, maker, limit(Side::Bid, 1_000, 5)).unwrap();
    w.place(m, other, limit(Side::Bid, 990, 5)).unwrap();
    assert_eq!(w.slot(maker, m).base, 0);

    w.quote_ok = false;
    assert_eq!(
        w.place(m, maker, limit(Side::Bid, 1_000, 1)),
        Err(E::QuoteGuardTripped)
    );
    let outcome = w
        .place(m, closer, reduce_only(ioc(Side::Ask, 990, 5)))
        .unwrap();
    assert_eq!(outcome.filled, 5);
    assert_eq!(w.slot(maker, m).base, 0, "no position opened while tripped");
    assert_eq!(
        w.seat(maker).open_orders[m],
        0,
        "the growing bid was cancelled"
    );
    assert_eq!(w.slot(other, m).base, 0, "a shrinking bid still filled");
    assert_eq!(w.slot(closer, m).base, 0);
}

/// A print beyond the move limit whose confidence is wider than `max_conf_bps` is
/// refused before the move limit is looked at (price.rs:139), so it opens no incident.
/// Withdrawals stay open for everyone, a position holder's included, until the mark is
/// `max_price_age` old, however many honest keepers send that print. Accepted, and
/// stated in SECURITY.md under "The price source".
#[test]
fn f3_a_wide_confidence_crash_print_opens_no_incident_and_withdrawals_stay_open() {
    let mut w = World::new(10, 8);
    let m = w.add_market(perp_with_window());
    let long = funded(&mut w, 2_000);
    let short = funded(&mut w, 100_000);
    buy_from(&mut w, m, long, short, 1_000, 10);
    let mut feed = source_at(START);

    w.now = START + 5;
    let crash = Observation {
        price: 800,
        conf: 9,
        publish_time: w.now,
    };
    assert_eq!(w.sync(m, &mut feed, crash), Err(E::PriceConfidenceTooWide));
    assert_eq!(w.markets[m].params.oracle_health, ORACLE_HEALTHY);
    assert_eq!(w.markets[m].price.price, 1_000);
    assert_eq!(
        w.withdraw(long, Asset::Collateral, 900),
        Ok(()),
        "valued at the pre-crash mark while the source shows 20% lower"
    );
    w.now = START + w.markets[m].params.max_price_age;
    assert_eq!(w.withdraw(long, Asset::Collateral, 1), Ok(()));
}

#[derive(Clone, Debug)]
struct Step {
    wait: i64,
    stamped_back: i64,
    move_bps: i64,
    from_mark: bool,
}

fn step() -> impl Strategy<Value = Step> {
    (-3i64..6, 0i64..4, -3_000i64..3_000, any::<bool>()).prop_map(
        |(wait, stamped_back, move_bps, from_mark)| Step {
            wait,
            stamped_back,
            move_bps,
            from_mark,
        },
    )
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(3_000))]

    /// Held: with the clock stepping back as well as forward, prices both sides of the
    /// limit, and stamps in the past, a refusal writes nothing; a mark change beyond the
    /// limit only ever settles a dislocation opened at least `min_publish_gap` earlier;
    /// healthy never comes before every settlement window has ended; the source's
    /// publish time only rises and never passes the clock.
    #[test]
    fn held_the_incident_machine_survives_clock_rollback(
        steps in prop::collection::vec(step(), 1..80),
        paused in any::<bool>(),
    ) {
        let mut params = perp_with_window();
        let mut feed = PriceFeed::zeroed();
        feed.binding = unit_binding();
        let mut now = START;
        sync_source(&mut feed, &mut params, &seen(100_000, now), now).unwrap();
        resume_market(&mut params, &[]).unwrap();
        if paused {
            params.status = STATUS_PAUSED;
        }
        let mut window_end = i64::MIN;
        for step in steps {
            now += step.wait;
            let base = if step.from_mark { feed.price.price } else { feed.source.target };
            let base = i64::try_from(base).unwrap();
            let price = (base + base * step.move_bps / 10_000).max(1);
            let (old, old_params) = (feed, params);
            let result = sync_source(&mut feed, &mut params, &seen(price, now - step.stamped_back), now);
            if result.is_err() {
                prop_assert_eq!(feed, old);
                prop_assert_eq!(params, old_params);
                continue;
            }
            if feed.incident.reason == INCIDENT_SETTLED_GAP {
                window_end = window_end.max(feed.incident.settle_until);
            }
            if params.oracle_health == ORACLE_HEALTHY {
                prop_assert!(now >= window_end, "a window ended early");
            }
            prop_assert!(feed.source.publish_time > old.source.publish_time);
            prop_assert!(feed.source.publish_time <= now);
            prop_assert!(feed.price.publish_time <= feed.source.publish_time);
            if feed.price == old.price {
                continue;
            }
            let moved = u128::from(feed.price.price.abs_diff(old.price.price)) * 10_000;
            let limit = u128::from(old.price.price) * u128::from(params.max_move_bps);
            if moved > limit {
                prop_assert_eq!(old_params.oracle_health, ORACLE_DISLOCATED);
                prop_assert!(now - old.incident.since >= i64::from(params.min_publish_gap));
                prop_assert_eq!(params.oracle_health, ORACLE_SETTLING);
                prop_assert_ne!(params.status, STATUS_ACTIVE);
            } else {
                prop_assert_ne!(params.oracle_health, ORACLE_DISLOCATED);
            }
        }
    }

    /// Held: a source price lands in `1..=MAX_PRICE` exactly as
    /// `floor(price * base_lot * 10^scale)` for every scale in -30..=30, or is refused;
    /// nothing panics or wraps.
    #[test]
    fn held_scaling_is_exact_or_refused_at_every_scale(
        price in 1u64..=u64::MAX,
        base_lot in 1u64..=u64::MAX,
        scale in -30i32..=30,
    ) {
        let binding = SourceBinding {
            expo: scale,
            ..unit_binding()
        };
        let exact = |price: u64, lot: u64| -> Option<u128> {
            let per_lot = u128::from(price).checked_mul(u128::from(lot))?;
            let power = 10u128.checked_pow(scale.unsigned_abs())?;
            if scale >= 0 { per_lot.checked_mul(power) } else { Some(per_lot / power) }
        };
        match observed_mark(price, base_lot, &binding) {
            Ok(mark) => {
                prop_assert!((1..=MAX_PRICE).contains(&mark));
                prop_assert_eq!(Some(u128::from(mark)), exact(price, base_lot));
            }
            Err(error) => {
                let expected = match exact(price, base_lot) {
                    Some(0) => E::ZeroPrice,
                    _ => E::PriceTooHigh,
                };
                prop_assert_eq!(error, expected);
            }
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(400))]

    /// Held: flapping a perp's source between dislocated, settling and healthy never
    /// pays collateral out before every settlement window has ended, whatever the
    /// order of observations and withdrawal attempts.
    #[test]
    fn held_no_collateral_leaves_before_a_settlement_window_ends(
        steps in prop::collection::vec(step(), 1..40),
    ) {
        let mut w = World::new(10, 8);
        let m = w.add_market(perp_with_window());
        let flat = funded(&mut w, 1_000_000);
        let long = funded(&mut w, 1_000_000);
        let short = funded(&mut w, 1_000_000);
        buy_from(&mut w, m, long, short, 1_000, 10);
        let mut feed = source_at(START);
        let mut window_end = i64::MIN;
        for step in steps {
            w.now += step.wait.max(0);
            let base = if step.from_mark { w.markets[m].price.price } else { feed.source.target.max(1) };
            let base = i64::try_from(base).unwrap();
            let price = (base + base * step.move_bps / 10_000).max(1);
            let _ = w.sync(m, &mut feed, seen(price, w.now - step.stamped_back));
            if feed.incident.reason == INCIDENT_SETTLED_GAP {
                window_end = window_end.max(feed.incident.settle_until);
            }
            let healthy = w.markets[m].params.oracle_health == ORACLE_HEALTHY;
            for seat in [flat, long, short] {
                if w.withdraw(seat, Asset::Collateral, 1).is_ok() {
                    prop_assert!(healthy && w.now >= window_end);
                }
            }
        }
    }
}

/// Held: the guard's dollar is `10^-expo` for every exponent `set_quote_source` admits
/// (-18..=0) and one past it is refused, never wrapped.
#[test]
fn held_the_usdc_guard_dollar_fits_every_admitted_exponent() {
    for expo in -18i32..=0 {
        let rules = QuoteRules {
            expo,
            max_conf_bps: 100,
            depeg_bps: 100,
            max_age: 180,
        };
        let one = 10i64.checked_pow(expo.unsigned_abs());
        let one = one.unwrap_or(i64::MAX);
        let verdict = check_quote(&rules, 0, &seen(one, START), START);
        assert_eq!(
            verdict,
            Ok(QuoteVerdict::Healthy {
                ok_until: START + 180
            }),
            "expo {expo}"
        );
    }
    let too_far = QuoteRules {
        expo: -20,
        max_conf_bps: 100,
        depeg_bps: 100,
        max_age: 180,
    };
    assert_eq!(
        check_quote(&too_far, 0, &seen(1, START), START),
        Err(E::InvalidMarketParams)
    );
}

/// Held: the first observation opens nothing even on an active market, and a market
/// rebound while paused stays paused through its first mark.
#[test]
fn held_a_first_mark_never_leaves_a_market_active() {
    for status in [STATUS_ACTIVE, STATUS_REDUCE_ONLY, STATUS_PAUSED] {
        let mut params = perp_with_window();
        params.status = status;
        let mut feed = PriceFeed::zeroed();
        feed.binding = unit_binding();
        sync_source(&mut feed, &mut params, &seen(1_000, START), START).unwrap();
        assert_ne!(params.status, STATUS_ACTIVE);
        if status == STATUS_PAUSED {
            assert_eq!(params.status, STATUS_PAUSED);
        }
    }
}

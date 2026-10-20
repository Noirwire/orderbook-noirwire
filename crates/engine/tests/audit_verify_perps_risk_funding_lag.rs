//! Audit verification: the funding premium is measured against the mark at each fill,
//! so small, ordinary moves after a fill at the mark charge nothing, and no fill means
//! no funding.

mod common;

use common::*;
use noirwire_orderbook_engine::*;

const SOL: u64 = DEPLOYED_MARK;

#[test]
fn audit_verify_a_small_drift_after_a_fill_at_the_mark_charges_nothing() {
    let mut w = World::new(16, 64);
    let m = w.add_market(deployed_perp(0));
    w.set_price(m, SOL);
    let long = funded(&mut w, 30_000_000);
    let short = funded(&mut w, 30_000_000);
    w.place(m, short, limit(Side::Ask, SOL, 1_000)).unwrap();
    assert_eq!(
        w.place(m, long, ioc(Side::Bid, SOL, 1_000)).unwrap().filled,
        1_000
    );

    w.now += 60;
    let drift = SOL + SOL * 30 / 10_000;
    assert_eq!(w.publish(m, drift, w.now), Ok(()));
    assert_eq!(w.fund(m), Ok(true));
    assert_eq!(
        w.funding_units(m),
        0,
        "the only fill was at the mark of its moment"
    );
}

#[test]
fn audit_verify_no_fill_in_the_interval_means_no_funding() {
    let mut w = World::new(16, 64);
    let m = w.add_market(deployed_perp(0));
    w.set_price(m, SOL);
    let long = funded(&mut w, 30_000_000);
    let short = funded(&mut w, 30_000_000);
    w.place(m, short, limit(Side::Ask, SOL, 1_000)).unwrap();
    w.place(m, long, ioc(Side::Bid, SOL, 1_000)).unwrap();
    w.now += 60;
    w.set_price(m, SOL);
    assert_eq!(w.fund(m), Ok(true));
    w.now += 60;
    let step = SOL + SOL * 250 / 10_000;
    assert_eq!(w.publish(m, step, w.now), Ok(()));
    assert_eq!(w.fund(m), Ok(true));
    println!(
        "no fill in the interval: F = {}",
        w.markets[m].book.funding_index
    );
    assert_eq!(w.markets[m].book.funding_index, 0);
}

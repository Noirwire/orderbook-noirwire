//! RULES 6: a recorded shortfall stops collateral withdrawals, and spot balances of the
//! collateral token stay outside that freeze. They are not claims on the perp pool, and
//! collateral cannot move into them while the shortfall is recorded, so paying them out
//! leaves the collateral holders' deficit exactly where it was.

mod common;

use common::*;
use noirwire_orderbook_engine::EngineError as E;
use noirwire_orderbook_engine::*;

/// What `crash` leaves uncovered: 100 lots bought at 1,000 on 10,500 of collateral,
/// liquidated at a mark of 500 with no penalty, since the target is bankrupt there,
/// less the 300 of taker fee the fee seat holds and pays first (RULES 8.5).
const UNCOVERED: i128 = 39_500;

fn funded(w: &mut World, collateral: u64) -> u32 {
    let seat = w.open();
    w.deposit(seat, Asset::Collateral, collateral).unwrap();
    seat
}

fn shared_custody(w: &World) -> i128 {
    w.custody_collateral + w.custody_spot[0] as i128
}

fn positive_collateral(w: &World) -> i128 {
    w.seats
        .iter()
        .filter(|seat| seat.is_open())
        .map(|seat| i128::from(seat.collateral.max(0)))
        .sum()
}

fn spot_claims(w: &World) -> i128 {
    w.seats
        .iter()
        .map(|seat| i128::from(seat.spot[0].available) + i128::from(seat.spot[0].locked))
        .sum()
}

fn perp_deficit(w: &World) -> i128 {
    positive_collateral(w) - (shared_custody(w) - spot_claims(w))
}

fn crash(w: &mut World, m: usize, loser: u32, counter: u32) {
    w.place(m, counter, limit(Side::Ask, 1000, 100)).unwrap();
    assert_eq!(
        w.place(m, loser, ioc(Side::Bid, 1000, 100)).unwrap().filled,
        100
    );
    w.set_price(m, 500);
    let outcome = w.liquidate(m, counter, loser, 100).unwrap();
    assert_eq!(i128::from(outcome.uncovered), UNCOVERED);
}

#[test]
fn spot_exit_during_shortfall_leaves_the_perp_deficit_unchanged() {
    let mut w = World::new(16, 8);
    let m = w.add_market(perp_params(0));
    let attacker = funded(&mut w, 100_000);
    let victim = funded(&mut w, 100_000);
    let loser = funded(&mut w, 10_500);
    let counter = funded(&mut w, 1_000_000);

    w.withdraw(attacker, Asset::Collateral, 90_000).unwrap();
    w.deposit(attacker, Asset::Spot(0), 90_000).unwrap();
    crash(&mut w, m, loser, counter);

    let victim_claim = w.collateral(victim);
    assert_eq!(perp_deficit(&w), UNCOVERED);
    w.withdraw(attacker, Asset::Spot(0), 90_000).unwrap();
    assert_eq!(perp_deficit(&w), UNCOVERED);
    assert_eq!(w.collateral(victim), victim_claim);
    assert_eq!(
        w.withdraw(victim, Asset::Collateral, 1),
        Err(E::ShortfallOutstanding)
    );
}

#[test]
fn moving_collateral_to_spot_during_a_shortfall_is_refused() {
    let mut w = World::new(16, 8);
    let m = w.add_market(perp_params(0));
    let attacker = funded(&mut w, 100_000);
    let loser = funded(&mut w, 10_500);
    let counter = funded(&mut w, 1_000_000);
    crash(&mut w, m, loser, counter);
    assert_eq!(
        w.withdraw(attacker, Asset::Collateral, 1),
        Err(E::ShortfallOutstanding),
        "a transfer from collateral to spot debits through this same withdrawal"
    );
}

#[test]
fn parking_in_spot_is_the_same_as_leaving_before_the_crash() {
    let run = |park_in_spot: bool| {
        let mut w = World::new(16, 8);
        let m = w.add_market(perp_params(0));
        let attacker = funded(&mut w, 100_000);
        let victim = funded(&mut w, 100_000);
        let loser = funded(&mut w, 10_500);
        let counter = funded(&mut w, 1_000_000);
        w.withdraw(attacker, Asset::Collateral, 90_000).unwrap();
        if park_in_spot {
            w.deposit(attacker, Asset::Spot(0), 90_000).unwrap();
        }
        crash(&mut w, m, loser, counter);
        if park_in_spot {
            w.withdraw(attacker, Asset::Spot(0), 90_000).unwrap();
        }
        (
            perp_deficit(&w),
            w.collateral(victim),
            w.collateral(counter),
            shared_custody(&w),
        )
    };
    assert_eq!(run(true), run(false));
}

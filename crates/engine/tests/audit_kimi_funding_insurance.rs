//! Audit replay, insurance seat and funding: hypotheses H21, H22, H23, H25,
//! H26 and H27 of the exploit catalogue. Each test asserts the defensive
//! behavior; a failure demonstrates the attack.

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

/// One wash trade at the top of the band, which moves the funding premium.
fn wash_at_band_top(w: &mut World, m: usize, maker: u32, taker: u32) {
    w.place(m, maker, limit(Side::Ask, 1050, 1)).unwrap();
    assert_eq!(w.place(m, taker, ioc(Side::Bid, 1050, 1)).unwrap().filled, 1);
}

/// A liquidation that leaves `debtor` flat, owing 520, of which insurance
/// covers 200 and 320 is recorded on the market.
fn world_with_shortfall() -> (World, usize, u32) {
    let mut w = World::new(10, 8);
    let m = w.add_market(perp_params(0));
    w.deposit(INSURANCE_SEAT, Asset::Collateral, 200).unwrap();
    let maker = funded(&mut w, 100_000);
    let liquidator = funded(&mut w, 100_000);
    let debtor = funded(&mut w, 1_100);
    buy_from(&mut w, m, debtor, maker, 1000, 10);
    w.set_price(m, 850);
    let outcome = w.liquidate(m, liquidator, debtor, 10).unwrap();
    assert_eq!((outcome.insurance_paid, outcome.uncovered), (200, 320));
    (w, m, debtor)
}

/// H21 and H22. While a shortfall is recorded, no collateral leaves any trader
/// seat, so nobody can take their profit out first and leave the loss behind.
/// The second assertion probes whether the same freeze covers the admin's fee
/// collection, as RULES 6's "refused for everyone" suggests it should.
#[test]
fn h22_shortfall_freezes_all_collateral_withdrawals_until_repaid() {
    let (mut w, m, debtor) = world_with_shortfall();
    let bystander = funded(&mut w, 100);
    assert_eq!(w.withdraw(bystander, Asset::Collateral, 50), Err(E::ShortfallOutstanding));
    let maker = 3; // the short counterparty, in profit
    assert_eq!(w.withdraw(maker, Asset::Collateral, 1), Err(E::ShortfallOutstanding));
    assert_eq!(w.resume(m), Err(E::ShortfallOutstanding));

    let fees = w.collateral(FEE_SEAT);
    assert!(fees > 0, "the debtor's taker fee");
    assert_eq!(
        w.collect_fees(Asset::Collateral, fees as u64),
        Err(E::ShortfallOutstanding),
        "RULES 6: collateral withdrawals are refused for everyone while a \
         shortfall is recorded, yet the fee seat's collateral may leave custody"
    );

    w.deposit(debtor, Asset::Collateral, 520).unwrap();
    assert_eq!(w.collateral(debtor), 0);
    assert_eq!(w.reconcile(), 320, "the record falls to what flat seats still owe");
    assert_eq!(w.resume(m), Ok(()));
    assert_eq!(w.withdraw(bystander, Asset::Collateral, 50), Ok(()));
}

/// H23. The reserved seats: no key can trade, withdraw, close or liquidate for
/// them, and the insurance seat cannot hold a position to be liquidated.
#[test]
fn h23_reserved_seats_cannot_trade_withdraw_close_or_liquidate() {
    let mut w = World::new(10, 8);
    let m = w.add_market(perp_params(0));
    let trader = funded(&mut w, 10_000);
    for reserved in [FEE_SEAT, INSURANCE_SEAT] {
        assert_eq!(
            w.place(m, reserved, limit(Side::Bid, 990, 1)),
            Err(E::ReservedSeat)
        );
        assert_eq!(w.withdraw(reserved, Asset::Collateral, 1), Err(E::ReservedSeat));
        assert_eq!(w.close(reserved), Err(E::ReservedSeat));
        assert_eq!(w.liquidate(m, reserved, trader, 1), Err(E::ReservedSeat));
    }
    let at_insurance = w.liquidate(m, trader, INSURANCE_SEAT, 1).unwrap();
    assert_eq!(at_insurance.status, LiquidationStatus::NoPosition);

    // The engine's own `deposit` credits any open seat, the insurance seat
    // included: RULES 12a's "ordinary deposits are refused" is the program's
    // check (its deposit names the beneficiary by view, and the reserved seats
    // have none; funding the insurance seat goes through `fund_insurance`).
    assert_eq!(w.deposit(INSURANCE_SEAT, Asset::Collateral, 1), Ok(()));
}

/// H25. Funding is exactly zero-sum across seats, even split over many tiny
/// seats, and each interval's step is bounded by `funding_cap_bps` of the mark.
#[test]
fn h25_funding_is_zero_sum_and_capped() {
    let mut w = World::new(16, 8);
    let m = w.add_market(perp_params(0));
    let long = funded(&mut w, 100_000);
    let shorts: Vec<u32> = (0..3).map(|_| funded(&mut w, 100_000)).collect();
    let wash_maker = funded(&mut w, 100_000);
    let wash_taker = funded(&mut w, 100_000);
    for short in &shorts {
        w.place(m, *short, limit(Side::Ask, 1000, 1)).unwrap();
    }
    assert_eq!(w.place(m, long, ioc(Side::Bid, 1000, 3)).unwrap().filled, 3);
    wash_at_band_top(&mut w, m, wash_maker, wash_taker);

    let before: Vec<i128> = [long].iter().chain(&shorts).map(|s| w.equity(*s)).collect();
    w.now += 3_600;
    w.set_price(m, 1000);
    assert_eq!(w.fund(m), Ok(true));
    let index = w.markets[m].book.funding_index;
    assert_eq!(index, 5, "a 5% premium clamps to the 0.5% cap: 1000 * 50 / 10000");

    let after: Vec<i128> = [long].iter().chain(&shorts).map(|s| w.equity(*s)).collect();
    let deltas: Vec<i128> = before.iter().zip(&after).map(|(b, a)| a - b).collect();
    assert_eq!(deltas[0], -15, "the long pays 3 lots * 5");
    assert_eq!(deltas[1..], [5, 5, 3 + 2], "the shorts share it per lot");
    assert_eq!(deltas.iter().sum::<i128>(), 0, "exactly zero-sum, no residue to farm");
}

/// H26. Funding is charged exactly once per interval per seat: opening after an
/// update and closing before the next pays nothing; holding through one pays
/// `base * step` exactly; and unpaid funding is charged before a withdrawal.
#[test]
fn h26_funding_timing_gives_no_free_capture() {
    let mut w = World::new(16, 8);
    let m = w.add_market(perp_params(0));
    let maker = funded(&mut w, 1_000_000);
    let wash_maker = funded(&mut w, 100_000);
    let wash_taker = funded(&mut w, 100_000);
    let x = funded(&mut w, 2_000);
    let y = funded(&mut w, 2_000);
    let z = funded(&mut w, 5_000);

    wash_at_band_top(&mut w, m, wash_maker, wash_taker);
    w.now += 3_600;
    w.set_price(m, 1000);
    assert_eq!(w.fund(m), Ok(true));
    assert_eq!(w.markets[m].book.funding_index, 5);

    // x and y open after the update; x closes before the next one
    buy_from(&mut w, m, x, maker, 1000, 10);
    buy_from(&mut w, m, y, maker, 1000, 10);
    w.place(m, maker, limit(Side::Bid, 1000, 10)).unwrap();
    assert_eq!(w.place(m, x, ioc(Side::Ask, 1000, 10)).unwrap().filled, 10);
    assert_eq!(w.equity(x), 1_940, "two taker fees and not one atom of funding");

    wash_at_band_top(&mut w, m, wash_maker, wash_taker);
    w.now += 3_600;
    w.set_price(m, 1000);
    assert_eq!(w.fund(m), Ok(true));
    assert_eq!(w.markets[m].book.funding_index, 10);

    w.place(m, maker, limit(Side::Bid, 1000, 10)).unwrap();
    assert_eq!(w.place(m, y, ioc(Side::Ask, 1000, 10)).unwrap().filled, 10);
    assert_eq!(w.equity(y), 1_890, "one interval: 10 lots * 5 atoms, once");

    // z opens at F = 10; one more interval passes; the pending 50 atoms are
    // charged before any withdrawal is measured against margin
    buy_from(&mut w, m, z, maker, 1000, 10);
    wash_at_band_top(&mut w, m, wash_maker, wash_taker);
    w.now += 3_600;
    w.set_price(m, 1000);
    assert_eq!(w.fund(m), Ok(true));
    assert_eq!(w.markets[m].book.funding_index, 15);

    assert_eq!(w.collateral(z), 4_970);
    assert_eq!(w.equity(z), 4_920);
    assert_eq!(w.withdraw(z, Asset::Collateral, 3_921), Err(E::InsufficientMargin));
    assert_eq!(w.withdraw(z, Asset::Collateral, 3_920), Ok(()));
}

/// H27. After an outage of a hundred intervals, one call applies exactly one
/// interval; a second call in the same interval does nothing.
#[test]
fn h27_missed_intervals_are_never_caught_up() {
    let mut w = World::new(10, 8);
    let m = w.add_market(perp_params(0));
    let wash_maker = funded(&mut w, 100_000);
    let wash_taker = funded(&mut w, 100_000);
    wash_at_band_top(&mut w, m, wash_maker, wash_taker);

    w.now += 3_600 * 100;
    w.set_price(m, 1000);
    assert_eq!(w.fund(m), Ok(true));
    assert_eq!(
        w.markets[m].book.funding_index,
        5,
        "one interval only, so an outage cannot liquidate the book in one step"
    );
    assert_eq!(w.fund(m), Ok(false));
    assert_eq!(w.markets[m].book.funding_index, 5);
}

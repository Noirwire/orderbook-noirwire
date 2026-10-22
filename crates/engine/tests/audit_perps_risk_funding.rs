//! Audit, perps risk: funding. Each test builds the attack from public instructions
//! only (orders, `update_funding`) on a market with the limits the deployment script
//! uses (`ops/deployment.ts`, `LIMITS`, market 0 NSOL-PERP).

mod common;

use common::*;
use noirwire_orderbook_engine::*;

/// NSOL-PERP's initial mark: quote atoms per lot of 0.001 SOL.
const SOL: u64 = DEPLOYED_MARK;
/// The highest bid the crossing band allows at that mark: 4% above it.
const BAND_EDGE: u64 = 156_000;
/// The smallest size whose notional at the band edge meets `min_notional`.
const WASH_LOTS: u64 = 7;

#[test]
fn audit_perps_risk_a_seven_lot_wash_trade_costs_more_than_the_funding_it_moves() {
    let mut w = World::new(16, 64);
    let m = w.add_market(deployed_perp(0));
    w.set_price(m, SOL);
    let victim = funded(&mut w, 20_000_000);
    let attacker = funded(&mut w, 20_000_000);
    let wash_taker = funded(&mut w, 5_000_000);
    let wash_maker = funded(&mut w, 5_000_000);
    let attacker_seats = [attacker, wash_taker, wash_maker];
    let worth = |w: &World| -> i128 { attacker_seats.iter().map(|s| w.equity(*s)).sum() };

    w.place(m, attacker, limit(Side::Ask, SOL, 1_000)).unwrap();
    let opened = w.place(m, victim, ioc(Side::Bid, SOL, 1_000)).unwrap();
    assert_eq!(opened.filled, 1_000);
    w.now += 60;
    w.set_price(m, SOL);
    assert_eq!(w.fund(m), Ok(true));
    assert_eq!(w.markets[m].book.funding_index, 0);
    assert!(!w.is_liquidatable(victim, m));

    let victim_equity_before = w.equity(victim);
    let attacker_worth_before = worth(&w);
    let mut wash_fees: u64 = 0;
    let intervals = 20;
    for _ in 0..intervals {
        w.place(m, wash_maker, limit(Side::Ask, BAND_EDGE, WASH_LOTS))
            .unwrap();
        let wash = w
            .place(m, wash_taker, ioc(Side::Bid, BAND_EDGE, WASH_LOTS))
            .unwrap();
        assert_eq!(wash.filled, WASH_LOTS);
        wash_fees += wash.fee_paid;
        w.now += 60;
        w.set_price(m, SOL);
        assert_eq!(w.fund(m), Ok(true));
    }

    let victim_lost = victim_equity_before - w.equity(victim);
    let attacker_gained = worth(&w) - attacker_worth_before;
    assert_eq!(w.markets[m].price.price, SOL, "the mark never moved");
    assert!(!w.is_liquidatable(victim, m));
    assert!(
        victim_lost * 4 <= i128::from(wash_fees),
        "RULES 7: funding moved times open interest is at most a quarter of the fees; \
         {intervals} washes of {WASH_LOTS} lots paid {wash_fees} and moved {victim_lost}"
    );
    assert!(
        attacker_gained < 0,
        "RULES 7 (moving funding costs taker fees): {intervals} wash trades of \
         {WASH_LOTS} lots cost the attacker {wash_fees} atoms of taker fee and moved \
         {victim_lost} atoms of funding from the victim, so the attacker's seats \
         changed by {attacker_gained}"
    );
}

/// The same lever pointed at the insurance seat: the attacker holds both sides and
/// tries to fund its own short from its own long until the long is bankrupt at an
/// unchanged mark, to liquidate it with the short and have insurance pay its debt.
#[test]
fn audit_perps_risk_wash_funding_cannot_bankrupt_an_attacker_seat_at_a_profit() {
    let mut w = World::new(16, 64);
    let m = w.add_market(deployed_perp(0));
    w.set_price(m, SOL);
    w.deposit(INSURANCE_SEAT, Asset::Collateral, 10_000_000)
        .unwrap();
    let long = funded(&mut w, 16_000_000);
    let short = funded(&mut w, 20_000_000);
    let wash_taker = funded(&mut w, 5_000_000);
    let wash_maker = funded(&mut w, 5_000_000);
    let attacker = [long, short, wash_taker, wash_maker];
    let total = |w: &World| -> i128 { attacker.iter().map(|seat| w.equity(*seat)).sum() };
    let deposited: i128 = 16_000_000 + 20_000_000 + 5_000_000 + 5_000_000;

    w.place(m, short, limit(Side::Ask, SOL, 1_000)).unwrap();
    assert_eq!(
        w.place(m, long, ioc(Side::Bid, SOL, 1_000)).unwrap().filled,
        1_000
    );
    w.now += 60;
    w.set_price(m, SOL);
    w.fund(m).unwrap();
    let intervals = 30;
    for _ in 0..intervals {
        w.place(m, wash_maker, limit(Side::Ask, BAND_EDGE, WASH_LOTS))
            .unwrap();
        w.place(m, wash_taker, ioc(Side::Bid, BAND_EDGE, WASH_LOTS))
            .unwrap();
        w.now += 60;
        w.set_price(m, SOL);
        w.fund(m).unwrap();
    }
    let outcome = w.liquidate(m, short, long, 1_000).unwrap();

    assert_eq!(outcome.status, LiquidationStatus::NotLiquidatable);
    assert_eq!(outcome.insurance_paid, 0);
    assert_eq!(w.markets[m].price.price, SOL, "the mark never moved");
    let insurance_left = w.collateral(INSURANCE_SEAT);
    let profit = total(&w) - deposited;
    assert!(
        profit <= 0,
        "RULES 8.5 and 13.9: after {intervals} wash-funded intervals at an unchanged mark \
         the attacker's own long was bankrupt; liquidating it with the attacker's own \
         short made the insurance seat pay {} atoms, and the attacker's four seats \
         together are up {profit} atoms (insurance left: {insurance_left})",
        outcome.insurance_paid
    );
}

/// No attacker at all: one honest trade at the mark, then one ordinary oracle step
/// inside `max_move_bps`. Each fill's premium is measured against the mark it was made
/// at, so a trending market alone charges no funding.
#[test]
fn audit_perps_risk_one_ordinary_oracle_step_charges_no_funding() {
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
    let short_before = w.equity(short);

    w.now += 60;
    let one_step = SOL + SOL * 250 / 10_000;
    assert_eq!(w.publish(m, one_step, w.now), Ok(()));
    assert_eq!(w.fund(m), Ok(true));
    assert_eq!(w.funding_units(m), 0);

    let funding_paid_by_short = -i128::from(w.markets[m].book.funding_index) * 1_000;
    let mark_pnl_of_short = -i128::from(one_step - SOL) * 1_000;
    assert_eq!(
        w.equity(short) - short_before,
        mark_pnl_of_short - funding_paid_by_short
    );
    let notional = i128::from(one_step) * 1_000;
    assert!(
        funding_paid_by_short * 10_000 < notional * 10,
        "RULES 7: with no fill away from the mark, one oracle step of 2.5% made the \
         short pay {funding_paid_by_short} atoms of funding in one 60 s interval, {} bps \
         of notional; the whole price move cost it {}",
        funding_paid_by_short * 10_000 / notional,
        -mark_pnl_of_short
    );
}

#[test]
fn audit_perps_risk_a_wash_among_real_volume_at_the_mark_moves_at_most_half_its_fee() {
    let mut w = World::new(16, 64);
    let m = w.add_market(deployed_perp(0));
    w.set_price(m, SOL);
    let a = funded(&mut w, 200_000_000);
    let b = funded(&mut w, 200_000_000);
    let wash_taker = funded(&mut w, 50_000_000);
    let wash_maker = funded(&mut w, 50_000_000);
    w.now += 60;
    w.set_price(m, SOL);
    assert_eq!(w.fund(m), Ok(true));

    w.place(m, a, limit(Side::Ask, SOL, 1_000)).unwrap();
    assert_eq!(
        w.place(m, b, ioc(Side::Bid, SOL, 1_000)).unwrap().filled,
        1_000
    );
    let real_volume = 1_000;
    let wash_lots = real_volume / 3;
    w.place(m, wash_maker, limit(Side::Ask, BAND_EDGE, wash_lots))
        .unwrap();
    let wash = w
        .place(m, wash_taker, ioc(Side::Bid, BAND_EDGE, wash_lots))
        .unwrap();
    w.now += 60;
    w.set_price(m, SOL);
    assert_eq!(w.fund(m), Ok(true));

    let index = w.markets[m].book.funding_index;
    let paid_by_the_real_long = 1_000 * i128::from(index);
    let open_interest = i128::from(w.markets[m].book.open_interest);
    assert!(
        w.funding_units(m) * open_interest * 2 <= i128::from(wash.fee_paid) * FUNDING_CARRY_SCALE,
        "RULES 7: added fills move funding times open interest by at most half their fee"
    );
    assert!(
        paid_by_the_real_long <= i128::from(wash.fee_paid),
        "RULES 7: a wash of a third of the interval's real volume cost {} atoms of fee \
         and moved F by {index} per lot, {paid_by_the_real_long} atoms out of the real long",
        wash.fee_paid
    );
}

//! Audit, perps risk: funding. Each test builds the attack from public instructions
//! only (orders, `update_funding`) on a market with the limits the deployment script
//! uses (`ops/deployment.ts`, `LIMITS`, market 0 NSOL-PERP).

mod common;

use bytemuck::Zeroable;
use common::*;
use noirwire_orderbook_engine::*;

/// `ops/deployment.ts` LIMITS with the NSOL-PERP tick and lot.
fn deployed_perp(market_id: u8) -> MarketParams {
    MarketParams {
        tick: 100,
        base_lot: 1_000_000,
        min_size: 1,
        min_notional: 1_000_000,
        funding_interval: 60,
        max_price_age: 10,
        max_age_liquidation: 60,
        open_interest_cap: 10_000_000,
        band_bps: 400,
        im_bps: 1_000,
        mm_bps: 500,
        taker_fee_bps: 5,
        liq_penalty_bps: 200,
        funding_cap_bps: 100,
        max_move_bps: 250,
        min_publish_gap: 1,
        max_open_orders: 32,
        liq_buffer_bps: 100,
        liq_insurance_share_bps: 5_000,
        fee_insurance_share_bps: 5_000,
        kind: KIND_PERP,
        market_id,
        ..MarketParams::zeroed()
    }
}

/// NSOL-PERP's initial mark: quote atoms per lot of 0.001 SOL.
const SOL: u64 = 150_000;
/// The highest bid the crossing band allows at that mark: 4% above it.
const BAND_EDGE: u64 = 156_000;
/// The smallest size whose notional at the band edge meets `min_notional`.
const WASH_LOTS: u64 = 7;

fn funded(w: &mut World, collateral: u64) -> u32 {
    let seat = w.open();
    w.deposit(seat, Asset::Collateral, collateral).unwrap();
    seat
}

#[test]
fn audit_perps_risk_a_seven_lot_wash_trade_sets_the_funding_rate_of_the_whole_market() {
    let mut w = World::new(16, 64);
    let m = w.add_market(deployed_perp(0));
    w.set_price(m, SOL);
    let victim = funded(&mut w, 20_000_000);
    let attacker = funded(&mut w, 20_000_000);
    let wash_taker = funded(&mut w, 5_000_000);
    let wash_maker = funded(&mut w, 5_000_000);

    w.place(m, attacker, limit(Side::Ask, SOL, 1_000)).unwrap();
    let opened = w.place(m, victim, ioc(Side::Bid, SOL, 1_000)).unwrap();
    assert_eq!(opened.filled, 1_000);
    w.now += 60;
    w.set_price(m, SOL);
    assert_eq!(w.fund(m), Ok(true));
    assert_eq!(w.markets[m].book.funding_index, 0);
    assert!(!w.is_liquidatable(victim, m));

    let victim_equity_before = w.equity(victim);
    let attacker_equity_before = w.equity(attacker);
    let mut wash_fees: u64 = 0;
    let mut intervals = 0;
    while !w.is_liquidatable(victim, m) && intervals < 20 {
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
        intervals += 1;
    }

    let victim_lost = victim_equity_before - w.equity(victim);
    let attacker_gained = w.equity(attacker) - attacker_equity_before;
    assert_eq!(w.markets[m].price.price, SOL, "the mark never moved");
    assert_eq!(w.markets[m].book.funding_index, 1_500 * intervals);
    assert_eq!(attacker_gained, victim_lost);
    assert!(
        victim_lost <= i128::from(wash_fees),
        "RULES 7 (moving funding costs taker fees): {intervals} wash trades of \
         {WASH_LOTS} lots cost the attacker {wash_fees} atoms of taker fee, yet moved \
         {victim_lost} atoms of funding from the victim to the attacker's short and made \
         the victim liquidatable at an unchanged mark"
    );
}

/// The same lever pointed at the insurance seat: the attacker holds both sides, funds
/// its own short from its own long until the long is bankrupt at an unchanged mark,
/// then liquidates it with the short. The insurance seat pays the long's debt.
#[test]
fn audit_perps_risk_wash_funding_bankrupts_an_attacker_seat_and_insurance_pays_for_it() {
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
    let mut intervals = 0;
    while w.equity(long) >= 0 && intervals < 30 {
        w.place(m, wash_maker, limit(Side::Ask, BAND_EDGE, WASH_LOTS))
            .unwrap();
        w.place(m, wash_taker, ioc(Side::Bid, BAND_EDGE, WASH_LOTS))
            .unwrap();
        w.now += 60;
        w.set_price(m, SOL);
        w.fund(m).unwrap();
        intervals += 1;
    }
    let outcome = w.liquidate(m, short, long, 1_000).unwrap();

    assert_eq!(outcome.status, LiquidationStatus::Liquidated);
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
/// inside `max_move_bps`. The premium compares fills made at the old mark with the new
/// one, so a single tick of a trending market charges `funding_cap_bps` of notional,
/// every interval (60 s in the deployment).
#[test]
fn audit_perps_risk_one_ordinary_oracle_step_charges_the_full_funding_cap() {
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
fn audit_perps_risk_funding_follows_the_wash_even_when_real_volume_traded_at_the_mark() {
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
    assert!(
        paid_by_the_real_long <= i128::from(wash.fee_paid),
        "RULES 7: a wash of a third of the interval's real volume cost {} atoms of fee \
         and moved F by {index} per lot, {paid_by_the_real_long} atoms out of the real long",
        wash.fee_paid
    );
}

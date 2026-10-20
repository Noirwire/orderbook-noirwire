//! Audit, perps risk: liquidation, staleness and the shortfall freeze.

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

/// A liquidator whose own equity rests on a position whose feed has stopped takes over
/// a position that the same seat could not have bought with an order.
#[test]
fn audit_perps_risk_a_liquidator_on_a_stale_feed_takes_exposure_an_order_could_not() {
    let mut w = World::new(10, 8);
    let m0 = w.add_market(perp_params(0));
    let m1 = w.add_market(perp_params(1));
    let maker = funded(&mut w, 1_000_000);
    let liquidator = funded(&mut w, 2_100);
    let target = funded(&mut w, 1_100);
    buy_from(&mut w, m1, liquidator, maker, 1_000, 10);
    buy_from(&mut w, m0, target, maker, 1_000, 10);

    w.now += 400;
    w.set_price(m0, 900);
    assert!(w.is_liquidatable(target, m0));
    let as_an_order = w.place(m0, liquidator, limit(Side::Bid, 900, 10));
    assert_eq!(as_an_order, Err(E::StalePrice));

    let outcome = w.liquidate(m0, liquidator, target, 10).unwrap();

    let at_a_fresh_m1_price_of_700 = {
        let mut risks = w.risks();
        risks[m1].mark = 700;
        equity(w.seat(liquidator), &risks).unwrap()
    };
    assert_ne!(
        outcome.status,
        LiquidationStatus::Liquidated,
        "RULES 9 (staleness blocks what increases exposure): the liquidator holds a \
         position on market 1 whose feed is {} s old, so place_order refused it, yet \
         liquidate let it take over {} lots on market 0, valuing market 1 at its last \
         price; were market 1 at 700 its equity would be {at_a_fresh_m1_price_of_700}",
        400,
        outcome.liquidated
    );
}

/// RULES 8.3: the liquidated size is the one that brings the target back to maintenance
/// margin plus the buffer. The size formula uses the exact penalty while the price uses
/// the penalty rounded up per lot, so with no buffer the target can be left below
/// maintenance and is liquidated, and pays the penalty, again.
#[test]
fn audit_perps_risk_a_restoring_liquidation_can_leave_the_target_below_maintenance() {
    let mut params = perp_params(0);
    params.liq_buffer_bps = 0;
    assert!(params.check().is_ok());
    let mut w = World::new(10, 8);
    let m = w.add_market(params);
    let maker = funded(&mut w, 1_000_000);
    let liquidator = funded(&mut w, 1_000_000);
    let target = funded(&mut w, 14_000);
    buy_from(&mut w, m, target, maker, 1_000, 100);
    w.set_price(m, 905);
    assert!(w.is_liquidatable(target, m));

    let first = w.liquidate(m, liquidator, target, 100).unwrap();

    assert_eq!(first.status, LiquidationStatus::Liquidated);
    assert!(first.liquidated < 100, "a partial liquidation");
    assert!(
        !w.is_liquidatable(target, m),
        "RULES 8.3: a liquidation of {} lots, sized to restore maintenance margin, left \
         the target at equity {} against maintenance {}",
        first.liquidated,
        w.equity(target),
        w.maintenance_margin(target)
    );
}

/// RULES 9 lets a liquidation run on a feed up to `max_age_liquidation` old, but the
/// trader's own spot balance of the collateral token cannot be moved into collateral to
/// save the position in that window: `transfer_between_balances` debits it through
/// `withdraw`, which refuses on a stale feed for anyone holding a position.
#[test]
fn audit_perps_risk_a_trader_cannot_move_own_spot_funds_to_collateral_while_being_liquidated() {
    let mut w = World::new(10, 8);
    let m = w.add_market(perp_params(0));
    let maker = funded(&mut w, 1_000_000);
    let liquidator = funded(&mut w, 1_000_000);
    let target = funded(&mut w, 1_100);
    w.deposit(target, Asset::Spot(QUOTE), 50_000).unwrap();
    buy_from(&mut w, m, target, maker, 1_000, 10);
    w.set_price(m, 920);
    w.now += 100;
    assert!(w.is_liquidatable(target, m));

    let debit_half_of_the_transfer = w.withdraw(target, Asset::Spot(QUOTE), 5_000);
    let liquidated = w.liquidate(m, liquidator, target, 10).unwrap();

    assert_eq!(liquidated.status, LiquidationStatus::Liquidated);
    assert_eq!(
        debit_half_of_the_transfer,
        Ok(()),
        "RULES 9 (staleness never blocks what only shrinks risk): the target held 50,000 \
         spot atoms of the collateral token, the feed was fresh enough to liquidate it, \
         but moving spot funds into collateral was refused"
    );
}

/// A liquidation that leaves `debtor` flat, owing 520, with 200 of it paid by insurance.
fn uncovered_shortfall() -> (World, usize, u32) {
    let mut w = World::new(10, 8);
    let m = w.add_market(perp_params(0));
    w.deposit(INSURANCE_SEAT, Asset::Collateral, 200).unwrap();
    let maker = funded(&mut w, 100_000);
    let liquidator = funded(&mut w, 100_000);
    let debtor = funded(&mut w, 1_100);
    buy_from(&mut w, m, debtor, maker, 1_000, 10);
    w.set_price(m, 850);
    let outcome = w.liquidate(m, liquidator, debtor, 10).unwrap();
    assert_eq!((outcome.insurance_paid, outcome.uncovered), (200, 320));
    (w, m, debtor)
}

/// RULES 6: while any market has a recorded uncovered shortfall, collateral
/// withdrawals are refused for everyone. The fee seat's collateral leaves custody all
/// the same.
#[test]
fn audit_perps_risk_fee_collateral_leaves_custody_while_traders_are_frozen() {
    let (mut w, _m, _debtor) = uncovered_shortfall();
    let trader = w.open();
    w.deposit(trader, Asset::Collateral, 100).unwrap();
    let fees = w.collateral(FEE_SEAT);
    assert!(fees > 0);

    assert_eq!(
        w.withdraw(trader, Asset::Collateral, 100),
        Err(E::ShortfallOutstanding)
    );
    let collected = w.collect_fees(Asset::Collateral, fees as u64);

    assert_eq!(
        collected,
        Err(E::ShortfallOutstanding),
        "RULES 6: collateral withdrawals are refused for everyone while a shortfall is \
         recorded, yet {fees} atoms of fee-seat collateral left custody"
    );
}

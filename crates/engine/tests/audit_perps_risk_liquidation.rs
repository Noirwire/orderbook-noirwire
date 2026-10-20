//! Audit, perps risk: liquidation, staleness and the shortfall freeze.

mod common;

use common::*;
use noirwire_orderbook_engine::EngineError as E;
use noirwire_orderbook_engine::*;

/// A liquidator long on market 1 and a target long on market 0, below maintenance there
/// once market 0 is repriced `market_1_age` seconds after market 1's last price.
fn liquidator_with_a_position_on_another_feed(market_1_age: i64) -> (World, usize, u32, u32) {
    let mut w = World::new(10, 8);
    let m0 = w.add_market(perp_params(0));
    let m1 = w.add_market(perp_params(1));
    let maker = funded(&mut w, 1_000_000);
    let liquidator = funded(&mut w, 2_100);
    let target = funded(&mut w, 1_100);
    buy_from(&mut w, m1, liquidator, maker, 1_000, 10);
    buy_from(&mut w, m0, target, maker, 1_000, 10);
    w.now += market_1_age;
    w.set_price(m0, 900);
    assert!(w.is_liquidatable(target, m0));
    (w, m0, liquidator, target)
}

/// RULES 8 and 9: a liquidator whose own equity rests on a position whose feed is older
/// than that market's `max_age_liquidation` takes nothing over, since a stopped price
/// could hide that it cannot carry the position. It gets "stale price", decided before
/// the target is looked at, and a liquidator with a fresh book still liquidates.
#[test]
fn audit_perps_risk_a_liquidator_on_a_stale_feed_takes_no_exposure_an_order_could_not() {
    let (mut w, m0, liquidator, target) = liquidator_with_a_position_on_another_feed(400);
    assert!(400 > perp_params(1).max_age_liquidation);
    let as_an_order = w.place(m0, liquidator, limit(Side::Bid, 900, 10));
    assert_eq!(as_an_order, Err(E::StalePrice));

    let outcome = w.liquidate(m0, liquidator, target, 10).unwrap();
    assert_eq!(
        outcome.status,
        LiquidationStatus::StalePrice,
        "RULES 8: market 1's feed is 400 s old, past its max_age_liquidation, so the \
         liquidator holding a position there takes nothing over"
    );
    let nobody = w.liquidate(m0, liquidator, 9, 10).unwrap();
    assert_eq!(
        nobody.status,
        LiquidationStatus::StalePrice,
        "the outcome is the same for a seat that is not open: it says nothing of the target"
    );

    let flat_liquidator = funded(&mut w, 1_000_000);
    let outcome = w.liquidate(m0, flat_liquidator, target, 10).unwrap();
    assert_eq!(outcome.status, LiquidationStatus::Liquidated);
}

/// RULES 9: the liquidator's feeds are held to the liquidation limit, not to the order
/// limit. A position on a feed too old for an order, but within `max_age_liquidation`,
/// does not stop its holder from liquidating.
#[test]
fn audit_perps_risk_a_liquidator_on_a_feed_fresh_enough_to_liquidate_still_liquidates() {
    let (mut w, m0, liquidator, target) = liquidator_with_a_position_on_another_feed(100);
    let params = perp_params(1);
    assert!(params.max_price_age < 100 && 100 <= params.max_age_liquidation);
    let as_an_order = w.place(m0, liquidator, limit(Side::Bid, 900, 10));
    assert_eq!(as_an_order, Err(E::StalePrice));

    let outcome = w.liquidate(m0, liquidator, target, 10).unwrap();
    assert_eq!(outcome.status, LiquidationStatus::Liquidated);
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

/// RULES 6 and 9: a transfer between balances applies the withdrawal checks to the side
/// it debits, so on a feed too old for withdrawals but fresh enough to liquidate, a
/// position holder cannot move its spot balance of the collateral token into collateral
/// (`transfer_between_balances` debits it through `withdraw`). A deposit is never
/// blocked, so the trader saves the position by depositing collateral instead.
#[test]
fn audit_perps_risk_a_trader_on_a_stale_feed_saves_its_position_by_deposit_not_by_transfer() {
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

    assert_eq!(
        w.withdraw(target, Asset::Spot(QUOTE), 5_000),
        Err(E::StalePrice),
        "RULES 9: the debit half of the transfer is a withdrawal by a position holder"
    );
    w.deposit(target, Asset::Collateral, 5_000).unwrap();
    assert!(!w.is_liquidatable(target, m));
    let outcome = w.liquidate(m, liquidator, target, 10).unwrap();
    assert_eq!(outcome.status, LiquidationStatus::NotLiquidatable);
}

/// A liquidation that leaves `debtor` flat, owing 430, with 200 of it paid by insurance
/// and 30 by the fee seat.
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
    let paid = (
        outcome.insurance_paid,
        outcome.fee_seat_paid,
        outcome.uncovered,
    );
    assert_eq!(paid, (200, 30, 200));
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
    let other = w.add_market(perp_params(1));
    let (buyer, seller) = (funded(&mut w, 100_000), funded(&mut w, 100_000));
    buy_from(&mut w, other, buyer, seller, 1_000, 10);
    let fees = w.collateral(FEE_SEAT);
    assert!(fees > 0, "a taker fee earned after the shortfall");

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

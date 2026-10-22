//! Audit round 4, spec lens: statements in SECURITY.md and RULES.md section 12 about
//! how fast a position reaches bankruptcy and how much a gap can leave unpaid,
//! checked against the engine at the deployed limits.

mod common;

use bytemuck::Zeroable;
use common::*;
use noirwire_orderbook_engine::*;

/// `ops/deployment.ts` LIMITS with no fee and no funding, so only the mark moves equity.
fn deployed_without_fees() -> MarketParams {
    let mut params = deployed_perp(0);
    params.taker_fee_bps = 0;
    params.funding_cap_bps = 0;
    params.fee_insurance_share_bps = 0;
    params.settle_window = 900;
    params
}

/// The largest price within `max_move_bps` above `mark`.
fn step_up(mark: u64, bps: u64) -> u64 {
    mark + mark * bps / 10_000
}

/// The smallest price within `max_move_bps` below `mark`.
fn step_down(mark: u64, bps: u64) -> u64 {
    mark - mark * bps / 10_000
}

/// SECURITY.md, "What this program does not guarantee", first bound, by side: at the
/// deployed settings a long that was above maintenance needs three updates to reach zero
/// equity, since two move the mark at most 1 - 0.975^2 = 4.94%, while a short's loss
/// compounds as the mark rises, 1.025^2 - 1 = 5.06%, so two updates one second apart
/// take it below zero equity. One update leaves either solvent.
#[test]
fn two_deployed_updates_take_a_short_above_maintenance_to_negative_equity() {
    let params = deployed_without_fees();
    let move_bps = u64::from(params.max_move_bps);
    let (mut w, m) = perp_world(params);
    w.set_price(m, DEPLOYED_MARK);
    let short = funded(&mut w, 150_000);
    let long = funded(&mut w, 100_000_000);
    buy_from(&mut w, m, long, short, DEPLOYED_MARK, 10);

    let staged = 157_142;
    w.set_price(m, staged);
    assert!(w.equity(short) > 0);
    assert!(
        !w.is_liquidatable(short, m),
        "the short starts above maintenance: equity {} maintenance {}",
        w.equity(short),
        w.maintenance_margin(short)
    );

    w.now += 1;
    let first = step_up(staged, move_bps);
    w.publish(m, first, w.now).unwrap();
    assert!(
        w.is_liquidatable(short, m),
        "one update makes it liquidatable"
    );
    assert!(
        w.equity(short) > 0,
        "one update leaves it solvent, as RULES 12 says"
    );

    w.now += 1;
    let second = step_up(first, move_bps);
    w.publish(m, second, w.now).unwrap();
    assert!(
        w.equity(short) < 0,
        "two updates, one second apart, leave equity {} below zero",
        w.equity(short)
    );
}

/// The same staging for a long: three updates are needed.
#[test]
fn a_long_above_maintenance_survives_two_deployed_updates() {
    let params = deployed_without_fees();
    let move_bps = u64::from(params.max_move_bps);
    let (mut w, m) = perp_world(params);
    w.set_price(m, DEPLOYED_MARK);
    let long = funded(&mut w, 150_000);
    let short = funded(&mut w, 100_000_000);
    buy_from(&mut w, m, long, short, DEPLOYED_MARK, 10);

    let staged = 142_106;
    w.set_price(m, staged);
    assert!(!w.is_liquidatable(long, m));
    let mut mark = staged;
    for _ in 0..2 {
        w.now += 1;
        mark = step_down(mark, move_bps) + 1;
        w.publish(m, mark, w.now).unwrap();
    }
    assert!(w.equity(long) > 0);
}

/// RULES 12: one price update leaves a seat that was at maintenance with at least the
/// penalty, on either side. For a short the penalty is measured at the raised mark, so
/// the rule counts it there: a move of 299 bps at maintenance 500 and penalty 200, which
/// would leave a short below one full penalty, is refused, and at the widest move the
/// rule accepts, 294 bps, the short keeps the full penalty.
#[test]
fn one_allowed_update_leaves_a_short_at_maintenance_with_the_full_penalty() {
    let mut params = deployed_without_fees();
    params.max_move_bps = 299;
    assert_eq!(params.check(), Err(EngineError::InvalidMarketParams));
    params.max_move_bps = 295;
    assert_eq!(params.check(), Err(EngineError::InvalidMarketParams));
    params.max_move_bps = 294;
    params.check().unwrap();
    let (mut w, m) = perp_world(params);
    w.set_price(m, DEPLOYED_MARK);
    let short = funded(&mut w, 150_000);
    let long = funded(&mut w, 100_000_000);
    buy_from(&mut w, m, long, short, DEPLOYED_MARK, 10);
    let staged = 157_142;
    w.set_price(m, staged);
    assert!(!w.is_liquidatable(short, m), "at maintenance, not below it");

    w.now += 1;
    let raised = step_up(staged, 294);
    w.publish(m, raised, w.now).unwrap();
    let full_penalty_per_lot = (raised * 200).div_ceil(10_000);
    let full_penalty = i128::from(full_penalty_per_lot) * 10;
    assert!(
        w.equity(short) >= full_penalty,
        "equity {} keeps one full penalty {full_penalty}",
        w.equity(short)
    );
}

/// RULES 8.3a: "When the insurance seat is not open or could not take the credit, the
/// liquidator keeps all of it." An insurance seat at `BALANCE_CAP` cannot take its
/// share, and the liquidation still happens, under every check the harness makes.
#[test]
fn a_full_insurance_seat_leaves_the_whole_penalty_to_the_liquidator() {
    let mut params = free_perp();
    params.liq_insurance_share_bps = 5_000;
    let (mut w, m) = perp_world(params);
    let long = funded(&mut w, 1_000);
    let short = funded(&mut w, 1_000_000);
    let keeper = funded(&mut w, 1_000_000);
    buy_from(&mut w, m, long, short, MARK, 10);
    w.deposit(INSURANCE_SEAT, Asset::Collateral, BALANCE_CAP)
        .unwrap();
    w.set_price(m, 940);
    assert!(w.is_liquidatable(long, m));
    let keeper_before = w.equity(keeper);
    assert!(w.sane_numbers);

    let outcome = w.liquidate(m, keeper, long, 10).unwrap();

    assert_eq!(outcome.status, LiquidationStatus::Liquidated);
    assert!(outcome.price < 940, "a penalty was charged");
    assert_eq!(outcome.penalty_to_insurance, 0);
    let penalty = i128::from(940 - outcome.price) * i128::from(outcome.liquidated);
    assert_eq!(w.equity(keeper) - keeper_before, penalty);
    assert_eq!(w.collateral(INSURANCE_SEAT), BALANCE_CAP as i64);
}

/// RULES 12, "Sizing `open_interest_cap` from insurance": a position waiting to be
/// liquidated keeps at least the penalty, so a settled gap `g` costs insurance at most
/// `open_interest * mark * (g - penalty)` at the mark the gap starts from. One update
/// within the move limit leaves a long that was above maintenance with 2.57% of its
/// notional, short of the 3% (`mm - penalty`) the rule once credited but above the 2%
/// penalty, and the settled 20% gap that follows stays within the bound.
#[test]
fn a_settled_gap_after_one_unliquidated_update_stays_within_the_rules_12_bound() {
    let params = deployed_without_fees();
    let move_bps = u64::from(params.max_move_bps);
    let (mm, penalty) = (
        u128::from(params.mm_bps),
        u128::from(params.liq_penalty_bps),
    );
    let (mut w, m) = perp_world(params);
    let long = funded(&mut w, 150_000);
    let short = funded(&mut w, 100_000_000);
    let keeper = funded(&mut w, 100_000_000);
    w.deposit(INSURANCE_SEAT, Asset::Collateral, 10_000_000)
        .unwrap();

    let mut feed = PriceFeed::zeroed();
    feed.binding = SourceBinding {
        expo: -6,
        max_conf_bps: 100,
        ..SourceBinding::zeroed()
    };
    let seen = |price: u64, publish_time: i64| Observation {
        price: price as i64,
        conf: 0,
        publish_time,
    };
    w.markets[m].price = Price::zeroed();
    w.sync(m, &mut feed, seen(DEPLOYED_MARK, w.now)).unwrap();
    w.resume(m).unwrap();
    buy_from(&mut w, m, long, short, DEPLOYED_MARK, 10);

    w.now += 1;
    let staged = 142_106;
    w.set_price(m, staged);
    feed.price = w.markets[m].price;
    assert!(
        !w.is_liquidatable(long, m),
        "above maintenance before the update"
    );

    w.now += 1;
    let waited = step_down(staged, move_bps) + 1;
    w.sync(m, &mut feed, seen(waited, w.now)).unwrap();
    assert_eq!(w.markets[m].price.price, waited);
    assert!(
        w.is_liquidatable(long, m),
        "liquidatable, and nobody liquidates"
    );
    let notional = 10 * u128::from(waited);
    let equity = u128::try_from(w.equity(long)).unwrap();
    assert!(
        equity * 10_000 < notional * (mm - penalty),
        "equity {equity} is below mm - penalty of notional {notional}"
    );
    assert!(
        equity * 10_000 >= notional * penalty,
        "equity {equity} keeps the penalty of notional {notional}"
    );

    let gapped = waited * 8 / 10;
    w.now += 1;
    w.sync(m, &mut feed, seen(gapped, w.now)).unwrap();
    assert_eq!(w.markets[m].params.oracle_health, ORACLE_DISLOCATED);
    w.now += 1;
    w.sync(m, &mut feed, seen(gapped, w.now)).unwrap();
    assert_eq!(w.markets[m].params.oracle_health, ORACLE_SETTLING);
    assert_eq!(w.markets[m].price.price, gapped);

    let outcome = w.liquidate(m, keeper, long, 10).unwrap();
    assert_eq!(outcome.status, LiquidationStatus::Liquidated);
    let deficit = u128::from(outcome.insurance_paid + outcome.fee_seat_paid + outcome.uncovered);
    let gap_bps = u128::from(waited - gapped) * 10_000 / u128::from(waited);
    let bound = 10 * u128::from(waited) * (gap_bps - penalty) / 10_000;
    assert!(
        deficit <= bound,
        "deficit {deficit} within the RULES 12 bound {bound} for a {gap_bps} bps gap"
    );
}

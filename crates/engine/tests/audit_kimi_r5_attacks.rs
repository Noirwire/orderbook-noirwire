mod common;

use bytemuck::Zeroable;
use common::*;
use noirwire_orderbook_engine::*;

/// A binding with a zero scale: `target = raw_price * base_lot`.
fn unit_binding() -> SourceBinding {
    SourceBinding {
        account: [9; 32],
        feed_id: [8; 32],
        expo: 0,
        max_conf_bps: 10_000,
        base_decimals: 0,
        quote_decimals: 0,
    }
}

fn feed() -> PriceFeed {
    PriceFeed {
        price: Price::zeroed(),
        source: SourceRecord::zeroed(),
        binding: unit_binding(),
        incident: Incident::zeroed(),
    }
}

fn seen(raw_price: i64, publish_time: i64) -> Observation {
    Observation {
        price: raw_price,
        conf: 0,
        publish_time,
    }
}

/// R5-01: RULES 9 blocks collateral withdrawals while "any perp" is not healthy.
/// A spot market runs the same health machine but holds no positions. If a spot
/// dislocation also freezes collateral withdrawals, one volatile spot feed moving
/// more than `max_move_bps` locks every trader's collateral until the feed heals.
#[test]
fn r5_01_a_dislocated_spot_market_and_collateral_withdrawals() {
    let mut w = World::new(10, 8);
    let perp = w.add_market(perp_params(0));
    let spot = w.add_market(spot_params(1));
    let seat = funded(&mut w, 100_000);

    w.now += 10;
    // The spot feed jumps 10%, beyond the 3% move limit: dislocation.
    let mut spot_feed = feed();
    w.sync(spot, &mut spot_feed, seen(11, w.now)).unwrap();
    assert_eq!(w.markets[spot].params.oracle_health, ORACLE_DISLOCATED);
    assert_eq!(w.markets[perp].params.oracle_health, ORACLE_HEALTHY);

    // A spot dislocation must not freeze collateral: the seat has no positions.
    w.withdraw(seat, Asset::Collateral, 1_000).unwrap();

    // Control: dislocating the perp instead does freeze collateral withdrawals.
    let mut perp_feed = feed();
    w.now += 10;
    w.sync(perp, &mut perp_feed, seen(1100, w.now)).unwrap();
    assert_eq!(w.markets[perp].params.oracle_health, ORACLE_DISLOCATED);
    let answer = w.withdraw(seat, Asset::Collateral, 1_000);
    assert_eq!(answer, Err(EngineError::OracleIncident));
}

/// R5-02: a seat below maintenance margin names itself as its own liquidator.
/// If the engine allows it, the target keeps its position (the takeover is a
/// no-op against itself) while the penalty and any deficit flow between the
/// seat, the insurance seat and the fee seat in ways RULES 8 never priced: the
/// insurance share of the penalty would come out of insurance for a transfer
/// that moved nothing, or a deficit would be paid to a seat that still holds
/// the position.
#[test]
fn r5_02_a_bankrupt_seat_liquidates_itself() {
    let (mut w, m) = perp_world(perp_params(0));
    let target = funded(&mut w, 2_100);
    let maker = funded(&mut w, 1_000_000);
    buy_from(&mut w, m, target, maker, 1_000, 20);

    w.set_price(m, 890);
    assert!(w.is_liquidatable(target, m));

    let insurance_before = w.collateral(INSURANCE_SEAT);
    let fee_seat_before = w.collateral(FEE_SEAT);
    let outcome = w.liquidate(m, target, target, 20);
    assert!(
        outcome.is_err(),
        "self-liquidation was not refused: {outcome:?}"
    );
    assert_eq!(w.collateral(INSURANCE_SEAT), insurance_before);
    assert_eq!(w.collateral(FEE_SEAT), fee_seat_before);
}

/// R5-03: while the USDC guard fails, RULES 9a restricts every perp to
/// reduce-only orders but says nothing about spot. If the guard also blocked
/// spot matching, a USDC depeg or a stale guard feed would halt the whole
/// exchange instead of just perp exposure.
#[test]
fn r5_03_a_tripped_guard_and_spot_trading() {
    let mut w = World::new(10, 8);
    let spot = w.add_market(spot_params(0));
    let perp = w.add_market(perp_params(1));
    let seller = w.open();
    w.deposit(seller, Asset::Spot(BASE), 1_000).unwrap();
    let buyer = w.open();
    w.deposit(buyer, Asset::Spot(QUOTE), 10_000).unwrap();
    let perp_trader = funded(&mut w, 100_000);

    w.quote_ok = false;

    // Perp control: an exposure-growing perp order is refused.
    let perp_answer = w.place(perp, perp_trader, ioc(Side::Bid, 1_000, 1));
    assert_eq!(perp_answer, Err(EngineError::QuoteGuardTripped));

    // Spot matching goes on.
    let outcome = w.place(spot, buyer, ioc(Side::Bid, 1_000, 1));
    assert_eq!(sizes(&outcome.unwrap()), (0, 0, 1));
    w.place(spot, seller, limit(Side::Ask, 1_000, 1)).unwrap();
    let outcome = w.place(spot, buyer, ioc(Side::Bid, 1_000, 1)).unwrap();
    assert_eq!(sizes(&outcome), (1, 0, 0));
    assert_eq!(w.spot(buyer, BASE).available, 100);
}

/// R5-04: settle timing against withdrawals. A settlement blocks collateral
/// withdrawals until `settle_window` has passed and a within-limit observation
/// has landed. The boundary decides how long everyone is frozen: one second
/// before the window ends a healing observation must leave the market settling,
/// and exactly at its end the same observation must reopen withdrawals.
#[test]
fn r5_04_withdrawals_reopen_exactly_at_the_settle_window() {
    let mut params = perp_params(0);
    params.settle_window = 100;
    let (mut w, m) = perp_world(params);
    let seat = funded(&mut w, 100_000);
    let mut oracle = feed();

    // Dislocate at +10% (move limit 3%), then confirm one gap later: settle.
    w.now += 10;
    w.sync(m, &mut oracle, seen(1_100, w.now)).unwrap();
    assert_eq!(w.markets[m].params.oracle_health, ORACLE_DISLOCATED);
    w.now += 1;
    w.sync(m, &mut oracle, seen(1_101, w.now)).unwrap();
    assert_eq!(w.markets[m].params.oracle_health, ORACLE_SETTLING);
    let settle_until = w.markets[m].incident.settle_until;
    assert_eq!(settle_until, w.now + 100);

    // During the window every collateral withdrawal is refused.
    let answer = w.withdraw(seat, Asset::Collateral, 1_000);
    assert_eq!(answer, Err(EngineError::OracleIncident));

    // One second before the window ends a healing observation leaves it settling.
    w.now = settle_until - 1;
    w.sync(m, &mut oracle, seen(1_100, w.now)).unwrap();
    assert_eq!(w.markets[m].params.oracle_health, ORACLE_SETTLING);
    let answer = w.withdraw(seat, Asset::Collateral, 1_000);
    assert_eq!(answer, Err(EngineError::OracleIncident));

    // Exactly at the window's end the same observation makes it healthy.
    w.now = settle_until;
    w.sync(m, &mut oracle, seen(1_100, w.now)).unwrap();
    assert_eq!(w.markets[m].params.oracle_health, ORACLE_HEALTHY);
    w.withdraw(seat, Asset::Collateral, 1_000).unwrap();
}

/// R5-05: RULES 9 says a target with a position on a dislocated market, asked
/// to be liquidated on another market, answers "nothing to liquidate", the same
/// as a seat with nothing to take. If the two answers differ, anyone learns
/// that a specific seat holds a position on the dislocated market from the
/// refusal alone.
#[test]
fn r5_05_a_dislocated_position_and_a_solvent_seat_answer_a_liquidation_the_same() {
    let mut w = World::new(10, 8);
    let a = w.add_market(perp_params(0));
    let b = w.add_market(perp_params(1));
    let target = funded(&mut w, 100_000);
    let maker = funded(&mut w, 1_000_000);
    let stranger = funded(&mut w, 100_000);
    let liquidator = funded(&mut w, 100_000);
    buy_from(&mut w, a, target, maker, 1_000, 10);

    w.now += 10;
    let mut oracle = feed();
    w.sync(a, &mut oracle, seen(1_100, w.now)).unwrap();
    assert_eq!(w.markets[a].params.oracle_health, ORACLE_DISLOCATED);

    let probe = w.liquidate(b, liquidator, target, 1);
    let control = w.liquidate(b, liquidator, stranger, 1);
    assert_eq!(
        probe.err(),
        control.err(),
        "the refusal says the target holds a position on the dislocated market"
    );
}

/// R5-06: the worst chain the new code allows. A bankrupt liquidation leaves an
/// uncovered shortfall on market A (blocking every collateral withdrawal), a
/// second perp then dislocates (a second, independent block), and the exchange
/// can only reopen if the recovery instructions keep working under an incident:
/// `cover_shortfall`, deposits and `reconcile_shortfall` are documented as
/// never blocked by the source. If any of them were blocked, or if a repaid
/// debt did not lift the freeze once the feed healed, one bad print would lock
/// the exchange forever.
#[test]
fn r5_06_a_shortfall_and_an_incident_still_let_the_exchange_recover() {
    let mut w = World::new(10, 8);
    let a = w.add_market(perp_params(0));
    let b = w.add_market(perp_params(1));
    let target = funded(&mut w, 2_100);
    let maker = funded(&mut w, 1_000_000);
    let liquidator = funded(&mut w, 100_000);
    let bystander = funded(&mut w, 50_000);

    // Bankrupt the target on A: long 20 at 1,000, mark to 400.
    buy_from(&mut w, a, target, maker, 1_000, 20);
    w.set_price(a, 400);
    let outcome = w.liquidate(a, liquidator, target, 20).unwrap();
    assert!(outcome.uncovered > 0, "setup: no shortfall was recorded");
    assert_eq!(w.collateral(INSURANCE_SEAT), 0);
    assert_eq!(w.collateral(FEE_SEAT), 0);
    let recorded = w.markets[a].params.uncovered_shortfall;
    assert_eq!(i64::try_from(recorded).unwrap(), -w.collateral(target));

    // The record alone blocks the bystander's collateral withdrawal.
    let answer = w.withdraw(bystander, Asset::Collateral, 1_000);
    assert_eq!(answer, Err(EngineError::ShortfallOutstanding));

    // Trade on B so the fee seat holds something again, then dislocate B.
    let trader = funded(&mut w, 100_000);
    let maker_b = funded(&mut w, 1_000_000);
    buy_from(&mut w, b, trader, maker_b, 1_000, 10);
    assert!(w.collateral(FEE_SEAT) > 0);
    let fee_balance = w.collateral(FEE_SEAT);
    w.now += 10;
    let mut oracle = feed();
    w.sync(b, &mut oracle, seen(1_100, w.now)).unwrap();
    assert_eq!(w.markets[b].params.oracle_health, ORACLE_DISLOCATED);

    // Under the incident, cover_shortfall still pays what the fee seat holds.
    let paid = w.cover_shortfall(a, target).unwrap();
    assert_eq!(paid, u64::try_from(fee_balance).unwrap());
    assert_eq!(w.markets[a].params.uncovered_shortfall, recorded - paid);

    // The debtor repays by deposit (never blocked), reconcile lifts the record.
    let debt = -w.collateral(target);
    w.deposit(target, Asset::Collateral, u64::try_from(debt).unwrap())
        .unwrap();
    assert_eq!(w.collateral(target), 0);
    let removed = w.reconcile();
    assert_eq!(removed, recorded - paid);
    assert_eq!(w.markets[a].params.uncovered_shortfall, 0);

    // The incident alone still blocks the withdrawal until the feed heals.
    let answer = w.withdraw(bystander, Asset::Collateral, 1_000);
    assert_eq!(answer, Err(EngineError::OracleIncident));
    w.now += 1;
    w.sync(b, &mut oracle, seen(1_000, w.now)).unwrap();
    assert_eq!(w.markets[b].params.oracle_health, ORACLE_HEALTHY);
    w.withdraw(bystander, Asset::Collateral, 1_000).unwrap();
}

/// R5-07: make funding pay out across an incident. The discard rule clears the
/// interval an incident touched, but the window between the heal and the first
/// later `update_funding` is a healthy market that still records premium. If
/// that sliver's premium survived the discard, an attacker could trade right
/// after every heal and collect funding for an interval the incident covered.
#[test]
fn r5_07_premium_recorded_after_a_heal_still_dies_with_the_interval() {
    let mut params = perp_params(0);
    params.funding_interval = 60;
    let (mut w, m) = perp_world(params);
    let buyer = funded(&mut w, 1_000_000);
    let seller = funded(&mut w, 1_000_000);
    let mut oracle = feed();

    // Premium before the incident: fills at 1,010 against a 1,000 mark.
    buy_from(&mut w, m, buyer, seller, 1_010, 10);

    // Dislocate at +10%, heal one gap later back at the mark.
    w.now += 10;
    w.sync(m, &mut oracle, seen(1_100, w.now)).unwrap();
    assert_eq!(w.markets[m].params.oracle_health, ORACLE_DISLOCATED);
    w.now += 1;
    w.sync(m, &mut oracle, seen(1_000, w.now)).unwrap();
    assert_eq!(w.markets[m].params.oracle_health, ORACLE_HEALTHY);

    // The healthy sliver: more premium, recorded while healthy and fresh.
    buy_from(&mut w, m, buyer, seller, 1_010, 10);

    // The first update after the interval must discard, not pay.
    w.now = START + 61;
    let index_before = w.funding_units(m);
    assert!(w.fund(m).unwrap());
    assert_eq!(
        w.funding_units(m),
        index_before,
        "funding paid out across a price incident"
    );

    // Control: a clean interval afterwards pays normally.
    buy_from(&mut w, m, buyer, seller, 1_010, 10);
    w.now = START + 121;
    w.sync(m, &mut oracle, seen(1_000, w.now)).unwrap();
    assert!(w.fund(m).unwrap());
    assert_ne!(w.funding_units(m), index_before);
}

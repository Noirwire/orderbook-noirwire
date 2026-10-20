//! Audit against a census of hacks on perpetuals venues: the gaps its coverage map
//! found in this engine's tests. Each test is named after the gap it closes, or, for
//! `p1`, the accepted limit it pins.

mod common;

use bytemuck::Zeroable;
use common::*;
use noirwire_orderbook_engine::EngineError as E;
use noirwire_orderbook_engine::*;

/// The caller's per-market data with one market left out, as the program would hand
/// it over if a trader could omit that market's accounts.
fn risks_without(w: &World, market: usize) -> Vec<MarketRisk> {
    let mut risks = w.risks();
    risks[market] = MarketRisk::NONE;
    risks
}

fn env_of<'a>(w: &World, risks: &'a [MarketRisk]) -> Env<'a> {
    Env {
        now: w.now,
        exchange_paused: w.paused,
        quote_ok: w.quote_ok,
        max_steps: w.max_steps,
        markets: risks,
        hash: sha,
    }
}

/// Two perp markets. `holder` is long on market 1 and holds a spot balance, `other`
/// is long on market 0, and `maker` is short on both.
struct TwoMarkets {
    w: World,
    first: usize,
    second: usize,
    holder: u32,
    other: u32,
}

fn two_markets() -> TwoMarkets {
    let mut w = World::new(10, 8);
    let first = w.add_market(perp_params(0));
    let second = w.add_market(perp_params(1));
    let maker = funded(&mut w, 1_000_000);
    let holder = funded(&mut w, 100_000);
    let other = funded(&mut w, 100_000);
    w.deposit(holder, Asset::Spot(QUOTE), 1_000).unwrap();
    buy_from(&mut w, second, holder, maker, MARK, 10);
    buy_from(&mut w, first, other, maker, MARK, 10);
    assert_eq!(w.slot(holder, second).base, 10);
    assert_eq!(w.slot(other, first).base, 10);
    TwoMarkets {
        w,
        first,
        second,
        holder,
        other,
    }
}

#[test]
fn g1_a_position_on_a_market_the_caller_left_out_refuses_every_decision_that_values_it() {
    let TwoMarkets {
        mut w,
        first,
        second,
        holder,
        other,
    } = two_markets();
    let before = w.bytes();
    let risks = risks_without(&w, second);
    let env = env_of(&w, &risks);
    let key = w.key(holder);
    let trader = Trader {
        seat: holder,
        owner: &key,
    };

    for asset in [Asset::Collateral, Asset::Spot(QUOTE)] {
        let mut seats = ledger(&mut w.header, &mut w.seats);
        assert_eq!(
            withdraw(&mut seats, &env, trader, asset, 1),
            Err(E::MarketDataMissing),
            "a withdrawal, or the debited side of a transfer between balances, of {asset:?}"
        );
    }
    {
        let mut seats = ledger(&mut w.header, &mut w.seats);
        let mut market = w.markets[first].as_mut();
        let mut journal = Journal::new(&mut w.journal);
        let placed = place_order(
            &mut seats,
            &mut market,
            &mut journal,
            &env,
            trader,
            &limit(Side::Bid, MARK, 1),
            &mut w.fills,
        );
        assert_eq!(placed.map(|_| ()), Err(E::MarketDataMissing));
    }
    {
        let mut seats = ledger(&mut w.header, &mut w.seats);
        let mut market = w.markets[first].as_mut();
        let mut journal = Journal::new(&mut w.journal);
        let request = LiquidationRequest {
            target: other,
            size: 10,
            worst_price: u64::MAX,
        };
        let liquidated = liquidate(
            &mut seats,
            &mut market,
            &mut journal,
            &env,
            trader,
            &request,
        );
        assert_eq!(
            liquidated.map(|outcome| outcome.status),
            Ok(LiquidationStatus::StalePrice),
            "RULES 8: the liquidator's own position is on the market left out, which is \
             decided before the target is looked at"
        );
    }
    assert!(before == w.bytes(), "a refused call changed state");

    assert_eq!(w.withdraw(holder, Asset::Collateral, 1), Ok(()));
    assert_eq!(w.withdraw(holder, Asset::Spot(QUOTE), 1), Ok(()));
}

#[test]
fn g1_a_target_valued_on_a_market_left_out_is_nothing_to_liquidate_and_never_an_error() {
    let TwoMarkets {
        mut w,
        first,
        second,
        holder,
        ..
    } = two_markets();
    let keeper = funded(&mut w, 1_000_000);
    let before = w.bytes();
    let risks = risks_without(&w, second);
    let env = env_of(&w, &risks);
    let key = w.key(keeper);
    let request = LiquidationRequest {
        target: holder,
        size: 10,
        worst_price: u64::MAX,
    };
    let mut seats = ledger(&mut w.header, &mut w.seats);
    let mut market = w.markets[first].as_mut();
    let mut journal = Journal::new(&mut w.journal);
    let liquidated = liquidate(
        &mut seats,
        &mut market,
        &mut journal,
        &env,
        Trader {
            seat: keeper,
            owner: &key,
        },
        &request,
    );

    assert_eq!(
        liquidated.map(|outcome| outcome.status),
        Ok(LiquidationStatus::NotLiquidatable),
        "RULES 8: an error here would say that the target holds a position on the \
         market left out; the program refuses a call missing any perp market before \
         the engine runs (`RiskTable::require_all`)"
    );
    assert!(before == w.bytes());
}

/// `seat` buys `size` lots at the mark from `maker`, with `collateral` behind it.
fn long_at_mark(w: &mut World, m: usize, maker: u32, collateral: u64, size: u64) -> u32 {
    let seat = funded(w, collateral);
    buy_from(w, m, seat, maker, MARK, size);
    seat
}

#[test]
fn g3_insurance_pays_two_bankrupt_seats_down_to_zero_and_a_second_cover_pays_nothing() {
    let (mut w, m) = perp_world(free_perp());
    w.deposit(INSURANCE_SEAT, Asset::Collateral, 1_000).unwrap();
    let maker = funded(&mut w, 10_000_000);
    let keeper = funded(&mut w, 10_000_000);
    let first = long_at_mark(&mut w, m, maker, 11_300, 100);
    let second = long_at_mark(&mut w, m, maker, 5_400, 50);
    w.set_price(m, 880);
    assert_eq!(w.equity(first), -700);
    assert_eq!(w.equity(second), -600);

    let paid = w.liquidate(m, keeper, first, 100).unwrap();
    assert_eq!((paid.insurance_paid, paid.uncovered), (700, 0));
    let paid = w.liquidate(m, keeper, second, 50).unwrap();
    assert_eq!((paid.insurance_paid, paid.uncovered), (300, 300));
    assert_eq!(w.collateral(INSURANCE_SEAT), 0);
    assert_eq!(w.markets[m].params.uncovered_shortfall, 300);

    for seat in [first, first, second, second] {
        assert_eq!(w.cover_shortfall(m, seat), Ok(0));
        assert_eq!(w.collateral(INSURANCE_SEAT), 0);
    }
    w.deposit(INSURANCE_SEAT, Asset::Collateral, 100).unwrap();
    assert_eq!(w.cover_shortfall(m, second), Ok(100));
    assert_eq!(w.cover_shortfall(m, second), Ok(0));
    assert_eq!(w.collateral(INSURANCE_SEAT), 0);
    assert_eq!(w.collateral(second), -200);
    assert_eq!(w.markets[m].params.uncovered_shortfall, 200);
}

#[test]
fn g4_a_market_opens_on_no_price_the_oracle_alone_can_set() {
    let mut w = World::new(10, 8);
    let m = w.add_market(deployed_perp(0));
    w.markets[m].price = Price {
        price: 0,
        publish_time: 0,
        accepted_at: 0,
    };
    w.deposit(INSURANCE_SEAT, Asset::Collateral, 1_000_000)
        .unwrap();
    let seller = funded(&mut w, 100_000_000);
    let buyer = funded(&mut w, 100_000_000);
    let slipped = DEPLOYED_MARK * 1_000;

    assert_eq!(w.publish(m, slipped, w.now), Err(E::FeedNotSeeded));
    assert_eq!(
        w.place(m, seller, limit(Side::Ask, slipped, 1)),
        Err(E::PriceUnavailable),
        "a market whose feed never had a price accepts no order"
    );

    assert_eq!(w.reset(m, slipped, w.now), Ok(()));
    assert_eq!(w.markets[m].params.status, STATUS_REDUCE_ONLY);
    for (seat, side) in [(seller, Side::Ask), (buyer, Side::Bid)] {
        assert_eq!(
            w.place(m, seat, limit(side, slipped, 100)),
            Err(E::MarketReduceOnly),
            "even the admin's first price opens nothing"
        );
    }

    w.now += 1;
    assert_eq!(w.reset(m, DEPLOYED_MARK, w.now), Ok(()));
    assert_eq!(w.resume(m), Ok(()));
    w.now += 1;
    let within_one_step = 153_700;
    assert_eq!(w.publish(m, 153_800, w.now), Err(E::PriceMoveTooLarge));
    assert_eq!(w.publish(m, within_one_step, w.now), Ok(()));
    w.place(m, seller, limit(Side::Ask, within_one_step, 100))
        .unwrap();
    let bought = w
        .place(m, buyer, ioc(Side::Bid, within_one_step, 100))
        .unwrap();
    assert_eq!(sizes(&bought).0, 100);
    assert!(
        w.collateral(INSURANCE_SEAT) >= 1_000_000,
        "insurance paid nothing"
    );
}

/// The SOL/USD binding NSOL-PERP is created with: Pyth's exponent, 9 base and 6 quote
/// decimals, so $150 is `DEPLOYED_MARK` under `deployed_perp`.
fn sol_source() -> PriceFeed {
    let mut feed = PriceFeed::zeroed();
    feed.binding = SourceBinding {
        expo: -8,
        max_conf_bps: 100,
        base_decimals: 9,
        quote_decimals: 6,
        ..SourceBinding::zeroed()
    };
    feed
}

/// `dollars` of SOL as Pyth publishes it, stamped `publish_time`.
fn sol_at(dollars: i64, publish_time: i64) -> Observation {
    Observation {
        price: dollars * 100_000_000,
        conf: 0,
        publish_time,
    }
}

#[test]
fn g4_a_first_observation_from_the_price_source_opens_nothing_until_resume_market() {
    let mut w = World::new(10, 8);
    let mut params = deployed_perp(0);
    params.settle_window = 900;
    let m = w.add_market(params);
    w.markets[m].price = Price::zeroed();
    let seller = funded(&mut w, 100_000_000);
    let buyer = funded(&mut w, 100_000_000);
    let mut feed = sol_source();
    let slipped = DEPLOYED_MARK * 1_000;

    assert_eq!(w.sync(m, &mut feed, sol_at(150_000, w.now)), Ok(()));
    assert_eq!(w.markets[m].price.price, slipped);
    assert_eq!(w.markets[m].params.oracle_health, ORACLE_HEALTHY);
    assert_eq!(w.markets[m].params.status, STATUS_REDUCE_ONLY);
    for (seat, side) in [(seller, Side::Ask), (buyer, Side::Bid)] {
        assert_eq!(
            w.place(m, seat, limit(side, slipped, 1)),
            Err(E::MarketReduceOnly),
            "a first observation, bounded by nothing, opens nothing"
        );
    }

    w.markets[m].params.status = STATUS_PAUSED;
    w.markets[m].price = Price::zeroed();
    feed = sol_source();
    w.now += 1;
    assert_eq!(w.sync(m, &mut feed, sol_at(150, w.now)), Ok(()));
    assert_eq!(
        w.markets[m].params.status, STATUS_PAUSED,
        "a rebound market stays paused"
    );

    assert_eq!(w.resume(m), Ok(()));
    w.place(m, seller, limit(Side::Ask, DEPLOYED_MARK, 100))
        .unwrap();
    let bought = w
        .place(m, buyer, ioc(Side::Bid, DEPLOYED_MARK, 100))
        .unwrap();
    assert_eq!(sizes(&bought).0, 100);
}

/// Two perp markets with one bankrupt debtor each and no insurance: `on_first` owes
/// 100, recorded on the first market, and `on_second` owes 50, recorded on the second.
struct TwoDebts {
    w: World,
    first: usize,
    second: usize,
    on_first: u32,
    on_second: u32,
}

fn two_debts() -> TwoDebts {
    let mut w = World::new(10, 8);
    let first = w.add_market(free_perp());
    let mut second_params = free_perp();
    second_params.market_id = 1;
    let second = w.add_market(second_params);
    let maker = funded(&mut w, 10_000_000);
    let keeper = funded(&mut w, 10_000_000);
    let on_first = long_at_mark(&mut w, first, maker, 1_000, 10);
    let on_second = long_at_mark(&mut w, second, maker, 500, 5);
    w.set_price(first, 890);
    w.set_price(second, 890);
    for (market, debtor, owed) in [(first, on_first, 100), (second, on_second, 50)] {
        let outcome = w.liquidate(market, keeper, debtor, u64::MAX).unwrap();
        assert_eq!((outcome.insurance_paid, outcome.uncovered), (0, owed));
        assert_eq!(w.collateral(debtor), -(owed as i64));
    }
    TwoDebts {
        w,
        first,
        second,
        on_first,
        on_second,
    }
}

fn records(w: &World) -> (u64, u64) {
    let recorded = |market: usize| w.markets[market].params.uncovered_shortfall;
    (recorded(0), recorded(1))
}

/// Both debtors repay by deposit and anyone reconciles; then every market resumes.
fn repaid_and_resumed(mut w: World, debtors: [u32; 2], first: usize, second: usize) {
    for debtor in debtors {
        let owed = w.collateral(debtor).unsigned_abs();
        if owed > 0 {
            w.deposit(debtor, Asset::Collateral, owed).unwrap();
        }
    }
    w.reconcile();
    assert_eq!(records(&w), (0, 0));
    for market in [first, second] {
        assert_eq!(w.resume(market), Ok(()));
        assert_eq!(w.markets[market].params.status, STATUS_ACTIVE);
    }
}

#[test]
fn g6_a_cover_named_on_another_market_cannot_reopen_a_market_whose_debtor_still_owes() {
    let TwoDebts {
        mut w,
        first,
        second,
        on_first,
        on_second,
    } = two_debts();
    w.deposit(INSURANCE_SEAT, Asset::Collateral, 50).unwrap();

    assert_eq!(w.cover_shortfall(second, on_first), Ok(50));
    assert_eq!(records(&w), (100, 0));
    assert_eq!(
        w.collateral(on_second),
        -50,
        "the second market's debtor still owes"
    );
    assert_eq!(w.reconcile(), 0);
    for market in [first, second] {
        assert_eq!(w.resume(market), Err(E::ShortfallOutstanding));
    }

    repaid_and_resumed(w, [on_first, on_second], first, second);
}

#[test]
fn g6_a_market_whose_debtor_was_covered_elsewhere_resumes_once_every_record_is_gone() {
    let TwoDebts {
        mut w,
        first,
        second,
        on_first,
        on_second,
    } = two_debts();
    w.deposit(INSURANCE_SEAT, Asset::Collateral, 50).unwrap();

    assert_eq!(w.cover_shortfall(first, on_second), Ok(50));
    assert_eq!(records(&w), (50, 50));
    assert_eq!(w.collateral(on_second), 0);
    assert_eq!(w.reconcile(), 0);
    for market in [first, second] {
        assert_eq!(
            w.resume(market),
            Err(E::ShortfallOutstanding),
            "the first market's debtor still owes 100"
        );
    }

    repaid_and_resumed(w, [on_first, on_second], first, second);
}

#[test]
fn g6_resume_market_needs_no_shortfall_anywhere_and_its_own_source_healthy() {
    let TwoDebts {
        mut w,
        first,
        second,
        on_first,
        on_second,
    } = two_debts();
    w.markets[first].params.oracle_health = ORACLE_SETTLING;
    assert_eq!(
        w.resume(second),
        Err(E::ShortfallOutstanding),
        "healthy, but a shortfall is recorded"
    );

    for debtor in [on_first, on_second] {
        let owed = w.collateral(debtor).unsigned_abs();
        w.deposit(debtor, Asset::Collateral, owed).unwrap();
    }
    w.reconcile();
    assert_eq!(records(&w), (0, 0));
    assert_eq!(
        w.resume(first),
        Err(E::OracleIncident),
        "no shortfall, but its source is settling"
    );
    assert_eq!(w.resume(second), Ok(()));

    w.markets[first].params.oracle_health = ORACLE_HEALTHY;
    assert_eq!(w.resume(first), Ok(()));
    assert_eq!(w.markets[first].params.status, STATUS_ACTIVE);
}

/// The pump and exit of an accepted limit (SECURITY, bad-debt bounds): a winner and a
/// loser hold the whole open interest cap against each other, the mark walks up
/// within the move limit with nobody liquidating, the winner closes against an
/// honest maker and withdraws its realised profit, and only then is the bankrupt
/// loser liquidated.
struct Exit {
    w: World,
    m: usize,
    loser: u32,
    keeper: u32,
    maker: u32,
    withdrawn: u64,
}

const CAP: u64 = 1_000;

fn pumped_and_exited(insurance: u64) -> Exit {
    let mut w = World::new(10, 8);
    let mut params = deployed_perp(0);
    params.open_interest_cap = CAP;
    let m = w.add_market(params);
    w.set_price(m, DEPLOYED_MARK);
    if insurance > 0 {
        w.deposit(INSURANCE_SEAT, Asset::Collateral, insurance)
            .unwrap();
    }
    let maker = funded(&mut w, 100_000_000);
    let keeper = funded(&mut w, 100_000_000);
    let winner = funded(&mut w, 15_100_000);
    let loser = funded(&mut w, 15_100_000);
    buy_from(&mut w, m, winner, loser, DEPLOYED_MARK, CAP);
    assert_eq!(w.markets[m].book.open_interest, CAP);

    let mut mark = DEPLOYED_MARK;
    while w.equity(loser) >= 0 {
        let step = mark * u64::from(params.max_move_bps) / 10_000;
        mark += step / params.tick * params.tick;
        w.now += 1;
        w.publish(m, mark, w.now).unwrap();
    }

    w.place(m, maker, limit(Side::Bid, mark, CAP)).unwrap();
    let closed = w.place(m, winner, ioc(Side::Ask, mark, CAP)).unwrap();
    assert_eq!(sizes(&closed).0, CAP);
    let withdrawn = u64::try_from(w.collateral(winner)).unwrap();
    assert!(withdrawn > 15_100_000, "the winner holds realised profit");
    w.withdraw(winner, Asset::Collateral, withdrawn).unwrap();
    Exit {
        w,
        m,
        loser,
        keeper,
        maker,
        withdrawn,
    }
}

#[test]
fn p1_after_a_pump_and_exit_insurance_pays_the_losers_deficit_at_the_mark_and_no_more() {
    let Exit {
        mut w,
        m,
        loser,
        keeper,
        withdrawn,
        ..
    } = pumped_and_exited(10_000_000);
    let deficit = -w.equity(loser);
    let insurance = w.collateral(INSURANCE_SEAT);
    let outcome = w.liquidate(m, keeper, loser, CAP).unwrap();

    assert_eq!(outcome.price, w.markets[m].price.price, "taken at the mark");
    assert_eq!(i128::from(outcome.insurance_paid), deficit);
    assert_eq!(outcome.uncovered, 0);
    let paid = insurance - w.collateral(INSURANCE_SEAT);
    assert_eq!(i128::from(paid), deficit);
    assert!(i128::from(withdrawn) > deficit);
}

#[test]
fn p1_when_insurance_falls_short_the_rest_is_recorded_and_every_collateral_withdrawal_stops() {
    let Exit {
        mut w,
        m,
        loser,
        keeper,
        maker,
        ..
    } = pumped_and_exited(0);
    let deficit = -w.equity(loser);
    let insurance = i128::from(w.collateral(INSURANCE_SEAT));
    assert!(
        insurance < deficit,
        "insurance holds only its share of fees"
    );
    let outcome = w.liquidate(m, keeper, loser, CAP).unwrap();

    assert_eq!(i128::from(outcome.insurance_paid), insurance);
    assert_eq!(i128::from(outcome.uncovered), deficit - insurance);
    assert_eq!(
        i128::from(w.markets[m].params.uncovered_shortfall),
        deficit - insurance
    );
    for seat in [maker, keeper] {
        assert_eq!(
            w.withdraw(seat, Asset::Collateral, 1),
            Err(E::ShortfallOutstanding)
        );
    }
}

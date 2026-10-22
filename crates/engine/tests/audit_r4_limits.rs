//! Audit round 4, limits lens: a deposit's answer must not depend on the seat it names,
//! the open interest sizing rule's floor on a waiting position's equity, and the fee
//! seat's draws.

mod common;

use common::*;
use noirwire_orderbook_engine::EngineError as E;
use noirwire_orderbook_engine::*;

/// What the program's `deposit_tokens` answers, step by step in its order. The tokens
/// move first, so a depositor holding less than `amount` is refused by the token
/// program; then custody is checked against the token's cap, which `set_custody_cap`
/// keeps at or below `BALANCE_CAP`; only then is the seat credited. The credit runs on
/// a copy of the ledger, so asking changes nothing.
#[derive(Debug, PartialEq, Eq)]
enum Answer {
    TokenProgramRefused,
    CustodyCapReached,
    Credited(EngineResult<()>),
}

struct Depositor {
    holds: u64,
    cap: u64,
}

fn custody_of(w: &World, asset: Asset) -> u128 {
    match asset {
        Asset::Collateral => u128::try_from(w.custody_collateral).unwrap(),
        Asset::Spot(token) => w.custody_spot[usize::from(token)],
    }
}

fn deposit_answer(
    w: &World,
    depositor: &Depositor,
    seat: u32,
    asset: Asset,
    amount: u64,
) -> Answer {
    assert!(depositor.cap <= BALANCE_CAP, "set_custody_cap refuses more");
    if amount > depositor.holds {
        return Answer::TokenProgramRefused;
    }
    if custody_of(w, asset) + u128::from(amount) > u128::from(depositor.cap) {
        return Answer::CustodyCapReached;
    }
    let mut header = w.header;
    let mut seats = w.seats.clone();
    let mut copy = ledger(&mut header, &mut seats);
    Answer::Credited(deposit(&mut copy, seat, asset, amount))
}

/// Every amount the round 4 probe used, around the seat's holding and the balance limit.
fn probes(held: u64) -> Vec<u64> {
    let mut amounts = vec![1, held, BALANCE_CAP, BALANCE_CAP + 1, u64::MAX];
    for x in [
        0,
        1,
        held.saturating_sub(1),
        held,
        held + 1,
        BALANCE_CAP / 2,
    ] {
        amounts.push(BALANCE_CAP - x);
    }
    amounts
}

const STRANGER: Depositor = Depositor {
    holds: 1,
    cap: BALANCE_CAP,
};

/// The stranger's answers for `seat`, one per probe amount.
fn answers(w: &World, seat: u32, asset: Asset, amounts: &[u64]) -> Vec<Answer> {
    amounts
        .iter()
        .map(|&amount| deposit_answer(w, &STRANGER, seat, asset, amount))
        .collect()
}

#[test]
fn r4_a_stranger_holding_one_atom_learns_nothing_from_deposits_into_any_seat() {
    let (mut w, m) = perp_world(perp_params(0));
    let victim = funded(&mut w, 123_456_789);
    let counter = funded(&mut w, 10_000_000);
    let empty = w.open();
    buy_from(&mut w, m, victim, counter, 1_000, 37);
    let held = u64::try_from(w.collateral(victim)).unwrap();
    let before = w.seats.clone();
    let amounts = probes(held);

    let victims = answers(&w, victim, Asset::Collateral, &amounts);

    assert_eq!(victims, answers(&w, empty, Asset::Collateral, &amounts));
    assert_eq!(victims, answers(&w, counter, Asset::Collateral, &amounts));
    for (amount, answer) in amounts.iter().zip(&victims) {
        let expected = if *amount <= STRANGER.holds {
            Answer::Credited(Ok(()))
        } else {
            Answer::TokenProgramRefused
        };
        assert_eq!(*answer, expected, "amount {amount}");
    }
    assert_eq!(w.seats, before, "no probe changed the ledger");
}

#[test]
fn r4_a_spot_holding_and_what_its_resting_orders_lock_answer_the_same_as_an_empty_seat() {
    let mut w = World::new(10, 8);
    let m = w.add_market(spot_params(0));
    let victim = w.open();
    let empty = w.open();
    w.deposit(victim, Asset::Spot(QUOTE), 987_654).unwrap();
    w.place(m, victim, limit(Side::Bid, 1_000, 3)).unwrap();
    assert!(
        w.spot(victim, QUOTE).locked > 0,
        "a resting bid locks quote"
    );
    let amounts = probes(987_654);

    assert_eq!(
        answers(&w, victim, Asset::Spot(QUOTE), &amounts),
        answers(&w, empty, Asset::Spot(QUOTE), &amounts)
    );
}

#[test]
fn r4_a_debtor_answers_the_same_as_a_seat_that_owes_nothing() {
    let (mut w, m) = perp_world(free_perp());
    let maker = funded(&mut w, 1_000_000);
    let liquidator = funded(&mut w, 10_000_000);
    let target = funded(&mut w, 1_100);
    buy_from(&mut w, m, target, maker, 1_000, 10);
    w.set_price(m, 850);
    let outcome = w.liquidate(m, liquidator, target, 10).unwrap();
    assert!(outcome.uncovered > 0);
    let owed = w.collateral(target).unsigned_abs();
    let amounts = [BALANCE_CAP + owed, BALANCE_CAP + owed + 1, u64::MAX];

    assert_eq!(
        answers(&w, target, Asset::Collateral, &amounts),
        answers(&w, maker, Asset::Collateral, &amounts)
    );
}

/// The other half: a depositor who holds the amount and stays within the cap is never
/// refused by the seat's own balance limit, whatever the seat holds, since the cap is at
/// most `BALANCE_CAP` and a holding is at most what custody holds.
#[test]
fn r4_a_deposit_within_the_cap_is_never_refused_by_a_seats_balance_limit() {
    let (mut w, m) = perp_world(perp_params(0));
    let s = w.add_market(spot_params(1));
    let rich = funded(&mut w, 1 << 40);
    let counter = funded(&mut w, 1 << 40);
    buy_from(&mut w, m, rich, counter, 1_000, 37);
    w.deposit(rich, Asset::Spot(QUOTE), 1 << 40).unwrap();
    w.deposit(rich, Asset::Spot(BASE), 1 << 40).unwrap();
    w.place(s, rich, limit(Side::Bid, 1_000, 3)).unwrap();
    let whale = Depositor {
        holds: u64::MAX,
        cap: BALANCE_CAP,
    };

    for asset in [Asset::Collateral, Asset::Spot(QUOTE), Asset::Spot(BASE)] {
        let room = u64::try_from(u128::from(BALANCE_CAP) - custody_of(&w, asset)).unwrap();
        for seat in [rich, counter] {
            let answer = deposit_answer(&w, &whale, seat, asset, room);
            assert_eq!(answer, Answer::Credited(Ok(())), "{asset:?} seat {seat}");
            let over = deposit_answer(&w, &whale, seat, asset, room + 1);
            assert_eq!(over, Answer::CustodyCapReached, "{asset:?} seat {seat}");
        }
    }
}

/// RULES 12 sizing of `open_interest_cap`: it rests on one update leaving a seat that
/// was at maintenance with at least the penalty, so a gap `g` costs insurance at most
/// `notional * (g - penalty)` at the mark the gap starts from. The settings that let a
/// waiting long keep about 1% where 4% was assumed (move 399 at maintenance 500 and
/// penalty 100) are now refused; at the widest move the rules accept, the bound holds
/// on both sides.
#[test]
fn r4_a_gap_on_a_waiting_position_costs_at_most_the_gap_less_the_penalty() {
    let refused = MarketParams {
        max_move_bps: 399,
        ..free_perp()
    };
    assert_eq!(refused.check(), Err(E::InvalidMarketParams));
    let params = MarketParams {
        max_move_bps: 396,
        ..free_perp()
    };
    assert_eq!((params.mm_bps, params.liq_penalty_bps), (500, 100));
    assert!(params.check().is_ok(), "the widest move the rules accept");

    for (side, at_maintenance, waiting, gapped) in [
        (Side::Bid, 94_740u64, 90_989u64, 72_792u64),
        (Side::Ask, 104_760, 108_908, 130_689),
    ] {
        let (mut w, m) = perp_world(params);
        let maker = funded(&mut w, 100_000_000);
        let liquidator = funded(&mut w, 100_000_000);
        let target = funded(&mut w, 1_000_000);
        w.set_price(m, 100_000);
        match side {
            Side::Bid => buy_from(&mut w, m, target, maker, 100_000, 100),
            Side::Ask => buy_from(&mut w, m, maker, target, 100_000, 100),
        }

        w.set_price(m, at_maintenance);
        assert!(!w.is_liquidatable(target, m), "just above maintenance");
        let moved = u128::from(at_maintenance.abs_diff(waiting)) * 10_000;
        assert!(moved <= u128::from(at_maintenance) * 396, "one update");
        w.set_price(m, waiting);
        assert!(w.is_liquidatable(target, m), "waiting to be liquidated");
        let notional = 100 * u128::from(waiting);
        let penalty = 100 * u128::from(waiting * 100).div_ceil(10_000);
        let equity = u128::try_from(w.equity(target)).unwrap();
        assert!(
            equity >= penalty,
            "{side:?}: equity {equity} keeps the penalty {penalty}"
        );

        let gap = u128::from(waiting.abs_diff(gapped)) * 10_000;
        assert!(gap <= u128::from(waiting) * 2_000, "a gap of at most 20%");
        w.set_price(m, gapped);
        let outcome = w.liquidate(m, liquidator, target, 100).unwrap();
        assert_eq!(outcome.status, LiquidationStatus::Liquidated);
        let deficit =
            u128::from(outcome.insurance_paid + outcome.fee_seat_paid + outcome.uncovered);
        let bound = notional * (2_000 - 100) / 10_000;
        assert!(
            deficit <= bound,
            "{side:?}: deficit {deficit} within g - penalty {bound}"
        );
    }
}

#[test]
fn r4_a_deficit_insurance_covers_leaves_the_fee_seat_untouched_and_nothing_pays_twice() {
    let (mut w, m) = perp_world(perp_params(0));
    let (a, b) = (funded(&mut w, 1_000_000), funded(&mut w, 1_000_000));
    buy_from(&mut w, m, a, b, MARK, 1_000);
    buy_from(&mut w, m, b, a, MARK, 1_000);
    let fees = w.collateral(FEE_SEAT);
    assert!(fees > 0);
    w.deposit(INSURANCE_SEAT, Asset::Collateral, 10_000)
        .unwrap();
    let maker = funded(&mut w, 100_000);
    let liquidator = funded(&mut w, 100_000);
    let target = funded(&mut w, 1_100);
    buy_from(&mut w, m, target, maker, 1_000, 10);
    let fees = w.collateral(FEE_SEAT);
    w.set_price(m, 850);

    let outcome = w.liquidate(m, liquidator, target, 10).unwrap();

    assert_eq!(outcome.fee_seat_paid, 0);
    assert_eq!(outcome.uncovered, 0);
    assert!(outcome.insurance_paid > 0);
    assert_eq!(w.collateral(FEE_SEAT), fees);
    assert_eq!(w.collateral(target), 0);
    assert_eq!(w.cover_shortfall(m, target), Ok(0));
    assert_eq!(w.cover_shortfall(m, FEE_SEAT), Ok(0));
    assert_eq!(w.cover_shortfall(m, INSURANCE_SEAT), Ok(0));
    assert!(w.collateral(INSURANCE_SEAT) >= 0);
}

#[test]
fn r4_a_liquidator_at_the_position_cap_still_takes_over_and_then_only_shrinks() {
    let (mut w, m) = perp_world(MarketParams {
        position_cap: 10,
        ..perp_params(0)
    });
    let makers = [funded(&mut w, 1_000_000), funded(&mut w, 1_000_000)];
    let liquidator = funded(&mut w, 10_000_000);
    let target = funded(&mut w, 1_100);
    buy_from(&mut w, m, liquidator, makers[0], 1_000, 10);
    buy_from(&mut w, m, target, makers[1], 1_000, 10);
    w.set_price(m, 900);

    let outcome = w.liquidate(m, liquidator, target, 10).unwrap();

    assert_eq!(outcome.status, LiquidationStatus::Liquidated);
    assert!(w.slot(liquidator, m).base > 10);
    assert_eq!(
        w.place(m, liquidator, ioc(Side::Bid, 900, 1)),
        Err(E::PositionCapExceeded)
    );
}

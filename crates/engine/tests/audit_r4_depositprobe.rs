//! Audit round 4: a deposit's answer must not depend on the seat it names. The engine
//! alone refuses a credit past `BALANCE_CAP` (a seat's own limit); the program's
//! `deposit_tokens` therefore moves the tokens and checks custody against the token's
//! cap, which is at most `BALANCE_CAP`, before it credits the seat. `program_answer`
//! follows that order.

mod common;

use common::*;
use noirwire_orderbook_engine::EngineError as E;
use noirwire_orderbook_engine::*;

#[derive(Debug, PartialEq, Eq)]
enum Answer {
    TokenProgramRefused,
    CustodyCapReached,
    Credited(EngineResult<()>),
}

fn engine_answer(w: &World, seat: u32, asset: Asset, amount: u64) -> EngineResult<()> {
    let mut header = w.header;
    let mut seats = w.seats.clone();
    let mut copy = ledger(&mut header, &mut seats);
    deposit(&mut copy, seat, asset, amount)
}

fn program_answer(w: &World, depositor_holds: u64, seat: u32, amount: u64) -> Answer {
    let cap = u128::from(BALANCE_CAP);
    if amount > depositor_holds {
        Answer::TokenProgramRefused
    } else if u128::try_from(w.custody_collateral).unwrap() + u128::from(amount) > cap {
        Answer::CustodyCapReached
    } else {
        Answer::Credited(engine_answer(w, seat, Asset::Collateral, amount))
    }
}

/// The engine on its own still answers by the seat's balance, which is why the program
/// must not ask it first.
#[test]
fn r4_the_engine_alone_answers_by_the_seats_balance() {
    let mut w = World::new(10, 8);
    let poor = funded(&mut w, 400);
    let rich = funded(&mut w, 600);
    let amount = BALANCE_CAP - 500;

    assert_eq!(engine_answer(&w, poor, Asset::Collateral, amount), Ok(()));
    assert_eq!(
        engine_answer(&w, rich, Asset::Collateral, amount),
        Err(E::BalanceCapExceeded)
    );
}

#[test]
fn r4_the_same_deposit_answers_the_same_for_seats_holding_different_amounts() {
    let mut w = World::new(10, 8);
    let poor = funded(&mut w, 400);
    let rich = funded(&mut w, 600);
    let amount = BALANCE_CAP - 500;

    for holds in [1, amount] {
        let answer = program_answer(&w, holds, poor, amount);
        assert_eq!(answer, program_answer(&w, holds, rich, amount));
    }
    assert_eq!(
        program_answer(&w, amount, rich, amount),
        Answer::CustodyCapReached,
        "a depositor holding the amount meets the token's cap before the seat"
    );
}

/// Every step of the round 4 binary search gets the same answer, so it ends where it
/// started.
#[test]
fn r4_a_binary_search_over_deposit_answers_finds_nothing() {
    let mut w = World::new(10, 8);
    let secret = 31_415_926_535u64;
    let victim = funded(&mut w, secret);
    for x in [
        0,
        1,
        secret - 1,
        secret,
        secret + 1,
        BALANCE_CAP / 2,
        BALANCE_CAP - 2,
    ] {
        let answer = program_answer(&w, 1, victim, BALANCE_CAP - x);
        assert_eq!(answer, Answer::TokenProgramRefused, "x = {x}");
    }
}

//! Audit, program authority: whether the admin can take back seats opened
//! through a stolen gate key.
//!
//! The program's `close_unused_trader` (instructions/trader.rs) closes a seat
//! only while `seat.version == view.opened_version`, and then calls the
//! engine's `close_seat`, which also requires the seat to hold nothing. These
//! tests model that precondition over the engine's seats exactly as the
//! program states it, so they run without a validator.

mod common;

use common::*;
use noirwire_orderbook_engine::EngineError as E;
use noirwire_orderbook_engine::*;

/// What `close_unused_trader` does with a seat, given the version the view
/// recorded when it was opened: `SeatUsed` unless the version is unchanged,
/// then the engine's `close_seat` for the seat's owner.
fn close_unused_trader(w: &mut World, seat: u32, opened_version: u64) -> Result<(), String> {
    if w.seat(seat).version != opened_version {
        return Err("SeatUsed".to_string());
    }
    w.close(seat).map_err(|error| format!("{error:?}"))
}

/// A key no other seat in the world uses, so the table can be filled past the
/// harness's own key counter.
fn spam_key(n: usize) -> [u8; 32] {
    let mut key = [0xA5; 32];
    key[..8].copy_from_slice(&(n as u64).to_le_bytes());
    key
}

const TRADER_PLACES: usize = 32;

fn full_table_of_spam(dust: bool) -> (World, Vec<(u32, u64)>) {
    let mut w = World::new(RESERVED_SEATS + TRADER_PLACES, 8);
    let mut opened = Vec::new();
    for n in 0..TRADER_PLACES {
        let seat = w.open_with_key(spam_key(n)).unwrap();
        let opened_version = w.seat(seat).version;
        if dust {
            w.deposit(seat, Asset::Spot(QUOTE), 1).unwrap();
        }
        opened.push((seat, opened_version));
    }
    assert_eq!(
        w.try_open(),
        Err(E::SeatTableFull),
        "the spam seats fill the table"
    );
    (w, opened)
}

#[test]
fn an_untouched_spam_seat_is_given_back_by_the_admin() {
    let (mut w, opened) = full_table_of_spam(false);
    for (seat, opened_version) in opened {
        close_unused_trader(&mut w, seat, opened_version).unwrap();
    }
    assert!(w.try_open().is_ok(), "a newcomer gets a place back");
}

#[test]
fn a_deposit_of_one_atom_is_accepted_into_any_open_seat() {
    let mut w = World::new(RESERVED_SEATS + 2, 8);
    let seat = w.open();
    let before = w.seat(seat).version;
    w.deposit(seat, Asset::Spot(QUOTE), 1).unwrap();
    assert_eq!(w.seat(seat).version, before + 1);
    assert_eq!(
        w.withdraw_as(seat, [0xEE; 32], Asset::Spot(QUOTE), 1),
        Err(E::NotSeatOwner),
        "nobody but the owner can take the atom back out"
    );
}

/// Accepted limit (`SECURITY.md`, "The gate key"). The admin gives back only seats
/// nobody touched. A thief holds the owner keys of the seats it opens, and one atom in
/// each makes every one of them the owner's to close, so those places stay taken. The
/// bound is that only the owner can give them back: the admin reclaims none, a newcomer
/// finds the table full, and once the owner empties a seat and closes it the place is
/// free again. How many places a thief takes is bounded by the daily seat cap
/// (`audit_availability_privacy_seats.rs`).
#[test]
fn accepted_limit_a_one_atom_deposit_keeps_a_stolen_gate_seat_from_the_admin_forever() {
    let (mut w, opened) = full_table_of_spam(true);
    for &(seat, opened_version) in &opened {
        assert_eq!(
            close_unused_trader(&mut w, seat, opened_version),
            Err("SeatUsed".to_string()),
            "accepted: the admin reclaims none of them"
        );
    }
    assert_eq!(w.try_open(), Err(E::SeatTableFull));

    let (seat, _) = opened[0];
    w.withdraw(seat, Asset::Spot(QUOTE), 1).unwrap();
    w.close(seat).unwrap();
    assert!(
        w.try_open().is_ok(),
        "the owner, and only the owner, gives the place back"
    );
}

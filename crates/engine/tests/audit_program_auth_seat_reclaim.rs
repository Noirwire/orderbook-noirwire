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

/// Fails today. SECURITY.md, "The gate key": seats opened through a stolen
/// gate key cost at most `max_seats_per_day` a day, and "the admin closes
/// seats that were never used with `close_unused_trader`, which returns their
/// rent and their place". A thief who also deposits one atom into each seat
/// it opens makes every one of them unclosable by the admin, so the bound is
/// per day but the loss accumulates until the table is full for good.
#[test]
fn a_one_atom_deposit_keeps_a_stolen_gate_seat_from_the_admin_forever() {
    let (mut w, opened) = full_table_of_spam(true);
    let mut reclaimed = 0;
    for (seat, opened_version) in opened {
        if close_unused_trader(&mut w, seat, opened_version).is_ok() {
            reclaimed += 1;
        }
    }
    let newcomer = w.try_open();
    assert!(
        reclaimed > 0 && newcomer.is_ok(),
        "INVARIANT BROKEN: seats opened through a stolen gate key can be given back by the \
         admin (SECURITY.md, the gate key). After a one-atom deposit into each of {TRADER_PLACES} \
         spam seats the admin reclaimed {reclaimed} of them and a new trader gets {newcomer:?}"
    );
}

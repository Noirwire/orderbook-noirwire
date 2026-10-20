//! Audit, availability of the seat table at its real size.
//!
//! `open_trader` (instructions/trader.rs) needs the gate's signature and counts the
//! seat against `max_seats_per_day` (state.rs `count_new_seat`, 100 by default in
//! `sdk/src/constants.ts`). `close_unused_trader` closes a seat only while its version
//! is the one it was opened with and the engine's `close_seat` finds it empty. The
//! test below drives the engine's own `open_seat`, `deposit` and `close_seat` over a
//! table of `SEATS` places and models those two program checks as written.

use bytemuck::Zeroable;
use noirwire_orderbook_engine::EngineError as E;
use noirwire_orderbook_engine::*;

const DEFAULT_MAX_SEATS_PER_DAY: usize = 100;

fn key(n: usize) -> [u8; 32] {
    let mut key = [0x5A; 32];
    key[..8].copy_from_slice(&(n as u64).to_le_bytes());
    key
}

/// Whoever can get the gate's signature (a stolen gate key, or a gate service that
/// co-signs `open_trader` for anyone, as the devnet simulation service does for the
/// MCP server) takes every one of the day's 100 places as soon as the UTC day turns,
/// and puts one atom into each seat. After 21 days the table is full. Every seat then
/// fails the admin's `close_unused_trader` twice over (its version moved, and
/// `close_seat` finds it not empty), only its owner can close it, and nothing evicts
/// it, so no newcomer can ever open a seat again.
#[test]
fn twenty_one_days_of_the_daily_quota_and_one_atom_each_fill_the_table_for_good() {
    let mut header = LedgerHeader::zeroed();
    let mut seats = vec![Seat::zeroed(); SEATS];
    let mut ledger = LedgerMut {
        header: &mut header,
        seats: &mut seats,
    };
    open_reserved_seat(&mut ledger, FEE_SEAT, &[0xF0; 32]).unwrap();
    open_reserved_seat(&mut ledger, INSURANCE_SEAT, &[0xF1; 32]).unwrap();

    let places = SEATS - RESERVED_SEATS;
    let mut opened = Vec::with_capacity(places);
    let mut days = 0;
    while opened.len() < places {
        days += 1;
        for _ in 0..DEFAULT_MAX_SEATS_PER_DAY.min(places - opened.len()) {
            let owner = key(opened.len());
            let seat = open_seat(&mut ledger, &owner).unwrap();
            let opened_version = ledger.seats[seat as usize].version;
            deposit(&mut ledger, seat, Asset::Collateral, 1).unwrap();
            opened.push((seat, owner, opened_version));
        }
    }
    assert_eq!(days, 21);
    assert_eq!(
        open_seat(&mut ledger, &key(usize::MAX)),
        Err(E::SeatTableFull)
    );

    let mut reclaimable = 0;
    for (seat, owner, opened_version) in &opened {
        let version_unchanged = ledger.seats[*seat as usize].version == *opened_version;
        let trader = Trader { seat: *seat, owner };
        if version_unchanged && close_seat(&mut ledger, trader).is_ok() {
            reclaimable += 1;
        }
    }
    assert_eq!(ledger.header.open_seats as usize, SEATS);
    assert!(
        reclaimable > 0,
        "availability (SECURITY.md, gate key): the admin must be able to give back places taken \
         through the gate; {places} seats opened at the default 100 a day for {days} days and \
         holding one atom each leave {reclaimable} of them reclaimable, and SeatTableFull for \
         every newcomer from then on"
    );
}

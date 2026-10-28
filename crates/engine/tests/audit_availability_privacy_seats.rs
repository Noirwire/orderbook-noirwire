//! Audit, availability of the seat table at its real size.
//!
//! `open_trader` (instructions/trader.rs) needs the gate's signature and counts the
//! seat against `max_seats_per_day` (state.rs `count_new_seat`, 100 by default in
//! `sdk/src/constants.ts`). `close_unused_trader` closes a seat only while its version
//! is the one it was opened with and the engine's `close_seat` finds it empty. The
//! test below drives the engine's own `take_seat`, `deposit` and `close_seat` over a
//! table of `MIN_SEATS` places and models those two program checks as written.

use bytemuck::Zeroable;
use noirwire_orderbook_engine::EngineError as E;
use noirwire_orderbook_engine::*;

const DEFAULT_MAX_SEATS_PER_DAY: usize = 100;

fn key(n: usize) -> [u8; 32] {
    let mut key = [0x5A; 32];
    key[..8].copy_from_slice(&(n as u64).to_le_bytes());
    key
}

/// Accepted limit (`SECURITY.md`, "The gate key"). Whoever can get the gate's
/// signature (a stolen gate key, or a gate service that co-signs `open_trader` on
/// request) takes every one of the day's 100 places as soon as the UTC day turns and
/// puts one atom into each seat. Every such seat fails the admin's `close_unused_trader`
/// twice over (its version moved, and `close_seat` finds it not empty), only its owner
/// can close it, and nothing evicts it. The bound: the table loses the daily cap each
/// day the gate keeps signing and no more, so the places lost are the cap times the
/// days until the admin replaces the gate or sets the cap to 0, and until then a
/// newcomer still gets a place. Left alone for 21 days at the default cap, the 2,046
/// trader places are all gone and every newcomer gets `SeatTableFull`.
#[test]
fn accepted_limit_one_atom_seats_are_lost_at_the_daily_cap_and_fill_the_table_in_21_days() {
    let mut header = LedgerHeader::zeroed();
    let mut seats = vec![Seat::zeroed(); MIN_SEATS];
    let mut ledger = LedgerMut {
        header: &mut header,
        seats: &mut seats,
    };
    open_reserved_seat(&mut ledger, FEE_SEAT, &[0xF0; 32]).unwrap();
    open_reserved_seat(&mut ledger, INSURANCE_SEAT, &[0xF1; 32]).unwrap();
    push_new_seats(&mut ledger, RESERVED_SEATS as u32, MIN_SEATS as u32).unwrap();

    let places = MIN_SEATS - RESERVED_SEATS;
    let mut opened = Vec::with_capacity(places);
    let mut days = 0;
    while opened.len() < places {
        days += 1;
        let first_of_the_day = opened.len();
        for _ in 0..DEFAULT_MAX_SEATS_PER_DAY.min(places - opened.len()) {
            let owner = key(opened.len());
            let seat = take_seat(&mut ledger, &owner).unwrap();
            let opened_version = ledger.seats[seat as usize].version;
            deposit(&mut ledger, seat, Asset::Collateral, 1).unwrap();
            opened.push((seat, owner, opened_version));
        }
        for (seat, owner, opened_version) in &opened[first_of_the_day..] {
            assert_ne!(ledger.seats[*seat as usize].version, *opened_version);
            let trader = Trader { seat: *seat, owner };
            assert_eq!(close_seat(&mut ledger, trader), Err(E::SeatNotEmpty));
        }
        let lost = (days * DEFAULT_MAX_SEATS_PER_DAY).min(places);
        assert_eq!(
            ledger.header.open_seats as usize,
            RESERVED_SEATS + lost,
            "accepted: day {days} loses the day's cap of places, and no more"
        );
        if lost < places {
            let newcomer = key(usize::MAX - days);
            let seat = take_seat(&mut ledger, &newcomer).unwrap();
            close_seat(
                &mut ledger,
                Trader {
                    seat,
                    owner: &newcomer,
                },
            )
            .unwrap();
        }
    }
    assert_eq!(days, 21);
    assert_eq!(
        take_seat(&mut ledger, &key(usize::MAX)),
        Err(E::SeatTableFull)
    );
}

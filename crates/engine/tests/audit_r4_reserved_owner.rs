//! Audit round 4, the owner of the fee and insurance seats.
//!
//! `finalize_ledger` opens both reserved seats with the program id as owner. The
//! program id is an on-curve key, so whoever holds its keypair can open an ordinary
//! seat with the same owner bytes. This checks that such a seat gets a trader index
//! and that the reserved indices stay refused even to a caller whose owner matches.

use bytemuck::Zeroable;
use noirwire_orderbook_engine::EngineError as E;
use noirwire_orderbook_engine::*;

const SEATS: usize = 8;

#[test]
fn a_seat_owned_like_the_reserved_seats_gets_a_trader_index_and_cannot_reach_them() {
    let program_id = [0x9A; 32];
    let mut header = LedgerHeader::zeroed();
    let mut seats = vec![Seat::zeroed(); SEATS];
    let mut ledger = LedgerMut {
        header: &mut header,
        seats: &mut seats,
    };
    open_reserved_seat(&mut ledger, FEE_SEAT, &program_id).unwrap();
    open_reserved_seat(&mut ledger, INSURANCE_SEAT, &program_id).unwrap();

    push_new_seats(&mut ledger, RESERVED_SEATS as u32, SEATS as u32).unwrap();
    let seat = take_seat(&mut ledger, &program_id).unwrap();
    assert!(seat as usize >= RESERVED_SEATS);
    assert_eq!(ledger.seats[seat as usize].owner, program_id);

    for reserved in [FEE_SEAT, INSURANCE_SEAT] {
        let trader = Trader {
            seat: reserved,
            owner: &program_id,
        };
        assert_eq!(close_seat(&mut ledger, trader), Err(E::ReservedSeat));
    }
    assert!(ledger.seats[FEE_SEAT as usize].is_open());
    assert!(ledger.seats[INSURANCE_SEAT as usize].is_open());
}

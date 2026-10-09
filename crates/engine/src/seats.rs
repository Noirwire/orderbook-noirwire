use bytemuck::Zeroable;

use crate::error::{EngineError, EngineResult};
use crate::journal::commit_seat;
use crate::margin::{
    meets_initial_margin, require_fresh_positions, settle_positions, MarketRisk, Risk,
};
use crate::math::{count, credit, credit_signed, debit, increment, index, signed};
use crate::state::{LedgerMut, Seat, Trader, RESERVED_SEATS, SEAT_OPEN};

/// Which pool of a seat a deposit or withdrawal moves.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Asset {
    /// RULES 6: cross-margin collateral for perpetuals.
    Collateral,
    /// RULES 5: one of the spot token balances, by token index.
    Spot(u8),
}

/// What the caller supplies besides the accounts: the time, the exchange pause flag,
/// the step limit and every market's risk data. The engine never reads a clock.
#[derive(Clone, Copy)]
pub struct Env<'a> {
    /// Unix seconds.
    pub now: i64,
    pub exchange_paused: bool,
    /// RULES 4: `MAX_STEPS` for one `place_order`.
    pub max_steps: u32,
    /// Indexed by market id.
    pub markets: &'a [MarketRisk],
    pub hash: Sha256,
}

/// SHA-256 over one byte string, supplied by the caller (RULES 10).
pub type Sha256 = fn(&[u8]) -> [u8; 32];

/// RULES 13.3: only a seat's owner can trade, cancel, withdraw or close it.
pub(crate) fn owned_seat<'s>(seats: &'s [Seat], trader: Trader<'_>) -> EngineResult<&'s Seat> {
    let seat = seats
        .get(index(trader.seat)?)
        .ok_or(EngineError::SeatOutOfRange)?;
    if !seat.is_open() {
        return Err(EngineError::SeatNotOpen);
    }
    if seat.owner != *trader.owner {
        return Err(EngineError::NotSeatOwner);
    }
    Ok(seat)
}

pub(crate) fn owned_seat_mut<'s>(
    seats: &'s mut [Seat],
    trader: Trader<'_>,
) -> EngineResult<&'s mut Seat> {
    owned_seat(seats, trader)?;
    seats
        .get_mut(index(trader.seat)?)
        .ok_or(EngineError::SeatOutOfRange)
}

fn occupy(ledger: &mut LedgerMut<'_>, seat_index: usize, owner: &[u8; 32]) -> EngineResult<u32> {
    let reported = count(seat_index)?;
    let open_seats = ledger
        .header
        .open_seats
        .checked_add(1)
        .ok_or(EngineError::MathOverflow)?;
    let seat = ledger
        .seats
        .get_mut(seat_index)
        .ok_or(EngineError::SeatOutOfRange)?;
    if seat.is_open() {
        return Err(EngineError::SeatAlreadyOpen);
    }
    let version = increment(seat.version)?;
    *seat = Seat::zeroed();
    seat.owner = *owner;
    seat.status = SEAT_OPEN;
    seat.version = version;
    ledger.header.open_seats = open_seats;
    Ok(reported)
}

/// RULES 12: opens the lowest free trader seat. A full table rejects; nothing is evicted.
/// One key holds at most one trader seat.
pub fn open_seat(ledger: &mut LedgerMut<'_>, owner: &[u8; 32]) -> EngineResult<u32> {
    let mut free = None;
    for (position, seat) in ledger.seats.iter().enumerate().skip(RESERVED_SEATS) {
        if seat.is_open() {
            if seat.owner == *owner {
                return Err(EngineError::SeatAlreadyOpen);
            }
        } else if free.is_none() {
            free = Some(position);
        }
    }
    occupy(ledger, free.ok_or(EngineError::SeatTableFull)?, owner)
}

/// Opens the fee seat or the insurance seat. They are ordinary seats at fixed indices.
pub fn open_reserved_seat(
    ledger: &mut LedgerMut<'_>,
    seat: u32,
    owner: &[u8; 32],
) -> EngineResult<u32> {
    let seat_index = index(seat)?;
    if seat_index >= RESERVED_SEATS {
        return Err(EngineError::NotReservedSeat);
    }
    occupy(ledger, seat_index, owner)
}

/// Closes a seat that holds nothing: no balance, no position, no open order.
pub fn close_seat(ledger: &mut LedgerMut<'_>, trader: Trader<'_>) -> EngineResult<()> {
    if index(trader.seat)? < RESERVED_SEATS {
        return Err(EngineError::ReservedSeat);
    }
    let open_seats = ledger
        .header
        .open_seats
        .checked_sub(1)
        .ok_or(EngineError::InvariantBroken)?;
    let seat = owned_seat_mut(ledger.seats, trader)?;
    if !seat.holds_nothing() {
        return Err(EngineError::SeatNotEmpty);
    }
    let version = increment(seat.version)?;
    *seat = Seat::zeroed();
    seat.version = version;
    ledger.header.open_seats = open_seats;
    Ok(())
}

/// RULES 11: credits a seat. The caller moves the tokens in the same instruction.
/// Anyone may deposit into any open seat.
pub fn deposit(
    ledger: &mut LedgerMut<'_>,
    seat: u32,
    asset: Asset,
    amount: u64,
) -> EngineResult<()> {
    if amount == 0 {
        return Err(EngineError::ZeroAmount);
    }
    let stored = ledger
        .seats
        .get_mut(index(seat)?)
        .ok_or(EngineError::SeatOutOfRange)?;
    if !stored.is_open() {
        return Err(EngineError::SeatNotOpen);
    }
    let mut working = *stored;
    match asset {
        Asset::Collateral => credit_signed(&mut working.collateral, i128::from(amount))?,
        Asset::Spot(token) => credit(&mut working.token_mut(token)?.available, u128::from(amount))?,
    }
    commit_seat(stored, working)
}

/// RULES 6: a collateral withdrawal needs collateral that covers it and equity after it
/// of at least initial margin. RULES 9: a stale feed on any market where the trader
/// holds a perp position blocks every withdrawal.
pub fn withdraw(
    ledger: &mut LedgerMut<'_>,
    env: &Env<'_>,
    trader: Trader<'_>,
    asset: Asset,
    amount: u64,
) -> EngineResult<()> {
    if amount == 0 {
        return Err(EngineError::ZeroAmount);
    }
    let stored = owned_seat_mut(ledger.seats, trader)?;
    let mut working = *stored;
    let risk = Risk::new(env.markets);
    require_fresh_positions(&working, &risk, env.now)?;
    settle_positions(&mut working, &risk)?;
    match asset {
        Asset::Collateral => {
            if i128::from(working.collateral) < i128::from(amount) {
                return Err(EngineError::InsufficientCollateral);
            }
            let debit_amount = signed(u128::from(amount))?
                .checked_neg()
                .ok_or(EngineError::MathOverflow)?;
            credit_signed(&mut working.collateral, debit_amount)?;
            if !meets_initial_margin(&working, &risk, None)? {
                return Err(EngineError::InsufficientMargin);
            }
        }
        Asset::Spot(token) => debit(
            &mut working.token_mut(token)?.available,
            u128::from(amount),
            EngineError::InsufficientBalance,
        )?,
    }
    commit_seat(stored, working)
}

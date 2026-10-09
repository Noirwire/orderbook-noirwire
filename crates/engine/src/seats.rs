use bytemuck::Zeroable;

use crate::error::{EngineError, EngineResult};
use crate::journal::commit_seat;
use crate::margin::{
    meets_initial_margin, require_fresh_positions, settle_positions, MarketRisk, Risk,
};
use crate::math::{count, credit_signed, credit_token, debit, increment, index, signed, sub};
use crate::state::{
    LedgerMut, MarketParams, Seat, Trader, FEE_SEAT, INSURANCE_SEAT, RESERVED_SEATS, SEAT_OPEN,
    STATUS_ACTIVE,
};

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
        Asset::Spot(token) => credit_token(working.token_mut(token)?, u128::from(amount))?,
    }
    commit_seat(stored, working)
}

/// RULES 12a: no key can sign for the fee seat or the insurance seat.
pub(crate) fn refuse_reserved_seat(seat: u32) -> EngineResult<()> {
    if index(seat)? < RESERVED_SEATS {
        Err(EngineError::ReservedSeat)
    } else {
        Ok(())
    }
}

fn open_seat_at<'s>(ledger: &'s mut LedgerMut<'_>, seat: u32) -> EngineResult<&'s mut Seat> {
    let stored = ledger
        .seats
        .get_mut(index(seat)?)
        .ok_or(EngineError::SeatOutOfRange)?;
    if stored.is_open() {
        Ok(stored)
    } else {
        Err(EngineError::SeatNotOpen)
    }
}

fn debit_fee_seat(working: &mut Seat, asset: Asset, amount: u64) -> EngineResult<()> {
    match asset {
        Asset::Collateral => {
            if i128::from(working.collateral) < i128::from(amount) {
                return Err(EngineError::InsufficientCollateral);
            }
            credit_signed(&mut working.collateral, sub(0, i128::from(amount))?)
        }
        Asset::Spot(token) => debit(
            &mut working.token_mut(token)?.available,
            u128::from(amount),
            EngineError::InsufficientBalance,
        ),
    }
}

/// RULES 12a: the admin moves collected perp fees, which are collateral, from the fee
/// seat to the insurance seat. Nothing leaves custody.
pub fn move_fees_to_insurance(ledger: &mut LedgerMut<'_>, amount: u64) -> EngineResult<()> {
    if amount == 0 {
        return Err(EngineError::ZeroAmount);
    }
    let mut fees = *open_seat_at(ledger, FEE_SEAT)?;
    let mut insurance = *open_seat_at(ledger, INSURANCE_SEAT)?;
    debit_fee_seat(&mut fees, Asset::Collateral, amount)?;
    credit_signed(&mut insurance.collateral, i128::from(amount))?;
    let fee_version = increment(fees.version)?;
    let insurance_version = increment(insurance.version)?;
    fees.version = fee_version;
    insurance.version = insurance_version;
    *open_seat_at(ledger, FEE_SEAT)? = fees;
    *open_seat_at(ledger, INSURANCE_SEAT)? = insurance;
    Ok(())
}

/// RULES 12a: the admin takes collected fees out. This debits the fee seat; the caller
/// pays the same amount out of custody in the same instruction (RULES 11).
pub fn collect_fees(ledger: &mut LedgerMut<'_>, asset: Asset, amount: u64) -> EngineResult<()> {
    if amount == 0 {
        return Err(EngineError::ZeroAmount);
    }
    let stored = open_seat_at(ledger, FEE_SEAT)?;
    let mut working = *stored;
    debit_fee_seat(&mut working, asset, amount)?;
    commit_seat(stored, working)
}

/// RULES 8.6: anyone may call this for a seat with no position on any market and
/// negative collateral. The insurance seat pays what it can, never more than the
/// market has recorded, and the market's recorded amount falls by the same. Returns
/// what was paid. A seat that does not qualify is not an error: nothing changes and
/// zero is returned, so the call reveals nothing about the seat.
pub fn cover_shortfall(
    ledger: &mut LedgerMut<'_>,
    params: &mut MarketParams,
    seat: u32,
) -> EngineResult<u64> {
    params.check()?;
    let Some(debtor) = usize::try_from(seat).ok().and_then(|i| ledger.seats.get(i)) else {
        return Ok(0);
    };
    let flat = debtor.perp.iter().all(|slot| slot.base == 0);
    if !debtor.is_open() || !flat || debtor.collateral >= 0 || seat == INSURANCE_SEAT {
        return Ok(0);
    }
    let mut debtor = *debtor;
    let mut insurance = *open_seat_at(ledger, INSURANCE_SEAT)?;
    let funds = u64::try_from(insurance.collateral).unwrap_or(0);
    let paid = debtor
        .collateral
        .unsigned_abs()
        .min(funds)
        .min(params.uncovered_shortfall);
    if paid == 0 {
        return Ok(0);
    }
    credit_signed(&mut insurance.collateral, sub(0, i128::from(paid))?)?;
    credit_signed(&mut debtor.collateral, i128::from(paid))?;
    let recorded = params
        .uncovered_shortfall
        .checked_sub(paid)
        .ok_or(EngineError::InvariantBroken)?;
    let debtor_version = increment(debtor.version)?;
    let insurance_version = increment(insurance.version)?;
    debtor.version = debtor_version;
    insurance.version = insurance_version;
    *open_seat_at(ledger, INSURANCE_SEAT)? = insurance;
    *open_seat_at(ledger, seat)? = debtor;
    params.uncovered_shortfall = recorded;
    Ok(paid)
}

/// RULES 8.6: anyone may call this. A debtor that repays by deposit no longer owes what
/// the markets still record. This lowers the records, market 0 first, until together
/// they equal what seats with no position on any market still owe, and returns the
/// amount removed. It never raises a record. One pass over the seat table: at most
/// `SEATS` seats of `MARKETS` positions each, then at most one write per market.
pub fn reconcile_shortfall(ledger: &LedgerMut<'_>, markets: &mut [MarketParams]) -> u64 {
    let owed: u128 = ledger
        .seats
        .iter()
        .filter(|seat| seat.is_open() && seat.collateral < 0)
        .filter(|seat| seat.perp.iter().all(|slot| slot.base == 0))
        .map(|seat| u128::from(seat.collateral.unsigned_abs()))
        .fold(0u128, u128::saturating_add);
    let recorded = markets
        .iter()
        .map(|market| u128::from(market.uncovered_shortfall))
        .fold(0u128, u128::saturating_add);
    let surplus = recorded.saturating_sub(owed);
    let mut to_remove = u64::try_from(surplus).unwrap_or(u64::MAX);
    let mut removed = 0u64;
    for market in markets.iter_mut() {
        let cut = market.uncovered_shortfall.min(to_remove);
        market.uncovered_shortfall = market.uncovered_shortfall.saturating_sub(cut);
        to_remove = to_remove.saturating_sub(cut);
        removed = removed.saturating_add(cut);
    }
    removed
}

/// RULES 8.6 and 9: the admin returns a market to normal status. Refused while the
/// market still has a recorded shortfall.
pub fn resume_market(params: &mut MarketParams) -> EngineResult<()> {
    params.check()?;
    if params.uncovered_shortfall != 0 {
        return Err(EngineError::ShortfallOutstanding);
    }
    params.status = STATUS_ACTIVE;
    Ok(())
}

/// RULES 6: a collateral withdrawal needs collateral that covers it and equity after it
/// of at least initial margin, and is refused for everyone while any market in
/// `env.markets` has a recorded uncovered shortfall. RULES 9: a stale feed on any
/// market where the trader holds a perp position blocks every withdrawal.
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
    refuse_reserved_seat(trader.seat)?;
    let shortfall_recorded = env.markets.iter().any(|m| m.uncovered_shortfall > 0);
    if asset == Asset::Collateral && shortfall_recorded {
        return Err(EngineError::ShortfallOutstanding);
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

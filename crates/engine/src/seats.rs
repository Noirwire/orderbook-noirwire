use bytemuck::Zeroable;

use crate::book::{release_seat_orders, remove_seat_orders, SeatRelease};
use crate::error::{EngineError, EngineResult};
use crate::journal::commit_seat;
use crate::margin::{
    meets_initial_margin, require_fresh_positions, settle_positions, MarketRisk, Risk,
};
use crate::math::{count, credit_signed, credit_token, debit, increment, index, signed, sub};
use crate::state::{
    listed_on, LedgerMut, MarketParams, Order, PerpBook, Seat, Side, Trader, ACCESS_MAKERS_LISTED,
    ACCESS_TAKERS_LISTED, FEE_SEAT, INSURANCE_SEAT, KIND_PERP, MARKETS, ORACLE_HEALTHY,
    RESERVED_SEATS, SEAT_OPEN, STATUS_ACTIVE,
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
/// the USDC guard, the step limit and every market's risk data. The engine never reads
/// a clock.
#[derive(Clone, Copy)]
pub struct Env<'a> {
    /// Unix seconds.
    pub now: i64,
    pub exchange_paused: bool,
    /// RULES 9a: the USDC guard passes. While it does not, every perp takes
    /// reduce-only orders only.
    pub quote_ok: bool,
    /// RULES 4: `MAX_STEPS` for one `place_order`.
    pub max_steps: u32,
    /// Indexed by market id.
    pub markets: &'a [MarketRisk],
    pub hash: Sha256,
}

/// SHA-256 over one byte string, supplied by the caller (RULES 10).
pub type Sha256 = fn(&[u8]) -> [u8; 32];

/// The seat at `seat`, refused when there is no such seat or it is not open.
#[inline(always)]
pub(crate) fn seat_if_open(seats: &[Seat], seat: u32) -> EngineResult<&Seat> {
    let stored = seats.get(index(seat)?).ok_or(EngineError::SeatOutOfRange)?;
    if stored.is_open() {
        Ok(stored)
    } else {
        Err(EngineError::SeatNotOpen)
    }
}

/// The seat at `seat`, for writing, refused like `seat_if_open`.
#[inline(always)]
pub(crate) fn seat_if_open_mut(seats: &mut [Seat], seat: u32) -> EngineResult<&mut Seat> {
    let stored = seats
        .get_mut(index(seat)?)
        .ok_or(EngineError::SeatOutOfRange)?;
    if stored.is_open() {
        Ok(stored)
    } else {
        Err(EngineError::SeatNotOpen)
    }
}

/// RULES 13.3: only a seat's owner can trade, cancel, withdraw or close it.
pub(crate) fn owned_seat<'s>(seats: &'s [Seat], trader: Trader<'_>) -> EngineResult<&'s Seat> {
    let seat = seat_if_open(seats, trader.seat)?;
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

/// RULES 12: gives `owner` the seat at the head of the free list, which is the seat
/// freed last, or a seat that was never taken. A table with no free seat rejects with
/// `SeatTableFull`; nothing is evicted. The engine does not look for another seat of
/// the same owner: that one view holds one seat is the caller's rule. A head or link
/// that names a reserved, open or out-of-range seat fails closed with `InvariantBroken`.
pub fn take_seat(ledger: &mut LedgerMut<'_>, owner: &[u8; 32]) -> EngineResult<u32> {
    let popped = ledger
        .header
        .free_head
        .checked_sub(1)
        .ok_or(EngineError::SeatTableFull)?;
    let at = index(popped)?;
    let seat_count = ledger.seats.len();
    let head = ledger.seats.get(at).ok_or(EngineError::InvariantBroken)?;
    let link_in_range = usize::try_from(head.next_free).is_ok_and(|next| next <= seat_count);
    if at < RESERVED_SEATS || head.is_open() || !link_in_range {
        return Err(EngineError::InvariantBroken);
    }
    let next = head.next_free;
    let taken = occupy(ledger, at, owner)?;
    ledger.header.free_head = next;
    Ok(taken)
}

/// RULES 12: puts a seat that holds nothing back on the free list. Version and list
/// link are the only bytes left in it.
fn release_seat(ledger: &mut LedgerMut<'_>, seat_index: usize) -> EngineResult<()> {
    if seat_index < RESERVED_SEATS {
        return Err(EngineError::ReservedSeat);
    }
    let open_seats = ledger
        .header
        .open_seats
        .checked_sub(1)
        .ok_or(EngineError::InvariantBroken)?;
    let head = ledger.header.free_head;
    let listed = count(seat_index)?
        .checked_add(1)
        .ok_or(EngineError::MathOverflow)?;
    let seat = ledger
        .seats
        .get_mut(seat_index)
        .ok_or(EngineError::SeatOutOfRange)?;
    if !seat.is_open() {
        return Err(EngineError::SeatNotOpen);
    }
    if !seat.holds_nothing() {
        return Err(EngineError::SeatNotEmpty);
    }
    let version = increment(seat.version)?;
    *seat = Seat::zeroed();
    seat.version = version;
    seat.next_free = head;
    ledger.header.free_head = listed;
    ledger.header.open_seats = open_seats;
    Ok(())
}

/// RULES 12: releases the seat when it holds nothing and is not pinned, and says
/// whether it did. A debtor, a seat with a list entry or a block, a reserved seat and a
/// seat that is not open stay as they are.
pub fn release_if_empty(ledger: &mut LedgerMut<'_>, seat: u32) -> bool {
    let Ok(at) = index(seat) else {
        return false;
    };
    let releasable = at >= RESERVED_SEATS
        && ledger.seats.get(at).is_some_and(|stored| {
            stored.is_open() && stored.holds_nothing() && !stored.is_pinned()
        });
    releasable && release_seat(ledger, at).is_ok()
}

/// RULES 12: `release_if_empty` for each seat of `start..start + count` that exists.
/// Blind: it reports nothing, so a caller learns nothing about which seats it released,
/// and a seat that does not qualify is passed over without a trace.
pub fn release_empty_seats(ledger: &mut LedgerMut<'_>, start: u32, count: u16) {
    for seat in seats_in_range(ledger.seats.len(), start, count) {
        release_if_empty(ledger, seat);
    }
}

/// RULES 12: puts the never-used seats `from..to` on the free list, `to - 1` first, so
/// that `from` is the next seat taken. They must be closed trader seats of the ledger.
pub fn push_new_seats(ledger: &mut LedgerMut<'_>, from: u32, to: u32) -> EngineResult<()> {
    let (from, to) = (index(from)?, index(to)?);
    let all_closed = ledger
        .seats
        .get(from..to)
        .is_some_and(|new| new.iter().all(|seat| !seat.is_open()));
    if from < RESERVED_SEATS || !all_closed {
        return Err(EngineError::InvariantBroken);
    }
    for at in (from..to).rev() {
        let head = ledger.header.free_head;
        let listed = count(at)?.checked_add(1).ok_or(EngineError::MathOverflow)?;
        let seat = ledger
            .seats
            .get_mut(at)
            .ok_or(EngineError::InvariantBroken)?;
        seat.next_free = head;
        ledger.header.free_head = listed;
    }
    Ok(())
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

/// Closes a seat that holds nothing: no balance, no position, no open order. The
/// owner leaving closes a pinned seat too; the seat goes back on the free list.
pub fn close_seat(ledger: &mut LedgerMut<'_>, trader: Trader<'_>) -> EngineResult<()> {
    let at = index(trader.seat)?;
    if at < RESERVED_SEATS {
        return Err(EngineError::ReservedSeat);
    }
    owned_seat(ledger.seats, trader)?;
    release_seat(ledger, at)
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
    let stored = seat_if_open_mut(ledger.seats, seat)?;
    let mut working = *stored;
    match asset {
        Asset::Collateral => credit_signed(&mut working.collateral, i128::from(amount))?,
        Asset::Spot(token) => credit_token(working.token_mut(token)?, u128::from(amount))?,
    }
    commit_seat(stored, working)
}

/// RULES 12a: no trader instruction acts for the fee seat or the insurance seat. No view
/// holds their index, and every entry point that takes a seat refuses it here; their
/// owner bytes play no part.
pub(crate) fn refuse_reserved_seat(seat: u32) -> EngineResult<()> {
    if index(seat)? < RESERVED_SEATS {
        Err(EngineError::ReservedSeat)
    } else {
        Ok(())
    }
}

fn open_seat_at<'s>(ledger: &'s mut LedgerMut<'_>, seat: u32) -> EngineResult<&'s mut Seat> {
    seat_if_open_mut(ledger.seats, seat)
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
/// pays the same amount out of custody in the same instruction (RULES 11). RULES 6:
/// collateral is refused while any market in `markets`, which must be every perp
/// market, has a recorded uncovered shortfall, and RULES 9 while any of them is not
/// healthy.
pub fn collect_fees(
    ledger: &mut LedgerMut<'_>,
    markets: &[MarketParams],
    asset: Asset,
    amount: u64,
) -> EngineResult<()> {
    if amount == 0 {
        return Err(EngineError::ZeroAmount);
    }
    let shortfall_recorded = markets.iter().any(|m| m.uncovered_shortfall > 0);
    if asset == Asset::Collateral && shortfall_recorded {
        return Err(EngineError::ShortfallOutstanding);
    }
    let incident_open = markets
        .iter()
        .any(|m| m.kind == KIND_PERP && m.oracle_health != ORACLE_HEALTHY);
    if asset == Asset::Collateral && incident_open {
        return Err(EngineError::OracleIncident);
    }
    let stored = open_seat_at(ledger, FEE_SEAT)?;
    let mut working = *stored;
    debit_fee_seat(&mut working, asset, amount)?;
    commit_seat(stored, working)
}

/// Moves as much of `payer`'s positive collateral as `owed` asks into `debtor`, both
/// copies, and returns the amount.
fn pay_debt(payer: &mut Seat, debtor: &mut Seat, owed: u64) -> EngineResult<u64> {
    let paid = owed.min(u64::try_from(payer.collateral).unwrap_or(0));
    if paid > 0 {
        credit_signed(&mut payer.collateral, sub(0, i128::from(paid))?)?;
        credit_signed(&mut debtor.collateral, i128::from(paid))?;
    }
    Ok(paid)
}

/// The seat indices a range call walks: `start` up to `count` further seats, never
/// past the last seat of the ledger. A range that starts beyond it is empty.
pub(crate) fn seats_in_range(seat_count: usize, start: u32, count: u16) -> core::ops::Range<u32> {
    let table_end = u32::try_from(seat_count).unwrap_or(u32::MAX);
    let end = start.saturating_add(u32::from(count)).min(table_end);
    start..end
}

/// RULES 8.6: `cover_shortfall` for each seat in `start..start + count` that exists,
/// in order, and the sum of what was paid. A seat that does not qualify adds nothing,
/// so the sweep of a whole table is the same calls in ranges a transaction can afford.
pub fn cover_shortfall_range(
    ledger: &mut LedgerMut<'_>,
    params: &mut MarketParams,
    start: u32,
    count: u16,
) -> EngineResult<u64> {
    let mut total = 0u64;
    for seat in seats_in_range(ledger.seats.len(), start, count) {
        let paid = cover_shortfall(ledger, params, seat)?;
        total = total.checked_add(paid).ok_or(EngineError::MathOverflow)?;
    }
    Ok(total)
}

/// RULES 8.6: anyone may call this for a seat with no position on any market and
/// negative collateral. The insurance seat pays what it can, then the fee seat, never
/// more than the market has recorded, and the market's recorded amount falls by the
/// same. Returns what was paid. A seat that does not qualify is not an error: nothing
/// changes and zero is returned, so the call reveals nothing about the seat.
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
    let reserved = seat == INSURANCE_SEAT || seat == FEE_SEAT;
    if !debtor.is_open() || !flat || debtor.collateral >= 0 || reserved {
        return Ok(0);
    }
    let mut debtor = *debtor;
    let mut insurance = *open_seat_at(ledger, INSURANCE_SEAT)?;
    let mut fees = *open_seat_at(ledger, FEE_SEAT)?;
    let owed = debtor
        .collateral
        .unsigned_abs()
        .min(params.uncovered_shortfall);
    let from_insurance = pay_debt(&mut insurance, &mut debtor, owed)?;
    let left = owed
        .checked_sub(from_insurance)
        .ok_or(EngineError::InvariantBroken)?;
    let from_fees = pay_debt(&mut fees, &mut debtor, left)?;
    let paid = from_insurance
        .checked_add(from_fees)
        .ok_or(EngineError::InvariantBroken)?;
    if paid == 0 {
        return Ok(0);
    }
    let recorded = params
        .uncovered_shortfall
        .checked_sub(paid)
        .ok_or(EngineError::InvariantBroken)?;
    commit_seat(open_seat_at(ledger, INSURANCE_SEAT)?, insurance)?;
    commit_seat(open_seat_at(ledger, FEE_SEAT)?, fees)?;
    commit_seat(open_seat_at(ledger, seat)?, debtor)?;
    params.uncovered_shortfall = recorded;
    Ok(paid)
}

/// RULES 8.6: anyone may call this. A debtor that repays by deposit no longer owes what
/// the markets still record. This lowers the records, market 0 first, until together
/// they equal what seats with no position on any market still owe, and returns the
/// amount removed. It never raises a record. One pass over the seat table: every seat
/// of the ledger, `MARKETS` positions each, then at most one write per market.
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

/// RULES 8.6 and 9: the admin returns a market to normal status. Refused while this
/// market or any market in `markets`, which must be every perp market, still has a
/// recorded shortfall, and while this market's price source is not healthy. A record
/// says where a debt was recorded, not whose it is: `cover_shortfall` lowers the
/// market it names and `reconcile_shortfall` market 0 first, so only their sum is a
/// fact about what flat seats owe.
pub fn resume_market(params: &mut MarketParams, markets: &[MarketParams]) -> EngineResult<()> {
    params.check()?;
    let shortfall_recorded = markets.iter().any(|m| m.uncovered_shortfall > 0);
    if params.uncovered_shortfall != 0 || shortfall_recorded {
        return Err(EngineError::ShortfallOutstanding);
    }
    if params.oracle_health != ORACLE_HEALTHY {
        return Err(EngineError::OracleIncident);
    }
    params.status = STATUS_ACTIVE;
    Ok(())
}

/// RULES 6: a collateral withdrawal needs collateral that covers it and equity after it
/// of at least initial margin, and is refused for everyone while any market in
/// `env.markets` has a recorded uncovered shortfall or, RULES 9, any perp in it is not
/// healthy. RULES 9: a stale or dislocated feed on any market where the trader holds a
/// perp position blocks every withdrawal.
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
    let incident_open = env.markets.iter().any(MarketRisk::has_incident);
    if asset == Asset::Collateral && incident_open {
        return Err(EngineError::OracleIncident);
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

/// RULES 3a: a seat's lists and block flag, which `set_seat_access` sets together.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SeatAccess {
    /// Bit `m` lists the seat as a maker on market `m`.
    pub maker_markets: u64,
    /// Bit `m` lists the seat as a taker on market `m`.
    pub taker_markets: u64,
    pub blocked: bool,
}

/// What clearing a maker bit takes off one book, worked out before anything is written.
#[derive(Clone, Copy)]
struct BookCancel {
    book: usize,
    bids: SeatRelease,
    asks: SeatRelease,
    bid_len: usize,
    ask_len: usize,
    bid_count: u32,
    ask_count: u32,
}

/// The perp market `market_id` as `release_order` reads it: its kind and its id.
fn perp_settings(market_id: u8) -> MarketParams {
    MarketParams {
        kind: KIND_PERP,
        market_id,
        ..MarketParams::zeroed()
    }
}

fn live(orders: &[Order], live_count: u32) -> EngineResult<&[Order]> {
    orders
        .get(..index(live_count)?)
        .ok_or(EngineError::InvariantBroken)
}

/// Releases every resting order of `seat` on book `at` into `working`, bids first, and
/// says what to drop from the book once the call is certain to succeed. A book that
/// does not hold every order the seat counts on that market is refused with
/// `InvariantBroken`.
fn plan_book_cancel(
    working: &mut Seat,
    seat: u32,
    at: usize,
    book: &PerpBook<'_>,
) -> EngineResult<BookCancel> {
    let params = perp_settings(book.book.market_id);
    let open = usize::from(working.open_order_count(usize::from(book.book.market_id))?);
    let bids = live(book.bids, book.book.bid_count)?;
    let asks = live(book.asks, book.book.ask_count)?;
    let from_bids = release_seat_orders(working, &params, Side::Bid, bids, seat, open)?;
    let ask_budget = open
        .checked_sub(from_bids.released)
        .ok_or(EngineError::InvariantBroken)?;
    let from_asks = release_seat_orders(working, &params, Side::Ask, asks, seat, ask_budget)?;
    if working.open_order_count(usize::from(book.book.market_id))? != 0 {
        return Err(EngineError::InvariantBroken);
    }
    let kept = |len: usize, released: usize| {
        len.checked_sub(released)
            .ok_or(EngineError::InvariantBroken)
            .and_then(count)
    };
    Ok(BookCancel {
        book: at,
        bids: from_bids,
        asks: from_asks,
        bid_len: bids.len(),
        ask_len: asks.len(),
        bid_count: kept(bids.len(), from_bids.released)?,
        ask_count: kept(asks.len(), from_asks.released)?,
    })
}

/// RULES 3a: the admin sets the lists and the block flag of the open trader seat at
/// `trader.seat`, which `trader.owner` must own, all three at once, and returns its
/// index. The fee and insurance seats are never found. An identical setting changes
/// nothing, not even the version. Clearing a maker bit cancels the seat's resting
/// orders on that market in the same call, whether or not the market's maker list is
/// on, so an order cancelled by a delisting never comes back with a relisting. Setting
/// a bit, changing the taker list or blocking cancels nothing: an order its owner may
/// no longer make with stays on the book until matching reaches it, and can fill again
/// if its owner may make again first.
///
/// `books` must be the books of perp markets, each the book its own `market_id`
/// names. The engine cannot tell a spot book or a book under another market's id
/// from the real one; the caller must, and the program checks both against each
/// account's validated header. The program passes every perp book the exchange has. A
/// cleared maker bit whose book is not among them is refused with
/// `MarketDataMissing`, and one whose book does not hold every order the seat counts
/// there with `InvariantBroken`. No price, no pause and no settings are read: this
/// works on any market at any time.
pub fn set_seat_access(
    ledger: &mut LedgerMut<'_>,
    books: &mut [PerpBook<'_>],
    trader: Trader<'_>,
    access: SeatAccess,
) -> EngineResult<u32> {
    if index(trader.seat)? < RESERVED_SEATS {
        return Err(EngineError::SeatNotOpen);
    }
    let seat = trader.seat;
    let stored = owned_seat_mut(ledger.seats, trader)?;
    let cleared = stored.maker_markets & !access.maker_markets;
    let mut working = *stored;
    let mut cancels: [Option<BookCancel>; MARKETS] = [None; MARKETS];
    for (market, cancel) in cancels.iter_mut().enumerate() {
        let market_id = u8::try_from(market).map_err(|_| EngineError::InvariantBroken)?;
        if !listed_on(cleared, market_id) {
            continue;
        }
        let at = books
            .iter()
            .position(|book| book.book.market_id == market_id)
            .ok_or(EngineError::MarketDataMissing)?;
        let book = books.get(at).ok_or(EngineError::InvariantBroken)?;
        *cancel = Some(plan_book_cancel(&mut working, seat, at, book)?);
    }
    working.maker_markets = access.maker_markets;
    working.taker_markets = access.taker_markets;
    working.blocked = u8::from(access.blocked);
    commit_seat(stored, working)?;
    for cancel in cancels.iter().flatten() {
        if let Some(book) = books.get_mut(cancel.book) {
            remove_seat_orders(book.bids, cancel.bid_len, seat, cancel.bids.from);
            remove_seat_orders(book.asks, cancel.ask_len, seat, cancel.asks.from);
            book.book.bid_count = cancel.bid_count;
            book.book.ask_count = cancel.ask_count;
        }
    }
    Ok(seat)
}

/// RULES 3a: the admin switches a perp market's maker list and taker list on or off,
/// at any status and any source health. A spot market takes neither: its switches stay
/// off and turning one on is refused with `InvalidMarketParams`, which changes nothing.
pub fn set_market_access(
    params: &mut MarketParams,
    makers_listed: bool,
    takers_listed: bool,
) -> EngineResult<()> {
    let mut changed = *params;
    changed.access = (if makers_listed {
        ACCESS_MAKERS_LISTED
    } else {
        0
    }) | (if takers_listed {
        ACCESS_TAKERS_LISTED
    } else {
        0
    });
    changed.check()?;
    *params = changed;
    Ok(())
}

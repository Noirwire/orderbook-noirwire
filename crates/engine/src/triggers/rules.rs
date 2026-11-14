//! Setting, cancelling and reconciling triggers.

use super::fire::smallest_order;
use super::heap::entry_of;
use super::{
    DropReason, Kind, TriggerBook, TriggerError, TriggerRecord, TriggerResult, ACTIVE, BELOW, LONG,
    NO_HEAP, NO_POSITION, UNFILLABLE, WHOLE,
};
use crate::state::{MarketKind, MarketParams, Seat, Trader, GENERATION_RETIRED, MAX_PRICE};

/// How much of the position a record closes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TriggerSize {
    /// The whole position at the time of firing: follows it up and down.
    WholePosition,
    /// This many lots, never more than the position, and only ever fewer.
    Lots(u64),
}

/// What a trader asks `set_trigger` for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TriggerInput {
    pub kind: Kind,
    pub trigger_price: u64,
    /// The worst price of the reduce-only market order: a floor when closing a long, a
    /// ceiling when closing a short.
    pub worst_price: u64,
    pub size: TriggerSize,
    /// Unix seconds, or zero for none.
    pub expiry: i64,
    pub client_id: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SetOutcome {
    /// An earlier record of the same kind was replaced.
    pub replaced: bool,
}

/// What `reconcile` found for one record.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Standing {
    /// There was no record.
    #[default]
    Absent,
    Armed,
    /// The record is fixed-size and the position fell below it: it now closes the position.
    Resized,
    Dropped(DropReason),
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Reconciled {
    /// The live position in lots when a record stood, otherwise zero.
    pub position: u64,
    pub take_profit: Standing,
    pub stop_loss: Standing,
}

impl Reconciled {
    pub fn of(&self, kind: Kind) -> Standing {
        match kind {
            Kind::TakeProfit => self.take_profit,
            Kind::StopLoss => self.stop_loss,
        }
    }

    fn set(&mut self, kind: Kind, standing: Standing) {
        match kind {
            Kind::TakeProfit => self.take_profit = standing,
            Kind::StopLoss => self.stop_loss = standing,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SweepReport {
    pub dropped: u32,
    /// Records that were in no heap and are queued again.
    pub requeued: u32,
}

/// Whether `record`, set on the position of `slot_owner`, still belongs to what `seat`
/// holds on `market`: returns the live position in lots, or why it does not.
fn identity(
    slot_owner: &[u8; 32],
    record: &TriggerRecord,
    seat: &Seat,
    market: usize,
) -> Result<u64, DropReason> {
    if !seat.is_open() || seat.owner != *slot_owner {
        return Err(DropReason::SeatGone);
    }
    let Some(at) = seat.slot_index(market) else {
        return Err(DropReason::Flat);
    };
    let base = seat.perp.get(at).map_or(0, |slot| slot.base);
    if base == 0 {
        return Err(DropReason::Flat);
    }
    let same_slot = usize::from(record.perp_slot) == at;
    let same_position = seat.generation(at) == record.generation;
    let same_side = (base > 0) == record.is_long();
    if same_slot && same_position && same_side {
        Ok(base.unsigned_abs())
    } else {
        Err(DropReason::Flip)
    }
}

impl TriggerBook<'_> {
    fn slot_at(&self, seat: u32) -> TriggerResult<usize> {
        let at = usize::try_from(seat).map_err(|_| TriggerError::SeatOutOfRange)?;
        if at < self.slots.len() {
            Ok(at)
        } else {
            Err(TriggerError::SeatOutOfRange)
        }
    }

    /// The slot of the trader's seat, once the seat is open and the trader's own.
    fn owned_slot(&self, trader: Trader<'_>, seat: &Seat) -> TriggerResult<usize> {
        let at = self.slot_at(trader.seat)?;
        if !seat.is_open() {
            Err(TriggerError::SeatNotOpen)
        } else if seat.owner != *trader.owner {
            Err(TriggerError::NotSeatOwner)
        } else {
            Ok(at)
        }
    }

    fn active_in(&self, at: usize) -> TriggerResult<usize> {
        Ok(self
            .slots
            .get(at)
            .ok_or(TriggerError::Corrupt)?
            .active_count())
    }

    fn market(&self) -> TriggerResult<usize> {
        usize::try_from(self.header.market_id).map_err(|_| TriggerError::Corrupt)
    }

    /// Takes the record out of its heap and clears it. The record's version moves on, so
    /// a reference taken earlier no longer matches.
    pub(super) fn drop_record(&mut self, at: usize, kind: Kind) -> TriggerResult<()> {
        let entry = entry_of(at, kind.which()).ok_or(TriggerError::Corrupt)?;
        self.heap_remove(entry)?;
        let slot = self.slots.get_mut(at).ok_or(TriggerError::Corrupt)?;
        let record = slot.record_mut(kind.which()).ok_or(TriggerError::Corrupt)?;
        let version = record.record_version.wrapping_add(1);
        *record = TriggerRecord {
            record_version: version,
            pos: NO_POSITION,
            ..bytemuck::Zeroable::zeroed()
        };
        if slot.active_count() == 0 {
            slot.owner = [0; 32];
        }
        Ok(())
    }

    /// Re-reads the position of `seat` against both records of the seat and drops every
    /// record that no longer belongs to it, as `Dropped` says why: the seat is closed or
    /// has another owner, the position is flat, flipped or a different one (its
    /// generation moved), or the record expired. A fixed-size record larger than the
    /// position shrinks to it. A whole-position record is untouched, since it follows
    /// the position. Records outstanding from `due_triggers` are judged like the rest.
    pub fn reconcile(
        &mut self,
        seat_index: u32,
        seat: &Seat,
        now: i64,
    ) -> TriggerResult<Reconciled> {
        let at = self.slot_at(seat_index)?;
        let market = self.market()?;
        let mut found = Reconciled::default();
        for kind in Kind::BOTH {
            let owner = self.slots.get(at).ok_or(TriggerError::Corrupt)?.owner;
            let record = *self.seat_record(at, kind)?;
            if !record.is_active() {
                continue;
            }
            let standing = match identity(&owner, &record, seat, market) {
                Err(reason) => {
                    self.drop_record(at, kind)?;
                    Standing::Dropped(reason)
                }
                Ok(position) if record.expiry != 0 && now > record.expiry => {
                    found.position = position;
                    self.drop_record(at, kind)?;
                    Standing::Dropped(DropReason::Expired)
                }
                Ok(position) => {
                    found.position = position;
                    if !record.is_whole() && record.size > position {
                        let live = self.seat_record_mut(at, kind)?;
                        live.size = position;
                        live.flags &= !UNFILLABLE;
                        Standing::Resized
                    } else {
                        Standing::Armed
                    }
                }
            };
            found.set(kind, standing);
        }
        Ok(found)
    }

    /// Drops every record of a seat, whatever it holds. The program calls it when the
    /// seat's owner key is reset after a leak, so a stop the leaked key set does not
    /// outlive the reset. It needs no seat, and clearing an empty slot is not an error.
    pub fn clear_seat(&mut self, seat_index: u32) -> TriggerResult<()> {
        let at = self.slot_at(seat_index)?;
        for kind in Kind::BOTH {
            if self.seat_record(at, kind)?.is_active() {
                self.drop_record(at, kind)?;
            }
        }
        Ok(())
    }

    /// Sets, or replaces, the seat's take-profit or stop-loss on the position it holds.
    ///
    /// Refused: a seat that is not open or not the trader's; a market that is not this
    /// book's perp; a mark that is not fresh; a seat with no position; a slot whose
    /// generation is retired; a trigger or worst
    /// price that is zero, off the tick or above `MAX_PRICE`; a trigger the mark already
    /// satisfies, which would fire at once; a worst price on the wrong side of the
    /// trigger; a size of zero or beyond the position; an expiry in the past; and a pair
    /// whose take-profit and stop-loss would sit on the wrong sides of each other.
    ///
    /// The record is bound to the position's current generation, side and slot. Dead
    /// records of the seat are dropped first.
    #[allow(clippy::too_many_arguments)]
    pub fn set_trigger(
        &mut self,
        trader: Trader<'_>,
        seat: &Seat,
        params: &MarketParams,
        mark: u64,
        mark_fresh: bool,
        now: i64,
        input: &TriggerInput,
    ) -> TriggerResult<SetOutcome> {
        let at = self.owned_slot(trader, seat)?;
        if params.check()? != MarketKind::Perp {
            return Err(TriggerError::NotPerpMarket);
        }
        if u32::from(params.market_id) != self.header.market_id {
            return Err(TriggerError::MarketMismatch);
        }
        if !mark_fresh || mark == 0 {
            return Err(TriggerError::MarkNotFresh);
        }
        let market = usize::from(params.market_id);
        let perp_slot = seat.slot_index(market).ok_or(TriggerError::NoPosition)?;
        let base = seat.perp.get(perp_slot).map_or(0, |position| position.base);
        if base == 0 {
            return Err(TriggerError::NoPosition);
        }
        if seat.generation(perp_slot) == GENERATION_RETIRED {
            return Err(TriggerError::SlotRetired);
        }
        let long = base > 0;
        let live = base.unsigned_abs();

        for price in [input.trigger_price, input.worst_price] {
            let on_tick = price.checked_rem(params.tick) == Some(0);
            if price == 0 || !on_tick || price > MAX_PRICE {
                return Err(TriggerError::InvalidPrice);
            }
        }
        let fires_below = matches!(
            (input.kind, long),
            (Kind::StopLoss, true) | (Kind::TakeProfit, false)
        );
        let fires_now = if fires_below {
            mark <= input.trigger_price
        } else {
            mark >= input.trigger_price
        };
        if fires_now {
            return Err(TriggerError::WouldFireImmediately);
        }
        let worst_is_adverse = if long {
            input.worst_price <= input.trigger_price
        } else {
            input.worst_price >= input.trigger_price
        };
        if !worst_is_adverse {
            return Err(TriggerError::InvalidWorstPrice);
        }
        let lots = match input.size {
            TriggerSize::WholePosition => 0,
            TriggerSize::Lots(lots) if lots >= 1 && lots <= live => lots,
            TriggerSize::Lots(_) => return Err(TriggerError::InvalidSize),
        };
        if lots > 0 && lots < live {
            let at_trigger = smallest_order(params, input.trigger_price)?;
            let at_worst = smallest_order(params, input.worst_price)?;
            if lots < at_trigger.max(at_worst) {
                return Err(TriggerError::SizeBelowMinimum);
            }
        }
        if input.expiry < 0 || (input.expiry != 0 && input.expiry <= now) {
            return Err(TriggerError::InvalidExpiry);
        }

        let owner = self.slots.get(at).ok_or(TriggerError::Corrupt)?.owner;
        let sibling = *self.seat_record(at, input.kind.sibling())?;
        if sibling.is_active() && identity(&owner, &sibling, seat, market).is_ok() {
            let crossed = match (long, input.kind) {
                (true, Kind::TakeProfit) | (false, Kind::StopLoss) => {
                    input.trigger_price <= sibling.trigger_price
                }
                (true, Kind::StopLoss) | (false, Kind::TakeProfit) => {
                    input.trigger_price >= sibling.trigger_price
                }
            };
            if crossed {
                return Err(TriggerError::CrossedPair);
            }
        }

        self.reconcile(trader.seat, seat, now)?;
        let replaced = self.seat_record(at, input.kind)?.is_active();
        if replaced {
            self.drop_record(at, input.kind)?;
        }
        self.slots.get_mut(at).ok_or(TriggerError::Corrupt)?.owner = seat.owner;
        let record = self.seat_record_mut(at, input.kind)?;
        let mut flags = ACTIVE;
        if fires_below {
            flags |= BELOW;
        }
        if matches!(input.size, TriggerSize::WholePosition) {
            flags |= WHOLE;
        }
        if long {
            flags |= LONG;
        }
        *record = TriggerRecord {
            trigger_price: input.trigger_price,
            worst_price: input.worst_price,
            size: lots,
            client_id: input.client_id,
            expiry: input.expiry,
            next_attempt: 0,
            record_version: record.record_version.wrapping_add(1),
            pos: NO_POSITION,
            flags,
            generation: seat.generation(perp_slot),
            perp_slot: u8::try_from(perp_slot).map_err(|_| TriggerError::Corrupt)?,
            heap: NO_HEAP,
            sequence: 0,
        };
        self.queue(at, input.kind, now)?;
        Ok(SetOutcome { replaced })
    }

    /// Cancels the seat's record of `kind`. Returns whether there was one; cancelling
    /// nothing is not an error, so a repeated cancel is harmless. Dead records of the
    /// seat are dropped first, so a record that no longer belonged to the seat counts as
    /// there being nothing to cancel.
    pub fn cancel_trigger(
        &mut self,
        trader: Trader<'_>,
        seat: &Seat,
        kind: Kind,
        now: i64,
    ) -> TriggerResult<bool> {
        let at = self.owned_slot(trader, seat)?;
        self.reconcile(trader.seat, seat, now)?;
        let active = self.seat_record(at, kind)?.is_active();
        if active {
            self.drop_record(at, kind)?;
        }
        Ok(active)
    }

    /// Reads `count` slots from the sweep cursor, wrapping at the end of the book:
    /// every record is reconciled against its seat, a record whose seat is past the end
    /// of `seats` is dropped, and a record that is in no heap (taken by `due_triggers`
    /// and never settled) is queued again. A pass of `count` slots at a time reaches
    /// every slot in `seat_capacity / count` calls. A sweep is housekeeping: a dead
    /// record never acts on a later position whether or not one runs, since `reconcile`
    /// refuses it and generations do not wrap. Each slot costs a constant amount.
    pub fn sweep(&mut self, seats: &[Seat], count: u32, now: i64) -> TriggerResult<SweepReport> {
        let capacity = self.header.seat_capacity;
        let mut report = SweepReport::default();
        if capacity == 0 {
            return Ok(report);
        }
        let steps = count.min(capacity);
        let mut cursor = self.header.sweep_cursor;
        if cursor >= capacity {
            cursor = 0;
        }
        for _ in 0..steps {
            let at = usize::try_from(cursor).map_err(|_| TriggerError::Corrupt)?;
            let before = self.active_in(at)?;
            if before > 0 {
                match seats.get(at) {
                    Some(seat) => {
                        self.reconcile(cursor, seat, now)?;
                    }
                    None => {
                        self.clear_seat(cursor)?;
                    }
                }
                let lost = before.saturating_sub(self.active_in(at)?);
                report.dropped = report
                    .dropped
                    .saturating_add(u32::try_from(lost).unwrap_or(0));
                for kind in Kind::BOTH {
                    let record = self.seat_record(at, kind)?;
                    if record.is_active() && record.heap == NO_HEAP {
                        self.queue(at, kind, now)?;
                        report.requeued = report.requeued.saturating_add(1);
                    }
                }
            }
            cursor = if cursor.saturating_add(1) >= capacity {
                0
            } else {
                cursor.saturating_add(1)
            };
        }
        self.header.sweep_cursor = cursor;
        Ok(report)
    }

    /// Whether either record of `seat` is set, in a heap or outside every heap (taken by
    /// `due_triggers` and not yet settled). A seat past the end of the book holds none.
    pub fn holds_records_of(&self, seat: u32) -> bool {
        usize::try_from(seat)
            .ok()
            .and_then(|at| self.slots.get(at))
            .is_some_and(|slot| slot.active_count() > 0)
    }
}

/// Sets the generation of `slot` of the seat at `seat_index` back to zero, which gives a
/// retired slot new life. Safe only because no record anywhere can still carry an old
/// generation of that seat, so the caller must pass the trigger book of **every** market
/// that can hold or fire a trigger; a book left out is a record that could match again.
///
/// Refused while the slot holds a position or a resting order, or while any
/// book holds an active record of the seat, whichever slot or heap it sits in (the
/// check is on the seat, the more conservative and simpler rule). A refusal changes
/// nothing. A reset bumps the seat's `version` like any change to a seat.
pub fn reset_slot_generation(
    seat: &mut Seat,
    seat_index: u32,
    slot: usize,
    books: &[&TriggerBook<'_>],
) -> TriggerResult<()> {
    if !seat.slot_is_empty(slot) {
        return Err(TriggerError::SlotNotEmpty);
    }
    if books.iter().any(|book| book.holds_records_of(seat_index)) {
        return Err(TriggerError::RecordsRemain);
    }
    let mut generations = seat.generations();
    *generations
        .get_mut(slot)
        .ok_or(TriggerError::SlotNotEmpty)? = 0;
    let version = seat.version.checked_add(1).ok_or(TriggerError::Corrupt)?;
    seat.set_generations(generations);
    seat.version = version;
    Ok(())
}

//! Setting, cancelling and reconciling triggers.

use super::fire::{placement_at, smallest_order};
use super::heap::Transition;
use super::{
    DropReason, Kind, TriggerBook, TriggerError, TriggerRecord, TriggerResult, ACTIVE, BELOW, LONG,
    NO_HEAP, NO_POSITION, SWEEP_MAX_HEAP_CHANGES, WHOLE,
};
use crate::state::{MarketKind, MarketParams, Seat, Trader, GENERATION_MAX, MAX_PRICE};

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
    /// The receipt secret the trader drew for the order this record places, as in
    /// `NewOrder::secret`. Stored with the record, so every order it places carries it.
    pub secret: [u8; 16],
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

/// What one record of a seat is, as its owner may be told.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum RecordStatus {
    /// There is no record, or it no longer belongs to the seat's position.
    #[default]
    Gone,
    Armed,
    /// No order could carry the record's size now: at the current mark if the trigger is
    /// crossed, otherwise at the prices it was set with. It is tried again at
    /// `next_attempt`, unix seconds, which is zero when its last attempt was not one that
    /// found it unfillable.
    Unfillable {
        next_attempt: i64,
    },
    /// The last attempt to close was refused for want of margin that the seat's own
    /// resting orders hold. The orders stay; cancelling one lets the next attempt, at
    /// `next_attempt`, close the position.
    BlockedByRestingOrders {
        next_attempt: i64,
    },
}

/// The status of both records of one seat on one market.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SeatTriggerStatus {
    pub take_profit: RecordStatus,
    pub stop_loss: RecordStatus,
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
    /// Seats the call handled. Fewer than asked when the call reached its heap change
    /// limit, in which case the cursor rests on the first seat not handled.
    pub examined: u32,
    pub dropped: u32,
    /// Records that were in no heap and are queued again.
    pub requeued: u32,
}

/// Whether `record`, set on the position of `slot_owner`, still belongs to what `seat`
/// holds on `market`: returns the live position in lots, or why it does not.
/// RULES 12: a record is the same position only when owner, market, physical slot,
/// side, seat epoch and generation all match. A record whose generation is past
/// `GENERATION_MAX` is corrupt, which no seat could ever have written.
fn identity(
    slot_owner: &[u8; 32],
    record: &TriggerRecord,
    seat: &Seat,
    market: usize,
) -> TriggerResult<Result<u64, DropReason>> {
    if record.generation > GENERATION_MAX {
        return Err(TriggerError::Corrupt);
    }
    if !seat.is_open() || seat.owner != *slot_owner {
        return Ok(Err(DropReason::SeatGone));
    }
    let Some(at) = seat.slot_index(market) else {
        return Ok(Err(DropReason::Flat));
    };
    let base = seat.perp.get(at).map_or(0, |slot| slot.base);
    if base == 0 {
        return Ok(Err(DropReason::Flat));
    }
    let same_slot = usize::from(record.perp_slot) == at;
    let same_position =
        seat.seat_epoch() == record.seat_epoch && seat.generation(at) == record.generation;
    let same_side = (base > 0) == record.is_long();
    Ok(if same_slot && same_position && same_side {
        Ok(base.unsigned_abs())
    } else {
        Err(DropReason::Flip)
    })
}

/// Whether a fixed size of `lots` is too small to place an order at the trigger or the
/// worst price of a position of `live` lots. A whole-position record (`lots` zero) and a
/// size that is the whole live position, or more, are always fillable.
fn is_below_minimum(
    params: &MarketParams,
    trigger_price: u64,
    worst_price: u64,
    lots: u64,
    live: u64,
) -> TriggerResult<bool> {
    if lots == 0 || lots >= live {
        return Ok(false);
    }
    let at_trigger = smallest_order(params, trigger_price)?;
    let at_worst = smallest_order(params, worst_price)?;
    Ok(lots < at_trigger.max(at_worst))
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
            let standing = match identity(&owner, &record, seat, market)? {
                Err(reason) => {
                    self.transition(at, kind, Transition::Drop)?;
                    Standing::Dropped(reason)
                }
                Ok(position) if record.is_expired(now) => {
                    found.position = position;
                    self.transition(at, kind, Transition::Drop)?;
                    Standing::Dropped(DropReason::Expired)
                }
                Ok(position) => {
                    found.position = position;
                    if !record.is_whole() && record.size > position {
                        self.transition(at, kind, Transition::Shrink(position))?;
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

    /// What the seat's two records are at `now`, read from that seat's slot alone: the
    /// answer says nothing of any other seat. A record that is missing, or that
    /// `reconcile` would drop (its seat is closed or has another owner, or the position
    /// is flat, flipped or another one, or the record expired), is `Gone`. A live record
    /// is `Unfillable` when it could not place an order now, and `BlockedByRestingOrders`
    /// when its last attempt was refused for margin the seat's own resting orders hold
    /// and the mark has not left the trigger since (or is unknown). The next attempt
    /// clears the mark of either. `mark` is the market's `usable_mark`, or `None`. When
    /// it has crossed the record, that is the question a fire
    /// would ask at that mark: the worst price clipped around it, and the minimum order
    /// there. Otherwise it is the rule `set_trigger` applies, against the seat's live
    /// position. The record's durable fire flag does not decide the state, so a minimum
    /// lowered or a position shrunk to the record's size reads `Armed` at once; the flag
    /// only supplies `next_attempt`, zero when no attempt was made. A seat past the end
    /// of the book holds no record. Read-only: a dead record stays until a reconcile or a
    /// sweep drops it.
    pub fn status_of(
        &self,
        seat_index: u32,
        seat: &Seat,
        params: &MarketParams,
        mark: Option<u64>,
        now: i64,
    ) -> TriggerResult<SeatTriggerStatus> {
        let Ok(at) = self.slot_at(seat_index) else {
            return Ok(SeatTriggerStatus::default());
        };
        let market = self.market()?;
        let owner = self.slots.get(at).ok_or(TriggerError::Corrupt)?.owner;
        let status_of = |kind: Kind| -> TriggerResult<RecordStatus> {
            let record = self.seat_record(at, kind)?;
            if !record.is_active() || record.is_expired(now) {
                return Ok(RecordStatus::Gone);
            }
            let Ok(live) = identity(&owner, record, seat, market)? else {
                return Ok(RecordStatus::Gone);
            };
            let cannot_place = match mark.filter(|mark| record.is_crossed_by(*mark)) {
                Some(mark) => placement_at(params, record, live, mark)?.is_none(),
                None => is_below_minimum(
                    params,
                    record.trigger_price,
                    record.worst_price,
                    record.size,
                    live,
                )?,
            };
            let still_blocked =
                record.is_blocked() && mark.is_some_and(|mark| record.is_crossed_by(mark));
            Ok(if cannot_place {
                RecordStatus::Unfillable {
                    next_attempt: if record.is_unfillable() {
                        record.next_attempt
                    } else {
                        0
                    },
                }
            } else if still_blocked {
                RecordStatus::BlockedByRestingOrders {
                    next_attempt: record.next_attempt,
                }
            } else {
                RecordStatus::Armed
            })
        };
        Ok(SeatTriggerStatus {
            take_profit: status_of(Kind::TakeProfit)?,
            stop_loss: status_of(Kind::StopLoss)?,
        })
    }

    /// Drops every record of a seat, whatever it holds. A sweep and a fire pass call it
    /// for a seat that is past the end of the ledger. It needs no seat, and clearing an
    /// empty slot is not an error.
    pub fn clear_seat(&mut self, seat_index: u32) -> TriggerResult<()> {
        let at = self.slot_at(seat_index)?;
        for kind in Kind::BOTH {
            if self.seat_record(at, kind)?.is_active() {
                self.transition(at, kind, Transition::Drop)?;
            }
        }
        Ok(())
    }

    /// Sets, or replaces, the seat's take-profit or stop-loss on the position it holds.
    ///
    /// RULES 12c: `mark` is the market's `usable_mark` (healthy and fresh), the same test
    /// `fire_triggers` and the status read use. Setting is allowed while the market is
    /// paused, since a pause stops trading, not the trader's protection; firing is not,
    /// so a trigger set under a pause waits for the market to resume.
    ///
    /// Refused: a seat that is not open or not the trader's; a market that is not this
    /// book's perp; no usable mark; a seat with no position; a trigger or worst
    /// price that is zero, off the tick or above `MAX_PRICE`; a trigger the mark already
    /// satisfies, which would fire at once; a worst price on the wrong side of the
    /// trigger; a size of zero or beyond the position; an expiry in the past; and a pair
    /// whose take-profit and stop-loss would sit on the wrong sides of each other.
    ///
    /// The record is bound to the position's seat epoch, generation, side and slot. Dead
    /// records of the seat are dropped first.
    #[allow(clippy::too_many_arguments)]
    pub fn set_trigger(
        &mut self,
        trader: Trader<'_>,
        seat: &Seat,
        params: &MarketParams,
        mark: Option<u64>,
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
        let mark = mark
            .filter(|mark| *mark > 0)
            .ok_or(TriggerError::MarkNotFresh)?;
        let market = usize::from(params.market_id);
        let perp_slot = seat.slot_index(market).ok_or(TriggerError::NoPosition)?;
        let base = seat.perp.get(perp_slot).map_or(0, |position| position.base);
        if base == 0 {
            return Err(TriggerError::NoPosition);
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
        if is_below_minimum(params, input.trigger_price, input.worst_price, lots, live)? {
            return Err(TriggerError::SizeBelowMinimum);
        }
        if input.expiry < 0 || (input.expiry != 0 && input.expiry <= now) {
            return Err(TriggerError::InvalidExpiry);
        }

        let owner = self.slots.get(at).ok_or(TriggerError::Corrupt)?.owner;
        let sibling = *self.seat_record(at, input.kind.sibling())?;
        if sibling.is_active() && identity(&owner, &sibling, seat, market)?.is_ok() {
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
            self.transition(at, input.kind, Transition::Drop)?;
        }
        self.slots.get_mut(at).ok_or(TriggerError::Corrupt)?.owner = seat.owner;
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
        let record = TriggerRecord {
            trigger_price: input.trigger_price,
            worst_price: input.worst_price,
            size: lots,
            secret: input.secret,
            expiry: input.expiry,
            next_attempt: 0,
            record_version: 0,
            pos: NO_POSITION,
            flags,
            seat_epoch: seat.seat_epoch(),
            generation: seat.generation(perp_slot),
            perp_slot: u8::try_from(perp_slot).map_err(|_| TriggerError::Corrupt)?,
            heap: NO_HEAP,
            sequence: 0,
            padding: 0,
        };
        self.transition(at, input.kind, Transition::Arm { record, now })?;
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
            self.transition(at, kind, Transition::Drop)?;
        }
        Ok(active)
    }

    /// Reads up to `count` seats from the sweep cursor, wrapping at the ledger's seat
    /// count (`seats.len()`, never the book's larger capacity): every record is
    /// reconciled against its seat, and a record that is in no heap (taken by
    /// `due_triggers` and never settled) is queued again. A seat is handled whole, and
    /// the sweep stops before the next one once `count` seats have been read or
    /// `SWEEP_MAX_HEAP_CHANGES` heap changes have been made, whichever comes first. The
    /// cursor then rests on the first seat not handled, so the next call resumes there
    /// and a window full of dead records is finished over several calls, never one that
    /// runs out of compute and is undone. A sweep is housekeeping: a dead record never
    /// acts on a later position whether or not one runs, since `reconcile` refuses it
    /// and the pair (epoch, generation) never repeats.
    pub fn sweep(&mut self, seats: &[Seat], count: u32, now: i64) -> TriggerResult<SweepReport> {
        let reach =
            u32::try_from(seats.len().min(self.slots.len())).map_err(|_| TriggerError::Corrupt)?;
        let mut report = SweepReport::default();
        if reach == 0 {
            return Ok(report);
        }
        let steps = count.min(reach);
        let started_at = self.heap_changes();
        let mut cursor = self.header.sweep_cursor;
        if cursor >= reach {
            cursor = 0;
        }
        while report.examined < steps
            && self.heap_changes().saturating_sub(started_at) < SWEEP_MAX_HEAP_CHANGES
        {
            let at = usize::try_from(cursor).map_err(|_| TriggerError::Corrupt)?;
            let before = self.active_in(at)?;
            if before > 0 {
                let seat = seats.get(at).ok_or(TriggerError::Corrupt)?;
                self.reconcile(cursor, seat, now)?;
                let lost = before.saturating_sub(self.active_in(at)?);
                report.dropped = report
                    .dropped
                    .saturating_add(u32::try_from(lost).unwrap_or(0));
                for kind in Kind::BOTH {
                    let record = self.seat_record(at, kind)?;
                    if record.is_active() && record.heap == NO_HEAP {
                        self.transition(at, kind, Transition::Queue { now })?;
                        report.requeued = report.requeued.saturating_add(1);
                    }
                }
            }
            cursor = if cursor.saturating_add(1) >= reach {
                0
            } else {
                cursor.saturating_add(1)
            };
            report.examined = report.examined.saturating_add(1);
        }
        self.header.sweep_cursor = cursor;
        Ok(report)
    }
}

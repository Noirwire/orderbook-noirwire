//! Finding due triggers and firing them through `place_order`.

use super::heap::{entry_of, locate};
use super::{
    DropReason, Kind, Standing, TriggerBook, TriggerError, TriggerResult, ABOVE_HEAP, BELOW_HEAP,
    FAIR_WINDOW, NO_HEAP, TIME_HEAP, UNFILLABLE,
};
use crate::error::EngineError;
use crate::journal::Journal;
use crate::margin::is_fresh;
use crate::math::u64_from;
use crate::orders::{place_order, Fills, NewOrder, OrderType, PlaceOutcome};
use crate::seats::Env;
use crate::state::{
    LedgerMut, MarketKind, MarketMut, MarketParams, Seat, Side, Trader, ORACLE_HEALTHY,
    OUTER_BAND_BPS, STATUS_PAUSED,
};

/// The most records one pass takes off the heaps. The pass keeps a buffer of this many
/// references on the stack, so the number is part of the program's frame budget.
pub const MAX_FIRES_PER_PASS: usize = 4;

/// The most fills one fired order makes, whatever the exchange allows a market order.
/// What a partly filled trigger leaves is retried after the retry delay.
pub const TRIGGER_MAX_STEPS: u8 = 16;

/// One in this many records of a pass is kept for the seat cursor, not the deepest.
const FAIR_SHARE: usize = 4;

const BPS: u128 = 10_000;

/// A reference to a record that `due_triggers` took off the heaps. Everything else about
/// the record is read from the book again when it is used.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Due {
    pub seat: u32,
    pub kind: Kind,
    /// The record's version when it was taken. A use after the record changed is refused.
    pub record_version: u32,
    pub trigger_price: u64,
    /// The receipt secret the trader drew when the record was set: the secret of the
    /// order the record places, exactly as `place_order` uses the secret it is given.
    pub secret: [u8; 16],
}

impl Due {
    /// A value to fill a buffer with before `due_triggers` writes into it.
    pub const EMPTY: Due = Due {
        seat: 0,
        kind: Kind::TakeProfit,
        record_version: 0,
        trigger_price: 0,
        secret: [0; 16],
    };
}

/// The reduce-only market order a due record asks for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FirePlan {
    pub seat: u32,
    pub kind: Kind,
    /// The side that reduces the position.
    pub side: Side,
    /// Lots the record means to close: at most the live position.
    pub size: u64,
    /// What the order carries. Equal to `size`, except that when `size` is the whole
    /// live position it is raised to the market's minimum size and minimum notional,
    /// which the engine checks before it reads the position; the engine then caps the
    /// execution to the position. A part of a position is never raised, so an order
    /// never closes more than the record authorizes.
    pub order_size: u64,
    /// The record's worst price, pulled inside the bands around today's mark.
    pub worst_price: u64,
    /// The `client_id` the record was set with.
    pub client_id: u64,
}

impl FirePlan {
    pub fn new_order(&self, secret: [u8; 16]) -> NewOrder {
        NewOrder {
            side: self.side,
            order_type: OrderType::Market,
            price: self.worst_price,
            size: self.order_size,
            secret,
            reduce_only: true,
            expiry: 0,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FireDecision {
    Fire(FirePlan),
    /// The record no longer belongs to the position, or expired. It is gone.
    Dropped(DropReason),
    /// The record closes part of the position, and that part is below the market's
    /// minimum size or notional, so no order could carry it without closing more than
    /// the record authorizes. Nothing is placed and the record stays armed: it fires
    /// once the position has shrunk to its size, or the owner changes it.
    Unfillable,
    /// The reference is out of date: the record changed or is not outstanding.
    Stale,
    /// The mark no longer satisfies the record. It is queued again.
    NotDue,
}

/// What came of the order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FireOutcome {
    /// `place_order` accepted the order and filled this many lots, possibly none.
    Placed { filled: u64 },
    /// `place_order` refused it.
    Refused(EngineError),
    /// No order was placed: the plan was `Unfillable`.
    Skipped,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Settled {
    /// The record stays, to be tried again at this time.
    Rearmed {
        next_attempt: i64,
    },
    Dropped(DropReason),
    Stale,
}

/// An error the engine will give again for this record however long it waits.
fn is_permanent(error: EngineError) -> bool {
    matches!(
        error,
        EngineError::ReduceOnlyWouldIncrease
            | EngineError::NoPosition
            | EngineError::SeatNotOpen
            | EngineError::NotSeatOwner
            | EngineError::SeatOutOfRange
            | EngineError::ReservedSeat
            | EngineError::InvalidOrderFlags
            | EngineError::NotPerpMarket
    )
}

/// The worst price pulled inside the crossing band and the outer band around `mark`, on
/// a tick. Closing a long sells, so the floor rises toward the band; closing a short
/// buys, so the ceiling falls toward it. A price already inside is unchanged.
fn clip_worst(side: Side, worst: u64, mark: u64, band_bps: u16, tick: u64) -> TriggerResult<u64> {
    let bps = band_bps.min(OUTER_BAND_BPS);
    let reach = u128::from(mark)
        .checked_mul(u128::from(bps))
        .and_then(|scaled| scaled.checked_div(BPS))
        .ok_or(TriggerError::Corrupt)?;
    let reach = u64_from(reach)?;
    let clipped = match side {
        Side::Ask => {
            let lowest = mark.saturating_sub(reach);
            let on_tick = lowest
                .checked_next_multiple_of(tick)
                .ok_or(TriggerError::Corrupt)?;
            worst.max(on_tick)
        }
        Side::Bid => {
            let highest = mark.saturating_add(reach);
            let on_tick = highest
                .checked_sub(highest.checked_rem(tick).ok_or(TriggerError::Corrupt)?)
                .ok_or(TriggerError::Corrupt)?;
            worst.min(on_tick)
        }
    };
    if clipped == 0 {
        return Err(TriggerError::InvalidWorstPrice);
    }
    Ok(clipped)
}

/// The fewest lots an order at `price` may carry: the market's minimum size, raised to
/// the minimum notional at that price.
pub(super) fn smallest_order(params: &MarketParams, price: u64) -> TriggerResult<u64> {
    let price = u128::from(price);
    let for_notional = u128::from(params.min_notional)
        .checked_add(price.saturating_sub(1))
        .and_then(|rounded| rounded.checked_div(price))
        .ok_or(TriggerError::Corrupt)?;
    Ok(params.min_size.max(u64_from(for_notional)?))
}

impl TriggerBook<'_> {
    /// Takes up to `max` due records off the heaps into `out` and returns how many. A
    /// record is due when its heap's condition holds at `mark`. A quarter of `max` is
    /// kept for fairness: the rest goes deepest crossing first, ties by the order
    /// records entered, then by seat, and the quarter (plus whatever the deepest left
    /// over) goes to the crossed records found on the next `FAIR_WINDOW` seats from a
    /// cursor that moves round the book. So a crossed record is taken within
    /// `seat_capacity / FAIR_WINDOW` passes, plus the passes the crossed records ahead
    /// of it on the cursor need, however many deeper records keep arriving (given `max`
    /// of at least 4). At most `max` records waiting for a retry whose time has come go
    /// back to their price heap first, so a pass costs a bounded amount whatever is
    /// waiting; the rest follow on later passes. Expired records met on the way are
    /// dropped, and count against `max`.
    ///
    /// Nothing is due, and nothing changes, unless `mark_fresh`. A taken record stays set
    /// but is in no heap until `record_fire_outcome` puts it back, or a sweep finds it.
    pub fn due_triggers(
        &mut self,
        mark: u64,
        mark_fresh: bool,
        now: i64,
        max: usize,
        out: &mut [Due],
    ) -> TriggerResult<usize> {
        let limit = max.min(out.len());
        if !mark_fresh || mark == 0 || limit == 0 {
            return Ok(0);
        }
        let mut promoted = 0usize;
        while promoted < limit {
            let Some(entry) = self.root(TIME_HEAP)? else {
                break;
            };
            if self.entry_record(entry)?.next_attempt > now {
                break;
            }
            self.heap_remove(entry)?;
            let (seat, which) = locate(entry).ok_or(TriggerError::Corrupt)?;
            let kind = Kind::from_which(which).ok_or(TriggerError::Corrupt)?;
            self.queue(seat, kind, now)?;
            promoted = promoted.saturating_add(1);
        }
        let deep = limit.saturating_sub(limit.checked_div(FAIR_SHARE).unwrap_or(0));
        let mut written = 0usize;
        let mut examined = 0usize;
        while written < deep && examined < limit {
            let above = self.root_crossing(ABOVE_HEAP, mark)?;
            let below = self.root_crossing(BELOW_HEAP, mark)?;
            let entry = match (above, below) {
                (None, None) => break,
                (Some((entry, _)), None) | (None, Some((entry, _))) => entry,
                (Some((a, depth_a)), Some((b, depth_b))) => {
                    let first_a = depth_a.cmp(&depth_b).reverse().then_with(|| {
                        let sequence_a = self.entry_record(a).map(|r| r.sequence).unwrap_or(0);
                        let sequence_b = self.entry_record(b).map(|r| r.sequence).unwrap_or(0);
                        sequence_a.cmp(&sequence_b).then(a.cmp(&b))
                    });
                    if first_a.is_le() {
                        a
                    } else {
                        b
                    }
                }
            };
            self.heap_remove(entry)?;
            examined = examined.saturating_add(1);
            written = written.saturating_add(self.take(entry, now, out, written)?);
        }
        let seats = self.slots.len();
        let start = usize::try_from(self.header.fair_cursor).unwrap_or(0);
        let mut cursor = start.checked_rem(seats).unwrap_or(0);
        let mut read = 0usize;
        'seats: while read < FAIR_WINDOW.min(seats) {
            for kind in Kind::BOTH {
                let entry = entry_of(cursor, kind.which()).ok_or(TriggerError::Corrupt)?;
                let record = *self.seat_record(cursor, kind)?;
                let waiting_in_price_heap = matches!(
                    usize::from(record.heap).checked_sub(1),
                    Some(ABOVE_HEAP | BELOW_HEAP)
                );
                if !waiting_in_price_heap || !record.is_crossed_by(mark) {
                    continue;
                }
                if written >= limit {
                    break 'seats;
                }
                self.heap_remove(entry)?;
                written = written.saturating_add(self.take(entry, now, out, written)?);
            }
            cursor = cursor.saturating_add(1).checked_rem(seats).unwrap_or(0);
            read = read.saturating_add(1);
        }
        self.header.fair_cursor = u32::try_from(cursor).map_err(|_| TriggerError::Corrupt)?;
        Ok(written)
    }

    /// Writes the record at `entry`, which is in no heap, as the next due reference, or
    /// drops it when it has expired. Returns the number of references written.
    fn take(&mut self, entry: u32, now: i64, out: &mut [Due], at: usize) -> TriggerResult<usize> {
        let record = *self.entry_record(entry)?;
        let (seat, which) = locate(entry).ok_or(TriggerError::Corrupt)?;
        let kind = Kind::from_which(which).ok_or(TriggerError::Corrupt)?;
        if record.expiry != 0 && now > record.expiry {
            self.drop_record(seat, kind)?;
            return Ok(0);
        }
        let slot = out.get_mut(at).ok_or(TriggerError::Corrupt)?;
        *slot = Due {
            seat: u32::try_from(seat).map_err(|_| TriggerError::Corrupt)?,
            kind,
            record_version: record.record_version,
            trigger_price: record.trigger_price,
            secret: record.secret,
        };
        Ok(1)
    }

    fn outstanding_record(&self, due: &Due) -> TriggerResult<Option<super::TriggerRecord>> {
        let at = usize::try_from(due.seat).map_err(|_| TriggerError::SeatOutOfRange)?;
        let record = *self.seat_record(at, due.kind)?;
        let outstanding = record.is_active()
            && record.heap == NO_HEAP
            && record.record_version == due.record_version;
        Ok(outstanding.then_some(record))
    }

    /// Judges a due record against the seat as it is now and, if it still stands, says
    /// what to fire: reduce-only, on the side that shrinks the position, for at most the
    /// live position, at a worst price inside today's bands. A record that no longer
    /// belongs to the seat's position is dropped, and so is its sibling if that does not
    /// belong either.
    pub fn begin_fire(
        &mut self,
        due: &Due,
        seat: &Seat,
        params: &MarketParams,
        mark: u64,
        now: i64,
    ) -> TriggerResult<FireDecision> {
        if self.outstanding_record(due)?.is_none() {
            return Ok(FireDecision::Stale);
        }
        let found = self.reconcile(due.seat, seat, now)?;
        if let Standing::Dropped(reason) = found.of(due.kind) {
            return Ok(FireDecision::Dropped(reason));
        }
        let at = usize::try_from(due.seat).map_err(|_| TriggerError::SeatOutOfRange)?;
        let record = self.outstanding_record(due)?.ok_or(TriggerError::Corrupt)?;
        if !record.is_crossed_by(mark) {
            self.queue(at, due.kind, now)?;
            return Ok(FireDecision::NotDue);
        }
        let live = found.position;
        let size = if record.is_whole() {
            live
        } else {
            record.size.min(live)
        };
        let side = if record.is_long() {
            Side::Ask
        } else {
            Side::Bid
        };
        let worst = clip_worst(side, record.worst_price, mark, params.band_bps, params.tick)?;
        let order_size = size.max(smallest_order(params, worst)?);
        if order_size > size && size < live {
            return Ok(FireDecision::Unfillable);
        }
        Ok(FireDecision::Fire(FirePlan {
            seat: due.seat,
            kind: due.kind,
            side,
            size,
            order_size,
            worst_price: worst,
            client_id: record.client_id,
        }))
    }

    /// Settles a record that `begin_fire` told to fire, once the order has been placed.
    /// `seat_after` is the seat as the order left it.
    ///
    /// A fixed-size record counts what was filled off its own size and is spent at zero.
    /// Then the seat is reconciled: a position now flat drops both records (one cancels
    /// the other), and a smaller position shrinks fixed-size records to it. A record that
    /// stands again is re-armed, to be tried at `now + retry_delay`, whether the order
    /// filled part or none of its size, so a record that cannot fill never holds up the
    /// others. An error the engine would give again drops the record.
    pub fn record_fire_outcome(
        &mut self,
        due: &Due,
        outcome: FireOutcome,
        seat_after: &Seat,
        now: i64,
        retry_delay: i64,
    ) -> TriggerResult<Settled> {
        let Some(record) = self.outstanding_record(due)? else {
            return Ok(Settled::Stale);
        };
        let at = usize::try_from(due.seat).map_err(|_| TriggerError::SeatOutOfRange)?;
        let ended = match outcome {
            FireOutcome::Refused(error) if is_permanent(error) => Some(DropReason::Refused),
            FireOutcome::Placed { filled } if !record.is_whole() => {
                let remaining = record
                    .size
                    .checked_sub(filled)
                    .ok_or(TriggerError::FillExceedsSize)?;
                self.seat_record_mut(at, due.kind)?.size = remaining;
                (remaining == 0).then_some(DropReason::Spent)
            }
            _ => None,
        };
        if ended.is_some() {
            self.drop_record(at, due.kind)?;
        }
        let found = self.reconcile(due.seat, seat_after, now)?;
        if let Some(reason) = ended {
            return Ok(Settled::Dropped(reason));
        }
        if let Standing::Dropped(reason) = found.of(due.kind) {
            return Ok(Settled::Dropped(reason));
        }
        let next = now
            .checked_add(retry_delay.max(0))
            .ok_or(TriggerError::Corrupt)?;
        let live = self.seat_record_mut(at, due.kind)?;
        live.next_attempt = next;
        if matches!(outcome, FireOutcome::Skipped) {
            live.flags |= UNFILLABLE;
        } else {
            live.flags &= !UNFILLABLE;
        }
        live.record_version = live.record_version.wrapping_add(1);
        self.queue(at, due.kind, now)?;
        Ok(Settled::Rearmed { next_attempt: next })
    }
}

/// How a pass is run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FireRules {
    /// Records to take in one pass, at most `MAX_FIRES_PER_PASS`.
    pub max: usize,
    /// Seconds before a record that filled part or none of its order is tried again.
    pub retry_delay: i64,
}

/// Why a pass did nothing. None of these is an error: a scheduled caller must never see
/// a failure for a market that is paused or a mark that is old.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Idle {
    ExchangePaused,
    MarketPaused,
    /// The market's settings do not describe a perp, or its book is another market's.
    MarketUnusable,
    /// The trigger book is for another market.
    WrongBook,
    /// The source is dislocated or settling.
    OracleNotHealthy,
    /// The mark is missing, from the future, or older than the market's age limit.
    MarkNotFresh,
    /// The trigger book disagreed with itself. A sweep will mend what it can.
    BookCorrupt,
}

/// What a pass did, in totals only. It names no seat.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FirePass {
    pub idle: Option<Idle>,
    /// Records taken off the heaps.
    pub due: u32,
    /// Orders `place_order` accepted.
    pub placed: u32,
    /// Orders `place_order` refused with an error.
    pub refused: u32,
    pub filled_lots: u64,
    /// Records that close part of a position and fall below the market's minimum order;
    /// they wait, armed, and no order was placed for them.
    pub unfillable: u32,
    pub rearmed: u32,
    pub dropped: u32,
    /// Records the book could not settle; a sweep puts them back.
    pub failed: u32,
}

/// One pass of firing: takes the due records, and for each one places the reduce-only
/// market order its plan asks for through `place_order` and settles the result.
///
/// It never fails. A paused market, an unhealthy source or an old mark make the pass
/// idle; an error from one record's order, or from the book while handling it, is
/// counted and the next record goes on. Each order carries the secret the trader drew
/// when setting the record, and `after_each` sees the fills and outcome of each
/// accepted order so the caller can record the tape.
#[allow(clippy::too_many_arguments)]
pub fn fire_triggers<A>(
    book: &mut TriggerBook<'_>,
    ledger: &mut LedgerMut<'_>,
    market: &mut MarketMut<'_>,
    journal: &mut Journal<'_>,
    env: &Env<'_>,
    fills: &mut Fills,
    rules: &FireRules,
    mut after_each: A,
) -> FirePass
where
    A: FnMut(&Due, &Fills, &PlaceOutcome),
{
    let mut pass = FirePass::default();
    let idle = |pass: FirePass, why: Idle| FirePass {
        idle: Some(why),
        ..pass
    };
    if env.exchange_paused {
        return idle(pass, Idle::ExchangePaused);
    }
    if !matches!(market.checked_kind(), Ok(MarketKind::Perp)) {
        return idle(pass, Idle::MarketUnusable);
    }
    if market.params.status == STATUS_PAUSED {
        return idle(pass, Idle::MarketPaused);
    }
    if book.header.market_id != u32::from(market.params.market_id) {
        return idle(pass, Idle::WrongBook);
    }
    if market.params.oracle_health != ORACLE_HEALTHY {
        return idle(pass, Idle::OracleNotHealthy);
    }
    let mark = market.price.price;
    let fresh = mark > 0
        && is_fresh(
            market.price.publish_time,
            market.params.max_price_age,
            env.now,
        );
    if !fresh {
        return idle(pass, Idle::MarkNotFresh);
    }
    let mut taken = [Due::EMPTY; MAX_FIRES_PER_PASS];
    let count = match book.due_triggers(
        mark,
        true,
        env.now,
        rules.max.min(MAX_FIRES_PER_PASS),
        &mut taken,
    ) {
        Ok(count) => count,
        Err(_) => return idle(pass, Idle::BookCorrupt),
    };
    pass.due = u32::try_from(count).unwrap_or(u32::MAX);
    for due in taken.iter().take(count) {
        let seat = usize::try_from(due.seat)
            .ok()
            .and_then(|at| ledger.seats.get(at))
            .copied();
        let Some(seat) = seat else {
            if book.clear_seat(due.seat).is_err() {
                pass.failed = pass.failed.saturating_add(1);
            }
            pass.dropped = pass.dropped.saturating_add(1);
            continue;
        };
        let params = *market.params;
        let outcome = match book.begin_fire(due, &seat, &params, mark, env.now) {
            Ok(FireDecision::Fire(plan)) => {
                let owner = seat.owner;
                let order = plan.new_order(due.secret);
                let trader = Trader {
                    seat: due.seat,
                    owner: &owner,
                };
                match place_order(ledger, market, journal, env, trader, &order, fills) {
                    Ok(placed) => {
                        pass.placed = pass.placed.saturating_add(1);
                        pass.filled_lots = pass.filled_lots.saturating_add(placed.filled);
                        after_each(due, fills, &placed);
                        FireOutcome::Placed {
                            filled: placed.filled,
                        }
                    }
                    Err(error) => {
                        pass.refused = pass.refused.saturating_add(1);
                        FireOutcome::Refused(error)
                    }
                }
            }
            Ok(FireDecision::Unfillable) => {
                pass.unfillable = pass.unfillable.saturating_add(1);
                FireOutcome::Skipped
            }
            Ok(FireDecision::Dropped(_)) => {
                pass.dropped = pass.dropped.saturating_add(1);
                continue;
            }
            Ok(FireDecision::Stale | FireDecision::NotDue) => continue,
            Err(_) => {
                pass.failed = pass.failed.saturating_add(1);
                continue;
            }
        };
        let after = usize::try_from(due.seat)
            .ok()
            .and_then(|at| ledger.seats.get(at))
            .copied()
            .unwrap_or(seat);
        match book.record_fire_outcome(due, outcome, &after, env.now, rules.retry_delay) {
            Ok(Settled::Rearmed { .. }) => pass.rearmed = pass.rearmed.saturating_add(1),
            Ok(Settled::Dropped(_)) => pass.dropped = pass.dropped.saturating_add(1),
            Ok(Settled::Stale) => {}
            Err(_) => pass.failed = pass.failed.saturating_add(1),
        }
    }
    pass
}

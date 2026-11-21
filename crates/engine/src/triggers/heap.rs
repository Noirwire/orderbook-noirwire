//! The three heaps of a trigger book.
//!
//! A heap entry is `seat * 4 + which`, where `which` is 0 for the take-profit record and
//! 1 for the stop-loss record of that seat. Every record keeps its heap and its position
//! in it, so a record leaves a heap without a search. The root of the above heap has the
//! lowest price, the root of the below heap the highest, the root of the time heap the
//! earliest next attempt; equal keys leave in the order they entered, then by entry.

use core::cmp::Ordering;

use super::{
    Kind, TriggerBook, TriggerError, TriggerRecord, TriggerResult, TriggerSlot, ABOVE_HEAP, ACTIVE,
    BELOW_HEAP, BLOCKED, HEAPS, NO_HEAP, NO_POSITION, TIME_HEAP, UNFILLABLE,
};
use crate::state::GENERATION_MAX;

/// A change to one record. Every change to a record's flags, heap or retry time is one of
/// these, applied by `TriggerBook::transition`, the only caller of the heap's insert and
/// remove, so the three cannot disagree: a record waits in the time heap exactly while
/// its `next_attempt` is ahead of `now`, and is in no heap exactly while it is dropped or
/// outstanding with a fire pass.
#[derive(Clone, Copy, Debug)]
pub(super) enum Transition {
    /// A new record on a seat that has none of this kind: queued at once.
    Arm { record: TriggerRecord, now: i64 },
    /// The record leaves its heap and stays set, handed to a fire attempt.
    Take,
    /// An outstanding record goes back into the heap its state names.
    Queue { now: i64 },
    /// An attempt is settled and the record stays set: it waits for `next_attempt`, with
    /// the reason its last attempt placed nothing, if it did not.
    Wait {
        next_attempt: i64,
        unfillable: bool,
        blocked: bool,
        now: i64,
    },
    /// A fixed size follows the position down to `size` lots.
    Shrink(u64),
    /// The record is cleared and its heap place freed.
    Drop,
}

/// The entry for a record, or `None` when the seat index does not fit.
pub(super) fn entry_of(seat: usize, which: usize) -> Option<u32> {
    u32::try_from(seat)
        .ok()?
        .checked_mul(4)?
        .checked_add(u32::try_from(which).ok()?)
}

/// The seat index and record number an entry names.
pub(super) fn locate(entry: u32) -> Option<(usize, usize)> {
    let seat = usize::try_from(entry.checked_div(4)?).ok()?;
    let which = usize::try_from(entry.checked_rem(4)?).ok()?;
    Some((seat, which))
}

fn record_of(slots: &[TriggerSlot], entry: u32) -> Option<&TriggerRecord> {
    let (seat, which) = locate(entry)?;
    slots.get(seat)?.record(which)
}

fn record_of_mut(slots: &mut [TriggerSlot], entry: u32) -> Option<&mut TriggerRecord> {
    let (seat, which) = locate(entry)?;
    slots.get_mut(seat)?.record_mut(which)
}

/// True when entry `a` belongs nearer the root of `heap` than entry `b`.
fn before(slots: &[TriggerSlot], heap: usize, a: u32, b: u32) -> Option<bool> {
    let left = record_of(slots, a)?;
    let right = record_of(slots, b)?;
    let by_key = match heap {
        ABOVE_HEAP => left.trigger_price.cmp(&right.trigger_price),
        BELOW_HEAP => right.trigger_price.cmp(&left.trigger_price),
        _ => left.next_attempt.cmp(&right.next_attempt),
    };
    let order = by_key
        .then(left.sequence.cmp(&right.sequence))
        .then(a.cmp(&b));
    Some(order == Ordering::Less)
}

fn place(slots: &mut [TriggerSlot], words: &mut [u32], at: usize, entry: u32) -> Option<()> {
    *words.get_mut(at)? = entry;
    record_of_mut(slots, entry)?.pos = u32::try_from(at).ok()?;
    Some(())
}

fn sift_up(
    slots: &mut [TriggerSlot],
    words: &mut [u32],
    heap: usize,
    start: usize,
    entry: u32,
) -> Option<()> {
    let mut at = start;
    while at > 0 {
        let parent = at.checked_sub(1)?.checked_div(2)?;
        let above = *words.get(parent)?;
        if !before(slots, heap, entry, above)? {
            break;
        }
        place(slots, words, at, above)?;
        at = parent;
    }
    place(slots, words, at, entry)
}

fn sift_down(
    slots: &mut [TriggerSlot],
    words: &mut [u32],
    heap: usize,
    len: usize,
    start: usize,
    entry: u32,
) -> Option<()> {
    let mut at = start;
    loop {
        let left = at.checked_mul(2)?.checked_add(1)?;
        if left >= len {
            break;
        }
        let right = left.checked_add(1)?;
        let left_entry = *words.get(left)?;
        let child = match words.get(right) {
            Some(right_entry) if right < len && before(slots, heap, *right_entry, left_entry)? => {
                right
            }
            _ => left,
        };
        let child_entry = *words.get(child)?;
        if !before(slots, heap, child_entry, entry)? {
            break;
        }
        place(slots, words, at, child_entry)?;
        at = child;
    }
    place(slots, words, at, entry)
}

impl TriggerBook<'_> {
    pub(super) fn entry_record(&self, entry: u32) -> TriggerResult<&TriggerRecord> {
        record_of(self.slots, entry).ok_or(TriggerError::Corrupt)
    }

    pub(super) fn entry_record_mut(&mut self, entry: u32) -> TriggerResult<&mut TriggerRecord> {
        record_of_mut(self.slots, entry).ok_or(TriggerError::Corrupt)
    }

    /// The entry at the root of `heap`, if any. A root whose record is not set, or does
    /// not say it is the root of this heap, is `Corrupt`.
    pub(super) fn root(&self, heap: usize) -> TriggerResult<Option<u32>> {
        if self.heap_len(heap) == 0 {
            return Ok(None);
        }
        let words = self.heaps.get(heap).ok_or(TriggerError::Corrupt)?;
        let entry = *words.first().ok_or(TriggerError::Corrupt)?;
        let record = self.entry_record(entry)?;
        let tagged = usize::from(record.heap).checked_sub(1);
        if !record.is_active() || tagged != Some(heap) || record.pos != 0 {
            return Err(TriggerError::Corrupt);
        }
        Ok(Some(entry))
    }

    /// Applies `change` to the seat's record of `kind`. A change the record's state does
    /// not allow (arming over a set record, taking or queueing one that is not in the
    /// right place) is `Corrupt`, and leaves the record as it was.
    pub(super) fn transition(
        &mut self,
        seat: usize,
        kind: Kind,
        change: Transition,
    ) -> TriggerResult<()> {
        let entry = entry_of(seat, kind.which()).ok_or(TriggerError::Corrupt)?;
        let record = *self.entry_record(entry)?;
        match change {
            Transition::Arm { record: new, now } => {
                if record.is_active() || record.heap != NO_HEAP {
                    return Err(TriggerError::Corrupt);
                }
                *self.entry_record_mut(entry)? = TriggerRecord {
                    flags: new.flags | ACTIVE,
                    next_attempt: 0,
                    record_version: record.record_version.wrapping_add(1),
                    pos: NO_POSITION,
                    heap: NO_HEAP,
                    sequence: 0,
                    padding: 0,
                    ..new
                };
                self.queue(seat, kind, now)
            }
            Transition::Take => {
                if !record.is_active() || record.heap == NO_HEAP {
                    return Err(TriggerError::Corrupt);
                }
                self.heap_remove(entry)
            }
            Transition::Queue { now } => {
                if !record.is_active() {
                    return Err(TriggerError::Corrupt);
                }
                self.queue(seat, kind, now)
            }
            Transition::Wait {
                next_attempt,
                unfillable,
                blocked,
                now,
            } => {
                if !record.is_active() || record.heap != NO_HEAP {
                    return Err(TriggerError::Corrupt);
                }
                let live = self.entry_record_mut(entry)?;
                live.next_attempt = next_attempt;
                live.flags &= !(UNFILLABLE | BLOCKED);
                if unfillable {
                    live.flags |= UNFILLABLE;
                }
                if blocked {
                    live.flags |= BLOCKED;
                }
                live.record_version = live.record_version.wrapping_add(1);
                self.queue(seat, kind, now)
            }
            Transition::Shrink(size) => {
                if !record.is_active() {
                    return Err(TriggerError::Corrupt);
                }
                let live = self.entry_record_mut(entry)?;
                live.size = size;
                live.flags &= !UNFILLABLE;
                Ok(())
            }
            Transition::Drop => {
                self.heap_remove(entry)?;
                *self.entry_record_mut(entry)? = TriggerRecord {
                    record_version: record.record_version.wrapping_add(1),
                    pos: NO_POSITION,
                    ..bytemuck::Zeroable::zeroed()
                };
                let slot = self.slots.get_mut(seat).ok_or(TriggerError::Corrupt)?;
                if slot.active_count() == 0 {
                    slot.owner = [0; 32];
                }
                Ok(())
            }
        }
    }

    /// Takes the record out of whatever heap it is in, if any.
    fn heap_remove(&mut self, entry: u32) -> TriggerResult<()> {
        let record = *self.entry_record(entry)?;
        let Some(heap) = usize::from(record.heap).checked_sub(1) else {
            return Ok(());
        };
        if heap >= HEAPS {
            return Err(TriggerError::Corrupt);
        }
        let at = usize::try_from(record.pos).map_err(|_| TriggerError::Corrupt)?;
        let len = self
            .heap_len(heap)
            .checked_sub(1)
            .ok_or(TriggerError::Corrupt)?;
        let words = self.heaps.get_mut(heap).ok_or(TriggerError::Corrupt)?;
        if words.get(at) != Some(&entry) {
            return Err(TriggerError::Corrupt);
        }
        let shrunk = u32::try_from(len).map_err(|_| TriggerError::Corrupt)?;
        *self
            .header
            .heap_len
            .get_mut(heap)
            .ok_or(TriggerError::Corrupt)? = shrunk;
        self.heap_changes = self.heap_changes.saturating_add(1);
        {
            let removed = self.entry_record_mut(entry)?;
            removed.heap = NO_HEAP;
            removed.pos = NO_POSITION;
        }
        if at == len {
            return Ok(());
        }
        let words = self.heaps.get_mut(heap).ok_or(TriggerError::Corrupt)?;
        let last = *words.get(len).ok_or(TriggerError::Corrupt)?;
        let parent_wins = match at.checked_sub(1).and_then(|up| up.checked_div(2)) {
            Some(parent) if at > 0 => {
                let above = *words.get(parent).ok_or(TriggerError::Corrupt)?;
                before(self.slots, heap, last, above).ok_or(TriggerError::Corrupt)?
            }
            _ => false,
        };
        let moved = if parent_wins {
            sift_up(self.slots, words, heap, at, last)
        } else {
            sift_down(self.slots, words, heap, len, at, last)
        };
        moved.ok_or(TriggerError::Corrupt)
    }

    /// Whether the entry's record would fire at `mark`, read at the root of a price heap.
    pub(super) fn root_crossing(
        &self,
        heap: usize,
        mark: u64,
    ) -> TriggerResult<Option<(u32, u64)>> {
        let Some(entry) = self.root(heap)? else {
            return Ok(None);
        };
        let record = self.entry_record(entry)?;
        if record.is_crossed_by(mark) {
            Ok(Some((entry, mark.abs_diff(record.trigger_price))))
        } else {
            Ok(None)
        }
    }

    /// True when every heap is ordered against its parents, every entry and every
    /// record agree on place and heap, and every active record is in a heap or
    /// outstanding (removed by `due_triggers` and not yet settled). Used by tests and by
    /// the program's checks.
    pub fn check_invariants(&self) -> TriggerResult<()> {
        let mut queued = 0usize;
        for heap in 0..HEAPS {
            let words = self.heaps.get(heap).ok_or(TriggerError::Corrupt)?;
            let len = self.heap_len(heap);
            if len > words.len() {
                return Err(TriggerError::Corrupt);
            }
            for at in 0..len {
                let entry = *words.get(at).ok_or(TriggerError::Corrupt)?;
                let record = self.entry_record(entry)?;
                let tagged = usize::from(record.heap).checked_sub(1);
                let pointed = usize::try_from(record.pos).ok();
                if !record.is_active() || tagged != Some(heap) || pointed != Some(at) {
                    return Err(TriggerError::Corrupt);
                }
                if heap == TIME_HEAP && record.next_attempt == 0 {
                    return Err(TriggerError::Corrupt);
                }
                if let Some(parent) = at.checked_sub(1).and_then(|up| up.checked_div(2)) {
                    if at > 0 {
                        let above = *words.get(parent).ok_or(TriggerError::Corrupt)?;
                        let wrong =
                            before(self.slots, heap, entry, above).ok_or(TriggerError::Corrupt)?;
                        if wrong {
                            return Err(TriggerError::Corrupt);
                        }
                    }
                }
                queued = queued.checked_add(1).ok_or(TriggerError::Corrupt)?;
            }
        }
        let records = || {
            self.slots
                .iter()
                .flat_map(|slot| [&slot.take_profit, &slot.stop_loss])
        };
        if records().any(|record| record.generation > GENERATION_MAX) {
            return Err(TriggerError::Corrupt);
        }
        let tagged = records().filter(|record| record.heap != NO_HEAP).count();
        if tagged == queued {
            Ok(())
        } else {
            Err(TriggerError::Corrupt)
        }
    }

    /// Queues a set record that is in no heap, under a fresh sequence number: in the time
    /// heap while it waits for `next_attempt`, otherwise in the price heap its direction
    /// names.
    fn queue(&mut self, seat: usize, kind: Kind, now: i64) -> TriggerResult<()> {
        let entry = entry_of(seat, kind.which()).ok_or(TriggerError::Corrupt)?;
        let record = *self.entry_record(entry)?;
        let heap = if record.next_attempt > now {
            TIME_HEAP
        } else if record.fires_below() {
            BELOW_HEAP
        } else {
            ABOVE_HEAP
        };
        let len = self.heap_len(heap);
        let room = self.heaps.get(heap).map_or(0, |words| words.len());
        if record.heap != NO_HEAP || len >= room {
            return Err(TriggerError::Corrupt);
        }
        let sequence = self.header.next_sequence;
        self.header.next_sequence = sequence.wrapping_add(1);
        let tag = u8::try_from(heap.checked_add(1).ok_or(TriggerError::Corrupt)?)
            .map_err(|_| TriggerError::Corrupt)?;
        let queued = self.entry_record_mut(entry)?;
        queued.sequence = sequence;
        queued.heap = tag;
        let grown = u32::try_from(len.checked_add(1).ok_or(TriggerError::Corrupt)?)
            .map_err(|_| TriggerError::Corrupt)?;
        *self
            .header
            .heap_len
            .get_mut(heap)
            .ok_or(TriggerError::Corrupt)? = grown;
        self.heap_changes = self.heap_changes.saturating_add(1);
        let words = self.heaps.get_mut(heap).ok_or(TriggerError::Corrupt)?;
        sift_up(self.slots, words, heap, len, entry).ok_or(TriggerError::Corrupt)
    }

    /// Heap changes made since the book was opened.
    pub(super) fn heap_changes(&self) -> u32 {
        self.heap_changes
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    extern crate std;

    use std::vec;

    use super::*;
    use crate::triggers::{book_len, BELOW};

    fn with_book(f: impl FnOnce(&mut TriggerBook<'_>)) {
        let words = book_len(4).unwrap().div_ceil(8);
        let mut storage = vec![0u64; words];
        let bytes: &mut [u8] = bytemuck::cast_slice_mut(&mut storage);
        TriggerBook::init(bytes, 0, 4).unwrap();
        f(&mut TriggerBook::open(bytes).unwrap());
    }

    fn armed() -> Transition {
        Transition::Arm {
            record: TriggerRecord {
                flags: BELOW,
                trigger_price: 900,
                ..bytemuck::Zeroable::zeroed()
            },
            now: 100,
        }
    }

    #[test]
    fn taking_a_record_that_is_in_no_heap_is_corrupt() {
        with_book(|book| {
            book.transition(1, Kind::StopLoss, armed()).unwrap();
            assert_eq!(book.transition(1, Kind::StopLoss, Transition::Take), Ok(()));
            assert_eq!(
                book.transition(1, Kind::StopLoss, Transition::Take),
                Err(TriggerError::Corrupt)
            );
            assert_eq!(
                book.transition(1, Kind::TakeProfit, Transition::Take),
                Err(TriggerError::Corrupt),
                "a record that was never set"
            );
        });
    }

    #[test]
    fn a_shrink_clears_the_unfillable_flag_and_keeps_the_blocked_one() {
        with_book(|book| {
            book.transition(1, Kind::StopLoss, armed()).unwrap();
            book.transition(1, Kind::StopLoss, Transition::Take)
                .unwrap();
            let wait = Transition::Wait {
                next_attempt: 200,
                unfillable: true,
                blocked: true,
                now: 100,
            };
            book.transition(1, Kind::StopLoss, wait).unwrap();
            book.transition(1, Kind::StopLoss, Transition::Shrink(5))
                .unwrap();
            let record = *book
                .entry_record(entry_of(1, Kind::StopLoss.which()).unwrap())
                .unwrap();
            assert_eq!(record.size, 5);
            assert_eq!(record.flags & UNFILLABLE, 0);
            assert_eq!(record.flags & BLOCKED, BLOCKED);
        });
    }
}

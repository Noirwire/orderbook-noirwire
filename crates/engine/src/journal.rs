use bytemuck::{Pod, Zeroable};
use core::mem::size_of;

use crate::error::{EngineError, EngineResult};
use crate::math::{increment, index};
use crate::state::Seat;

/// The bytes of one seat as they were before the current call first touched it.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Pod, Zeroable)]
pub struct JournalEntry {
    pub seat: Seat,
    pub index: u32,
    pub _padding: u32,
}

const _: () = assert!(size_of::<JournalEntry>() == 456);

/// Entries one `liquidate` can need: target, liquidator, insurance seat.
pub const LIQUIDATION_JOURNAL_ENTRIES: usize = 3;
/// Entries one `place_order` can need beyond one per step: taker, fee seat and
/// insurance seat.
pub const PLACE_JOURNAL_EXTRA_ENTRIES: usize = 3;

/// Scratch space lent by the caller so that a call touching several seats can be undone
/// (RULES 13.2). `place_order` needs `max_steps + 3` entries, `liquidate` needs 3.
/// Nothing in it survives a call.
pub struct Journal<'a> {
    entries: &'a mut [JournalEntry],
    len: usize,
}

impl<'a> Journal<'a> {
    pub fn new(entries: &'a mut [JournalEntry]) -> Self {
        Journal { entries, len: 0 }
    }

    pub(crate) fn begin(&mut self) {
        self.len = 0;
    }

    /// Checked before anything is read, so that running out of entries can never
    /// depend on how many makers an order happens to meet (RULES 3).
    pub(crate) fn require_capacity(&self, entries: usize) -> EngineResult<()> {
        if self.entries.len() >= entries {
            Ok(())
        } else {
            Err(EngineError::JournalFull)
        }
    }

    fn remember(&mut self, seat_index: u32, seat: &Seat) -> EngineResult<()> {
        let recorded = self
            .entries
            .iter()
            .take(self.len)
            .any(|entry| entry.index == seat_index);
        if recorded {
            return Ok(());
        }
        let entry = self
            .entries
            .get_mut(self.len)
            .ok_or(EngineError::JournalFull)?;
        *entry = JournalEntry {
            seat: *seat,
            index: seat_index,
            _padding: 0,
        };
        self.len = self.len.checked_add(1).ok_or(EngineError::MathOverflow)?;
        Ok(())
    }

    pub(crate) fn rollback(&mut self, seats: &mut [Seat]) {
        for entry in self.entries.iter().take(self.len) {
            let slot = usize::try_from(entry.index)
                .ok()
                .and_then(|i| seats.get_mut(i));
            if let Some(seat) = slot {
                *seat = entry.seat;
            }
        }
        self.len = 0;
    }

    fn bump_versions(&self, seats: &mut [Seat]) -> EngineResult<()> {
        for entry in self.entries.iter().take(self.len) {
            let seat = seats
                .get_mut(index(entry.index)?)
                .ok_or(EngineError::InvariantBroken)?;
            if *seat != entry.seat {
                seat.version = increment(entry.seat.version)?;
            }
        }
        Ok(())
    }

    /// RULES 13.2: a refused call restores every seat it touched, byte for byte.
    pub(crate) fn conclude<T>(
        &mut self,
        seats: &mut [Seat],
        planned: EngineResult<T>,
    ) -> EngineResult<T> {
        let outcome = planned.and_then(|plan| self.bump_versions(seats).map(|()| plan));
        if outcome.is_err() {
            self.rollback(seats);
        }
        self.len = 0;
        outcome
    }
}

/// Seats plus the journal that records each one before it is first changed.
pub(crate) struct Tx<'s, 'j, 'e> {
    pub(crate) seats: &'s mut [Seat],
    pub(crate) journal: &'j mut Journal<'e>,
}

impl Tx<'_, '_, '_> {
    pub(crate) fn seat(&self, seat_index: u32) -> EngineResult<&Seat> {
        let seat = self
            .seats
            .get(index(seat_index)?)
            .ok_or(EngineError::SeatOutOfRange)?;
        if seat.is_open() {
            Ok(seat)
        } else {
            Err(EngineError::SeatNotOpen)
        }
    }

    pub(crate) fn seat_mut(&mut self, seat_index: u32) -> EngineResult<&mut Seat> {
        let seat = self
            .seats
            .get_mut(index(seat_index)?)
            .ok_or(EngineError::SeatOutOfRange)?;
        if !seat.is_open() {
            return Err(EngineError::SeatNotOpen);
        }
        self.journal.remember(seat_index, seat)?;
        Ok(seat)
    }
}

/// Single-seat calls work on a copy and write it back only on success.
pub(crate) fn commit_seat(stored: &mut Seat, mut working: Seat) -> EngineResult<()> {
    if working != *stored {
        working.version = increment(stored.version)?;
        *stored = working;
    }
    Ok(())
}

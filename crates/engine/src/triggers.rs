//! Sealed take-profit and stop-loss triggers.
//!
//! A trigger belongs to one position of one seat on one market. It is stored in a
//! `TriggerBook`: one fixed slot per seat, three heaps of references to the slots'
//! records, and a header. The heaps answer "which record is due" without scanning the
//! seats, and every record knows its place in its heap, so a record leaves one without a
//! search.
//!
//! Identity. A record stores the seat's owner (in its slot), the position slot of the
//! market, the position generation (`Seat::generation`) and the side of the position
//! when it was set. `reconcile` drops a record whose seat is gone, whose owner changed,
//! whose position ended or flipped, or whose generation moved, so a trigger set for one
//! position never acts on a later one. The engine bumps the generation inside
//! `apply_trade`, the only writer of a position, so every path that changes a position,
//! including a maker filled in someone else's order and a liquidation, is covered
//! without the trigger account being present. The generation is one byte and stops at
//! `GENERATION_RETIRED` instead of wrapping, and `set_trigger` refuses a slot that holds
//! it, so no record can ever see its generation again on a later position, whatever
//! the schedule of sweeps.
//!
//! Size. A fixed-size record only ever shrinks, to the live position. A whole-position
//! record follows the position up and down. The order a record places is reduce-only,
//! so the engine's own cap on the live position applies as well. An order is never made
//! larger than the record's remaining size to meet a market minimum, except when that
//! size is the whole live position; a record below the minimum waits armed
//! (`FireDecision::Unfillable`).
//!
//! Firing. `due_triggers` takes due records off the heaps, deepest crossing first, at
//! most a fixed number per pass, and only on a fresh mark. A share of every pass goes
//! to a cursor over the seats instead (`FAIR_WINDOW` seats a pass), so a record that
//! stays crossed is taken within `seat_capacity / FAIR_WINDOW` passes, plus one pass for
//! every `limit / 4` crossed records the cursor meets before it. `fire_triggers` places one reduce-only market order per due
//! record through `place_order` and settles it with `record_fire_outcome`: a partial
//! fill re-arms the rest after a delay, a fill of nothing waits out the delay in the
//! time heap, and a record whose order errors is dropped or retried on its own, never
//! failing the others.
//!
//! Layout, for a seat capacity `n`: a 40 byte header, `192 * n` bytes of slots, then
//! the heaps of `4 * n`, `4 * n` and `8 * n` bytes. The account must be zeroed when it
//! is created and aligned to 8 bytes.

mod fire;
mod heap;
mod rules;

use core::cell::Cell;

use bytemuck::{Pod, Zeroable};

use crate::error::EngineError;

pub use fire::{
    fire_triggers, Due, FireDecision, FireOutcome, FirePass, FirePlan, FireRules, Idle, Settled,
    MAX_FIRES_PER_PASS, TRIGGER_MAX_STEPS,
};
pub use rules::{
    reset_slot_generation, Reconciled, SetOutcome, Standing, SweepReport, TriggerInput, TriggerSize,
};

/// The layout version a book is created with.
pub const TRIGGER_BOOK_VERSION: u32 = 1;

pub const HEADER_LEN: usize = 40;
pub const SLOT_LEN: usize = 192;

/// Seats the fairness cursor reads in one pass of `due_triggers`.
pub const FAIR_WINDOW: usize = 64;

/// Heap indices. The above heap holds records that fire when the mark is at or above
/// their price, the below heap those that fire at or below it, and the time heap
/// records waiting for their next attempt.
pub const ABOVE_HEAP: usize = 0;
pub const BELOW_HEAP: usize = 1;
pub const TIME_HEAP: usize = 2;
const HEAPS: usize = 3;

/// Entries the time heap reserves per seat: the two records.
const TIME_ENTRIES_PER_SEAT: usize = 2;

/// A back-pointer value for a record that is in no heap.
const NO_POSITION: u32 = u32::MAX;

/// `TriggerRecord::flags`.
const ACTIVE: u8 = 1;
/// The record fires when the mark is at or below its price.
const BELOW: u8 = 2;
/// The record's size is the whole position.
const WHOLE: u8 = 4;
/// The position was long when the record was set, so the record closes by selling.
const LONG: u8 = 8;
/// The record's last attempt placed nothing, because its remaining size is below the
/// market's minimum order while more position stands behind it. Cleared by the next
/// attempt that places an order, and when the position shrinks to the record's size.
const UNFILLABLE: u8 = 16;

/// `TriggerRecord::heap`: zero is in no heap, otherwise the heap index plus one.
const NO_HEAP: u8 = 0;

/// The two records of a seat.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    TakeProfit,
    StopLoss,
}

impl Kind {
    const BOTH: [Kind; 2] = [Kind::TakeProfit, Kind::StopLoss];

    const fn sibling(self) -> Kind {
        match self {
            Kind::TakeProfit => Kind::StopLoss,
            Kind::StopLoss => Kind::TakeProfit,
        }
    }

    const fn which(self) -> usize {
        match self {
            Kind::TakeProfit => 0,
            Kind::StopLoss => 1,
        }
    }

    fn from_which(which: usize) -> Option<Kind> {
        match which {
            0 => Some(Kind::TakeProfit),
            1 => Some(Kind::StopLoss),
            _ => None,
        }
    }
}

/// Why a record left the book.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DropReason {
    /// The position is gone.
    Flat,
    /// The position changed side, or the seat's generation moved: a different position.
    Flip,
    /// The seat is closed or belongs to another owner.
    SeatGone,
    Expired,
    /// A fixed-size record whose whole size has been executed.
    Spent,
    /// The engine refused the order for a reason that cannot get better.
    Refused,
}

/// Every way a trigger call is refused. A refusal changes nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TriggerError {
    /// The bytes are too short, misaligned, or not a book of this version, or the seat
    /// capacity asked for does not fit them.
    BadLayout,
    /// A heap, a back-pointer or a record disagrees with the rest of the book, or a sum
    /// overflowed.
    Corrupt,
    SeatOutOfRange,
    SeatNotOpen,
    NotSeatOwner,
    NotPerpMarket,
    MarketMismatch,
    /// The seat holds no position on the market.
    NoPosition,
    /// The seat's slot for the market has ended `GENERATION_RETIRED` positions, so a
    /// trigger on it could not be told from one on a later position.
    SlotRetired,
    /// A fixed size that is below the market's minimum order (size, or notional at the
    /// trigger or worst price) while more position stands behind it: no order could
    /// ever carry it without closing more than it authorizes.
    SizeBelowMinimum,
    /// A reported fill is larger than the lots the record has left.
    FillExceedsSize,
    /// The slot to reset holds a position or resting orders, or is out of range.
    SlotNotEmpty,
    /// A trigger book still holds an active record of the seat.
    RecordsRemain,
    /// The mark is not fresh, so "would this fire now" cannot be answered.
    MarkNotFresh,
    /// A trigger or worst price that is zero, off the tick or above `MAX_PRICE`.
    InvalidPrice,
    /// The condition already holds at the current mark: it would fire at once.
    WouldFireImmediately,
    /// A worst price on the wrong side of the trigger price.
    InvalidWorstPrice,
    /// A size of zero, or larger than the position.
    InvalidSize,
    InvalidExpiry,
    /// The take-profit and the stop-loss would sit on the wrong sides of each other.
    CrossedPair,
    Engine(EngineError),
}

impl From<EngineError> for TriggerError {
    fn from(error: EngineError) -> Self {
        TriggerError::Engine(error)
    }
}

pub type TriggerResult<T> = Result<T, TriggerError>;

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Pod, Zeroable)]
pub struct TriggerHeader {
    pub version: u32,
    /// The market the book is for.
    pub market_id: u32,
    /// Slots in the book: one per seat of the ledger.
    pub seat_capacity: u32,
    /// Entries each heap holds.
    pub heap_len: [u32; HEAPS],
    /// Stamped on a record each time it enters a heap, so records with equal keys leave
    /// in the order they entered. Wraps.
    pub next_sequence: u32,
    /// The next slot a sweep reads.
    pub sweep_cursor: u32,
    /// The next seat the fairness share of `due_triggers` reads.
    pub fair_cursor: u32,
    /// Keeps the header a multiple of 8 bytes.
    pub padding: u32,
}

/// One take-profit or stop-loss.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Pod, Zeroable)]
pub struct TriggerRecord {
    pub trigger_price: u64,
    /// The worst price of the reduce-only market order the record places.
    pub worst_price: u64,
    /// Lots of a fixed-size record; unread when the record is whole-position.
    pub size: u64,
    pub client_id: u64,
    /// Unix seconds after which the record is dropped; zero means never.
    pub expiry: i64,
    /// The earliest time of the next attempt; zero means now.
    pub next_attempt: i64,
    /// Changes whenever the record is set, re-armed or dropped, so a reference taken
    /// earlier cannot act on a later state of the record.
    pub record_version: u32,
    /// The record's position in its heap.
    pub pos: u32,
    pub flags: u8,
    /// The position generation the record was set on.
    pub generation: u8,
    /// The seat's position slot the record was set on.
    pub perp_slot: u8,
    /// Zero, or the heap index plus one.
    pub heap: u8,
    pub sequence: u32,
    /// The receipt secret the trader drew when the record was set. Every order the record
    /// places carries it, and it is zeroed with the rest of the record when the record
    /// is dropped or cancelled.
    pub secret: [u8; 16],
}

impl TriggerRecord {
    fn is_active(&self) -> bool {
        self.flags & ACTIVE != 0
    }

    fn fires_below(&self) -> bool {
        self.flags & BELOW != 0
    }

    fn is_whole(&self) -> bool {
        self.flags & WHOLE != 0
    }

    /// Whether the record's last attempt could not be placed for want of size: it is set
    /// but cannot protect the part of the position it names, and the owner should be told.
    pub fn is_unfillable(&self) -> bool {
        self.flags & UNFILLABLE != 0
    }

    fn is_long(&self) -> bool {
        self.flags & LONG != 0
    }

    /// Whether the mark has reached the trigger price.
    fn is_crossed_by(&self, mark: u64) -> bool {
        if self.fires_below() {
            mark <= self.trigger_price
        } else {
            mark >= self.trigger_price
        }
    }
}

/// The fixed place of one seat: its owner and its two records.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Pod, Zeroable)]
pub struct TriggerSlot {
    /// Zero when the slot holds no record.
    pub owner: [u8; 32],
    pub take_profit: TriggerRecord,
    pub stop_loss: TriggerRecord,
}

impl TriggerSlot {
    fn record(&self, which: usize) -> Option<&TriggerRecord> {
        match which {
            0 => Some(&self.take_profit),
            1 => Some(&self.stop_loss),
            _ => None,
        }
    }

    fn record_mut(&mut self, which: usize) -> Option<&mut TriggerRecord> {
        match which {
            0 => Some(&mut self.take_profit),
            1 => Some(&mut self.stop_loss),
            _ => None,
        }
    }

    fn active_count(&self) -> usize {
        usize::from(self.take_profit.is_active())
            .saturating_add(usize::from(self.stop_loss.is_active()))
    }
}

/// Version 1 is exactly this layout. A change to any of these sizes is a new version.
const _: () = assert!(
    TRIGGER_BOOK_VERSION != 1
        || (HEADER_LEN == 40 && SLOT_LEN == 192 && TIME_ENTRIES_PER_SEAT == 2)
);
const _: () = assert!(size_of::<TriggerHeader>() == HEADER_LEN);
const _: () = assert!(size_of::<TriggerRecord>() == 80);
const _: () = assert!(SLOT_LEN == 32 + 2 * size_of::<TriggerRecord>());
const _: () = assert!(size_of::<TriggerSlot>() == SLOT_LEN);
const _: () = assert!(align_of::<TriggerSlot>() == 8);
const _: () = assert!(HEADER_LEN % 8 == 0);
/// The largest seat table the 10 MiB account limit allows fits this layout.
const HEAP_BYTES_PER_SEAT: usize = 4 * (2 + TIME_ENTRIES_PER_SEAT);
const _: () = assert!(HEADER_LEN + 34_492 * (SLOT_LEN + HEAP_BYTES_PER_SEAT) <= 10_485_760);

/// Bytes a book for `seat_capacity` seats takes, or `None` when that overflows.
pub fn book_len(seat_capacity: usize) -> Option<usize> {
    seat_capacity
        .checked_mul(SLOT_LEN + HEAP_BYTES_PER_SEAT)?
        .checked_add(HEADER_LEN)
}

/// Takes the next `count` values of `T` off the front of `bytes`.
fn carve<'a, T: Pod>(bytes: &mut &'a mut [u8], count: usize) -> TriggerResult<&'a mut [T]> {
    let len = count
        .checked_mul(size_of::<T>())
        .ok_or(TriggerError::BadLayout)?;
    let (head, tail) = core::mem::take(bytes)
        .split_at_mut_checked(len)
        .ok_or(TriggerError::BadLayout)?;
    *bytes = tail;
    bytemuck::try_cast_slice_mut(head).map_err(|_| TriggerError::BadLayout)
}

/// A book borrowed from an account's bytes.
pub struct TriggerBook<'a> {
    header: &'a mut TriggerHeader,
    slots: &'a mut [TriggerSlot],
    heaps: [&'a mut [u32]; HEAPS],
    scanned: Cell<u64>,
}

impl<'a> TriggerBook<'a> {
    /// Writes the header of a new book into `data`, which must be zeroed, aligned to 8
    /// bytes and at least `book_len(seat_capacity)` long.
    pub fn init(data: &mut [u8], market_id: u8, seat_capacity: u32) -> TriggerResult<()> {
        let needed = usize::try_from(seat_capacity)
            .ok()
            .and_then(book_len)
            .ok_or(TriggerError::BadLayout)?;
        if data.len() < needed {
            return Err(TriggerError::BadLayout);
        }
        let (head, _) = data
            .split_at_mut_checked(HEADER_LEN)
            .ok_or(TriggerError::BadLayout)?;
        let header: &mut TriggerHeader =
            bytemuck::try_from_bytes_mut(head).map_err(|_| TriggerError::BadLayout)?;
        *header = TriggerHeader {
            version: TRIGGER_BOOK_VERSION,
            market_id: u32::from(market_id),
            seat_capacity,
            ..TriggerHeader::zeroed()
        };
        Ok(())
    }

    /// Borrows the book in `data`, refusing bytes that are not a whole book of this version.
    pub fn open(data: &'a mut [u8]) -> TriggerResult<TriggerBook<'a>> {
        let (head, rest) = data
            .split_at_mut_checked(HEADER_LEN)
            .ok_or(TriggerError::BadLayout)?;
        let header: &mut TriggerHeader =
            bytemuck::try_from_bytes_mut(head).map_err(|_| TriggerError::BadLayout)?;
        if header.version != TRIGGER_BOOK_VERSION {
            return Err(TriggerError::BadLayout);
        }
        let capacity =
            usize::try_from(header.seat_capacity).map_err(|_| TriggerError::BadLayout)?;
        let mut rest = rest;
        let slots = carve(&mut rest, capacity)?;
        let time_entries = capacity
            .checked_mul(TIME_ENTRIES_PER_SEAT)
            .ok_or(TriggerError::BadLayout)?;
        let heaps = [
            carve(&mut rest, capacity)?,
            carve(&mut rest, capacity)?,
            carve(&mut rest, time_entries)?,
        ];
        let within =
            header
                .heap_len
                .iter()
                .zip(heaps.iter())
                .all(|(len, room): (&u32, &&mut [u32])| {
                    usize::try_from(*len).is_ok_and(|len| len <= room.len())
                });
        if !within {
            return Err(TriggerError::BadLayout);
        }
        Ok(TriggerBook {
            header,
            slots,
            heaps,
            scanned: Cell::new(0),
        })
    }

    fn seat_record(&self, at: usize, kind: Kind) -> TriggerResult<&TriggerRecord> {
        self.slots
            .get(at)
            .and_then(|slot| slot.record(kind.which()))
            .ok_or(TriggerError::Corrupt)
    }

    fn seat_record_mut(&mut self, at: usize, kind: Kind) -> TriggerResult<&mut TriggerRecord> {
        self.slots
            .get_mut(at)
            .and_then(|slot| slot.record_mut(kind.which()))
            .ok_or(TriggerError::Corrupt)
    }

    pub fn heap_len(&self, heap: usize) -> usize {
        self.header
            .heap_len
            .get(heap)
            .and_then(|len| usize::try_from(*len).ok())
            .unwrap_or(0)
    }

    /// The seat's record of `kind`, if one is set.
    pub fn record(&self, seat: u32, kind: Kind) -> Option<&TriggerRecord> {
        let slot = usize::try_from(seat)
            .ok()
            .and_then(|seat| self.slots.get(seat))?;
        slot.record(kind.which())
            .filter(|record| record.is_active())
    }

    /// Slots read by `active_records` since the book was opened. A sweep or a pass over
    /// a large book must leave it at zero, since each such read costs the whole book.
    pub fn slots_scanned(&self) -> u64 {
        self.scanned.get()
    }

    /// Records set, in a heap or taken by `due_triggers` and not yet settled. Reads
    /// every slot of the book.
    pub fn active_records(&self) -> usize {
        let slots = u64::try_from(self.slots.len()).unwrap_or(u64::MAX);
        self.scanned.set(self.scanned.get().saturating_add(slots));
        self.slots
            .iter()
            .flat_map(|slot| [&slot.take_profit, &slot.stop_loss])
            .filter(|record| record.is_active())
            .count()
    }
}

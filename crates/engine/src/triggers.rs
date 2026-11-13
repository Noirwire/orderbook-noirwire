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
//! without the trigger account being present.
//!
//! Size. A fixed-size record only ever shrinks, to the live position. A whole-position
//! record follows the position up and down. The order a record places is reduce-only,
//! so the engine's own cap on the live position applies as well.
//!
//! Firing. `due_triggers` takes due records off the heaps, deepest crossing first, at
//! most a fixed number per pass, and only on a fresh mark. `fire_triggers` places one
//! reduce-only market order per due record through `place_order` and settles it with
//! `record_fire_outcome`: a partial fill re-arms the rest after a delay, a fill of
//! nothing waits out the delay in the time heap, and a record whose order errors is
//! dropped or retried on its own, never failing the others.
//!
//! Layout, for a seat capacity `n`: a 32 byte header, `248 * n` bytes of slots, then
//! the heaps of `4 * n`, `4 * n` and `12 * n` bytes. The account must be zeroed when it
//! is created and aligned to 8 bytes.

mod fire;
mod heap;
mod rules;

use bytemuck::{Pod, Zeroable};

use crate::error::EngineError;

pub use fire::{
    fire_triggers, Due, FireDecision, FireOutcome, FirePass, FirePlan, FireRules, Idle, Settled,
    MAX_FIRES_PER_PASS,
};
pub use rules::{Reconciled, SetOutcome, Standing, SweepReport, TriggerInput, TriggerSize};

/// The layout version a book is created with.
pub const TRIGGER_BOOK_VERSION: u32 = 1;

pub const HEADER_LEN: usize = 32;
pub const SLOT_LEN: usize = 248;

/// Heap indices. The above heap holds records that fire when the mark is at or above
/// their price, the below heap those that fire at or below it, and the time heap
/// records waiting for their next attempt.
pub const ABOVE_HEAP: usize = 0;
pub const BELOW_HEAP: usize = 1;
pub const TIME_HEAP: usize = 2;
const HEAPS: usize = 3;

/// Entries the time heap reserves per seat: the two price records, and the scheduled
/// record the slot keeps room for.
const TIME_ENTRIES_PER_SEAT: usize = 3;

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

/// `TriggerRecord::heap`: zero is in no heap, otherwise the heap index plus one.
const NO_HEAP: u8 = 0;

/// The two records of a seat.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    TakeProfit,
    StopLoss,
}

impl Kind {
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

/// The fixed place of one seat: its owner, its two records, and the room the layout
/// keeps for a record of scheduled buys, which nothing reads or writes yet.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Pod, Zeroable)]
pub struct TriggerSlot {
    /// Zero when the slot holds no record.
    pub owner: [u8; 32],
    pub take_profit: TriggerRecord,
    pub stop_loss: TriggerRecord,
    pub scheduled: [u64; 11],
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

    fn has_active(&self) -> bool {
        self.take_profit.is_active() || self.stop_loss.is_active()
    }
}

const _: () = assert!(size_of::<TriggerHeader>() == HEADER_LEN);
const _: () = assert!(size_of::<TriggerRecord>() == 64);
const _: () = assert!(size_of::<TriggerSlot>() == SLOT_LEN);
const _: () = assert!(align_of::<TriggerSlot>() == 8);
const _: () = assert!(HEADER_LEN % 8 == 0);
/// The largest seat table the 10 MiB account limit allows fits this layout.
const _: () =
    assert!(HEADER_LEN + 34_492 * (SLOT_LEN + 4 * (2 + TIME_ENTRIES_PER_SEAT)) <= 10_485_760);

/// Bytes a book for `seat_capacity` seats takes, or `None` when that overflows.
pub fn book_len(seat_capacity: usize) -> Option<usize> {
    let heaps = seat_capacity
        .checked_mul(2usize.checked_add(TIME_ENTRIES_PER_SEAT)?)?
        .checked_mul(4)?;
    HEADER_LEN
        .checked_add(seat_capacity.checked_mul(SLOT_LEN)?)?
        .checked_add(heaps)
}

/// A book borrowed from an account's bytes.
pub struct TriggerBook<'a> {
    header: &'a mut TriggerHeader,
    slots: &'a mut [TriggerSlot],
    heaps: [&'a mut [u32]; HEAPS],
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
        let slots_len = capacity
            .checked_mul(SLOT_LEN)
            .ok_or(TriggerError::BadLayout)?;
        let (slot_bytes, rest) = rest
            .split_at_mut_checked(slots_len)
            .ok_or(TriggerError::BadLayout)?;
        let slots: &mut [TriggerSlot] =
            bytemuck::try_cast_slice_mut(slot_bytes).map_err(|_| TriggerError::BadLayout)?;
        let heap_bytes = |entries: usize| {
            capacity
                .checked_mul(entries)
                .and_then(|entries| entries.checked_mul(4))
                .ok_or(TriggerError::BadLayout)
        };
        let (above, rest) = rest
            .split_at_mut_checked(heap_bytes(1)?)
            .ok_or(TriggerError::BadLayout)?;
        let (below, rest) = rest
            .split_at_mut_checked(heap_bytes(1)?)
            .ok_or(TriggerError::BadLayout)?;
        let (time, _) = rest
            .split_at_mut_checked(heap_bytes(TIME_ENTRIES_PER_SEAT)?)
            .ok_or(TriggerError::BadLayout)?;
        let words =
            |bytes| bytemuck::try_cast_slice_mut(bytes).map_err(|_| TriggerError::BadLayout);
        let heaps = [words(above)?, words(below)?, words(time)?];
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
        })
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

    /// Records set, in a heap or taken by `due_triggers` and not yet settled.
    pub fn active_records(&self) -> usize {
        self.slots
            .iter()
            .flat_map(|slot| [&slot.take_profit, &slot.stop_loss])
            .filter(|record| record.is_active())
            .count()
    }
}

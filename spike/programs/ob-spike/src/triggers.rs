//! Storage layouts for sealed trigger orders, built to be measured.
//!
//! One account per layout, one fixed slot per seat. A slot holds the owner, one
//! take-profit record, one stop-loss record and one scheduled-buy record.
//!
//! Layout A is the slots and nothing else: every pass scans them all.
//! Layout B adds three binary heaps of slot references and a back-pointer per
//! slot, so a due entry is found at the root of a heap and an entry can be
//! removed by slot.

use anchor_lang::prelude::*;
use bytemuck::{Pod, Zeroable};

use crate::SpikeError;

pub const LAYOUT_A: u32 = 1;
pub const LAYOUT_B: u32 = 2;
pub const NONE: u32 = u32::MAX;

pub const ACTIVE: u8 = 1;
/// The record fires when the mark is at or below its trigger price.
pub const BELOW: u8 = 2;

pub const ABOVE_HEAP: usize = 0;
pub const BELOW_HEAP: usize = 1;
pub const TIME_HEAP: usize = 2;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct Header {
    pub kind: u32,
    pub cap: u32,
    /// Entries in the above, below and time heaps.
    pub len: [u32; 3],
    pub pad: [u32; 11],
}

pub const HEADER_LEN: usize = std::mem::size_of::<Header>();

/// A take-profit or a stop-loss.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct PriceRec {
    pub seat: u32,
    pub kind: u8,
    pub side: u8,
    pub flags: u8,
    pub pad: u8,
    pub trigger_price: u64,
    pub worst_price: u64,
    pub size: u64,
    pub client_id: u64,
    pub expiry: i64,
}

/// A scheduled buy.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct DcaRec {
    pub seat: u32,
    pub kind: u8,
    pub side: u8,
    pub flags: u8,
    pub pad: u8,
    pub worst_price: u64,
    pub size: u64,
    pub client_id: u64,
    pub expiry: i64,
    pub interval: i64,
    pub next_time: i64,
    pub remaining: u32,
    pub pad2: u32,
    pub budget: u64,
    pub seed: [u8; 32],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct SlotA {
    pub owner: [u8; 32],
    pub tp: PriceRec,
    pub sl: PriceRec,
    pub dca: DcaRec,
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct SlotB {
    pub a: SlotA,
    /// Position of this slot's entry in each heap, or `NONE`.
    pub pos: [u32; 3],
    pub pad: u32,
}

pub const SLOT_A_LEN: usize = std::mem::size_of::<SlotA>();
pub const SLOT_B_LEN: usize = std::mem::size_of::<SlotB>();

pub const fn len_a(cap: usize) -> usize {
    HEADER_LEN + cap * SLOT_A_LEN
}

pub const fn len_b(cap: usize) -> usize {
    HEADER_LEN + cap * SLOT_B_LEN + 3 * cap * 4
}

trait Filled {
    fn base(&mut self) -> &mut SlotA;
    fn set_pos(&mut self, pos: [u32; 3]);
}

impl Filled for SlotA {
    fn base(&mut self) -> &mut SlotA {
        self
    }
    fn set_pos(&mut self, _pos: [u32; 3]) {}
}

impl Filled for SlotB {
    fn base(&mut self) -> &mut SlotA {
        &mut self.a
    }
    fn set_pos(&mut self, pos: [u32; 3]) {
        self.pos = pos;
    }
}

pub const ABOVE_BASE: u64 = 2_000_000;
pub const ABOVE_STEP: u64 = 16;
pub const BELOW_BASE: u64 = 500_000;
pub const BELOW_STEP: u64 = 8;
pub const TIME_BASE: i64 = 1_000_000_000;
pub const TIME_STEP: i64 = 60;

fn above_key(slot: u32) -> u64 {
    ABOVE_BASE + ABOVE_STEP * slot as u64
}

fn below_key(slot: u32) -> u64 {
    BELOW_BASE - BELOW_STEP * slot as u64
}

fn price_rec(slot: u32, kind: u8, below: bool, trigger_price: u64) -> PriceRec {
    PriceRec {
        seat: slot,
        kind,
        side: below as u8,
        flags: ACTIVE | if below { BELOW } else { 0 },
        pad: 0,
        trigger_price,
        worst_price: trigger_price,
        size: 1_000 + slot as u64,
        client_id: slot as u64,
        expiry: 0,
    }
}

/// Even slots are longs: take-profit above, stop-loss below. Odd slots are
/// shorts: the other way round. So each heap holds one entry per slot, and
/// which record that is depends on the slot.
fn above_which(slot: u32) -> u32 {
    slot & 1
}

fn below_which(slot: u32) -> u32 {
    1 - (slot & 1)
}

fn fill_slot(s: &mut SlotA, slot: u32) {
    s.owner = [0; 32];
    s.owner[..4].copy_from_slice(&slot.to_le_bytes());
    s.owner[31] = 7;
    let long = slot & 1 == 0;
    s.tp = if long {
        price_rec(slot, 0, false, above_key(slot))
    } else {
        price_rec(slot, 0, true, below_key(slot))
    };
    s.sl = if long {
        price_rec(slot, 1, true, below_key(slot))
    } else {
        price_rec(slot, 1, false, above_key(slot))
    };
    s.dca = DcaRec {
        seat: slot,
        kind: 2,
        side: 0,
        flags: ACTIVE,
        pad: 0,
        worst_price: ABOVE_BASE,
        size: 500,
        client_id: slot as u64,
        expiry: 0,
        interval: TIME_STEP,
        next_time: TIME_BASE + TIME_STEP * slot as i64,
        remaining: 10,
        pad2: 0,
        budget: 1_000_000,
        seed: [slot as u8; 32],
    };
}

fn open<'a>(data: &'a mut [u8], kind: u32) -> Result<(&'a mut Header, &'a mut [u8])> {
    require!(data.len() >= HEADER_LEN, SpikeError::TooSmall);
    let (head, rest) = data.split_at_mut(HEADER_LEN);
    let header = bytemuck::from_bytes_mut::<Header>(head);
    require!(header.kind == kind, SpikeError::BadLayout);
    Ok((header, rest))
}

fn words(bytes: &mut [u8]) -> Result<&mut [u32]> {
    bytemuck::try_cast_slice_mut::<u8, u32>(bytes).map_err(|_| error!(SpikeError::TooSmall))
}

pub fn init(data: &mut [u8], kind: u32, cap: u32) -> Result<()> {
    let needed = match kind {
        LAYOUT_A => len_a(cap as usize),
        LAYOUT_B => len_b(cap as usize),
        _ => return err!(SpikeError::BadLayout),
    };
    require!(data.len() >= needed, SpikeError::TooSmall);
    let head = bytemuck::from_bytes_mut::<Header>(&mut data[..HEADER_LEN]);
    head.kind = kind;
    head.cap = cap;
    head.len = [0; 3];
    Ok(())
}

fn fill_range<S: Filled + Pod>(
    slots: &mut [S],
    cap: u32,
    first: u32,
    count: u32,
    heap_n: u32,
    heaps: Option<[&mut [u32]; 3]>,
) -> Result<()> {
    require!(first as u64 + count as u64 <= cap as u64, SpikeError::BadSeat);
    let mut heaps = heaps;
    for slot in first..first + count {
        let s = &mut slots[slot as usize];
        fill_slot(s.base(), slot);
        let queued = slot < heap_n;
        s.set_pos(if queued { [slot; 3] } else { [NONE; 3] });
        if let (true, Some(h)) = (queued, heaps.as_mut()) {
            h[ABOVE_HEAP][slot as usize] = slot * 2 + above_which(slot);
            h[BELOW_HEAP][slot as usize] = slot * 2 + below_which(slot);
            h[TIME_HEAP][slot as usize] = slot * 2;
        }
    }
    Ok(())
}

/// Bulk setup. Writes slots `first..first + count` with deterministic records:
/// above-prices rise with the slot number, below-prices fall, due times rise.
/// So an array in slot order is already a valid heap, and layout B needs no
/// sifting to be built. Slots below `heap_n` are queued in all three heaps.
pub fn fill(data: &mut [u8], kind: u32, first: u32, count: u32, heap_n: u32) -> Result<()> {
    let (header, rest) = open(data, kind)?;
    let cap = header.cap;
    if kind == LAYOUT_A {
        let slots = bytemuck::try_cast_slice_mut::<u8, SlotA>(&mut rest[..cap as usize * SLOT_A_LEN])
            .map_err(|_| SpikeError::TooSmall)?;
        return fill_range(slots, cap, first, count, 0, None);
    }
    let heap_n = heap_n.min(cap);
    header.len = [heap_n; 3];
    let (slots, rest) = rest.split_at_mut(cap as usize * SLOT_B_LEN);
    let slots = bytemuck::try_cast_slice_mut::<u8, SlotB>(slots).map_err(|_| SpikeError::TooSmall)?;
    let (h0, rest) = rest.split_at_mut(cap as usize * 4);
    let (h1, rest) = rest.split_at_mut(cap as usize * 4);
    let h2 = &mut rest[..cap as usize * 4];
    fill_range(slots, cap, first, count, heap_n, Some([words(h0)?, words(h1)?, words(h2)?]))
}

/// Layout A. Counts the records whose condition holds at `mark` (and, with
/// `with_dca`, the scheduled buys due at `now`), in slots `start..end`.
/// Nothing is fired or written.
pub fn scan(data: &mut [u8], mark: u64, now: i64, start: u32, end: u32, with_dca: bool) -> Result<(u32, u32)> {
    let (header, rest) = open(data, LAYOUT_A)?;
    require!(start <= end && end <= header.cap, SpikeError::BadSeat);
    let slots = bytemuck::try_cast_slice::<u8, SlotA>(&rest[..header.cap as usize * SLOT_A_LEN])
        .map_err(|_| SpikeError::TooSmall)?;
    let mut price_due = 0u32;
    let mut time_due = 0u32;
    for s in &slots[start as usize..end as usize] {
        price_due += met(&s.tp, mark) as u32;
        price_due += met(&s.sl, mark) as u32;
        if with_dca {
            time_due += (s.dca.flags & ACTIVE != 0 && s.dca.next_time <= now) as u32;
        }
    }
    Ok((price_due, time_due))
}

#[inline(always)]
fn met(rec: &PriceRec, mark: u64) -> bool {
    if rec.flags & ACTIVE == 0 {
        return false;
    }
    if rec.flags & BELOW == 0 {
        mark >= rec.trigger_price
    } else {
        mark <= rec.trigger_price
    }
}

/// Layout B, borrowed in pieces so a heap and the slots can be used together.
pub struct Book<'a> {
    pub len: &'a mut [u32; 3],
    pub slots: &'a mut [SlotB],
    pub heaps: [&'a mut [u32]; 3],
}

pub fn with_b<T>(data: &mut [u8], work: impl FnOnce(&mut Book) -> Result<T>) -> Result<T> {
    let (header, rest) = open(data, LAYOUT_B)?;
    let cap = header.cap as usize;
    let (slots, rest) = rest.split_at_mut(cap * SLOT_B_LEN);
    let (h0, rest) = rest.split_at_mut(cap * 4);
    let (h1, rest) = rest.split_at_mut(cap * 4);
    let h2 = &mut rest[..cap * 4];
    let mut book = Book {
        len: &mut header.len,
        slots: bytemuck::try_cast_slice_mut::<u8, SlotB>(slots).map_err(|_| SpikeError::TooSmall)?,
        heaps: [words(h0)?, words(h1)?, words(h2)?],
    };
    work(&mut book)
}

/// What a heap orders by. An entry is `slot * 2 + which`; `which` picks the
/// take-profit or the stop-loss record. The time heap always uses 0.
#[inline(always)]
fn key(slots: &[SlotB], heap: usize, entry: u32) -> u64 {
    let s = &slots[(entry >> 1) as usize].a;
    if heap == TIME_HEAP {
        s.dca.next_time as u64
    } else if entry & 1 == 0 {
        s.tp.trigger_price
    } else {
        s.sl.trigger_price
    }
}

/// True when `x` belongs nearer the root than `y`. Equal keys go to the lower entry.
#[inline(always)]
fn before(slots: &[SlotB], heap: usize, x: u32, y: u32) -> bool {
    let (kx, ky) = (key(slots, heap, x), key(slots, heap, y));
    if kx == ky {
        x < y
    } else if heap == BELOW_HEAP {
        kx > ky
    } else {
        kx < ky
    }
}

#[inline(always)]
fn place(slots: &mut [SlotB], heap: &mut [u32], which: usize, at: usize, entry: u32) {
    heap[at] = entry;
    slots[(entry >> 1) as usize].pos[which] = at as u32;
}

fn sift_up(slots: &mut [SlotB], heap: &mut [u32], which: usize, mut at: usize, entry: u32) {
    while at > 0 {
        let parent = (at - 1) / 2;
        let above = heap[parent];
        if !before(slots, which, entry, above) {
            break;
        }
        place(slots, heap, which, at, above);
        at = parent;
    }
    place(slots, heap, which, at, entry);
}

fn sift_down(slots: &mut [SlotB], heap: &mut [u32], len: usize, which: usize, mut at: usize, entry: u32) {
    loop {
        let left = 2 * at + 1;
        if left >= len {
            break;
        }
        let right = left + 1;
        let child = if right < len && before(slots, which, heap[right], heap[left]) {
            right
        } else {
            left
        };
        if !before(slots, which, heap[child], entry) {
            break;
        }
        let moved = heap[child];
        place(slots, heap, which, at, moved);
        at = child;
    }
    place(slots, heap, which, at, entry);
}

fn remove_at(book: &mut Book, which: usize, at: usize) {
    let len = book.len[which] as usize - 1;
    book.len[which] = len as u32;
    let removed = book.heaps[which][at];
    book.slots[(removed >> 1) as usize].pos[which] = NONE;
    if at == len {
        return;
    }
    let last = book.heaps[which][len];
    let parent_wins = at > 0 && before(book.slots, which, last, book.heaps[which][(at - 1) / 2]);
    if parent_wins {
        sift_up(book.slots, book.heaps[which], which, at, last);
    } else {
        sift_down(book.slots, book.heaps[which], len, which, at, last);
    }
}

/// Queues `slot` in heap `which` under `key_value`, writing the key into the
/// record the heap reads it from.
pub fn insert(book: &mut Book, which: usize, slot: u32, record: u8, key_value: u64) -> Result<()> {
    let cap = book.slots.len();
    require!((slot as usize) < cap, SpikeError::BadSeat);
    let len = book.len[which] as usize;
    require!(len < cap, SpikeError::HeapFull);
    let s = &mut book.slots[slot as usize];
    require!(s.pos[which] == NONE, SpikeError::AlreadyQueued);
    let entry = if which == TIME_HEAP {
        s.a.dca.next_time = key_value as i64;
        slot * 2
    } else if record == 0 {
        s.a.tp.trigger_price = key_value;
        slot * 2
    } else {
        s.a.sl.trigger_price = key_value;
        slot * 2 + 1
    };
    book.len[which] = len as u32 + 1;
    sift_up(book.slots, book.heaps[which], which, len, entry);
    Ok(())
}

/// Removes `slot` from heap `which`.
pub fn remove(book: &mut Book, which: usize, slot: u32) -> Result<()> {
    require!((slot as usize) < book.slots.len(), SpikeError::BadSeat);
    let at = book.slots[slot as usize].pos[which];
    require!(at != NONE, SpikeError::NotQueued);
    remove_at(book, which, at as usize);
    Ok(())
}

/// Pops up to `max` entries from the root of heap `which` while the root is
/// due: at or past `mark` for the price heaps, at or past `now` for the time heap.
pub fn pop_due(book: &mut Book, which: usize, mark: u64, now: i64, max: u32) -> u32 {
    let mut popped = 0;
    while popped < max && book.len[which] > 0 {
        let root = book.heaps[which][0];
        let k = key(book.slots, which, root);
        let due = match which {
            ABOVE_HEAP => mark >= k,
            BELOW_HEAP => mark <= k,
            _ => now as u64 >= k,
        };
        if !due {
            break;
        }
        remove_at(book, which, 0);
        popped += 1;
    }
    popped
}

/// True when heap positions `start..end` are ordered against their parents and
/// every slot's back-pointer names its own position. Returns the heap length too.
pub fn check(book: &Book, which: usize, start: u32, end: u32) -> (u32, bool) {
    let len = book.len[which] as usize;
    let heap = &book.heaps[which];
    let range = (start as usize).min(len)..(end as usize).min(len);
    let ordered = range
        .clone()
        .all(|i| i == 0 || !before(book.slots, which, heap[i], heap[(i - 1) / 2]));
    let pointed = range.clone().all(|i| book.slots[(heap[i] >> 1) as usize].pos[which] == i as u32);
    (len as u32, ordered && pointed)
}

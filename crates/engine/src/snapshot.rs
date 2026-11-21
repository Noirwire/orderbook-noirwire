use bytemuck::{Pod, Zeroable};
use core::mem::size_of;

use crate::error::{EngineError, EngineResult};
use crate::math::count;
use crate::seats::owned_seat;
use crate::state::{MarketMut, Order, Seat, Side, Trader, MAX_OPEN_ORDERS, ORDER_FLAG_ASK};
use crate::triggers::{RecordStatus, SeatTriggerStatus};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Pod, Zeroable)]
pub struct OrderView {
    pub price: u64,
    pub remaining: u64,
    pub sequence: u64,
    pub locked: u64,
    pub expiry: i64,
    pub secret: [u8; 16],
    pub flags: u8,
    pub _padding: [u8; 7],
}

/// One trader's private view: a copy of the seat and its open orders on one market,
/// bids first, best price first within a side.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Pod, Zeroable)]
pub struct SeatSnapshot {
    pub seat: Seat,
    /// The room the seat had before it was 304 bytes. It holds a `TriggerStatusBlock`
    /// after `sync_view` and zero after any other write of the snapshot.
    pub _seat_reserved: [u8; 144],
    pub seat_index: u32,
    pub order_count: u32,
    pub market_id: u8,
    /// `SNAPSHOT_LAYOUT_IDENTITY` in every snapshot written with the seat epoch and the
    /// 24 bit generations, `SNAPSHOT_LAYOUT_SLOTS` in one written with the tagged-slot
    /// seat before them, zero in one written before that.
    pub layout: u8,
    pub _padding: [u8; 6],
    pub orders: [OrderView; MAX_OPEN_ORDERS],
}

/// The `layout` of a snapshot that holds a tagged-slot seat.
pub const SNAPSHOT_LAYOUT_SLOTS: u8 = 1;

/// The `layout` of a snapshot whose seat carries the seat epoch and the 24 bit
/// generations, and keeps the market lists in one byte each.
pub const SNAPSHOT_LAYOUT_IDENTITY: u8 = 2;

/// `TriggerStatusBlock::tag` of a block that holds a status. Zero is a reserve nothing
/// has written, which means the status is unknown, never that the records are gone.
pub const TRIGGER_STATUS_TAG: u8 = 1;

/// `TriggerStatusBlock` status bytes.
pub const TRIGGER_STATUS_GONE: u8 = 0;
pub const TRIGGER_STATUS_ARMED: u8 = 1;
pub const TRIGGER_STATUS_UNFILLABLE: u8 = 2;
/// The record's last attempt to close was refused for margin the seat's own resting
/// orders hold. The orders are left alone; cancel one to let the next attempt through.
pub const TRIGGER_STATUS_BLOCKED_BY_RESTING_ORDERS: u8 = 3;

/// What a view says of the trader's two triggers on one market as of the last
/// `sync_view`, laid at the start of `SeatSnapshot::_seat_reserved`. A retry time is
/// zero unless its record is unfillable or blocked by resting orders.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Pod, Zeroable)]
pub struct TriggerStatusBlock {
    pub tag: u8,
    pub market_id: u8,
    pub take_profit: u8,
    pub stop_loss: u8,
    pub _padding: [u8; 4],
    pub take_profit_retry: i64,
    pub stop_loss_retry: i64,
}

const _: () = assert!(size_of::<TriggerStatusBlock>() == 24);
const _: () = assert!(size_of::<TriggerStatusBlock>() <= 144);

impl TriggerStatusBlock {
    pub fn new(market_id: u8, status: &SeatTriggerStatus) -> TriggerStatusBlock {
        let (take_profit, take_profit_retry) = coded(status.take_profit);
        let (stop_loss, stop_loss_retry) = coded(status.stop_loss);
        TriggerStatusBlock {
            tag: TRIGGER_STATUS_TAG,
            market_id,
            take_profit,
            stop_loss,
            _padding: [0; 4],
            take_profit_retry,
            stop_loss_retry,
        }
    }
}

fn coded(status: RecordStatus) -> (u8, i64) {
    match status {
        RecordStatus::Gone => (TRIGGER_STATUS_GONE, 0),
        RecordStatus::Armed => (TRIGGER_STATUS_ARMED, 0),
        RecordStatus::Unfillable { next_attempt } => (TRIGGER_STATUS_UNFILLABLE, next_attempt),
        RecordStatus::BlockedByRestingOrders { next_attempt } => {
            (TRIGGER_STATUS_BLOCKED_BY_RESTING_ORDERS, next_attempt)
        }
    }
}

/// Lays the trigger status of the snapshot's seat on `market_id` at the start of the
/// reserve. Written after `snapshot_seat`, which zeroes the reserve.
pub fn write_trigger_status(out: &mut SeatSnapshot, market_id: u8, status: &SeatTriggerStatus) {
    let block = TriggerStatusBlock::new(market_id, status);
    let bytes = bytemuck::bytes_of(&block);
    if let Some(room) = out._seat_reserved.get_mut(..bytes.len()) {
        room.copy_from_slice(bytes);
    }
}

/// Marks the status block unknown when it is the one for `market_id`: the book changed
/// after the last sync, so what the block says may no longer be true. A block for
/// another market, or no block, is left as it is. Returns whether it cleared one.
pub fn clear_trigger_status(out: &mut SeatSnapshot, market_id: u8) -> bool {
    let block_is_for_market = out._seat_reserved.first() == Some(&TRIGGER_STATUS_TAG)
        && out._seat_reserved.get(1) == Some(&market_id);
    if block_is_for_market {
        if let Some(tag) = out._seat_reserved.first_mut() {
            *tag = 0;
        }
    }
    block_is_for_market
}

const _: () = assert!(size_of::<OrderView>() == 64);
const _: () = assert!(size_of::<SeatSnapshot>() == 304 + 144 + 16 + MAX_OPEN_ORDERS * 64);
const _: () = assert!(size_of::<SeatSnapshot>() == 2_512);

fn view(order: &Order, side: Side) -> OrderView {
    OrderView {
        price: order.price,
        remaining: order.remaining,
        sequence: order.sequence,
        locked: order.locked,
        expiry: order.expiry,
        secret: order.secret,
        flags: match side {
            Side::Bid => 0,
            Side::Ask => ORDER_FLAG_ASK,
        },
        _padding: [0; 7],
    }
}

/// RULES 13.10: fills `out` with the caller's own seat and open orders. Read-only.
pub fn snapshot_seat(
    seats: &[Seat],
    market: &MarketMut<'_>,
    trader: Trader<'_>,
    out: &mut SeatSnapshot,
) -> EngineResult<()> {
    market.checked_kind()?;
    let seat = owned_seat(seats, trader)?;
    let bids = market.live(Side::Bid)?.iter().rev().map(|o| (o, Side::Bid));
    let asks = market.live(Side::Ask)?.iter().rev().map(|o| (o, Side::Ask));
    let mut snapshot = SeatSnapshot::zeroed();
    let mut written = 0usize;
    for (order, side) in bids.chain(asks).filter(|(o, _)| o.seat == trader.seat) {
        let slot = snapshot
            .orders
            .get_mut(written)
            .ok_or(EngineError::InvariantBroken)?;
        *slot = view(order, side);
        written = written.checked_add(1).ok_or(EngineError::MathOverflow)?;
    }
    snapshot.seat = *seat;
    snapshot.seat_index = trader.seat;
    snapshot.order_count = count(written)?;
    snapshot.market_id = market.params.market_id;
    snapshot.layout = SNAPSHOT_LAYOUT_IDENTITY;
    *out = snapshot;
    Ok(())
}

use bytemuck::{Pod, Zeroable};
use core::mem::size_of;

use crate::error::{EngineError, EngineResult};
use crate::math::count;
use crate::seats::owned_seat;
use crate::state::{MarketMut, Order, Seat, Side, Trader, MAX_OPEN_ORDERS, ORDER_FLAG_ASK};

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
    pub seat_index: u32,
    pub order_count: u32,
    pub market_id: u8,
    pub _padding: [u8; 7],
    pub orders: [OrderView; MAX_OPEN_ORDERS],
}

const _: () = assert!(size_of::<OrderView>() == 64);
const _: () = assert!(size_of::<SeatSnapshot>() == 448 + 16 + MAX_OPEN_ORDERS * 64);

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
    *out = snapshot;
    Ok(())
}

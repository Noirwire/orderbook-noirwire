use bytemuck::Zeroable;

use crate::error::{EngineError, EngineResult};
use crate::math::{base_atoms, credit, debit};
use crate::state::{MarketKind, MarketParams, Order, Seat, Side};

/// RULES 4: whether a taker with this limit price trades against a resting price.
pub(crate) fn crosses(taker_side: Side, limit: u64, resting: u64) -> bool {
    match taker_side {
        Side::Bid => resting <= limit,
        Side::Ask => resting >= limit,
    }
}

/// RULES 4: where a new order goes so the side stays sorted worst first. The new order
/// has the highest sequence, so it sits below every older order at the same price.
pub(crate) fn insert_index(live: &[Order], side: Side, price: u64) -> usize {
    match side {
        Side::Bid => live.partition_point(|order| order.price < price),
        Side::Ask => live.partition_point(|order| order.price > price),
    }
}

pub(crate) fn insert_at(orders: &mut [Order], len: usize, index: usize, order: Order) {
    let window = len
        .checked_add(1)
        .and_then(|end| orders.get_mut(index..end));
    if let Some(window) = window {
        if !window.is_empty() {
            window.rotate_right(1);
        }
        if let Some(first) = window.first_mut() {
            *first = order;
        }
    }
}

pub(crate) fn remove_at(orders: &mut [Order], len: usize, index: usize) {
    if let Some(window) = orders.get_mut(index..len) {
        if !window.is_empty() {
            window.rotate_left(1);
        }
        if let Some(last) = window.last_mut() {
            *last = Order::zeroed();
        }
    }
}

pub(crate) fn truncate(orders: &mut [Order], len: usize, keep: usize) {
    if let Some(tail) = orders.get_mut(keep..len) {
        tail.fill(Order::zeroed());
    }
}

/// Removes every order of `seat` at or above `from`, keeping the rest in order.
pub(crate) fn remove_seat_orders(orders: &mut [Order], len: usize, seat: u32, from: usize) {
    let Some(live) = orders.get_mut(..len) else {
        return;
    };
    let mut kept = 0usize;
    for read in 0..live.len() {
        let removed = read >= from && live.get(read).is_some_and(|order| order.seat == seat);
        if !removed {
            live.swap(kept, read);
            kept = kept.saturating_add(1);
        }
    }
    if let Some(tail) = live.get_mut(kept..) {
        tail.fill(Order::zeroed());
    }
}

pub(crate) fn find_by_sequence(live: &[Order], sequence: u64) -> Option<(usize, Order)> {
    live.iter()
        .position(|order| order.sequence == sequence)
        .and_then(|position| live.get(position).map(|order| (position, *order)))
}

/// RULES 5: on cancel or end of an order, whatever it still has locked returns to
/// `available`. For a perp order the open lots stop counting toward initial margin.
pub(crate) fn release_order(
    seat: &mut Seat,
    params: &MarketParams,
    side: Side,
    order: &Order,
) -> EngineResult<()> {
    let market = usize::from(params.market_id);
    match (params.kind()?, side) {
        (MarketKind::Spot, Side::Bid) => {
            let quote = seat.token_mut(params.quote_token)?;
            let amount = u128::from(order.locked);
            debit(&mut quote.locked, amount, EngineError::InvariantBroken)?;
            credit(&mut quote.available, amount)?;
        }
        (MarketKind::Spot, Side::Ask) => {
            let base = seat.token_mut(params.base_token)?;
            let amount = base_atoms(order.remaining, params.base_lot)?;
            debit(&mut base.locked, amount, EngineError::InvariantBroken)?;
            credit(&mut base.available, amount)?;
        }
        (MarketKind::Perp, Side::Bid) => {
            let slot = seat.slot_mut(market)?;
            slot.open_bid_lots = slot
                .open_bid_lots
                .checked_sub(order.remaining)
                .ok_or(EngineError::InvariantBroken)?;
        }
        (MarketKind::Perp, Side::Ask) => {
            let slot = seat.slot_mut(market)?;
            slot.open_ask_lots = slot
                .open_ask_lots
                .checked_sub(order.remaining)
                .ok_or(EngineError::InvariantBroken)?;
        }
    }
    close_order_slot(seat, market)
}

pub(crate) fn close_order_slot(seat: &mut Seat, market: usize) -> EngineResult<()> {
    let open = seat.open_order_count_mut(market)?;
    *open = open.checked_sub(1).ok_or(EngineError::InvariantBroken)?;
    Ok(())
}

/// Releases up to `budget` orders of `seat`, best first, and reports the lowest index
/// released so the book can drop exactly those orders once the call is certain to succeed.
pub(crate) fn release_seat_orders(
    seat: &mut Seat,
    params: &MarketParams,
    side: Side,
    live: &[Order],
    seat_index: u32,
    budget: usize,
) -> EngineResult<SeatRelease> {
    let mut release = SeatRelease {
        from: live.len(),
        released: 0,
    };
    for (position, order) in live.iter().enumerate().rev() {
        if release.released >= budget {
            break;
        }
        if order.seat == seat_index {
            release_order(seat, params, side, order)?;
            release.from = position;
            release.released = release
                .released
                .checked_add(1)
                .ok_or(EngineError::MathOverflow)?;
        }
    }
    Ok(release)
}

#[derive(Clone, Copy)]
pub(crate) struct SeatRelease {
    pub(crate) from: usize,
    pub(crate) released: usize,
}

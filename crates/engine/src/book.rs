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

/// RULES 3.8: whether a new order's price is strictly better than a resting price on
/// its own side, so that it may evict that order from a full side.
fn improves_on(side: Side, price: u64, resting: u64) -> bool {
    match side {
        Side::Bid => price > resting,
        Side::Ask => price < resting,
    }
}

/// RULES 3.8: the index of the order a new order evicts from a full side. The first
/// expired order, worst first, wherever it sits; else the worst order, at index 0,
/// when the new price is strictly better than its price.
pub(crate) fn eviction_index(live: &[Order], side: Side, price: u64, now: i64) -> Option<usize> {
    live.iter()
        .position(|order| order.is_expired(now))
        .or_else(|| {
            live.first()
                .filter(|worst| improves_on(side, price, worst.price))
                .map(|_| 0)
        })
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

/// RULES 3.8: drops the order at `removed` from a full side and puts `order` at `index`
/// of the orders that remain, moving only the orders between the two.
pub(crate) fn replace_at(orders: &mut [Order], removed: usize, index: usize, order: Order) {
    if removed < index {
        let window = index
            .checked_add(1)
            .and_then(|end| orders.get_mut(removed..end));
        if let Some(window) = window {
            window.rotate_left(1);
            if let Some(last) = window.last_mut() {
                *last = order;
            }
        }
    } else {
        let window = removed
            .checked_add(1)
            .and_then(|end| orders.get_mut(index..end));
        if let Some(window) = window {
            window.rotate_right(1);
            if let Some(first) = window.first_mut() {
                *first = order;
            }
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
/// Nothing below `from` moves, and each run of kept orders between two removed
/// ones moves down in one copy, so against a full side the work is one scan and
/// at most one copy per removed order.
pub(crate) fn remove_seat_orders(orders: &mut [Order], len: usize, seat: u32, from: usize) {
    let Some(live) = orders.get_mut(..len) else {
        return;
    };
    let start = from.min(live.len());
    let mut kept = start;
    let mut run = start;
    for read in start..live.len() {
        if live.get(read).is_some_and(|order| order.seat == seat) {
            kept = move_run(live, run..read, kept);
            run = read.saturating_add(1);
        }
    }
    kept = move_run(live, run..live.len(), kept);
    if let Some(tail) = live.get_mut(kept..) {
        tail.fill(Order::zeroed());
    }
}

/// Moves the orders in `run` down to start at `to` and returns where the next run goes.
fn move_run(live: &mut [Order], run: core::ops::Range<usize>, to: usize) -> usize {
    let moved = run.len();
    if moved > 0 && run.start != to {
        live.copy_within(run, to);
    }
    to.saturating_add(moved)
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

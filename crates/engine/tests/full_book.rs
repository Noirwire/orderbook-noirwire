//! Cancelling against a book with both sides full: the case whose cost grows with
//! the book. The orders that stay must keep their places and their order exactly.

mod common;

use bytemuck::Zeroable;
use common::*;
use noirwire_orderbook_engine::*;

const TARGET_PER_SIDE: usize = 16;
const PER_SEAT: usize = 32;

fn funded(w: &mut World) -> u32 {
    let seat = w.open();
    w.deposit(seat, Asset::Collateral, 1_000_000).unwrap();
    seat
}

fn price(side: Side, level: usize) -> u64 {
    let ticks = 10 * (1 + level as u64 % 5);
    match side {
        Side::Bid => MARK - ticks,
        Side::Ask => MARK + ticks,
    }
}

fn worst(side: Side) -> u64 {
    price(side, 4)
}

/// A perp market with 1,024 bids and 1,024 asks. `target` holds sixteen of each,
/// and its last order on each side is the newest at the worst price, so it sits
/// at the very front and every other order lies behind one of its orders.
fn full_book() -> (World, usize, u32) {
    let mut w = World::new(80, ORDERS_PER_SIDE);
    let m = w.add_market(MarketParams {
        max_open_orders: PER_SEAT as u16,
        ..perp_params(0)
    });
    let target = funded(&mut w);
    for side in [Side::Bid, Side::Ask] {
        let mut filler = funded(&mut w);
        for level in 0..ORDERS_PER_SIDE - TARGET_PER_SIDE {
            if level > 0 && level % PER_SEAT == 0 {
                filler = funded(&mut w);
            }
            let placed = w
                .place(m, filler, limit(side, price(side, level), 1))
                .unwrap();
            assert_eq!(placed.status, PlaceStatus::Rested);
        }
        for level in 0..TARGET_PER_SIDE {
            let at = if level + 1 == TARGET_PER_SIDE {
                worst(side)
            } else {
                price(side, level * 3)
            };
            let placed = w.place(m, target, limit(side, at, 1)).unwrap();
            assert_eq!(placed.status, PlaceStatus::Rested);
        }
    }
    assert_eq!(w.markets[m].live(Side::Bid).len(), ORDERS_PER_SIDE);
    assert_eq!(w.markets[m].live(Side::Ask).len(), ORDERS_PER_SIDE);
    assert_eq!(w.markets[m].live(Side::Bid)[0].seat, target);
    assert_eq!(w.markets[m].live(Side::Ask)[0].seat, target);
    (w, m, target)
}

fn without(orders: &[Order], gone: impl Fn(usize, &Order) -> bool) -> Vec<Order> {
    orders
        .iter()
        .enumerate()
        .filter(|(at, order)| !gone(*at, order))
        .map(|(_, order)| *order)
        .collect()
}

#[test]
fn cancel_all_on_a_full_book_keeps_every_other_order_in_its_order() {
    let (mut w, m, target) = full_book();
    let bids = w.markets[m].live(Side::Bid).to_vec();
    let asks = w.markets[m].live(Side::Ask).to_vec();

    let cancelled = w.cancel_all(m, target, PER_SEAT as u32).unwrap();

    assert_eq!(cancelled as usize, 2 * TARGET_PER_SIDE);
    let mine = |_: usize, order: &Order| order.seat == target;
    assert_eq!(
        w.markets[m].live(Side::Bid),
        without(&bids, mine).as_slice()
    );
    assert_eq!(
        w.markets[m].live(Side::Ask),
        without(&asks, mine).as_slice()
    );
    assert_eq!(w.slot(target, m).open_bid_lots, 0);
    assert_eq!(w.slot(target, m).open_ask_lots, 0);
}

#[test]
fn a_cancel_all_cut_short_by_its_budget_removes_only_the_best_orders_it_released() {
    let (mut w, m, target) = full_book();
    let bids = w.markets[m].live(Side::Bid).to_vec();
    let asks = w.markets[m].live(Side::Ask).to_vec();
    let budget = 5;
    let released: Vec<usize> = bids
        .iter()
        .enumerate()
        .filter(|(_, order)| order.seat == target)
        .map(|(at, _)| at)
        .rev()
        .take(budget)
        .collect();

    let cancelled = w.cancel_all(m, target, budget as u32).unwrap();

    assert_eq!(cancelled as usize, budget);
    let expected = without(&bids, |at, _| released.contains(&at));
    assert_eq!(w.markets[m].live(Side::Bid), expected.as_slice());
    assert_eq!(w.markets[m].live(Side::Ask), asks.as_slice());
    assert_eq!(
        w.markets[m].bids[ORDERS_PER_SIDE - budget..],
        vec![Order::zeroed(); budget],
        "the slots the removed orders left are cleared"
    );
}

//! RULES 6: the public open interest of a perp market is the figure its book keeps,
//! and the program publishes that figure after every perp order and every
//! liquidation. These tests count it a second way, from the seats alone: each fill
//! is walked back from the positions as they end up, so a seat filled several times
//! is undone one fill at a time, and the change in total long lots must equal the
//! change in the book's figure.

mod common;

use common::*;
use noirwire_orderbook_engine::*;
use proptest::prelude::*;

fn positive(base: i128) -> i128 {
    base.max(0)
}

fn long_lots(seats: &[Seat], seat: u32, market: usize) -> i128 {
    usize::try_from(seat)
        .ok()
        .and_then(|index| seats.get(index))
        .and_then(|seat| seat.slot(market).ok())
        .map(|slot| positive(i128::from(slot.base)))
        .unwrap_or(0)
}

fn walked_back_change(seats: &[Seat], market: usize, fills: &[Fill]) -> Option<i128> {
    let mut tracked: [(u32, i128); MAX_FILLS + 1] = [(u32::MAX, 0); MAX_FILLS + 1];
    let mut tracked_len = 0usize;
    let mut change: i128 = 0;
    for fill in fills.iter().rev() {
        let size = i128::from(fill.size);
        let (taker_delta, maker_delta) = match fill.taker_side {
            Side::Bid => (size, -size),
            Side::Ask => (-size, size),
        };
        for (seat_index, delta) in [
            (fill.taker_seat, taker_delta),
            (fill.maker_seat, maker_delta),
        ] {
            let known = tracked[..tracked_len]
                .iter()
                .position(|(index, _)| *index == seat_index);
            let after = match known {
                Some(at) => tracked[at].1,
                None => {
                    let seat = seats.get(usize::try_from(seat_index).ok()?)?;
                    i128::from(seat.slot(market).ok()?.base)
                }
            };
            let before = after.checked_sub(delta)?;
            change = change.checked_add(positive(after) - positive(before))?;
            match known {
                Some(at) => tracked[at].1 = before,
                None => {
                    *tracked.get_mut(tracked_len)? = (seat_index, before);
                    tracked_len += 1;
                }
            }
        }
    }
    Some(change)
}

#[derive(Debug, Clone)]
enum Op {
    Place {
        seat: u32,
        bid: bool,
        ioc: bool,
        level: u64,
        size: u64,
    },
    Price {
        level: u64,
    },
    Liquidate {
        liquidator: u32,
        target: u32,
        size: u64,
    },
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        8 => (2u32..7, any::<bool>(), any::<bool>(), 90u64..111, 1u64..40).prop_map(
            |(seat, bid, ioc, level, size)| Op::Place {
                seat,
                bid,
                ioc,
                level,
                size,
            }
        ),
        1 => (80u64..121).prop_map(|level| Op::Price { level }),
        2 => (2u32..7, 2u32..7, 1u64..60).prop_map(|(liquidator, target, size)| {
            Op::Liquidate {
                liquidator,
                target,
                size,
            }
        }),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(1000))]
    #[test]
    fn seats_walked_back_agree_with_the_book(ops in prop::collection::vec(op(), 1..60)) {
        let mut w = World::new(8, 8);
        let m = w.add_market(perp_params(0));
        for _ in 0..5 {
            let seat = w.open();
            w.deposit(seat, Asset::Collateral, 3_000 + u64::from(seat) * 700).unwrap();
        }
        let mut counted: i128 = 0;
        for op in ops {
            match op {
                Op::Place { seat, bid, ioc: is_ioc, level, size } => {
                    let side = if bid { Side::Bid } else { Side::Ask };
                    let price = level * 10;
                    let order = if is_ioc { ioc(side, price, size) } else { limit(side, price, size) };
                    let before = w.markets[m].book.open_interest;
                    if w.place(m, seat, order).is_ok() {
                        let after = w.markets[m].book.open_interest;
                        let change = walked_back_change(&w.seats, m, w.fills.as_slice()).unwrap();
                        prop_assert_eq!(change, i128::from(after) - i128::from(before));
                        counted += change;
                        prop_assert_eq!(counted, i128::from(after));
                    }
                }
                Op::Price { level } => w.set_price(m, level * 10),
                Op::Liquidate { liquidator, target, size } => {
                    let before = w.markets[m].book.open_interest;
                    let long_before = long_lots(&w.seats, target, m) + long_lots(&w.seats, liquidator, m);
                    if let Ok(outcome) = w.liquidate(m, liquidator, target, size) {
                        let after = w.markets[m].book.open_interest;
                        if outcome.status == LiquidationStatus::Liquidated {
                            let long_after = long_lots(&w.seats, target, m) + long_lots(&w.seats, liquidator, m);
                            prop_assert_eq!(long_after - long_before, i128::from(after) - i128::from(before));
                            counted += long_after - long_before;
                        } else {
                            prop_assert_eq!(after, before);
                        }
                        prop_assert_eq!(counted, i128::from(after));
                    }
                }
            }
        }
    }
}

#[test]
fn a_liquidation_moves_the_book_by_the_long_lots_it_changes() {
    let mut liquidated = 0;
    for seed in 0..200u64 {
        let mut w = World::new(8, 8);
        let m = w.add_market(perp_params(0));
        let a = w.open();
        let b = w.open();
        let c = w.open();
        w.deposit(a, Asset::Collateral, 2_000).unwrap();
        w.deposit(b, Asset::Collateral, 50_000).unwrap();
        w.deposit(c, Asset::Collateral, 50_000).unwrap();
        let size = 10 + seed % 9;
        w.place(m, b, limit(Side::Ask, MARK, size)).unwrap();
        w.place(m, a, ioc(Side::Bid, MARK, size)).unwrap();
        w.set_price(m, MARK - 100 - (seed % 5) * 10);
        let before = w.markets[m].book.open_interest;
        let long_before = long_lots(&w.seats, a, m) + long_lots(&w.seats, c, m);
        if let Ok(outcome) = w.liquidate(m, c, a, 1 + seed % 20) {
            if outcome.status == LiquidationStatus::Liquidated {
                let long_after = long_lots(&w.seats, a, m) + long_lots(&w.seats, c, m);
                assert_eq!(
                    long_after - long_before,
                    i128::from(w.markets[m].book.open_interest) - i128::from(before)
                );
                liquidated += 1;
            }
        }
    }
    assert!(liquidated > 0);
}

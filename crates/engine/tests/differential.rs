//! RULES 4 against a second implementation. `Model` is written to be obviously right
//! and nothing else: one `Vec` of orders, sorted from scratch for every order. Both
//! are fed the same random streams and must agree on every fill, every outcome and
//! the whole resting book.

mod common;

use common::*;
use noirwire_orderbook_engine::EngineError as E;
use noirwire_orderbook_engine::*;
use proptest::prelude::*;
use proptest::test_runner::{Config, RngAlgorithm, TestRng, TestRunner};

const TRADERS: usize = 4;
const BOOK_CAPACITY: usize = 6;
const OPEN_ORDER_LIMIT: usize = 4;
const STEP_LIMIT: u32 = 3;
const DEEP_POCKETS: u64 = 1_000_000_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Resting {
    price: u64,
    remaining: u64,
    sequence: u64,
    seat: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ModelFill {
    fill_seq: u64,
    price: u64,
    size: u64,
    maker_seat: u32,
}

#[derive(Debug, PartialEq, Eq)]
struct ModelOutcome {
    status: PlaceStatus,
    filled: u64,
    rested: u64,
    cancelled: u64,
    resting_order_seq: Option<u64>,
    fills: Vec<ModelFill>,
}

#[derive(Default)]
struct Model {
    bids: Vec<Resting>,
    asks: Vec<Resting>,
    next_order_seq: u64,
    next_fill_seq: u64,
}

impl Model {
    fn side(&mut self, side: Side) -> &mut Vec<Resting> {
        match side {
            Side::Bid => &mut self.bids,
            Side::Ask => &mut self.asks,
        }
    }

    /// Best price first, then lowest sequence.
    fn by_priority(&self, side: Side) -> Vec<Resting> {
        let mut orders = match side {
            Side::Bid => self.bids.clone(),
            Side::Ask => self.asks.clone(),
        };
        orders.sort_by_key(|order| {
            let price_rank = match side {
                Side::Bid => u64::MAX - order.price,
                Side::Ask => order.price,
            };
            (price_rank, order.sequence)
        });
        orders
    }

    fn open_orders(&self, seat: u32) -> usize {
        let on_bids = self.bids.iter().filter(|o| o.seat == seat).count();
        let on_asks = self.asks.iter().filter(|o| o.seat == seat).count();
        on_bids + on_asks
    }

    fn place(&mut self, seat: u32, order: &NewOrder) -> Result<ModelOutcome, E> {
        let may_rest = matches!(order.order_type, OrderType::Limit | OrderType::PostOnly);
        if may_rest && self.open_orders(seat) >= OPEN_ORDER_LIMIT {
            return Err(E::TooManyOpenOrders);
        }
        let maker_side = order.side.opposite();
        let crosses = |resting: &Resting| match order.side {
            Side::Bid => resting.price <= order.price,
            Side::Ask => resting.price >= order.price,
        };
        let queue = self.by_priority(maker_side);
        if order.order_type == OrderType::PostOnly && queue.first().is_some_and(crosses) {
            return Ok(ModelOutcome {
                status: PlaceStatus::RefusedPostOnlyWouldMatch,
                filled: 0,
                rested: 0,
                cancelled: order.size,
                resting_order_seq: None,
                fills: Vec::new(),
            });
        }

        let mut remaining = order.size;
        let mut truncated = false;
        let mut fills = Vec::new();
        for (steps_taken, maker) in queue.into_iter().enumerate() {
            if remaining == 0 || !crosses(&maker) {
                break;
            }
            if steps_taken == STEP_LIMIT as usize {
                truncated = true;
                break;
            }
            let makers = self.side(maker_side);
            let at = makers
                .iter()
                .position(|o| o.sequence == maker.sequence)
                .unwrap();
            if maker.seat == seat {
                makers.remove(at);
                continue;
            }
            let size = remaining.min(maker.remaining);
            remaining -= size;
            makers[at].remaining -= size;
            if makers[at].remaining == 0 {
                makers.remove(at);
            }
            fills.push(ModelFill {
                fill_seq: self.next_fill_seq,
                price: maker.price,
                size,
                maker_seat: maker.seat,
            });
            self.next_fill_seq += 1;
        }

        let sequence = self.next_order_seq;
        self.next_order_seq += 1;
        let filled = order.size - remaining;
        let would_rest = remaining > 0 && !truncated && may_rest;
        let rests = would_rest && self.side(order.side).len() < BOOK_CAPACITY;
        if rests {
            self.side(order.side).push(Resting {
                price: order.price,
                remaining,
                sequence,
                seat,
            });
        }
        let status = if truncated {
            PlaceStatus::RemainderCancelledStepLimit
        } else if rests {
            PlaceStatus::Rested
        } else if would_rest {
            PlaceStatus::RemainderCancelledBookFull
        } else if remaining > 0 {
            PlaceStatus::RemainderCancelled
        } else {
            PlaceStatus::Filled
        };
        Ok(ModelOutcome {
            status,
            filled,
            rested: if rests { remaining } else { 0 },
            cancelled: if rests { 0 } else { remaining },
            resting_order_seq: rests.then_some(sequence),
            fills,
        })
    }

    fn cancel(&mut self, seat: u32, sequence: u64) -> Result<(), E> {
        for side in [Side::Bid, Side::Ask] {
            let orders = self.side(side);
            let found = orders
                .iter()
                .position(|o| o.sequence == sequence && o.seat == seat);
            if let Some(at) = found {
                orders.remove(at);
                return Ok(());
            }
        }
        Err(E::OrderNotFound)
    }

    fn cancel_all(&mut self, seat: u32, max_cancels: u32) -> u32 {
        let mut cancelled = 0;
        for side in [Side::Bid, Side::Ask] {
            for order in self.by_priority(side) {
                if cancelled < max_cancels && order.seat == seat {
                    self.cancel(seat, order.sequence).unwrap();
                    cancelled += 1;
                }
            }
        }
        cancelled
    }
}

#[derive(Clone, Debug)]
enum Step {
    Place { trader: usize, order: NewOrder },
    Cancel { trader: usize, sequence: u64 },
    CancelAll { trader: usize, max_cancels: u32 },
}

fn any_side() -> impl Strategy<Value = Side> {
    prop_oneof![Just(Side::Bid), Just(Side::Ask)]
}

fn any_order_type() -> impl Strategy<Value = OrderType> {
    prop_oneof![
        5 => Just(OrderType::Limit),
        2 => Just(OrderType::PostOnly),
        2 => Just(OrderType::ImmediateOrCancel),
        1 => Just(OrderType::Market),
    ]
}

fn any_step() -> impl Strategy<Value = Step> {
    let trader = 0..TRADERS;
    let shape = (any_side(), any_order_type(), 0u64..9, 1u64..12);
    let place = (trader.clone(), shape).prop_map(|(trader, shape)| {
        let (side, order_type, level, size) = shape;
        let order = order(side, order_type, 960 + level * 10, size);
        Step::Place { trader, order }
    });
    let cancel =
        (trader.clone(), 0u64..60).prop_map(|(trader, sequence)| Step::Cancel { trader, sequence });
    let cancel_all = (trader, 0u32..4).prop_map(|(trader, max_cancels)| Step::CancelAll {
        trader,
        max_cancels,
    });
    prop_oneof![12 => place, 3 => cancel, 1 => cancel_all]
}

fn deep_pocketed_world(params: MarketParams) -> (World, usize, Vec<u32>) {
    let mut w = World::new(TRADERS + RESERVED_SEATS, BOOK_CAPACITY);
    w.max_steps = STEP_LIMIT;
    let m = w.add_market(params);
    let traders: Vec<u32> = (0..TRADERS).map(|_| w.open()).collect();
    for trader in &traders {
        for asset in [Asset::Collateral, Asset::Spot(QUOTE), Asset::Spot(BASE)] {
            w.deposit(*trader, asset, DEEP_POCKETS).unwrap();
        }
    }
    (w, m, traders)
}

fn engine_book(w: &World, m: usize, side: Side) -> Vec<Resting> {
    w.markets[m]
        .resting(side)
        .iter()
        .map(|o| Resting {
            price: o.price,
            remaining: o.remaining,
            sequence: o.sequence,
            seat: o.seat,
        })
        .collect()
}

fn engine_outcome(w: &World, outcome: &PlaceOutcome) -> ModelOutcome {
    ModelOutcome {
        status: outcome.status,
        filled: outcome.filled,
        rested: outcome.rested,
        cancelled: outcome.cancelled,
        resting_order_seq: outcome.resting_order_seq,
        fills: w
            .fills
            .as_slice()
            .iter()
            .map(|fill| ModelFill {
                fill_seq: fill.fill_seq,
                price: fill.price,
                size: fill.size,
                maker_seat: fill.maker_seat,
            })
            .collect(),
    }
}

#[derive(Default)]
struct Seen {
    fills: usize,
    self_cancels: usize,
    truncated: usize,
    refused_post_only: usize,
    book_full: usize,
    open_limit: usize,
}

fn run_stream(params: MarketParams, steps: &[Step], seen: &mut Seen) {
    let (mut w, m, traders) = deep_pocketed_world(params);
    let mut model = Model::default();
    for step in steps {
        match step {
            Step::Place { trader, order } => {
                let seat = traders[*trader];
                let own_before = model.open_orders(seat);
                let expected = model.place(seat, order);
                let actual = w.place(m, seat, *order);
                let actual = actual.map(|outcome| engine_outcome(&w, &outcome));
                assert_eq!(actual, expected, "{step:?}");
                if let Ok(outcome) = &expected {
                    seen.fills += outcome.fills.len();
                    let own_after = model.open_orders(seat) - usize::from(outcome.rested > 0);
                    seen.self_cancels += own_before - own_after.min(own_before);
                    match outcome.status {
                        PlaceStatus::RemainderCancelledStepLimit => seen.truncated += 1,
                        PlaceStatus::RefusedPostOnlyWouldMatch => seen.refused_post_only += 1,
                        PlaceStatus::RemainderCancelledBookFull => seen.book_full += 1,
                        _ => {}
                    }
                } else {
                    seen.open_limit += 1;
                }
            }
            Step::Cancel { trader, sequence } => {
                let seat = traders[*trader];
                let expected = model.cancel(seat, *sequence);
                assert_eq!(w.cancel(m, seat, *sequence), expected, "{step:?}");
            }
            Step::CancelAll {
                trader,
                max_cancels,
            } => {
                let seat = traders[*trader];
                let expected = model.cancel_all(seat, *max_cancels);
                assert_eq!(w.cancel_all(m, seat, *max_cancels), Ok(expected));
            }
        }
        for side in [Side::Bid, Side::Ask] {
            assert_eq!(engine_book(&w, m, side), model.by_priority(side));
        }
        assert_eq!(w.markets[m].book.next_order_seq, model.next_order_seq);
        assert_eq!(w.markets[m].book.next_fill_seq, model.next_fill_seq);
    }
}

fn differential(params: MarketParams, seed: u8, cases: u32) {
    let config = Config {
        cases,
        failure_persistence: None,
        ..Config::default()
    };
    let rng = TestRng::from_seed(RngAlgorithm::ChaCha, &[seed; 32]);
    let mut runner = TestRunner::new_with_rng(config, rng);
    let seen = std::cell::RefCell::new(Seen::default());
    let streams = prop::collection::vec(any_step(), 1..120);

    runner
        .run(&streams, |steps| {
            run_stream(params, &steps, &mut seen.borrow_mut());
            Ok(())
        })
        .unwrap();

    let seen = seen.into_inner();
    assert!(seen.fills > 10_000, "fills {}", seen.fills);
    assert!(seen.self_cancels > 100, "{}", seen.self_cancels);
    assert!(seen.truncated > 100, "truncated {}", seen.truncated);
    assert!(seen.refused_post_only > 100);
    assert!(seen.book_full > 100, "book full {}", seen.book_full);
    assert!(seen.open_limit > 100, "open limit {}", seen.open_limit);
}

fn open_order_limit(mut params: MarketParams) -> MarketParams {
    params.max_open_orders = OPEN_ORDER_LIMIT as u16;
    params
}

#[test]
fn spot_matching_agrees_with_the_reference_model() {
    differential(open_order_limit(spot_params(0)), 11, 1_500);
}

#[test]
fn perp_matching_agrees_with_the_reference_model() {
    differential(open_order_limit(perp_params(0)), 12, 1_500);
}

#[test]
fn the_reference_model_itself_follows_price_then_time_priority() {
    let mut model = Model::default();
    model.place(1, &limit(Side::Ask, 1_010, 1)).unwrap();
    model.place(2, &limit(Side::Ask, 1_000, 1)).unwrap();
    model.place(1, &limit(Side::Ask, 1_000, 1)).unwrap();

    let outcome = model.place(3, &ioc(Side::Bid, 1_010, 3)).unwrap();

    let makers: Vec<(u64, u32)> = outcome
        .fills
        .iter()
        .map(|fill| (fill.price, fill.maker_seat))
        .collect();
    assert_eq!(makers, vec![(1_000, 2), (1_000, 1), (1_010, 1)]);
}

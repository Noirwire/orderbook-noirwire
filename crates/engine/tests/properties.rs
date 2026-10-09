//! RULES 13 under long random histories. Three markets (one spot, two perps), eight
//! seats including the fee and insurance seats, every entry point, moving prices,
//! stale feeds, funding and liquidations. `World` asserts after every single call:
//! custody per token, byte-for-byte no change on a refused call or a refused outcome,
//! total long equals total short, collateral conservation, locks and open-order counts
//! against the resting orders, sorted books and seat versions.

mod common;

use common::*;
use noirwire_orderbook_engine::EngineError as E;
use noirwire_orderbook_engine::*;
use proptest::prelude::*;
use proptest::test_runner::{Config, RngAlgorithm, TestRng, TestRunner};
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};

const SEAT_CAPACITY: u32 = 8;
const FIRST_TRADER: u32 = 2;
const LAST_TRADER: u32 = 7;
const BOOK_CAPACITY: usize = 6;
const MARKET_COUNT: usize = 3;
const WRONG_KEY: [u8; 32] = [0xCD; 32];

#[derive(Clone, Debug)]
enum Op {
    Place {
        market: usize,
        seat: u32,
        side: Side,
        order_type: OrderType,
        level: i64,
        size: u64,
        reduce_only: bool,
        wrong_key: bool,
        secret: u8,
    },
    Cancel {
        market: usize,
        seat: u32,
        pick: usize,
    },
    CancelAll {
        market: usize,
        seat: u32,
        max_cancels: u32,
    },
    Deposit {
        seat: u32,
        asset: Asset,
        amount: u64,
    },
    Withdraw {
        seat: u32,
        asset: Asset,
        amount: u64,
        wrong_key: bool,
    },
    MovePrice {
        market: usize,
        bps: i64,
    },
    /// Many small price updates at once: the mark as it stands after a fast market.
    GapPrice {
        market: usize,
        bps: i64,
    },
    RefreshPrices,
    Wait {
        seconds: i64,
    },
    Fund {
        market: usize,
    },
    Liquidate {
        market: usize,
        liquidator: u32,
        target: u32,
        size: u64,
    },
    LiquidateWhoeverIsUnderwater {
        market: usize,
        liquidator: u32,
        size: u64,
    },
    Open,
    Close {
        seat: u32,
    },
    SetPaused(bool),
    Resume {
        market: usize,
    },
    Reconcile,
    ResetPrice {
        market: usize,
        price: u64,
    },
    CoverShortfall {
        market: usize,
        seat: u32,
    },
    MoveFees {
        amount: u64,
    },
    CollectFees {
        asset: Asset,
        amount: u64,
    },
    Snapshot {
        market: usize,
        seat: u32,
    },
}

fn any_market() -> impl Strategy<Value = usize> {
    0..MARKET_COUNT
}

fn any_seat() -> impl Strategy<Value = u32> {
    prop_oneof![1 => 0..SEAT_CAPACITY, 4 => FIRST_TRADER..LAST_TRADER]
}

fn any_asset() -> impl Strategy<Value = Asset> {
    prop_oneof![
        3 => Just(Asset::Collateral),
        2 => Just(Asset::Spot(QUOTE)),
        2 => Just(Asset::Spot(BASE)),
        1 => (0u8..6).prop_map(Asset::Spot),
    ]
}

fn any_order_type() -> impl Strategy<Value = OrderType> {
    prop_oneof![
        5 => Just(OrderType::Limit),
        1 => Just(OrderType::PostOnly),
        3 => Just(OrderType::ImmediateOrCancel),
        2 => Just(OrderType::Market),
    ]
}

fn any_place() -> impl Strategy<Value = Op> {
    let level = prop_oneof![9 => -6i64..=6, 1 => -80i64..=80];
    let size = prop_oneof![9 => 1u64..10, 1 => 0u64..400];
    let flags = (prop::bool::weighted(0.08), prop::bool::weighted(0.03));
    let who = (any_market(), any_seat(), any::<u8>());
    let what = (
        prop_oneof![Just(Side::Bid), Just(Side::Ask)],
        any_order_type(),
        level,
        size,
    );
    (who, what, flags).prop_map(
        |((market, seat, secret), (side, order_type, level, size), (reduce_only, wrong_key))| {
            Op::Place {
                market,
                seat,
                side,
                order_type,
                level,
                size,
                reduce_only,
                wrong_key,
                secret,
            }
        },
    )
}

fn any_op() -> impl Strategy<Value = Op> {
    let amount = prop_oneof![8 => 1u64..4_000, 2 => 0u64..200_000];
    let cancel = (any_market(), any_seat(), 0usize..12)
        .prop_map(|(market, seat, pick)| Op::Cancel { market, seat, pick });
    let cancel_all =
        (any_market(), any_seat(), 0u32..5).prop_map(|(market, seat, max_cancels)| Op::CancelAll {
            market,
            seat,
            max_cancels,
        });
    let deposit =
        (any_seat(), any_asset(), amount.clone()).prop_map(|(seat, asset, amount)| Op::Deposit {
            seat,
            asset,
            amount,
        });
    let withdraw = (any_seat(), any_asset(), amount, prop::bool::weighted(0.03)).prop_map(
        |(seat, asset, amount, wrong_key)| Op::Withdraw {
            seat,
            asset,
            amount,
            wrong_key,
        },
    );
    let bps = prop_oneof![19 => -280i64..280, 1 => -9_000i64..9_000];
    let move_price = (any_market(), bps).prop_map(|(market, bps)| Op::MovePrice { market, bps });
    let gap =
        (any_market(), -1_500i64..1_500).prop_map(|(market, bps)| Op::GapPrice { market, bps });
    let wait =
        prop_oneof![9 => 0i64..15, 1 => 0i64..4_000].prop_map(|seconds| Op::Wait { seconds });
    let liquidate = (any_market(), any_seat(), any_seat(), 0u64..40).prop_map(
        |(market, liquidator, target, size)| Op::Liquidate {
            market,
            liquidator,
            target,
            size,
        },
    );
    let liquidate_underwater =
        (any_market(), any_seat(), 1u64..40).prop_map(|(market, liquidator, size)| {
            Op::LiquidateWhoeverIsUnderwater {
                market,
                liquidator,
                size,
            }
        });
    let snapshot =
        (any_market(), any_seat()).prop_map(|(market, seat)| Op::Snapshot { market, seat });
    let reset = (any_market(), 0u64..3_000).prop_map(|(market, price)| {
        let price = price / 10 * 10;
        Op::ResetPrice { market, price }
    });
    let cover =
        (any_market(), any_seat()).prop_map(|(market, seat)| Op::CoverShortfall { market, seat });
    let collect =
        (any_asset(), 0u64..40).prop_map(|(asset, amount)| Op::CollectFees { asset, amount });
    prop_oneof![
        40 => any_place(),
        6 => cancel,
        3 => cancel_all,
        5 => deposit,
        6 => withdraw,
        8 => move_price,
        5 => gap,
        8 => Just(Op::RefreshPrices),
        3 => wait,
        4 => any_market().prop_map(|market| Op::Fund { market }),
        3 => liquidate,
        10 => liquidate_underwater,
        1 => Just(Op::Open),
        1 => any_seat().prop_map(|seat| Op::Close { seat }),
        1 => prop::bool::weighted(0.15).prop_map(Op::SetPaused),
        3 => any_market().prop_map(|market| Op::Resume { market }),
        2 => Just(Op::Reconcile),
        1 => reset,
        4 => cover,
        1 => (0u64..40).prop_map(|amount| Op::MoveFees { amount }),
        1 => collect,
        2 => snapshot,
    ]
}

fn world() -> World {
    let mut w = World::new(SEAT_CAPACITY as usize, BOOK_CAPACITY);
    w.max_steps = 3;
    let mut spot = spot_params(0);
    spot.max_open_orders = 3;
    let mut tight = perp_params(1);
    tight.max_open_orders = 3;
    tight.open_interest_cap = 40;
    tight.fee_insurance_share_bps = 2_500;
    let mut loose = perp_params(2);
    loose.tick = 5;
    loose.im_bps = 2_000;
    loose.mm_bps = 1_000;
    loose.taker_fee_bps = 7;
    loose.liq_penalty_bps = 250;
    loose.liq_buffer_bps = 150;
    loose.liq_insurance_share_bps = 5_000;
    loose.band_bps = 800;
    loose.max_move_bps = 600;
    loose.funding_interval = 600;
    loose.funding_cap_bps = 100;
    for params in [spot, tight, loose] {
        w.add_market(params);
    }
    w.deposit(INSURANCE_SEAT, Asset::Collateral, 150).unwrap();
    for collateral in [1_200, 2_000, 4_000, 30_000, 200_000] {
        let trader = w.open();
        w.deposit(trader, Asset::Collateral, collateral).unwrap();
        w.deposit(trader, Asset::Spot(QUOTE), 600_000).unwrap();
        w.deposit(trader, Asset::Spot(BASE), 60_000).unwrap();
    }
    w
}

#[derive(Debug, Default)]
struct Seen {
    ops: usize,
    fills: usize,
    statuses: BTreeSet<u8>,
    liquidation_statuses: BTreeSet<u8>,
    shortfalls_covered: usize,
    reconciled: usize,
    fee_moves: usize,
    resumes: usize,
    errors: BTreeMap<u32, usize>,
    liquidations: usize,
    insurance_payments: usize,
    uncovered: usize,
    funding_updates: usize,
    index_moves: usize,
    spot_fills: usize,
    perp_fills: usize,
    closes: usize,
}

impl Seen {
    fn note<T>(&mut self, result: &EngineResult<T>) {
        if let Err(error) = result {
            *self.errors.entry(error.code()).or_default() += 1;
        }
    }
}

fn order_price(w: &World, market: usize, level: i64) -> u64 {
    let state = &w.markets[market];
    let tick = state.params.tick as i64;
    let on_tick = state.price.price as i64 / tick * tick;
    (on_tick + level * tick).max(0) as u64
}

fn first_underwater(w: &World, market: usize) -> Option<u32> {
    let risks = w.risks();
    (0..SEAT_CAPACITY).find(|seat| {
        let state = w.seat(*seat);
        let holds = state.perp[market].base != 0;
        holds && state.is_open() && is_liquidatable(state, &risks, market, w.now) == Ok(true)
    })
}

fn apply(w: &mut World, op: &Op, seen: &mut Seen) {
    seen.ops += 1;
    match *op {
        Op::Place {
            market,
            seat,
            side,
            order_type,
            level,
            size,
            reduce_only,
            wrong_key,
            secret,
        } => {
            let new_order = NewOrder {
                side,
                order_type,
                price: order_price(w, market, level),
                size,
                secret: [secret; 16],
                reduce_only,
                expiry: match secret % 5 {
                    0 => w.now + i64::from(secret % 40),
                    _ => 0,
                },
            };
            let key = if wrong_key { WRONG_KEY } else { w.key(seat) };
            let result = w.place_as(market, seat, key, new_order);
            seen.note(&result);
            if let Ok(outcome) = result {
                let fills = w.fills.as_slice().len();
                seen.fills += fills;
                seen.statuses.insert(outcome.status.code());
                match w.markets[market].params.kind {
                    KIND_SPOT => seen.spot_fills += fills,
                    _ => seen.perp_fills += fills,
                }
            }
        }
        Op::Cancel { market, seat, pick } => {
            let state = &w.markets[market];
            let mut resting = state.resting(Side::Bid);
            resting.extend(state.resting(Side::Ask));
            let sequence = resting
                .get(pick)
                .map(|order| order.sequence)
                .unwrap_or(pick as u64);
            let result = w.cancel(market, seat, sequence);
            seen.note(&result);
        }
        Op::CancelAll {
            market,
            seat,
            max_cancels,
        } => {
            let open_before = w.seat(seat).open_orders[market];
            let result = w.cancel_all(market, seat, max_cancels);
            seen.note(&result);
            if let Ok(cancelled) = result {
                assert_eq!(cancelled, u32::from(open_before).min(max_cancels));
            }
        }
        Op::Deposit {
            seat,
            asset,
            amount,
        } => {
            let result = w.deposit(seat, asset, amount);
            seen.note(&result);
        }
        Op::Withdraw {
            seat,
            asset,
            amount,
            wrong_key,
        } => {
            let key = if wrong_key { WRONG_KEY } else { w.key(seat) };
            let result = w.withdraw_as(seat, key, asset, amount);
            seen.note(&result);
        }
        Op::MovePrice { market, bps } => {
            let mark = w.markets[market].price.price as i64;
            let moved = (mark * (10_000 + bps) / 10_000).max(1) as u64;
            w.now += 1;
            let result = w.publish(market, moved, w.now);
            seen.note(&result);
        }
        Op::GapPrice { market, bps } => {
            let mark = w.markets[market].price.price as i64;
            let moved = (mark * (10_000 + bps) / 10_000).max(1) as u64;
            w.set_price(market, moved);
        }
        Op::RefreshPrices => {
            w.now += 1;
            for market in 0..MARKET_COUNT {
                let mark = w.markets[market].price.price;
                let result = w.publish(market, mark, w.now);
                seen.note(&result);
            }
        }
        Op::ResetPrice { market, price } => {
            let result = w.reset(market, price, w.now);
            seen.note(&result);
        }
        Op::CoverShortfall { market, seat } => {
            let owes = |seat: &u32| {
                let state = w.seat(*seat);
                state.collateral < 0 && state.perp.iter().all(|slot| slot.base == 0)
            };
            let debtor = (0..SEAT_CAPACITY).find(owes);
            if seat % 2 == 0 && debtor.is_some() {
                w.deposit(INSURANCE_SEAT, Asset::Collateral, 400).unwrap();
            }
            let seat = debtor.unwrap_or(seat);
            let recorded = w.markets[market].params.uncovered_shortfall;
            let result = w.cover_shortfall(market, seat);
            seen.note(&result);
            let paid = result.unwrap();
            seen.shortfalls_covered += usize::from(paid > 0);
            let recorded_after = w.markets[market].params.uncovered_shortfall;
            assert_eq!(recorded_after, recorded - paid);
        }
        Op::MoveFees { amount } => {
            let result = w.move_fees_to_insurance(amount);
            seen.note(&result);
            seen.fee_moves += usize::from(result.is_ok());
        }
        Op::CollectFees { asset, amount } => {
            let result = w.collect_fees(asset, amount);
            seen.note(&result);
            seen.fee_moves += usize::from(result.is_ok());
        }
        Op::Wait { seconds } => w.now += seconds,
        Op::Fund { market } => {
            let index_before = w.markets[market].book.funding_index;
            let result = w.fund(market);
            seen.note(&result);
            if result == Ok(true) {
                seen.funding_updates += 1;
                assert_eq!(w.markets[market].book.last_funding_time, w.now);
                let moved = w.markets[market].book.funding_index != index_before;
                seen.index_moves += usize::from(moved);
            } else {
                assert_eq!(w.markets[market].book.funding_index, index_before);
            }
        }
        Op::Liquidate {
            market,
            liquidator,
            target,
            size,
        } => {
            let result = w.liquidate(market, liquidator, target, size);
            seen.note(&result);
            note_liquidation(w, market, target, size, &result, seen);
        }
        Op::LiquidateWhoeverIsUnderwater {
            market,
            liquidator,
            size,
        } => {
            if let Some(target) = first_underwater(w, market) {
                let target_is_long = w.slot(target, market).base > 0;
                let refuses_any_price = size % 5 == 0;
                let worst_price = match (target_is_long, refuses_any_price) {
                    (true, false) | (false, true) => u64::MAX,
                    (true, true) | (false, false) => 0,
                };
                let request = LiquidationRequest {
                    target,
                    size,
                    worst_price,
                };
                let key = w.key(liquidator);
                let result = w.liquidate_with(market, liquidator, key, request);
                seen.note(&result);
                if let Ok(outcome) = &result {
                    let refused = outcome.status == LiquidationStatus::WorstPriceExceeded;
                    assert_eq!(refused, refuses_any_price);
                }
                note_liquidation(w, market, target, size, &result, seen);
            }
        }
        Op::Open => {
            let result = w.try_open();
            seen.note(&result);
        }
        Op::Close { seat } => {
            let result = w.close(seat);
            seen.note(&result);
            seen.closes += usize::from(result.is_ok());
        }
        Op::SetPaused(paused) => w.paused = paused,
        Op::Reconcile => {
            let owes = |seat: &u32| {
                let state = w.seat(*seat);
                state.collateral < 0 && state.perp.iter().all(|slot| slot.base == 0)
            };
            if let Some(debtor) = (0..SEAT_CAPACITY).find(owes) {
                w.deposit(debtor, Asset::Collateral, 50).unwrap();
            }
            let removed = w.reconcile();
            seen.reconciled += usize::from(removed > 0);
            assert_eq!(w.reconcile(), 0);
        }
        Op::Resume { market } => {
            let recorded = w.markets[market].params.uncovered_shortfall;
            let result = w.resume(market);
            seen.note(&result);
            assert_eq!(result.is_ok(), recorded == 0);
            seen.resumes += usize::from(result.is_ok());
        }
        Op::Snapshot { market, seat } => {
            let result = w.snapshot_as(market, seat, w.key(seat));
            if let Ok(snapshot) = result {
                assert_eq!(snapshot.seat, *w.seat(seat));
                let open = w.seat(seat).open_orders[market];
                assert_eq!(snapshot.order_count, u32::from(open));
            }
        }
    }
}

/// RULES 13.9: the right side and size moved, and the shortfall order was followed.
fn note_liquidation(
    w: &World,
    market: usize,
    target: u32,
    size: u64,
    result: &EngineResult<LiquidationOutcome>,
    seen: &mut Seen,
) {
    let Ok(outcome) = result else {
        return;
    };
    seen.liquidation_statuses.insert(outcome.status.code());
    if outcome.status != LiquidationStatus::Liquidated {
        return;
    }
    seen.liquidations += 1;
    assert!(outcome.liquidated > 0 && outcome.liquidated <= size);
    assert_eq!(w.seat(target).open_orders[market], 0);
    let mark = w.markets[market].price.price;
    assert_ne!(outcome.price, mark);
    let flat = w.seat(target).perp.iter().all(|slot| slot.base == 0);
    if outcome.insurance_paid > 0 {
        seen.insurance_payments += 1;
        assert!(flat);
    }
    if outcome.uncovered > 0 {
        seen.uncovered += 1;
        assert!(flat);
        assert_eq!(w.collateral(INSURANCE_SEAT).max(0), 0);
        assert_eq!(w.collateral(target), -(outcome.uncovered as i64));
        assert_eq!(w.markets[market].params.status, STATUS_REDUCE_ONLY);
    } else if flat {
        assert!(w.collateral(target) >= 0);
    }
}

fn run(seed: u8, cases: u32) -> Seen {
    let config = Config {
        cases,
        failure_persistence: None,
        ..Config::default()
    };
    let rng = TestRng::from_seed(RngAlgorithm::ChaCha, &[seed; 32]);
    let mut runner = TestRunner::new_with_rng(config, rng);
    let seen = RefCell::new(Seen::default());
    let histories = prop::collection::vec(any_op(), 40..220);

    runner
        .run(&histories, |ops| {
            let mut w = world();
            for op in &ops {
                apply(&mut w, op, &mut seen.borrow_mut());
                for state in &w.markets {
                    let within_cap = state.book.open_interest <= state.params.open_interest_cap;
                    assert!(within_cap, "RULES 6 open interest cap");
                }
            }
            Ok(())
        })
        .unwrap();

    let seen = seen.into_inner();
    eprintln!("seed {seed}: {seen:?}");
    seen
}

/// A history that never reached the interesting branches would prove nothing, so
/// each run also has to show that it did.
fn assert_everything_was_exercised(seen: &Seen) {
    assert!(seen.spot_fills > 1_000, "spot fills {}", seen.spot_fills);
    assert!(seen.perp_fills > 1_000, "perp fills {}", seen.perp_fills);
    assert_eq!(seen.statuses, BTreeSet::from([1, 2, 3, 4, 5, 6, 7]));
    assert!(seen.reconciled > 0, "reconciled {}", seen.reconciled);
    let every_liquidation_status = BTreeSet::from([1, 2, 3, 4, 5, 6, 7]);
    assert_eq!(seen.liquidation_statuses, every_liquidation_status);
    assert!(seen.shortfalls_covered > 2, "{}", seen.shortfalls_covered);
    assert!(seen.fee_moves > 0 && seen.resumes > 0);
    assert!(seen.liquidations > 50, "liquidations {}", seen.liquidations);
    assert!(seen.insurance_payments > 5, "{}", seen.insurance_payments);
    assert!(seen.uncovered > 5, "uncovered {}", seen.uncovered);
    assert!(seen.funding_updates > 50, "{}", seen.funding_updates);
    assert!(seen.index_moves > 10, "index moves {}", seen.index_moves);
    assert!(seen.closes > 0, "closes {}", seen.closes);
    let expected_errors = [
        E::NotSeatOwner,
        E::SeatNotOpen,
        E::SeatTableFull,
        E::SeatNotEmpty,
        E::InsufficientBalance,
        E::InsufficientCollateral,
        E::InsufficientMargin,
        E::ExchangePaused,
        E::MarketReduceOnly,
        E::SizeTooSmall,
        E::PriceOutsideBand,
        E::StalePrice,
        E::TooManyOpenOrders,
        E::ReduceOnlyWouldIncrease,
        E::OrderNotFound,
        E::ReservedSeat,
        E::ShortfallOutstanding,
        E::NotPerpMarket,
        E::PriceMoveTooLarge,
    ];
    for error in expected_errors {
        let seen_it = seen.errors.contains_key(&error.code());
        assert!(seen_it, "never saw {error:?}");
    }
    assert!(!seen.errors.contains_key(&E::InvariantBroken.code()));
    assert!(!seen.errors.contains_key(&E::JournalFull.code()));
}

#[test]
fn invariants_hold_after_every_operation_seed_1() {
    assert_everything_was_exercised(&run(1, 1_400));
}

#[test]
fn invariants_hold_after_every_operation_seed_2() {
    assert_everything_was_exercised(&run(2, 1_400));
}

#[test]
fn invariants_hold_after_every_operation_seed_3() {
    assert_everything_was_exercised(&run(3, 1_400));
}

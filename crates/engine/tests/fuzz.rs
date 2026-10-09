//! Hostile arguments. Every numeric argument of every entry point is drawn from the
//! extremes (0, 1, the type's maximum, `i64::MIN` reinterpreted) mixed with arbitrary
//! and small values. The engine must never panic, and `World` asserts after each call
//! that a refused call changed nothing and that every invariant still holds. The
//! second test also draws the market settings themselves from the extremes.

mod common;

use common::*;
use noirwire_orderbook_engine::*;
use proptest::prelude::*;
use proptest::test_runner::{Config, RngAlgorithm, TestRng, TestRunner};
use std::cell::Cell;

const SEAT_CAPACITY: usize = 6;
const BOOK_CAPACITY: usize = 4;

fn hostile_u64() -> BoxedStrategy<u64> {
    let extremes = prop_oneof![
        Just(0),
        Just(1),
        Just(u64::MAX),
        Just(u64::MAX - 1),
        Just(i64::MAX as u64),
        Just(i64::MIN as u64),
        Just(1 << 32),
        Just(u64::from(u32::MAX)),
    ];
    let near_the_mark = (95u64..106).prop_map(|level| level * 10);
    prop_oneof![
        8 => extremes,
        2 => any::<u64>(),
        5 => 0u64..3_000,
        5 => near_the_mark,
    ]
    .boxed()
}

fn hostile_i64() -> BoxedStrategy<i64> {
    let extremes = prop_oneof![
        Just(0),
        Just(1),
        Just(-1),
        Just(i64::MAX),
        Just(i64::MIN),
        any::<i64>(),
    ];
    prop_oneof![
        6 => extremes,
        6 => (START - 100)..(START + 10_000),
    ]
    .boxed()
}

fn hostile_u32() -> BoxedStrategy<u32> {
    let extremes = prop_oneof![Just(0), Just(1), Just(u32::MAX), any::<u32>()];
    prop_oneof![
        4 => extremes,
        8 => 0u32..(SEAT_CAPACITY as u32 + 2),
    ]
    .boxed()
}

fn hostile_u16() -> impl Strategy<Value = u16> {
    prop_oneof![
        Just(0),
        Just(1),
        Just(u16::MAX),
        Just(10_000),
        any::<u16>(),
        0u16..600
    ]
}

fn hostile_asset() -> impl Strategy<Value = Asset> {
    prop_oneof![
        Just(Asset::Collateral),
        any::<u8>().prop_map(Asset::Spot),
        (0u8..3).prop_map(Asset::Spot),
    ]
}

#[derive(Clone, Debug)]
enum Call {
    Place {
        market: usize,
        seat: u32,
        side: Side,
        order_type: OrderType,
        price: u64,
        size: u64,
        reduce_only: bool,
    },
    Cancel {
        market: usize,
        seat: u32,
        order_seq: u64,
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
    },
    Liquidate {
        market: usize,
        liquidator: u32,
        target: u32,
        size: u64,
    },
    Publish {
        market: usize,
        price: u64,
        publish_time: i64,
    },
    Reset {
        market: usize,
        price: u64,
        publish_time: i64,
    },
    Fund {
        market: usize,
    },
    SetClock(i64),
    SetStepLimit(u32),
    SetFundingIndex {
        market: usize,
        index: i64,
    },
    Open,
    Close {
        seat: u32,
    },
    Snapshot {
        market: usize,
        seat: u32,
    },
}

fn any_call(markets: usize) -> impl Strategy<Value = Call> {
    let market = 0..markets;
    let order_type = prop_oneof![
        Just(OrderType::Limit),
        Just(OrderType::PostOnly),
        Just(OrderType::ImmediateOrCancel),
        Just(OrderType::Market),
    ];
    let side = prop_oneof![Just(Side::Bid), Just(Side::Ask)];
    let who = (market.clone(), hostile_u32());
    let amounts = (hostile_u64(), hostile_u64(), any::<bool>());
    let what = (side, order_type, amounts).prop_map(|(side, order_type, amounts)| {
        let (price, size, reduce_only) = amounts;
        (side, order_type, price, size, reduce_only)
    });
    let place = (who, what).prop_map(
        |((market, seat), (side, order_type, price, size, reduce_only))| Call::Place {
            market,
            seat,
            side,
            order_type,
            price,
            size,
            reduce_only,
        },
    );
    let cancel =
        (market.clone(), hostile_u32(), hostile_u64()).prop_map(|(market, seat, order_seq)| {
            Call::Cancel {
                market,
                seat,
                order_seq,
            }
        });
    let cancel_all =
        (market.clone(), hostile_u32(), hostile_u32()).prop_map(|(market, seat, max_cancels)| {
            Call::CancelAll {
                market,
                seat,
                max_cancels,
            }
        });
    let deposit =
        (hostile_u32(), hostile_asset(), hostile_u64()).prop_map(|(seat, asset, amount)| {
            Call::Deposit {
                seat,
                asset,
                amount,
            }
        });
    let withdraw =
        (hostile_u32(), hostile_asset(), hostile_u64()).prop_map(|(seat, asset, amount)| {
            Call::Withdraw {
                seat,
                asset,
                amount,
            }
        });
    let liquidate = (market.clone(), hostile_u32(), hostile_u32(), hostile_u64()).prop_map(
        |(market, liquidator, target, size)| Call::Liquidate {
            market,
            liquidator,
            target,
            size,
        },
    );
    let publish =
        (market.clone(), hostile_u64(), hostile_i64()).prop_map(|(market, price, publish_time)| {
            Call::Publish {
                market,
                price,
                publish_time,
            }
        });
    let reset =
        (market.clone(), hostile_u64(), hostile_i64()).prop_map(|(market, price, publish_time)| {
            Call::Reset {
                market,
                price,
                publish_time,
            }
        });
    let funding_index = (market.clone(), hostile_i64())
        .prop_map(|(market, index)| Call::SetFundingIndex { market, index });
    let snapshot =
        (market.clone(), hostile_u32()).prop_map(|(market, seat)| Call::Snapshot { market, seat });
    prop_oneof![
        30 => place,
        4 => cancel,
        3 => cancel_all,
        8 => deposit,
        6 => withdraw,
        6 => liquidate,
        4 => publish,
        2 => reset,
        3 => market.prop_map(|market| Call::Fund { market }),
        2 => hostile_i64().prop_map(Call::SetClock),
        1 => hostile_u32().prop_map(Call::SetStepLimit),
        1 => funding_index,
        1 => Just(Call::Open),
        1 => hostile_u32().prop_map(|seat| Call::Close { seat }),
        2 => snapshot,
    ]
}

/// Returns whether the engine accepted the call.
fn apply(w: &mut World, call: &Call) -> bool {
    match *call {
        Call::Place {
            market,
            seat,
            side,
            order_type,
            price,
            size,
            reduce_only,
        } => {
            let new_order = NewOrder {
                side,
                order_type,
                price,
                size,
                secret: [3; 16],
                reduce_only,
            };
            w.place(market, seat, new_order).is_ok()
        }
        Call::Cancel {
            market,
            seat,
            order_seq,
        } => w.cancel(market, seat, order_seq).is_ok(),
        Call::CancelAll {
            market,
            seat,
            max_cancels,
        } => w.cancel_all(market, seat, max_cancels).is_ok(),
        Call::Deposit {
            seat,
            asset,
            amount,
        } => w.deposit(seat, asset, amount).is_ok(),
        Call::Withdraw {
            seat,
            asset,
            amount,
        } => w.withdraw(seat, asset, amount).is_ok(),
        Call::Liquidate {
            market,
            liquidator,
            target,
            size,
        } => w.liquidate(market, liquidator, target, size).is_ok(),
        Call::Publish {
            market,
            price,
            publish_time,
        } => w.publish(market, price, publish_time).is_ok(),
        Call::Reset {
            market,
            price,
            publish_time,
        } => w.reset(market, price, publish_time).is_ok(),
        Call::Fund { market } => w.fund(market).is_ok(),
        Call::SetClock(now) => {
            w.now = now;
            true
        }
        Call::SetStepLimit(max_steps) => {
            w.max_steps = max_steps;
            true
        }
        Call::SetFundingIndex { market, index } => w.set_funding_index(market, index),
        Call::Open => w.try_open().is_ok(),
        Call::Close { seat } => w.close(seat).is_ok(),
        Call::Snapshot { market, seat } => w.snapshot_as(market, seat, w.key(seat)).is_ok(),
    }
}

fn funded_world(markets: &[MarketParams]) -> World {
    let mut w = World::new(SEAT_CAPACITY, BOOK_CAPACITY);
    for params in markets {
        w.add_market(*params);
    }
    for amount in [5_000u64, 1 << 40, i64::MAX as u64 / 4] {
        let trader = w.open();
        w.deposit(trader, Asset::Collateral, amount).unwrap();
        w.deposit(trader, Asset::Spot(QUOTE), amount).unwrap();
        w.deposit(trader, Asset::Spot(BASE), amount).unwrap();
    }
    w.deposit(INSURANCE_SEAT, Asset::Collateral, 1_000).unwrap();
    w
}

fn runner(seed: u8, cases: u32) -> TestRunner {
    let config = Config {
        cases,
        failure_persistence: None,
        ..Config::default()
    };
    let rng = TestRng::from_seed(RngAlgorithm::ChaCha, &[seed; 32]);
    TestRunner::new_with_rng(config, rng)
}

#[test]
fn hostile_arguments_never_panic_and_a_refused_call_changes_nothing() {
    let markets = [spot_params(0), perp_params(1)];
    let calls = prop::collection::vec(any_call(markets.len()), 1..150);
    let accepted = Cell::new(0usize);
    let refused = Cell::new(0usize);

    runner(21, 1_500)
        .run(&calls, |calls| {
            let mut w = funded_world(&markets);
            for call in &calls {
                let counter = if apply(&mut w, call) {
                    &accepted
                } else {
                    &refused
                };
                counter.set(counter.get() + 1);
            }
            Ok(())
        })
        .unwrap();

    assert!(accepted.get() > 20_000, "accepted {}", accepted.get());
    assert!(refused.get() > 20_000, "refused {}", refused.get());
}

fn hostile_params(kind: u8, market_id: u8) -> impl Strategy<Value = MarketParams> {
    let sizes = (hostile_u64(), hostile_u64(), hostile_u64(), hostile_u64());
    let times = (hostile_i64(), hostile_i64());
    let risk = (
        hostile_u16(),
        hostile_u16(),
        hostile_u16(),
        hostile_u16(),
        hostile_u16(),
        hostile_u16(),
    );
    let limits = (hostile_u16(), 0u16..40, 0u8..4);
    (sizes, times, risk, limits).prop_map(move |(sizes, times, risk, limits)| MarketParams {
        tick: sizes.0,
        base_lot: sizes.1,
        min_size: sizes.2,
        min_notional: sizes.3,
        funding_interval: times.0,
        max_price_age: times.1,
        band_bps: risk.0,
        im_bps: risk.1,
        mm_bps: risk.2,
        taker_fee_bps: risk.3,
        liq_penalty_bps: risk.4,
        funding_cap_bps: risk.5,
        max_move_bps: limits.0,
        max_open_orders: limits.1,
        status: limits.2,
        ..if kind == KIND_SPOT {
            spot_params(market_id)
        } else {
            perp_params(market_id)
        }
    })
}

#[test]
fn hostile_market_settings_never_panic_and_a_refused_call_changes_nothing() {
    let settings = (
        hostile_params(KIND_SPOT, 0),
        hostile_params(KIND_PERP, 1),
        prop::bool::weighted(0.6),
    );
    let calls = prop::collection::vec(any_call(2), 1..80);
    let accepted = Cell::new(0usize);

    runner(22, 1_500)
        .run(&(settings, calls), |((spot, perp, tame), calls)| {
            let markets = if tame {
                [tamed(spot, spot_params(0)), tamed(perp, perp_params(1))]
            } else {
                [spot, perp]
            };
            let mut w = funded_world(&markets);
            for call in &calls {
                accepted.set(accepted.get() + usize::from(apply(&mut w, call)));
            }
            Ok(())
        })
        .unwrap();

    assert!(accepted.get() > 10_000, "accepted {}", accepted.get());
}

/// Keeps the hostile risk settings but restores the fields that would make the engine
/// refuse the market outright, so that hostile ratios are exercised by real trades.
fn tamed(mut hostile: MarketParams, sane: MarketParams) -> MarketParams {
    hostile.tick = sane.tick;
    hostile.base_lot = sane.base_lot;
    hostile.min_size = sane.min_size;
    hostile.min_notional = sane.min_notional;
    hostile.funding_interval = sane.funding_interval;
    hostile.max_price_age = sane.max_price_age;
    hostile.max_open_orders = sane.max_open_orders;
    hostile.status = STATUS_ACTIVE;
    hostile.taker_fee_bps %= 10_001;
    hostile.liq_penalty_bps %= 10_001;
    hostile
}

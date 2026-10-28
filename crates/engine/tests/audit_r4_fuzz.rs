//! Long random histories across the price source, the position caps,
//! eviction, funding, liquidation and withdrawals together. Two perps and one spot
//! market, each bound to a source that moves by random observations: within the move
//! limit, beyond it, stamped late, repeated, and settling. `World` checks after every
//! call that custody equals the seats per token, that the fee and insurance seats
//! hold no position and never owe, that open interest equals the long side, and that a
//! refused call changes nothing. This file adds the cross-feature rules of RULES 6, 8,
//! 9 and 11 on top, after every step.
//!
//! `PROPTEST_CASES` raises the case count above each test's own, and `R4_SALT` changes
//! the seeds.

mod common;

use bytemuck::Zeroable;
use common::*;
use noirwire_orderbook_engine::EngineError as E;
use noirwire_orderbook_engine::*;
use proptest::prelude::*;
use proptest::test_runner::{Config, RngAlgorithm, TestRng, TestRunner};
use std::cell::RefCell;
use std::collections::BTreeMap;

const SEAT_CAPACITY: u32 = 10;
const FIRST_TRADER: u32 = 2;
const BOOK_CAPACITY: usize = 4;
const PERPS: [usize; 2] = [0, 1];
const SPOT: usize = 2;
const MARKET_COUNT: usize = 3;
const WRONG_KEY: [u8; 32] = [0xCD; 32];
const COLLATERAL_MINT: usize = 0;

#[derive(Clone, Debug)]
enum Op {
    Wait(i64),
    Sync {
        market: usize,
        from_mark: bool,
        bps: i64,
        delay: i64,
        stamp_back: i64,
    },
    /// Several observations one second apart, each `bps` from the mark: a market that
    /// walks within the move limit, as Pyth does in a fast move.
    Trend {
        market: usize,
        bps: i64,
        steps: u8,
    },
    /// A gap a second observation confirms, then the keeper sweeping every seat at the
    /// settled mark (`SECURITY.md`, "Running a small mainnet market").
    GapAndSweep {
        market: usize,
        bps: i64,
        liquidator: u32,
    },
    Place {
        market: usize,
        seat: u32,
        side: Side,
        order_type: OrderType,
        level: i64,
        size: u64,
        reduce_only: bool,
        expires_in: i64,
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
    },
    Deposit {
        seat: u32,
        asset: Asset,
        amount: u64,
    },
    FundInsurance(u64),
    Withdraw {
        seat: u32,
        asset: Asset,
        amount: u64,
        wrong_key: bool,
    },
    Transfer {
        seat: u32,
        to_collateral: bool,
        amount: u64,
    },
    Liquidate {
        market: usize,
        liquidator: u32,
        target: u32,
        size: u64,
    },
    Keeper {
        market: usize,
        liquidator: u32,
        size: u64,
    },
    Fund(usize),
    Cover {
        market: usize,
        seat: u32,
    },
    Reconcile,
    Resume(usize),
    MoveFees(u64),
    CollectFees {
        asset: Asset,
        amount: u64,
    },
    SetCaps {
        market: usize,
        open_interest_cap: u64,
        position_cap: u64,
        max_move_bps: u16,
        min_publish_gap: u16,
        settle_window: i64,
    },
    Restrict {
        market: usize,
        paused: bool,
    },
    QuoteGuard(bool),
}

fn any_market() -> impl Strategy<Value = usize> {
    0..MARKET_COUNT
}

fn any_perp() -> impl Strategy<Value = usize> {
    prop_oneof![Just(PERPS[0]), Just(PERPS[1])]
}

fn any_seat() -> impl Strategy<Value = u32> {
    prop_oneof![1 => 0..SEAT_CAPACITY, 8 => FIRST_TRADER..SEAT_CAPACITY]
}

fn any_asset() -> impl Strategy<Value = Asset> {
    prop_oneof![
        4 => Just(Asset::Collateral),
        2 => Just(Asset::Spot(QUOTE)),
        2 => Just(Asset::Spot(BASE)),
    ]
}

fn any_sync() -> impl Strategy<Value = Op> {
    let bps = prop_oneof![
        24 => -250i64..=250,
        3 => -2_500i64..=2_500,
        1 => -6_000i64..=6_000,
        4 => Just(0i64),
    ];
    (
        any_market(),
        prop::bool::weighted(0.5),
        bps,
        prop_oneof![6 => 0i64..3, 1 => 0i64..60],
        prop_oneof![8 => Just(0i64), 2 => 0i64..4],
    )
        .prop_map(|(market, from_mark, bps, delay, stamp_back)| Op::Sync {
            market,
            from_mark,
            bps,
            delay,
            stamp_back,
        })
}

fn any_place() -> impl Strategy<Value = Op> {
    let level = prop_oneof![9 => -5i64..=5, 1 => -60i64..=60];
    let size = prop_oneof![9 => 1u64..12, 1 => 1u64..80];
    let order_type = prop_oneof![
        5 => Just(OrderType::Limit),
        1 => Just(OrderType::PostOnly),
        3 => Just(OrderType::ImmediateOrCancel),
        2 => Just(OrderType::Market),
    ];
    let who = (any_market(), any_seat(), any::<u8>());
    let what = (
        prop_oneof![Just(Side::Bid), Just(Side::Ask)],
        order_type,
        level,
        size,
    );
    let flags = (
        prop::bool::weighted(0.15),
        prop_oneof![4 => Just(0i64), 1 => 1i64..30],
    );
    (who, what, flags).prop_map(
        |((market, seat, secret), (side, order_type, level, size), (reduce_only, expires_in))| {
            Op::Place {
                market,
                seat,
                side,
                order_type,
                level,
                size,
                reduce_only,
                expires_in,
                secret,
            }
        },
    )
}

fn any_op() -> impl Strategy<Value = Op> {
    let amount = prop_oneof![8 => 1u64..3_000, 2 => 1u64..100_000];
    let wait = prop_oneof![9 => 0i64..5, 1 => 0i64..400].prop_map(Op::Wait);
    let cancel = (any_market(), any_seat(), 0usize..10)
        .prop_map(|(market, seat, pick)| Op::Cancel { market, seat, pick });
    let cancel_all =
        (any_market(), any_seat()).prop_map(|(market, seat)| Op::CancelAll { market, seat });
    let deposit =
        (any_seat(), any_asset(), amount.clone()).prop_map(|(seat, asset, amount)| Op::Deposit {
            seat,
            asset,
            amount,
        });
    let withdraw = (
        any_seat(),
        any_asset(),
        amount.clone(),
        prop::bool::weighted(0.03),
    )
        .prop_map(|(seat, asset, amount, wrong_key)| Op::Withdraw {
            seat,
            asset,
            amount,
            wrong_key,
        });
    let transfer =
        (any_seat(), any::<bool>(), amount.clone()).prop_map(|(seat, to_collateral, amount)| {
            Op::Transfer {
                seat,
                to_collateral,
                amount,
            }
        });
    let liquidate = (any_perp(), any_seat(), any_seat(), 1u64..40).prop_map(
        |(market, liquidator, target, size)| Op::Liquidate {
            market,
            liquidator,
            target,
            size,
        },
    );
    let keeper =
        (any_perp(), any_seat(), 1u64..60).prop_map(|(market, liquidator, size)| Op::Keeper {
            market,
            liquidator,
            size,
        });
    let cover = (any_perp(), any_seat()).prop_map(|(market, seat)| Op::Cover { market, seat });
    let collect =
        (any_asset(), 1u64..400).prop_map(|(asset, amount)| Op::CollectFees { asset, amount });
    let caps = (
        (any_market(), 1u64..120, 1u64..60),
        (1u16..700, 1u16..4, 1i64..120),
    )
        .prop_map(
            |((market, open_interest_cap, position_cap), (max_move_bps, gap, window))| {
                Op::SetCaps {
                    market,
                    open_interest_cap,
                    position_cap,
                    max_move_bps,
                    min_publish_gap: gap,
                    settle_window: window,
                }
            },
        );
    let restrict = (any_market(), prop::bool::weighted(0.3))
        .prop_map(|(market, paused)| Op::Restrict { market, paused });
    prop_oneof![
        40 => any_place(),
        18 => any_sync(),
        4 => (any_market(), -300i64..=300, 2u8..10)
            .prop_map(|(market, bps, steps)| Op::Trend { market, bps, steps }),
        3 => (
            any_perp(),
            prop_oneof![-3_000i64..-400, 400i64..3_000],
            FIRST_TRADER..SEAT_CAPACITY
        )
            .prop_map(|(market, bps, liquidator)| Op::GapAndSweep {
                market,
                bps,
                liquidator
            }),
        6 => wait,
        5 => cancel,
        2 => cancel_all,
        4 => deposit,
        1 => (1u64..2_000).prop_map(Op::FundInsurance),
        6 => withdraw,
        3 => transfer,
        3 => liquidate,
        8 => keeper,
        4 => any_perp().prop_map(Op::Fund),
        3 => cover,
        2 => Just(Op::Reconcile),
        12 => any_market().prop_map(Op::Resume),
        1 => (1u64..400).prop_map(Op::MoveFees),
        2 => collect,
        2 => caps,
        1 => restrict,
        1 => prop::bool::weighted(0.85).prop_map(Op::QuoteGuard),
    ]
}

/// A source quoted so that an observation's price is its target in quote atoms per lot:
/// a perp's lot is one atom, the spot market's lot is 100, so its binding divides by 100.
fn binding_for(market: usize) -> SourceBinding {
    SourceBinding {
        max_conf_bps: 100,
        base_decimals: if market == SPOT { 2 } else { 0 },
        ..SourceBinding::zeroed()
    }
}

#[derive(Debug, Default)]
struct Seen {
    fills: usize,
    dislocations: usize,
    settlements: usize,
    recoveries: usize,
    liquidations: usize,
    liquidations_while_settling: usize,
    insurance_payments: usize,
    fee_seat_payments: usize,
    uncovered: usize,
    evictions: usize,
    funding_moves: usize,
    funding_discards: usize,
    cap_refusals: usize,
    collateral_withdrawals: usize,
    transfers: usize,
    errors: BTreeMap<u32, usize>,
}

impl Seen {
    fn note<T>(&mut self, result: &EngineResult<T>) {
        if let Err(error) = result {
            *self.errors.entry(error.code()).or_default() += 1;
        }
    }
}

struct Fuzz {
    w: World,
    feeds: Vec<PriceFeed>,
    /// RULES 7: a perp's source was dislocated or settling after some step since its
    /// last funding update that acted.
    unhealthy_since_funding: [bool; MARKET_COUNT],
}

impl Fuzz {
    fn new() -> Fuzz {
        let mut w = World::new(SEAT_CAPACITY as usize, BOOK_CAPACITY);
        w.max_steps = 4;
        let mut tight = perp_params(0);
        tight.max_open_orders = 4;
        tight.open_interest_cap = 60;
        tight.position_cap = 20;
        tight.settle_window = 30;
        tight.funding_interval = 60;
        tight.liq_buffer_bps = 100;
        tight.liq_insurance_share_bps = 5_000;
        tight.fee_insurance_share_bps = 5_000;
        let mut loose = perp_params(1);
        loose.tick = 5;
        loose.im_bps = 2_000;
        loose.mm_bps = 1_000;
        loose.taker_fee_bps = 7;
        loose.liq_penalty_bps = 250;
        loose.liq_buffer_bps = 150;
        loose.liq_insurance_share_bps = 2_500;
        loose.band_bps = 800;
        loose.max_move_bps = 600;
        loose.funding_interval = 120;
        loose.funding_cap_bps = 100;
        loose.open_interest_cap = 90;
        loose.position_cap = 35;
        loose.settle_window = 60;
        loose.max_open_orders = 4;
        let mut spot = spot_params(2);
        spot.max_open_orders = 3;
        spot.settle_window = 45;
        for params in [tight, loose, spot] {
            assert!(params.check().is_ok(), "{params:?}");
            w.add_market(params);
        }
        let feeds = (0..MARKET_COUNT)
            .map(|market| {
                let mut feed = PriceFeed::zeroed();
                feed.binding = binding_for(market);
                feed.price = w.markets[market].price;
                feed.source.publish_time = START;
                feed.source.target = MARK;
                feed.source.raw_price = MARK as i64;
                feed.source.observed_at = START;
                feed
            })
            .collect();
        let mut fuzz = Fuzz {
            w,
            feeds,
            unhealthy_since_funding: [false; MARKET_COUNT],
        };
        fuzz.w
            .deposit(INSURANCE_SEAT, Asset::Collateral, 300)
            .unwrap();
        for collateral in [300, 600, 1_200, 2_500, 6_000, 20_000, 90_000, 800] {
            let trader = fuzz.w.open();
            fuzz.w
                .deposit(trader, Asset::Collateral, collateral)
                .unwrap();
            fuzz.w.deposit(trader, Asset::Spot(QUOTE), 300_000).unwrap();
            fuzz.w.deposit(trader, Asset::Spot(BASE), 30_000).unwrap();
        }
        fuzz
    }

    /// RULES 11: the collateral and the spot quote token share one mint and one custody
    /// account; the base token has its own.
    fn custody(&self, mint: usize) -> u128 {
        if mint == COLLATERAL_MINT {
            let collateral = u128::try_from(self.w.custody_collateral).unwrap();
            collateral + self.w.custody_spot[usize::from(QUOTE)]
        } else {
            self.w.custody_spot[usize::from(BASE)]
        }
    }

    fn incident_open(&self) -> bool {
        PERPS
            .iter()
            .any(|&m| self.w.markets[m].params.oracle_health != ORACLE_HEALTHY)
    }

    fn shortfall_recorded(&self) -> bool {
        self.w
            .markets
            .iter()
            .any(|state| state.params.uncovered_shortfall > 0)
    }

    fn health(&self, market: usize) -> u8 {
        self.w.markets[market].params.oracle_health
    }

    /// The perp markets where `seat` holds a position, with their health.
    fn positions(&self, seat: u32) -> Vec<(usize, u8)> {
        let Some(state) = self.w.seats.get(seat as usize) else {
            return Vec::new();
        };
        PERPS
            .iter()
            .filter(|&&m| state.perp()[m].base != 0)
            .map(|&m| (m, self.health(m)))
            .collect()
    }

    fn holds_on_dislocated(&self, seat: u32) -> bool {
        self.positions(seat)
            .iter()
            .any(|(_, health)| *health == ORACLE_DISLOCATED)
    }

    fn order_price(&self, market: usize, level: i64) -> u64 {
        let state = &self.w.markets[market];
        let tick = state.params.tick as i64;
        let mark = state.price.price as i64 / tick * tick;
        (mark + level * tick).max(tick) as u64
    }
}

fn grows(before: i64, after: i64) -> bool {
    let smaller_same_side = before.signum() == after.signum() && after.abs() < before.abs();
    after != 0 && !smaller_same_side
}

fn apply(f: &mut Fuzz, op: &Op, seen: &mut Seen) {
    let marks_before: Vec<Price> = f.w.markets.iter().map(|m| m.price).collect();
    let funding_before: Vec<(i64, i32)> =
        f.w.markets
            .iter()
            .map(|m| (m.book.funding_index, m.book.funding_carry))
            .collect();
    let health_before: Vec<u8> = (0..MARKET_COUNT).map(|m| f.health(m)).collect();
    let incident_before = f.incident_open();
    let shortfall_before = f.shortfall_recorded();
    let mut is_sync = false;
    let mut is_fund = false;

    match *op {
        Op::Wait(seconds) => f.w.now += seconds,
        Op::Sync {
            market,
            from_mark,
            bps,
            delay,
            stamp_back,
        } => {
            is_sync = true;
            f.w.now += delay;
            sync(f, market, from_mark, bps, stamp_back, seen);
        }
        Op::Trend { market, bps, steps } => {
            is_sync = true;
            for _ in 0..steps {
                f.w.now += 1;
                sync(f, market, true, bps, 0, seen);
                check_global(f, op, &marks_before, true, &funding_before, false);
            }
        }
        Op::GapAndSweep {
            market,
            bps,
            liquidator,
        } => {
            is_sync = true;
            for _ in 0..2 {
                f.w.now += 1;
                sync(f, market, true, bps, 0, seen);
                check_global(f, op, &marks_before, true, &funding_before, false);
            }
            for target in FIRST_TRADER..SEAT_CAPACITY {
                if target != liquidator {
                    liquidate(f, market, liquidator, target, 1_000, seen);
                    check_global(f, op, &marks_before, true, &funding_before, false);
                }
            }
        }
        Op::Place {
            market,
            seat,
            side,
            order_type,
            level,
            size,
            reduce_only,
            expires_in,
            secret,
        } => place(
            f,
            market,
            seat,
            NewOrder {
                side,
                order_type,
                price: f.order_price(market, level),
                size,
                secret: [secret; 16],
                reduce_only,
                expiry: if expires_in == 0 {
                    0
                } else {
                    f.w.now + expires_in
                },
            },
            seen,
        ),
        Op::Cancel { market, seat, pick } => {
            let state = &f.w.markets[market];
            let mut resting = state.resting(Side::Bid);
            resting.extend(state.resting(Side::Ask));
            let sequence = resting
                .get(pick)
                .map(|order| order.sequence)
                .unwrap_or(pick as u64);
            let result = f.w.cancel(market, seat, sequence);
            seen.note(&result);
        }
        Op::CancelAll { market, seat } => {
            let result = f.w.cancel_all(market, seat, 64);
            seen.note(&result);
        }
        Op::Deposit {
            seat,
            asset,
            amount,
        } => {
            if seat < FIRST_TRADER {
                return check_global(f, op, &marks_before, is_sync, &funding_before, is_fund);
            }
            let result = f.w.deposit(seat, asset, amount);
            seen.note(&result);
        }
        Op::FundInsurance(amount) => {
            let result = f.w.deposit(INSURANCE_SEAT, Asset::Collateral, amount);
            seen.note(&result);
        }
        Op::Withdraw {
            seat,
            asset,
            amount,
            wrong_key,
        } => {
            let key = if wrong_key { WRONG_KEY } else { f.w.key(seat) };
            let stale_or_dislocated = f.positions(seat).iter().any(|&(m, health)| {
                let state = &f.w.markets[m];
                let fresh = f.w.now - state.price.publish_time <= state.params.max_price_age;
                health == ORACLE_DISLOCATED || !fresh
            });
            let result = f.w.withdraw_as(seat, key, asset, amount);
            seen.note(&result);
            if result.is_ok() {
                assert!(
                    !stale_or_dislocated,
                    "RULES 9 withdrawal on a stale or dislocated feed"
                );
                if asset == Asset::Collateral {
                    seen.collateral_withdrawals += 1;
                    assert!(
                        !incident_before,
                        "RULES 9 I5 collateral left during an incident"
                    );
                    assert!(
                        !shortfall_before,
                        "RULES 6 collateral left with a shortfall"
                    );
                }
            }
        }
        Op::Transfer {
            seat,
            to_collateral,
            amount,
        } => {
            let (from, to) = if to_collateral {
                (Asset::Spot(QUOTE), Asset::Collateral)
            } else {
                (Asset::Collateral, Asset::Spot(QUOTE))
            };
            let mint_before = f.custody(COLLATERAL_MINT);
            let snapshot = f.w.clone();
            let result =
                f.w.withdraw(seat, from, amount)
                    .and_then(|()| f.w.deposit(seat, to, amount));
            seen.note(&result);
            if result.is_err() {
                f.w = snapshot;
            } else {
                seen.transfers += 1;
                assert_eq!(f.custody(COLLATERAL_MINT), mint_before, "no token moves");
                if !to_collateral {
                    assert!(!incident_before, "RULES 9 transfer out of collateral");
                    assert!(!shortfall_before, "RULES 6 transfer out of collateral");
                }
            }
        }
        Op::Liquidate {
            market,
            liquidator,
            target,
            size,
        } => liquidate(f, market, liquidator, target, size, seen),
        Op::Keeper {
            market,
            liquidator,
            size,
        } => {
            let risks = f.w.risks();
            let underwater = (FIRST_TRADER..SEAT_CAPACITY).find(|&seat| {
                seat != liquidator
                    && f.w.seat(seat).is_open()
                    && is_liquidatable(f.w.seat(seat), &risks, market, f.w.now) == Ok(true)
            });
            if let Some(target) = underwater {
                liquidate(f, market, liquidator, target, size, seen);
            }
        }
        Op::Fund(market) => {
            is_fund = true;
            let book = f.w.markets[market].book;
            let incident = f.w.markets[market].incident;
            let result = f.w.fund(market);
            seen.note(&result);
            let after = f.w.markets[market].book;
            let index = |book: &BookHeader| (book.funding_index, book.funding_carry);
            if health_before[market] != ORACLE_HEALTHY {
                assert_ne!(result, Ok(true), "RULES 7 funding acted during an incident");
                assert_eq!(after, book, "RULES 7 funding wrote during an incident");
            } else if result == Ok(true) {
                let reached = incident.reason != 0 && incident.since >= book.last_funding_time;
                if f.unhealthy_since_funding[market] {
                    assert!(
                        reached,
                        "RULES 7 an interval with an incident was not discarded"
                    );
                }
                if reached {
                    seen.funding_discards += 1;
                    assert_eq!(index(&after), index(&book), "RULES 7 a discard moved F");
                    assert_eq!((after.traded_premium, after.traded_size), (0, 0));
                } else if index(&after) != index(&book) {
                    seen.funding_moves += 1;
                }
                f.unhealthy_since_funding[market] = false;
            }
        }
        Op::Cover { market, seat } => {
            let owes = |seat: &u32| {
                let state = f.w.seat(*seat);
                state.collateral < 0 && state.perp.iter().all(|slot| slot.base == 0)
            };
            let seat = (0..SEAT_CAPACITY).find(owes).unwrap_or(seat);
            let recorded = f.w.markets[market].params.uncovered_shortfall;
            let result = f.w.cover_shortfall(market, seat);
            seen.note(&result);
            let paid = result.unwrap();
            assert_eq!(
                f.w.markets[market].params.uncovered_shortfall,
                recorded - paid
            );
        }
        Op::Reconcile => {
            f.w.reconcile();
            assert_eq!(f.w.reconcile(), 0);
        }
        Op::Resume(market) => {
            let result = f.w.resume(market);
            seen.note(&result);
            if result.is_ok() {
                assert_eq!(health_before[market], ORACLE_HEALTHY, "RULES 9 I7");
                assert!(!shortfall_before, "RULES 8.8 resume with a shortfall");
            }
        }
        Op::MoveFees(amount) => {
            let result = f.w.move_fees_to_insurance(amount);
            seen.note(&result);
        }
        Op::CollectFees { asset, amount } => {
            let result = f.w.collect_fees(asset, amount);
            seen.note(&result);
            if result.is_ok() && asset == Asset::Collateral {
                assert!(
                    !incident_before,
                    "RULES 12a fee collateral during an incident"
                );
                assert!(
                    !shortfall_before,
                    "RULES 12a fee collateral with a shortfall"
                );
            }
        }
        Op::SetCaps {
            market,
            open_interest_cap,
            position_cap,
            max_move_bps,
            min_publish_gap,
            settle_window,
        } => {
            if health_before[market] == ORACLE_HEALTHY {
                let mut params = f.w.markets[market].params;
                params.open_interest_cap = open_interest_cap;
                params.position_cap = position_cap;
                params.max_move_bps = max_move_bps;
                params.min_publish_gap = min_publish_gap;
                params.settle_window = settle_window;
                if params.check().is_ok() {
                    f.w.markets[market].params = params;
                    f.w.check_invariants();
                }
            }
        }
        Op::Restrict { market, paused } => {
            f.w.markets[market].params.status = if paused {
                STATUS_PAUSED
            } else {
                STATUS_REDUCE_ONLY
            };
        }
        Op::QuoteGuard(ok) => f.w.quote_ok = ok,
    }
    for market in PERPS {
        if f.health(market) != ORACLE_HEALTHY {
            f.unhealthy_since_funding[market] = true;
        }
    }
    check_global(f, op, &marks_before, is_sync, &funding_before, is_fund);
}

fn sync(f: &mut Fuzz, market: usize, from_mark: bool, bps: i64, stamp_back: i64, seen: &mut Seen) {
    let feed = f.feeds[market];
    let params_before = f.w.markets[market].params;
    let old = f.w.markets[market].price;
    let base = if from_mark {
        old.price
    } else {
        feed.source.target
    } as i64;
    let target = (base * (10_000 + bps) / 10_000).clamp(50, 50_000);
    let publish_time = f.w.now - stamp_back;
    let observed = Observation {
        price: target,
        conf: 0,
        publish_time,
    };
    let mut working = feed;
    let result = f.w.sync(market, &mut working, observed);
    seen.note(&result);
    if result.is_err() {
        assert_eq!(
            f.w.markets[market].params, params_before,
            "a refused sync wrote"
        );
        assert_eq!(f.w.markets[market].price, old);
        return;
    }
    f.feeds[market] = working;
    let after = f.w.markets[market].params;
    let new = f.w.markets[market].price;
    assert_eq!(working.price, new);
    assert!(
        working.source.publish_time > feed.source.publish_time,
        "RULES 9 I3"
    );
    assert!(
        new.publish_time <= working.source.publish_time,
        "RULES 9 I3"
    );
    assert!(working.source.publish_time <= f.w.now, "RULES 9 I3");
    assert!(new.price > 0 && new.price <= MAX_PRICE, "RULES 9 I3");
    match (params_before.oracle_health, after.oracle_health) {
        (ORACLE_HEALTHY, ORACLE_DISLOCATED) | (ORACLE_SETTLING, ORACLE_DISLOCATED) => {
            seen.dislocations += 1
        }
        (ORACLE_DISLOCATED, ORACLE_SETTLING)
            if working.incident.reason == INCIDENT_SETTLED_GAP && new != old =>
        {
            seen.settlements += 1
        }
        (_, ORACLE_HEALTHY) if params_before.oracle_health != ORACLE_HEALTHY => {
            seen.recoveries += 1
        }
        _ => {}
    }
    if new == old {
        return;
    }
    let gap = i64::from(params_before.min_publish_gap);
    assert!(new.publish_time - old.publish_time >= gap, "RULES 9 I1 gap");
    assert!(new.accepted_at - old.accepted_at >= gap, "RULES 9 I1 gap");
    let moved = u128::from(new.price.abs_diff(old.price)) * 10_000;
    let limit = u128::from(old.price) * u128::from(params_before.max_move_bps);
    if moved > limit {
        assert_eq!(params_before.oracle_health, ORACLE_DISLOCATED, "RULES 9 I2");
        assert_eq!(after.oracle_health, ORACLE_SETTLING, "RULES 9 I2");
        assert_ne!(after.status, STATUS_ACTIVE, "RULES 9 I2 reduce-only");
    } else {
        assert_ne!(after.oracle_health, ORACLE_DISLOCATED);
    }
}

fn place(f: &mut Fuzz, market: usize, seat: u32, order: NewOrder, seen: &mut Seen) {
    let health = f.health(market);
    let params = f.w.markets[market].params;
    let is_perp = params.kind == KIND_PERP;
    let quote_ok = f.w.quote_ok;
    let book_before = f.w.markets[market].book;
    let side_full = f.w.markets[market].live(order.side).len() == BOOK_CAPACITY;
    let seats_before = f.w.seats.clone();
    let reach = seats_before.get(seat as usize).map(|state| {
        let slot = state.perp()[market];
        let (on_side, open) = match order.side {
            Side::Bid => (slot.base.max(0) as i128, slot.open_bid_lots),
            Side::Ask => ((-slot.base).max(0) as i128, slot.open_ask_lots),
        };
        on_side + i128::from(open) + i128::from(order.size)
    });
    let dislocated_holders: Vec<bool> = (0..SEAT_CAPACITY)
        .map(|s| {
            let state = f.w.seat(s);
            PERPS.iter().any(|&m| {
                let slot = state.perp()[m];
                let holds = slot.base != 0 || slot.open_bid_lots != 0 || slot.open_ask_lots != 0;
                holds && f.health(m) == ORACLE_DISLOCATED
            })
        })
        .collect();

    let key = f.w.key(seat);
    let result = f.w.place_as(market, seat, key, order);
    seen.note(&result);
    if result == Err(E::PositionCapExceeded) {
        seen.cap_refusals += 1;
        assert!(reach.unwrap() > i128::from(params.position_cap));
    }
    let Ok(outcome) = result else {
        return;
    };
    assert_ne!(
        health, ORACLE_DISLOCATED,
        "RULES 9 I4 an order on a dislocated market"
    );
    if is_perp && !order.reduce_only {
        assert!(quote_ok, "RULES 9a an increase while the USDC guard fails");
        let reach = reach.unwrap();
        assert!(
            reach <= i128::from(params.position_cap),
            "RULES 3.6 an order past the position cap was accepted: {reach}"
        );
    }
    if side_full && outcome.rested > 0 {
        seen.evictions += 1;
    }
    let fills = f.w.fills.as_slice().to_vec();
    seen.fills += fills.len();
    for fill in &fills {
        for party in [fill.maker_seat, fill.taker_seat] {
            assert!(
                !(is_perp && dislocated_holders[party as usize]),
                "RULES 9 a seat holding a dislocated market was valued for a fill"
            );
        }
    }
    let book = f.w.markets[market].book;
    if is_perp {
        let counts = health == ORACLE_HEALTHY
            && f.w.now - f.w.markets[market].price.publish_time <= params.max_price_age;
        if !counts {
            assert_eq!(
                (book.traded_premium, book.traded_size),
                (book_before.traded_premium, book_before.traded_size),
                "RULES 7 a fill while settling or stale recorded funding"
            );
        }
        let raised = book.open_interest > book_before.open_interest;
        if raised {
            assert!(
                book.open_interest <= params.open_interest_cap,
                "RULES 6 OI cap"
            );
        }
        for (index, before) in seats_before.iter().enumerate() {
            let base_before = before.perp()[market].base;
            let base_after = f.w.seats[index].perp()[market].base;
            if base_before != base_after && grows(base_before, base_after) {
                assert!(
                    base_after.unsigned_abs() <= params.position_cap,
                    "RULES 6 a fill grew a position past the cap"
                );
                assert!(
                    quote_ok,
                    "RULES 9a a fill grew a position while the guard fails"
                );
            }
        }
    }
}

fn liquidate(
    f: &mut Fuzz,
    market: usize,
    liquidator: u32,
    target: u32,
    size: u64,
    seen: &mut Seen,
) {
    let health = f.health(market);
    let liquidator_on_dislocated = f.holds_on_dislocated(liquidator);
    let target_on_dislocated = f.holds_on_dislocated(target);
    let result = f.w.liquidate(market, liquidator, target, size);
    seen.note(&result);
    let Ok(outcome) = result else {
        return;
    };
    if outcome.status != LiquidationStatus::Liquidated {
        return;
    }
    seen.liquidations += 1;
    assert_ne!(
        health, ORACLE_DISLOCATED,
        "RULES 9 I4 liquidation on a dislocated market"
    );
    assert!(
        !liquidator_on_dislocated,
        "RULES 8 a liquidator on a dislocated market"
    );
    assert!(
        !target_on_dislocated,
        "RULES 8 a target that cannot be valued"
    );
    if health == ORACLE_SETTLING {
        seen.liquidations_while_settling += 1;
    }
    let mark = f.w.markets[market].price.price;
    let penalty_bps = u64::from(f.w.markets[market].params.liq_penalty_bps);
    assert!(mark.abs_diff(outcome.price) <= (mark * penalty_bps).div_ceil(10_000));
    let paid = outcome.insurance_paid + outcome.fee_seat_paid + outcome.uncovered;
    if paid > 0 {
        assert_eq!(
            outcome.price, mark,
            "RULES 8.5 insurance never pays a bonus"
        );
        assert!(f.w.seat(target).perp.iter().all(|slot| slot.base == 0));
    }
    seen.insurance_payments += usize::from(outcome.insurance_paid > 0);
    seen.fee_seat_payments += usize::from(outcome.fee_seat_paid > 0);
    if outcome.fee_seat_paid > 0 {
        assert_eq!(f.w.collateral(INSURANCE_SEAT), 0, "RULES 8.5 order");
    }
    if outcome.uncovered > 0 {
        seen.uncovered += 1;
        assert_eq!(f.w.collateral(INSURANCE_SEAT), 0);
        assert_eq!(f.w.collateral(FEE_SEAT), 0);
        assert_eq!(f.w.collateral(target), -(outcome.uncovered as i64));
        assert_ne!(f.w.markets[market].params.status, STATUS_ACTIVE);
    }
}

/// The rules that must hold whatever the last step was.
fn check_global(
    f: &Fuzz,
    op: &Op,
    marks_before: &[Price],
    is_sync: bool,
    funding_before: &[(i64, i32)],
    is_fund: bool,
) {
    f.w.check_invariants();
    for (market, state) in f.w.markets.iter().enumerate() {
        let params = &state.params;
        if !is_sync {
            assert_eq!(
                state.price, marks_before[market],
                "only a sync moves a mark: {op:?}"
            );
        }
        if !is_fund {
            let funding = (state.book.funding_index, state.book.funding_carry);
            assert_eq!(
                funding, funding_before[market],
                "only funding moves F: {op:?}"
            );
        }
        assert!(state.price.price > 0 && state.price.price <= MAX_PRICE);
        let feed = &f.feeds[market];
        assert!(feed.source.publish_time <= f.w.now, "RULES 9 I3");
        assert!(
            state.price.publish_time <= feed.source.publish_time,
            "RULES 9 I3"
        );
        if params.oracle_health == ORACLE_SETTLING {
            assert_ne!(
                params.status, STATUS_ACTIVE,
                "RULES 9 settling while active: {op:?}"
            );
        }
        if params.oracle_health == ORACLE_HEALTHY {
            assert!(
                feed.incident.settle_until <= f.w.now,
                "RULES 9 healthy before the window ended: {op:?}"
            );
        }
        if params.uncovered_shortfall > 0 {
            assert_ne!(
                params.status, STATUS_ACTIVE,
                "RULES 8.5 a record on an active market"
            );
        }
    }
    for reserved in [FEE_SEAT, INSURANCE_SEAT] {
        let seat = f.w.seat(reserved);
        assert!(seat.collateral >= 0);
        assert!(seat
            .perp
            .iter()
            .all(|slot| slot.base == 0 && slot.quote == 0));
    }
}

/// `PROPTEST_CASES`, when it asks for more than `minimum`.
fn cases_at_least(minimum: u32) -> u32 {
    minimum.max(Config::default().cases)
}

fn r4_seed(seed: u8) -> [u8; 32] {
    let salt: u64 = std::env::var("R4_SALT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let mut bytes = [seed; 32];
    for (byte, salt) in bytes.iter_mut().zip(salt.to_le_bytes()) {
        *byte ^= salt;
    }
    bytes
}

fn run(seed: u8, cases: u32) -> Seen {
    let config = Config {
        cases: cases_at_least(cases),
        failure_persistence: None,
        ..Config::default()
    };
    let rng = TestRng::from_seed(RngAlgorithm::ChaCha, &r4_seed(seed));
    let mut runner = TestRunner::new_with_rng(config, rng);
    let seen = RefCell::new(Seen::default());
    let histories = prop::collection::vec(any_op(), 40..260);
    runner
        .run(&histories, |ops| {
            let mut fuzz = Fuzz::new();
            for op in &ops {
                apply(&mut fuzz, op, &mut seen.borrow_mut());
            }
            Ok(())
        })
        .unwrap();
    let seen = seen.into_inner();
    eprintln!("seed {seed}: {seen:?}");
    seen
}

/// A history that never reached the new branches would prove nothing.
fn assert_exercised(seen: &Seen) {
    assert!(seen.fills > 1_000, "fills {}", seen.fills);
    assert!(
        seen.dislocations > 100,
        "dislocations {}",
        seen.dislocations
    );
    assert!(seen.settlements > 50, "settlements {}", seen.settlements);
    assert!(seen.recoveries > 50, "recoveries {}", seen.recoveries);
    assert!(seen.liquidations > 30, "liquidations {}", seen.liquidations);
    assert!(seen.liquidations_while_settling > 5);
    assert!(seen.insurance_payments > 5, "{}", seen.insurance_payments);
    assert!(seen.uncovered > 0, "uncovered {}", seen.uncovered);
    assert!(seen.evictions > 10, "evictions {}", seen.evictions);
    assert!(
        seen.funding_moves > 5,
        "funding moves {}",
        seen.funding_moves
    );
    assert!(
        seen.funding_discards > 5,
        "discards {}",
        seen.funding_discards
    );
    assert!(seen.cap_refusals > 10, "cap refusals {}", seen.cap_refusals);
    assert!(seen.collateral_withdrawals > 50);
    assert!(seen.transfers > 50);
    for error in [
        E::OracleIncident,
        E::OracleDislocated,
        E::ShortfallOutstanding,
        E::PositionCapExceeded,
        E::QuoteGuardTripped,
        E::PricePublishedTooSoon,
        E::PriceTimeWentBackwards,
    ] {
        let times = seen.errors.get(&error.code()).copied().unwrap_or(0);
        assert!(times > 0, "never saw {error:?}");
    }
    assert!(!seen.errors.contains_key(&E::InvariantBroken.code()));
    assert!(!seen.errors.contains_key(&E::JournalFull.code()));
    assert!(!seen.errors.contains_key(&E::MathOverflow.code()));
}

/// The minimal history behind the `properties` suite's failure at 200,000 cases: a
/// liquidator that holds a position on a feed older than `max_age_liquidation` reads
/// "stale price" before its worst price is looked at (RULES 8), so a refusing worst
/// price does not always come back as `WorstPriceExceeded`.
#[test]
fn a_liquidator_on_a_stale_feed_reads_stale_price_before_its_worst_price() {
    let mut w = World::new(10, 8);
    w.add_market(perp_params(0));
    w.add_market(perp_params(1));
    let liquidator = funded(&mut w, 10_000);
    let counterparty = funded(&mut w, 10_000);
    let target = funded(&mut w, 1_100);
    let fresh_liquidator = funded(&mut w, 10_000);
    buy_from(&mut w, 1, liquidator, counterparty, MARK, 1);
    buy_from(&mut w, 0, target, fresh_liquidator, MARK, 10);

    w.now += 301;
    w.reset(0, 900, w.now).unwrap();
    assert!(w.is_liquidatable(target, 0));
    let refusing = LiquidationRequest {
        target,
        size: 35,
        worst_price: 0,
    };

    let stale = w
        .liquidate_with(0, liquidator, w.key(liquidator), refusing)
        .unwrap();
    let fresh = w
        .liquidate_with(0, fresh_liquidator, w.key(fresh_liquidator), refusing)
        .unwrap();

    assert_eq!(stale.status, LiquidationStatus::StalePrice);
    assert_eq!(fresh.status, LiquidationStatus::WorstPriceExceeded);
}

#[test]
fn every_global_invariant_holds_across_price_source_caps_funding_and_liquidation_seed_41() {
    assert_exercised(&run(41, 1_500));
}

#[test]
fn every_global_invariant_holds_across_price_source_caps_funding_and_liquidation_seed_42() {
    assert_exercised(&run(42, 1_500));
}

#[test]
fn every_global_invariant_holds_across_price_source_caps_funding_and_liquidation_seed_43() {
    assert_exercised(&run(43, 1_500));
}

//! RULES 3, 4 and 6 against a second implementation. `Model` is written to be
//! obviously right and nothing else: one `Vec` of orders per side, sorted from scratch
//! for every order, and one cash figure and one position per trader. Both are fed the
//! same random streams of orders, cancels, mark moves and clock ticks, and must agree
//! on every error, every outcome, every fill, the whole resting book and, on the perp
//! market, every trader's position and money.

mod common;

use common::*;
use noirwire_orderbook_engine::EngineError as E;
use noirwire_orderbook_engine::*;
use proptest::prelude::*;
use proptest::test_runner::{Config, RngAlgorithm, TestRng, TestRunner};
use std::collections::BTreeMap;

const TRADERS: usize = 4;
const BOOK_CAPACITY: usize = 6;
const OPEN_ORDER_LIMIT: usize = 4;
const STEP_LIMIT: usize = 3;
const OPEN_INTEREST_CAP: u64 = 6;
const DEEP_POCKETS: u64 = 1_000_000_000_000;
const COLLATERAL: [u64; TRADERS] = [106, 215, 100_000, 1_000_000];
const BPS: i128 = 10_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Resting {
    price: u64,
    remaining: u64,
    sequence: u64,
    seat: u32,
    expiry: i64,
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

/// A perp trader as the model sees one: everything it has in quote atoms, and its
/// position in lots. Equity is `cash + base * mark`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Account {
    cash: i128,
    base: i128,
}

#[derive(Clone, Copy)]
struct Rules {
    is_perp: bool,
    band_bps: i128,
    im_bps: i128,
    mm_bps: i128,
    fee_bps: i128,
}

#[derive(Debug, Default)]
struct Seen {
    fills: usize,
    self_cancels: usize,
    band_cancels: usize,
    expiry_cancels: usize,
    maker_failures: usize,
    taker_failures: usize,
    open_interest_stops: usize,
    truncated: usize,
    refused_post_only: usize,
    book_full: usize,
    errors: BTreeMap<u32, usize>,
}

struct Model {
    rules: Rules,
    bids: Vec<Resting>,
    asks: Vec<Resting>,
    accounts: BTreeMap<u32, Account>,
    next_order_seq: u64,
    next_fill_seq: u64,
    mark: i128,
    now: i64,
    open_interest: i128,
}

fn further_than(price: i128, mark: i128, band_bps: i128) -> bool {
    (price - mark).abs() * BPS > mark * band_bps
}

fn grows(before: i128, after: i128) -> bool {
    let reduced = before.signum() == after.signum() && after.abs() < before.abs();
    after != 0 && !reduced
}

fn not_riskier(equity: (i128, i128), maintenance: (i128, i128)) -> bool {
    let (equity_before, equity_after) = equity;
    let (before, after) = maintenance;
    if after == 0 {
        return equity_after >= 0;
    }
    after <= before && equity_after * before >= equity_before * after
}

impl Model {
    fn new(rules: Rules, traders: &[u32]) -> Model {
        let accounts = traders
            .iter()
            .zip(COLLATERAL)
            .map(|(seat, collateral)| {
                let cash = i128::from(collateral);
                (*seat, Account { cash, base: 0 })
            })
            .collect();
        Model {
            rules,
            bids: Vec::new(),
            asks: Vec::new(),
            accounts,
            next_order_seq: 0,
            next_fill_seq: 0,
            mark: i128::from(MARK),
            now: START,
            open_interest: 0,
        }
    }

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

    fn open_lots(&self, seat: u32, side: Side) -> i128 {
        let orders = match side {
            Side::Bid => &self.bids,
            Side::Ask => &self.asks,
        };
        let own = orders.iter().filter(|o| o.seat == seat);
        i128::from(own.map(|o| o.remaining).sum::<u64>())
    }

    fn breaches_crossing_band(&self, side: Side, price: u64) -> bool {
        let price = i128::from(price);
        let on_the_crossing_side = match side {
            Side::Bid => price > self.mark,
            Side::Ask => price < self.mark,
        };
        on_the_crossing_side && further_than(price, self.mark, self.rules.band_bps)
    }

    fn equity(&self, account: Account) -> i128 {
        account.cash + account.base * self.mark
    }

    /// (initial, maintenance), both multiplied by 10,000.
    fn margins(&self, base: i128, open_bids: i128, open_asks: i128) -> (i128, i128) {
        let worst = (base + open_bids).max(0).max((open_asks - base).max(0));
        let initial = worst * self.mark * self.rules.im_bps;
        let maintenance = base.abs() * self.mark * self.rules.mm_bps;
        (initial, maintenance)
    }

    fn fee(&self, price: u64, size: u64) -> i128 {
        let notional = i128::from(price) * i128::from(size);
        (notional * self.rules.fee_bps + BPS - 1) / BPS
    }

    /// RULES 6, "Fill checks", for one side of one proposed fill.
    fn passes_fill_check(&self, seat: u32, after: Account, leaving_book: (Side, i128)) -> bool {
        let lots_leaving_book = leaving_book;
        let before = self.accounts[&seat];
        let leaving = |side: Side| match lots_leaving_book {
            (leaving_side, lots) if leaving_side == side => lots,
            _ => 0,
        };
        let open_bids = self.open_lots(seat, Side::Bid) - leaving(Side::Bid);
        let open_asks = self.open_lots(seat, Side::Ask) - leaving(Side::Ask);
        let (initial, maintenance) = self.margins(after.base, open_bids, open_asks);
        let equity = self.equity(after);
        if equity < 0 {
            return false;
        }
        let is_maker = lots_leaving_book.1 > 0;
        if grows(before.base, after.base) {
            return if is_maker {
                2 * equity * BPS >= initial + maintenance
            } else {
                equity * BPS >= initial
            };
        }
        let maintenance_before = before.base.abs() * self.mark * self.rules.mm_bps;
        let equities = (self.equity(before), equity);
        equity * BPS >= initial || not_riskier(equities, (maintenance_before, maintenance))
    }

    fn place(&mut self, seat: u32, order: &NewOrder, seen: &mut Seen) -> Result<ModelOutcome, E> {
        if order.expiry != 0 && self.now > order.expiry {
            return Err(E::OrderExpired);
        }
        let outside_bands = self.breaches_crossing_band(order.side, order.price)
            || further_than(i128::from(order.price), self.mark, 5_000);
        if outside_bands {
            return Err(E::PriceOutsideBand);
        }
        let may_rest = matches!(order.order_type, OrderType::Limit | OrderType::PostOnly);
        if may_rest && self.open_orders(seat) >= OPEN_ORDER_LIMIT {
            return Err(E::TooManyOpenOrders);
        }
        if self.rules.is_perp {
            let account = self.accounts[&seat];
            let size = i128::from(order.size);
            let mut open_bids = self.open_lots(seat, Side::Bid);
            let mut open_asks = self.open_lots(seat, Side::Ask);
            match order.side {
                Side::Bid => open_bids += size,
                Side::Ask => open_asks += size,
            }
            let (initial, _) = self.margins(account.base, open_bids, open_asks);
            let reserved_fee = self.fee(order.price, order.size);
            if (self.equity(account) - reserved_fee) * BPS < initial {
                return Err(E::InsufficientMargin);
            }
        }
        let maker_side = order.side.opposite();
        let crosses = |resting: &Resting| match order.side {
            Side::Bid => resting.price <= order.price,
            Side::Ask => resting.price >= order.price,
        };
        let queue = self.by_priority(maker_side);
        if order.order_type == OrderType::PostOnly && queue.first().is_some_and(crosses) {
            seen.refused_post_only += 1;
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
        let mut taker_failed = false;
        let mut fills = Vec::new();
        for (steps_taken, maker) in queue.into_iter().enumerate() {
            if remaining == 0 || !crosses(&maker) {
                break;
            }
            if steps_taken == STEP_LIMIT {
                truncated = true;
                break;
            }
            let at = |book: &[Resting]| book.iter().position(|o| o.sequence == maker.sequence);
            let own = maker.seat == seat;
            let outside = self.breaches_crossing_band(maker_side, maker.price);
            let expired = maker.expiry != 0 && self.now > maker.expiry;
            if own || outside || expired {
                seen.self_cancels += usize::from(own);
                seen.band_cancels += usize::from(!own && outside);
                seen.expiry_cancels += usize::from(!own && !outside && expired);
                let position = at(self.side(maker_side)).unwrap();
                self.side(maker_side).remove(position);
                continue;
            }
            let size = remaining.min(maker.remaining);
            let lots = i128::from(size);
            let paid = i128::from(maker.price) * lots;
            let taker_buys = order.side == Side::Bid;
            let signed = if taker_buys { lots } else { -lots };
            let fee = self.fee(maker.price, size);
            if self.rules.is_perp {
                let maker_before = self.accounts[&maker.seat];
                let taker_before = self.accounts[&seat];
                let maker_after = Account {
                    cash: maker_before.cash + if taker_buys { paid } else { -paid },
                    base: maker_before.base - signed,
                };
                let taker_after = Account {
                    cash: taker_before.cash - if taker_buys { paid } else { -paid } - fee,
                    base: taker_before.base + signed,
                };
                if !self.passes_fill_check(maker.seat, maker_after, (maker_side, lots)) {
                    seen.maker_failures += 1;
                    let position = at(self.side(maker_side)).unwrap();
                    self.side(maker_side).remove(position);
                    continue;
                }
                if !self.passes_fill_check(seat, taker_after, (maker_side, 0)) {
                    seen.taker_failures += 1;
                    taker_failed = true;
                    break;
                }
                let long = |account: Account| account.base.max(0);
                let open_interest = self.open_interest + long(maker_after) + long(taker_after)
                    - long(maker_before)
                    - long(taker_before);
                let cap = i128::from(OPEN_INTEREST_CAP);
                if open_interest > self.open_interest && open_interest > cap {
                    seen.open_interest_stops += 1;
                    taker_failed = true;
                    break;
                }
                self.open_interest = open_interest;
                self.accounts.insert(maker.seat, maker_after);
                self.accounts.insert(seat, taker_after);
            }
            remaining -= size;
            let position = at(self.side(maker_side)).unwrap();
            let makers = self.side(maker_side);
            makers[position].remaining -= size;
            if makers[position].remaining == 0 {
                makers.remove(position);
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
        let would_rest = remaining > 0 && !truncated && !taker_failed && may_rest;
        let rests = would_rest && self.side(order.side).len() < BOOK_CAPACITY;
        if rests {
            self.side(order.side).push(Resting {
                price: order.price,
                remaining,
                sequence,
                seat,
                expiry: order.expiry,
            });
        }
        let status = if truncated {
            PlaceStatus::RemainderCancelledStepLimit
        } else if taker_failed {
            PlaceStatus::RemainderCancelledFillCheck
        } else if rests {
            PlaceStatus::Rested
        } else if would_rest {
            PlaceStatus::RemainderCancelledBookFull
        } else if remaining > 0 {
            PlaceStatus::RemainderCancelled
        } else {
            PlaceStatus::Filled
        };
        seen.fills += fills.len();
        seen.truncated += usize::from(truncated);
        seen.book_full += usize::from(status == PlaceStatus::RemainderCancelledBookFull);
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
    MoveMark { level: u64 },
    Wait { seconds: i64 },
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
    let lifetime = prop_oneof![3 => Just(None), 1 => (-1i64..5).prop_map(Some)];
    let shape = (any_side(), any_order_type(), 0u64..11, 1u64..4, lifetime);
    let place = (trader.clone(), shape).prop_map(|(trader, shape)| {
        let (side, order_type, level, size, lifetime) = shape;
        let mut order = order(side, order_type, 950 + level * 10, size);
        order.expiry = lifetime.map_or(0, |seconds| seconds + 1_000_000_000);
        Step::Place { trader, order }
    });
    let cancel =
        (trader.clone(), 0u64..60).prop_map(|(trader, sequence)| Step::Cancel { trader, sequence });
    let cancel_all = (trader, 0u32..4).prop_map(|(trader, max_cancels)| Step::CancelAll {
        trader,
        max_cancels,
    });
    let move_mark = (0u64..7).prop_map(|level| Step::MoveMark { level });
    let wait = (1i64..3).prop_map(|seconds| Step::Wait { seconds });
    prop_oneof![14 => place, 3 => cancel, 1 => cancel_all, 4 => move_mark, 1 => wait]
}

fn world(params: MarketParams) -> (World, usize, Vec<u32>) {
    let mut w = World::new(TRADERS + RESERVED_SEATS, BOOK_CAPACITY);
    w.max_steps = STEP_LIMIT as u32;
    let m = w.add_market(params);
    let traders: Vec<u32> = (0..TRADERS).map(|_| w.open()).collect();
    for (trader, collateral) in traders.iter().zip(COLLATERAL) {
        w.deposit(*trader, Asset::Collateral, collateral).unwrap();
        for asset in [Asset::Spot(QUOTE), Asset::Spot(BASE)] {
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
            expiry: o.expiry,
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

fn engine_account(w: &World, m: usize, seat: u32) -> Account {
    let slot = w.slot(seat, m);
    Account {
        cash: i128::from(w.collateral(seat)) + i128::from(slot.quote),
        base: i128::from(slot.base),
    }
}

/// The order's lifetime was drawn relative to a fixed origin; here it becomes relative
/// to the clock at the moment the order is placed.
fn at_the_current_time(order: &NewOrder, now: i64) -> NewOrder {
    let mut order = *order;
    if order.expiry != 0 {
        order.expiry = now + (order.expiry - 1_000_000_000);
    }
    order
}

fn run_stream(params: MarketParams, steps: &[Step], seen: &mut Seen) {
    let (mut w, m, traders) = world(params);
    let rules = Rules {
        is_perp: params.kind == KIND_PERP,
        band_bps: i128::from(params.band_bps),
        im_bps: i128::from(params.im_bps),
        mm_bps: i128::from(params.mm_bps),
        fee_bps: i128::from(params.taker_fee_bps),
    };
    let mut model = Model::new(rules, &traders);
    for step in steps {
        match step {
            Step::Place { trader, order } => {
                let seat = traders[*trader];
                let order = at_the_current_time(order, model.now);
                let expected = model.place(seat, &order, seen);
                let actual = w.place(m, seat, order);
                let actual = actual.map(|outcome| engine_outcome(&w, &outcome));
                assert_eq!(actual, expected, "{step:?}");
                if let Err(error) = expected {
                    *seen.errors.entry(error.code()).or_default() += 1;
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
            Step::MoveMark { level } => {
                let mark = 940 + level * 20;
                model.mark = i128::from(mark);
                w.set_price(m, mark);
            }
            Step::Wait { seconds } => {
                model.now += seconds;
                w.now += seconds;
                let mark = w.markets[m].price.price;
                w.set_price(m, mark);
            }
        }
        for side in [Side::Bid, Side::Ask] {
            assert_eq!(engine_book(&w, m, side), model.by_priority(side));
        }
        assert_eq!(w.markets[m].book.next_order_seq, model.next_order_seq);
        assert_eq!(w.markets[m].book.next_fill_seq, model.next_fill_seq);
        if rules.is_perp {
            for seat in &traders {
                assert_eq!(engine_account(&w, m, *seat), model.accounts[seat]);
            }
            let open_interest = i128::from(w.markets[m].book.open_interest);
            assert_eq!(open_interest, model.open_interest);
        }
    }
}

fn differential(params: MarketParams, seed: u8, cases: u32) -> Seen {
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
    eprintln!("seed {seed}: {seen:?}");
    assert!(seen.fills > 3_000, "fills {}", seen.fills);
    assert!(seen.self_cancels > 100, "{}", seen.self_cancels);
    assert!(seen.band_cancels > 100, "band {}", seen.band_cancels);
    assert!(seen.expiry_cancels > 100, "expiry {}", seen.expiry_cancels);
    assert!(seen.truncated > 50, "truncated {}", seen.truncated);
    assert!(seen.refused_post_only > 100);
    assert!(seen.book_full > 50, "book full {}", seen.book_full);
    for error in [E::TooManyOpenOrders, E::PriceOutsideBand, E::OrderExpired] {
        let times = seen.errors.get(&error.code()).copied().unwrap_or(0);
        assert!(times > 100, "{error:?} {times}");
    }
    seen
}

fn limits(mut params: MarketParams) -> MarketParams {
    params.max_open_orders = OPEN_ORDER_LIMIT as u16;
    params.band_bps = 500;
    params.open_interest_cap = OPEN_INTEREST_CAP;
    params
}

#[test]
fn spot_matching_agrees_with_the_reference_model() {
    differential(limits(spot_params(0)), 11, 1_500);
}

#[test]
fn perp_matching_and_fill_checks_agree_with_the_reference_model() {
    let seen = differential(limits(perp_params(0)), 12, 1_500);

    assert!(seen.maker_failures > 100, "maker {}", seen.maker_failures);
    assert!(seen.taker_failures > 100, "taker {}", seen.taker_failures);
    assert!(seen.open_interest_stops > 20);
    let margin_errors = seen.errors.get(&E::InsufficientMargin.code());
    assert!(margin_errors.copied().unwrap_or(0) > 100);
}

#[test]
fn the_reference_model_itself_follows_price_then_time_priority() {
    let rules = Rules {
        is_perp: false,
        band_bps: 500,
        im_bps: 1_000,
        mm_bps: 500,
        fee_bps: 30,
    };
    let mut model = Model::new(rules, &[1, 2, 3]);
    let mut seen = Seen::default();
    for (seat, price) in [(1, 1_010), (2, 1_000), (1, 1_000)] {
        let resting = limit(Side::Ask, price, 1);
        model.place(seat, &resting, &mut seen).unwrap();
    }

    let taking = ioc(Side::Bid, 1_010, 3);
    let outcome = model.place(3, &taking, &mut seen).unwrap();

    let makers: Vec<(u64, u32)> = outcome
        .fills
        .iter()
        .map(|fill| (fill.price, fill.maker_seat))
        .collect();
    assert_eq!(makers, vec![(1_000, 2), (1_000, 1), (1_010, 1)]);
}

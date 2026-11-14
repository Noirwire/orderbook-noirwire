//! Trigger books in the program: how one is created, finalised and loaded, what
//! `set_trigger` and `cancel_trigger` record and refuse, what a pass of `fire_triggers`
//! places and writes to the tape, what a sweep drops, and that the owner's key reset
//! clears the seat's triggers. The cores that take the clock as an argument run on
//! in-memory accounts; the instructions that need no clock run through `entry`.

use anchor_lang::prelude::*;
use anchor_lang::InstructionData;
use bytemuck::Zeroable;
use noirwire_orderbook_engine::{
    deposit as engine_deposit, place_order, receipt, take_seat, Asset, BookHeader, Fills, Journal,
    JournalEntry, Kind, MarketParams, NewOrder, OrderType, Price, Seat, Side, Trader, TriggerBook,
    TriggerHeader, KIND_PERP, MAX_FILLS, MAX_OPEN_INTEREST_CAP, PLACE_JOURNAL_EXTRA_ENTRIES,
    ROLE_TAKER, SEAT_OPEN,
};

use crate::errors::OrderbookError;
use crate::growth_tests::{
    account, bytes_of, exchange_account, ledger_of, live_exchange, refusal, refused_with, run,
    signer, write,
};
use crate::instructions::trader::clear_stops;
use crate::instructions::triggers::{
    apply_cancel_trigger, apply_set_trigger, fired, sweep_slots, Firing, SetCall, TriggerParams,
};
use crate::loader::{load_ledger, load_ledger_mut, load_mut, load_triggers_mut, open_book, Scope};
use crate::market::{env, sha256, MarketAccounts};
use crate::risk::RiskTable;
use crate::state::{
    trigger_account_len, BookData, Exchange, Header, MarketData, OrderResult, PriceData,
    RollupAccount, StatsData, TapeData, TapeFill, TriggerData, ViewData, HEADER_LEN, MARKET_SEED,
    MIN_SEATS, NO_SEAT, READY, RESULT_CANCEL_TRIGGER, RESULT_SET_TRIGGER, STATUS_DONE,
    STATUS_REFUSED, SWEEP_TRIGGER_SLOTS_PER_CALL, TAPE_FILLS, TRIGGER_SEED, VIEW_SEED,
};

const NOW: i64 = 1_000_000;
const KEY_A: [u8; 32] = [0xA1; 32];

fn perp_params(market_id: u8) -> MarketParams {
    MarketParams {
        tick: 10,
        base_lot: 1,
        min_size: 1,
        funding_interval: 3_600,
        max_price_age: 60,
        open_interest_cap: 1_000_000,
        position_cap: MAX_OPEN_INTEREST_CAP,
        band_bps: 500,
        im_bps: 1_000,
        mm_bps: 500,
        taker_fee_bps: 0,
        liq_penalty_bps: 100,
        funding_cap_bps: 0,
        max_move_bps: 300,
        min_publish_gap: 1,
        max_open_orders: 4,
        kind: KIND_PERP,
        market_id,
        ..MarketParams::zeroed()
    }
}

fn stamped(
    tag: [u8; 8],
    seed: &[u8],
    extra: &[u8],
    market_id: u8,
    len: usize,
) -> AccountInfo<'static> {
    let mut seeds = vec![seed];
    if !extra.is_empty() {
        seeds.push(extra);
    }
    let (key, bump) = Pubkey::find_program_address(&seeds, &crate::ID);
    let info = account(key, crate::ID, len, false, true);
    let header = Header {
        tag,
        ready: READY,
        market_id,
        bump,
        _padding: [0; 5],
    };
    write(&info, 0, bytemuck::bytes_of(&header));
    info
}

fn market_stamped<T: RollupAccount>(market_id: u8, len: usize) -> AccountInfo<'static> {
    stamped(T::TAG, T::SEED, &[market_id], market_id, len)
}

fn book_account(market_id: u8, seats: u32) -> AccountInfo<'static> {
    let len = trigger_account_len(seats as usize).unwrap();
    let info = market_stamped::<TriggerData>(market_id, len);
    TriggerBook::init(
        &mut info.try_borrow_mut_data().unwrap()[HEADER_LEN..],
        market_id,
        seats,
    )
    .unwrap();
    info
}

fn with_book<R>(info: &AccountInfo, market_id: u8, f: impl FnOnce(&mut TriggerBook<'_>) -> R) -> R {
    let mut data = load_triggers_mut(info, market_id).unwrap();
    let mut book = open_book(&mut data).unwrap();
    f(&mut book)
}

fn holding(owner: u8, base: i64) -> Seat {
    let mut seat = Seat::zeroed();
    seat.owner = [owner; 32];
    seat.status = SEAT_OPEN;
    seat.slot_markets[0] = 1;
    seat.perp[0].base = base;
    seat
}

fn stop(trigger: u64, worst: u64) -> TriggerParams {
    TriggerParams {
        kind: 1,
        trigger_price: trigger,
        worst_price: worst,
        size: 0,
        expiry: 0,
        secret: [9; 16],
    }
}

fn take(trigger: u64, worst: u64) -> TriggerParams {
    TriggerParams {
        kind: 0,
        ..stop(trigger, worst)
    }
}

fn set_on(
    book: &mut TriggerBook<'_>,
    index: u32,
    seat: &Seat,
    params: &MarketParams,
    mark: u64,
    fresh: bool,
    request: TriggerParams,
) -> Result<OrderResult> {
    apply_set_trigger(
        book,
        &SetCall {
            trader: Trader {
                seat: index,
                owner: &seat.owner,
            },
            seat,
            params,
            mark,
            mark_fresh: fresh,
            now: NOW,
            client_order_id: 7,
        },
        &request,
    )
}

fn code(error: OrderbookError) -> u16 {
    error as u16
}

#[test]
fn a_trigger_is_recorded_and_a_second_one_of_its_kind_replaces_it() {
    let (params, seat) = (perp_params(0), holding(1, 100));
    let info = book_account(0, 8);
    with_book(&info, 0, |book| {
        let done = set_on(book, 3, &seat, &params, 1_000, true, stop(950, 900)).unwrap();
        assert_eq!(
            (done.kind, done.status, done.cancelled, done.client_order_id),
            (RESULT_SET_TRIGGER, STATUS_DONE, 0, 7)
        );
        assert_eq!(book.record(3, Kind::StopLoss).unwrap().client_id, 7);
        assert!(book.record(3, Kind::TakeProfit).is_none());

        let again = set_on(book, 3, &seat, &params, 1_000, true, stop(940, 900)).unwrap();
        assert_eq!((again.status, again.cancelled), (STATUS_DONE, 1));
        assert_eq!(book.record(3, Kind::StopLoss).unwrap().trigger_price, 940);
    });
}

#[test]
fn every_refusal_that_depends_on_the_seat_is_an_outcome_and_changes_nothing() {
    let long = holding(1, 100);
    let mut retired = long;
    retired.set_generations([255, 0, 0, 0]);
    let strict = MarketParams {
        min_size: 10,
        ..perp_params(0)
    };
    let cases: Vec<(
        &str,
        Seat,
        MarketParams,
        bool,
        u32,
        TriggerParams,
        OrderbookError,
    )> = vec![
        (
            "flat",
            holding(1, 0),
            perp_params(0),
            true,
            3,
            stop(950, 900),
            OrderbookError::NoPosition,
        ),
        (
            "retired",
            retired,
            perp_params(0),
            true,
            3,
            stop(950, 900),
            OrderbookError::TriggerSlotRetired,
        ),
        (
            "fires now",
            long,
            perp_params(0),
            true,
            3,
            stop(1_000, 900),
            OrderbookError::TriggerWouldFireImmediately,
        ),
        (
            "off the tick",
            long,
            perp_params(0),
            true,
            3,
            stop(955, 900),
            OrderbookError::TriggerPriceInvalid,
        ),
        (
            "worst price on the wrong side",
            long,
            perp_params(0),
            true,
            3,
            stop(950, 960),
            OrderbookError::TriggerWorstPriceInvalid,
        ),
        (
            "larger than the position",
            long,
            perp_params(0),
            true,
            3,
            TriggerParams {
                size: 101,
                ..stop(950, 900)
            },
            OrderbookError::TriggerSizeInvalid,
        ),
        (
            "below the minimum order",
            long,
            strict,
            true,
            3,
            TriggerParams {
                size: 5,
                ..stop(950, 900)
            },
            OrderbookError::TriggerSizeBelowMinimum,
        ),
        (
            "already expired",
            long,
            perp_params(0),
            true,
            3,
            TriggerParams {
                expiry: 5,
                ..stop(950, 900)
            },
            OrderbookError::TriggerExpiryInvalid,
        ),
        (
            "mark not fresh",
            long,
            perp_params(0),
            false,
            3,
            stop(950, 900),
            OrderbookError::StalePrice,
        ),
        (
            "seat past the book",
            long,
            perp_params(0),
            true,
            9,
            stop(950, 900),
            OrderbookError::TriggerBookTooSmall,
        ),
    ];
    for (name, seat, params, fresh, index, request, expected) in cases {
        let info = book_account(0, 8);
        let before = bytes_of(&info);
        let outcome = with_book(&info, 0, |book| {
            set_on(book, index, &seat, &params, 1_000, fresh, request).unwrap()
        });
        assert_eq!(
            (
                outcome.kind,
                outcome.status,
                outcome.code,
                outcome.client_order_id
            ),
            (RESULT_SET_TRIGGER, STATUS_REFUSED, code(expected), 7),
            "{name}"
        );
        assert_eq!(bytes_of(&info), before, "{name} leaves the book alone");
    }
}

#[test]
fn a_take_profit_the_stop_would_cross_is_an_outcome() {
    let (params, seat) = (perp_params(0), holding(1, 100));
    let info = book_account(0, 8);
    with_book(&info, 0, |book| {
        set_on(book, 3, &seat, &params, 1_000, true, stop(950, 900)).unwrap();
        let crossed = set_on(book, 3, &seat, &params, 900, true, take(940, 900)).unwrap();
        assert_eq!(
            (crossed.status, crossed.code),
            (STATUS_REFUSED, code(OrderbookError::TriggerPairCrossed))
        );
    });
}

#[test]
fn a_seat_that_is_not_the_traders_is_an_outcome() {
    let (params, seat) = (perp_params(0), holding(1, 100));
    let info = book_account(0, 8);
    with_book(&info, 0, |book| {
        let stranger = [2u8; 32];
        let outcome = apply_set_trigger(
            book,
            &SetCall {
                trader: Trader {
                    seat: 3,
                    owner: &stranger,
                },
                seat: &seat,
                params: &params,
                mark: 1_000,
                mark_fresh: true,
                now: NOW,
                client_order_id: 7,
            },
            &stop(950, 900),
        )
        .unwrap();
        assert_eq!(
            (outcome.status, outcome.code),
            (STATUS_REFUSED, code(OrderbookError::NotSeatOwner))
        );
    });
}

#[test]
fn a_trigger_kind_that_is_neither_is_an_error_and_so_are_unusable_market_settings() {
    let (params, seat) = (perp_params(0), holding(1, 100));
    let info = book_account(0, 8);
    with_book(&info, 0, |book| {
        let bad_kind = TriggerParams {
            kind: 2,
            ..stop(950, 900)
        };
        assert_eq!(
            refusal(set_on(book, 3, &seat, &params, 1_000, true, bad_kind)),
            error!(OrderbookError::TriggerKindInvalid)
        );
        assert_eq!(
            refusal(apply_cancel_trigger(
                book,
                Trader {
                    seat: 3,
                    owner: &seat.owner
                },
                &seat,
                2,
                NOW,
                7
            )),
            error!(OrderbookError::TriggerKindInvalid)
        );
        let broken = MarketParams::zeroed();
        assert!(set_on(book, 3, &seat, &broken, 1_000, true, stop(950, 900)).is_err());
    });
}

#[test]
fn a_cancel_reports_whether_there_was_a_trigger_and_a_repeat_is_harmless() {
    let (params, seat) = (perp_params(0), holding(1, 100));
    let info = book_account(0, 8);
    let trader = Trader {
        seat: 3,
        owner: &seat.owner,
    };
    with_book(&info, 0, |book| {
        set_on(book, 3, &seat, &params, 1_000, true, stop(950, 900)).unwrap();
        set_on(book, 3, &seat, &params, 1_000, true, take(1_100, 1_050)).unwrap();

        let first = apply_cancel_trigger(book, trader, &seat, 1, NOW, 8).unwrap();
        assert_eq!(
            (
                first.kind,
                first.status,
                first.cancelled,
                first.client_order_id
            ),
            (RESULT_CANCEL_TRIGGER, STATUS_DONE, 1, 8)
        );
        let second = apply_cancel_trigger(book, trader, &seat, 1, NOW, 9).unwrap();
        assert_eq!((second.status, second.cancelled), (STATUS_DONE, 0));

        let flipped = holding(1, -100);
        let after_flip = apply_cancel_trigger(book, trader, &flipped, 0, NOW, 10).unwrap();
        assert_eq!(
            (after_flip.status, after_flip.cancelled),
            (STATUS_DONE, 0),
            "a trigger of a position that is gone is nothing to cancel"
        );
        assert!(book.record(3, Kind::TakeProfit).is_none());
    });
}

#[test]
fn a_trigger_keeps_the_secret_it_was_set_with_and_a_replacement_swaps_it() {
    let (params, seat) = (perp_params(0), holding(1, 100));
    let info = book_account(0, 8);
    with_book(&info, 0, |book| {
        let first = TriggerParams {
            secret: [5; 16],
            ..stop(950, 900)
        };
        set_on(book, 3, &seat, &params, 1_000, true, first).unwrap();
        assert_eq!(book.record(3, Kind::StopLoss).unwrap().secret, [5; 16]);

        let second = TriggerParams {
            secret: [6; 16],
            ..stop(940, 900)
        };
        set_on(book, 3, &seat, &params, 1_000, true, second).unwrap();
        assert_eq!(book.record(3, Kind::StopLoss).unwrap().secret, [6; 16]);

        let zero = TriggerParams {
            secret: [0; 16],
            ..stop(930, 900)
        };
        let done = set_on(book, 3, &seat, &params, 1_000, true, zero).unwrap();
        assert_eq!(
            done.status, STATUS_DONE,
            "place_order accepts a zero secret too"
        );
    });
}

#[test]
fn two_triggers_that_differ_only_in_secret_get_different_receipts_from_the_traders_secret() {
    let w = World::new();
    let (first, second) = (w.long(1, 100), w.long(2, 100));
    let (secret_first, secret_second) = ([0x11; 16], [0x22; 16]);
    for (seat, key, secret) in [(first, 1, secret_first), (second, 2, secret_second)] {
        let request = TriggerParams {
            secret,
            ..stop(950, 900)
        };
        assert_eq!(w.set(seat, key, 7, request).status, STATUS_DONE);
    }
    w.mark(940);
    w.bid_at_930(3, 200);

    let pass = w.fire(2);

    assert_eq!((pass.placed, pass.refused), (2, 0));
    let tape = load_mut::<TapeData>(&w.tape, Scope::Market(0)).unwrap();
    assert_eq!(
        tape.written, 2,
        "the two stops are the only fills on the tape"
    );
    let written = usize::try_from(tape.written).unwrap();
    let stops = [
        tape.fills[(written - 2) % TAPE_FILLS],
        tape.fills[(written - 1) % TAPE_FILLS],
    ];
    let expected =
        |secret: &[u8; 16], fill: &TapeFill| receipt(sha256, secret, fill.fill_seq, ROLE_TAKER);
    let matches_first = stops
        .iter()
        .filter(|fill| fill.taker_receipt == expected(&secret_first, fill))
        .count();
    let matches_second = stops
        .iter()
        .filter(|fill| fill.taker_receipt == expected(&secret_second, fill))
        .count();
    assert_eq!((matches_first, matches_second), (1, 1));
    assert_ne!(stops[0].taker_receipt, stops[1].taker_receipt);
}

struct World {
    exchange: Exchange,
    ledger: AccountInfo<'static>,
    market: AccountInfo<'static>,
    book: AccountInfo<'static>,
    price: AccountInfo<'static>,
    tape: AccountInfo<'static>,
    stats: AccountInfo<'static>,
    triggers: AccountInfo<'static>,
}

fn global<T: RollupAccount>() -> AccountInfo<'static> {
    stamped(T::TAG, T::SEED, &[], 0, T::LEN)
}

impl World {
    fn new() -> World {
        let mut exchange = live_exchange(Pubkey::new_unique());
        exchange.perp_markets = 1;
        exchange.quote.ok_until = i64::MAX;
        let world = World {
            exchange,
            ledger: ledger_of(MIN_SEATS),
            market: market_stamped::<MarketData>(0, MarketData::LEN),
            book: market_stamped::<BookData>(0, BookData::LEN),
            price: market_stamped::<PriceData>(0, PriceData::LEN),
            tape: market_stamped::<TapeData>(0, TapeData::LEN),
            stats: global::<StatsData>(),
            triggers: book_account(0, u32::try_from(MIN_SEATS).unwrap()),
        };
        {
            let mut market = load_mut::<MarketData>(&world.market, Scope::Market(0)).unwrap();
            market.params = perp_params(0);
            market.capacity = 8;
        }
        {
            let mut book = load_mut::<BookData>(&world.book, Scope::Market(0)).unwrap();
            book.book.header = BookHeader {
                market_id: 0,
                last_funding_time: NOW,
                ..BookHeader::zeroed()
            };
        }
        world.mark(1_000);
        world
    }

    fn mark(&self, price: u64) {
        load_mut::<PriceData>(&self.price, Scope::Market(0))
            .unwrap()
            .price = Price {
            price,
            publish_time: NOW,
            accepted_at: NOW,
        };
    }

    fn seat(&self, key: u8) -> u32 {
        let mut ledger = load_ledger_mut(&self.ledger).unwrap();
        let mut engine = ledger.engine();
        let index = take_seat(&mut engine, &[key; 32]).unwrap();
        engine_deposit(&mut engine, index, Asset::Collateral, 1_000_000).unwrap();
        index
    }

    fn place(
        &self,
        seat: u32,
        key: u8,
        side: Side,
        order_type: OrderType,
        price: u64,
        size: u64,
    ) -> u64 {
        let mut ledger = load_ledger_mut(&self.ledger).unwrap();
        let mut loaded = MarketAccounts::load(&self.market, &self.book, &self.price, 0).unwrap();
        let mut risk = RiskTable::new();
        risk.set(0, loaded.risk()).unwrap();
        let env = env(&self.exchange, NOW, &risk.markets);
        let mut entries = vec![JournalEntry::zeroed(); MAX_FILLS + PLACE_JOURNAL_EXTRA_ENTRIES];
        let mut journal = Journal::new(&mut entries);
        let mut fills = Fills::new();
        let mut market = loaded.as_engine();
        let mut seats = ledger.engine();
        place_order(
            &mut seats,
            &mut market,
            &mut journal,
            &env,
            Trader {
                seat,
                owner: &[key; 32],
            },
            &NewOrder {
                side,
                order_type,
                price,
                size,
                secret: [3; 16],
                reduce_only: false,
                expiry: 0,
            },
            &mut fills,
        )
        .unwrap()
        .filled
    }

    fn long(&self, key: u8, lots: u64) -> u32 {
        let maker = self.seat(key.wrapping_add(100));
        let taker = self.seat(key);
        self.place(
            maker,
            key.wrapping_add(100),
            Side::Ask,
            OrderType::Limit,
            1_000,
            lots,
        );
        let filled = self.place(
            taker,
            key,
            Side::Bid,
            OrderType::ImmediateOrCancel,
            1_000,
            lots,
        );
        assert_eq!(filled, lots);
        taker
    }

    fn bid_at_930(&self, key: u8, lots: u64) {
        let bidder = self.seat(key);
        self.place(bidder, key, Side::Bid, OrderType::Limit, 930, lots);
    }

    fn base(&self, seat: u32) -> i64 {
        load_ledger(&self.ledger).unwrap().seats[seat as usize]
            .slot(0)
            .unwrap()
            .base
    }

    fn set(&self, seat: u32, key: u8, client: u64, request: TriggerParams) -> OrderResult {
        let seat_now = load_ledger(&self.ledger).unwrap().seats[seat as usize];
        let params = perp_params(0);
        let risk = MarketAccounts::load(&self.market, &self.book, &self.price, 0)
            .unwrap()
            .risk();
        with_book(&self.triggers, 0, |book| {
            apply_set_trigger(
                book,
                &SetCall {
                    trader: Trader {
                        seat,
                        owner: &[key; 32],
                    },
                    seat: &seat_now,
                    params: &params,
                    mark: risk.mark,
                    mark_fresh: risk.is_usable_for_liquidation(NOW),
                    now: NOW,
                    client_order_id: client,
                },
                &request,
            )
            .unwrap()
        })
    }

    fn fire_at(&self, now: i64, max: usize, paused: bool) -> noirwire_orderbook_engine::FirePass {
        let exchange = Exchange {
            paused,
            ..self.exchange.clone()
        };
        let mut ledger = load_ledger_mut(&self.ledger).unwrap();
        let mut loaded = MarketAccounts::load(&self.market, &self.book, &self.price, 0).unwrap();
        let mut tape = load_mut::<TapeData>(&self.tape, Scope::Market(0)).unwrap();
        let mut stats = load_mut::<StatsData>(&self.stats, Scope::Global).unwrap();
        let mut data = load_triggers_mut(&self.triggers, 0).unwrap();
        let mut book = open_book(&mut data).unwrap();
        let mut risk = RiskTable::new();
        risk.set(0, loaded.risk()).unwrap();
        let env = env(&exchange, now, &risk.markets);
        fired(&mut Firing {
            env: &env,
            market_id: 0,
            max_fires: max,
            ledger: &mut ledger,
            loaded: &mut loaded,
            tape: &mut tape,
            stats: &mut stats,
            book: &mut book,
        })
        .unwrap()
    }

    fn fire(&self, max: usize) -> noirwire_orderbook_engine::FirePass {
        self.fire_at(NOW, max, false)
    }

    fn everything(&self) -> Vec<Vec<u8>> {
        [
            &self.ledger,
            &self.market,
            &self.book,
            &self.tape,
            &self.stats,
            &self.triggers,
        ]
        .iter()
        .map(|info| bytes_of(info))
        .collect()
    }

    fn tape_written(&self) -> u64 {
        load_mut::<TapeData>(&self.tape, Scope::Market(0))
            .unwrap()
            .written
    }
}

#[test]
fn a_crossed_stop_places_a_reduce_only_order_and_writes_the_tape_and_the_counters() {
    let w = World::new();
    let trader = w.long(1, 100);
    assert_eq!(w.set(trader, 1, 11, stop(950, 900)).status, STATUS_DONE);
    w.mark(940);
    w.bid_at_930(2, 100);
    let written_before = w.tape_written();
    let orders_before = load_mut::<StatsData>(&w.stats, Scope::Global)
        .unwrap()
        .orders;

    let pass = w.fire(1);

    assert_eq!((pass.due, pass.placed, pass.refused), (1, 1, 0));
    assert_eq!(w.base(trader), 0);
    assert_eq!(w.tape_written(), written_before + 1);
    let stats = load_mut::<StatsData>(&w.stats, Scope::Global).unwrap();
    assert_eq!(stats.orders, orders_before + 1);
    assert_eq!(
        stats.open_interest[0], 100,
        "the lots passed from the stopped seat to the bidder"
    );
    drop(stats);
    with_book(&w.triggers, 0, |book| {
        assert!(book.record(trader, Kind::StopLoss).is_none());
    });
}

#[test]
fn a_partial_fill_leaves_the_rest_armed() {
    let w = World::new();
    let trader = w.long(1, 100);
    w.set(trader, 1, 11, stop(950, 900));
    w.mark(940);
    w.bid_at_930(2, 40);

    let pass = w.fire(1);

    assert_eq!((pass.placed, pass.filled_lots, pass.rearmed), (1, 40, 1));
    assert_eq!(w.base(trader), 60);
    with_book(&w.triggers, 0, |book| {
        assert!(book.record(trader, Kind::StopLoss).is_some());
    });
}

#[test]
fn a_pass_takes_no_more_than_it_is_asked_to() {
    let w = World::new();
    let first = w.long(1, 100);
    let second = w.long(3, 100);
    w.set(first, 1, 11, stop(950, 900));
    w.set(second, 3, 12, stop(950, 900));
    w.mark(940);
    w.bid_at_930(5, 100);
    w.bid_at_930(6, 100);

    let pass = w.fire(1);

    assert_eq!((pass.due, pass.placed), (1, 1));
    assert_eq!(w.base(first) + w.base(second), 100, "one of the two closed");
}

#[test]
fn a_pass_that_has_nothing_to_do_changes_no_byte_and_succeeds() {
    let w = World::new();
    let trader = w.long(1, 100);
    w.set(trader, 1, 11, stop(950, 900));
    w.mark(940);
    w.bid_at_930(2, 100);
    let before = w.everything();

    assert!(w.fire_at(NOW + 1_000, 1, false).idle.is_some(), "old mark");
    assert!(w.fire_at(NOW, 1, true).idle.is_some(), "exchange paused");
    assert_eq!(w.everything(), before);

    w.mark(1_000);
    let quiet = w.fire(1);
    assert_eq!((quiet.idle, quiet.due, quiet.placed), (None, 0, 0));
    assert_eq!(
        w.everything()[..5],
        before[..5],
        "mark above the stop: nothing due, and only the book's own cursor moves"
    );
}

#[test]
fn a_stop_set_before_the_key_reset_does_not_fire_after_it() {
    let w = World::new();
    let trader = w.long(1, 100);
    w.set(trader, 1, 11, stop(950, 900));
    w.mark(940);
    w.bid_at_930(2, 100);
    let mut view = ViewData::zeroed();
    view.owner = [1; 32];
    view.seat = trader;

    clear_stops(
        &w.exchange,
        &w.ledger,
        &view,
        std::slice::from_ref(&w.triggers),
    )
    .unwrap();
    let pass = w.fire(1);

    assert_eq!((pass.due, pass.placed), (0, 0));
    assert_eq!(w.base(trader), 100);
}

#[test]
fn routine_rotation_leaves_triggers_armed() {
    let w = World::new();
    let trader = w.long(1, 100);
    w.set(trader, 1, 11, stop(950, 900));
    let mut view = ViewData::zeroed();
    view.owner = [1; 32];
    view.order_keys[0] = [9; 32];
    crate::view::use_order_key(
        &mut view,
        &Pubkey::new_from_array([9; 32]),
        &Pubkey::new_unique(),
    )
    .unwrap();
    with_book(&w.triggers, 0, |book| {
        assert!(book.record(trader, Kind::StopLoss).is_some());
    });
}

fn trigger_header(info: &AccountInfo) -> TriggerHeader {
    *bytemuck::from_bytes(&bytes_of(info)[HEADER_LEN..HEADER_LEN + 40])
}

#[test]
fn a_sweep_drops_what_no_longer_belongs_and_its_cursor_wraps() {
    let info = book_account(0, 4);
    let (params, seat) = (perp_params(0), holding(1, 100));
    with_book(&info, 0, |book| {
        set_on(book, 1, &seat, &params, 1_000, true, stop(950, 900)).unwrap();
        set_on(
            book,
            2,
            &holding(1, 100),
            &params,
            1_000,
            true,
            stop(950, 900),
        )
        .unwrap();
    });
    let mut seats = [Seat::zeroed(); 4];
    seats[2] = holding(1, 100);

    with_book(&info, 0, |book| sweep_slots(book, &seats, 3, NOW).unwrap());
    assert_eq!(trigger_header(&info).sweep_cursor, 3);
    with_book(&info, 0, |book| {
        assert!(
            book.record(1, Kind::StopLoss).is_none(),
            "its seat is closed"
        );
        assert!(book.record(2, Kind::StopLoss).is_some());
        sweep_slots(book, &seats, 3, NOW).unwrap();
    });
    assert_eq!(trigger_header(&info).sweep_cursor, 2);
}

#[test]
fn a_sweep_of_no_slots_or_of_too_many_is_refused() {
    let info = book_account(0, 4);
    let seats = [Seat::zeroed(); 4];
    for count in [0, SWEEP_TRIGGER_SLOTS_PER_CALL + 1] {
        let refused = with_book(&info, 0, |book| {
            refusal(sweep_slots(book, &seats, count, NOW))
        });
        assert_eq!(refused, error!(OrderbookError::InvalidSettings), "{count}");
    }
}

#[test]
fn a_trigger_book_must_be_the_one_the_loader_expects() {
    let seats = 16u32;
    let len = trigger_account_len(seats as usize).unwrap();
    assert!(load_triggers_mut(&book_account(0, seats), 0).is_ok());
    assert_eq!(len, 16 + 40 + 208 * 16);

    let wrong = |header: Header, info: AccountInfo<'static>| {
        write(&info, 0, bytemuck::bytes_of(&header));
        info
    };
    let fresh = |market: u8| book_account(market, seats);

    let tag = {
        let info = fresh(0);
        let mut header = *bytemuck::from_bytes::<Header>(&bytes_of(&info)[..HEADER_LEN]);
        header.tag = *b"nwbook\0\0";
        wrong(header, info)
    };
    assert_eq!(
        refusal(load_triggers_mut(&tag, 0)),
        error!(OrderbookError::WrongKind)
    );

    let other_market = {
        let info = fresh(0);
        let mut header = *bytemuck::from_bytes::<Header>(&bytes_of(&info)[..HEADER_LEN]);
        header.market_id = 1;
        wrong(header, info)
    };
    assert_eq!(
        refusal(load_triggers_mut(&other_market, 0)),
        error!(OrderbookError::WrongMarket)
    );

    let unready = {
        let info = fresh(0);
        let mut header = *bytemuck::from_bytes::<Header>(&bytes_of(&info)[..HEADER_LEN]);
        header.ready = 0;
        wrong(header, info)
    };
    assert_eq!(
        refusal(load_triggers_mut(&unready, 0)),
        error!(OrderbookError::NotReady)
    );

    let foreign = {
        let info = fresh(0);
        account(*info.key, Pubkey::new_unique(), len, false, true)
    };
    write(&foreign, 0, &bytes_of(&fresh(0)));
    assert_eq!(
        refusal(load_triggers_mut(&foreign, 0)),
        error!(OrderbookError::WrongOwner)
    );

    let read_only = {
        let info = fresh(0);
        let copy = account(*info.key, crate::ID, len, false, false);
        write(&copy, 0, &bytes_of(&info));
        copy
    };
    assert_eq!(
        refusal(load_triggers_mut(&read_only, 0)),
        error!(anchor_lang::error::ErrorCode::ConstraintMut)
    );

    for bad_len in [len - 8, len + 8, len - 208] {
        let info = fresh(0);
        let sized = account(*info.key, crate::ID, bad_len, false, true);
        let keep = bad_len.min(len);
        write(&sized, 0, &bytes_of(&info)[..keep]);
        assert_eq!(
            refusal(load_triggers_mut(&sized, 0)),
            error!(OrderbookError::WrongSize),
            "{bad_len} bytes"
        );
    }
}

fn unready_book(market_id: u8, len: usize) -> AccountInfo<'static> {
    let info = market_stamped::<TriggerData>(market_id, len);
    let mut header = *bytemuck::from_bytes::<Header>(&bytes_of(&info)[..HEADER_LEN]);
    header.ready = 0;
    write(&info, 0, bytemuck::bytes_of(&header));
    info
}

fn market_of_kind(market_id: u8, kind: u8) -> AccountInfo<'static> {
    let info = market_stamped::<MarketData>(market_id, MarketData::LEN);
    let mut market = load_mut::<MarketData>(&info, Scope::Market(market_id)).unwrap();
    market.params.kind = kind;
    drop(market);
    info
}

fn finalize(
    signer_key: Pubkey,
    exchange: &AccountInfo<'static>,
    market: &AccountInfo<'static>,
    triggers: &AccountInfo<'static>,
) -> core::result::Result<(), ProgramError> {
    run(
        vec![
            signer(signer_key),
            exchange.clone(),
            market.clone(),
            triggers.clone(),
        ],
        crate::instruction::FinalizeTriggerBook { market_id: 0 }.data(),
    )
}

#[test]
fn a_perp_trigger_book_finalises_at_the_ledgers_capacity_and_a_spot_one_holds_only_a_header() {
    let admin = Pubkey::new_unique();
    let exchange = exchange_account(live_exchange(admin));
    let seats = u32::try_from(MIN_SEATS).unwrap();

    let perp = unready_book(0, trigger_account_len(MIN_SEATS).unwrap());
    finalize(admin, &exchange, &market_of_kind(0, KIND_PERP), &perp).unwrap();
    let ready = load_triggers_mut(&perp, 0).unwrap();
    drop(ready);
    let header = trigger_header(&perp);
    assert_eq!((header.market_id, header.seat_capacity), (0, seats));
    with_book(&perp, 0, |book| assert_eq!(book.heap_len(0), 0));

    let spot = unready_book(0, trigger_account_len(0).unwrap());
    assert_eq!(bytes_of(&spot).len(), 56);
    finalize(
        admin,
        &exchange,
        &market_of_kind(0, noirwire_orderbook_engine::KIND_SPOT),
        &spot,
    )
    .unwrap();
    assert_eq!(trigger_header(&spot).seat_capacity, 0);
    assert!(load_triggers_mut(&spot, 0).is_ok());
}

#[test]
fn finalising_is_the_admins_and_needs_the_full_length_zeroed_bytes_and_happens_once() {
    let admin = Pubkey::new_unique();
    let exchange = exchange_account(live_exchange(admin));
    let market = market_of_kind(0, KIND_PERP);
    let len = trigger_account_len(MIN_SEATS).unwrap();

    let book = unready_book(0, len);
    assert_eq!(
        finalize(Pubkey::new_unique(), &exchange, &market, &book),
        refused_with(OrderbookError::NotAdmin)
    );
    let short = unready_book(0, len - 208);
    assert_eq!(
        finalize(admin, &exchange, &market, &short),
        refused_with(OrderbookError::WrongSize)
    );
    let dirty = unready_book(0, len);
    write(&dirty, len - 8, &[1]);
    assert_eq!(
        finalize(admin, &exchange, &market, &dirty),
        refused_with(OrderbookError::TriggerBookInvalid)
    );
    finalize(admin, &exchange, &market, &book).unwrap();
    assert_eq!(
        finalize(admin, &exchange, &market, &book),
        refused_with(OrderbookError::AlreadyReady)
    );
}

fn give_position(ledger: &AccountInfo, index: u32, market: u8, base: i64) {
    let mut open = load_ledger_mut(ledger).unwrap();
    let seat = &mut open.seats[index as usize];
    seat.slot_markets[usize::from(market)] = market + 1;
    seat.perp[usize::from(market)].base = base;
}

struct Reset {
    exchange: Exchange,
    ledger: AccountInfo<'static>,
    books: [AccountInfo<'static>; 2],
    seat: u32,
}

fn reset_world() -> Reset {
    let mut exchange = live_exchange(Pubkey::new_unique());
    exchange.perp_markets = 0b11;
    let ledger = ledger_of(MIN_SEATS);
    let seat = {
        let mut open = load_ledger_mut(&ledger).unwrap();
        take_seat(&mut open.engine(), &KEY_A).unwrap()
    };
    give_position(&ledger, seat, 0, 100);
    give_position(&ledger, seat, 1, 100);
    let books = [
        book_account(0, u32::try_from(MIN_SEATS).unwrap()),
        book_account(1, u32::try_from(MIN_SEATS).unwrap()),
    ];
    let reset = Reset {
        exchange,
        ledger,
        books,
        seat,
    };
    for market in 0..2u8 {
        let seat_now = load_ledger(&reset.ledger).unwrap().seats[seat as usize];
        let outcome = with_book(&reset.books[usize::from(market)], market, |book| {
            apply_set_trigger(
                book,
                &SetCall {
                    trader: Trader {
                        seat,
                        owner: &KEY_A,
                    },
                    seat: &seat_now,
                    params: &perp_params(market),
                    mark: 1_000,
                    mark_fresh: true,
                    now: NOW,
                    client_order_id: 1,
                },
                &stop(950, 900),
            )
            .unwrap()
        });
        assert_eq!(outcome.status, STATUS_DONE);
    }
    reset
}

impl Reset {
    fn armed(&self) -> [bool; 2] {
        let armed = |market: u8| {
            with_book(&self.books[usize::from(market)], market, |book| {
                book.record(self.seat, Kind::StopLoss).is_some()
            })
        };
        [armed(0), armed(1)]
    }

    fn view(&self) -> ViewData {
        let mut view = ViewData::zeroed();
        view.owner = KEY_A;
        view.seat = self.seat;
        view
    }

    fn clear(&self, view: &ViewData, books: &[AccountInfo<'static>]) -> Result<()> {
        clear_stops(&self.exchange, &self.ledger, view, books)
    }
}

#[test]
fn a_reset_clears_the_seats_triggers_in_every_perp_markets_book() {
    let reset = reset_world();
    assert_eq!(reset.armed(), [true, true]);
    reset.clear(&reset.view(), &reset.books).unwrap();
    assert_eq!(reset.armed(), [false, false]);
}

#[test]
fn a_reset_that_omits_repeats_or_misnames_a_book_is_refused_and_clears_nothing() {
    let reset = reset_world();
    let view = reset.view();
    assert_eq!(
        refusal(reset.clear(&view, &reset.books[..1])),
        error!(OrderbookError::MarketDataMissing)
    );
    assert_eq!(
        refusal(reset.clear(&view, &[reset.books[0].clone(), reset.books[0].clone()])),
        error!(OrderbookError::DuplicateMarket)
    );
    let third = book_account(2, 2);
    assert_eq!(
        refusal(reset.clear(
            &view,
            &[reset.books[0].clone(), reset.books[1].clone(), third]
        )),
        error!(OrderbookError::NotPerpMarket)
    );
    assert_eq!(reset.armed(), [true, true]);
}

#[test]
fn a_view_that_is_not_seated_clears_nobody_elses_triggers() {
    let reset = reset_world();

    let mut homeless = reset.view();
    homeless.seat = NO_SEAT;
    reset.clear(&homeless, &reset.books).unwrap();

    let mut stale = reset.view();
    stale.owner = [0xB2; 32];
    reset.clear(&stale, &reset.books).unwrap();

    assert_eq!(
        reset.armed(),
        [true, true],
        "the seat is another owner's now"
    );
}

#[test]
fn an_owner_seated_past_a_books_capacity_can_still_reset() {
    let mut reset = reset_world();
    reset.books[1] = book_account(1, 2);
    reset.clear(&reset.view(), &reset.books).unwrap();
    assert!(with_book(&reset.books[0], 0, |book| book
        .record(reset.seat, Kind::StopLoss)
        .is_none()));
}

#[test]
fn set_order_keys_clears_the_triggers_and_moves_the_counter_and_refuses_without_every_book() {
    let reset = reset_world();
    let owner = Pubkey::new_from_array(KEY_A);
    let (view_key, bump) = Pubkey::find_program_address(&[VIEW_SEED, owner.as_ref()], &crate::ID);
    let view = account(view_key, crate::ID, ViewData::LEN, false, true);
    write(
        &view,
        0,
        bytemuck::bytes_of(&Header {
            tag: ViewData::TAG,
            ready: READY,
            market_id: 0,
            bump,
            _padding: [0; 5],
        }),
    );
    {
        let mut body = load_mut::<ViewData>(&view, Scope::Owner(&owner)).unwrap();
        *body = reset.view();
    }
    let keys: [Pubkey; 4] = std::array::from_fn(|_| Pubkey::new_unique());
    let call = |books: &[AccountInfo<'static>]| {
        let mut accounts = vec![
            signer(owner),
            view.clone(),
            exchange_account(reset.exchange.clone()),
            reset.ledger.clone(),
        ];
        accounts.extend(books.iter().cloned());
        run(
            accounts,
            crate::instruction::SetOrderKeys { order_keys: keys }.data(),
        )
    };

    assert_eq!(
        call(&reset.books[..1]),
        refused_with(OrderbookError::MarketDataMissing)
    );
    assert_eq!(reset.armed(), [true, true]);

    call(&reset.books).unwrap();
    assert_eq!(reset.armed(), [false, false]);
    let body = load_mut::<ViewData>(&view, Scope::Owner(&owner)).unwrap();
    assert_eq!(body.owner_nonce, 1);
    assert_eq!(body.order_keys[0], keys[0].to_bytes());
}

#[test]
fn trigger_book_seeds_and_tags_are_the_ones_clients_derive() {
    assert_eq!(TRIGGER_SEED, b"trigger");
    assert_eq!(TriggerData::TAG, *b"nwtrig\0\0");
    assert_eq!(MARKET_SEED, b"market");
    assert_eq!(trigger_account_len(MIN_SEATS), Some(426_040));
    assert_eq!(trigger_account_len(34_492), Some(7_174_392));
    assert_eq!(trigger_account_len(0), Some(56));
}

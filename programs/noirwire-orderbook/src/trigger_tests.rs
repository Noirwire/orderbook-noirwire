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
    JournalEntry, Kind, MarketParams, NewOrder, OrderType, Price, RecordStatus, Seat, Side, Trader,
    TriggerBook, TriggerHeader, TriggerRecord, TriggerSlot, TriggerStatusBlock, KIND_PERP,
    MAX_FILLS, MAX_OPEN_INTEREST_CAP, PLACE_JOURNAL_EXTRA_ENTRIES, ROLE_TAKER, SEAT_OPEN,
    SNAPSHOT_LAYOUT_IDENTITY, STATUS_PAUSED, TRIGGER_MAX_STEPS, TRIGGER_STATUS_ARMED,
    TRIGGER_STATUS_BLOCKED_BY_RESTING_ORDERS, TRIGGER_STATUS_GONE, TRIGGER_STATUS_TAG,
    TRIGGER_STATUS_UNFILLABLE,
};

use crate::errors::OrderbookError;
use crate::growth_tests::{
    account, bytes_of, exchange_account, grown_to, ledger_of, live_exchange, refusal, refused_with,
    run, signer, write,
};
use crate::instructions::setup::zero_and_record;
use crate::instructions::trader::{reset_keys, reset_keys_signed, SignedKeys};
use crate::instructions::triggers::{
    apply_cancel_trigger, apply_set_trigger, fired, firing_env, forget_status_after, sweep_slots,
    Firing, SetCall, TriggerParams,
};
use crate::loader::active::{load_ledger, load_ledger_mut};
use crate::loader::{load_mut, load_triggers_mut, open_book, Scope};
use crate::market::{env, sha256, MarketAccounts};
use crate::owner_auth;
use crate::risk::RiskTable;
use crate::state::{
    ledger_len, trigger_account_len, BookData, Exchange, Header, MarketData, OrderResult,
    PriceData, RollupAccount, StatsData, TapeData, TapeFill, TriggerData, ViewData, HEADER_LEN,
    MARKET_SEED, MAX_SEATS, MIN_SEATS, NO_SEAT, READY, RESULT_CANCEL_TRIGGER, RESULT_SET_TRIGGER,
    STATUS_DONE, STATUS_REFUSED, SWEEP_TRIGGER_SLOTS_PER_CALL, TAPE_FILLS, TRIGGER_SEED, VIEW_SEED,
};
use crate::view::note_trigger_status;

const NOW: i64 = 1_000_000;
const KEY_A: [u8; 32] = [0xA1; 32];

pub(crate) fn perp_params(market_id: u8) -> MarketParams {
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

pub(crate) fn stamped(
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

pub(crate) fn market_stamped<T: RollupAccount>(market_id: u8, len: usize) -> AccountInfo<'static> {
    stamped(T::TAG, T::SEED, &[market_id], market_id, len)
}

/// The seats of a perp market's book: the most an account can hold, whatever the ledger
/// holds.
fn book_seats() -> u32 {
    u32::try_from(MAX_SEATS).unwrap()
}

pub(crate) fn book_account(market_id: u8) -> AccountInfo<'static> {
    let len = trigger_account_len(MAX_SEATS).unwrap();
    let info = market_stamped::<TriggerData>(market_id, len);
    TriggerBook::init(
        &mut info.try_borrow_mut_data().unwrap()[HEADER_LEN..],
        market_id,
        book_seats(),
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
            mark: Some(mark).filter(|_| fresh),
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
    let info = book_account(0);
    with_book(&info, 0, |book| {
        let done = set_on(book, 3, &seat, &params, 1_000, true, stop(950, 900)).unwrap();
        assert_eq!(
            (done.kind, done.status, done.cancelled, done.client_order_id),
            (RESULT_SET_TRIGGER, STATUS_DONE, 0, 7)
        );
        assert_eq!(book.record(3, Kind::StopLoss).unwrap().trigger_price, 950);
        assert!(book.record(3, Kind::TakeProfit).is_none());

        let again = set_on(book, 3, &seat, &params, 1_000, true, stop(940, 900)).unwrap();
        assert_eq!((again.status, again.cancelled), (STATUS_DONE, 1));
        assert_eq!(book.record(3, Kind::StopLoss).unwrap().trigger_price, 940);
    });
}

#[test]
fn every_refusal_that_depends_on_the_seat_is_an_outcome_and_changes_nothing() {
    let long = holding(1, 100);
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
            book_seats(),
            stop(950, 900),
            OrderbookError::TriggerBookTooSmall,
        ),
    ];
    for (name, seat, params, fresh, index, request, expected) in cases {
        let info = book_account(0);
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
    let info = book_account(0);
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
    let info = book_account(0);
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
                mark: Some(1_000),
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
    let info = book_account(0);
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
    let info = book_account(0);
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
    let info = book_account(0);
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

pub(crate) fn global<T: RollupAccount>() -> AccountInfo<'static> {
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
            triggers: book_account(0),
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
                    mark: risk.usable_mark(NOW),
                    now: NOW,
                    client_order_id: client,
                },
                &request,
            )
            .unwrap()
        })
    }

    fn fire_at(&self, now: i64, max: usize, paused: bool) -> noirwire_orderbook_engine::FirePass {
        self.try_fire_at(now, max, paused).unwrap()
    }

    fn try_fire_at(
        &self,
        now: i64,
        max: usize,
        paused: bool,
    ) -> Result<noirwire_orderbook_engine::FirePass> {
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
        let env = firing_env(&exchange, now, &risk.markets);
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
fn a_firing_env_never_carries_more_than_the_trigger_step_bound() {
    let mut exchange = live_exchange(Pubkey::new_unique());
    exchange.max_steps = 32;
    assert_eq!(env(&exchange, NOW, &[]).max_steps, 32);
    assert_eq!(
        firing_env(&exchange, NOW, &[]).max_steps,
        u32::from(TRIGGER_MAX_STEPS)
    );
    exchange.max_steps = 8;
    assert_eq!(firing_env(&exchange, NOW, &[]).max_steps, 8);
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

    reset_keys(&w.exchange, &w.ledger, &mut view, &Reset::new_keys()).unwrap();
    let pass = w.fire(1);

    assert_eq!((pass.placed, pass.dropped), (0, 1));
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
fn a_sweep_drops_what_no_longer_belongs_and_its_cursor_wraps_at_the_ledgers_seats() {
    let info = book_account(0);
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
    let info = book_account(0);
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
    let len = trigger_account_len(MAX_SEATS).unwrap();
    assert!(load_triggers_mut(&book_account(0), 0).is_ok());
    assert_eq!(len, 16 + 40 + (192 + 16) * MAX_SEATS);
    assert_eq!(len, 7_174_392);

    let wrong = |header: Header, info: AccountInfo<'static>| {
        write(&info, 0, bytemuck::bytes_of(&header));
        info
    };
    let fresh = book_account;

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

    let other_version = {
        let info = fresh(0);
        write(&info, HEADER_LEN, &1u32.to_le_bytes());
        info
    };
    assert_eq!(
        refusal(load_triggers_mut(&other_version, 0)),
        error!(OrderbookError::TriggerBookInvalid),
        "an earlier version of the book"
    );

    let small = {
        let seats = 16u32;
        let info = market_stamped::<TriggerData>(0, trigger_account_len(16).unwrap());
        TriggerBook::init(
            &mut info.try_borrow_mut_data().unwrap()[HEADER_LEN..],
            0,
            seats,
        )
        .unwrap();
        info
    };
    assert_eq!(
        refusal(load_triggers_mut(&small, 0)),
        error!(OrderbookError::TriggerBookInvalid),
        "a book of the right length for its own header but not for the largest ledger"
    );
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
fn a_perp_trigger_book_finalises_at_the_largest_ledger_and_a_spot_one_holds_only_a_header() {
    let admin = Pubkey::new_unique();
    let live = live_exchange(admin);
    assert!(
        live.seat_capacity < book_seats(),
        "the ledger is smaller than the book"
    );
    let exchange = exchange_account(live);

    let perp = unready_book(0, trigger_account_len(MAX_SEATS).unwrap());
    finalize(admin, &exchange, &market_of_kind(0, KIND_PERP), &perp).unwrap();
    let ready = load_triggers_mut(&perp, 0).unwrap();
    drop(ready);
    let header = trigger_header(&perp);
    assert_eq!((header.market_id, header.seat_capacity), (0, book_seats()));
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
    let len = trigger_account_len(MAX_SEATS).unwrap();

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
    let books = [book_account(0), book_account(1)];
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
                    mark: Some(1_000),
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
    fn stored(&self) -> Seat {
        load_ledger(&self.ledger).unwrap().seats[self.seat as usize]
    }

    /// Whether the seat's stop-loss in each market's book still stands as its owner
    /// would be told: a record the seat no longer matches reads `Gone`.
    fn armed(&self) -> [bool; 2] {
        let seat = self.stored();
        let armed = |market: u8| {
            with_book(&self.books[usize::from(market)], market, |book| {
                let status = book
                    .status_of(self.seat, &seat, &perp_params(market), None, NOW)
                    .unwrap();
                status.stop_loss != RecordStatus::Gone
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

    fn new_keys() -> [Pubkey; 4] {
        std::array::from_fn(|_| Pubkey::new_unique())
    }

    fn reset(&self, view: &mut ViewData) -> Result<()> {
        reset_keys(&self.exchange, &self.ledger, view, &Reset::new_keys())
    }

    fn set_epoch(&self, epoch: u32) {
        let mut open = load_ledger_mut(&self.ledger).unwrap();
        open.seats[self.seat as usize].seat_epoch = epoch;
    }
}

#[test]
fn a_key_reset_kills_the_seats_triggers_in_every_market_without_any_book() {
    let reset = reset_world();
    assert_eq!(reset.armed(), [true, true]);
    let (epoch, version) = (reset.stored().seat_epoch(), reset.stored().version);
    let mut view = reset.view();
    view.snapshot.layout = 7;
    view.snapshot._seat_reserved[0] = TRIGGER_STATUS_TAG;

    reset.reset(&mut view).unwrap();

    assert_eq!(reset.armed(), [false, false]);
    assert_eq!(reset.stored().seat_epoch(), epoch + 1);
    assert_eq!(reset.stored().version, version + 1);
    assert_eq!(view.owner_nonce, 1);
    assert_eq!(
        view.snapshot._seat_reserved[0], 0,
        "the cached status is unknown again"
    );
    assert_eq!(view.snapshot.seat.seat_epoch(), epoch + 1);
    assert_eq!(view.snapshot.layout, SNAPSHOT_LAYOUT_IDENTITY);
}

#[test]
fn a_trigger_set_after_a_key_reset_is_live_and_one_set_before_stays_dead() {
    let reset = reset_world();
    reset.reset(&mut reset.view()).unwrap();
    let seat = reset.stored();
    let set = with_book(&reset.books[0], 0, |book| {
        set_on(
            book,
            reset.seat,
            &seat,
            &perp_params(0),
            1_000,
            true,
            stop(940, 900),
        )
        .unwrap()
    });
    assert_eq!(set.status, STATUS_DONE);
    assert_eq!(reset.armed(), [true, false]);
}

#[test]
fn a_key_reset_at_the_last_epoch_is_refused_and_changes_nothing() {
    let reset = reset_world();
    reset.set_epoch(u32::MAX);
    let before = bytes_of(&reset.ledger);
    let mut view = reset.view();

    assert_eq!(
        refusal(reset.reset(&mut view)),
        error!(OrderbookError::SeatEpochExhausted)
    );

    assert_eq!(bytes_of(&reset.ledger), before);
    assert_eq!(view.owner_nonce, 0);
}

#[test]
fn an_unseated_view_rotates_its_keys_and_never_writes_the_old_seat() {
    let reset = reset_world();
    let before = bytes_of(&reset.ledger);

    let mut homeless = reset.view();
    homeless.seat = NO_SEAT;
    let keys = Reset::new_keys();
    reset_keys(&reset.exchange, &reset.ledger, &mut homeless, &keys).unwrap();
    assert_eq!(homeless.order_keys[0], keys[0].to_bytes());
    assert_eq!(homeless.owner_nonce, 1);

    let mut released = reset.view();
    released.seat = reset.seat;
    {
        let mut open = load_ledger_mut(&reset.ledger).unwrap();
        open.seats[reset.seat as usize].status = 0;
    }
    let after_release = bytes_of(&reset.ledger);
    reset.reset(&mut released).unwrap();
    assert_eq!(released.owner_nonce, 1);

    assert_ne!(before, after_release);
    assert_eq!(bytes_of(&reset.ledger), after_release, "a released seat");
}

#[test]
fn a_seat_that_is_a_strangers_now_is_never_written_by_a_key_reset() {
    let reset = reset_world();
    let before = bytes_of(&reset.ledger);

    let mut stale = reset.view();
    stale.owner = [0xB2; 32];
    reset.reset(&mut stale).unwrap();

    assert_eq!(stale.owner_nonce, 1);
    assert_eq!(bytes_of(&reset.ledger), before);
    assert_eq!(
        reset.armed(),
        [true, true],
        "the seat is another owner's now"
    );
}

#[test]
fn set_order_keys_kills_the_triggers_and_moves_the_counter_with_no_book_in_the_transaction() {
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
    let accounts = vec![
        signer(owner),
        view.clone(),
        exchange_account(reset.exchange.clone()),
        reset.ledger.clone(),
    ];
    assert_eq!(reset.armed(), [true, true]);

    run(
        accounts,
        crate::instruction::SetOrderKeys { order_keys: keys }.data(),
    )
    .unwrap();

    assert_eq!(reset.armed(), [false, false]);
    let body = load_mut::<ViewData>(&view, Scope::Owner(&owner)).unwrap();
    assert_eq!(body.owner_nonce, 1);
    assert_eq!(body.order_keys[0], keys[0].to_bytes());
}

fn owner_view(reset: &Reset, owner: &Pubkey) -> AccountInfo<'static> {
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
    *load_mut::<ViewData>(&view, Scope::Owner(owner)).unwrap() = reset.view();
    view
}

/// The instructions sysvar of a transaction whose second instruction is this program's
/// and whose first is an Ed25519 proof of `owner` over `text`.
fn proof_sysvar(owner: &Pubkey, text: &str) -> AccountInfo<'static> {
    use anchor_lang::solana_program::instruction::BorrowedInstruction;
    use solana_instructions_sysvar::{construct_instructions_data, store_current_index_checked};

    const HEADER: usize = 16;
    const SIGNATURE: usize = HEADER + 32;
    const MESSAGE: usize = SIGNATURE + 64;
    let message = text.as_bytes();
    let mut proof = vec![0u8; MESSAGE + message.len()];
    proof[0] = 1;
    for (at, value) in [
        (2, SIGNATURE),
        (4, usize::from(u16::MAX)),
        (6, HEADER),
        (8, usize::from(u16::MAX)),
        (10, MESSAGE),
        (12, message.len()),
        (14, usize::from(u16::MAX)),
    ] {
        proof[at..at + 2].copy_from_slice(&u16::try_from(value).unwrap().to_le_bytes());
    }
    proof[HEADER..SIGNATURE].copy_from_slice(owner.as_ref());
    proof[MESSAGE..].copy_from_slice(message);
    let ed25519 = solana_sdk_ids::ed25519_program::ID;
    let program = crate::ID;
    let instructions = [
        BorrowedInstruction {
            program_id: &ed25519,
            accounts: vec![],
            data: &proof,
        },
        BorrowedInstruction {
            program_id: &program,
            accounts: vec![],
            data: &[],
        },
    ];
    let mut data = construct_instructions_data(&instructions);
    store_current_index_checked(&mut data, 1).unwrap();
    let sysvar = account(
        solana_instructions_sysvar::ID,
        solana_sdk_ids::sysvar::ID,
        data.len(),
        false,
        false,
    );
    write(&sysvar, 0, &data);
    sysvar
}

const EXPIRES: i64 = NOW + 60;

fn signed_by(keys: &[Pubkey; 4], nonce: u32) -> SignedKeys {
    SignedKeys {
        order_keys: *keys,
        nonce,
        expires_at: EXPIRES,
    }
}

fn proof_for(owner: &Pubkey, keys: &[Pubkey; 4], nonce: u32) -> AccountInfo<'static> {
    let text = owner_auth::message(false, owner, keys, Some(nonce), EXPIRES);
    proof_sysvar(owner, &text)
}

#[test]
fn a_signed_key_replacement_kills_the_triggers_and_moves_the_epoch_and_the_nonce() {
    let reset = reset_world();
    let owner = Pubkey::new_from_array(KEY_A);
    let view = owner_view(&reset, &owner);
    let keys = Reset::new_keys();
    let (epoch, version) = (reset.stored().seat_epoch(), reset.stored().version);
    assert_eq!(reset.armed(), [true, true]);

    reset_keys_signed(
        &reset.exchange,
        &reset.ledger,
        &view,
        &proof_for(&owner, &keys, 0),
        &owner,
        &signed_by(&keys, 0),
    )
    .unwrap();

    assert_eq!(reset.armed(), [false, false]);
    assert_eq!(reset.stored().seat_epoch(), epoch + 1);
    assert_eq!(reset.stored().version, version + 1);
    let body = load_mut::<ViewData>(&view, Scope::Owner(&owner)).unwrap();
    assert_eq!(body.owner_nonce, 1);
    assert_eq!(body.order_keys[3], keys[3].to_bytes());
}

#[test]
fn a_signed_key_replacement_that_is_refused_leaves_the_seat_and_the_view_unchanged() {
    let owner = Pubkey::new_from_array(KEY_A);
    let keys = Reset::new_keys();
    let mut repeated = keys;
    repeated[1] = repeated[0];
    let other = Reset::new_keys();
    let cases = [
        (
            "a nonce the view has moved past",
            keys,
            proof_for(&owner, &keys, 5),
            signed_by(&keys, 5),
            OrderbookError::WrongOwnerNonce,
        ),
        (
            "a list that repeats a key",
            repeated,
            proof_for(&owner, &repeated, 0),
            signed_by(&repeated, 0),
            OrderbookError::InvalidOrderKey,
        ),
        (
            "a proof over other keys",
            keys,
            proof_for(&owner, &other, 0),
            signed_by(&keys, 0),
            OrderbookError::InvalidOwnerProof,
        ),
        (
            "a proof of another owner",
            keys,
            proof_for(&Pubkey::new_unique(), &keys, 0),
            signed_by(&keys, 0),
            OrderbookError::InvalidOwnerProof,
        ),
    ];
    for (name, _, sysvar, signed, expected) in cases {
        let reset = reset_world();
        let view = owner_view(&reset, &owner);
        let (ledger, before_view) = (bytes_of(&reset.ledger), bytes_of(&view));

        let refused = reset_keys_signed(
            &reset.exchange,
            &reset.ledger,
            &view,
            &sysvar,
            &owner,
            &signed,
        );

        assert_eq!(refusal(refused), Error::from(expected), "{name}");
        assert_eq!(bytes_of(&reset.ledger), ledger, "{name}");
        assert_eq!(bytes_of(&view), before_view, "{name}");
        assert_eq!(reset.armed(), [true, true], "{name}");
    }
}

impl World {
    fn view_after_sync(&self, seat: u32, key: u8) -> ViewData {
        let seat_now = load_ledger(&self.ledger).unwrap().seats[seat as usize];
        let mut view = ViewData::zeroed();
        view.owner = [key; 32];
        view.seat = seat;
        let params = load_mut::<MarketData>(&self.market, Scope::Market(0))
            .unwrap()
            .params;
        let risk = MarketAccounts::load(&self.market, &self.book, &self.price, 0)
            .unwrap()
            .risk();
        let usable_mark = risk.usable_mark(NOW);
        with_book(&self.triggers, 0, |book| {
            note_trigger_status(&mut view, 0, book, &seat_now, &params, usable_mark, NOW).unwrap();
        });
        view
    }

    fn set_min_size(&self, lots: u64) {
        load_mut::<MarketData>(&self.market, Scope::Market(0))
            .unwrap()
            .params
            .min_size = lots;
    }

    fn status_block(&self, seat: u32, key: u8) -> TriggerStatusBlock {
        let view = self.view_after_sync(seat, key);
        bytemuck::pod_read_unaligned(
            &view.snapshot._seat_reserved[..size_of::<TriggerStatusBlock>()],
        )
    }

    fn cancel(&self, seat: u32, key: u8, kind: u8) -> OrderResult {
        let seat_now = load_ledger(&self.ledger).unwrap().seats[seat as usize];
        with_book(&self.triggers, 0, |book| {
            apply_cancel_trigger(
                book,
                Trader {
                    seat,
                    owner: &[key; 32],
                },
                &seat_now,
                kind,
                NOW,
                5,
            )
            .unwrap()
        })
    }
}

fn block_of(view: &ViewData) -> TriggerStatusBlock {
    bytemuck::pod_read_unaligned(&view.snapshot._seat_reserved[..size_of::<TriggerStatusBlock>()])
}

#[test]
fn a_set_clears_the_status_a_sync_wrote_for_its_market() {
    let w = World::new();
    let trader = w.long(1, 100);
    let mut view = w.view_after_sync(trader, 1);
    assert_eq!(block_of(&view).stop_loss, TRIGGER_STATUS_GONE);
    assert_eq!(block_of(&view).tag, TRIGGER_STATUS_TAG);

    let outcome = w.set(trader, 1, 11, stop(950, 900));
    forget_status_after(&mut view, 0, &outcome);

    assert_eq!(view.snapshot._seat_reserved[0], 0, "unknown until a sync");
    assert_eq!(
        block_of(&w.view_after_sync(trader, 1)).stop_loss,
        TRIGGER_STATUS_ARMED
    );
}

#[test]
fn a_cancel_clears_the_status_a_sync_wrote_for_its_market() {
    let w = World::new();
    let trader = w.long(1, 100);
    w.set(trader, 1, 11, stop(950, 900));
    let mut view = w.view_after_sync(trader, 1);
    assert_eq!(block_of(&view).stop_loss, TRIGGER_STATUS_ARMED);

    let outcome = w.cancel(trader, 1, 1);
    forget_status_after(&mut view, 0, &outcome);

    assert_eq!(view.snapshot._seat_reserved[0], 0);
}

#[test]
fn a_set_or_cancel_leaves_the_status_of_another_market_and_a_refusal_leaves_its_own() {
    let w = World::new();
    let trader = w.long(1, 100);
    w.set(trader, 1, 11, stop(950, 900));
    let synced = w.view_after_sync(trader, 1);
    let done = w.cancel(trader, 1, 1);
    assert_eq!(done.status, STATUS_DONE);

    let mut elsewhere = synced;
    forget_status_after(&mut elsewhere, 1, &done);
    assert_eq!(block_of(&elsewhere).tag, TRIGGER_STATUS_TAG);

    let refused_outcome = w.set(trader, 1, 12, stop(1_050, 900));
    assert_eq!(refused_outcome.status, STATUS_REFUSED);
    let mut kept = elsewhere;
    forget_status_after(&mut kept, 0, &refused_outcome);
    assert_eq!(block_of(&kept).tag, TRIGGER_STATUS_TAG);
}

#[test]
fn raising_the_minimum_past_a_fixed_size_stop_reads_unfillable_in_the_next_sync_with_no_fire() {
    let w = World::new();
    let trader = w.long(1, 100);
    w.set(
        trader,
        1,
        11,
        TriggerParams {
            size: 2,
            ..stop(950, 900)
        },
    );
    assert_eq!(w.status_block(trader, 1).stop_loss, TRIGGER_STATUS_ARMED);

    w.set_min_size(6);
    let block = w.status_block(trader, 1);
    assert_eq!(block.stop_loss, TRIGGER_STATUS_UNFILLABLE);
    assert_eq!(block.stop_loss_retry, 0);

    w.set_min_size(1);
    let block = w.status_block(trader, 1);
    assert_eq!(block.stop_loss, TRIGGER_STATUS_ARMED);
    assert_eq!(block.stop_loss_retry, 0);
}

#[test]
fn a_view_that_never_synced_says_unknown_and_a_sync_after_a_set_says_armed() {
    let w = World::new();
    let trader = w.long(1, 100);
    assert_eq!(ViewData::zeroed().snapshot._seat_reserved[0], 0);

    w.set(trader, 1, 11, stop(950, 900));
    let block = w.status_block(trader, 1);

    assert_eq!(block.tag, TRIGGER_STATUS_TAG);
    assert_eq!(block.market_id, 0);
    assert_eq!(block.take_profit, TRIGGER_STATUS_GONE);
    assert_eq!(block.stop_loss, TRIGGER_STATUS_ARMED);
    assert_eq!((block.take_profit_retry, block.stop_loss_retry), (0, 0));
}

#[test]
fn a_cancelled_trigger_is_gone_in_the_next_sync() {
    let w = World::new();
    let trader = w.long(1, 100);
    w.set(trader, 1, 11, stop(950, 900));
    w.set(trader, 1, 12, take(1_100, 1_050));
    w.cancel(trader, 1, 1);

    let block = w.status_block(trader, 1);

    assert_eq!(block.stop_loss, TRIGGER_STATUS_GONE);
    assert_eq!(block.take_profit, TRIGGER_STATUS_ARMED);
}

#[test]
fn a_trigger_a_fire_pass_found_below_the_markets_minimum_is_unfillable_with_its_retry_time() {
    let w = World::new();
    let trader = w.long(1, 100);
    w.set(
        trader,
        1,
        11,
        TriggerParams {
            size: 2,
            ..stop(950, 900)
        },
    );
    load_mut::<MarketData>(&w.market, Scope::Market(0))
        .unwrap()
        .params
        .min_size = 6;
    w.mark(940);
    w.bid_at_930(2, 100);
    assert_eq!(w.fire(1).unfillable, 1);

    let retry = with_book(&w.triggers, 0, |book| {
        book.record(trader, Kind::StopLoss).unwrap().next_attempt
    });
    let block = w.status_block(trader, 1);

    assert_ne!(retry, 0);
    assert_eq!(block.stop_loss, TRIGGER_STATUS_UNFILLABLE);
    assert_eq!(block.stop_loss_retry, retry);
    assert_eq!(block.take_profit, TRIGGER_STATUS_GONE);
    assert_eq!(block.take_profit_retry, 0);
}

#[test]
fn a_crossed_take_profit_whose_clipped_price_needs_more_lots_than_its_size_reads_unfillable_at_sync(
) {
    let w = World::new();
    let maker = w.seat(101);
    let trader = w.seat(1);
    w.place(maker, 101, Side::Bid, OrderType::Limit, 1_000, 100);
    w.place(
        trader,
        1,
        Side::Ask,
        OrderType::ImmediateOrCancel,
        1_000,
        100,
    );
    load_mut::<MarketData>(&w.market, Scope::Market(0))
        .unwrap()
        .params
        .min_notional = 1_200;
    w.set(
        trader,
        1,
        11,
        TriggerParams {
            size: 2,
            ..take(900, 950)
        },
    );
    assert_eq!(w.status_block(trader, 1).take_profit, TRIGGER_STATUS_ARMED);

    w.mark(500);
    let block = w.status_block(trader, 1);

    assert_eq!(block.take_profit, TRIGGER_STATUS_UNFILLABLE);
    assert_eq!(block.take_profit_retry, 0, "no attempt was made");
}

#[test]
fn no_byte_of_another_seats_record_reaches_a_view() {
    let w = World::new();
    let mine = w.long(1, 100);
    let theirs = w.long(3, 100);
    let alone = bytes_of_view(&w.view_after_sync(mine, 1));

    w.set(
        theirs,
        3,
        11,
        TriggerParams {
            secret: [0x5E; 16],
            ..stop(950, 900)
        },
    );
    w.set(theirs, 3, 12, take(1_100, 1_050));
    let beside = w.view_after_sync(mine, 1);

    assert_eq!(bytes_of_view(&beside), alone);
    assert_eq!(w.status_block(mine, 1).stop_loss, TRIGGER_STATUS_GONE);
    assert_eq!(w.status_block(mine, 1).take_profit, TRIGGER_STATUS_GONE);
}

fn bytes_of_view(view: &ViewData) -> Vec<u8> {
    bytemuck::bytes_of(view).to_vec()
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

#[test]
fn a_book_made_beside_a_small_ledger_keeps_working_after_the_ledger_grows_to_its_maximum() {
    let mut w = World::new();
    let early = w.long(1, 100);
    assert!((early as usize) < MIN_SEATS);
    assert_eq!(w.set(early, 1, 11, stop(950, 900)).status, STATUS_DONE);

    let old_len = bytes_of(&w.ledger).len();
    let new_len = ledger_len(MAX_SEATS);
    grown_to(&w.ledger, new_len, 0xAA);
    zero_and_record(&mut w.exchange, &w.ledger, old_len, new_len).unwrap();
    assert_eq!(w.exchange.seat_capacity as usize, MAX_SEATS);
    assert_eq!(load_ledger(&w.ledger).unwrap().seats.len(), MAX_SEATS);

    let late = w.long(3, 100);
    assert!(
        (late as usize) >= MIN_SEATS,
        "a seat past the capacity the ledger had when the book was made"
    );
    assert_eq!(w.set(late, 3, 12, stop(950, 900)).status, STATUS_DONE);
    with_book(&w.triggers, 0, |book| {
        assert!(book.record(early, Kind::StopLoss).is_some());
        assert!(book.record(late, Kind::StopLoss).is_some());
    });

    w.mark(940);
    w.bid_at_930(5, 200);
    let pass = w.fire(4);

    assert_eq!((pass.due, pass.placed, pass.refused), (2, 2, 0));
    assert_eq!((w.base(early), w.base(late)), (0, 0));
    let seats = load_ledger(&w.ledger).unwrap().seats.to_vec();
    with_book(&w.triggers, 0, |book| {
        sweep_slots(book, &seats, SWEEP_TRIGGER_SLOTS_PER_CALL, NOW).unwrap();
        assert_eq!(book.active_records(), 0);
    });
}

#[test]
fn a_book_that_disagrees_with_itself_fails_a_set_with_the_public_corrupt_error() {
    let (params, seat) = (perp_params(0), holding(1, 100));
    let info = book_account(0);
    with_book(&info, 0, |book| {
        set_on(book, 3, &seat, &params, 1_000, true, stop(950, 900)).unwrap();
    });
    let slot = HEADER_LEN + size_of::<TriggerHeader>() + 3 * size_of::<TriggerSlot>();
    let stop_loss_generation =
        slot + 32 + size_of::<TriggerRecord>() + core::mem::offset_of!(TriggerRecord, generation);
    write(&info, stop_loss_generation, &u32::MAX.to_le_bytes());

    with_book(&info, 0, |book| {
        assert_eq!(
            refusal(set_on(book, 3, &seat, &params, 1_000, true, stop(940, 900))),
            error!(OrderbookError::TriggerBookCorrupt)
        );
    });
}

#[test]
fn a_pass_over_a_corrupt_book_fails_and_leaves_every_account_unchanged() {
    let w = World::new();
    let (stopped, profited) = (w.long(1, 100), w.long(2, 100));
    assert_eq!(w.set(stopped, 1, 11, stop(950, 900)).status, STATUS_DONE);
    assert_eq!(
        w.set(profited, 2, 12, take(1_020, 1_000)).status,
        STATUS_DONE
    );
    w.mark(1_030);
    w.bid_at_930(3, 200);
    let slot = HEADER_LEN
        + size_of::<TriggerHeader>()
        + usize::try_from(stopped).unwrap() * size_of::<TriggerSlot>();
    let stop_loss_heap =
        slot + 32 + size_of::<TriggerRecord>() + core::mem::offset_of!(TriggerRecord, heap);
    write(&w.triggers, stop_loss_heap, &[0]);
    let before = w.everything();

    for max in 1..=4 {
        assert_eq!(
            refusal(w.try_fire_at(NOW, max, false)),
            error!(OrderbookError::TriggerBookCorrupt),
            "max {max}"
        );
        assert_eq!(w.everything(), before, "max {max}");
    }
}

#[test]
fn a_record_whose_generation_is_past_the_maximum_fails_the_pass_and_changes_nothing() {
    let w = World::new();
    let trader = w.long(1, 100);
    assert_eq!(w.set(trader, 1, 11, stop(950, 900)).status, STATUS_DONE);
    w.mark(940);
    let slot = HEADER_LEN
        + size_of::<TriggerHeader>()
        + usize::try_from(trader).unwrap() * size_of::<TriggerSlot>();
    let stop_loss_generation =
        slot + 32 + size_of::<TriggerRecord>() + core::mem::offset_of!(TriggerRecord, generation);
    write(&w.triggers, stop_loss_generation, &u32::MAX.to_le_bytes());
    let orders_and_money =
        || [&w.ledger, &w.market, &w.book, &w.tape, &w.stats].map(|info| bytes_of(info));
    let before = orders_and_money();

    assert_eq!(
        refusal(w.try_fire_at(NOW, 1, false)),
        error!(OrderbookError::TriggerBookCorrupt)
    );
    assert_eq!(
        orders_and_money(),
        before,
        "no order was placed and nothing was written to the tape; the failed transaction \
         reverts the trigger book's own bytes"
    );
}

#[test]
fn a_stop_refused_for_margin_its_resting_orders_hold_syncs_as_blocked_with_its_retry_time() {
    let w = World::new();
    let trader = w.long(1, 100);
    w.place(trader, 1, Side::Ask, OrderType::Limit, 1_050, 4_000);
    load_mut::<MarketData>(&w.market, Scope::Market(0))
        .unwrap()
        .params
        .im_bps = 5_000;
    assert_eq!(w.set(trader, 1, 11, stop(950, 900)).status, STATUS_DONE);
    w.mark(940);
    w.bid_at_930(2, 100);

    let pass = w.fire(1);

    assert_eq!((pass.placed, pass.refused, pass.rearmed), (0, 1, 1));
    assert_eq!(w.base(trader), 100);
    let retry = with_book(&w.triggers, 0, |book| {
        book.record(trader, Kind::StopLoss).unwrap().next_attempt
    });
    let block = w.status_block(trader, 1);
    assert_eq!(block.stop_loss, TRIGGER_STATUS_BLOCKED_BY_RESTING_ORDERS);
    assert_eq!(block.stop_loss_retry, retry);
    assert_eq!(block.take_profit, TRIGGER_STATUS_GONE);
}

#[test]
fn a_trigger_is_set_while_the_market_is_paused() {
    let w = World::new();
    let trader = w.long(1, 100);
    load_mut::<MarketData>(&w.market, Scope::Market(0))
        .unwrap()
        .params
        .status = STATUS_PAUSED;

    assert_eq!(w.set(trader, 1, 11, stop(950, 900)).status, STATUS_DONE);
    w.mark(940);
    assert_eq!(
        w.fire(1).idle,
        Some(noirwire_orderbook_engine::Idle::MarketPaused)
    );
}

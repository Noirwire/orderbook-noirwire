//! Seats, ownership, custody, receipts, the trader's view and the stored layout:
//! RULES sections 10 to 13 and the parts of DESIGN that the engine carries.

mod common;

use bytemuck::Zeroable;
use common::*;
use core::mem::{align_of, size_of};
use noirwire_orderbook_engine::EngineError as E;
use noirwire_orderbook_engine::*;
use sha2::{Digest, Sha256 as Sha2};

const STRANGER: [u8; 32] = [0xAB; 32];

fn spot_world() -> (World, usize, u32, u32) {
    let mut w = World::new(8, 8);
    let m = w.add_market(spot_params(0));
    let a = w.open();
    let b = w.open();
    for trader in [a, b] {
        w.deposit(trader, Asset::Spot(QUOTE), 1_000_000).unwrap();
        w.deposit(trader, Asset::Spot(BASE), 100_000).unwrap();
    }
    (w, m, a, b)
}

#[test]
fn s12_a_full_seat_table_rejects_and_never_evicts() {
    let mut w = World::new(4, 2);
    let first = w.open();
    let second = w.open();

    assert_eq!((first, second), (2, 3));
    assert_eq!(w.try_open(), Err(E::SeatTableFull));
    assert_eq!(w.header.open_seats, 4);
    assert!(w.seat(first).is_open() && w.seat(second).is_open());
}

#[test]
fn seats_are_opened_at_the_lowest_free_index_and_one_key_holds_one_seat() {
    let mut w = World::new(6, 2);
    let first = w.open();
    let second = w.open();
    let key = w.key(first);

    assert_eq!(w.open_with_key(key), Err(E::SeatAlreadyOpen));
    assert_eq!(w.close(first), Ok(()));
    assert_eq!(w.open_with_key(key), Ok(first));
    assert_eq!(w.open(), second + 1);
    assert_eq!(w.seat(first).owner, key);
}

#[test]
fn the_fee_and_insurance_seats_are_ordinary_seats_at_reserved_indices() {
    let mut w = World::new(4, 2);
    let mut ledger = LedgerMut {
        header: &mut w.header,
        seats: &mut w.seats,
    };

    assert_eq!(
        open_reserved_seat(&mut ledger, FEE_SEAT, &STRANGER),
        Err(E::SeatAlreadyOpen)
    );
    assert_eq!(
        open_reserved_seat(&mut ledger, 2, &STRANGER),
        Err(E::NotReservedSeat)
    );
    assert_eq!(w.close(FEE_SEAT), Err(E::ReservedSeat));
    assert_eq!(w.deposit(INSURANCE_SEAT, Asset::Collateral, 7), Ok(()));
    assert_eq!(
        w.withdraw(INSURANCE_SEAT, Asset::Collateral, 7),
        Err(E::ReservedSeat)
    );
}

#[test]
fn a_seat_closes_only_when_it_holds_nothing() {
    let (mut w, m, a, _) = spot_world();
    let resting = w.place(m, a, limit(Side::Bid, 990, 1)).unwrap();

    assert_eq!(w.close(a), Err(E::SeatNotEmpty));
    w.cancel(m, a, seq(&resting)).unwrap();
    w.withdraw(a, Asset::Spot(QUOTE), 1_000_000).unwrap();
    assert_eq!(w.close(a), Err(E::SeatNotEmpty));
    w.withdraw(a, Asset::Spot(BASE), 100_000).unwrap();
    let version = w.seat(a).version;

    assert_eq!(w.close(a), Ok(()));
    assert!(!w.seat(a).is_open());
    assert_eq!(w.seat(a).version, version + 1);
    assert_eq!(w.close(a), Err(E::SeatNotOpen));
    assert_eq!(w.deposit(a, Asset::Collateral, 1), Err(E::SeatNotOpen));
}

#[test]
fn s13_3_only_the_owner_can_trade_cancel_withdraw_snapshot_or_close_a_seat() {
    let (mut w, m, a, b) = spot_world();
    let resting = w.place(m, a, limit(Side::Bid, 990, 1)).unwrap();
    let other = w.key(b);

    for key in [STRANGER, other] {
        let placing = w.place_as(m, a, key, limit(Side::Bid, 990, 1));
        assert_eq!(placing, Err(E::NotSeatOwner));
        let cancelling = w.cancel_as(m, a, key, seq(&resting));
        assert_eq!(cancelling, Err(E::NotSeatOwner));
        assert_eq!(w.cancel_all_as(m, a, key, 5), Err(E::NotSeatOwner));
        let withdrawing = w.withdraw_as(a, key, Asset::Spot(QUOTE), 1);
        assert_eq!(withdrawing, Err(E::NotSeatOwner));
        assert_eq!(w.close_as(a, key), Err(E::NotSeatOwner));
        assert_eq!(w.snapshot_as(m, a, key).err(), Some(E::NotSeatOwner));
    }
    assert_eq!(
        w.place_as(m, 99, STRANGER, limit(Side::Bid, 990, 1)),
        Err(E::SeatOutOfRange)
    );
    assert_eq!(
        w.place_as(m, 7, STRANGER, limit(Side::Bid, 990, 1)),
        Err(E::SeatNotOpen)
    );
}

#[test]
fn s13_3_only_the_owner_of_the_liquidating_seat_can_liquidate_with_it() {
    let mut w = World::new(8, 8);
    let m = w.add_market(perp_params(0));
    let traders = [w.open(), w.open(), w.open()];
    for trader in traders {
        w.deposit(trader, Asset::Collateral, 100_000).unwrap();
    }
    let [a, b, c] = traders;
    w.withdraw(a, Asset::Collateral, 98_900).unwrap();
    w.place(m, b, limit(Side::Ask, 1_000, 10)).unwrap();
    w.place(m, a, ioc(Side::Bid, 1_000, 10)).unwrap();
    w.set_price(m, 900);

    let stolen = w.liquidate_as(m, c, STRANGER, a, 1);

    assert_eq!(stolen, Err(E::NotSeatOwner));
    let outcome = w.liquidate(m, c, a, 1).unwrap();
    assert_eq!(outcome.status, LiquidationStatus::Liquidated);
}

#[test]
fn s11_anyone_may_deposit_into_an_open_seat_and_custody_follows_every_move() {
    let (mut w, _, a, _) = spot_world();

    assert_eq!(w.deposit(a, Asset::Spot(QUOTE), 0), Err(E::ZeroAmount));
    assert_eq!(w.deposit(a, Asset::Spot(9), 1), Err(E::InvalidToken));
    assert_eq!(w.deposit(99, Asset::Collateral, 1), Err(E::SeatOutOfRange));
    assert_eq!(w.deposit(a, Asset::Collateral, 250), Ok(()));
    assert_eq!(w.withdraw(a, Asset::Spot(9), 1), Err(E::InvalidToken));
    assert_eq!(
        w.withdraw(a, Asset::Spot(QUOTE), 1_000_001),
        Err(E::InsufficientBalance)
    );
    assert_eq!(w.withdraw(a, Asset::Spot(QUOTE), 400_000), Ok(()));

    assert_eq!(w.collateral(a), 250);
    assert_eq!(w.spot(a, QUOTE).available, 600_000);
    assert_eq!(w.custody_collateral, 250);
    assert_eq!(w.custody_spot[usize::from(QUOTE)], 1_600_000);
}

#[test]
fn s11_a_deposit_that_would_overflow_the_balance_is_refused() {
    let (mut w, _, a, _) = spot_world();

    for asset in [Asset::Collateral, Asset::Spot(QUOTE)] {
        let refused = w.deposit(a, asset, u64::MAX);
        assert_eq!(refused, Err(E::BalanceCapExceeded));
    }
}

#[test]
fn locked_spot_tokens_cannot_be_withdrawn() {
    let (mut w, m, a, _) = spot_world();
    w.place(m, a, limit(Side::Ask, 1_010, 10)).unwrap();

    assert_eq!(
        w.withdraw(a, Asset::Spot(BASE), 99_001),
        Err(E::InsufficientBalance)
    );
    assert_eq!(w.withdraw(a, Asset::Spot(BASE), 99_000), Ok(()));
}

#[test]
fn s10_receipts_are_the_first_eight_bytes_of_sha256_of_secret_sequence_and_role() {
    let (mut w, m, a, b) = spot_world();
    let mut maker_order = limit(Side::Ask, 1_000, 2);
    maker_order.secret = [0x11; 16];
    let mut taker_order = ioc(Side::Bid, 1_000, 1);
    taker_order.secret = [0x22; 16];
    w.place(m, b, maker_order).unwrap();
    w.markets[m].book.next_fill_seq = 0x0102_0304_0506_0708;

    w.place(m, a, taker_order).unwrap();
    let first = w.fills.as_slice()[0];
    w.place(m, a, taker_order).unwrap();
    let second = w.fills.as_slice()[0];

    let expected = |secret: [u8; 16], fill_seq: u64, role: u8| -> [u8; 8] {
        let mut hasher = Sha2::new();
        hasher.update(secret);
        hasher.update(fill_seq.to_le_bytes());
        hasher.update([role]);
        hasher.finalize()[..8].try_into().unwrap()
    };
    assert_eq!(first.fill_seq, 0x0102_0304_0506_0708);
    assert_eq!(first.maker_receipt, expected([0x11; 16], first.fill_seq, 0));
    assert_eq!(first.taker_receipt, expected([0x22; 16], first.fill_seq, 1));
    assert_eq!(
        second.maker_receipt,
        expected([0x11; 16], second.fill_seq, 0)
    );
    assert_ne!(first.maker_receipt, second.maker_receipt);
    assert_ne!(first.maker_receipt, first.taker_receipt);
    assert_eq!((ROLE_MAKER, ROLE_TAKER), (0, 1));
}

#[test]
fn snapshot_copies_the_seat_and_its_open_orders_on_one_market_best_first() {
    let (mut w, m, a, b) = spot_world();
    w.place(m, a, limit(Side::Bid, 980, 1)).unwrap();
    w.place(m, b, limit(Side::Bid, 970, 9)).unwrap();
    w.place(m, a, limit(Side::Bid, 990, 2)).unwrap();
    w.place(m, a, limit(Side::Ask, 1_020, 3)).unwrap();
    w.place(m, a, limit(Side::Ask, 1_010, 4)).unwrap();

    let snapshot = w.snapshot_as(m, a, w.key(a)).unwrap();

    assert_eq!(snapshot.seat, *w.seat(a));
    assert_eq!((snapshot.seat_index, snapshot.market_id), (a, 0));
    assert_eq!(snapshot.order_count, 4);
    let listed: Vec<(u64, u64, u8)> = snapshot.orders[..4]
        .iter()
        .map(|o| (o.price, o.remaining, o.flags))
        .collect();
    let ask = ORDER_FLAG_ASK;
    assert_eq!(
        listed,
        vec![(990, 2, 0), (980, 1, 0), (1_010, 4, ask), (1_020, 3, ask)]
    );
    assert_eq!(snapshot.orders[0].locked, 1_980 + 6);
    assert_eq!(snapshot.orders[0].secret, [7; 16]);
    assert_eq!(snapshot.orders[4], OrderView::zeroed());
}

#[test]
fn a_fill_changes_the_makers_seat_version_so_a_view_can_tell_it_is_behind() {
    let (mut w, m, a, b) = spot_world();
    w.place(m, a, limit(Side::Bid, 1_000, 2)).unwrap();
    let before = w.snapshot_as(m, a, w.key(a)).unwrap();
    let untouched = w.seat(FEE_SEAT).version;

    w.place(m, b, ioc(Side::Ask, 1_000, 1)).unwrap();

    assert_eq!(w.seat(a).version, before.seat.version + 1);
    assert_eq!(w.seat(FEE_SEAT).version, untouched + 1);
    let failed = w.place(m, b, limit(Side::Bid, 5, 1));
    assert!(failed.is_err());
}

#[test]
fn the_journal_must_hold_one_entry_per_step_plus_three_whatever_the_book_holds() {
    let (mut w, m, a, b) = spot_world();
    w.max_steps = 4;
    w.journal.truncate(6);

    let on_an_empty_book = w.place(m, a, limit(Side::Bid, 990, 1));
    w.journal.push(JournalEntry::zeroed());
    w.place(m, b, limit(Side::Ask, 1_000, 1)).unwrap();
    w.journal.truncate(6);
    let on_a_loaded_book = w.place(m, a, ioc(Side::Bid, 1_000, 1));

    assert_eq!(on_an_empty_book, Err(E::JournalFull));
    assert_eq!(on_a_loaded_book, Err(E::JournalFull));
    assert_eq!(PLACE_JOURNAL_EXTRA_ENTRIES, 3);
    assert_eq!(LIQUIDATION_JOURNAL_ENTRIES, 3);
}

#[test]
fn a_closed_fee_seat_refuses_orders_on_a_fee_charging_market_before_any_match() {
    let (mut w, m, a, _) = spot_world();
    w.seats[FEE_SEAT as usize].status = SEAT_FREE;
    w.seats[FEE_SEAT as usize].owner = [0; 32];
    w.header.open_seats -= 1;

    assert_eq!(
        w.place(m, a, limit(Side::Bid, 990, 1)),
        Err(E::FeeSeatNotOpen)
    );
}

#[test]
fn settings_the_engine_cannot_run_on_are_refused() {
    let broken: [fn(&mut MarketParams); 7] = [
        |p| p.tick = 0,
        |p| p.base_lot = 0,
        |p| p.kind = 0,
        |p| p.status = 3,
        |p| p.max_open_orders = MAX_OPEN_ORDERS as u16 + 1,
        |p| p.taker_fee_bps = 10_001,
        |p| p.base_token = p.quote_token,
    ];
    for breaking in broken {
        let (mut w, m, a, _) = spot_world();
        breaking(&mut w.markets[m].params);

        let placing = w.place(m, a, limit(Side::Bid, 990, 1));
        assert_eq!(placing, Err(E::InvalidMarketParams));
        assert_eq!(w.cancel(m, a, 0), Err(E::InvalidMarketParams));
    }

    let (mut w, m, a, _) = spot_world();
    let state = &mut w.markets[m];
    state.book.market_id = 3;
    let mut view = MarketMut {
        params: &mut state.params,
        book: &mut state.book,
        bids: &mut state.bids,
        asks: &mut state.asks,
        price: &state.price,
    };
    let mut ledger = LedgerMut {
        header: &mut w.header,
        seats: &mut w.seats,
    };
    let owner = w.keys[a as usize];
    let trader = Trader {
        seat: a,
        owner: &owner,
    };
    assert_eq!(
        cancel_order(&mut ledger, &mut view, trader, 0),
        Err(E::MarketMismatch)
    );
    let mut perp = perp_params(0);
    perp.funding_interval = 0;
    assert_eq!(perp.check(), Err(E::InvalidMarketParams));
    let mut beyond_the_last_market = perp_params(MARKETS as u8);
    assert_eq!(beyond_the_last_market.check(), Err(E::InvalidMarketParams));
    beyond_the_last_market.market_id = 7;
    assert_eq!(beyond_the_last_market.check(), Ok(MarketKind::Perp));
}

#[test]
fn error_codes_are_stable() {
    let codes = [
        (E::MathOverflow, 1),
        (E::SeatNotOpen, 11),
        (E::NotSeatOwner, 12),
        (E::SeatTableFull, 13),
        (E::InsufficientBalance, 22),
        (E::InsufficientMargin, 24),
        (E::ExchangePaused, 30),
        (E::PriceOutsideBand, 37),
        (E::StalePrice, 38),
        (E::TooManyOpenOrders, 40),
        (E::OrderNotFound, 50),
        (E::NotLiquidatable, 61),
        (E::PriceMoveTooLarge, 71),
    ];
    for (error, code) in codes {
        assert_eq!(error.code(), code);
    }
}

#[test]
fn stored_structs_have_fixed_sizes_and_at_most_eight_byte_alignment() {
    assert_eq!(size_of::<Seat>(), 448);
    assert_eq!(size_of::<Order>(), 64);
    assert_eq!(size_of::<Ledger>(), 8 + 2_048 * 448);
    assert_eq!(size_of::<Book>(), 72 + 2 * 1_024 * 64);
    assert_eq!(size_of::<MarketParams>(), 104);
    assert_eq!(size_of::<Price>(), 16);
    assert_eq!(size_of::<SeatSnapshot>(), 448 + 16 + 32 * 64);
    assert_eq!(size_of::<JournalEntry>(), 456);
    let alignments = [
        align_of::<Ledger>(),
        align_of::<Book>(),
        align_of::<MarketParams>(),
        align_of::<Price>(),
        align_of::<SeatSnapshot>(),
        align_of::<JournalEntry>(),
    ];
    assert_eq!(alignments, [8; 6]);
    assert_eq!((SEATS, ORDERS_PER_SIDE, MARKETS), (2_048, 1_024, 8));
    assert_eq!((MAX_OPEN_ORDERS, MAX_FILLS), (32, 32));
}

#[test]
fn the_full_size_ledger_and_book_map_onto_eight_byte_aligned_account_bytes() {
    let mut ledger_words = vec![0u64; size_of::<Ledger>() / 8];
    let mut book_words = vec![0u64; size_of::<Book>() / 8];
    let ledger: &mut Ledger = bytemuck::from_bytes_mut(bytemuck::cast_slice_mut(&mut ledger_words));
    let book: &mut Book = bytemuck::from_bytes_mut(bytemuck::cast_slice_mut(&mut book_words));
    let mut params = spot_params(0);
    let price = Price {
        price: MARK,
        publish_time: START,
    };
    let keys = [[1u8; 32], [2; 32], [3; 32], [4; 32]];
    let mut view = ledger.as_mut();
    open_reserved_seat(&mut view, FEE_SEAT, &keys[0]).unwrap();
    open_reserved_seat(&mut view, INSURANCE_SEAT, &keys[1]).unwrap();
    let maker = open_seat(&mut view, &keys[2]).unwrap();
    let taker = open_seat(&mut view, &keys[3]).unwrap();
    deposit(&mut view, maker, Asset::Spot(BASE), 1_000).unwrap();
    deposit(&mut view, taker, Asset::Spot(QUOTE), 100_000).unwrap();
    let mut entries = vec![JournalEntry::zeroed(); MAX_FILLS + PLACE_JOURNAL_EXTRA_ENTRIES];
    let mut journal = Journal::new(&mut entries);
    let mut fills = Fills::new();
    let risks = [MarketRisk::NONE; MARKETS];
    let env = Env {
        now: START,
        exchange_paused: false,
        max_steps: MAX_FILLS as u32,
        markets: &risks,
        hash: sha,
    };
    let mut market = book.as_market(&mut params, &price);
    let selling = Trader {
        seat: maker,
        owner: &keys[2],
    };
    let buying = Trader {
        seat: taker,
        owner: &keys[3],
    };

    for price in [1_000, 1_010] {
        let ask = limit(Side::Ask, price, 5);
        place_order(
            &mut view,
            &mut market,
            &mut journal,
            &env,
            selling,
            &ask,
            &mut fills,
        )
        .unwrap();
    }
    let bid = limit(Side::Bid, 1_000, 7);
    let outcome = place_order(
        &mut view,
        &mut market,
        &mut journal,
        &env,
        buying,
        &bid,
        &mut fills,
    )
    .unwrap();

    assert_eq!(sizes(&outcome), (5, 2, 0));
    assert_eq!(
        (market.best_bid(), market.best_ask()),
        (Some(1_000), Some(1_010))
    );
    assert_eq!((book.header.bid_count, book.header.ask_count), (1, 1));
    assert_eq!(book.bids[0].remaining, 2);
    assert_eq!(ledger.header.open_seats, 4);
    let bought = ledger.seats[taker as usize].spot[usize::from(BASE)];
    assert_eq!(bought.available, 500);
    assert!(book_words.iter().any(|word| *word != 0));
}

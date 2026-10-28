//! The move of the seats from the ledger of 448-byte seats into the ledger of 304-byte
//! seats, run through the program's entry point on in-memory accounts: every seat and every
//! total arrives exactly, the old ledger is never written, and every wrong state or wrong
//! ledger is refused before it can write.

use anchor_lang::prelude::*;
use anchor_lang::InstructionData;
use bytemuck::Zeroable;
use noirwire_orderbook_engine::{take_seat, TokenBalance, SEAT_FREE, SEAT_OPEN};

use crate::errors::OrderbookError;
use crate::growth_tests::{
    account, blank_exchange, bytes_of, exchange_account, exchange_of, free_list, header_of,
    live_exchange, refusal, refused_with, run, signer, write,
};
use crate::loader::{load_ledger, load_ledger_mut};
use crate::relayout::{
    expand, normalized, LegacySeat, LEGACY_LEDGER_LEN, LEGACY_LEDGER_PREFIX, LEGACY_SEATS,
};
use crate::state::{
    Exchange, LedgerData, RollupAccount, HEADER_LEN, LAYOUT_RELAYOUT, LAYOUT_V2, LEDGER_SEED,
    LEGACY_LEDGER_SEED, MIN_SEATS, READY, RELAYOUT_SEATS_PER_CALL, SEAT_LEN,
};

fn open(owner: u8, collateral: i64) -> LegacySeat {
    LegacySeat {
        owner: [owner; 32],
        version: 4,
        collateral,
        status: SEAT_OPEN,
        ..LegacySeat::zeroed()
    }
}

/// An old ledger's table with a story: the reserved seats, a maker listed on one market
/// with a position, a trader in a perp market with resting orders on another, a debtor, a
/// listed and blocked seat, a funded last seat and closed seats between, each with the
/// version its closing left.
fn story() -> Vec<LegacySeat> {
    let mut table = vec![LegacySeat::zeroed(); LEGACY_SEATS];
    for (index, seat) in table.iter_mut().enumerate() {
        seat.version = u64::try_from(index % 3).unwrap();
    }
    table[0] = open(0xF0, 5);
    table[1] = open(0xF1, 1_000);
    let mut maker = open(2, 1_000);
    maker.maker_markets = 0b10;
    maker.perp[1].base = 3;
    maker.perp[1].quote = -30;
    maker.perp[1].funding_checkpoint = 5;
    maker.perp[4].funding_checkpoint = 9;
    table[2] = maker;
    let mut trader = open(5, 0);
    trader.spot[0] = TokenBalance {
        available: 7,
        locked: 3,
    };
    trader.perp[6].base = -2;
    trader.perp[6].quote = 20;
    trader.open_orders[2] = 2;
    trader.perp[0].open_ask_lots = 4;
    trader.open_orders[0] = 1;
    table[5] = trader;
    table[9] = open(9, -50);
    let mut listed = open(12, 1);
    listed.taker_markets = 0b10;
    listed.blocked = 1;
    table[12] = listed;
    table[300] = LegacySeat {
        version: 7,
        ..LegacySeat::zeroed()
    };
    table[2047] = open(47, 99);
    table
}

fn open_count(table: &[LegacySeat]) -> u32 {
    u32::try_from(table.iter().filter(|seat| seat.status == SEAT_OPEN).count()).unwrap()
}

/// An account at the old ledger's address holding `table`, as far as `len` bytes allow.
fn legacy_with(
    table: &[LegacySeat],
    tag: [u8; 8],
    ready: u8,
    owner: Pubkey,
    len: usize,
) -> AccountInfo<'static> {
    let (key, bump) = Pubkey::find_program_address(&[LEGACY_LEDGER_SEED], &crate::ID);
    let info = account(key, owner, len, false, false);
    write(&info, 0, bytemuck::bytes_of(&header_of(tag, bump, ready)));
    write(&info, HEADER_LEN, &open_count(table).to_le_bytes());
    let seats: &[u8] = bytemuck::cast_slice(table);
    let room = len - LEGACY_LEDGER_PREFIX;
    write(&info, LEGACY_LEDGER_PREFIX, &seats[..seats.len().min(room)]);
    info
}

fn legacy_ledger(table: &[LegacySeat]) -> AccountInfo<'static> {
    legacy_with(table, LedgerData::TAG, READY, crate::ID, LEGACY_LEDGER_LEN)
}

/// The new ledger as `create_relayout_ledger` and the growth leave it: full size, not
/// ready, and holding whatever the rollup put there.
fn new_ledger() -> AccountInfo<'static> {
    let (key, bump) = Pubkey::find_program_address(&[LEDGER_SEED], &crate::ID);
    let info = account(key, crate::ID, LedgerData::LEN, false, true);
    write(&info, HEADER_LEN, &vec![0xAA; LedgerData::LEN - HEADER_LEN]);
    write(
        &info,
        0,
        bytemuck::bytes_of(&header_of(LedgerData::TAG, bump, 0)),
    );
    info
}

fn relaying(admin: Pubkey) -> AccountInfo<'static> {
    exchange_account(Exchange {
        layout: LAYOUT_RELAYOUT,
        paused: true,
        ..blank_exchange(admin)
    })
}

fn relayout(
    admin: Pubkey,
    exchange: &AccountInfo<'static>,
    legacy: &AccountInfo<'static>,
    ledger: &AccountInfo<'static>,
    count: u16,
) -> core::result::Result<(), ProgramError> {
    let accounts = vec![
        signer(admin),
        exchange.clone(),
        legacy.clone(),
        ledger.clone(),
    ];
    run(accounts, crate::instruction::RelayoutSeats { count }.data())
}

fn finish(
    admin: Pubkey,
    exchange: &AccountInfo<'static>,
    legacy: &AccountInfo<'static>,
    ledger: &AccountInfo<'static>,
) -> core::result::Result<(), ProgramError> {
    let accounts = vec![
        signer(admin),
        exchange.clone(),
        legacy.clone(),
        ledger.clone(),
    ];
    run(accounts, crate::instruction::FinishRelayout {}.data())
}

fn copy_all(
    admin: Pubkey,
    exchange: &AccountInfo<'static>,
    legacy: &AccountInfo<'static>,
    ledger: &AccountInfo<'static>,
    counts: &[u16],
) {
    for count in counts {
        assert_eq!(relayout(admin, exchange, legacy, ledger, *count), Ok(()));
    }
    assert_eq!(exchange_of(exchange).relayout_next as usize, LEGACY_SEATS);
}

fn eight_calls() -> Vec<u16> {
    vec![RELAYOUT_SEATS_PER_CALL; LEGACY_SEATS / usize::from(RELAYOUT_SEATS_PER_CALL)]
}

#[test]
fn every_seat_and_every_total_arrives_exactly_and_the_old_ledger_is_never_written() {
    let admin = Pubkey::new_unique();
    let table = story();
    let legacy = legacy_ledger(&table);
    let legacy_before = bytes_of(&legacy);
    let ledger = new_ledger();
    let exchange = relaying(admin);

    copy_all(admin, &exchange, &legacy, &ledger, &eight_calls());
    assert_eq!(
        bytes_of(&ledger)[8],
        0,
        "the new ledger is not ready until the end"
    );
    assert_eq!(finish(admin, &exchange, &legacy, &ledger), Ok(()));

    let after = exchange_of(&exchange);
    assert_eq!(after.layout, LAYOUT_V2);
    assert_eq!(after.seat_capacity as usize, MIN_SEATS);
    assert_eq!(after.relayout_next, 0);
    assert_eq!(
        bytes_of(&legacy),
        legacy_before,
        "the old ledger is untouched"
    );
    assert_eq!(bytes_of(&ledger)[8], READY);

    let read = load_ledger(&ledger).unwrap();
    assert_eq!(read.seats.len(), MIN_SEATS);
    assert_eq!(read.header.open_seats, open_count(&table));
    for (index, (new, old)) in read.seats.iter().zip(&table).enumerate() {
        assert_eq!(
            expand(new).unwrap(),
            normalized(old),
            "seat {index} arrived as it was"
        );
    }
    let collateral = |seats: &mut dyn Iterator<Item = i64>| seats.sum::<i64>();
    assert_eq!(
        collateral(&mut read.seats.iter().map(|seat| seat.collateral)),
        collateral(&mut table.iter().map(|seat| seat.collateral))
    );
    assert_eq!(read.seats[2].slot_markets, [2, 0, 0, 0]);
    assert_eq!(read.seats[2].perp[0].funding_checkpoint, 5);
    assert_eq!(read.seats[2].maker_markets, 0b10);
    assert_eq!(read.seats[5].slot_markets, [1, 3, 7, 0]);
    assert_eq!(read.seats[5].slot_orders, [1, 2, 0, 0]);
    assert_eq!(read.seats[5].perp[0].open_ask_lots, 4);
    assert_eq!(read.seats[5].perp[2].base, -2);
    assert_eq!(read.seats[9].collateral, -50);
    assert_eq!(
        (read.seats[12].taker_markets, read.seats[12].blocked),
        (0b10, 1)
    );
    assert_eq!(read.seats[300].version, 7);
    drop(read);

    let listed = free_list(&ledger);
    assert_eq!(listed.len(), MIN_SEATS - 7);
    let read = load_ledger(&ledger).unwrap();
    assert!(listed
        .iter()
        .all(|index| *index >= 2 && !read.seats[*index].is_open()));
    drop(read);
    let mut sorted = listed.clone();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(sorted.len(), listed.len(), "no seat is listed twice");

    let mut open = load_ledger_mut(&ledger).unwrap();
    let taken = take_seat(&mut open.engine(), &[0xEE; 32]).unwrap();
    assert_eq!(taken as usize, listed[0]);
    assert!(table[taken as usize].status == SEAT_FREE);
    assert_eq!(
        open.seats[taken as usize].version,
        table[taken as usize].version + 1,
        "the take counts after the version the old seat had"
    );
}

#[test]
fn copying_in_other_ranges_gives_the_same_ledger_and_a_call_after_the_end_is_refused() {
    let admin = Pubkey::new_unique();
    let table = story();
    let legacy = legacy_ledger(&table);

    let whole_ledger = new_ledger();
    let whole = relaying(admin);
    copy_all(admin, &whole, &legacy, &whole_ledger, &eight_calls());
    assert_eq!(finish(admin, &whole, &legacy, &whole_ledger), Ok(()));

    let ragged_ledger = new_ledger();
    let ragged = relaying(admin);
    let counts = [1, 255, 100, 200, 256, 7, 249, 256, 256, 256, 256];
    copy_all(admin, &ragged, &legacy, &ragged_ledger, &counts);
    assert_eq!(
        relayout(admin, &ragged, &legacy, &ragged_ledger, 1),
        refused_with(OrderbookError::RelayoutOutOfOrder),
        "a call after the last seat copies nothing"
    );
    assert_eq!(finish(admin, &ragged, &legacy, &ragged_ledger), Ok(()));

    assert_eq!(bytes_of(&whole_ledger), bytes_of(&ragged_ledger));

    for done in [&whole, &ragged] {
        let (ledger, exchange_before) = (new_ledger(), bytes_of(done));
        assert_eq!(
            relayout(admin, done, &legacy, &ledger, 1),
            refused_with(OrderbookError::RelayoutOutOfOrder)
        );
        assert_eq!(
            finish(admin, done, &legacy, &ledger),
            refused_with(OrderbookError::RelayoutOutOfOrder)
        );
        assert_eq!(bytes_of(done), exchange_before);
    }
}

#[test]
fn the_relayout_refuses_the_wrong_state_the_wrong_caller_and_a_step_out_of_bounds() {
    let admin = Pubkey::new_unique();
    let legacy = legacy_ledger(&story());
    let ledger = new_ledger();
    let ledger_before = bytes_of(&ledger);

    let unpaused = exchange_account(Exchange {
        layout: LAYOUT_RELAYOUT,
        ..blank_exchange(admin)
    });
    let live = exchange_account(live_exchange(admin));
    let unmigrated = exchange_account(blank_exchange(admin));
    for exchange in [&unpaused, &live, &unmigrated] {
        let before = bytes_of(exchange);
        assert_eq!(
            relayout(admin, exchange, &legacy, &ledger, 1),
            refused_with(OrderbookError::RelayoutOutOfOrder)
        );
        assert_eq!(bytes_of(exchange), before);
    }
    for exchange in [&live, &unmigrated] {
        assert_eq!(
            finish(admin, exchange, &legacy, &ledger),
            refused_with(OrderbookError::RelayoutOutOfOrder)
        );
    }

    let exchange = relaying(admin);
    assert_eq!(
        relayout(Pubkey::new_unique(), &exchange, &legacy, &ledger, 1),
        refused_with(OrderbookError::NotAdmin)
    );
    for count in [0, RELAYOUT_SEATS_PER_CALL + 1, u16::MAX] {
        assert_eq!(
            relayout(admin, &exchange, &legacy, &ledger, count),
            refused_with(OrderbookError::InvalidSettings),
            "{count} seats"
        );
    }
    assert_eq!(
        finish(admin, &exchange, &legacy, &ledger),
        refused_with(OrderbookError::RelayoutIncomplete),
        "nothing is copied yet"
    );
    assert_eq!(exchange_of(&exchange).relayout_next, 0);
    assert_eq!(bytes_of(&ledger), ledger_before);
}

#[test]
fn finishing_before_every_seat_is_copied_is_refused() {
    let admin = Pubkey::new_unique();
    let legacy = legacy_ledger(&story());
    let ledger = new_ledger();
    let exchange = relaying(admin);
    for _ in 0..7 {
        assert_eq!(relayout(admin, &exchange, &legacy, &ledger, 256), Ok(()));
    }
    let before = bytes_of(&exchange);
    assert_eq!(
        finish(admin, &exchange, &legacy, &ledger),
        refused_with(OrderbookError::RelayoutIncomplete)
    );
    assert_eq!(bytes_of(&exchange), before);
    assert_eq!(bytes_of(&ledger)[8], 0, "the new ledger is still not ready");
}

#[test]
fn an_old_ledger_that_is_not_the_one_expected_is_refused_with_nothing_copied() {
    let admin = Pubkey::new_unique();
    let table = story();
    let exchange = relaying(admin);
    let ledger = new_ledger();
    let before = bytes_of(&ledger);
    let wrong: [AccountInfo<'static>; 4] = [
        legacy_with(
            &table,
            LedgerData::TAG,
            READY,
            crate::ID,
            LEGACY_LEDGER_LEN + 8,
        ),
        legacy_with(
            &table,
            LedgerData::TAG,
            READY,
            crate::ID,
            LEGACY_LEDGER_LEN - 448,
        ),
        legacy_with(&table, *b"nwview\0\0", READY, crate::ID, LEGACY_LEDGER_LEN),
        legacy_with(&table, LedgerData::TAG, 0, crate::ID, LEGACY_LEDGER_LEN),
    ];
    let foreign = legacy_with(
        &table,
        LedgerData::TAG,
        READY,
        Pubkey::new_unique(),
        LEGACY_LEDGER_LEN,
    );
    let reasons = [
        OrderbookError::WrongSize,
        OrderbookError::WrongSize,
        OrderbookError::WrongKind,
        OrderbookError::NotReady,
        OrderbookError::WrongOwner,
    ];
    for (legacy, reason) in wrong.iter().chain([&foreign]).zip(reasons) {
        assert_eq!(
            relayout(admin, &exchange, legacy, &ledger, 256),
            refused_with(reason)
        );
        assert_eq!(exchange_of(&exchange).relayout_next, 0);
        assert_eq!(bytes_of(&ledger), before);
    }
    let copied = new_ledger();
    copy_all(
        admin,
        &exchange,
        &legacy_ledger(&table),
        &copied,
        &eight_calls(),
    );
    for (legacy, reason) in wrong.iter().chain([&foreign]).zip(reasons) {
        assert_eq!(
            finish(admin, &exchange, legacy, &copied),
            refused_with(reason)
        );
        assert_eq!(bytes_of(&copied)[8], 0);
    }
}

#[test]
fn a_seat_in_five_markets_an_unknown_status_and_a_missing_reserved_seat_stop_the_copy() {
    let admin = Pubkey::new_unique();
    let mut five = story();
    for market in 0..5 {
        five[20].perp[market].base = 1;
    }
    five[20].status = SEAT_OPEN;
    let mut unknown = story();
    unknown[30].status = 2;
    let mut no_fee_seat = story();
    no_fee_seat[0].status = SEAT_FREE;
    for table in [five, unknown, no_fee_seat] {
        let exchange = relaying(admin);
        let legacy = legacy_ledger(&table);
        let ledger = new_ledger();
        assert_eq!(
            relayout(admin, &exchange, &legacy, &ledger, 256),
            refused_with(OrderbookError::RelayoutMismatch)
        );
        assert_eq!(
            exchange_of(&exchange).relayout_next,
            0,
            "the cursor does not move past a refused call"
        );
    }
}

#[test]
fn a_new_seat_changed_between_the_calls_fails_the_totals_check_and_nothing_is_stamped() {
    let admin = Pubkey::new_unique();
    let table = story();
    let legacy = legacy_ledger(&table);
    let ledger = new_ledger();
    let exchange = relaying(admin);
    copy_all(admin, &exchange, &legacy, &ledger, &eight_calls());

    let collateral_at = HEADER_LEN + 32 + 9 * SEAT_LEN + 40;
    let honest = bytes_of(&ledger)[collateral_at..collateral_at + 8].to_vec();
    write(&ledger, collateral_at, &(-49i64).to_le_bytes());
    let before = bytes_of(&exchange);
    assert_eq!(
        finish(admin, &exchange, &legacy, &ledger),
        refused_with(OrderbookError::RelayoutMismatch)
    );
    assert_eq!(bytes_of(&exchange), before);
    assert_eq!(bytes_of(&ledger)[8], 0);

    let closed_at = HEADER_LEN + 32 + 40 * SEAT_LEN + 40;
    write(&ledger, collateral_at, &honest);
    write(&ledger, closed_at, &1i64.to_le_bytes());
    assert_eq!(
        finish(admin, &exchange, &legacy, &ledger),
        refused_with(OrderbookError::RelayoutMismatch),
        "a closed seat holds nothing"
    );
    write(&ledger, closed_at, &0i64.to_le_bytes());

    assert_eq!(finish(admin, &exchange, &legacy, &ledger), Ok(()));
    assert_eq!(exchange_of(&exchange).layout, LAYOUT_V2);
}

#[test]
fn while_the_exchange_is_relaying_nothing_that_needs_the_new_ledger_runs() {
    let admin = Pubkey::new_unique();
    let exchange = relaying(admin);
    let ledger = new_ledger();
    assert_eq!(
        refusal(load_ledger(&ledger)),
        error!(OrderbookError::NotReady),
        "every deposit, withdrawal and order loads the ledger first"
    );
    let release = crate::instruction::ReleaseEmptySeats { start: 0, count: 1 }.data();
    assert_eq!(
        run(
            vec![signer(admin), exchange.clone(), ledger.clone()],
            release
        ),
        refused_with(OrderbookError::LayoutNotMigrated)
    );
}

#[test]
fn finishing_needs_the_exchange_paused_and_changes_nothing_when_it_is_not() {
    let admin = Pubkey::new_unique();
    let table = story();
    let legacy = legacy_ledger(&table);
    let ledger = new_ledger();
    let exchange = relaying(admin);
    copy_all(admin, &exchange, &legacy, &ledger, &eight_calls());
    let mut live = exchange_of(&exchange);
    live.paused = false;
    let unpaused = exchange_account(live);
    let before = (bytes_of(&unpaused), bytes_of(&ledger));
    assert_eq!(
        finish(admin, &unpaused, &legacy, &ledger),
        refused_with(OrderbookError::RelayoutOutOfOrder)
    );
    assert_eq!((bytes_of(&unpaused), bytes_of(&ledger)), before);
}

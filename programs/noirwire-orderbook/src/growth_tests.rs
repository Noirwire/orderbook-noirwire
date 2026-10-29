//! The ledger past its creation size and the exchange layout that records it: what the
//! loaders accept, what `migrate_exchange` and `extend_ledger` refuse, that the seats an
//! extension adds join the free list, that a seat past the first 2,048 trades and is
//! liquidated, and that the retired cap error keeps its number.
//!
//! Accounts are built in memory as the runtime hands them over. They are leaked, since
//! `entry` wants them for the program's whole run and a test process is short.

use anchor_lang::prelude::*;
use anchor_lang::InstructionData;
use bytemuck::Zeroable;
use ephemeral_rollups_sdk::consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID};
use noirwire_orderbook_engine::{
    deposit as engine_deposit, liquidate_range, open_reserved_seat, place_order, push_new_seats,
    take_seat, Asset, BookHeader, Env, Fills, Journal, JournalEntry, MarketMut, MarketParams,
    MarketRisk, NewOrder, Order, OrderType, Price, RangeRequest, Side, Trader, FEE_SEAT,
    INSURANCE_SEAT, KIND_PERP, MARKETS, MAX_FILLS, MAX_OPEN_INTEREST_CAP,
    PLACE_JOURNAL_EXTRA_ENTRIES,
};

use crate::errors::OrderbookError;
use crate::instructions::setup::{extension, zero_and_record};
use crate::loader::{load_ledger, load_ledger_mut};
use crate::state::{
    ledger_len, Exchange, Header, LedgerData, QuoteGuard, RollupAccount, TokenInfo, ViewData,
    EXCHANGE_SEED, EXTEND_SEATS_PER_CALL, HEADER_LEN, LAYOUT_RELAYOUT, LAYOUT_V2, LEDGER_SEED,
    MAX_SEATS, MIN_SEATS, READY, SEAT_LEN, TOKENS,
};

const OLD_CAP: u64 = 1_800_000_000;

/// An account at `key`, owned by `owner`, of `len` zero bytes.
pub(crate) fn account(
    key: Pubkey,
    owner: Pubkey,
    len: usize,
    signer: bool,
    writable: bool,
) -> AccountInfo<'static> {
    let words: &'static mut [u64] = Box::leak(vec![0u64; len.div_ceil(8)].into_boxed_slice());
    let data: &'static mut [u8] = &mut bytemuck::cast_slice_mut::<u64, u8>(words)[..len];
    AccountInfo::new(
        Box::leak(Box::new(key)),
        signer,
        writable,
        Box::leak(Box::new(1_000_000_000u64)),
        data,
        Box::leak(Box::new(owner)),
        false,
    )
}

pub(crate) fn write(info: &AccountInfo, at: usize, bytes: &[u8]) {
    let mut data = info.try_borrow_mut_data().unwrap();
    data[at..at + bytes.len()].copy_from_slice(bytes);
}

pub(crate) fn header_of(tag: [u8; 8], bump: u8, ready: u8) -> Header {
    Header {
        tag,
        ready,
        market_id: 0,
        bump,
        _padding: [0; 5],
    }
}

/// A ready ledger of `seats` seats with the fee and insurance seats open and every other
/// seat on the free list, as `finalize_ledger` and `extend_ledger` leave one.
pub(crate) fn ledger_of(seats: usize) -> AccountInfo<'static> {
    let (key, bump) = Pubkey::find_program_address(&[LEDGER_SEED], &crate::ID);
    let info = account(key, crate::ID, ledger_len(seats), false, true);
    write(
        &info,
        0,
        bytemuck::bytes_of(&header_of(LedgerData::TAG, bump, READY)),
    );
    {
        let mut ledger = load_ledger_mut(&info).unwrap();
        let mut engine = ledger.engine();
        open_reserved_seat(&mut engine, FEE_SEAT, &[0xF0; 32]).unwrap();
        open_reserved_seat(&mut engine, INSURANCE_SEAT, &[0xF1; 32]).unwrap();
        push_new_seats(&mut engine, 2, u32::try_from(seats).unwrap()).unwrap();
    }
    info
}

pub(crate) fn bytes_of(info: &AccountInfo) -> Vec<u8> {
    info.try_borrow_data().unwrap().to_vec()
}

pub(crate) fn refusal<T>(result: Result<T>) -> Error {
    match result {
        Ok(_) => panic!("expected a refusal"),
        Err(error) => error,
    }
}

pub(crate) fn blank_exchange(admin: Pubkey) -> Exchange {
    Exchange {
        bump: Pubkey::find_program_address(&[EXCHANGE_SEED], &crate::ID).1,
        admin,
        pending_admin: None,
        gate: Pubkey::new_unique(),
        oracle: Pubkey::new_unique(),
        paused: false,
        max_steps: 1,
        collateral_token: 0,
        tokens: [TokenInfo::default(); TOKENS],
        perp_markets: 0,
        max_seats_per_day: 100,
        seats_day: 0,
        seats_opened: 0,
        public_custody: 0,
        quote: QuoteGuard::unbound(),
        seat_capacity: 0,
        layout: 0,
        min_seat_deposit: 0,
        relayout_next: 0,
        _reserved: [0; 12],
    }
}

/// A migrated exchange: the layout the ledger of 304-byte seats goes with.
pub(crate) fn live_exchange(admin: Pubkey) -> Exchange {
    Exchange {
        layout: LAYOUT_V2,
        seat_capacity: u32::try_from(MIN_SEATS).unwrap(),
        ..blank_exchange(admin)
    }
}

/// The exchange account as the upgrade finds it: the last 32 bytes of its fields hold
/// four custody caps.
fn exchange_with_caps(exchange: Exchange, caps: [u64; TOKENS]) -> AccountInfo<'static> {
    let mut bytes = Vec::new();
    exchange.try_serialize(&mut bytes).unwrap();
    let at = bytes.len() - 32;
    for (cap, slot) in caps.iter().zip(bytes[at..].chunks_exact_mut(8)) {
        slot.copy_from_slice(&cap.to_le_bytes());
    }
    exchange_holding(&bytes)
}

pub(crate) fn exchange_account(exchange: Exchange) -> AccountInfo<'static> {
    let mut bytes = Vec::new();
    exchange.try_serialize(&mut bytes).unwrap();
    exchange_holding(&bytes)
}

fn exchange_holding(bytes: &[u8]) -> AccountInfo<'static> {
    let key = Pubkey::find_program_address(&[EXCHANGE_SEED], &crate::ID).0;
    let info = account(key, crate::ID, 8 + Exchange::INIT_SPACE, false, true);
    write(&info, 0, bytes);
    info
}

/// The 32 bytes the exchange's last field occupies in the account, whatever the
/// nominee field takes before it.
fn last_field_bytes(info: &AccountInfo) -> Vec<u8> {
    let exchange = exchange_of(info);
    let mut serialized = Vec::new();
    exchange.try_serialize(&mut serialized).unwrap();
    bytes_of(info)[serialized.len() - 32..serialized.len()].to_vec()
}

pub(crate) fn exchange_of(info: &AccountInfo) -> Exchange {
    Exchange::try_deserialize(&mut &info.try_borrow_data().unwrap()[..]).unwrap()
}

pub(crate) fn signer(key: Pubkey) -> AccountInfo<'static> {
    account(key, anchor_lang::system_program::ID, 0, true, false)
}

pub(crate) fn at(key: Pubkey) -> AccountInfo<'static> {
    account(key, anchor_lang::system_program::ID, 0, false, true)
}

pub(crate) fn run(
    accounts: Vec<AccountInfo<'static>>,
    data: Vec<u8>,
) -> core::result::Result<(), ProgramError> {
    let accounts: &'static [AccountInfo<'static>] = Box::leak(accounts.into_boxed_slice());
    let data: &'static [u8] = Box::leak(data.into_boxed_slice());
    crate::entry(&crate::ID, accounts, data)
}

pub(crate) fn refused_with(error: OrderbookError) -> core::result::Result<(), ProgramError> {
    Err(ProgramError::Custom(u32::from(error)))
}

fn extend_accounts(
    admin: Pubkey,
    exchange: &AccountInfo<'static>,
    ledger: &AccountInfo<'static>,
) -> Vec<AccountInfo<'static>> {
    vec![
        signer(admin),
        exchange.clone(),
        ledger.clone(),
        at(EPHEMERAL_VAULT_ID),
        at(MAGIC_PROGRAM_ID),
    ]
}

fn migrate(
    admin: Pubkey,
    exchange: &AccountInfo<'static>,
) -> core::result::Result<(), ProgramError> {
    let accounts = vec![signer(admin), exchange.clone()];
    run(accounts, crate::instruction::MigrateExchange {}.data())
}

fn paused_with_caps(admin: Pubkey, caps: [u64; TOKENS]) -> AccountInfo<'static> {
    exchange_with_caps(
        Exchange {
            paused: true,
            ..blank_exchange(admin)
        },
        caps,
    )
}

#[test]
fn the_ledger_created_with_2048_seats_loads_unchanged() {
    assert_eq!(ledger_len(MIN_SEATS), 622_640);
    let info = ledger_of(MIN_SEATS);
    {
        let mut ledger = load_ledger_mut(&info).unwrap();
        let mut engine = ledger.engine();
        for owner in 1..=5u8 {
            let seat = take_seat(&mut engine, &[owner; 32]).unwrap();
            engine_deposit(
                &mut engine,
                seat,
                Asset::Collateral,
                1_000 * u64::from(owner),
            )
            .unwrap();
        }
    }
    let before = bytes_of(&info);

    let read = load_ledger(&info).unwrap();
    assert_eq!(read.seats.len(), MIN_SEATS);
    assert_eq!(read.header.open_seats, 7);
    assert_eq!(read.header.free_head, 8, "seat 7 is the next one taken");
    assert_eq!(read.seats[0].owner, [0xF0; 32]);
    assert_eq!(read.seats[4].owner, [3; 32]);
    assert_eq!(read.seats[4].collateral, 3_000);
    assert_eq!(
        read.seats[MIN_SEATS - 1],
        noirwire_orderbook_engine::Seat::zeroed(),
        "the last seat of the list links to nothing"
    );
    drop(read);
    drop(load_ledger_mut(&info).unwrap());

    assert_eq!(bytes_of(&info), before, "loading changes nothing");
    assert_eq!(before.len(), 622_640);
}

#[test]
fn a_ledger_of_any_size_between_the_minimum_and_the_maximum_loads() {
    for seats in [MIN_SEATS + 1, 8_192, 12_288, MAX_SEATS] {
        let info = ledger_of(seats);
        assert_eq!(load_ledger(&info).unwrap().seats.len(), seats);
        assert_eq!(load_ledger_mut(&info).unwrap().seats.len(), seats);
    }
}

#[test]
fn a_ledger_of_the_wrong_size_is_refused_by_both_loaders() {
    let wrong = error!(OrderbookError::WrongSize);
    let lengths = [
        ledger_len(MIN_SEATS - 1),
        ledger_len(MIN_SEATS) - 8,
        ledger_len(MIN_SEATS) + 8,
        ledger_len(MIN_SEATS) + SEAT_LEN - 8,
        ledger_len(MAX_SEATS) + SEAT_LEN,
        HEADER_LEN + 8,
        HEADER_LEN,
    ];
    for len in lengths {
        let (key, bump) = Pubkey::find_program_address(&[LEDGER_SEED], &crate::ID);
        let info = account(key, crate::ID, len, false, true);
        write(
            &info,
            0,
            bytemuck::bytes_of(&header_of(LedgerData::TAG, bump, READY)),
        );
        assert_eq!(refusal(load_ledger(&info)), wrong, "{len} bytes");
        assert_eq!(refusal(load_ledger_mut(&info)), wrong, "{len} bytes");
    }
}

#[test]
fn a_ledger_that_is_not_ready_or_not_writable_or_not_this_programs_is_refused() {
    let (key, bump) = Pubkey::find_program_address(&[LEDGER_SEED], &crate::ID);
    let len = ledger_len(8_192);

    let unready = account(key, crate::ID, len, false, true);
    write(
        &unready,
        0,
        bytemuck::bytes_of(&header_of(LedgerData::TAG, bump, 0)),
    );
    assert_eq!(
        refusal(load_ledger(&unready)),
        error!(OrderbookError::NotReady)
    );

    let read_only = ledger_of(8_192);
    let frozen = AccountInfo::new(
        read_only.key,
        false,
        false,
        Box::leak(Box::new(0u64)),
        Box::leak(bytes_of(&read_only).into_boxed_slice()),
        read_only.owner,
        false,
    );
    assert!(load_ledger(&frozen).is_ok());
    assert_eq!(
        refusal(load_ledger_mut(&frozen)),
        error!(ErrorCode::ConstraintMut)
    );

    let foreign = account(key, Pubkey::new_unique(), len, false, true);
    write(
        &foreign,
        0,
        bytemuck::bytes_of(&header_of(LedgerData::TAG, bump, READY)),
    );
    assert_eq!(
        refusal(load_ledger(&foreign)),
        error!(OrderbookError::WrongOwner)
    );

    let other_kind = account(key, crate::ID, len, false, true);
    write(
        &other_kind,
        0,
        bytemuck::bytes_of(&header_of(ViewData::TAG, bump, READY)),
    );
    assert_eq!(
        refusal(load_ledger(&other_kind)),
        error!(OrderbookError::WrongKind)
    );

    let elsewhere = account(Pubkey::new_unique(), crate::ID, len, false, true);
    write(
        &elsewhere,
        0,
        bytemuck::bytes_of(&header_of(LedgerData::TAG, bump, READY)),
    );
    assert_eq!(
        refusal(load_ledger(&elsewhere)),
        error!(OrderbookError::WrongDerivation)
    );
}

#[test]
fn the_ledger_of_448_byte_seats_is_not_the_ledger_the_program_loads() {
    let (old_key, old_bump) = Pubkey::find_program_address(&[b"ledger"], &crate::ID);
    let (new_key, _) = Pubkey::find_program_address(&[LEDGER_SEED], &crate::ID);
    assert_ne!(old_key, new_key);
    let legacy = account(old_key, crate::ID, 917_528, false, true);
    write(
        &legacy,
        0,
        bytemuck::bytes_of(&header_of(LedgerData::TAG, old_bump, READY)),
    );
    assert_eq!(
        refusal(load_ledger(&legacy)),
        error!(OrderbookError::WrongDerivation),
        "the old ledger is at another address"
    );
    let (_, bump) = Pubkey::find_program_address(&[LEDGER_SEED], &crate::ID);
    let at_the_new_address = account(new_key, crate::ID, 917_528, false, true);
    write(
        &at_the_new_address,
        0,
        bytemuck::bytes_of(&header_of(LedgerData::TAG, bump, READY)),
    );
    assert_eq!(
        refusal(load_ledger(&at_the_new_address)),
        error!(OrderbookError::WrongSize),
        "917,528 bytes is not a whole number of 304-byte seats"
    );
}

#[test]
fn migrating_zeroes_the_caps_and_starts_the_relayout_once_and_a_second_migration_is_refused() {
    let admin = Pubkey::new_unique();
    let exchange = paused_with_caps(admin, [OLD_CAP, OLD_CAP, 0, u64::MAX / 3]);
    let before = exchange_of(&exchange);
    assert_ne!(before.layout, LAYOUT_V2);

    assert_eq!(migrate(admin, &exchange), Ok(()));

    let after = exchange_of(&exchange);
    assert_eq!(after.seat_capacity, 0);
    assert_eq!(after.layout, LAYOUT_RELAYOUT);
    assert_eq!((after.min_seat_deposit, after.relayout_next), (0, 0));
    assert_eq!(after._reserved, [0; 12]);
    let tail = last_field_bytes(&exchange);
    assert_eq!(tail[..4], [0; 4]);
    assert_eq!(tail[4..8], *b"NWXR");
    assert_eq!(tail[8..], [0; 24], "the custody caps are gone");
    assert_eq!(
        (
            after.admin,
            after.gate,
            after.max_seats_per_day,
            after.paused
        ),
        (before.admin, before.gate, before.max_seats_per_day, true),
        "no other setting moves"
    );

    let migrating = bytes_of(&exchange);
    assert_eq!(
        migrate(admin, &exchange),
        refused_with(OrderbookError::AlreadyMigrated)
    );
    assert_eq!(
        bytes_of(&exchange),
        migrating,
        "the second call changes nothing"
    );
}

#[test]
fn migrating_needs_the_admin_a_paused_exchange_and_one_that_has_not_the_layout() {
    let admin = Pubkey::new_unique();
    let unpaused = exchange_with_caps(blank_exchange(admin), [OLD_CAP; TOKENS]);
    let before = bytes_of(&unpaused);
    assert_eq!(
        migrate(admin, &unpaused),
        refused_with(OrderbookError::RelayoutOutOfOrder)
    );
    assert_eq!(bytes_of(&unpaused), before);

    let paused = paused_with_caps(admin, [OLD_CAP; TOKENS]);
    assert_eq!(
        migrate(Pubkey::new_unique(), &paused),
        refused_with(OrderbookError::NotAdmin)
    );

    let live = exchange_account(Exchange {
        paused: true,
        ..live_exchange(admin)
    });
    assert_eq!(
        migrate(admin, &live),
        refused_with(OrderbookError::AlreadyMigrated),
        "an exchange that has the layout is never reset"
    );
}

#[test]
fn extending_before_the_exchange_has_its_ledger_is_refused_and_changes_nothing() {
    let admin = Pubkey::new_unique();
    let ledger = ledger_of(MIN_SEATS);
    let relayout = exchange_account(Exchange {
        layout: LAYOUT_RELAYOUT,
        ..blank_exchange(admin)
    });
    for exchange in [
        exchange_with_caps(blank_exchange(admin), [OLD_CAP; TOKENS]),
        relayout,
    ] {
        let (ledger_before, exchange_before) = (bytes_of(&ledger), bytes_of(&exchange));

        let data = crate::instruction::ExtendLedger {
            seats: EXTEND_SEATS_PER_CALL,
        }
        .data();
        let result = run(extend_accounts(admin, &exchange, &ledger), data);

        assert_eq!(result, refused_with(OrderbookError::LayoutNotMigrated));
        assert_eq!(bytes_of(&ledger), ledger_before);
        assert_eq!(bytes_of(&exchange), exchange_before);
    }
}

#[test]
fn an_exchange_whose_cap_bytes_look_like_a_layout_is_not_migrated_until_the_magic_is_there() {
    let admin = Pubkey::new_unique();
    let ledger = ledger_of(MIN_SEATS);
    let capacity_like = u64::from(LAYOUT_V2 - 1) << 32 | 8_192;
    let exchange = exchange_with_caps(blank_exchange(admin), [capacity_like, 0, 0, 0]);
    let data = crate::instruction::ExtendLedger { seats: 1 }.data();
    assert_eq!(
        run(extend_accounts(admin, &exchange, &ledger), data),
        refused_with(OrderbookError::LayoutNotMigrated)
    );
}

#[test]
fn extending_is_refused_past_the_most_seats_an_account_holds_and_for_a_step_that_is_not_one() {
    let admin = Pubkey::new_unique();
    let exchange = exchange_account(live_exchange(admin));

    let nearly_full = ledger_of(MAX_SEATS - usize::from(EXTEND_SEATS_PER_CALL) / 2);
    let data = crate::instruction::ExtendLedger {
        seats: EXTEND_SEATS_PER_CALL,
    }
    .data();
    assert_eq!(
        run(extend_accounts(admin, &exchange, &nearly_full), data),
        refused_with(OrderbookError::LedgerTooLarge)
    );

    let ledger = ledger_of(MIN_SEATS);
    for seats in [0u16, EXTEND_SEATS_PER_CALL + 1, u16::MAX] {
        let data = crate::instruction::ExtendLedger { seats }.data();
        assert_eq!(
            run(extend_accounts(admin, &exchange, &ledger), data),
            refused_with(OrderbookError::InvalidGrowth),
            "{seats} seats"
        );
    }

    let stranger = Pubkey::new_unique();
    let data = crate::instruction::ExtendLedger { seats: 1 }.data();
    assert_eq!(
        run(extend_accounts(stranger, &exchange, &ledger), data),
        refused_with(OrderbookError::NotAdmin)
    );
}

#[test]
fn an_extension_plans_one_step_ending_on_a_seat_boundary_past_12288_seats_up_to_the_maximum() {
    let migrated = live_exchange(Pubkey::new_unique());

    let ledger = ledger_of(MIN_SEATS);
    let planned = extension(&migrated, &ledger, EXTEND_SEATS_PER_CALL).unwrap();
    assert_eq!(planned.0, ledger_len(MIN_SEATS));
    let step = usize::from(EXTEND_SEATS_PER_CALL);
    assert_eq!(planned.1, ledger_len(MIN_SEATS + step));
    assert_eq!(planned.1 - planned.0, step * SEAT_LEN);
    assert!(planned.1 - planned.0 <= crate::state::GROWTH_STEP as usize);

    let past_the_old_cap = ledger_of(12_288);
    assert_eq!(
        extension(&migrated, &past_the_old_cap, EXTEND_SEATS_PER_CALL)
            .unwrap()
            .1,
        ledger_len(12_288 + step)
    );
    let at_the_edge = ledger_of(MAX_SEATS - step);
    assert_eq!(
        extension(&migrated, &at_the_edge, EXTEND_SEATS_PER_CALL)
            .unwrap()
            .1,
        ledger_len(MAX_SEATS)
    );
    let full = ledger_of(MAX_SEATS);
    assert_eq!(
        refusal(extension(&migrated, &full, 1)),
        error!(OrderbookError::LedgerTooLarge)
    );
    let one_over = ledger_of(MAX_SEATS - step + 1);
    assert_eq!(
        refusal(extension(&migrated, &one_over, EXTEND_SEATS_PER_CALL)),
        error!(OrderbookError::LedgerTooLarge)
    );
}

/// Swaps in a ledger account's data grown to `new_len` with `fill` after the old bytes,
/// as the rollup's resize leaves it.
fn grown_to(ledger: &AccountInfo<'static>, new_len: usize, fill: u8) {
    let mut bigger = bytes_of(ledger);
    bigger.resize(new_len, fill);
    let words: &'static mut [u64] = Box::leak(vec![0u64; new_len.div_ceil(8)].into_boxed_slice());
    let data: &'static mut [u8] = &mut bytemuck::cast_slice_mut::<u64, u8>(words)[..new_len];
    data.copy_from_slice(&bigger);
    *ledger.data.borrow_mut() = data;
}

/// The seat indices on the free list, in the order they are handed out.
pub(crate) fn free_list(ledger: &AccountInfo) -> Vec<usize> {
    let read = load_ledger(ledger).unwrap();
    let mut listed = Vec::new();
    let mut link = read.header.free_head;
    while link != 0 {
        let index = usize::try_from(link - 1).unwrap();
        listed.push(index);
        assert!(listed.len() <= read.seats.len(), "the list loops");
        link = read.seats[index].next_free;
    }
    listed
}

#[test]
fn a_grown_ledger_has_its_new_bytes_zeroed_its_old_seats_kept_and_the_new_seats_listed() {
    let mut exchange = live_exchange(Pubkey::new_unique());
    let ledger = ledger_of(MIN_SEATS);
    let taken = {
        let mut open = load_ledger_mut(&ledger).unwrap();
        let mut engine = open.engine();
        let seat = take_seat(&mut engine, &[9; 32]).unwrap();
        engine_deposit(&mut engine, seat, Asset::Collateral, 77).unwrap();
        seat
    };
    assert_eq!(taken, 2);
    let mut capacity = MIN_SEATS;
    while capacity < 8_192 {
        let step = usize::from(EXTEND_SEATS_PER_CALL).min(8_192 - capacity);
        let (old_len, new_len) =
            extension(&exchange, &ledger, u16::try_from(step).unwrap()).unwrap();
        grown_to(&ledger, new_len, 0xAA);

        zero_and_record(&mut exchange, &ledger, old_len, new_len).unwrap();

        capacity += step;
        assert_eq!(exchange.seat_capacity as usize, capacity);
        assert_eq!(load_ledger(&ledger).unwrap().seats.len(), capacity);
    }

    assert_eq!(exchange.seat_capacity, 8_192);
    assert_eq!(bytes_of(&ledger).len(), ledger_len(8_192));
    let read = load_ledger(&ledger).unwrap();
    assert_eq!(read.header.open_seats, 3);
    assert_eq!(read.seats[2].owner, [9; 32]);
    assert_eq!(read.seats[2].collateral, 77);
    drop(read);

    let listed = free_list(&ledger);
    assert_eq!(
        listed.len(),
        8_192 - 3,
        "every closed trader seat is listed"
    );
    let mut sorted = listed.clone();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(sorted.len(), listed.len(), "none twice");
    assert_eq!(sorted[0], 3);
    assert_eq!(*sorted.last().unwrap(), 8_191);
    let newest_chunk = 8_192 - 6;
    assert_eq!(
        listed[0], newest_chunk,
        "the seats added last are the next ones taken"
    );

    let mut open = load_ledger_mut(&ledger).unwrap();
    let mut engine = open.engine();
    let past = take_seat(&mut engine, &[10; 32]).unwrap();
    assert_eq!(
        past as usize, newest_chunk,
        "a take lands above index 2,047"
    );
    let open_past_creation = engine.seats[MIN_SEATS..]
        .iter()
        .filter(|seat| seat.is_open())
        .count();
    assert_eq!(open_past_creation, 1);
    assert_eq!(engine.seats[newest_chunk].owner, [10; 32]);
}

#[test]
fn a_ledger_that_did_not_reach_its_new_length_is_not_recorded() {
    let mut exchange = live_exchange(Pubkey::new_unique());
    let ledger = ledger_of(MIN_SEATS);
    let (old_len, new_len) = extension(&exchange, &ledger, EXTEND_SEATS_PER_CALL).unwrap();
    let before = bytes_of(&ledger);

    let refused = refusal(zero_and_record(&mut exchange, &ledger, old_len, new_len));

    assert_eq!(refused, error!(OrderbookError::InvalidGrowth));
    assert_eq!(exchange.seat_capacity, 2_048);
    assert_eq!(bytes_of(&ledger), before, "no seat was listed");
}

#[test]
fn the_retired_cap_error_keeps_its_number_and_the_new_codes_have_theirs() {
    assert_eq!(u32::from(OrderbookError::CustodyCapReached), 6_150);
    assert_eq!(u32::from(OrderbookError::WrongWithdrawDestination), 6_154);
    assert_eq!(u32::from(OrderbookError::NotSeated), 6_155);
    assert_eq!(u32::from(OrderbookError::SeatDepositTooSmall), 6_156);
    assert_eq!(u32::from(OrderbookError::LayoutNotMigrated), 6_157);
    assert_eq!(u32::from(OrderbookError::AlreadyMigrated), 6_158);
    assert_eq!(u32::from(OrderbookError::LedgerTooLarge), 6_159);
    assert_eq!(u32::from(OrderbookError::RelayoutOutOfOrder), 6_160);
    assert_eq!(u32::from(OrderbookError::RelayoutMismatch), 6_161);
    assert_eq!(u32::from(OrderbookError::RelayoutIncomplete), 6_162);
    assert_eq!(u32::from(OrderbookError::SlotsFull), 6_093);
}

fn perp_params() -> MarketParams {
    MarketParams {
        tick: 10,
        base_lot: 1,
        min_size: 1,
        funding_interval: 3_600,
        max_price_age: 60,
        max_age_liquidation: 300,
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
        market_id: 0,
        ..MarketParams::zeroed()
    }
}

fn hash(data: &[u8]) -> [u8; 32] {
    solana_sha256_hasher::hash(data).to_bytes()
}

#[test]
fn a_seat_past_the_first_2048_trades_and_is_liquidated_through_a_range() {
    const NOW: i64 = 1_000_000;
    let info = ledger_of(8_192);
    let mut params = perp_params();
    let mut book = BookHeader {
        market_id: 0,
        last_funding_time: NOW,
        ..BookHeader::zeroed()
    };
    let mut bids = vec![Order::zeroed(); 8];
    let mut asks = vec![Order::zeroed(); 8];
    let fresh = |price: u64| Price {
        price,
        publish_time: NOW,
        accepted_at: NOW,
    };
    let mut price = fresh(1_000);
    let key = |seat: u32| [u8::try_from(seat % 200).unwrap() + 1; 32];
    let mut journal_entries = vec![JournalEntry::zeroed(); MAX_FILLS + PLACE_JOURNAL_EXTRA_ENTRIES];
    let mut fills = Fills::new();

    let (maker, liquidator, trader);
    {
        let mut open = load_ledger_mut(&info).unwrap();
        let mut engine = open.engine();
        maker = take_seat(&mut engine, &key(2)).unwrap();
        liquidator = take_seat(&mut engine, &key(3)).unwrap();
        let mut filler = 4u32;
        let mut last = liquidator;
        while last < 2_100 {
            let mut owner = [0xC0; 32];
            owner[..4].copy_from_slice(&filler.to_le_bytes());
            last = take_seat(&mut engine, &owner).unwrap();
            filler += 1;
        }
        trader = take_seat(&mut engine, &[0xDD; 32]).unwrap();
        assert!(trader as usize > MIN_SEATS, "seat {trader}");
        engine_deposit(&mut engine, maker, Asset::Collateral, 1_000_000).unwrap();
        engine_deposit(&mut engine, liquidator, Asset::Collateral, 10_000_000).unwrap();
        engine_deposit(&mut engine, trader, Asset::Collateral, 1_100).unwrap();
    }

    let order = |side, order_type, size| NewOrder {
        side,
        order_type,
        price: 1_000,
        size,
        secret: [7; 16],
        reduce_only: false,
        expiry: 0,
    };
    fn env(markets: &[MarketRisk]) -> Env<'_> {
        Env {
            now: NOW,
            exchange_paused: false,
            quote_ok: true,
            max_steps: 8,
            markets,
            hash,
        }
    }
    {
        let mut risks = vec![MarketRisk::NONE; MARKETS];
        risks[0] = MarketRisk::new(&params, &price, &book);
        let mut open = load_ledger_mut(&info).unwrap();
        let mut engine = open.engine();
        let mut market = MarketMut {
            params: &mut params,
            book: &mut book,
            bids: &mut bids,
            asks: &mut asks,
            price: &price,
        };
        let mut journal = Journal::new(&mut journal_entries);
        let key_of = |seat| key(seat);
        place_order(
            &mut engine,
            &mut market,
            &mut journal,
            &env(&risks),
            Trader {
                seat: maker,
                owner: &key_of(2),
            },
            &order(Side::Ask, OrderType::Limit, 10),
            &mut fills,
        )
        .unwrap();
        let taken = place_order(
            &mut engine,
            &mut market,
            &mut journal,
            &env(&risks),
            Trader {
                seat: trader,
                owner: &[0xDD; 32],
            },
            &order(Side::Bid, OrderType::ImmediateOrCancel, 10),
            &mut fills,
        )
        .unwrap();
        assert_eq!(taken.filled, 10);
    }
    assert_eq!(
        load_ledger(&info).unwrap().seats[trader as usize]
            .slot(0)
            .unwrap()
            .base,
        10
    );

    price = fresh(850);
    let mut risks = vec![MarketRisk::NONE; MARKETS];
    risks[0] = MarketRisk::new(&params, &price, &book);
    let sweep = |start: u32, count: u16| RangeRequest {
        start,
        count,
        size: 10,
        worst_price: u64::MAX,
        max_takeovers: 4,
    };
    let liquidate = |request: &RangeRequest,
                     params: &mut MarketParams,
                     book: &mut BookHeader,
                     bids: &mut Vec<Order>,
                     asks: &mut Vec<Order>,
                     journal_entries: &mut Vec<JournalEntry>| {
        let mut open = load_ledger_mut(&info).unwrap();
        let mut engine = open.engine();
        let mut market = MarketMut {
            params,
            book,
            bids,
            asks,
            price: &price,
        };
        let mut journal = Journal::new(journal_entries);
        liquidate_range(
            &mut engine,
            &mut market,
            &mut journal,
            &env(&risks),
            Trader {
                seat: liquidator,
                owner: &key(3),
            },
            request,
        )
        .unwrap()
    };
    let below = liquidate(
        &sweep(0, 2_048),
        &mut params,
        &mut book,
        &mut bids,
        &mut asks,
        &mut journal_entries,
    );
    assert_eq!(below.taken, 0, "the first 2,048 seats hold nothing to take");

    let swept = liquidate(
        &sweep(2_048, 200),
        &mut params,
        &mut book,
        &mut bids,
        &mut asks,
        &mut journal_entries,
    );
    assert_eq!((swept.taken, swept.lots), (1, 10), "{swept:?}");
    assert!(swept.notional > 0);

    let read = load_ledger(&info).unwrap();
    assert_eq!(read.seats[trader as usize].slot(0).unwrap().base, 0);
    assert_eq!(read.seats[liquidator as usize].slot(0).unwrap().base, 10);
}

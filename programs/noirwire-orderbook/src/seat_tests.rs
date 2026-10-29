//! A seat is taken by the first deposit into a view that holds none and given back when
//! it holds nothing: the take, the release, what a view that lost its seat can and cannot
//! do, the sweep, the full table, and the admin's access lists taking a seat. The deposit
//! and withdrawal are the program's own `credit_view` and `debit_view` on in-memory
//! ledgers; the instructions that need no clock or token program run through `entry`.

use anchor_lang::prelude::*;
use anchor_lang::InstructionData;
use bytemuck::Zeroable;
use core::mem::size_of;
use ephemeral_rollups_sdk::consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID};
use noirwire_orderbook_engine::{
    release_empty_seats, withdraw, Asset, Env, MarketRisk, Seat, Trader, MARKETS,
};

use crate::errors::OrderbookError;
use crate::growth_tests::{
    account, blank_exchange, bytes_of, exchange_account, free_list, header_of, ledger_of,
    live_exchange, refused_with, run, signer, write,
};
use crate::instructions::trader::{credit_view, debit_view};
use crate::loader::{load_ledger, load_ledger_mut, LedgerAccount};
use crate::state::{
    BookData, Exchange, Header, RollupAccount, ViewData, MIN_SEATS, NO_SEAT, PERMISSION_SEED,
    READY, RELEASE_SEATS_PER_CALL, VIEW_SEED,
};
use crate::view::{is_seated, seated_index, unseat};

fn hash(data: &[u8]) -> [u8; 32] {
    solana_sha256_hasher::hash(data).to_bytes()
}

fn view_of(owner: u8) -> ViewData {
    let mut view = ViewData::zeroed();
    view.owner = [owner; 32];
    unseat(&mut view);
    view
}

fn owner_key(index: usize) -> [u8; 32] {
    let mut owner = [0x77; 32];
    owner[..8].copy_from_slice(&u64::try_from(index).unwrap().to_le_bytes());
    owner
}

fn view_with_owner(owner: [u8; 32]) -> ViewData {
    let mut view = ViewData::zeroed();
    view.owner = owner;
    unseat(&mut view);
    view
}

fn credit(
    min: u64,
    view: &mut ViewData,
    ledger: &mut LedgerAccount<'_>,
    asset: Asset,
    amount: u64,
) -> Result<()> {
    credit_view(min, view, &mut ledger.engine(), asset, amount)
}

fn debit(view: &mut ViewData, ledger: &mut LedgerAccount<'_>, amount: u64) -> Result<()> {
    let risks = vec![MarketRisk::NONE; MARKETS];
    let env = Env {
        now: 1_000,
        exchange_paused: false,
        quote_ok: true,
        max_steps: 8,
        markets: &risks,
        hash,
    };
    debit_view(&env, view, &mut ledger.engine(), Asset::Collateral, amount)
}

fn view_bytes(view: &ViewData) -> Vec<u8> {
    bytemuck::bytes_of(view).to_vec()
}

#[test]
fn a_deposit_into_a_view_without_a_seat_takes_one_only_as_collateral_of_the_minimum() {
    let info = ledger_of(MIN_SEATS);
    let mut view = view_of(1);
    let (ledger_before, view_before) = (bytes_of(&info), view_bytes(&view));
    let mut ledger = load_ledger_mut(&info).unwrap();

    for (asset, amount) in [
        (Asset::Spot(1), 10),
        (Asset::Spot(0), 1_000),
        (Asset::Collateral, 9),
        (Asset::Collateral, 1),
    ] {
        assert_eq!(
            credit(10, &mut view, &mut ledger, asset, amount).unwrap_err(),
            error!(OrderbookError::SeatDepositTooSmall)
        );
    }
    assert_eq!(
        credit(10, &mut view, &mut ledger, Asset::Collateral, 0).unwrap_err(),
        error!(OrderbookError::ZeroAmount)
    );
    drop(ledger);
    assert_eq!(
        bytes_of(&info),
        ledger_before,
        "a refusal leaves the table alone"
    );
    assert_eq!(view_bytes(&view), view_before);

    let mut ledger = load_ledger_mut(&info).unwrap();
    credit(10, &mut view, &mut ledger, Asset::Collateral, 10).unwrap();
    assert_eq!(view.seat, 2, "the head of the free list");
    assert_eq!(view.used, 1);
    assert_eq!(view.snapshot.seat_index, 2);
    assert_eq!(view.snapshot.layout, 1);
    assert_eq!(view.snapshot.seat.collateral, 10);
    assert_eq!(view.snapshot._seat_reserved, [0; 144]);
    assert_eq!(ledger.header.open_seats, 3);
    assert_eq!(ledger.seats[2].owner, [1; 32]);
    assert_eq!(
        ledger.seats[2].version, 2,
        "one for the take, one for the credit"
    );
    assert!(is_seated(&view, &ledger.seats));
    assert_eq!(seated_index(&view, &ledger.seats).unwrap(), 2);

    credit(10, &mut view, &mut ledger, Asset::Spot(1), 5).unwrap();
    credit(10, &mut view, &mut ledger, Asset::Collateral, 1).unwrap();
    assert_eq!(
        ledger.header.open_seats, 3,
        "a seated view takes no second seat"
    );
    assert_eq!(ledger.seats[2].spot[1].available, 5);
    assert_eq!(ledger.seats[2].collateral, 11);
    assert_eq!(
        view.snapshot.seat, ledger.seats[2],
        "the view shows the seat"
    );
    assert_eq!(view.seat, 2);
}

#[test]
fn with_no_minimum_any_positive_collateral_takes_a_seat() {
    let info = ledger_of(MIN_SEATS);
    let mut ledger = load_ledger_mut(&info).unwrap();
    let mut view = view_of(1);
    assert_eq!(
        credit(0, &mut view, &mut ledger, Asset::Spot(0), 7).unwrap_err(),
        error!(OrderbookError::SeatDepositTooSmall),
        "a spot deposit never takes one"
    );
    assert_eq!(
        credit(0, &mut view, &mut ledger, Asset::Collateral, 0).unwrap_err(),
        error!(OrderbookError::ZeroAmount)
    );
    credit(0, &mut view, &mut ledger, Asset::Collateral, 1).unwrap();
    assert!(is_seated(&view, &ledger.seats));
    assert_eq!(ledger.seats[view.seat as usize].collateral, 1);
}

#[test]
fn an_emptying_withdrawal_releases_the_seat_and_a_partial_one_does_not() {
    let info = ledger_of(MIN_SEATS);
    let mut ledger = load_ledger_mut(&info).unwrap();
    let mut view = view_of(1);
    credit(0, &mut view, &mut ledger, Asset::Collateral, 10).unwrap();
    let version_taken = ledger.seats[2].version;

    debit(&mut view, &mut ledger, 4).unwrap();
    assert_eq!(view.seat, 2);
    assert_eq!(view.snapshot.seat.collateral, 6);
    assert_eq!(ledger.header.open_seats, 3);

    debit(&mut view, &mut ledger, 6).unwrap();
    assert_eq!(view.seat, NO_SEAT);
    assert_eq!(view.used, 1, "the view remembers it took a seat");
    assert_eq!(view.snapshot.seat, Seat::zeroed());
    assert_eq!(view.snapshot.layout, 1);
    assert_eq!(ledger.header.open_seats, 2);
    assert_eq!(ledger.header.free_head, 3, "seat 2 is the next one taken");
    assert!(ledger.seats[2].version > version_taken);
    assert!(!is_seated(&view, &ledger.seats));
    assert_eq!(
        seated_index(&view, &ledger.seats).unwrap_err(),
        error!(OrderbookError::NotSeated)
    );
    assert_eq!(
        debit(&mut view, &mut ledger, 1).unwrap_err(),
        error!(OrderbookError::NotSeated),
        "a withdrawal needs a seat"
    );

    let version_released = ledger.seats[2].version;
    credit(0, &mut view, &mut ledger, Asset::Collateral, 3).unwrap();
    assert_eq!(view.seat, 2);
    assert!(
        ledger.seats[2].version > version_released,
        "the version rises at every take and every release"
    );
}

#[test]
fn a_seat_with_a_list_entry_or_a_block_or_a_debt_is_not_released_by_a_withdrawal_or_the_sweep() {
    let info = ledger_of(MIN_SEATS);
    let mut ledger = load_ledger_mut(&info).unwrap();
    let (mut pinned, mut blocked, mut debtor) = (view_of(1), view_of(2), view_of(3));
    for view in [&mut pinned, &mut blocked, &mut debtor] {
        credit(0, view, &mut ledger, Asset::Collateral, 10).unwrap();
    }
    ledger.seats[pinned.seat as usize].maker_markets = 0b10;
    ledger.seats[blocked.seat as usize].blocked = 1;

    debit(&mut pinned, &mut ledger, 10).unwrap();
    debit(&mut blocked, &mut ledger, 10).unwrap();
    assert!(
        is_seated(&pinned, &ledger.seats),
        "a list entry pins the seat"
    );
    assert!(is_seated(&blocked, &ledger.seats), "a block pins the seat");
    assert_eq!(pinned.snapshot.seat.collateral, 0);

    ledger.seats[debtor.seat as usize].collateral = -5;
    release_empty_seats(&mut ledger.engine(), 0, 2_048);
    for view in [&pinned, &blocked, &debtor] {
        assert!(is_seated(view, &ledger.seats), "the sweep passes it over");
    }
    assert_eq!(ledger.header.open_seats, 5);
}

#[test]
fn a_seat_the_sweep_released_and_another_owner_took_is_not_the_old_owners() {
    let info = ledger_of(MIN_SEATS);
    let mut ledger = load_ledger_mut(&info).unwrap();
    let (mut first, mut second) = (view_of(1), view_of(2));
    credit(10, &mut first, &mut ledger, Asset::Collateral, 10).unwrap();
    let risks = vec![MarketRisk::NONE; MARKETS];
    let env = Env {
        now: 1_000,
        exchange_paused: false,
        quote_ok: true,
        max_steps: 8,
        markets: &risks,
        hash,
    };
    let owner = first.owner;
    withdraw(
        &mut ledger.engine(),
        &env,
        Trader {
            seat: first.seat,
            owner: &owner,
        },
        Asset::Collateral,
        10,
    )
    .unwrap();
    assert!(
        is_seated(&first, &ledger.seats),
        "emptied but not released: the seat is still the owner's"
    );
    release_empty_seats(&mut ledger.engine(), 0, 2_048);
    assert_eq!(first.seat, 2, "the sweep cannot write views");
    assert!(!is_seated(&first, &ledger.seats));

    credit(10, &mut second, &mut ledger, Asset::Collateral, 10).unwrap();
    assert_eq!(second.seat, 2, "the freed index goes to the next taker");
    assert!(
        !is_seated(&first, &ledger.seats),
        "it is another owner's now"
    );
    assert_eq!(
        seated_index(&first, &ledger.seats).unwrap_err(),
        error!(OrderbookError::NotSeated)
    );
    assert_eq!(
        debit(&mut first, &mut ledger, 1).unwrap_err(),
        error!(OrderbookError::NotSeated),
        "a withdrawal never touches the new owner's seat"
    );

    drop(ledger);
    let before = bytes_of(&info);
    let mut ledger = load_ledger_mut(&info).unwrap();
    assert_eq!(
        credit(10, &mut first, &mut ledger, Asset::Collateral, 5).unwrap_err(),
        error!(OrderbookError::SeatDepositTooSmall),
        "a third party's small deposit cannot take a seat for a swept view"
    );
    drop(ledger);
    assert_eq!(bytes_of(&info), before);
    let mut ledger = load_ledger_mut(&info).unwrap();
    assert_eq!(
        ledger.seats[2].collateral, 10,
        "the new owner's balance stands"
    );

    credit(10, &mut first, &mut ledger, Asset::Collateral, 12).unwrap();
    assert_ne!(
        first.seat, 2,
        "a deposit of the minimum takes a seat of its own"
    );
    assert_eq!(ledger.seats[first.seat as usize].owner, [1; 32]);
    assert_eq!(ledger.seats[2].owner, [2; 32]);
    assert_eq!(ledger.seats[2].collateral, 10);
    assert_eq!(first.used, 1);

    let mut repaired = view_of(9);
    repaired.seat = 2;
    repaired.used = 1;
    assert!(!is_seated(&repaired, &ledger.seats));
    unseat(&mut repaired);
    assert_eq!(repaired.seat, NO_SEAT);
    assert_eq!(repaired.snapshot.seat, Seat::zeroed());
    assert_eq!(repaired.used, 1, "the repair keeps what the view did");
}

#[test]
fn a_full_table_refuses_only_the_deposit_that_would_take_a_seat() {
    let info = ledger_of(MIN_SEATS);
    let mut ledger = load_ledger_mut(&info).unwrap();
    let mut views: Vec<ViewData> = (0..MIN_SEATS - 2)
        .map(|index| view_with_owner(owner_key(index)))
        .collect();
    for view in &mut views {
        credit(0, view, &mut ledger, Asset::Collateral, 5).unwrap();
    }
    assert_eq!(ledger.header.free_head, 0);
    assert_eq!(ledger.header.open_seats as usize, MIN_SEATS);

    let mut late = view_with_owner(owner_key(MIN_SEATS));
    assert_eq!(
        credit(0, &mut late, &mut ledger, Asset::Collateral, 5).unwrap_err(),
        error!(OrderbookError::SeatTableFull)
    );
    assert_eq!(late.seat, NO_SEAT);

    credit(0, &mut views[10], &mut ledger, Asset::Collateral, 5).unwrap();
    credit(0, &mut views[10], &mut ledger, Asset::Spot(2), 5).unwrap();
    debit(&mut views[10], &mut ledger, 3).unwrap();
    debit(&mut views[11], &mut ledger, 5).unwrap();
    assert_eq!(
        views[11].seat, NO_SEAT,
        "an emptying withdrawal frees a seat"
    );

    credit(0, &mut late, &mut ledger, Asset::Collateral, 5).unwrap();
    assert!(is_seated(&late, &ledger.seats));
}

#[test]
fn the_sweep_releases_only_empty_unpinned_trader_seats_and_says_nothing() {
    let admin = Pubkey::new_unique();
    let info = ledger_of(MIN_SEATS);
    let mut views: Vec<ViewData> = (0..6).map(|n| view_of(n + 1)).collect();
    {
        let mut ledger = load_ledger_mut(&info).unwrap();
        for view in &mut views {
            credit(0, view, &mut ledger, Asset::Collateral, 5).unwrap();
        }
        let seat = |view: &ViewData| view.seat as usize;
        ledger.seats[seat(&views[0])].collateral = 0;
        ledger.seats[seat(&views[1])].collateral = 0;
        ledger.seats[seat(&views[1])].taker_markets = 1;
        ledger.seats[seat(&views[2])].collateral = -1;
        ledger.seats[seat(&views[3])].collateral = 0;
        ledger.seats[seat(&views[3])].blocked = 1;
        ledger.seats[seat(&views[4])].collateral = 0;
        ledger.seats[seat(&views[4])].spot[3].locked = 1;
    }
    let exchange = exchange_account(live_exchange(admin));
    let sweep = |start: u32, count: u16| {
        let accounts = vec![signer(admin), exchange.clone(), info.clone()];
        run(
            accounts,
            crate::instruction::ReleaseEmptySeats { start, count }.data(),
        )
    };

    assert_eq!(sweep(0, RELEASE_SEATS_PER_CALL), Ok(()));

    let read = load_ledger(&info).unwrap();
    assert!(
        !read.seats[views[0].seat as usize].is_open(),
        "empty and unpinned"
    );
    for kept in &views[1..=4] {
        assert!(read.seats[kept.seat as usize].is_open());
    }
    assert!(read.seats[views[5].seat as usize].is_open(), "funded");
    assert!(
        read.seats[0].is_open() && read.seats[1].is_open(),
        "reserved"
    );
    assert_eq!(read.header.open_seats, 7);
    drop(read);
    assert_eq!(
        free_list(&info)[0],
        views[0].seat as usize,
        "the released seat is the next one taken"
    );

    let after = bytes_of(&info);
    assert_eq!(
        sweep(0, RELEASE_SEATS_PER_CALL),
        Ok(()),
        "a second sweep finds nothing"
    );
    assert_eq!(bytes_of(&info), after);
    assert_eq!(
        sweep(100_000, 10),
        Ok(()),
        "a range past the table is empty"
    );
    assert_eq!(bytes_of(&info), after);
    for count in [0, RELEASE_SEATS_PER_CALL + 1, u16::MAX] {
        assert_eq!(
            sweep(0, count),
            refused_with(OrderbookError::InvalidSettings),
            "{count} seats"
        );
    }
    let unmigrated = exchange_account(blank_exchange(admin));
    let accounts = vec![signer(admin), unmigrated, info.clone()];
    assert_eq!(
        run(
            accounts,
            crate::instruction::ReleaseEmptySeats { start: 0, count: 1 }.data()
        ),
        refused_with(OrderbookError::LayoutNotMigrated)
    );
}

fn view_account(view: &ViewData) -> AccountInfo<'static> {
    let owner = Pubkey::new_from_array(view.owner);
    let (key, bump) = Pubkey::find_program_address(&[VIEW_SEED, owner.as_ref()], &crate::ID);
    let info = account(key, crate::ID, ViewData::LEN, false, true);
    write(
        &info,
        0,
        bytemuck::bytes_of(&header_of(ViewData::TAG, bump, READY)),
    );
    write(&info, 16, bytemuck::bytes_of(view));
    info
}

fn view_of_of(info: &AccountInfo) -> ViewData {
    *bytemuck::from_bytes(&bytes_of(info)[16..16 + size_of::<ViewData>()])
}

/// The accounts `close_trader` and `close_unused_trader` take after the signer, the
/// exchange and the ledger: the view and its permission and the rollup's own accounts.
fn closing_accounts(view: &AccountInfo<'static>) -> Vec<AccountInfo<'static>> {
    let (permission, _) = Pubkey::find_program_address(
        &[PERMISSION_SEED, view.key.as_ref()],
        &PERMISSION_PROGRAM_ID,
    );
    vec![
        view.clone(),
        account(permission, PERMISSION_PROGRAM_ID, 0, false, true),
        account(
            PERMISSION_PROGRAM_ID,
            PERMISSION_PROGRAM_ID,
            0,
            false,
            false,
        ),
        account(EPHEMERAL_VAULT_ID, PERMISSION_PROGRAM_ID, 0, false, true),
        account(MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID, 0, false, false),
    ]
}

#[test]
fn closing_a_funded_seat_is_refused_and_the_admin_closes_only_views_that_never_took_one() {
    let admin = Pubkey::new_unique();
    let owner = Pubkey::new_unique();
    let ledger = ledger_of(MIN_SEATS);
    let exchange = exchange_account(live_exchange(admin));
    let mut view = view_with_owner(owner.to_bytes());
    credit(
        0,
        &mut view,
        &mut load_ledger_mut(&ledger).unwrap(),
        Asset::Collateral,
        5,
    )
    .unwrap();
    let view_info = view_account(&view);
    let before = (bytes_of(&ledger), bytes_of(&view_info));

    let close_trader = |view_info: &AccountInfo<'static>| {
        let mut accounts = vec![signer(owner), exchange.clone(), ledger.clone()];
        accounts.extend(closing_accounts(view_info));
        run(accounts, crate::instruction::CloseTrader {}.data())
    };
    let close_unused = |view_info: &AccountInfo<'static>| {
        let mut accounts = vec![signer(admin), exchange.clone(), ledger.clone()];
        accounts.extend(closing_accounts(view_info));
        run(
            accounts,
            crate::instruction::CloseUnusedTrader { owner }.data(),
        )
    };
    assert_eq!(
        close_trader(&view_info),
        refused_with(OrderbookError::SeatNotEmpty),
        "a funded seat is never cut off from its view"
    );
    assert_eq!(
        close_unused(&view_info),
        refused_with(OrderbookError::SeatUsed),
        "the admin leaves a seated view alone"
    );

    let mut emptied = view_of_of(&view_info);
    debit(&mut emptied, &mut load_ledger_mut(&ledger).unwrap(), 5).unwrap();
    let swept = view_account(&emptied);
    assert_eq!(emptied.seat, NO_SEAT);
    assert_eq!(
        close_unused(&swept),
        refused_with(OrderbookError::SeatUsed),
        "a view that once took a seat keeps its order keys"
    );
    assert_ne!(before.0, bytes_of(&ledger));
    assert_eq!(before.1, bytes_of(&view_info));
}

fn book_of(market_id: u8) -> AccountInfo<'static> {
    let (key, bump) = Pubkey::find_program_address(&[BookData::SEED, &[market_id]], &crate::ID);
    let info = account(key, crate::ID, BookData::LEN, false, true);
    let header = Header {
        tag: BookData::TAG,
        ready: READY,
        market_id,
        bump,
        _padding: [0; 5],
    };
    write(&info, 0, bytemuck::bytes_of(&header));
    {
        let mut data = info.try_borrow_mut_data().unwrap();
        bytemuck::from_bytes_mut::<BookData>(&mut data[16..16 + size_of::<BookData>()])
            .book
            .header
            .market_id = market_id;
    }
    info
}

fn set_access(
    admin: Pubkey,
    exchange: &AccountInfo<'static>,
    ledger: &AccountInfo<'static>,
    view: &AccountInfo<'static>,
    owner: Pubkey,
    lists: (u64, u64, bool),
) -> core::result::Result<(), ProgramError> {
    let accounts = vec![
        signer(admin),
        exchange.clone(),
        ledger.clone(),
        view.clone(),
        book_of(1),
    ];
    run(
        accounts,
        crate::instruction::SetSeatAccess {
            owner,
            maker_markets: lists.0,
            taker_markets: lists.1,
            blocked: lists.2,
        }
        .data(),
    )
}

fn exchange_with_one_perp(admin: Pubkey) -> AccountInfo<'static> {
    exchange_account(Exchange {
        perp_markets: 0b10,
        ..live_exchange(admin)
    })
}

#[test]
fn the_admin_taking_a_seat_for_an_unseated_owner_pins_it_and_a_later_deposit_lands_in_it() {
    let admin = Pubkey::new_unique();
    let owner = Pubkey::new_unique();
    let ledger = ledger_of(MIN_SEATS);
    let exchange = exchange_with_one_perp(admin);
    let view_info = view_account(&view_with_owner(owner.to_bytes()));

    let (ledger_before, view_before) = (bytes_of(&ledger), bytes_of(&view_info));
    assert_eq!(
        set_access(admin, &exchange, &ledger, &view_info, owner, (0, 0, false)),
        Ok(()),
        "nothing to set for an owner with no seat"
    );
    assert_eq!(bytes_of(&ledger), ledger_before);
    assert_eq!(bytes_of(&view_info), view_before);
    assert_eq!(
        set_access(
            admin,
            &exchange,
            &ledger,
            &view_info,
            owner,
            (0b100, 0, false)
        ),
        refused_with(OrderbookError::InvalidSettings),
        "the lists name perp markets only"
    );
    assert_eq!(bytes_of(&ledger), ledger_before);

    assert_eq!(
        set_access(
            admin,
            &exchange,
            &ledger,
            &view_info,
            owner,
            (0b10, 0, false)
        ),
        Ok(())
    );
    let view = view_of_of(&view_info);
    assert_eq!(view.seat, 2);
    assert_eq!(view.used, 1);
    {
        let read = load_ledger(&ledger).unwrap();
        assert_eq!(read.seats[2].owner, owner.to_bytes());
        assert_eq!(read.seats[2].maker_markets, 0b10);
        assert_eq!(read.header.open_seats, 3);
    }

    let mut view = view;
    credit(
        0,
        &mut view,
        &mut load_ledger_mut(&ledger).unwrap(),
        Asset::Collateral,
        9,
    )
    .unwrap();
    let read = load_ledger(&ledger).unwrap();
    assert_eq!(view.seat, 2, "the deposit finds the seat the admin took");
    assert_eq!(read.seats[2].collateral, 9);
    assert_eq!(read.seats[2].maker_markets, 0b10);
    assert_eq!(read.header.open_seats, 3);
    drop(read);

    let seated_view = view_account(&view);
    assert_eq!(
        set_access(
            admin,
            &exchange,
            &ledger,
            &seated_view,
            owner,
            (0, 0b10, true)
        ),
        Ok(())
    );
    let read = load_ledger(&ledger).unwrap();
    assert_eq!(
        (
            read.seats[2].maker_markets,
            read.seats[2].taker_markets,
            read.seats[2].blocked
        ),
        (0, 0b10, 1)
    );
    assert_eq!(read.seats[2].collateral, 9);
    assert_eq!(
        read.header.open_seats, 3,
        "an owner with a seat takes no second one"
    );
}

#[test]
fn a_block_alone_takes_a_seat_and_a_full_table_refuses_the_admin_like_anyone() {
    let admin = Pubkey::new_unique();
    let ledger = ledger_of(MIN_SEATS);
    let exchange = exchange_with_one_perp(admin);
    let owner = Pubkey::new_unique();
    let view_info = view_account(&view_with_owner(owner.to_bytes()));
    assert_eq!(
        set_access(admin, &exchange, &ledger, &view_info, owner, (0, 0, true)),
        Ok(())
    );
    let seat = view_of_of(&view_info).seat as usize;
    assert_eq!(load_ledger(&ledger).unwrap().seats[seat].blocked, 1);

    {
        let mut open = load_ledger_mut(&ledger).unwrap();
        let mut views: Vec<ViewData> = (0..MIN_SEATS - 3)
            .map(|index| view_with_owner(owner_key(index)))
            .collect();
        for view in &mut views {
            credit(0, view, &mut open, Asset::Collateral, 1).unwrap();
        }
    }
    let late = Pubkey::new_unique();
    let late_view = view_account(&view_with_owner(late.to_bytes()));
    let (ledger_before, view_before) = (bytes_of(&ledger), bytes_of(&late_view));
    assert_eq!(
        set_access(
            admin,
            &exchange,
            &ledger,
            &late_view,
            late,
            (0b10, 0, false)
        ),
        refused_with(OrderbookError::SeatTableFull)
    );
    assert_eq!(bytes_of(&ledger), ledger_before);
    assert_eq!(bytes_of(&late_view), view_before);
    assert_eq!(
        set_access(admin, &exchange, &ledger, &late_view, late, (0, 0, false)),
        Ok(()),
        "clearing everything on a view with no seat needs none"
    );
}

//! The phases of the exchange's layout through the program's own entry point: what an
//! exchange the earlier build made refuses, what scanning and activating it take, and what
//! the renamed instructions do with the old discriminators.

use anchor_lang::prelude::*;
use anchor_lang::{Discriminator, InstructionData, ToAccountMetas};
use bytemuck::Zeroable;
use ephemeral_rollups_sdk::consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID};
use noirwire_orderbook_engine::{MarketParams, KIND_PERP, KIND_SPOT, STATUS_ACTIVE, STATUS_PAUSED};

use crate::errors::OrderbookError;
use crate::growth_tests::{
    at, bytes_of, deployed_exchange, exchange_account, ledger_of, live_exchange, refused_with, run,
    signer, write,
};
use crate::instructions::setup::require_perp_room;
use crate::instructions::trader::AssetKind;
use crate::instructions::trading::{LiquidationInput, OrderInput};
use crate::instructions::triggers::TriggerParams;
use crate::instructions::{MarketLimits, MarketSettings, PriceSourceSettings, QuoteSettings};
use crate::layout::INSTRUCTION_GATES;
use crate::market::sha256;
use crate::state::{
    BookData, Exchange, MarketData, PriceData, RollupAccount, ScanData, StatsData, TapeData,
    TriggerData, ViewData, HEADER_LEN, LAYOUT_V2, LAYOUT_V3, LEDGER_PREFIX, MAX_PERP_MARKETS,
    MIN_SEATS, NO_SEAT, PERMISSION_SEED, SCAN_SEED, SCAN_VERSION, SEAT_LEN, VIEW_SEED,
};
use crate::trigger_tests::{global, market_stamped, perp_params, stamped};

/// Every account the program's calls name, at its derived address, with an exchange of
/// the given layout and a ledger of `MIN_SEATS` seats.
struct Chain {
    admin: Pubkey,
    owner: Pubkey,
    order_key: Pubkey,
    exchange: AccountInfo<'static>,
    ledger: AccountInfo<'static>,
    view: AccountInfo<'static>,
    market: AccountInfo<'static>,
    book: AccountInfo<'static>,
    price: AccountInfo<'static>,
    tape: AccountInfo<'static>,
    stats: AccountInfo<'static>,
    triggers: AccountInfo<'static>,
}

fn paused(exchange: Exchange) -> Exchange {
    Exchange {
        paused: true,
        ..exchange
    }
}

impl Chain {
    fn new(exchange: impl FnOnce(Pubkey) -> Exchange) -> Chain {
        let admin = Pubkey::new_unique();
        let owner = Pubkey::new_unique();
        let order_key = Pubkey::new_unique();
        let view = stamped(ViewData::TAG, VIEW_SEED, owner.as_ref(), 0, ViewData::LEN);
        {
            let mut body = ViewData::zeroed();
            body.owner = owner.to_bytes();
            body.order_keys[0] = order_key.to_bytes();
            body.seat = NO_SEAT;
            write(&view, HEADER_LEN, bytemuck::bytes_of(&body));
        }
        let market = market_stamped::<MarketData>(0, MarketData::LEN);
        {
            let mut body = MarketData::zeroed();
            body.params = perp_params(0);
            body.params.status = STATUS_PAUSED;
            body.params._reserved = [0xAB; 8];
            body.capacity = 8;
            write(&market, HEADER_LEN, bytemuck::bytes_of(&body));
        }
        Chain {
            admin,
            owner,
            order_key,
            exchange: exchange_account(exchange(admin)),
            ledger: ledger_of(MIN_SEATS),
            view,
            market,
            book: market_stamped::<BookData>(0, BookData::LEN),
            price: market_stamped::<PriceData>(0, PriceData::LEN),
            tape: market_stamped::<TapeData>(0, TapeData::LEN),
            stats: global::<StatsData>(),
            triggers: market_stamped::<TriggerData>(0, TriggerData::LEN),
        }
    }

    fn every_account(&self) -> Vec<AccountInfo<'static>> {
        vec![
            self.exchange.clone(),
            self.ledger.clone(),
            self.view.clone(),
            self.market.clone(),
            self.book.clone(),
            self.price.clone(),
            self.tape.clone(),
            self.stats.clone(),
            self.triggers.clone(),
        ]
    }

    fn snapshot(&self) -> Vec<Vec<u8>> {
        self.every_account().iter().map(bytes_of).collect()
    }

    /// The accounts of every instruction an order key signs.
    fn order_key_call(&self) -> Vec<AccountInfo<'static>> {
        vec![
            signer(self.order_key),
            self.view.clone(),
            self.exchange.clone(),
            self.ledger.clone(),
            self.market.clone(),
            self.book.clone(),
            self.price.clone(),
            self.tape.clone(),
            self.stats.clone(),
            self.triggers.clone(),
        ]
    }

    fn own_view(&self) -> Vec<AccountInfo<'static>> {
        vec![
            signer(self.owner),
            self.view.clone(),
            self.exchange.clone(),
            self.ledger.clone(),
        ]
    }

    fn own_view_signed(&self) -> Vec<AccountInfo<'static>> {
        vec![
            at(self.owner),
            self.view.clone(),
            at(solana_instructions_sysvar::ID),
            self.exchange.clone(),
            self.ledger.clone(),
        ]
    }

    fn deposit(&self) -> Vec<AccountInfo<'static>> {
        vec![
            signer(Pubkey::new_unique()),
            self.exchange.clone(),
            self.ledger.clone(),
            self.view.clone(),
            at(Pubkey::new_unique()),
            at(Pubkey::new_unique()),
            at(Pubkey::new_unique()),
            at(Pubkey::new_unique()),
        ]
    }

    fn fire(&self) -> Vec<AccountInfo<'static>> {
        vec![
            self.exchange.clone(),
            self.ledger.clone(),
            self.market.clone(),
            self.book.clone(),
            self.price.clone(),
            self.tape.clone(),
            self.stats.clone(),
            self.triggers.clone(),
        ]
    }

    fn sweep(&self) -> Vec<AccountInfo<'static>> {
        vec![
            self.exchange.clone(),
            self.ledger.clone(),
            self.triggers.clone(),
        ]
    }

    fn rebind(&self) -> Vec<AccountInfo<'static>> {
        vec![
            signer(self.admin),
            self.exchange.clone(),
            self.market.clone(),
            self.book.clone(),
            self.price.clone(),
        ]
    }

    fn sync_price(&self) -> Vec<AccountInfo<'static>> {
        vec![
            self.exchange.clone(),
            self.market.clone(),
            self.price.clone(),
            at(Pubkey::new_unique()),
        ]
    }

    fn funding(&self) -> Vec<AccountInfo<'static>> {
        vec![
            self.exchange.clone(),
            self.market.clone(),
            self.book.clone(),
            self.price.clone(),
        ]
    }

    fn quote(&self) -> Vec<AccountInfo<'static>> {
        vec![signer(self.admin), self.exchange.clone()]
    }
}

fn order() -> OrderInput {
    OrderInput {
        side: 0,
        order_type: 0,
        price: 1_000,
        size: 1,
        secret: [1; 16],
        reduce_only: false,
        expiry: 0,
    }
}

fn trigger() -> TriggerParams {
    TriggerParams {
        kind: 1,
        trigger_price: 900,
        worst_price: 800,
        size: 0,
        expiry: 0,
        secret: [2; 16],
    }
}

fn new_keys() -> [Pubkey; 4] {
    std::array::from_fn(|_| Pubkey::new_unique())
}

type Call = (&'static str, Vec<AccountInfo<'static>>, Vec<u8>);

/// One call of each kind the exchange refuses before activation, with the accounts it names.
fn calls(chain: &Chain) -> Vec<Call> {
    let (replacement, client_order_id, market_id) = (Pubkey::new_unique(), 7u64, 0u8);
    vec![
        (
            "place_order",
            chain.order_key_call(),
            crate::instruction::PlaceOrder {
                expires_at: i64::MAX,
                replacement,
                client_order_id,
                market_id,
                order: order(),
            }
            .data(),
        ),
        (
            "deposit",
            chain.deposit(),
            crate::instruction::Deposit {
                asset: AssetKind::Collateral,
                amount: 1,
            }
            .data(),
        ),
        (
            "set_order_keys",
            chain.own_view(),
            crate::instruction::SetOrderKeys {
                order_keys: new_keys(),
            }
            .data(),
        ),
        (
            "set_order_keys_signed",
            chain.own_view_signed(),
            crate::instruction::SetOrderKeysSigned {
                order_keys: new_keys(),
                nonce: 0,
                expires_at: i64::MAX,
            }
            .data(),
        ),
        (
            "set_trigger",
            chain.order_key_call(),
            crate::instruction::SetTrigger {
                expires_at: i64::MAX,
                replacement,
                client_order_id,
                market_id,
                trigger: trigger(),
            }
            .data(),
        ),
        (
            "fire_triggers",
            chain.fire(),
            crate::instruction::FireTriggers {
                market_id,
                max_fires: 1,
            }
            .data(),
        ),
        (
            "sweep_triggers",
            chain.sweep(),
            crate::instruction::SweepTriggers {
                market_id,
                count: 1,
            }
            .data(),
        ),
        (
            "liquidate",
            chain.order_key_call(),
            crate::instruction::Liquidate {
                expires_at: i64::MAX,
                replacement,
                client_order_id,
                market_id,
                request: LiquidationInput {
                    target: 2,
                    size: 1,
                    worst_price: 1,
                },
            }
            .data(),
        ),
        (
            "set_price_source_v2",
            chain.rebind(),
            crate::instruction::SetPriceSourceV2 { market_id, feed: 6 }.data(),
        ),
        (
            "set_quote_source_v2",
            chain.quote(),
            crate::instruction::SetQuoteSourceV2 {
                settings: QuoteSettings {
                    feed: 7,
                    depeg_bps: 100,
                    max_age: 180,
                },
            }
            .data(),
        ),
        (
            "sync_price",
            chain.sync_price(),
            crate::instruction::SyncPrice { market_id }.data(),
        ),
        (
            "update_funding",
            chain.funding(),
            crate::instruction::UpdateFunding { market_id }.data(),
        ),
    ]
}

#[test]
fn an_exchange_the_earlier_build_made_refuses_every_money_key_price_trade_trigger_and_upkeep_call()
{
    let chain = Chain::new(deployed_exchange);
    let before = chain.snapshot();
    for (name, accounts, data) in calls(&chain) {
        assert_eq!(
            run(accounts, data),
            refused_with(OrderbookError::LayoutNotActive),
            "{name}"
        );
        assert_eq!(chain.snapshot(), before, "{name} wrote");
    }
}

#[test]
fn an_exchange_with_neither_layout_refuses_them_too() {
    let chain = Chain::new(|admin| Exchange {
        layout: 0,
        ..deployed_exchange(admin)
    });
    for (name, accounts, data) in calls(&chain) {
        assert_eq!(
            run(accounts, data),
            refused_with(OrderbookError::LayoutNotActive),
            "{name}"
        );
    }
}

#[test]
fn the_same_calls_get_past_the_gate_once_the_layout_is_active() {
    let chain = Chain::new(live_exchange);
    for (name, accounts, data) in calls(&chain) {
        assert_ne!(
            run(accounts, data),
            refused_with(OrderbookError::LayoutNotActive),
            "{name}"
        );
    }
}

#[test]
fn a_key_reset_works_once_active_and_writes_the_view_only() {
    let chain = Chain::new(live_exchange);
    let ledger_before = bytes_of(&chain.ledger);
    let keys = new_keys();
    run(
        chain.own_view(),
        crate::instruction::SetOrderKeys { order_keys: keys }.data(),
    )
    .unwrap();
    assert_eq!(bytes_of(&chain.ledger), ledger_before, "an unseated view");
    let view = bytes_of(&chain.view);
    assert_eq!(
        view[HEADER_LEN + 32..HEADER_LEN + 64],
        keys[0].to_bytes(),
        "the first key was replaced"
    );
}

/// The scan's own account, ready, at its address.
fn scan_account(cursor: u32, capacity: u32) -> AccountInfo<'static> {
    let account = stamped(ScanData::TAG, SCAN_SEED, &[], 0, ScanData::LEN);
    write(
        &account,
        HEADER_LEN,
        bytemuck::bytes_of(&ScanData {
            version: SCAN_VERSION,
            cursor,
            capacity,
            _padding: 0,
        }),
    );
    account
}

fn cursor_of(scan: &AccountInfo) -> u32 {
    let data = bytes_of(scan);
    bytemuck::from_bytes::<ScanData>(
        &data[HEADER_LEN..HEADER_LEN + std::mem::size_of::<ScanData>()],
    )
    .cursor
}

struct Migration {
    admin: Pubkey,
    exchange: AccountInfo<'static>,
    ledger: AccountInfo<'static>,
    scan: AccountInfo<'static>,
}

impl Migration {
    fn new(exchange: impl FnOnce(Pubkey) -> Exchange, seats: usize, cursor: u32) -> Migration {
        let admin = Pubkey::new_unique();
        Migration {
            admin,
            exchange: exchange_account(exchange(admin)),
            ledger: ledger_of(seats),
            scan: scan_account(cursor, u32::try_from(seats).unwrap()),
        }
    }

    fn scan(&self, count: u16) -> core::result::Result<(), ProgramError> {
        run(
            vec![
                signer(self.admin),
                self.exchange.clone(),
                self.ledger.clone(),
                self.scan.clone(),
                at(EPHEMERAL_VAULT_ID),
                at(MAGIC_PROGRAM_ID),
            ],
            crate::instruction::ScanSeatLayout { count }.data(),
        )
    }

    fn activate(&self) -> core::result::Result<(), ProgramError> {
        run(
            vec![
                signer(self.admin),
                self.exchange.clone(),
                self.ledger.clone(),
                self.scan.clone(),
            ],
            crate::instruction::ActivateLayout {}.data(),
        )
    }

    fn layout(&self) -> u32 {
        let data = bytes_of(&self.exchange);
        Exchange::try_deserialize(&mut data.as_slice())
            .unwrap()
            .layout
    }
}

fn deployed_and_paused(admin: Pubkey) -> Exchange {
    paused(deployed_exchange(admin))
}

fn active_and_paused(admin: Pubkey) -> Exchange {
    paused(live_exchange(admin))
}

#[test]
fn the_scan_reads_the_ledger_in_ranges_and_activation_follows_the_last_one() {
    let migration = Migration::new(deployed_and_paused, MIN_SEATS, 0);
    migration.scan(1_000).unwrap();
    assert_eq!(cursor_of(&migration.scan), 1_000);
    migration.scan(1_000).unwrap();
    assert_eq!(cursor_of(&migration.scan), 2_000);
    assert_eq!(
        migration.activate(),
        refused_with(OrderbookError::LayoutScanIncomplete),
        "48 seats are still unread"
    );
    assert_eq!(migration.layout(), LAYOUT_V2);

    migration.scan(48).unwrap();
    assert_eq!(
        cursor_of(&migration.scan),
        u32::try_from(MIN_SEATS).unwrap()
    );
    migration.scan(5).unwrap();
    assert_eq!(
        cursor_of(&migration.scan),
        u32::try_from(MIN_SEATS).unwrap(),
        "past the end changes nothing"
    );

    migration.activate().unwrap();
    assert_eq!(migration.layout(), LAYOUT_V3);
}

#[test]
fn the_scan_names_the_magic_program_its_first_call_creates_the_account_through() {
    let metas = crate::accounts::ScanSeatLayout {
        admin: Pubkey::new_unique(),
        exchange: Pubkey::new_unique(),
        ledger: Pubkey::new_unique(),
        scan: Pubkey::new_unique(),
        vault: EPHEMERAL_VAULT_ID,
        magic_program: MAGIC_PROGRAM_ID,
    }
    .to_account_metas(None);
    let magic = metas
        .iter()
        .find(|meta| meta.pubkey == MAGIC_PROGRAM_ID)
        .expect("the scan's account list names the magic program");
    assert!(!magic.is_writable && !magic.is_signer);
    assert_eq!(metas.len(), 6);

    let migration = Migration::new(deployed_and_paused, MIN_SEATS, 0);
    let other_program = run(
        vec![
            signer(migration.admin),
            migration.exchange.clone(),
            migration.ledger.clone(),
            migration.scan.clone(),
            at(EPHEMERAL_VAULT_ID),
            at(Pubkey::new_unique()),
        ],
        crate::instruction::ScanSeatLayout { count: 10 }.data(),
    );
    assert_eq!(
        other_program,
        Err(ProgramError::Custom(
            anchor_lang::error::ErrorCode::ConstraintAddress.into()
        ))
    );
    assert_eq!(cursor_of(&migration.scan), 0);
}

#[test]
fn neither_migration_instruction_runs_once_the_layout_is_active() {
    let migration = Migration::new(active_and_paused, MIN_SEATS, 0);
    let before = bytes_of(&migration.exchange);
    assert_eq!(
        migration.scan(10),
        refused_with(OrderbookError::LayoutAlreadyActive)
    );
    assert_eq!(
        migration.activate(),
        refused_with(OrderbookError::LayoutAlreadyActive)
    );
    let done = Migration::new(
        active_and_paused,
        MIN_SEATS,
        u32::try_from(MIN_SEATS).unwrap(),
    );
    assert_eq!(
        done.activate(),
        refused_with(OrderbookError::LayoutAlreadyActive),
        "a finished scan is not a way to stamp it twice"
    );
    assert_eq!(bytes_of(&migration.exchange), before);
}

#[test]
fn the_migration_wants_a_paused_exchange_the_admin_and_a_scan_that_exists() {
    let running = Migration::new(deployed_exchange, MIN_SEATS, 0);
    assert_eq!(
        running.scan(10),
        refused_with(OrderbookError::ExchangeNotPaused)
    );
    assert_eq!(
        running.activate(),
        refused_with(OrderbookError::ExchangeNotPaused)
    );

    let mut stranger = Migration::new(deployed_and_paused, MIN_SEATS, 0);
    stranger.admin = Pubkey::new_unique();
    assert_eq!(stranger.scan(10), refused_with(OrderbookError::NotAdmin));
    assert_eq!(stranger.activate(), refused_with(OrderbookError::NotAdmin));

    let migration = Migration::new(deployed_and_paused, MIN_SEATS, 0);
    assert_eq!(
        migration.scan(0),
        refused_with(OrderbookError::InvalidSettings)
    );
    assert_eq!(cursor_of(&migration.scan), 0);

    let never_scanned = Migration {
        scan: at(Pubkey::find_program_address(&[SCAN_SEED], &crate::ID).0),
        ..Migration::new(deployed_and_paused, MIN_SEATS, 0)
    };
    assert_eq!(
        never_scanned.activate(),
        refused_with(OrderbookError::LayoutScanIncomplete)
    );
    assert_eq!(never_scanned.layout(), LAYOUT_V2);
}

#[test]
fn a_scan_that_started_before_the_ledger_grew_reads_the_new_seats_too() {
    let grown = MIN_SEATS + 33;
    let migration = Migration {
        scan: scan_account(
            u32::try_from(MIN_SEATS).unwrap(),
            u32::try_from(MIN_SEATS).unwrap(),
        ),
        ..Migration::new(deployed_and_paused, grown, 0)
    };
    assert_eq!(
        migration.activate(),
        refused_with(OrderbookError::LayoutScanIncomplete),
        "the scan has not read the new seats"
    );
    migration.scan(100).unwrap();
    assert_eq!(cursor_of(&migration.scan), u32::try_from(grown).unwrap());
    migration.activate().unwrap();
    assert_eq!(migration.layout(), LAYOUT_V3);
}

/// The 18 bytes of a seat the earlier build left zero and this build gives a meaning.
fn reused_offsets() -> Vec<usize> {
    (113..=119)
        .chain(121..=127)
        .chain([298, 299, 302, 303])
        .collect()
}

fn poke(migration: &Migration, seat: usize, offset: usize, value: u8) {
    write(
        &migration.ledger,
        LEDGER_PREFIX + seat * SEAT_LEN + offset,
        &[value],
    );
}

#[test]
fn a_nonzero_byte_at_any_of_the_eighteen_offsets_stops_the_scan_and_it_does_not_advance() {
    let offsets = reused_offsets();
    assert_eq!(offsets.len(), 18);
    let seats = [0, 1, 2, 777, MIN_SEATS - 1];
    for (at, offset) in offsets.iter().copied().enumerate() {
        let seat = seats[at % seats.len()];
        let migration = Migration::new(deployed_and_paused, MIN_SEATS, 0);
        poke(&migration, seat, offset, 1);
        let ledger = bytes_of(&migration.ledger);
        let exchange = bytes_of(&migration.exchange);

        assert_eq!(
            migration.scan(u16::try_from(MIN_SEATS).unwrap()),
            refused_with(OrderbookError::SeatLayoutUnexpected),
            "offset {offset} of seat {seat}"
        );

        assert_eq!(cursor_of(&migration.scan), 0, "offset {offset}");
        assert_eq!(
            bytes_of(&migration.ledger),
            ledger,
            "the scan rewrites nothing"
        );
        assert_eq!(bytes_of(&migration.exchange), exchange);
        assert_eq!(
            migration.activate(),
            refused_with(OrderbookError::LayoutScanIncomplete)
        );
    }
}

#[test]
fn the_scan_checks_the_seats_of_its_range_and_the_masks_may_hold_anything() {
    let migration = Migration::new(deployed_and_paused, MIN_SEATS, 0);
    poke(&migration, 500, 120, 0xFF);
    poke(&migration, 5, 112, 0xFF);
    poke(&migration, 1_500, 124, 9);

    migration.scan(1_000).unwrap();
    assert_eq!(
        cursor_of(&migration.scan),
        1_000,
        "seat 1500 is out of range"
    );
    assert_eq!(
        migration.scan(1_048),
        refused_with(OrderbookError::SeatLayoutUnexpected)
    );
    assert_eq!(cursor_of(&migration.scan), 1_000, "it does not advance");

    poke(&migration, 1_500, 124, 0);
    migration.scan(1_048).unwrap();
    assert_eq!(
        cursor_of(&migration.scan),
        u32::try_from(MIN_SEATS).unwrap()
    );
}

#[test]
fn a_seventh_perp_market_is_refused_and_the_sixth_is_not() {
    assert_eq!(MAX_PERP_MARKETS, 6);
    let with = |markets: u32| -> u8 { u8::try_from((1u32 << markets) - 1).unwrap() };
    for existing in 0..MAX_PERP_MARKETS {
        assert!(
            require_perp_room(with(existing)).is_ok(),
            "{existing} exist"
        );
    }
    assert_eq!(
        require_perp_room(with(6)).unwrap_err(),
        error!(OrderbookError::TooManyPerpMarkets),
        "a seventh"
    );
    assert_eq!(
        require_perp_room(with(7)).unwrap_err(),
        error!(OrderbookError::TooManyPerpMarkets)
    );
    assert!(
        require_perp_room(0b0111_1110).is_err(),
        "six markets, whatever their ids"
    );
    assert!(
        require_perp_room(0b1000_0000).is_ok(),
        "the count is of markets, not of the highest id"
    );
}

/// The first eight bytes the program dispatches an instruction by: Anchor's hash of
/// `global:<name>`.
fn discriminator(name: &str) -> [u8; 8] {
    let hash = sha256(format!("global:{name}").as_bytes());
    hash[..8].try_into().unwrap()
}

fn not_found() -> core::result::Result<(), ProgramError> {
    Err(ProgramError::Custom(
        anchor_lang::error::ErrorCode::InstructionFallbackNotFound.into(),
    ))
}

#[test]
fn the_discriminators_the_program_dispatches_are_anchors_hash_of_the_name() {
    assert_eq!(
        crate::instruction::SetPriceSourceV2::DISCRIMINATOR,
        discriminator("set_price_source_v2")
    );
    assert_eq!(
        crate::instruction::SetQuoteSourceV2::DISCRIMINATOR,
        discriminator("set_quote_source_v2")
    );
    assert_eq!(
        crate::instruction::UpdateMarketV2::DISCRIMINATOR,
        discriminator("update_market_v2")
    );
    assert_eq!(
        crate::instruction::CreateMarketV2::DISCRIMINATOR,
        discriminator("create_market_v2")
    );
}

#[test]
fn a_call_the_earlier_build_understood_does_not_reach_a_handler_here() {
    let chain = Chain::new(live_exchange);
    let before = chain.snapshot();

    let mut old_set_price_source = discriminator("set_price_source").to_vec();
    old_set_price_source.push(0);
    old_set_price_source.extend_from_slice(&[0x11; 32]);
    old_set_price_source.extend_from_slice(&(-8i32).to_le_bytes());
    assert_eq!(
        run(chain.rebind(), old_set_price_source.clone()),
        not_found(),
        "a valid old payload with its old arguments"
    );
    assert_eq!(run(vec![], old_set_price_source), not_found());

    let mut old_set_quote_source = discriminator("set_quote_source").to_vec();
    old_set_quote_source.extend_from_slice(&[0x22; 32]);
    old_set_quote_source.extend_from_slice(&(-8i32).to_le_bytes());
    old_set_quote_source.extend_from_slice(&100u16.to_le_bytes());
    old_set_quote_source.extend_from_slice(&100u16.to_le_bytes());
    old_set_quote_source.extend_from_slice(&180i64.to_le_bytes());
    assert_eq!(run(chain.quote(), old_set_quote_source), not_found());

    let mut old_update_market = discriminator("update_market").to_vec();
    old_update_market.push(0);
    old_update_market.extend_from_slice(&[0; 150]);
    assert_eq!(
        run(
            vec![
                signer(chain.admin),
                chain.exchange.clone(),
                chain.market.clone()
            ],
            old_update_market
        ),
        not_found()
    );

    assert_eq!(chain.snapshot(), before);
}

#[test]
fn the_new_names_reach_their_handlers() {
    let chain = Chain::new(deployed_exchange);
    assert_eq!(
        run(
            vec![
                signer(chain.admin),
                chain.exchange.clone(),
                chain.market.clone()
            ],
            crate::instruction::UpdateMarketV2 {
                market_id: 0,
                limits: limits(),
            }
            .data()
        ),
        refused_with(OrderbookError::LayoutNotActive)
    );
}

fn limits() -> MarketLimits {
    MarketLimits {
        min_size: 1,
        min_notional: 1,
        band_bps: 400,
        im_bps: 1_000,
        mm_bps: 500,
        taker_fee_bps: 5,
        liq_penalty_bps: 200,
        funding_cap_bps: 50,
        max_move_bps: 250,
        max_open_orders: 32,
        max_price_age: 10,
        funding_interval: 60,
        min_publish_gap: 1,
        open_interest_cap: 10_000_000,
        liq_buffer_bps: 100,
        liq_insurance_share_bps: 5_000,
        fee_insurance_share_bps: 5_000,
        settle_window: 900,
        position_cap: 2_000_000,
    }
}

fn settings(kind: u8, capacity: u16) -> MarketSettings {
    MarketSettings {
        kind,
        base_symbol: *b"SOL\0\0\0\0\0",
        quote_symbol: *b"USDC\0\0\0\0",
        base_token: 1,
        quote_token: 0,
        tick: 10,
        base_lot: 1,
        capacity,
        limits: limits(),
        price_source: PriceSourceSettings {
            feed: 6,
            base_decimals: 9,
            quote_decimals: 6,
        },
    }
}

/// The accounts `create_market_v2` names for market `market_id`, with the exchange the
/// given one.
fn create_market_accounts(
    admin: Pubkey,
    exchange: AccountInfo<'static>,
    market_id: u8,
) -> Vec<AccountInfo<'static>> {
    let book = market_stamped::<BookData>(market_id, HEADER_LEN);
    let permission = Pubkey::find_program_address(
        &[PERMISSION_SEED, book.key.as_ref()],
        &PERMISSION_PROGRAM_ID,
    )
    .0;
    vec![
        signer(admin),
        exchange,
        market_stamped::<MarketData>(market_id, HEADER_LEN),
        book,
        market_stamped::<TapeData>(market_id, HEADER_LEN),
        market_stamped::<PriceData>(market_id, HEADER_LEN),
        at(permission),
        at(PERMISSION_PROGRAM_ID),
        at(EPHEMERAL_VAULT_ID),
        at(MAGIC_PROGRAM_ID),
    ]
}

fn create_market_call(
    perp_markets: u8,
    kind: u8,
    capacity: u16,
) -> core::result::Result<(), ProgramError> {
    let admin = Pubkey::new_unique();
    let exchange = exchange_account(Exchange {
        perp_markets,
        ..live_exchange(admin)
    });
    run(
        create_market_accounts(admin, exchange, 7),
        crate::instruction::CreateMarketV2 {
            market_id: 7,
            settings: settings(kind, capacity),
        }
        .data(),
    )
}

#[test]
fn a_seventh_perp_market_is_refused_when_it_is_created_and_a_spot_market_or_a_sixth_is_not() {
    let six = 0b0011_1111;
    assert_eq!(
        create_market_call(six, KIND_PERP, 8),
        refused_with(OrderbookError::TooManyPerpMarkets)
    );
    assert_eq!(
        create_market_call(0b1011_1111, KIND_PERP, 8),
        refused_with(OrderbookError::TooManyPerpMarkets)
    );
    // A capacity of zero is refused by the next check, so a call that gets past the
    // perp count stops there and nothing is created.
    let past_the_count = refused_with(OrderbookError::InvalidCapacity);
    assert_eq!(create_market_call(six, KIND_SPOT, 0), past_the_count);
    assert_eq!(
        create_market_call(0b0001_1111, KIND_PERP, 0),
        past_the_count
    );
    assert_eq!(create_market_call(0, KIND_PERP, 0), past_the_count);
}

#[test]
fn create_market_v2_waits_for_the_active_layout() {
    let admin = Pubkey::new_unique();
    let exchange = exchange_account(deployed_exchange(admin));
    assert_eq!(
        run(
            create_market_accounts(admin, exchange, 7),
            crate::instruction::CreateMarketV2 {
                market_id: 7,
                settings: settings(KIND_PERP, 8),
            }
            .data()
        ),
        refused_with(OrderbookError::LayoutNotActive)
    );
}

/// The `create_market` payload of the build now on mainnet: its `MarketLimits` ends in
/// the 8 byte liquidation age that this build dropped, and its price source is a 32 byte
/// feed id with an exponent and a confidence limit where this one has a feed number.
fn earlier_create_market_payload(market_id: u8) -> Vec<u8> {
    let mut data = discriminator("create_market").to_vec();
    data.push(market_id);
    data.push(KIND_SPOT);
    data.extend_from_slice(b"SOL\0\0\0\0\0");
    data.extend_from_slice(b"USDC\0\0\0\0");
    data.extend_from_slice(&[1, 0]);
    data.extend_from_slice(&10u64.to_le_bytes());
    data.extend_from_slice(&1u64.to_le_bytes());
    data.extend_from_slice(&8u16.to_le_bytes());
    let limits = limits();
    data.extend_from_slice(&limits.min_size.to_le_bytes());
    data.extend_from_slice(&limits.min_notional.to_le_bytes());
    for bps in [
        limits.band_bps,
        limits.im_bps,
        limits.mm_bps,
        limits.taker_fee_bps,
        limits.liq_penalty_bps,
        limits.funding_cap_bps,
        limits.max_move_bps,
        limits.max_open_orders,
    ] {
        data.extend_from_slice(&bps.to_le_bytes());
    }
    data.extend_from_slice(&limits.max_price_age.to_le_bytes());
    data.extend_from_slice(&limits.funding_interval.to_le_bytes());
    data.extend_from_slice(&limits.min_publish_gap.to_le_bytes());
    data.extend_from_slice(&60i64.to_le_bytes());
    data.extend_from_slice(&limits.open_interest_cap.to_le_bytes());
    for bps in [
        limits.liq_buffer_bps,
        limits.liq_insurance_share_bps,
        limits.fee_insurance_share_bps,
    ] {
        data.extend_from_slice(&bps.to_le_bytes());
    }
    data.extend_from_slice(&limits.settle_window.to_le_bytes());
    data.extend_from_slice(&limits.position_cap.to_le_bytes());
    data.extend_from_slice(&[0x11; 32]);
    data.extend_from_slice(&(-8i32).to_le_bytes());
    data.extend_from_slice(&100u16.to_le_bytes());
    data.extend_from_slice(&[9, 6]);
    data
}

#[test]
fn the_earlier_create_market_payload_does_not_reach_a_handler_here() {
    let admin = Pubkey::new_unique();
    let exchange = exchange_account(live_exchange(admin));
    let accounts = create_market_accounts(admin, exchange, 7);
    let before: Vec<Vec<u8>> = accounts.iter().map(bytes_of).collect();
    assert_eq!(
        discriminator("create_market_v2"),
        crate::instruction::CreateMarketV2::DISCRIMINATOR
    );
    assert_ne!(
        discriminator("create_market"),
        crate::instruction::CreateMarketV2::DISCRIMINATOR
    );
    assert_eq!(
        run(accounts.clone(), earlier_create_market_payload(7)),
        not_found()
    );
    assert_eq!(run(vec![], earlier_create_market_payload(7)), not_found());
    let after: Vec<Vec<u8>> = accounts.iter().map(bytes_of).collect();
    assert_eq!(after, before);
}

fn resume_accounts(chain: &Chain) -> Vec<AccountInfo<'static>> {
    vec![
        signer(chain.admin),
        chain.exchange.clone(),
        chain.market.clone(),
    ]
}

fn resume_call() -> Vec<u8> {
    crate::instruction::ResumeMarket { market_id: 0 }.data()
}

fn clear_reserved(chain: &Chain) {
    let at = HEADER_LEN
        + std::mem::offset_of!(MarketData, params)
        + std::mem::offset_of!(MarketParams, _reserved);
    write(&chain.market, at, &[0; 8]);
}

fn status_of(chain: &Chain) -> u8 {
    let bytes = bytes_of(&chain.market);
    let body = &bytes[HEADER_LEN..HEADER_LEN + std::mem::size_of::<MarketData>()];
    bytemuck::pod_read_unaligned::<MarketData>(body)
        .params
        .status
}

#[test]
fn a_market_that_still_holds_the_earlier_builds_liquidation_age_is_not_resumed() {
    for exchange in [deployed_exchange, live_exchange] {
        let chain = Chain::new(exchange);
        assert_eq!(status_of(&chain), STATUS_PAUSED);
        let before = chain.snapshot();
        assert_eq!(
            run(resume_accounts(&chain), resume_call()),
            refused_with(OrderbookError::MarketNotRebound)
        );
        assert_eq!(chain.snapshot(), before, "a refusal writes nothing");
    }
}

#[test]
fn a_market_whose_reserved_bytes_are_clear_is_resumed() {
    let chain = Chain::new(live_exchange);
    clear_reserved(&chain);
    run(resume_accounts(&chain), resume_call()).unwrap();
    assert_eq!(status_of(&chain), STATUS_ACTIVE);
}

fn grow_call(chain: &Chain, kind: u8) -> core::result::Result<(), ProgramError> {
    run(
        vec![
            signer(chain.admin),
            chain.exchange.clone(),
            at(Pubkey::new_unique()),
            at(EPHEMERAL_VAULT_ID),
            at(MAGIC_PROGRAM_ID),
        ],
        crate::instruction::GrowAccount {
            kind,
            market_id: 0,
            new_len: 1,
        }
        .data(),
    )
}

#[test]
fn growing_an_account_before_activation_is_allowed_for_a_trigger_book_only() {
    use crate::instructions::setup::{GROW_BOOK, GROW_LEDGER, GROW_TAPE, GROW_TRIGGERS};

    let before = Chain::new(deployed_exchange);
    for kind in [GROW_LEDGER, GROW_BOOK, GROW_TAPE, 9] {
        assert_eq!(
            grow_call(&before, kind),
            refused_with(OrderbookError::LayoutNotActive),
            "kind {kind}"
        );
    }
    assert_ne!(
        grow_call(&before, GROW_TRIGGERS),
        refused_with(OrderbookError::LayoutNotActive),
        "a trigger book is a new account, so it grows before activation"
    );

    let active = Chain::new(live_exchange);
    for kind in [GROW_LEDGER, GROW_BOOK, GROW_TAPE, GROW_TRIGGERS] {
        assert_ne!(
            grow_call(&active, kind),
            refused_with(OrderbookError::LayoutNotActive),
            "kind {kind}"
        );
    }
}

#[test]
fn the_earlier_two_account_key_reset_is_refused_and_writes_nothing() {
    let chain = Chain::new(live_exchange);
    let before = chain.snapshot();
    let old_accounts = vec![signer(chain.owner), chain.view.clone()];
    assert_eq!(
        run(
            old_accounts,
            crate::instruction::SetOrderKeys {
                order_keys: new_keys()
            }
            .data()
        ),
        Err(ProgramError::Custom(
            anchor_lang::error::ErrorCode::AccountNotEnoughKeys.into()
        ))
    );
    assert_eq!(chain.snapshot(), before);
}

#[test]
fn the_account_list_of_a_key_reset_names_the_exchange_and_a_writable_ledger() {
    let metas = crate::accounts::OwnView {
        owner: Pubkey::new_unique(),
        view: Pubkey::new_unique(),
        exchange: Pubkey::new_unique(),
        ledger: Pubkey::new_unique(),
    }
    .to_account_metas(None);
    assert_eq!(metas.len(), 4);
    assert!(metas[1].is_writable, "the view");
    assert!(!metas[2].is_writable, "the exchange is read");
    assert!(metas[3].is_writable, "the ledger");
}

#[test]
fn the_renamed_instructions_wait_for_the_active_layout() {
    for renamed in [
        "set_price_source_v2",
        "set_quote_source_v2",
        "update_market_v2",
        "create_market_v2",
    ] {
        let gate = INSTRUCTION_GATES
            .iter()
            .find(|(name, _)| *name == renamed)
            .map(|(_, gate)| *gate);
        assert_eq!(gate, Some(crate::layout::Gate::ActiveOnly), "{renamed}");
    }
}

/// Scanning proves every seat clean at the moment it is read, and activation only
/// compares the scan's cursor with the ledger's length: it does not read the seats
/// again. This pins that accepted boundary. The scan's meaning rests on no instruction
/// that runs before activation writing the ledger (see the next test), not on a second
/// read, so a byte changed after its seat was scanned goes unnoticed. If activation
/// ever re-reads seats this test is the one to change on purpose.
#[test]
fn activation_does_not_read_seats_again_so_a_byte_changed_after_its_scan_goes_unnoticed() {
    let seats = [0usize, 1, 2, 777, MIN_SEATS - 1, 9, 44, 555, 1_111];
    for (at, offset) in reused_offsets().iter().copied().enumerate() {
        let seat = seats[at % seats.len()];
        let migration = Migration::new(deployed_and_paused, MIN_SEATS, 0);
        migration.scan(u16::try_from(MIN_SEATS).unwrap()).unwrap();
        assert_eq!(
            cursor_of(&migration.scan),
            u32::try_from(MIN_SEATS).unwrap()
        );
        poke(&migration, seat, offset, 0x5A);
        let changed = bytes_of(&migration.ledger);

        migration.activate().unwrap();

        assert_eq!(
            migration.layout(),
            LAYOUT_V3,
            "offset {offset} of seat {seat}"
        );
        assert_eq!(
            bytes_of(&migration.ledger),
            changed,
            "activation writes no seat byte and checks none"
        );
    }
}

/// The rows of the gate table that run before activation.
fn both_rows() -> Vec<&'static str> {
    INSTRUCTION_GATES
        .iter()
        .filter(|(_, gate)| *gate == crate::layout::Gate::Both)
        .map(|(name, _)| *name)
        .collect()
}

/// Everything in `before` and `after` is equal except the one byte at `at`, which differs.
fn only_this_byte_moved(before: &[u8], after: &[u8], at: usize, what: &str) {
    assert_eq!(before.len(), after.len(), "{what}");
    assert_eq!(
        before[..at],
        after[..at],
        "{what}: nothing before the byte moved"
    );
    assert_eq!(
        before[at + 1..],
        after[at + 1..],
        "{what}: nothing after the byte moved"
    );
    assert_ne!(before[at], after[at], "{what}: the byte itself moved");
}

/// The trusted boundary of the migration: the scan reads each seat once, so every
/// instruction that runs before activation must leave the ledger alone. Each row of the
/// gate table that runs then either is executed here and shown to leave the ledger
/// byte-identical (a market's status byte is the only other thing the two market
/// instructions may move), or has an account list that names no ledger at all, pinned by
/// a struct literal that stops compiling when a ledger account is added and by the
/// account count. A new pre-activation row is in neither list, so this test fails until
/// someone has decided which it is.
#[test]
fn every_instruction_that_runs_before_activation_leaves_the_ledger_byte_identical() {
    let mut covered: Vec<&str> = Vec::new();
    let chain = Chain::new(deployed_and_paused);
    let ledger_before = bytes_of(&chain.ledger);
    let status_at = HEADER_LEN
        + core::mem::offset_of!(MarketData, params)
        + core::mem::offset_of!(MarketParams, status);

    run(
        vec![signer(chain.admin), chain.exchange.clone()],
        crate::instruction::SetPaused { paused: false }.data(),
    )
    .unwrap();
    run(
        vec![signer(chain.admin), chain.exchange.clone()],
        crate::instruction::SetPaused { paused: true }.data(),
    )
    .unwrap();
    assert_eq!(bytes_of(&chain.ledger), ledger_before, "set_paused");
    covered.push("set_paused");

    let nominee = Pubkey::new_unique();
    run(
        vec![signer(chain.admin), chain.exchange.clone()],
        crate::instruction::ProposeAdmin {
            nominee: Some(nominee),
        }
        .data(),
    )
    .unwrap();
    assert_eq!(bytes_of(&chain.ledger), ledger_before, "propose_admin");
    covered.push("propose_admin");

    run(
        vec![signer(nominee), chain.exchange.clone()],
        crate::instruction::AcceptAdmin {}.data(),
    )
    .unwrap();
    assert_eq!(bytes_of(&chain.ledger), ledger_before, "accept_admin");
    covered.push("accept_admin");

    run(vec![], crate::instruction::ExtendCompute {}.data()).unwrap();
    assert_eq!(bytes_of(&chain.ledger), ledger_before, "extend_compute");
    covered.push("extend_compute");

    let market_before = bytes_of(&chain.market);
    run(
        vec![
            signer(nominee),
            chain.exchange.clone(),
            chain.market.clone(),
        ],
        crate::instruction::RestrictMarket {
            market_id: 0,
            status: noirwire_orderbook_engine::STATUS_REDUCE_ONLY,
        }
        .data(),
    )
    .unwrap();
    assert_eq!(bytes_of(&chain.ledger), ledger_before, "restrict_market");
    let restricted = bytes_of(&chain.market);
    only_this_byte_moved(&market_before, &restricted, status_at, "restrict_market");
    covered.push("restrict_market");

    clear_reserved(&chain);
    let cleared = bytes_of(&chain.market);
    run(
        vec![
            signer(nominee),
            chain.exchange.clone(),
            chain.market.clone(),
        ],
        resume_call(),
    )
    .unwrap();
    assert_eq!(status_of(&chain), STATUS_ACTIVE);
    assert_eq!(bytes_of(&chain.ledger), ledger_before, "resume_market");
    only_this_byte_moved(
        &cleared,
        &bytes_of(&chain.market),
        status_at,
        "resume_market",
    );
    covered.push("resume_market");

    let key = Pubkey::new_unique;
    let ledger_free: [(&str, usize); 5] = [
        (
            "initialize_exchange",
            crate::accounts::InitializeExchange {
                admin: key(),
                exchange: key(),
                program: key(),
                program_data: key(),
                system_program: key(),
            }
            .to_account_metas(None)
            .len(),
        ),
        (
            "create_trigger_book",
            crate::accounts::CreateTriggerBook {
                admin: key(),
                exchange: key(),
                market: key(),
                triggers: key(),
                triggers_permission: key(),
                permission_program: key(),
                vault: key(),
                magic_program: key(),
            }
            .to_account_metas(None)
            .len(),
        ),
        (
            "finalize_trigger_book",
            crate::accounts::FinalizeTriggerBook {
                admin: key(),
                exchange: key(),
                market: key(),
                triggers: key(),
            }
            .to_account_metas(None)
            .len(),
        ),
        (
            "delegate_exchange",
            crate::accounts::DelegateExchange {
                admin: key(),
                buffer_exchange: key(),
                delegation_record_exchange: key(),
                delegation_metadata_exchange: key(),
                exchange: key(),
                owner_program: key(),
                delegation_program: key(),
                system_program: key(),
            }
            .to_account_metas(None)
            .len(),
        ),
        (
            "undelegate_exchange",
            crate::accounts::UndelegateExchange {
                admin: key(),
                exchange: key(),
                magic_context: key(),
                magic_program: key(),
            }
            .to_account_metas(None)
            .len(),
        ),
    ];
    assert_eq!(
        ledger_free,
        [
            ("initialize_exchange", 5),
            ("create_trigger_book", 8),
            ("finalize_trigger_book", 4),
            ("delegate_exchange", 8),
            ("undelegate_exchange", 4),
        ],
        "a ledger-free instruction gained an account: decide whether it is the ledger"
    );
    covered.extend(ledger_free.iter().map(|(name, _)| *name));

    let mut rows = both_rows();
    rows.sort_unstable();
    covered.sort_unstable();
    assert_eq!(
        covered, rows,
        "every pre-activation instruction is either run here or shown to name no ledger"
    );
}

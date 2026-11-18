//! RULES 9 and 9a from the outside, through the public API only: what `sync_price` and
//! `sync_quote` do with the account they are handed. Fixtures are built byte by byte as
//! `magicblock_oracle.rs` documents the layout.

use anchor_lang::prelude::*;
use noirwire_orderbook::errors::OrderbookError;
use noirwire_orderbook::instructions::{apply_quote, rebind, sync_observed};
use noirwire_orderbook::magicblock_oracle::{
    self, feed_account, ORACLE_ID, PRICE_UPDATE_DISCRIMINATOR, PRICE_UPDATE_LEN,
};
use noirwire_orderbook::state::{PriceData, QuoteGuard, QUOTE_DEPEGGED, QUOTE_HEALTHY};
use noirwire_orderbook_engine::{
    BookHeader, MarketParams, Price, SourceBinding, SourceRecord, KIND_PERP, ORACLE_DISLOCATED,
    ORACLE_HEALTHY, ORACLE_SETTLING, STATUS_ACTIVE, STATUS_PAUSED, STATUS_REDUCE_ONLY,
};

const SOL_FEED: u32 = 6;
const USDC_FEED: u32 = 7;
const NOW: i64 = 1_794_592_460;
const MAX_AGE: i64 = 90;

struct Stored {
    key: Pubkey,
    owner: Pubkey,
    lamports: u64,
    data: Vec<u8>,
}

impl Stored {
    fn info(&mut self) -> AccountInfo<'_> {
        let Stored {
            key,
            owner,
            lamports,
            data,
        } = self;
        AccountInfo::new(key, false, false, lamports, data, owner, false)
    }
}

/// The oracle's `PriceUpdateV3` for feed `number`, as it writes it: its feed id is its
/// own address, its exponent is stored as +8 and its confidence is zero.
fn oracle_account(number: u32, price: i64, publish_time: i64) -> Stored {
    let key = feed_account(number);
    let mut data = vec![0u8; PRICE_UPDATE_LEN];
    data[..8].copy_from_slice(&PRICE_UPDATE_DISCRIMINATOR);
    data[40] = 1;
    data[41..73].copy_from_slice(&key.to_bytes());
    data[73..81].copy_from_slice(&price.to_le_bytes());
    data[89..93].copy_from_slice(&8i32.to_le_bytes());
    data[93..101].copy_from_slice(&publish_time.to_le_bytes());
    Stored {
        key,
        owner: ORACLE_ID,
        lamports: 0,
        data,
    }
}

fn market() -> (PriceData, MarketParams) {
    let mut feed: PriceData = bytemuck::Zeroable::zeroed();
    feed.binding = SourceBinding {
        account: feed_account(SOL_FEED).to_bytes(),
        feed: SOL_FEED,
        expo: -8,
        base_decimals: 9,
        quote_decimals: 6,
        ..bytemuck::Zeroable::zeroed()
    };
    let params = MarketParams {
        tick: 100,
        base_lot: 1_000_000,
        min_size: 1,
        funding_interval: 60,
        max_price_age: MAX_AGE,
        open_interest_cap: 1_000,
        settle_window: 900,
        position_cap: 1_000,
        band_bps: 400,
        im_bps: 1_000,
        mm_bps: 500,
        taker_fee_bps: 5,
        liq_penalty_bps: 200,
        funding_cap_bps: 100,
        max_move_bps: 250,
        min_publish_gap: 1,
        max_open_orders: 32,
        kind: KIND_PERP,
        status: STATUS_ACTIVE,
        ..bytemuck::Zeroable::zeroed()
    };
    (feed, params)
}

fn live_market() -> (PriceData, MarketParams) {
    let (mut feed, params) = market();
    feed.price = Price {
        price: 80_000,
        publish_time: NOW - 60,
        accepted_at: NOW - 60,
    };
    feed.source = SourceRecord {
        raw_price: 8_000_000_000,
        publish_time: NOW - 60,
        target: 80_000,
        observed_at: NOW - 60,
        ..bytemuck::Zeroable::zeroed()
    };
    (feed, params)
}

fn refused(result: Result<()>, expected: OrderbookError) {
    assert_eq!(result.unwrap_err(), error!(expected));
}

#[test]
fn the_bound_account_moves_the_mark_within_the_limit() {
    let (mut feed, mut params) = live_market();
    let mut account = oracle_account(SOL_FEED, 8_100_000_000, NOW - 2);
    sync_observed(&account.info(), &mut feed, &mut params, NOW).unwrap();
    assert_eq!(feed.price.price, 81_000);
    assert_eq!(feed.price.publish_time, NOW - 2);
    assert_eq!(feed.source.raw_price, 8_100_000_000);
    assert_eq!(params.oracle_health, ORACLE_HEALTHY);
}

#[test]
fn a_price_beyond_the_limit_opens_an_incident_and_the_mark_stays() {
    let (mut feed, mut params) = live_market();
    let mut account = oracle_account(SOL_FEED, 8_800_000_000, NOW - 2);
    sync_observed(&account.info(), &mut feed, &mut params, NOW).unwrap();
    assert_eq!(feed.price.price, 80_000);
    assert_eq!(params.oracle_health, ORACLE_DISLOCATED);
}

#[test]
fn an_account_that_is_not_the_bound_one_is_refused_and_nothing_is_written() {
    let (mut feed, mut params) = live_market();
    let before = (feed, params);
    let mut other_feed = oracle_account(USDC_FEED, 8_100_000_000, NOW - 2);
    refused(
        sync_observed(&other_feed.info(), &mut feed, &mut params, NOW),
        OrderbookError::WrongPriceAccount,
    );
    let mut stranger = oracle_account(SOL_FEED, 8_100_000_000, NOW - 2);
    stranger.key = Pubkey::new_unique();
    refused(
        sync_observed(&stranger.info(), &mut feed, &mut params, NOW),
        OrderbookError::WrongPriceAccount,
    );
    assert_eq!((feed, params), before);
}

#[test]
fn an_account_the_oracle_program_does_not_own_is_refused_and_nothing_is_written() {
    let (mut feed, mut params) = live_market();
    let before = (feed, params);
    for owner in [Pubkey::new_unique(), anchor_lang::system_program::ID] {
        let mut forged = oracle_account(SOL_FEED, 9_000_000_000, NOW - 2);
        forged.owner = owner;
        refused(
            sync_observed(&forged.info(), &mut feed, &mut params, NOW),
            OrderbookError::WrongPriceAccountOwner,
        );
    }
    assert_eq!((feed, params), before);
}

#[test]
fn a_market_still_bound_to_an_old_account_refuses_the_oracles_account() {
    let (mut feed, mut params) = live_market();
    feed.binding.account = Pubkey::new_unique().to_bytes();
    let mut account = oracle_account(SOL_FEED, 8_100_000_000, NOW - 2);
    refused(
        sync_observed(&account.info(), &mut feed, &mut params, NOW),
        OrderbookError::WrongPriceAccount,
    );
}

#[test]
fn a_market_bound_to_nothing_reads_no_account() {
    let (mut feed, mut params) = live_market();
    feed.binding.account = [0; 32];
    let mut account = oracle_account(SOL_FEED, 8_100_000_000, NOW - 2);
    refused(
        sync_observed(&account.info(), &mut feed, &mut params, NOW),
        OrderbookError::WrongPriceAccount,
    );
}

#[test]
fn a_stale_account_is_refused_by_the_engine_and_writes_nothing() {
    let (mut feed, mut params) = live_market();
    let before = (feed, params);
    let mut account = oracle_account(SOL_FEED, 8_100_000_000, NOW - MAX_AGE - 1);
    refused(
        sync_observed(&account.info(), &mut feed, &mut params, NOW),
        OrderbookError::PriceTooOld,
    );
    assert_eq!((feed, params), before);
}

#[test]
fn a_first_mark_leaves_the_market_reduce_only() {
    let (mut feed, mut params) = market();
    let mut account = oracle_account(SOL_FEED, 8_000_000_000, NOW - 2);
    sync_observed(&account.info(), &mut feed, &mut params, NOW).unwrap();
    assert_eq!(feed.price.price, 80_000);
    assert_eq!(params.status, STATUS_REDUCE_ONLY);
}

#[test]
fn a_rebound_market_that_holds_positions_keeps_its_mark_and_a_far_price_opens_an_incident() {
    let (mut feed, mut params) = live_market();
    params.status = STATUS_PAUSED;
    let mut header: BookHeader = bytemuck::Zeroable::zeroed();
    header.open_interest = 3;
    let mark = feed.price;
    let mut binding = feed.binding;
    binding.account = feed_account(SOL_FEED).to_bytes();
    rebind(&mut params, &mut header, &mut feed, binding, NOW - 30);
    assert_eq!(feed.price, mark);
    assert_eq!(
        params.oracle_health, ORACLE_SETTLING,
        "no withdrawal and no resume before the new feed is read"
    );
    assert_eq!(
        feed.source,
        <SourceRecord as bytemuck::Zeroable>::zeroed(),
        "the old source's record is cleared"
    );

    let mut far = oracle_account(SOL_FEED, 12_000_000_000, NOW - 2);
    sync_observed(&far.info(), &mut feed, &mut params, NOW).unwrap();
    assert_eq!(feed.price, mark, "the mark does not jump");
    assert_eq!(params.oracle_health, ORACLE_DISLOCATED);
    assert_eq!(params.status, STATUS_PAUSED);

    let (mut feed, mut params) = live_market();
    rebind(&mut params, &mut header, &mut feed, binding, NOW - 30);
    let mut near = oracle_account(SOL_FEED, 8_100_000_000, NOW - 2);
    sync_observed(&near.info(), &mut feed, &mut params, NOW).unwrap();
    assert_eq!(feed.price.price, 81_000);
    assert_eq!(params.oracle_health, ORACLE_HEALTHY);
}

#[test]
fn a_settlement_window_that_is_running_survives_a_rebind() {
    let (mut feed, mut params) = live_market();
    params.oracle_health = ORACLE_SETTLING;
    feed.incident.settle_until = NOW + 500;
    let mut header: BookHeader = bytemuck::Zeroable::zeroed();
    header.open_interest = 3;
    let binding = feed.binding;
    rebind(&mut params, &mut header, &mut feed, binding, NOW);
    assert_eq!(feed.incident.settle_until, NOW + 500);

    let mut inside = oracle_account(SOL_FEED, 8_100_000_000, NOW + 100);
    sync_observed(&inside.info(), &mut feed, &mut params, NOW + 101).unwrap();
    assert_eq!(feed.price.price, 81_000);
    assert_eq!(params.oracle_health, ORACLE_SETTLING, "inside the window");

    let mut after = oracle_account(SOL_FEED, 8_150_000_000, NOW + 600);
    sync_observed(&after.info(), &mut feed, &mut params, NOW + 601).unwrap();
    assert_eq!(params.oracle_health, ORACLE_HEALTHY, "past the window");
}

fn usdc_guard() -> QuoteGuard {
    QuoteGuard {
        account: feed_account(USDC_FEED),
        feed: USDC_FEED,
        depeg_bps: 100,
        max_age: 180,
        ..QuoteGuard::unbound()
    }
}

#[test]
fn the_usdc_guard_passes_on_a_dollar_and_trips_on_a_depeg() {
    let mut guard = usdc_guard();
    let mut healthy = oracle_account(USDC_FEED, 99_990_000, NOW - 2);
    apply_quote(&mut guard, &healthy.info(), NOW).unwrap();
    assert_eq!(guard.state, QUOTE_HEALTHY);
    assert_eq!(guard.ok_until, NOW - 2 + 180);
    assert_eq!(guard.price, 99_990_000);
    assert!(guard.passes(NOW));

    let mut depegged = oracle_account(USDC_FEED, 95_000_000, NOW - 1);
    apply_quote(&mut guard, &depegged.info(), NOW).unwrap();
    assert_eq!(guard.state, QUOTE_DEPEGGED);
    assert!(!guard.passes(NOW));
}

#[test]
fn the_usdc_guard_refuses_any_account_but_its_own_and_one_the_oracle_does_not_own() {
    let mut guard = usdc_guard();
    let before = guard;
    let mut sol = oracle_account(SOL_FEED, 99_990_000, NOW - 2);
    refused(
        apply_quote(&mut guard, &sol.info(), NOW),
        OrderbookError::WrongPriceAccount,
    );
    let mut forged = oracle_account(USDC_FEED, 99_990_000, NOW - 2);
    forged.owner = Pubkey::new_unique();
    refused(
        apply_quote(&mut guard, &forged.info(), NOW),
        OrderbookError::WrongPriceAccountOwner,
    );
    let mut replay = oracle_account(USDC_FEED, 99_990_000, NOW - 2);
    guard.publish_time = NOW - 2;
    refused(
        apply_quote(&mut guard, &replay.info(), NOW),
        OrderbookError::PriceTimeWentBackwards,
    );
    assert_eq!(guard.state, before.state);
    assert_eq!(magicblock_oracle::STORED_DECIMALS, 8);
}

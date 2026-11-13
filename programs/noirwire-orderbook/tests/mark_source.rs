//! RULES 9b from the outside, through the public API only: what `sync_price` does with
//! the Pyth account and the primary account it is handed. Fixtures are built byte by
//! byte as `pyth.rs` and `magicblock_oracle.rs` document the two layouts.

use anchor_lang::prelude::*;
use noirwire_orderbook::errors::OrderbookError;
use noirwire_orderbook::instructions::{sync_observed, MarkSource};
use noirwire_orderbook::magicblock_oracle::{self, ORACLE_ID};
use noirwire_orderbook::pyth::{self, RECEIVER_ID};
use noirwire_orderbook_engine::{
    MarketParams, PriceFeed, SourceBinding, KIND_PERP, ORACLE_HEALTHY, STATUS_REDUCE_ONLY,
};

const PYTH_FEED: [u8; 32] = [7; 32];
const MARK_FEED: u32 = 6;
const BAND: u16 = 100;
const WINDOW: u16 = 10;
const NOW: i64 = 1_794_592_460;
const MAX_AGE: i64 = 90;

/// An account as the runtime hands it over: address, owning program and data.
struct Stored {
    key: Pubkey,
    owner: Pubkey,
    lamports: u64,
    data: Vec<u8>,
}

impl Stored {
    fn new(key: Pubkey, owner: Pubkey, data: Vec<u8>) -> Stored {
        Stored {
            key,
            owner,
            lamports: 0,
            data,
        }
    }

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

/// A fully verified Pyth `PriceUpdateV2` for `PYTH_FEED`, at the bound address.
fn pyth_account(price: i64, conf: u64, publish_time: i64) -> Stored {
    let mut data = vec![0u8; pyth::PRICE_UPDATE_LEN];
    data[..8].copy_from_slice(&pyth::PRICE_UPDATE_DISCRIMINATOR);
    data[40] = 1;
    data[41..73].copy_from_slice(&PYTH_FEED);
    data[73..81].copy_from_slice(&price.to_le_bytes());
    data[81..89].copy_from_slice(&conf.to_le_bytes());
    data[89..93].copy_from_slice(&(-8i32).to_le_bytes());
    data[93..101].copy_from_slice(&publish_time.to_le_bytes());
    Stored::new(pyth::feed_account(&PYTH_FEED), RECEIVER_ID, data)
}

/// MagicBlock's `PriceUpdateV3` for feed `number`, as the oracle writes it: its feed id
/// is its own address, its exponent is stored as +8 and its confidence is zero.
fn mark_account(number: u32, price: i64, publish_time: i64) -> Stored {
    let key = magicblock_oracle::feed_account(number);
    let mut data = vec![0u8; pyth::PRICE_UPDATE_LEN];
    data[..8].copy_from_slice(&magicblock_oracle::PRICE_UPDATE_DISCRIMINATOR);
    data[40] = 1;
    data[41..73].copy_from_slice(&key.to_bytes());
    data[73..81].copy_from_slice(&price.to_le_bytes());
    data[89..93].copy_from_slice(&8i32.to_le_bytes());
    data[93..101].copy_from_slice(&publish_time.to_le_bytes());
    Stored::new(key, ORACLE_ID, data)
}

fn market() -> (PriceFeed, MarketParams) {
    let mut feed: PriceFeed = bytemuck::Zeroable::zeroed();
    feed.binding = SourceBinding {
        account: pyth::feed_account(&PYTH_FEED).to_bytes(),
        feed_id: PYTH_FEED,
        expo: -8,
        max_conf_bps: 100,
        base_decimals: 9,
        quote_decimals: 6,
    };
    let params = MarketParams {
        tick: 100,
        base_lot: 1_000_000,
        min_size: 1,
        funding_interval: 60,
        max_price_age: MAX_AGE,
        max_age_liquidation: 180,
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
        ..bytemuck::Zeroable::zeroed()
    };
    (feed, params)
}

/// A market whose mark is 80,000 atoms per lot, taken from the source a minute ago.
fn live_market() -> (PriceFeed, MarketParams) {
    let (mut feed, params) = market();
    feed.price.price = 80_000;
    feed.price.publish_time = NOW - 60;
    feed.price.accepted_at = NOW - 60;
    feed.source.publish_time = NOW - 60;
    (feed, params)
}

/// `sync_price` with the market's primary price bound, and a check that a refusal wrote
/// nothing.
fn sync(
    pyth: &mut Stored,
    mark: &mut Stored,
    feed: &mut PriceFeed,
    params: &mut MarketParams,
) -> Result<()> {
    let (before_feed, before_params) = (*feed, *params);
    let source = MarkSource {
        feed: MARK_FEED,
        guard_bps: BAND,
        guard_window: WINDOW,
    };
    let result = sync_observed(&pyth.info(), &mark.info(), Some(source), feed, params, NOW);
    if result.is_err() {
        assert_eq!((*feed, *params), (before_feed, before_params), "it wrote");
    }
    result
}

fn refused(result: Result<()>, expected: OrderbookError) {
    assert_eq!(result.unwrap_err(), error!(expected));
}

#[test]
fn in_band_the_mark_moves_to_magicblocks_price_not_pyths() {
    let (mut feed, mut params) = live_market();
    let mut pyth = pyth_account(8_000_000_000, 2_000_000, NOW - 3);
    let mut mark = mark_account(MARK_FEED, 8_002_901_727, NOW - 1);
    sync(&mut pyth, &mut mark, &mut feed, &mut params).unwrap();
    assert_eq!(
        feed.price.price, 80_029,
        "MagicBlock's, where Pyth's is 80,000"
    );
    assert_eq!(feed.price.publish_time, NOW - 1);
    assert_eq!(feed.source.raw_price, 8_002_901_727);
    assert_eq!(feed.source.conf, 0);
    assert_eq!(params.oracle_health, ORACLE_HEALTHY);
}

#[test]
fn out_of_band_the_mark_is_frozen() {
    let (mut feed, mut params) = live_market();
    let mut pyth = pyth_account(7_500_000_000, 2_000_000, NOW - 1);
    let mut mark = mark_account(MARK_FEED, 8_002_901_727, NOW - 1);
    refused(
        sync(&mut pyth, &mut mark, &mut feed, &mut params),
        OrderbookError::GuardDisagrees,
    );
    assert_eq!(feed.price.price, 80_000);
    assert_eq!(feed.source.publish_time, NOW - 60);
    assert_eq!(params.oracle_health, ORACLE_HEALTHY, "no incident either");
}

#[test]
fn a_stale_magicblock_account_freezes_the_mark() {
    let (mut feed, mut params) = live_market();
    let mut pyth = pyth_account(8_000_000_000, 2_000_000, NOW - 5);
    let mut mark = mark_account(MARK_FEED, 8_002_901_727, NOW - MAX_AGE - 1);
    refused(
        sync(&mut pyth, &mut mark, &mut feed, &mut params),
        OrderbookError::PriceTooOld,
    );
    assert_eq!(feed.price.price, 80_000);
}

#[test]
fn a_stale_or_wide_pyth_guard_is_no_evidence_and_the_primary_moves_the_mark_within_the_limit() {
    let mut mark = mark_account(MARK_FEED, 8_002_901_727, NOW - 1);
    let mut rogue = mark_account(MARK_FEED, 9_000_000_000, NOW - 1);
    let stale = |age| pyth_account(7_500_000_000, 2_000_000, NOW - age);
    let wide = || pyth_account(7_500_000_000, 80_000_001, NOW - 1);
    for (name, guard) in [
        ("stale", stale(i64::from(WINDOW) + 1)),
        ("very stale", stale(MAX_AGE + 1)),
        ("wide", wide()),
    ] {
        let (mut feed, mut params) = live_market();
        let mut guard_a = Stored::new(guard.key, guard.owner, guard.data.clone());
        sync(&mut guard_a, &mut mark, &mut feed, &mut params).unwrap();
        assert_eq!(
            feed.price.price, 80_029,
            "{name}: followed within the limit"
        );
        let (mut feed, mut params) = live_market();
        let mut guard_b = Stored::new(guard.key, guard.owner, guard.data);
        refused(
            sync(&mut guard_b, &mut rogue, &mut feed, &mut params),
            OrderbookError::UnguardedMoveTooLarge,
        );
        assert_eq!(feed.price.price, 80_000, "{name}: a 12% jump is frozen");
        assert_eq!(params.oracle_health, ORACLE_HEALTHY, "{name}: no incident");
    }
}

#[test]
fn a_crash_pyth_has_not_yet_pushed_is_followed_not_frozen() {
    let (mut feed, mut params) = live_market();
    let mut pyth = pyth_account(8_000_000_000, 2_000_000, NOW - 5);
    let mut mark = mark_account(MARK_FEED, 7_800_000_000, NOW - 1);
    let (before_mark, before_time) = (feed.price.price, feed.price.publish_time);
    let result = sync(&mut pyth, &mut mark, &mut feed, &mut params);
    result.unwrap();
    assert!(feed.price.price < before_mark, "the mark fell with it");
    assert_ne!(feed.price.publish_time, before_time);
}

#[test]
fn a_market_with_no_primary_price_follows_pyth_and_never_reads_the_last_account() {
    let (mut feed, mut params) = live_market();
    let mut pyth = pyth_account(8_010_000_000, 2_000_000, NOW - 5);
    let mut unread = Stored::new(Pubkey::new_unique(), Pubkey::new_unique(), vec![0xff; 3]);
    sync_observed(
        &pyth.info(),
        &unread.info(),
        None,
        &mut feed,
        &mut params,
        NOW,
    )
    .unwrap();
    assert_eq!(feed.price.price, 80_100, "Pyth's price, taken as before");
    assert_eq!(feed.source.conf, 2_000_000);
}

#[test]
fn a_market_with_a_primary_price_refuses_a_last_account_that_is_not_the_bound_one() {
    let (mut feed, mut params) = live_market();
    let mut pyth = pyth_account(8_000_000_000, 2_000_000, NOW - 5);

    let mut other_feed = mark_account(7, 8_002_901_727, NOW - 1);
    refused(
        sync(&mut pyth, &mut other_feed, &mut feed, &mut params),
        OrderbookError::WrongPriceAccount,
    );

    let mut not_the_oracles = mark_account(MARK_FEED, 8_002_901_727, NOW - 1);
    not_the_oracles.owner = Pubkey::new_unique();
    refused(
        sync(&mut pyth, &mut not_the_oracles, &mut feed, &mut params),
        OrderbookError::WrongPriceAccountOwner,
    );

    let mut pyth_owned = mark_account(MARK_FEED, 8_002_901_727, NOW - 1);
    pyth_owned.owner = RECEIVER_ID;
    refused(
        sync(&mut pyth, &mut pyth_owned, &mut feed, &mut params),
        OrderbookError::WrongPriceAccountOwner,
    );

    let mut guard_as_primary = pyth_account(8_000_000_000, 2_000_000, NOW - 5);
    refused(
        sync(&mut pyth, &mut guard_as_primary, &mut feed, &mut params),
        OrderbookError::WrongPriceAccount,
    );
    assert_eq!(feed.price.price, 80_000);
}

#[test]
fn the_primary_cannot_stand_in_for_the_guard() {
    let (mut feed, mut params) = live_market();
    let mut mark = mark_account(MARK_FEED, 8_002_901_727, NOW - 1);
    let mut again = mark_account(MARK_FEED, 8_002_901_727, NOW - 1);
    refused(
        sync(&mut mark, &mut again, &mut feed, &mut params),
        OrderbookError::WrongPriceAccount,
    );
}

#[test]
fn only_a_binding_of_exponent_minus_eight_reads_the_primary() {
    let (mut feed, mut params) = live_market();
    feed.binding.expo = -9;
    let mut pyth = pyth_account(8_000_000_000, 2_000_000, NOW - 5);
    pyth.data[89..93].copy_from_slice(&(-9i32).to_le_bytes());
    let mut mark = mark_account(MARK_FEED, 8_002_901_727, NOW - 1);
    refused(
        sync(&mut pyth, &mut mark, &mut feed, &mut params),
        OrderbookError::WrongPriceExponent,
    );
}

#[test]
fn a_first_mark_needs_both_and_leaves_the_market_reduce_only() {
    let (mut feed, mut params) = market();
    let mut pyth = pyth_account(8_000_000_000, 2_000_000, NOW - 1);
    let mut far = mark_account(MARK_FEED, 8_500_000_000, NOW - 1);
    refused(
        sync(&mut pyth, &mut far, &mut feed, &mut params),
        OrderbookError::GuardDisagrees,
    );
    let mut stale = pyth_account(8_000_000_000, 2_000_000, NOW - 30);
    let mut agreeing = mark_account(MARK_FEED, 8_002_901_727, NOW - 1);
    refused(
        sync(&mut stale, &mut agreeing, &mut feed, &mut params),
        OrderbookError::UnguardedMoveTooLarge,
    );
    assert_eq!(feed.price.price, 0);
    let mut mark = mark_account(MARK_FEED, 8_002_901_727, NOW - 1);
    sync(&mut pyth, &mut mark, &mut feed, &mut params).unwrap();
    assert_eq!(feed.price.price, 80_029);
    assert_eq!(params.status, STATUS_REDUCE_ONLY);
}

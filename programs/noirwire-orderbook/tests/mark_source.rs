//! RULES 9b from the outside, through the public API only: what `sync_price` does with
//! the Pyth account and the primary account it is handed. Fixtures are built byte by
//! byte as `pyth.rs` and `magicblock_oracle.rs` document the two layouts.

use anchor_lang::prelude::*;
use noirwire_orderbook::errors::OrderbookError;
use noirwire_orderbook::instructions::{sync_observed, MarkSource};
use noirwire_orderbook::magicblock_oracle::{self, ORACLE_ID};
use noirwire_orderbook::market::gate_of;
use noirwire_orderbook::pyth::{self, RECEIVER_ID};
use noirwire_orderbook::state::MarketData;
use noirwire_orderbook_engine::{
    GuardedSync, MarketParams, PriceFeed, SourceBinding, SourceRecord, KIND_PERP, ORACLE_HEALTHY,
    STATUS_REDUCE_ONLY,
};

const PYTH_FEED: [u8; 32] = [7; 32];
const MARK_FEED: u32 = 6;
const BREAKER_BPS: u16 = 400;
const BREAKER_AGE: u8 = 90;
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

    fn copy(&self) -> Stored {
        Stored::new(self.key, self.owner, self.data.clone())
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

/// A market whose mark is 80,000 atoms per lot, taken a minute ago, and whose last Pyth
/// observation, 80,000 too, is as old.
fn live_market() -> (PriceFeed, MarketParams) {
    let (mut feed, params) = market();
    feed.price.price = 80_000;
    feed.price.publish_time = NOW - 60;
    feed.price.accepted_at = NOW - 60;
    feed.source = SourceRecord {
        raw_price: 8_000_000_000,
        conf: 0,
        publish_time: NOW - 60,
        target: 80_000,
        observed_at: NOW - 60,
    };
    (feed, params)
}

/// The same, with the last Pyth observation `age` seconds old at `NOW`.
fn live_market_pyth_aged(age: i64) -> (PriceFeed, MarketParams) {
    let (mut feed, params) = live_market();
    feed.source.publish_time = NOW - age;
    (feed, params)
}

fn source() -> MarkSource {
    MarkSource {
        feed: MARK_FEED,
        breaker_bps: BREAKER_BPS,
        breaker_age: BREAKER_AGE,
    }
}

/// `sync_price` at `now` with the market's primary price bound, and a check that a
/// refusal wrote nothing.
fn sync_at(
    now: i64,
    pyth: &mut Stored,
    mark: Option<&mut Stored>,
    feed: &mut PriceFeed,
    params: &mut MarketParams,
) -> Result<GuardedSync> {
    let (before_feed, before_params) = (*feed, *params);
    let mark_info = mark.map(|stored| stored.info());
    let result = sync_observed(
        &pyth.info(),
        mark_info.as_ref(),
        Some(source()),
        feed,
        params,
        now,
    );
    if result.is_err() {
        assert_eq!((*feed, *params), (before_feed, before_params), "it wrote");
    }
    result
}

fn sync(
    pyth: &mut Stored,
    mark: &mut Stored,
    feed: &mut PriceFeed,
    params: &mut MarketParams,
) -> Result<GuardedSync> {
    sync_at(NOW, pyth, Some(mark), feed, params)
}

fn refused(result: Result<GuardedSync>, expected: OrderbookError) {
    assert_eq!(result.unwrap_err(), error!(expected));
}

/// A trip is a success that moved no mark and opened nothing: it keeps only Pyth's
/// newer observation.
fn tripped(result: Result<GuardedSync>) {
    assert_eq!(result.unwrap(), GuardedSync::BreakerTripped);
}

fn unreadable_pyth_accounts() -> Vec<(&'static str, Stored)> {
    let good = || pyth_account(8_000_000_000, 2_000_000, NOW - 1);
    let mut wrong_owner = good();
    wrong_owner.owner = Pubkey::new_unique();
    let mut wrong_size = good();
    wrong_size.data.push(0);
    let mut wrong_kind = good();
    wrong_kind.data[0] ^= 1;
    let mut wrong_feed = good();
    wrong_feed.data[41] ^= 1;
    let mut wrong_expo = good();
    wrong_expo.data[89..93].copy_from_slice(&(-9i32).to_le_bytes());
    let mut partial = good();
    partial.data[40] = 0;
    let missing = Stored::new(good().key, Pubkey::default(), vec![]);
    vec![
        ("wrong owner", wrong_owner),
        ("wrong size", wrong_size),
        ("wrong discriminator", wrong_kind),
        ("wrong feed", wrong_feed),
        ("wrong exponent", wrong_expo),
        ("not fully verified", partial),
        ("missing", missing),
    ]
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
    assert_eq!(feed.source.raw_price, 8_000_000_000, "Pyth's is kept");
    assert_eq!(feed.source.publish_time, NOW - 3);
    assert_eq!(feed.source.conf, 2_000_000);
    assert_eq!(params.oracle_health, ORACLE_HEALTHY);
}

#[test]
fn past_the_breaker_the_mark_is_frozen() {
    let (mut feed, mut params) = live_market();
    let mut pyth = pyth_account(7_500_000_000, 2_000_000, NOW - 1);
    let mut mark = mark_account(MARK_FEED, 8_002_901_727, NOW - 1);
    tripped(sync(&mut pyth, &mut mark, &mut feed, &mut params));
    assert_eq!(feed.price.price, 80_000);
    assert_eq!(feed.price.publish_time, NOW - 60, "the mark did not move");
    assert_eq!(
        feed.source.publish_time,
        NOW - 1,
        "Pyth's newer print is kept"
    );
    assert_eq!(feed.source.raw_price, 7_500_000_000);
    assert_eq!(params.oracle_health, ORACLE_HEALTHY, "no incident either");
}

/// A market whose mark is a primary price, bound to feed 6 with the mainnet profile.
fn bound_market() -> MarketData {
    let mut market: MarketData = bytemuck::Zeroable::zeroed();
    market.mark_feed = u16::try_from(MARK_FEED).unwrap();
    market.breaker_bps = BREAKER_BPS;
    market.breaker_age = BREAKER_AGE;
    market.liquidation_band = 150;
    market
}

#[test]
fn the_p0_sequence_across_two_syncs_a_refused_print_stops_liquidation_at_once() {
    let (mut feed, mut params) = live_market();
    let market = bound_market();
    let mut agreeing = pyth_account(8_000_000_000, 2_000_000, NOW - 5);
    let mut mark = mark_account(MARK_FEED, 8_002_901_727, NOW - 4);
    sync_at(
        NOW - 4,
        &mut agreeing,
        Some(&mut mark),
        &mut feed,
        &mut params,
    )
    .unwrap();
    let confirmed = gate_of(&market, &feed).unwrap();
    assert!(
        confirmed.confirms(feed.price.price, NOW - 4),
        "Pyth stands behind the mark"
    );

    let mut disagreeing = pyth_account(8_800_000_000, 2_000_000, NOW - 1);
    let mut same_mark = mark_account(MARK_FEED, 8_003_000_000, NOW - 1);
    tripped(sync_at(
        NOW,
        &mut disagreeing,
        Some(&mut same_mark),
        &mut feed,
        &mut params,
    ));
    let gate = gate_of(&market, &feed).unwrap();
    assert_eq!(feed.price.price, 80_029, "the mark did not move");
    assert!(
        !gate.confirms(feed.price.price, NOW),
        "the very next liquidation is refused"
    );
}

#[test]
fn a_market_whose_primary_was_taken_away_confirms_nothing_until_pyth_has_set_the_mark() {
    let (mut feed, mut params) = live_market();
    let mut market = bound_market();
    let mut pyth = pyth_account(8_000_000_000, 2_000_000, NOW - 3);
    let mut mark = mark_account(MARK_FEED, 8_002_901_727, NOW - 1);
    sync(&mut pyth, &mut mark, &mut feed, &mut params).unwrap();
    assert_eq!(feed.price.publish_time, NOW - 1, "MagicBlock's stamp");
    assert_eq!(feed.source.publish_time, NOW - 3, "Pyth's");

    market.mark_feed = 0;
    market.breaker_bps = 0;
    market.breaker_age = 0;
    market.liquidation_band = 0;
    let held = gate_of(&market, &feed).expect("a gate that confirms nothing");
    assert!(!held.confirms(feed.price.price, NOW));
    assert!(!held.confirms(0, NOW));

    let mut newer = pyth_account(8_003_000_000, 2_000_000, NOW + 2);
    sync_observed(&newer.info(), None, None, &mut feed, &mut params, NOW + 3).unwrap();
    assert_eq!(feed.price.publish_time, feed.source.publish_time);
    assert_eq!(gate_of(&market, &feed), None, "Pyth's own mark again");
}

#[test]
fn a_market_that_never_had_a_primary_has_no_gate() {
    let (feed, _) = live_market();
    let market: MarketData = bytemuck::Zeroable::zeroed();
    assert_eq!(gate_of(&market, &feed), None);
    let (never_read, _) = self::market();
    assert_eq!(gate_of(&market, &never_read), None);
}

#[test]
fn the_p1_sequence_a_pyth_8_to_9_seconds_old_and_a_20_percent_jump_freezes_the_mark() {
    for age in [8, 9, 30] {
        let (mut feed, mut params) = live_market();
        let mut pyth = pyth_account(8_000_000_000, 2_000_000, NOW - age);
        let mut jump = mark_account(MARK_FEED, 9_600_000_000, NOW - 1);
        tripped(sync(&mut pyth, &mut jump, &mut feed, &mut params));
        let mut again = mark_account(MARK_FEED, 9_600_000_000, NOW);
        tripped(sync_at(
            NOW + 1,
            &mut pyth,
            Some(&mut again),
            &mut feed,
            &mut params,
        ));
        assert_eq!(feed.price.price, 80_000, "age {age}");
        assert_eq!(params.oracle_health, ORACLE_HEALTHY, "age {age}");
    }
}

#[test]
fn a_stale_magicblock_account_freezes_the_mark() {
    let (mut feed, mut params) = live_market();
    let mut pyth = pyth_account(8_000_000_000, 2_000_000, NOW - 60);
    let mut mark = mark_account(MARK_FEED, 8_002_901_727, NOW - MAX_AGE - 1);
    refused(
        sync(&mut pyth, &mut mark, &mut feed, &mut params),
        OrderbookError::PriceTooOld,
    );
    assert_eq!(feed.price.price, 80_000);
}

#[test]
fn a_stalled_magicblock_account_does_not_hold_back_a_newer_disagreeing_pyth() {
    let (mut feed, mut params) = live_market();
    let market = bound_market();
    assert!(gate_of(&market, &feed)
        .unwrap()
        .confirms(feed.price.price, NOW - 59));

    let mut pyth = pyth_account(8_800_000_000, 2_000_000, NOW - 1);
    let mut stalled = mark_account(MARK_FEED, 8_000_000_000, NOW - 60);
    let synced = sync(&mut pyth, &mut stalled, &mut feed, &mut params).unwrap();
    assert_eq!(
        synced,
        GuardedSync::PythRecorded,
        "a success, not a refusal"
    );
    assert_eq!(feed.price.price, 80_000, "the mark did not move");
    assert_eq!(feed.price.publish_time, NOW - 60);
    assert_eq!(feed.source.raw_price, 8_800_000_000, "Pyth's print is kept");
    assert!(!gate_of(&market, &feed)
        .unwrap()
        .confirms(feed.price.price, NOW));

    refused(
        sync(&mut pyth, &mut stalled, &mut feed, &mut params),
        OrderbookError::PriceTimeWentBackwards,
    );
}

#[test]
fn an_unreadable_pyth_account_never_freezes_the_mark_and_is_never_read_as_a_price() {
    for (name, bad) in unreadable_pyth_accounts() {
        let (mut feed, mut params) = live_market();
        let mut pyth = bad.copy();
        let mut mark = mark_account(MARK_FEED, 8_002_901_727, NOW - 1);
        sync(&mut pyth, &mut mark, &mut feed, &mut params)
            .unwrap_or_else(|e| panic!("{name}: {e:?}"));
        assert_eq!(feed.price.price, 80_029, "{name}: followed within the caps");
        assert_eq!(
            feed.source.publish_time,
            NOW - 60,
            "{name}: nothing was kept from it"
        );

        let (mut feed, mut params) = live_market_pyth_aged(300);
        let mut pyth = bad.copy();
        let mut rogue = mark_account(MARK_FEED, 9_000_000_000, NOW - 1);
        refused(
            sync(&mut pyth, &mut rogue, &mut feed, &mut params),
            OrderbookError::UnguardedMoveTooLarge,
        );
        assert_eq!(feed.price.price, 80_000, "{name}: a 12% jump is refused");

        let (mut feed, mut params) = live_market();
        let mut pyth = bad.copy();
        tripped(sync(&mut pyth, &mut rogue, &mut feed, &mut params));
    }
}

#[test]
fn a_pyth_account_at_another_address_is_refused_not_ignored() {
    let (mut feed, mut params) = live_market();
    let mut other = pyth_account(8_000_000_000, 2_000_000, NOW - 1);
    other.key = Pubkey::new_unique();
    let mut mark = mark_account(MARK_FEED, 8_002_901_727, NOW - 1);
    refused(
        sync(&mut other, &mut mark, &mut feed, &mut params),
        OrderbookError::WrongPriceAccount,
    );
}

#[test]
fn the_p0_sequence_many_small_bad_steps_while_pyth_is_silent_stop_at_the_cumulative_cap() {
    for (name, bad) in unreadable_pyth_accounts() {
        let (mut feed, mut params) = live_market_pyth_aged(300);
        let mut pyth = bad.copy();
        let prices = [
            7_920_000_000,
            7_840_000_000,
            7_760_000_000,
            7_680_000_000,
            7_600_000_000,
            7_520_000_000,
        ];
        let mut results = Vec::new();
        for (step, price) in (1..).zip(prices) {
            let now = NOW + step;
            let mut mark = mark_account(MARK_FEED, price, now);
            results.push(sync_at(
                now,
                &mut pyth,
                Some(&mut mark),
                &mut feed,
                &mut params,
            ));
        }
        for (step, result) in results.into_iter().enumerate() {
            if step < 4 {
                result.unwrap_or_else(|e| panic!("{name} step {step}: {e:?}"));
            } else {
                refused(result, OrderbookError::UnguardedDriftTooLarge);
            }
        }
        assert_eq!(
            feed.price.price, 76_800,
            "{name}: 400 bps below Pyth's last price"
        );
    }
}

#[test]
fn a_crash_pyth_has_not_yet_pushed_is_followed_within_the_breaker_not_frozen() {
    let (mut feed, mut params) = live_market();
    let mut pyth = pyth_account(8_000_000_000, 2_000_000, NOW - 5);
    let mut mark = mark_account(MARK_FEED, 7_800_000_000, NOW - 1);
    let (before_mark, before_time) = (feed.price.price, feed.price.publish_time);
    sync(&mut pyth, &mut mark, &mut feed, &mut params).unwrap();
    assert!(feed.price.price < before_mark, "the mark fell with it");
    assert_ne!(feed.price.publish_time, before_time);
}

#[test]
fn an_old_three_account_crank_syncs_a_market_with_no_primary_and_the_fourth_is_never_read() {
    let (mut feed, mut params) = live_market();
    let mut pyth = pyth_account(8_010_000_000, 2_000_000, NOW - 5);
    sync_observed(&pyth.info(), None, None, &mut feed, &mut params, NOW).unwrap();
    assert_eq!(feed.price.price, 80_100, "Pyth's price, taken as before");
    assert_eq!(feed.source.conf, 2_000_000);

    let (mut feed, mut params) = live_market();
    let mut unread = Stored::new(Pubkey::new_unique(), Pubkey::new_unique(), vec![0xff; 3]);
    sync_observed(
        &pyth.info(),
        Some(&unread.info()),
        None,
        &mut feed,
        &mut params,
        NOW,
    )
    .unwrap();
    assert_eq!(feed.price.price, 80_100);
}

#[test]
fn a_market_with_a_primary_price_refuses_the_old_three_account_crank_cleanly() {
    let (mut feed, mut params) = live_market();
    let mut pyth = pyth_account(8_000_000_000, 2_000_000, NOW - 5);
    refused(
        sync_at(NOW, &mut pyth, None, &mut feed, &mut params),
        OrderbookError::PrimaryPriceAccountMissing,
    );
    assert_eq!(feed.price.price, 80_000);
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
fn the_primary_cannot_stand_in_for_pyth() {
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
fn a_first_mark_needs_a_fresh_agreeing_pyth_and_leaves_the_market_reduce_only() {
    let (mut feed, mut params) = market();
    let mut pyth = pyth_account(8_000_000_000, 2_000_000, NOW - 1);
    let mut far = mark_account(MARK_FEED, 8_500_000_000, NOW - 1);
    let mut unreadable = pyth_account(8_000_000_000, 2_000_000, NOW - 1);
    unreadable.owner = Pubkey::new_unique();
    let mut agreeing = mark_account(MARK_FEED, 8_002_901_727, NOW - 1);
    refused(
        sync(&mut unreadable, &mut agreeing, &mut feed, &mut params),
        OrderbookError::UnguardedMoveTooLarge,
    );
    tripped(sync(&mut pyth, &mut far, &mut feed, &mut params));
    assert_eq!(feed.price.price, 0, "a trip sets no first mark");
    let mut mark = mark_account(MARK_FEED, 8_002_901_727, NOW - 1);
    pyth.data[93..101].copy_from_slice(&NOW.to_le_bytes());
    sync(&mut pyth, &mut mark, &mut feed, &mut params).unwrap();
    assert_eq!(feed.price.price, 80_029);
    assert_eq!(params.status, STATUS_REDUCE_ONLY);
}

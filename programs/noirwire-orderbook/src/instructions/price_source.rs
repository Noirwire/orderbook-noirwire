use anchor_lang::prelude::*;
use bytemuck::Zeroable;
use noirwire_orderbook_engine::{
    check_quote, price_scale, sync_guarded, sync_source, MarketParams, QuoteRules, QuoteVerdict,
    SourceBinding, ORACLE_HEALTHY, STATUS_PAUSED,
};

use crate::errors::{engine, OrderbookError};
use crate::instructions::exchange::AdministerExchange;
use crate::loader::{load, load_mut, Scope};
use crate::state::{
    BookData, Exchange, MarketData, PriceData, QuoteGuard, BOOK_SEED, EXCHANGE_SEED, MARKET_SEED,
    MAX_BPS, MAX_GUARD_WINDOW, MAX_PRICE_AGE, PRICE_SEED, QUOTE_DEPEGGED, QUOTE_HEALTHY,
    QUOTE_UNBOUND,
};
use crate::{magicblock_oracle, pyth};

#[derive(Accounts)]
#[instruction(market_id: u8)]
pub struct SyncPrice<'info> {
    /// CHECK: Checked by the loader against its seeds, tag, size, readiness and market id.
    #[account(mut, seeds = [MARKET_SEED, &[market_id]], bump)]
    pub market: UncheckedAccount<'info>,
    /// CHECK: Checked by the loader against its seeds, tag, size, readiness and market id.
    #[account(mut, seeds = [PRICE_SEED, &[market_id]], bump)]
    pub price_feed: UncheckedAccount<'info>,
    /// CHECK: Compared with the market's bound source account and read by `pyth::read`.
    pub price_update: UncheckedAccount<'info>,
    /// CHECK: Read by `magicblock_oracle::read`, against the account the market's primary
    /// price is bound to, when the market has one. A market with none ignores it.
    pub mark_update: UncheckedAccount<'info>,
}

/// RULES 9 and 9b: anyone may hand the market's bound accounts to the engine.
///
/// A market with no primary price takes its bound Pyth account alone: the mark
/// follows it within the move limit; beyond it the market is dislocated, and a
/// confirmed dislocation settles at the source. `mark_update` is not read.
///
/// A market with a primary price takes MagicBlock's account as `mark_update` and
/// the bound Pyth account as `price_update`, which is only the guard: the mark
/// follows the primary. A guard fresh within the market's window has to agree within
/// its band, or the call is refused; a guard that is not fresh is no evidence, and the
/// mark then follows the primary only within the move limit. A stale primary is
/// refused. Whenever the call is refused the mark stays where it is.
///
/// A market's first mark leaves it reduce-only, or paused, until `resume_market`.
/// A refusal writes nothing.
pub fn sync_price(ctx: Context<SyncPrice>, market_id: u8) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let accounts = &ctx.accounts;
    let mut market = load_mut::<MarketData>(&accounts.market, Scope::Market(market_id))?;
    let mut feed = load_mut::<PriceData>(&accounts.price_feed, Scope::Market(market_id))?;
    let mark_source = market.mark_feed_id().map(|feed| MarkSource {
        feed,
        guard_bps: market.guard_bps,
        guard_window: market.guard_window,
    });
    sync_observed(
        &accounts.price_update,
        &accounts.mark_update,
        mark_source,
        &mut feed,
        &mut market.params,
        now,
    )
}

/// RULES 9b: a market's primary price: the oracle's feed number, the base of the band
/// and the seconds its guard stays fresh enough to be compared with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MarkSource {
    pub feed: u32,
    pub guard_bps: u16,
    pub guard_window: u16,
}

/// RULES 9 and 9b: what `sync_price` does with the two accounts it was handed, once the
/// market's own accounts are loaded. With no `mark_source` the Pyth account alone moves
/// the mark and `mark_update` is not read; with one, the primary account moves it under
/// the guard of the Pyth account. A refusal at any step writes nothing.
pub fn sync_observed(
    price_update: &AccountInfo,
    mark_update: &AccountInfo,
    mark_source: Option<MarkSource>,
    feed: &mut PriceData,
    params: &mut MarketParams,
    now: i64,
) -> Result<()> {
    let binding = feed.binding;
    let pyth_observed = pyth::read(
        price_update,
        &Pubkey::new_from_array(binding.account),
        &binding.feed_id,
        binding.expo,
    )?;
    let Some(source) = mark_source else {
        return sync_source(feed, params, &pyth_observed, now).map_err(engine);
    };
    let primary = magicblock_oracle::read(
        mark_update,
        &magicblock_oracle::feed_account(source.feed),
        binding.expo,
    )?;
    sync_guarded(
        feed,
        params,
        &primary,
        &pyth_observed,
        source.guard_bps,
        source.guard_window,
        now,
    )
    .map_err(engine)
}

/// RULES 9b: a primary price needs a Pyth account bound beside it, a band in
/// `1..=MAX_BPS` and a window in `1..=MAX_GUARD_WINDOW`; removing one takes all three
/// at zero, and nothing in between.
fn mark_source_is_sane(pyth_bound: bool, mark_feed: u16, guard_bps: u16, window: u16) -> bool {
    let removing = mark_feed == 0 && guard_bps == 0 && window == 0;
    let setting = mark_feed != 0
        && (1..=MAX_BPS).contains(&guard_bps)
        && (1..=MAX_GUARD_WINDOW).contains(&window);
    pyth_bound && (removing || setting)
}

#[derive(Accounts)]
#[instruction(market_id: u8)]
pub struct SetMarkSource<'info> {
    pub admin: Signer<'info>,
    #[account(
        seeds = [EXCHANGE_SEED],
        bump = exchange.bump,
        has_one = admin @ OrderbookError::NotAdmin
    )]
    pub exchange: Account<'info, Exchange>,
    /// CHECK: Checked by the loader against its seeds, tag, size, readiness and market id.
    #[account(mut, seeds = [MARKET_SEED, &[market_id]], bump)]
    pub market: UncheckedAccount<'info>,
    /// CHECK: Checked by the loader against its seeds, tag, size, readiness and market id.
    #[account(seeds = [PRICE_SEED, &[market_id]], bump)]
    pub price_feed: UncheckedAccount<'info>,
}

/// RULES 9b: the admin binds a market's primary price to MagicBlock's oracle feed
/// number `mark_feed`, with the base `guard_bps` of the band its guard has to be within
/// and the `guard_window` seconds the guard counts as fresh, or takes it away again
/// with all three zero. The market must already be bound to a Pyth account, which
/// becomes the guard, and healthy, so nothing an open incident is judged by changes
/// under it. It may be live: the mark does not move by this call, and the next
/// `sync_price` is bound by the move limit as any other. A band of zero or beyond
/// `MAX_BPS`, a window of zero or beyond `MAX_GUARD_WINDOW`, a feed number of zero and
/// a band or window with no feed are refused. Observations taken from the one source
/// are never followed by older ones from the other: the source record's publish time
/// only rises.
pub fn set_mark_source(
    ctx: Context<SetMarkSource>,
    market_id: u8,
    mark_feed: u16,
    guard_bps: u16,
    guard_window: u16,
) -> Result<()> {
    let accounts = &ctx.accounts;
    let scope = Scope::Market(market_id);
    let mut market = load_mut::<MarketData>(&accounts.market, scope)?;
    let feed = load::<PriceData>(&accounts.price_feed, scope)?;
    require!(
        mark_source_is_sane(
            feed.binding.account != [0; 32],
            mark_feed,
            guard_bps,
            guard_window
        ),
        OrderbookError::InvalidSettings
    );
    require!(
        market.params.oracle_health == ORACLE_HEALTHY,
        OrderbookError::OracleIncident
    );
    market.mark_feed = mark_feed;
    market.guard_bps = guard_bps;
    market.guard_window = guard_window;
    Ok(())
}

#[derive(Accounts)]
pub struct SyncQuote<'info> {
    #[account(mut, seeds = [EXCHANGE_SEED], bump = exchange.bump)]
    pub exchange: Account<'info, Exchange>,
    /// CHECK: Compared with the USDC guard's bound account and read by `pyth::read`.
    pub price_update: UncheckedAccount<'info>,
}

/// RULES 9a: anyone may hand the USDC guard its bound Pyth account. An observation
/// within `depeg_bps` of one dollar keeps the guard passing until it is `max_age`
/// old; one beyond it trips the guard at once. A refusal writes nothing.
pub fn sync_quote(mut ctx: Context<SyncQuote>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let accounts = &mut ctx.accounts;
    let guard = &mut accounts.exchange.quote;
    let observed = pyth::read(
        &accounts.price_update,
        &guard.account,
        &guard.feed_id,
        guard.expo,
    )?;
    let rules = QuoteRules {
        expo: guard.expo,
        max_conf_bps: guard.max_conf_bps,
        depeg_bps: guard.depeg_bps,
        max_age: guard.max_age,
    };
    let verdict = check_quote(&rules, guard.publish_time, &observed, now).map_err(engine)?;
    (guard.state, guard.ok_until) = match verdict {
        QuoteVerdict::Healthy { ok_until } => (QUOTE_HEALTHY, ok_until),
        QuoteVerdict::Depegged => (QUOTE_DEPEGGED, 0),
    };
    guard.price = observed.price;
    guard.conf = observed.conf;
    guard.publish_time = observed.publish_time;
    Ok(())
}

/// RULES 9: the Pyth feed a market is created with. A test network's build also
/// takes an all-zero `feed_id`: a market bound to nothing, whose mark only the
/// oracle key publishes.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct PriceSourceSettings {
    pub feed_id: [u8; 32],
    pub expo: i32,
    pub max_conf_bps: u16,
    pub base_decimals: u8,
    pub quote_decimals: u8,
}

impl PriceSourceSettings {
    /// RULES 9 and 12: the binding these settings give, at the push oracle's
    /// address for the feed.
    pub(crate) fn binding(self) -> Result<SourceBinding> {
        let unbound = self.feed_id == [0; 32];
        require!(
            !unbound || cfg!(feature = "test-oracle"),
            OrderbookError::InvalidSettings
        );
        require!(
            (1..=MAX_BPS).contains(&self.max_conf_bps),
            OrderbookError::InvalidSettings
        );
        let binding = SourceBinding {
            account: if unbound {
                [0; 32]
            } else {
                pyth::feed_account(&self.feed_id).to_bytes()
            },
            feed_id: self.feed_id,
            expo: self.expo,
            max_conf_bps: self.max_conf_bps,
            base_decimals: self.base_decimals,
            quote_decimals: self.quote_decimals,
        };
        require_scale(&binding)?;
        Ok(binding)
    }
}

fn require_scale(binding: &SourceBinding) -> Result<()> {
    price_scale(binding.expo, binding.base_decimals, binding.quote_decimals)
        .map_err(|_| error!(OrderbookError::InvalidSettings))?;
    Ok(())
}

#[derive(Accounts)]
#[instruction(market_id: u8)]
pub struct SetPriceSource<'info> {
    pub admin: Signer<'info>,
    #[account(
        seeds = [EXCHANGE_SEED],
        bump = exchange.bump,
        has_one = admin @ OrderbookError::NotAdmin
    )]
    pub exchange: Account<'info, Exchange>,
    /// CHECK: Checked by the loader against its seeds, tag, size, readiness and market id.
    #[account(mut, seeds = [MARKET_SEED, &[market_id]], bump)]
    pub market: UncheckedAccount<'info>,
    /// CHECK: Checked by the loader against its seeds, tag, size, readiness and market id.
    #[account(mut, seeds = [BOOK_SEED, &[market_id]], bump)]
    pub book: UncheckedAccount<'info>,
    /// CHECK: Checked by the loader against its seeds, tag, size, readiness and market id.
    #[account(mut, seeds = [PRICE_SEED, &[market_id]], bump)]
    pub price_feed: UncheckedAccount<'info>,
}

/// RULES 9: the admin rebinds a market to another feed, only while it is paused
/// with no position and no order on it. The mark, the source record and the
/// incident start again from nothing and the market is healthy, so the next
/// `sync_price` sets the mark and no price is chosen for anyone. RULES 9b: the
/// market's primary price and band are cleared, since they belong to the feed it
/// had, and the admin binds them again with `set_mark_source`. RULES 7: the
/// funding totals start again too, so no premium measured under the old feed
/// is charged under the new one. The decimals and confidence limit stay.
pub fn set_price_source(
    ctx: Context<SetPriceSource>,
    market_id: u8,
    feed_id: [u8; 32],
    expo: i32,
) -> Result<()> {
    let accounts = &ctx.accounts;
    let scope = Scope::Market(market_id);
    let mut market = load_mut::<MarketData>(&accounts.market, scope)?;
    let mut book = load_mut::<BookData>(&accounts.book, scope)?;
    let header = &mut book.book.header;
    let empty = header.open_interest == 0 && header.bid_count == 0 && header.ask_count == 0;
    require!(
        market.params.status == STATUS_PAUSED && empty,
        OrderbookError::PriceSourceInUse
    );
    let mut feed = load_mut::<PriceData>(&accounts.price_feed, scope)?;
    let binding = PriceSourceSettings {
        feed_id,
        expo,
        max_conf_bps: feed.binding.max_conf_bps,
        base_decimals: feed.binding.base_decimals,
        quote_decimals: feed.binding.quote_decimals,
    }
    .binding()?;
    *feed = PriceData {
        binding,
        ..PriceData::zeroed()
    };
    market.params.oracle_health = ORACLE_HEALTHY;
    market.mark_feed = 0;
    market.guard_bps = 0;
    market.guard_window = 0;
    header.traded_premium = 0;
    header.traded_size = 0;
    header.last_funding_time = Clock::get()?.unix_timestamp;
    Ok(())
}

/// RULES 9a: the USDC guard's source and limits.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct QuoteSettings {
    pub feed_id: [u8; 32],
    pub expo: i32,
    pub max_conf_bps: u16,
    pub depeg_bps: u16,
    pub max_age: i64,
}

/// The most digits a dollar may have: `10^18` is the largest power of ten in a u64.
const MAX_QUOTE_DIGITS: i32 = 18;

/// RULES 9a: the admin sets the USDC guard's source and limits, at any time. The
/// guard starts unbound and fails closed until `sync_quote` reads the new source,
/// so a wrong source can block increases but never move money.
pub fn set_quote_source(ctx: Context<AdministerExchange>, settings: QuoteSettings) -> Result<()> {
    let sane = (-MAX_QUOTE_DIGITS..=0).contains(&settings.expo)
        && (1..=MAX_BPS).contains(&settings.max_conf_bps)
        && (1..=MAX_BPS).contains(&settings.depeg_bps)
        && (1..=MAX_PRICE_AGE).contains(&settings.max_age)
        && settings.feed_id != [0; 32];
    require!(sane, OrderbookError::InvalidSettings);
    ctx.accounts.exchange.quote = QuoteGuard {
        account: pyth::feed_account(&settings.feed_id),
        feed_id: settings.feed_id,
        expo: settings.expo,
        max_conf_bps: settings.max_conf_bps,
        depeg_bps: settings.depeg_bps,
        max_age: settings.max_age,
        state: QUOTE_UNBOUND,
        ..QuoteGuard::default()
    };
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sol() -> PriceSourceSettings {
        PriceSourceSettings {
            feed_id: [7; 32],
            expo: -8,
            max_conf_bps: 100,
            base_decimals: 9,
            quote_decimals: 6,
        }
    }

    #[test]
    fn a_binding_sits_at_the_push_oracles_address_for_its_feed() {
        let binding = sol().binding().unwrap();
        assert_eq!(binding.account, pyth::feed_account(&[7; 32]).to_bytes());
        assert_eq!((binding.expo, binding.max_conf_bps), (-8, 100));
    }

    #[test]
    fn a_market_created_before_the_primary_price_has_none_and_no_band() {
        let before = [0u8; core::mem::size_of::<MarketData>()];
        let market: MarketData = bytemuck::pod_read_unaligned(&before);
        assert_eq!(market.mark_feed_id(), None);
        assert_eq!((market.guard_bps, market.guard_window), (0, 0));
        let mut bound = before;
        bound[138..140].copy_from_slice(&100u16.to_le_bytes());
        bound[140..142].copy_from_slice(&6u16.to_le_bytes());
        bound[142..144].copy_from_slice(&10u16.to_le_bytes());
        let market: MarketData = bytemuck::pod_read_unaligned(&bound);
        assert_eq!(market.mark_feed_id(), Some(6));
        assert_eq!((market.guard_bps, market.guard_window), (100, 10));
    }

    #[test]
    fn a_primary_price_needs_a_bound_guard_a_band_and_a_window_and_is_removed_with_none() {
        assert!(mark_source_is_sane(true, 6, 100, 10));
        assert!(mark_source_is_sane(true, 6, 1, 1));
        assert!(mark_source_is_sane(true, 6, MAX_BPS, MAX_GUARD_WINDOW));
        assert!(mark_source_is_sane(true, 0, 0, 0));
        assert!(
            !mark_source_is_sane(false, 6, 100, 10),
            "no Pyth guard bound"
        );
        assert!(!mark_source_is_sane(false, 0, 0, 0));
        assert!(!mark_source_is_sane(true, 6, 0, 10), "a band of zero");
        assert!(!mark_source_is_sane(true, 6, MAX_BPS + 1, 10));
        assert!(!mark_source_is_sane(true, 6, 100, 0), "a window of zero");
        assert!(!mark_source_is_sane(true, 6, 100, MAX_GUARD_WINDOW + 1));
        assert!(
            !mark_source_is_sane(true, 0, 100, 10),
            "a band with no feed"
        );
        assert!(
            !mark_source_is_sane(true, 0, 0, 10),
            "a window with no feed"
        );
    }

    #[test]
    fn a_scale_beyond_thirty_or_a_confidence_limit_out_of_range_is_refused() {
        let far = PriceSourceSettings { expo: -28, ..sol() };
        assert_eq!(
            far.binding().unwrap_err(),
            error!(OrderbookError::InvalidSettings)
        );
        for max_conf_bps in [0, MAX_BPS + 1] {
            let settings = PriceSourceSettings {
                max_conf_bps,
                ..sol()
            };
            assert!(settings.binding().is_err());
        }
    }

    #[test]
    fn only_a_test_networks_build_creates_a_market_bound_to_nothing() {
        let unbound = PriceSourceSettings {
            feed_id: [0; 32],
            ..sol()
        };
        let made = unbound.binding();
        assert_eq!(made.is_ok(), cfg!(feature = "test-oracle"));
        if let Ok(binding) = made {
            assert_eq!(binding.account, [0; 32]);
        }
    }
}

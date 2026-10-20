use anchor_lang::prelude::*;
use bytemuck::Zeroable;
use noirwire_orderbook_engine::{
    check_quote, price_scale, sync_source, QuoteRules, QuoteVerdict, SourceBinding, ORACLE_HEALTHY,
    STATUS_PAUSED,
};

use crate::errors::{engine, OrderbookError};
use crate::instructions::exchange::AdministerExchange;
use crate::loader::{load, load_mut, Scope};
use crate::pyth;
use crate::state::{
    BookData, Exchange, MarketData, PriceData, QuoteGuard, BOOK_SEED, EXCHANGE_SEED, MARKET_SEED,
    MAX_BPS, MAX_PRICE_AGE, PRICE_SEED, QUOTE_DEPEGGED, QUOTE_HEALTHY, QUOTE_UNBOUND,
};

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
}

/// RULES 9: anyone may hand the market's bound Pyth account to the engine. The
/// mark follows it within the move limit; beyond it the market is dislocated,
/// and a confirmed dislocation settles at the source. A refusal writes nothing.
pub fn sync_price(ctx: Context<SyncPrice>, market_id: u8) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let accounts = &ctx.accounts;
    let mut market = load_mut::<MarketData>(&accounts.market, Scope::Market(market_id))?;
    let mut feed = load_mut::<PriceData>(&accounts.price_feed, Scope::Market(market_id))?;
    let binding = feed.binding;
    let observed = pyth::read(
        &accounts.price_update,
        &Pubkey::new_from_array(binding.account),
        &binding.feed_id,
        binding.expo,
    )?;
    sync_source(&mut feed, &mut market.params, &observed, now).map_err(engine)
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
    #[account(seeds = [BOOK_SEED, &[market_id]], bump)]
    pub book: UncheckedAccount<'info>,
    /// CHECK: Checked by the loader against its seeds, tag, size, readiness and market id.
    #[account(mut, seeds = [PRICE_SEED, &[market_id]], bump)]
    pub price_feed: UncheckedAccount<'info>,
}

/// RULES 9: the admin rebinds a market to another feed, only while it is paused
/// with no position and no order on it. The mark, the source record and the
/// incident start again from nothing, so the next `sync_price` sets the mark and
/// no price is chosen for anyone. The decimals and confidence limit stay.
pub fn set_price_source(
    ctx: Context<SetPriceSource>,
    market_id: u8,
    feed_id: [u8; 32],
    expo: i32,
) -> Result<()> {
    let accounts = &ctx.accounts;
    let scope = Scope::Market(market_id);
    let mut market = load_mut::<MarketData>(&accounts.market, scope)?;
    {
        let book = load::<BookData>(&accounts.book, scope)?;
        let header = &book.book.header;
        let empty = header.open_interest == 0 && header.bid_count == 0 && header.ask_count == 0;
        require!(
            market.params.status == STATUS_PAUSED && empty,
            OrderbookError::PriceSourceInUse
        );
    }
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

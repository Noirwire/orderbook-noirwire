use anchor_lang::prelude::*;
use bytemuck::Zeroable;
use noirwire_orderbook_engine::{
    check_quote, price_scale, sync_source, BookHeader, Incident, MarketParams, Price, PriceFeed,
    QuoteRules, QuoteVerdict, SourceBinding, INCIDENT_SETTLED_GAP, ORACLE_HEALTHY, ORACLE_SETTLING,
    STATUS_PAUSED,
};

use crate::errors::{engine, OrderbookError};
use crate::instructions::exchange::AdministerExchange;
use crate::loader::{load_mut, Scope};
use crate::magicblock_oracle::{self, STORED_DECIMALS};
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
    /// CHECK: Compared with the market's bound source account and read by
    /// `magicblock_oracle::read`.
    pub oracle_price: UncheckedAccount<'info>,
}

/// RULES 9: anyone may hand the market's bound oracle account to the engine. The mark
/// follows it within the move limit; beyond it the market is dislocated, and a confirmed
/// dislocation settles at the source. A market's first mark leaves it reduce-only, or
/// paused, until `resume_market`. A refusal writes nothing.
pub fn sync_price(ctx: Context<SyncPrice>, market_id: u8) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let accounts = &ctx.accounts;
    let mut market = load_mut::<MarketData>(&accounts.market, Scope::Market(market_id))?;
    let mut feed = load_mut::<PriceData>(&accounts.price_feed, Scope::Market(market_id))?;
    sync_observed(&accounts.oracle_price, &mut feed, &mut market.params, now)
}

/// RULES 9: what `sync_price` does with the account it was handed, once the market's
/// own accounts are loaded. The account must be the one the binding names, owned by
/// the oracle program. A refusal at any step writes nothing.
pub fn sync_observed(
    oracle_price: &AccountInfo,
    feed: &mut PriceData,
    params: &mut MarketParams,
    now: i64,
) -> Result<()> {
    let binding = feed.binding;
    let bound = Pubkey::new_from_array(binding.account);
    let observed = magicblock_oracle::read(oracle_price, &bound, binding.expo)?;
    sync_source(feed, params, &observed, now).map_err(engine)
}

#[derive(Accounts)]
pub struct SyncQuote<'info> {
    #[account(mut, seeds = [EXCHANGE_SEED], bump = exchange.bump)]
    pub exchange: Account<'info, Exchange>,
    /// CHECK: Compared with the USDC guard's bound account and read by
    /// `magicblock_oracle::read`.
    pub oracle_price: UncheckedAccount<'info>,
}

/// RULES 9a: anyone may hand the USDC guard its bound oracle account. An observation
/// within `depeg_bps` of one dollar keeps the guard passing until it is `max_age`
/// old; one beyond it trips the guard at once. A refusal writes nothing.
pub fn sync_quote(mut ctx: Context<SyncQuote>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let accounts = &mut ctx.accounts;
    apply_quote(&mut accounts.exchange.quote, &accounts.oracle_price, now)
}

/// RULES 9a: reads `oracle_price` for the guard and records the verdict.
pub fn apply_quote(guard: &mut QuoteGuard, oracle_price: &AccountInfo, now: i64) -> Result<()> {
    let observed = magicblock_oracle::read(oracle_price, &guard.account, -STORED_DECIMALS)?;
    let rules = QuoteRules {
        expo: -STORED_DECIMALS,
        depeg_bps: guard.depeg_bps,
        max_age: guard.max_age,
    };
    let verdict = check_quote(&rules, guard.publish_time, &observed, now).map_err(engine)?;
    (guard.state, guard.ok_until) = match verdict {
        QuoteVerdict::Healthy { ok_until } => (QUOTE_HEALTHY, ok_until),
        QuoteVerdict::Depegged => (QUOTE_DEPEGGED, 0),
    };
    guard.price = observed.price;
    guard.publish_time = observed.publish_time;
    Ok(())
}

/// RULES 9: the oracle feed a market is created with. A test network's build also
/// takes a feed of zero: a market bound to nothing, whose mark only the oracle key
/// publishes.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct PriceSourceSettings {
    pub feed: u32,
    pub base_decimals: u8,
    pub quote_decimals: u8,
}

impl PriceSourceSettings {
    /// RULES 9 and 12: the binding these settings give, at the oracle's address for
    /// the feed, with the exponent the oracle stores its prices in.
    pub(crate) fn binding(self) -> Result<SourceBinding> {
        let unbound = self.feed == 0;
        require!(
            !unbound || cfg!(feature = "test-oracle"),
            OrderbookError::InvalidSettings
        );
        let binding = SourceBinding {
            account: if unbound {
                [0; 32]
            } else {
                magicblock_oracle::feed_account(self.feed).to_bytes()
            },
            feed: self.feed,
            expo: -STORED_DECIMALS,
            base_decimals: self.base_decimals,
            quote_decimals: self.quote_decimals,
            ..SourceBinding::zeroed()
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

/// RULES 9: the admin rebinds a market to oracle feed number `feed`, only while it is
/// paused. The source record starts again from nothing, and RULES 7: the funding totals
/// start again too, so no premium measured under the old feed is charged under the new
/// one. A market with no open interest and no order also loses its mark and its
/// incident and is healthy, so the next `sync_price` sets the mark and no price is
/// chosen for anyone. A market that holds either keeps its mark, so its positions stay
/// valued, and is left settling from the moment of the rebind, with a settlement window
/// that ends no earlier than one already running, so it can neither pay out collateral
/// nor resume until one observation of the new feed is accepted after the window. That
/// `sync_price` is bound by the gap and the move limit like any other: within the limit
/// it makes the market healthy once the window has passed; beyond it, it opens a
/// dislocation and the mark does not jump. The decimals stay.
pub fn set_price_source(ctx: Context<SetPriceSource>, market_id: u8, feed: u32) -> Result<()> {
    let accounts = &ctx.accounts;
    let scope = Scope::Market(market_id);
    let mut market = load_mut::<MarketData>(&accounts.market, scope)?;
    let mut book = load_mut::<BookData>(&accounts.book, scope)?;
    require!(
        market.params.status == STATUS_PAUSED,
        OrderbookError::PriceSourceInUse
    );
    let mut price_feed = load_mut::<PriceData>(&accounts.price_feed, scope)?;
    let binding = PriceSourceSettings {
        feed,
        base_decimals: price_feed.binding.base_decimals,
        quote_decimals: price_feed.binding.quote_decimals,
    }
    .binding()?;
    rebind(
        &mut market.params,
        &mut book.book.header,
        &mut price_feed,
        binding,
        Clock::get()?.unix_timestamp,
    );
    Ok(())
}

/// What `set_price_source` writes once the market is known to be paused and the new
/// binding to be valid.
pub fn rebind(
    params: &mut MarketParams,
    header: &mut BookHeader,
    feed: &mut PriceFeed,
    binding: SourceBinding,
    now: i64,
) {
    let empty = header.open_interest == 0 && header.bid_count == 0 && header.ask_count == 0;
    let (mark, incident) = if empty {
        (Price::zeroed(), Incident::zeroed())
    } else {
        let window_end = if params.oracle_health == ORACLE_HEALTHY {
            now
        } else {
            feed.incident.settle_until.max(now)
        };
        let held = Incident {
            since: now,
            settle_until: window_end,
            reason: INCIDENT_SETTLED_GAP,
            ..Incident::zeroed()
        };
        (feed.price, held)
    };
    *feed = PriceFeed {
        price: mark,
        binding,
        incident,
        ..PriceFeed::zeroed()
    };
    params.oracle_health = if empty {
        ORACLE_HEALTHY
    } else {
        ORACLE_SETTLING
    };
    header.traded_premium = 0;
    header.traded_size = 0;
    header.last_funding_time = now;
}

/// RULES 9a: the USDC guard's source and limits.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct QuoteSettings {
    pub feed: u32,
    pub depeg_bps: u16,
    pub max_age: i64,
}

impl QuoteSettings {
    fn guard(self) -> Result<QuoteGuard> {
        let sane = (1..=MAX_BPS).contains(&self.depeg_bps)
            && (1..=MAX_PRICE_AGE).contains(&self.max_age)
            && self.feed != 0;
        require!(sane, OrderbookError::InvalidSettings);
        Ok(QuoteGuard {
            account: magicblock_oracle::feed_account(self.feed),
            feed: self.feed,
            depeg_bps: self.depeg_bps,
            max_age: self.max_age,
            state: QUOTE_UNBOUND,
            ..QuoteGuard::default()
        })
    }
}

/// RULES 9a: the admin sets the USDC guard's source and limits, at any time. The
/// guard starts unbound and fails closed until `sync_quote` reads the new source,
/// so a wrong source can block increases but never move money.
pub fn set_quote_source(ctx: Context<AdministerExchange>, settings: QuoteSettings) -> Result<()> {
    ctx.accounts.exchange.quote = settings.guard()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use noirwire_orderbook_engine::{SourceRecord, INCIDENT_MOVE_BEYOND_LIMIT, ORACLE_DISLOCATED};

    fn sol() -> PriceSourceSettings {
        PriceSourceSettings {
            feed: 6,
            base_decimals: 9,
            quote_decimals: 6,
        }
    }

    #[test]
    fn a_binding_sits_at_the_oracles_address_for_its_feed() {
        let binding = sol().binding().unwrap();
        assert_eq!(
            binding.account,
            magicblock_oracle::feed_account(6).to_bytes()
        );
        assert_eq!((binding.feed, binding.expo), (6, -8));
        assert_eq!(binding._reserved, [0; 28]);
    }

    #[test]
    fn a_scale_beyond_thirty_is_refused() {
        let far = PriceSourceSettings {
            base_decimals: 40,
            ..sol()
        };
        assert_eq!(
            far.binding().unwrap_err(),
            error!(OrderbookError::InvalidSettings)
        );
    }

    #[test]
    fn only_a_test_networks_build_creates_a_market_bound_to_nothing() {
        let unbound = PriceSourceSettings { feed: 0, ..sol() };
        let made = unbound.binding();
        assert_eq!(made.is_ok(), cfg!(feature = "test-oracle"));
        if let Ok(binding) = made {
            assert_eq!(binding.account, [0; 32]);
        }
    }

    fn quote() -> QuoteSettings {
        QuoteSettings {
            feed: 7,
            depeg_bps: 100,
            max_age: 180,
        }
    }

    #[test]
    fn the_usdc_guard_binds_to_the_oracles_account_and_starts_unbound() {
        let guard = quote().guard().unwrap();
        assert_eq!(guard.account, magicblock_oracle::feed_account(7));
        assert_eq!((guard.feed, guard.depeg_bps, guard.max_age), (7, 100, 180));
        assert_eq!(guard.state, QUOTE_UNBOUND);
    }

    #[test]
    fn a_usdc_guard_with_no_feed_or_out_of_range_limits_is_refused() {
        let refused = |settings: QuoteSettings| {
            assert_eq!(
                settings.guard().err(),
                Some(error!(OrderbookError::InvalidSettings))
            )
        };
        refused(QuoteSettings { feed: 0, ..quote() });
        for depeg_bps in [0, MAX_BPS + 1] {
            refused(QuoteSettings {
                depeg_bps,
                ..quote()
            });
        }
        for max_age in [0, -1, MAX_PRICE_AGE + 1] {
            refused(QuoteSettings { max_age, ..quote() });
        }
    }

    fn market(open_interest: u64) -> (MarketParams, BookHeader, PriceFeed) {
        let mut params = MarketParams::zeroed();
        params.status = STATUS_PAUSED;
        params.oracle_health = ORACLE_SETTLING;
        let mut header = BookHeader::zeroed();
        header.open_interest = open_interest;
        header.traded_premium = 7;
        header.traded_size = 3;
        header.last_funding_time = 10;
        let feed = PriceFeed {
            price: Price {
                price: 80_000,
                publish_time: 90,
                accepted_at: 91,
            },
            source: SourceRecord {
                raw_price: 8_000_000_000,
                publish_time: 92,
                target: 80_000,
                observed_at: 93,
                ..SourceRecord::zeroed()
            },
            binding: SourceBinding {
                account: [4; 32],
                feed: 1,
                expo: -8,
                base_decimals: 9,
                quote_decimals: 6,
                ..SourceBinding::zeroed()
            },
            incident: Incident {
                since: 50,
                settle_until: 60,
                gap_bps: 700,
                reason: INCIDENT_MOVE_BEYOND_LIMIT,
                _padding: [0; 5],
            },
        };
        (params, header, feed)
    }

    #[test]
    fn rebinding_an_empty_market_restarts_the_mark_and_everything_measured_under_the_old_feed() {
        let (mut params, mut header, mut feed) = market(0);
        let binding = sol().binding().unwrap();
        rebind(&mut params, &mut header, &mut feed, binding, 500);
        assert_eq!(
            feed,
            PriceFeed {
                binding,
                ..PriceFeed::zeroed()
            }
        );
        assert_eq!(params.oracle_health, ORACLE_HEALTHY);
        assert_eq!(params.status, STATUS_PAUSED);
        assert_eq!(
            (
                header.traded_premium,
                header.traded_size,
                header.last_funding_time
            ),
            (0, 0, 500)
        );
    }

    #[test]
    fn rebinding_a_market_with_open_interest_keeps_its_mark_and_leaves_it_settling() {
        let (mut params, mut header, mut feed) = market(5);
        let mark = feed.price;
        let binding = sol().binding().unwrap();
        rebind(&mut params, &mut header, &mut feed, binding, 500);
        assert_eq!(feed.price, mark, "positions stay valued");
        assert_eq!(feed.binding, binding);
        assert_eq!(feed.source, SourceRecord::zeroed());
        assert_eq!(
            feed.incident,
            Incident {
                since: 500,
                settle_until: 500,
                gap_bps: 0,
                reason: INCIDENT_SETTLED_GAP,
                _padding: [0; 5],
            }
        );
        assert_eq!(params.oracle_health, ORACLE_SETTLING);
        assert_eq!(
            (
                header.traded_premium,
                header.traded_size,
                header.last_funding_time
            ),
            (0, 0, 500)
        );
    }

    #[test]
    fn rebinding_a_market_with_only_a_resting_order_keeps_its_mark_too() {
        for (bids, asks) in [(1, 0), (0, 1)] {
            let (mut params, mut header, mut feed) = market(0);
            header.bid_count = bids;
            header.ask_count = asks;
            let mark = feed.price;
            rebind(
                &mut params,
                &mut header,
                &mut feed,
                sol().binding().unwrap(),
                500,
            );
            assert_eq!(feed.price, mark);
        }
    }

    #[test]
    fn a_healthy_market_that_holds_positions_is_left_settling_from_the_rebind() {
        let (mut params, mut header, mut feed) = market(5);
        params.oracle_health = ORACLE_HEALTHY;
        feed.incident.settle_until = 900;
        rebind(
            &mut params,
            &mut header,
            &mut feed,
            sol().binding().unwrap(),
            500,
        );
        assert_eq!(params.oracle_health, ORACLE_SETTLING);
        assert_eq!(
            (feed.incident.since, feed.incident.settle_until),
            (500, 500)
        );
    }

    #[test]
    fn rebinding_never_shortens_a_window_that_is_running() {
        for health in [ORACLE_DISLOCATED, ORACLE_SETTLING] {
            let (mut params, mut header, mut feed) = market(5);
            params.oracle_health = health;
            feed.incident.settle_until = 900;
            rebind(
                &mut params,
                &mut header,
                &mut feed,
                sol().binding().unwrap(),
                500,
            );
            assert_eq!(params.oracle_health, ORACLE_SETTLING);
            assert_eq!(feed.incident.settle_until, 900);
        }
    }
}

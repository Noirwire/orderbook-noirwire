use anchor_lang::prelude::*;
use noirwire_orderbook_engine::{publish_price as engine_publish, reset_price as engine_reset};

use crate::errors::{engine, OrderbookError};
use crate::loader::{load, load_mut, Scope};
use crate::state::{Exchange, MarketData, PriceData, EXCHANGE_SEED, MARKET_SEED, PRICE_SEED};

#[derive(Accounts)]
#[instruction(market_id: u8)]
pub struct PublishPrice<'info> {
    #[account(address = exchange.oracle @ OrderbookError::NotOracle)]
    pub oracle: Signer<'info>,
    #[account(seeds = [EXCHANGE_SEED], bump = exchange.bump)]
    pub exchange: Account<'info, Exchange>,
    /// CHECK: Checked by the loader against its seeds, tag, size, readiness and market id.
    #[account(seeds = [MARKET_SEED, &[market_id]], bump)]
    pub market: UncheckedAccount<'info>,
    /// CHECK: Checked by the loader against its seeds, tag, size, readiness and market id.
    #[account(mut, seeds = [PRICE_SEED, &[market_id]], bump)]
    pub price_feed: UncheckedAccount<'info>,
}

/// RULES 9: the oracle authority writes the mark, within the market's move
/// limit and publish gap, never ahead of the rollup's clock.
pub fn publish_price(
    ctx: Context<PublishPrice>,
    market_id: u8,
    price: u64,
    publish_time: i64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let market = load::<MarketData>(&ctx.accounts.market, Scope::Market(market_id))?;
    let mut feed = load_mut::<PriceData>(&ctx.accounts.price_feed, Scope::Market(market_id))?;
    engine_publish(&mut feed.price, &market.params, price, publish_time, now).map_err(engine)
}

#[derive(Accounts)]
#[instruction(market_id: u8)]
pub struct ResetPrice<'info> {
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
    #[account(mut, seeds = [PRICE_SEED, &[market_id]], bump)]
    pub price_feed: UncheckedAccount<'info>,
}

/// RULES 9: the admin's reset. It skips the move limit and the time checks and
/// puts the market in reduce-only status until `resume_market`.
pub fn reset_price(
    ctx: Context<ResetPrice>,
    market_id: u8,
    price: u64,
    publish_time: i64,
) -> Result<()> {
    let mut market = load_mut::<MarketData>(&ctx.accounts.market, Scope::Market(market_id))?;
    let mut feed = load_mut::<PriceData>(&ctx.accounts.price_feed, Scope::Market(market_id))?;
    engine_reset(&mut feed.price, &mut market.params, price, publish_time).map_err(engine)
}

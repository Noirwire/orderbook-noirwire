use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke;
use ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID;
use magicblock_magic_program_api::args::ScheduleTaskArgs;
use magicblock_magic_program_api::instruction::MagicBlockInstruction;
use noirwire_orderbook_engine::{update_funding as engine_update, KIND_PERP};

use crate::errors::{engine, OrderbookError};
use crate::loader::{load, Scope};
use crate::market::{env, MarketAccounts};
use crate::state::{Exchange, MarketData, BOOK_SEED, EXCHANGE_SEED, MARKET_SEED, PRICE_SEED};

#[derive(Accounts)]
#[instruction(market_id: u8)]
pub struct UpdateFunding<'info> {
    #[account(seeds = [EXCHANGE_SEED], bump = exchange.bump)]
    pub exchange: Account<'info, Exchange>,
    /// CHECK: Checked by the loader against its seeds, tag, size, readiness and market id.
    #[account(mut, seeds = [MARKET_SEED, &[market_id]], bump)]
    pub market: UncheckedAccount<'info>,
    /// CHECK: Checked by the loader against its seeds, tag, size, readiness and market id.
    #[account(mut, seeds = [BOOK_SEED, &[market_id]], bump)]
    pub book: UncheckedAccount<'info>,
    /// CHECK: Checked by the loader against its seeds, tag, size, readiness and market id.
    #[account(seeds = [PRICE_SEED, &[market_id]], bump)]
    pub price_feed: UncheckedAccount<'info>,
}

/// RULES 7: anyone may call, and so may the scheduler. Does nothing, and
/// succeeds, inside the funding interval, while the price source is not
/// healthy, or while the price is missing or stale. The price feed's last
/// incident says whether the interval is discarded.
pub fn update_funding(ctx: Context<UpdateFunding>, market_id: u8) -> Result<()> {
    let accounts = &ctx.accounts;
    let mut loaded = MarketAccounts::load(
        &accounts.market,
        &accounts.book,
        &accounts.price_feed,
        market_id,
    )?;
    let incident = loaded.incident();
    let env = env(&accounts.exchange, Clock::get()?.unix_timestamp, &[]);
    engine_update(&mut loaded.as_engine(), &incident, &env).map_err(engine)?;
    Ok(())
}

#[derive(Accounts)]
#[instruction(market_id: u8)]
pub struct ScheduleFunding<'info> {
    #[account(mut)]
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
    #[account(seeds = [PRICE_SEED, &[market_id]], bump)]
    pub price_feed: UncheckedAccount<'info>,
    /// CHECK: The magic program, by its fixed address.
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

/// Asks the rollup's scheduler to call `update_funding` on a perp market every
/// `interval_ms`, `iterations` times. The admin is the task's authority, the
/// only key that can cancel it.
pub fn schedule_funding(
    ctx: Context<ScheduleFunding>,
    market_id: u8,
    task_id: i64,
    interval_ms: i64,
    iterations: i64,
) -> Result<()> {
    let accounts = &ctx.accounts;
    require!(
        interval_ms > 0 && iterations > 0,
        OrderbookError::InvalidSchedule
    );
    {
        let market = load::<MarketData>(&accounts.market, Scope::Market(market_id))?;
        require!(
            market.params.kind == KIND_PERP,
            OrderbookError::NotPerpMarket
        );
    }
    let tick = Instruction {
        program_id: crate::ID,
        accounts: vec![
            AccountMeta::new_readonly(accounts.exchange.key(), false),
            AccountMeta::new(accounts.market.key(), false),
            AccountMeta::new(accounts.book.key(), false),
            AccountMeta::new_readonly(accounts.price_feed.key(), false),
        ],
        data: anchor_lang::InstructionData::data(&crate::instruction::UpdateFunding { market_id }),
    };
    let schedule = Instruction::new_with_bincode(
        MAGIC_PROGRAM_ID,
        &MagicBlockInstruction::ScheduleTask(ScheduleTaskArgs {
            task_id,
            execution_interval_millis: interval_ms,
            iterations,
            instructions: vec![tick],
        }),
        vec![
            AccountMeta::new(accounts.admin.key(), true),
            AccountMeta::new_readonly(accounts.exchange.key(), false),
            AccountMeta::new(accounts.market.key(), false),
            AccountMeta::new(accounts.book.key(), false),
            AccountMeta::new_readonly(accounts.price_feed.key(), false),
        ],
    );
    invoke(
        &schedule,
        &[
            accounts.admin.to_account_info(),
            accounts.exchange.to_account_info(),
            accounts.market.to_account_info(),
            accounts.book.to_account_info(),
            accounts.price_feed.to_account_info(),
        ],
    )?;
    Ok(())
}

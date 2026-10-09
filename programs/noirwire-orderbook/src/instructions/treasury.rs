use anchor_lang::prelude::*;
use noirwire_orderbook_engine::{
    collect_fees as engine_collect, cover_shortfall as engine_cover,
    move_fees_to_insurance as engine_move, reconcile_shortfall as engine_reconcile,
    resume_market as engine_resume, LedgerMut, MarketParams, KIND_PERP,
};

use crate::custody::{checked_custody, require_token_program, token_account, transfer_out};
use crate::errors::{engine, OrderbookError};
use crate::instructions::trader::AssetKind;
use crate::loader::{load_mut, Scope};
use crate::risk::stated_market_id;
use crate::state::{
    Exchange, LedgerData, MarketData, CUSTODY_SEED, EXCHANGE_SEED, LEDGER_SEED, MARKET_SEED,
};

#[derive(Accounts)]
#[instruction(market_id: u8)]
pub struct CoverShortfall<'info> {
    #[account(seeds = [EXCHANGE_SEED], bump = exchange.bump)]
    pub exchange: Account<'info, Exchange>,
    /// CHECK: Checked by the loader against its seeds, tag, size and readiness.
    #[account(mut, seeds = [LEDGER_SEED], bump)]
    pub ledger: UncheckedAccount<'info>,
    /// CHECK: Checked by the loader against its seeds, tag, size, readiness and market id.
    #[account(mut, seeds = [MARKET_SEED, &[market_id]], bump)]
    pub market: UncheckedAccount<'info>,
}

/// RULES 8.6: anyone may ask the insurance seat to cover a flat seat's negative
/// collateral, down to what the market has recorded. A seat that does not
/// qualify changes nothing, so the call says nothing about it.
pub fn cover_shortfall(ctx: Context<CoverShortfall>, market_id: u8, seat: u32) -> Result<()> {
    let accounts = &ctx.accounts;
    let mut ledger_account = load_mut::<LedgerData>(&accounts.ledger, Scope::Global)?;
    let ledger = &mut *ledger_account;
    let mut market = load_mut::<MarketData>(&accounts.market, Scope::Market(market_id))?;
    let mut seats = LedgerMut {
        header: &mut ledger.header,
        seats: &mut ledger.seats,
    };
    engine_cover(&mut seats, &mut market.params, seat).map_err(engine)?;
    Ok(())
}

#[derive(Accounts)]
pub struct ReconcileShortfall<'info> {
    #[account(seeds = [EXCHANGE_SEED], bump = exchange.bump)]
    pub exchange: Account<'info, Exchange>,
    /// CHECK: Checked by the loader against its seeds, tag, size and readiness. Only read.
    #[account(mut, seeds = [LEDGER_SEED], bump)]
    pub ledger: UncheckedAccount<'info>,
}

/// RULES 8.6: anyone may lower the markets' recorded shortfalls to what flat
/// seats still owe, after a debtor repaid by deposit. The remaining accounts
/// are every perp market the exchange has, by rising id, each checked like
/// any market account; a market left out is refused, so a record can never
/// be lowered against a partial picture.
pub fn reconcile_shortfall(ctx: Context<ReconcileShortfall>) -> Result<()> {
    let accounts = &ctx.accounts;
    let mut loaded = Vec::with_capacity(ctx.remaining_accounts.len());
    let mut seen: u8 = 0;
    for account in ctx.remaining_accounts {
        let market_id = stated_market_id(account)?;
        let market = load_mut::<MarketData>(account, Scope::Market(market_id))?;
        require!(
            market.params.kind == KIND_PERP && market_id as usize >= loaded.len(),
            OrderbookError::MalformedRemainingAccounts
        );
        require!(
            seen >> market_id == 0,
            OrderbookError::MalformedRemainingAccounts
        );
        seen |= 1 << market_id;
        loaded.push(market);
    }
    require!(
        seen == accounts.exchange.perp_markets,
        OrderbookError::MarketDataMissing
    );
    let mut params: Vec<MarketParams> = loaded.iter().map(|market| market.params).collect();
    let mut ledger_account = load_mut::<LedgerData>(&accounts.ledger, Scope::Global)?;
    let ledger = &mut *ledger_account;
    let seats = LedgerMut {
        header: &mut ledger.header,
        seats: &mut ledger.seats,
    };
    engine_reconcile(&seats, &mut params);
    for (market, after) in loaded.iter_mut().zip(params) {
        market.params.uncovered_shortfall = after.uncovered_shortfall;
    }
    Ok(())
}

#[derive(Accounts)]
#[instruction(market_id: u8)]
pub struct ResumeMarket<'info> {
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
}

/// RULES 8.6 and 9: returns a market to normal status, only once nothing is
/// owed on it.
pub fn resume_market(ctx: Context<ResumeMarket>, market_id: u8) -> Result<()> {
    let mut market = load_mut::<MarketData>(&ctx.accounts.market, Scope::Market(market_id))?;
    engine_resume(&mut market.params).map_err(engine)
}

#[derive(Accounts)]
pub struct MoveFees<'info> {
    pub admin: Signer<'info>,
    #[account(
        seeds = [EXCHANGE_SEED],
        bump = exchange.bump,
        has_one = admin @ OrderbookError::NotAdmin
    )]
    pub exchange: Account<'info, Exchange>,
    /// CHECK: Checked by the loader against its seeds, tag, size and readiness.
    #[account(mut, seeds = [LEDGER_SEED], bump)]
    pub ledger: UncheckedAccount<'info>,
}

/// RULES 12a: collected perp fees go from the fee seat to the insurance seat.
/// Nothing leaves custody.
pub fn move_fees_to_insurance(ctx: Context<MoveFees>, amount: u64) -> Result<()> {
    let mut ledger_account = load_mut::<LedgerData>(&ctx.accounts.ledger, Scope::Global)?;
    let ledger = &mut *ledger_account;
    let mut seats = LedgerMut {
        header: &mut ledger.header,
        seats: &mut ledger.seats,
    };
    engine_move(&mut seats, amount).map_err(engine)
}

#[derive(Accounts)]
pub struct CollectFees<'info> {
    pub admin: Signer<'info>,
    #[account(
        seeds = [EXCHANGE_SEED],
        bump = exchange.bump,
        has_one = admin @ OrderbookError::NotAdmin
    )]
    pub exchange: Account<'info, Exchange>,
    /// CHECK: Checked by the loader against its seeds, tag, size and readiness.
    #[account(mut, seeds = [LEDGER_SEED], bump)]
    pub ledger: UncheckedAccount<'info>,
    /// CHECK: The address that owns every custody token account. It never holds data.
    #[account(seeds = [CUSTODY_SEED], bump)]
    pub custody_authority: UncheckedAccount<'info>,
    /// CHECK: Compared with the registered custody account and read as an SPL token account.
    #[account(mut)]
    pub custody: UncheckedAccount<'info>,
    /// CHECK: Read as an SPL token account of the registered mint; the admin chooses it.
    #[account(mut)]
    pub to: UncheckedAccount<'info>,
    /// CHECK: Must be the SPL Token program.
    pub token_program: UncheckedAccount<'info>,
}

/// RULES 12a and 11: the admin takes collected fees out of the fee seat and
/// custody in one instruction, to a token account of the admin's choosing.
pub fn collect_fees(ctx: Context<CollectFees>, asset: AssetKind, amount: u64) -> Result<()> {
    let accounts = &ctx.accounts;
    require_token_program(&accounts.token_program)?;
    let (token_index, pool) = asset.resolve(&accounts.exchange);
    let token = accounts.exchange.token(token_index)?;
    let custody_authority = accounts.custody_authority.key();
    checked_custody(token, &custody_authority, &accounts.custody)?;
    let to = token_account(&accounts.to)?;
    require_keys_eq!(to.mint, token.mint, OrderbookError::WrongMint);
    {
        let mut ledger_account = load_mut::<LedgerData>(&accounts.ledger, Scope::Global)?;
        let ledger = &mut *ledger_account;
        let mut seats = LedgerMut {
            header: &mut ledger.header,
            seats: &mut ledger.seats,
        };
        engine_collect(&mut seats, pool, amount).map_err(engine)?;
    }
    let custody_seeds: [&[u8]; 2] = [CUSTODY_SEED, &[ctx.bumps.custody_authority]];
    transfer_out(
        &accounts.custody,
        &accounts.to,
        &accounts.custody_authority,
        &custody_seeds,
        amount,
    )
}

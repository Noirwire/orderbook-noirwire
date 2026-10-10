use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder};

use crate::custody::{
    associated_token_address, checked_custody, require_public_custody, require_sealed_custody,
};
use crate::errors::OrderbookError;
use crate::program::NoirwireOrderbook;
use crate::state::{
    CustodyVisibility, Exchange, ExchangeSettings, ExchangeUpdate, TokenInfo, CUSTODY_SEED,
    EXCHANGE_SEED, TOKENS,
};

#[derive(Accounts)]
pub struct InitializeExchange<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + Exchange::INIT_SPACE,
        seeds = [EXCHANGE_SEED],
        bump
    )]
    pub exchange: Account<'info, Exchange>,
    #[account(
        constraint = program.programdata_address()? == Some(program_data.key())
            @ OrderbookError::NotUpgradeAuthority
    )]
    pub program: Program<'info, NoirwireOrderbook>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(admin.key())
            @ OrderbookError::NotUpgradeAuthority
    )]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

/// Creates the exchange on Solana. Only the program's upgrade authority may,
/// so nobody can claim the one exchange address before the deployer does.
pub fn initialize_exchange(
    ctx: Context<InitializeExchange>,
    settings: ExchangeSettings,
) -> Result<()> {
    let exchange = &mut ctx.accounts.exchange;
    exchange.bump = ctx.bumps.exchange;
    exchange.admin = ctx.accounts.admin.key();
    exchange.pending_admin = None;
    exchange.paused = false;
    exchange.tokens = [TokenInfo::default(); TOKENS];
    exchange.perp_markets = 0;
    exchange.seats_day = 0;
    exchange.seats_opened = 0;
    exchange.public_custody = 0;
    settings.apply_to(exchange)
}

/// The admin and the exchange, for what only changes what the exchange
/// stores. Sent to wherever the exchange lives: the rollup while delegated.
#[derive(Accounts)]
pub struct AdministerExchange<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [EXCHANGE_SEED],
        bump = exchange.bump,
        has_one = admin @ OrderbookError::NotAdmin
    )]
    pub exchange: Account<'info, Exchange>,
}

pub fn update_exchange(ctx: Context<AdministerExchange>, settings: ExchangeUpdate) -> Result<()> {
    settings.apply_to(&mut ctx.accounts.exchange)
}

/// While paused, no order is placed, no funding advances and no liquidation
/// runs. Cancels and withdrawals stay open.
pub fn set_paused(ctx: Context<AdministerExchange>, paused: bool) -> Result<()> {
    ctx.accounts.exchange.paused = paused;
    Ok(())
}

/// Offers the admin role to `nominee`, replacing any earlier offer. `None`
/// withdraws it. Nothing changes hands until the nominee accepts.
pub fn propose_admin(ctx: Context<AdministerExchange>, nominee: Option<Pubkey>) -> Result<()> {
    ctx.accounts.exchange.pending_admin = nominee;
    Ok(())
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub nominee: Signer<'info>,
    #[account(
        mut,
        seeds = [EXCHANGE_SEED],
        bump = exchange.bump,
        constraint = exchange.pending_admin == Some(nominee.key()) @ OrderbookError::NotNominee
    )]
    pub exchange: Account<'info, Exchange>,
}

/// Makes the nominee the admin. The admin before it keeps nothing.
pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
    let exchange = &mut ctx.accounts.exchange;
    exchange.admin = ctx.accounts.nominee.key();
    exchange.pending_admin = None;
    Ok(())
}

#[derive(Accounts)]
#[instruction(index: u8)]
pub struct RegisterToken<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [EXCHANGE_SEED],
        bump = exchange.bump,
        has_one = admin @ OrderbookError::NotAdmin
    )]
    pub exchange: Account<'info, Exchange>,
    /// CHECK: The address that owns every custody token account. It never holds data.
    #[account(seeds = [CUSTODY_SEED], bump)]
    pub custody_authority: UncheckedAccount<'info>,
    /// CHECK: Read as an SPL token account in the handler.
    pub custody: UncheckedAccount<'info>,
    /// CHECK: Its address, owner and contents are checked in the handler.
    pub custody_permission: UncheckedAccount<'info>,
}

/// Records a token's mint and its custody token account at `index`. The custody
/// account must already exist inside the rollup, owned by the custody
/// authority, so a deposit never credits a seat for tokens that went nowhere.
/// Its balance is sealed, so the sum of all seats is not public, or public
/// with no private permission at all, as `visibility` says. Neither the token
/// nor its visibility changes once recorded.
pub fn register_token(
    ctx: Context<RegisterToken>,
    index: u8,
    mint: Pubkey,
    visibility: CustodyVisibility,
) -> Result<()> {
    let accounts = &ctx.accounts;
    require!(usize::from(index) < TOKENS, OrderbookError::InvalidSettings);
    require!(mint != Pubkey::default(), OrderbookError::InvalidSettings);
    let custody_authority = accounts.custody_authority.key();
    let token = TokenInfo {
        mint,
        custody: associated_token_address(&custody_authority, &mint),
    };
    checked_custody(&token, &custody_authority, &accounts.custody)?;
    match visibility {
        CustodyVisibility::Sealed => {
            require_sealed_custody(&custody_authority, &mint, &accounts.custody_permission)?
        }
        CustodyVisibility::Public => {
            require_public_custody(&custody_authority, &mint, &accounts.custody_permission)?
        }
    }
    let exchange = &mut ctx.accounts.exchange;
    let recorded = exchange.tokens[usize::from(index)];
    require!(
        !recorded.is_set()
            || (recorded == token && exchange.custody_visibility(index) == visibility),
        OrderbookError::InvalidSettings
    );
    exchange.tokens[usize::from(index)] = token;
    if visibility == CustodyVisibility::Public {
        exchange.public_custody |= 1 << index;
    }
    Ok(())
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateExchange<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: The exchange PDA. Its seeds are checked here and again by the
    /// delegation call; its stored admin is compared in the handler. Left
    /// unchecked so Anchor does not write stale data back after ownership moves.
    #[account(mut, del, seeds = [EXCHANGE_SEED], bump)]
    pub exchange: UncheckedAccount<'info>,
}

/// Moves the exchange, with its balance, to the rollup run by `validator`.
pub fn delegate_exchange(ctx: Context<DelegateExchange>, validator: Pubkey) -> Result<()> {
    let accounts = &ctx.accounts;
    require_keys_eq!(
        stored_admin(&accounts.exchange)?,
        accounts.admin.key(),
        OrderbookError::NotAdmin
    );
    accounts.delegate_exchange(
        &accounts.admin,
        &[EXCHANGE_SEED],
        DelegateConfig {
            validator: Some(validator),
            ..Default::default()
        },
    )?;
    Ok(())
}

fn stored_admin(exchange: &AccountInfo) -> Result<Pubkey> {
    require_keys_eq!(
        *exchange.owner,
        crate::ID,
        ErrorCode::AccountOwnedByWrongProgram
    );
    let data = exchange.try_borrow_data()?;
    Ok(Exchange::try_deserialize(&mut &data[..])?.admin)
}

#[commit]
#[derive(Accounts)]
pub struct UndelegateExchange<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [EXCHANGE_SEED],
        bump = exchange.bump,
        has_one = admin @ OrderbookError::NotAdmin
    )]
    pub exchange: Account<'info, Exchange>,
}

/// Sent to the rollup. Brings the exchange back to Solana with the balance it
/// has there. Everything it paid for stays in the rollup.
pub fn undelegate_exchange(ctx: Context<UndelegateExchange>) -> Result<()> {
    MagicIntentBundleBuilder::new(
        ctx.accounts.admin.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit_and_undelegate(&[ctx.accounts.exchange.to_account_info()])
    .build_and_invoke()?;
    Ok(())
}

#[derive(Accounts)]
pub struct WithdrawExchange<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [EXCHANGE_SEED],
        bump = exchange.bump,
        has_one = admin @ OrderbookError::NotAdmin
    )]
    pub exchange: Account<'info, Exchange>,
}

/// Pays the admin out of the exchange's balance, down to its own rent and no
/// further. Meant for the undelegated exchange on Solana: undelegate first.
///
/// The program owns the exchange, so it moves the lamports itself. The system
/// program would refuse to debit an account that carries data.
pub fn withdraw_exchange(ctx: Context<WithdrawExchange>, lamports: u64) -> Result<()> {
    let exchange = ctx.accounts.exchange.to_account_info();
    let admin = ctx.accounts.admin.to_account_info();

    let rent = Rent::get()?.minimum_balance(exchange.data_len());
    let remaining = exchange
        .lamports()
        .checked_sub(lamports)
        .ok_or(OrderbookError::BelowRent)?;
    require!(remaining >= rent, OrderbookError::BelowRent);
    let paid = admin
        .lamports()
        .checked_add(lamports)
        .ok_or(OrderbookError::MathOverflow)?;

    **exchange.try_borrow_mut_lamports()? = remaining;
    **admin.try_borrow_mut_lamports()? = paid;
    Ok(())
}

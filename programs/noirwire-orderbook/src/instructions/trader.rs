use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID};
use noirwire_orderbook_engine::{
    close_seat, deposit, release_empty_seats as engine_release_empty_seats, release_if_empty,
    take_seat, withdraw, Asset, Env, LedgerMut, INSURANCE_SEAT,
};

use super::trading::now_before;
use crate::custody::{
    associated_token_address, checked_holding, custody_leg, require_within_ceiling, token_account,
    transfer_in, transfer_out,
};
use crate::ephemeral::{self, PermissionAccounts};
use crate::errors::{engine, OrderbookError};
use crate::loader::{finalize, load_ledger_mut, load_mut, load_view_mut, Scope};
use crate::market::env;
use crate::owner_auth;
use crate::risk::RiskTable;
use crate::state::{
    Exchange, ViewData, EXCHANGE_SEED, LEDGER_SEED, ORDER_KEYS, PERMISSION_SEED,
    RELEASE_SEATS_PER_CALL, VIEW_SEED,
};
use crate::view::{
    check_order_keys, is_seated, record_seat, refresh_seat, reset_order_keys, seated_index,
    set_order_keys as replace_keys, trader, unseat, use_order_key,
};

/// Which pool of a seat a deposit or a withdrawal moves.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub enum AssetKind {
    Collateral,
    Spot { token: u8 },
}

impl AssetKind {
    /// The token index behind the pool, and the engine's name for the pool.
    pub fn resolve(self, exchange: &Exchange) -> (u8, Asset) {
        match self {
            AssetKind::Collateral => (exchange.collateral_token, Asset::Collateral),
            AssetKind::Spot { token } => (token, Asset::Spot(token)),
        }
    }
}

#[derive(Accounts)]
pub struct OpenTrader<'info> {
    #[account(address = exchange.gate @ OrderbookError::GateMissing)]
    pub gate: Signer<'info>,
    pub owner: Signer<'info>,
    #[account(mut, seeds = [EXCHANGE_SEED], bump = exchange.bump)]
    pub exchange: Account<'info, Exchange>,
    /// CHECK: The owner's view, created here inside the rollup.
    #[account(mut, seeds = [VIEW_SEED, owner.key().as_ref()], bump)]
    pub view: UncheckedAccount<'info>,
    /// CHECK: The view's permission, at the one address the permission program derives for it.
    #[account(
        mut,
        seeds = [PERMISSION_SEED, view.key().as_ref()],
        bump,
        seeds::program = PERMISSION_PROGRAM_ID
    )]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: The permission program, by its fixed address.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: The rollup's rent vault, by its fixed address.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: The magic program, by its fixed address.
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

/// Creates the owner's view with its owner-only permission and its four order keys,
/// all at once, so the view is never readable by anyone else and never exists without
/// its keys. RULES 12: it takes no seat; the first deposit does.
pub fn open_trader(mut ctx: Context<OpenTrader>, order_keys: [Pubkey; ORDER_KEYS]) -> Result<()> {
    let accounts = &mut ctx.accounts;
    open_trader_core(
        &mut accounts.exchange,
        &accounts.view,
        &accounts.permission,
        &accounts.permission_program,
        &accounts.vault,
        &accounts.magic_program,
        &accounts.owner.key(),
        ctx.bumps.view,
        order_keys,
    )
}

#[derive(Accounts)]
pub struct OpenTraderSigned<'info> {
    #[account(address = exchange.gate @ OrderbookError::GateMissing)]
    pub gate: Signer<'info>,
    /// CHECK: Bound to the verified Ed25519 public key and view seeds.
    pub owner: UncheckedAccount<'info>,
    #[account(mut, seeds = [EXCHANGE_SEED], bump = exchange.bump)]
    pub exchange: Account<'info, Exchange>,
    /// CHECK: Created for the verified owner.
    #[account(mut, seeds = [VIEW_SEED, owner.key().as_ref()], bump)]
    pub view: UncheckedAccount<'info>,
    /// CHECK: Derived for the view.
    #[account(mut, seeds = [PERMISSION_SEED, view.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: Fixed program address.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: Fixed rollup account.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: Fixed program address.
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
    /// CHECK: Fixed instructions sysvar address.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
}

pub fn open_trader_signed(
    mut ctx: Context<OpenTraderSigned>,
    order_keys: [Pubkey; ORDER_KEYS],
    expires_at: i64,
) -> Result<()> {
    owner_auth::check_expiry(expires_at)?;
    let owner = ctx.accounts.owner.key();
    let message = owner_auth::message(true, &owner, &order_keys, None, expires_at);
    owner_auth::verify(
        &ctx.accounts.instructions.to_account_info(),
        &owner,
        message.as_bytes(),
    )?;
    let accounts = &mut ctx.accounts;
    open_trader_core(
        &mut accounts.exchange,
        &accounts.view,
        &accounts.permission,
        &accounts.permission_program,
        &accounts.vault,
        &accounts.magic_program,
        &owner,
        ctx.bumps.view,
        order_keys,
    )
}

#[allow(clippy::too_many_arguments)]
fn open_trader_core<'info>(
    exchange: &mut Account<'info, Exchange>,
    view_info: &AccountInfo<'info>,
    permission: &AccountInfo<'info>,
    permission_program: &AccountInfo<'info>,
    vault: &AccountInfo<'info>,
    magic_program: &AccountInfo<'info>,
    owner: &Pubkey,
    view_bump: u8,
    order_keys: [Pubkey; ORDER_KEYS],
) -> Result<()> {
    require!(!exchange.paused, OrderbookError::ExchangePaused);
    // Security: the exchange pays for every view, and every seat needs one, so a
    // stolen gate key is held to a daily number of them.
    let now = Clock::get()?.unix_timestamp;
    exchange.count_new_seat(now)?;
    check_order_keys(owner, &order_keys)?;

    ephemeral::create::<ViewData>(exchange, view_info, vault, Scope::Owner(owner), view_bump)?;
    ephemeral::reserve_for_owner::<ViewData>(
        exchange,
        view_info,
        &PermissionAccounts {
            permission,
            permission_program,
            vault,
            magic_program,
        },
        owner,
        view_bump,
    )?;

    finalize::<ViewData>(view_info, Scope::Owner(owner), |view| {
        view.owner = owner.to_bytes();
        replace_keys(view, &order_keys)?;
        unseat(view);
        view.owner_nonce = 0;
        view.used = 0;
        Ok(())
    })
}

#[derive(Accounts)]
pub struct OwnView<'info> {
    pub owner: Signer<'info>,
    /// CHECK: Checked by the loader against its seeds, tag, size and readiness.
    #[account(mut, seeds = [VIEW_SEED, owner.key().as_ref()], bump)]
    pub view: UncheckedAccount<'info>,
}

/// Replaces all four order keys. The way back in after a key leaked.
pub fn set_order_keys(ctx: Context<OwnView>, order_keys: [Pubkey; ORDER_KEYS]) -> Result<()> {
    let owner = ctx.accounts.owner.key();
    let mut view = load_mut::<ViewData>(&ctx.accounts.view, Scope::Owner(&owner))?;
    require!(view.owner == owner.to_bytes(), OrderbookError::NotViewOwner);
    reset_order_keys(&mut view, &order_keys)
}

#[derive(Accounts)]
pub struct OwnViewSigned<'info> {
    /// CHECK: Bound to the view and verified proof.
    pub owner: UncheckedAccount<'info>,
    /// CHECK: Checked by the loader.
    #[account(mut, seeds = [VIEW_SEED, owner.key().as_ref()], bump)]
    pub view: UncheckedAccount<'info>,
    /// CHECK: Fixed instructions sysvar address.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
}

pub fn set_order_keys_signed(
    ctx: Context<OwnViewSigned>,
    order_keys: [Pubkey; ORDER_KEYS],
    nonce: u32,
    expires_at: i64,
) -> Result<()> {
    owner_auth::check_expiry(expires_at)?;
    let owner = ctx.accounts.owner.key();
    let message = owner_auth::message(false, &owner, &order_keys, Some(nonce), expires_at);
    owner_auth::verify(&ctx.accounts.instructions, &owner, message.as_bytes())?;
    let mut view = load_mut::<ViewData>(&ctx.accounts.view, Scope::Owner(&owner))?;
    require!(view.owner == owner.to_bytes(), OrderbookError::NotViewOwner);
    require!(view.owner_nonce == nonce, OrderbookError::WrongOwnerNonce);
    reset_order_keys(&mut view, &order_keys)
}

#[derive(Accounts)]
pub struct CloseTrader<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [EXCHANGE_SEED], bump = exchange.bump)]
    pub exchange: Account<'info, Exchange>,
    /// CHECK: Checked by the loader against its seeds, tag, size and readiness.
    #[account(mut, seeds = [LEDGER_SEED], bump)]
    pub ledger: UncheckedAccount<'info>,
    /// CHECK: Checked by the loader against its seeds, tag, size and readiness.
    #[account(mut, seeds = [VIEW_SEED, owner.key().as_ref()], bump)]
    pub view: UncheckedAccount<'info>,
    /// CHECK: The view's permission, at the one address the permission program derives for it.
    #[account(
        mut,
        seeds = [PERMISSION_SEED, view.key().as_ref()],
        bump,
        seeds::program = PERMISSION_PROGRAM_ID
    )]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: The permission program, by its fixed address.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: The rollup's rent vault, by its fixed address.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: The magic program, by its fixed address.
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

/// Closes the owner's seat if the view holds one, then the view and its permission. The
/// rent goes back to the exchange. Security: a seat that holds anything is refused with
/// `SeatNotEmpty`, so a funded seat is never cut off from its view. A view that holds no
/// seat, or whose seat was released and maybe taken by another owner, touches no seat.
pub fn close_trader(ctx: Context<CloseTrader>) -> Result<()> {
    let accounts = &ctx.accounts;
    let owner = accounts.owner.key();
    {
        let view = load_mut::<ViewData>(&accounts.view, Scope::Owner(&owner))?;
        require!(view.owner == owner.to_bytes(), OrderbookError::NotViewOwner);
        let mut ledger = load_ledger_mut(&accounts.ledger)?;
        if is_seated(&view, &ledger.seats) {
            let mut seats = ledger.engine();
            close_seat(&mut seats, trader(&view)).map_err(engine)?;
        }
    }
    let permission = PermissionAccounts {
        permission: &accounts.permission,
        permission_program: &accounts.permission_program,
        vault: &accounts.vault,
        magic_program: &accounts.magic_program,
    };
    close_view(
        &accounts.exchange,
        &accounts.view,
        &permission,
        &owner,
        ctx.bumps.view,
    )
}

fn close_view<'info>(
    exchange: &Account<'info, Exchange>,
    view: &AccountInfo<'info>,
    permission: &PermissionAccounts<'_, 'info>,
    owner: &Pubkey,
    bump: u8,
) -> Result<()> {
    ephemeral::close_permission::<ViewData>(exchange, view, permission, Scope::Owner(owner), bump)?;
    ephemeral::close(exchange, view, permission.vault)
}

#[derive(Accounts)]
#[instruction(owner: Pubkey)]
pub struct CloseUnusedTrader<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [EXCHANGE_SEED],
        bump = exchange.bump,
        has_one = admin @ OrderbookError::NotAdmin
    )]
    pub exchange: Account<'info, Exchange>,
    /// CHECK: Checked by the loader against its seeds, tag, size and readiness.
    #[account(mut, seeds = [LEDGER_SEED], bump)]
    pub ledger: UncheckedAccount<'info>,
    /// CHECK: Checked by the loader against its seeds, tag, size and readiness.
    #[account(mut, seeds = [VIEW_SEED, owner.as_ref()], bump)]
    pub view: UncheckedAccount<'info>,
    /// CHECK: The view's permission, at the one address the permission program derives for it.
    #[account(
        mut,
        seeds = [PERMISSION_SEED, view.key().as_ref()],
        bump,
        seeds::program = PERMISSION_PROGRAM_ID
    )]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: The permission program, by its fixed address.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: The rollup's rent vault, by its fixed address.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: The magic program, by its fixed address.
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

/// The admin closes a view nobody ever used, and its permission, so views opened
/// through a stolen gate key give their rent back. Security: only a view that never took
/// a seat qualifies, so a view that ever took one, and may hold order keys its owner
/// still needs, stays its owner's to close, even when the sweep has since released the
/// seat.
pub fn close_unused_trader(ctx: Context<CloseUnusedTrader>, owner: Pubkey) -> Result<()> {
    let accounts = &ctx.accounts;
    {
        let view = load_mut::<ViewData>(&accounts.view, Scope::Owner(&owner))?;
        let ledger = load_ledger_mut(&accounts.ledger)?;
        require!(
            view.used == 0 && !is_seated(&view, &ledger.seats),
            OrderbookError::SeatUsed
        );
    }
    let permission = PermissionAccounts {
        permission: &accounts.permission,
        permission_program: &accounts.permission_program,
        vault: &accounts.vault,
        magic_program: &accounts.magic_program,
    };
    close_view(
        &accounts.exchange,
        &accounts.view,
        &permission,
        &owner,
        ctx.bumps.view,
    )
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub depositor: Signer<'info>,
    #[account(seeds = [EXCHANGE_SEED], bump = exchange.bump)]
    pub exchange: Account<'info, Exchange>,
    /// CHECK: Checked by the loader against its seeds, tag, size and readiness.
    #[account(mut, seeds = [LEDGER_SEED], bump)]
    pub ledger: UncheckedAccount<'info>,
    /// CHECK: The beneficiary's view. Its owner is read from its data and its
    /// address checked against that owner by the loader. Written when the deposit
    /// takes a seat.
    #[account(mut)]
    pub view: UncheckedAccount<'info>,
    /// CHECK: The token's custody authority, checked against its registered seeds. It never holds data.
    pub custody_authority: UncheckedAccount<'info>,
    /// CHECK: Compared with the registered custody account and read as an SPL token account.
    #[account(mut)]
    pub custody: UncheckedAccount<'info>,
    /// CHECK: Read as an SPL token account of the depositor.
    #[account(mut)]
    pub from: UncheckedAccount<'info>,
    /// CHECK: Must be the SPL Token program.
    pub token_program: UncheckedAccount<'info>,
}

/// RULES 11 and 12: credits a seat and moves the tokens into custody in one
/// instruction. The beneficiary is named by its view, whose address anyone
/// derives from the owner's key, so a depositor needs no seat number. Anyone
/// may deposit for any trader. A view that holds no seat takes one from the
/// free list with the deposit, which must then be collateral of at least the
/// exchange's `min_seat_deposit` (`SeatDepositTooSmall`), and a full table
/// refuses it (`SeatTableFull`); a view whose recorded seat is no longer its
/// owner's counts as holding none. Security: the fee seat and the insurance seat
/// have no view and are never taken or credited from here, so nobody but the
/// admin changes what the admin can collect or what insurance can pay.
///
/// RULES 11: the deposit is refused when custody would hold more than
/// `BALANCE_CAP` of the token afterwards, a fixed ceiling nothing configures.
/// Security: the tokens move first, then custody is checked against the
/// ceiling, and only then is the seat read and credited. So a depositor who
/// does not hold the amount is refused by the token program whatever the seat
/// holds, and the ceiling refusal speaks about the token's total. Every seat
/// holds less than custody does, so a seat's own balance limit never refuses a
/// credit (SECURITY.md, "What an observer can learn").
pub fn deposit_tokens(ctx: Context<Deposit>, asset: AssetKind, amount: u64) -> Result<()> {
    let accounts = &ctx.accounts;
    let (token_index, pool) = asset.resolve(&accounts.exchange);
    let token = custody_leg(
        &accounts.exchange,
        token_index,
        &accounts.custody_authority,
        &accounts.custody,
        &accounts.token_program,
    )?;
    checked_holding(&accounts.from, &token.mint, accounts.depositor.key)?;

    transfer_in(
        &accounts.from,
        &accounts.custody,
        &accounts.depositor,
        amount,
    )?;
    require_within_ceiling(token_account(&accounts.custody)?.amount)?;
    let mut view = load_view_mut(&accounts.view)?;
    let mut ledger = load_ledger_mut(&accounts.ledger)?;
    let mut seats = ledger.engine();
    credit_view(
        accounts.exchange.min_seat_deposit,
        &mut view,
        &mut seats,
        pool,
        amount,
    )
}

/// Credits the view's seat, taking one first when the view holds none. Security: the
/// seat credited is the one `is_seated` proves is the view's owner's, never an index a
/// view merely records; and a take needs collateral of at least `min_seat_deposit`, so
/// a spot deposit or a dust one cannot fill the table.
pub(crate) fn credit_view(
    min_seat_deposit: u64,
    view: &mut ViewData,
    ledger: &mut LedgerMut<'_>,
    pool: Asset,
    amount: u64,
) -> Result<()> {
    let seated = is_seated(view, ledger.seats);
    let index = if seated {
        view.seat
    } else {
        require!(amount > 0, OrderbookError::ZeroAmount);
        require!(
            matches!(pool, Asset::Collateral) && amount >= min_seat_deposit,
            OrderbookError::SeatDepositTooSmall
        );
        take_seat(ledger, &view.owner).map_err(engine)?
    };
    deposit(ledger, index, pool, amount).map_err(engine)?;
    let seat = *ledger
        .seats
        .get(index as usize)
        .ok_or(OrderbookError::SeatOutOfRange)?;
    if seated {
        refresh_seat(view, index, &seat);
    } else {
        record_seat(view, index, &seat);
    }
    Ok(())
}

#[derive(Accounts)]
pub struct FundInsurance<'info> {
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
    /// CHECK: The token's custody authority, checked against its registered seeds. It never holds data.
    pub custody_authority: UncheckedAccount<'info>,
    /// CHECK: Compared with the registered custody account and read as an SPL token account.
    #[account(mut)]
    pub custody: UncheckedAccount<'info>,
    /// CHECK: Read as an SPL token account of the admin.
    #[account(mut)]
    pub from: UncheckedAccount<'info>,
    /// CHECK: Must be the SPL Token program.
    pub token_program: UncheckedAccount<'info>,
}

/// The admin adds collateral to the insurance seat, moving the same amount of
/// the collateral token from the admin's own token account into custody.
pub fn fund_insurance(ctx: Context<FundInsurance>, amount: u64) -> Result<()> {
    let accounts = &ctx.accounts;
    let token = custody_leg(
        &accounts.exchange,
        accounts.exchange.collateral_token,
        &accounts.custody_authority,
        &accounts.custody,
        &accounts.token_program,
    )?;
    checked_holding(&accounts.from, &token.mint, accounts.admin.key)?;

    let mut ledger = load_ledger_mut(&accounts.ledger)?;
    let mut seats = ledger.engine();
    deposit(&mut seats, INSURANCE_SEAT, Asset::Collateral, amount).map_err(engine)?;
    transfer_in(&accounts.from, &accounts.custody, &accounts.admin, amount)
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [EXCHANGE_SEED], bump = exchange.bump)]
    pub exchange: Account<'info, Exchange>,
    /// CHECK: Checked by the loader against its seeds, tag, size and readiness.
    #[account(mut, seeds = [LEDGER_SEED], bump)]
    pub ledger: UncheckedAccount<'info>,
    /// CHECK: Checked by the loader against its seeds, tag, size and readiness.
    #[account(mut, seeds = [VIEW_SEED, owner.key().as_ref()], bump)]
    pub view: UncheckedAccount<'info>,
    /// CHECK: The token's custody authority, checked against its registered seeds. It never holds data.
    pub custody_authority: UncheckedAccount<'info>,
    /// CHECK: Compared with the registered custody account and read as an SPL token account.
    #[account(mut)]
    pub custody: UncheckedAccount<'info>,
    /// CHECK: Read as an SPL token account of the owner.
    #[account(mut)]
    pub to: UncheckedAccount<'info>,
    /// CHECK: Must be the SPL Token program.
    pub token_program: UncheckedAccount<'info>,
}

/// RULES 6, 9 and 11: debits the seat if margin allows and pays the owner's
/// own token account out of custody in one instruction. The remaining
/// accounts are the other perp markets, as `risk.rs` describes.
pub fn withdraw_tokens(ctx: Context<Withdraw>, asset: AssetKind, amount: u64) -> Result<()> {
    let accounts = &ctx.accounts;
    let owner = accounts.owner.key();
    withdraw_core(
        &accounts.exchange,
        &accounts.ledger,
        &accounts.view,
        &accounts.custody_authority,
        &accounts.custody,
        &accounts.to,
        &accounts.token_program,
        ctx.remaining_accounts,
        &owner,
        false,
        asset,
        amount,
    )
}

#[derive(Accounts)]
pub struct WithdrawByKey<'info> {
    pub order_key: Signer<'info>,
    #[account(seeds = [EXCHANGE_SEED], bump = exchange.bump)]
    pub exchange: Account<'info, Exchange>,
    /// CHECK: Checked by the loader.
    #[account(mut, seeds = [LEDGER_SEED], bump)]
    pub ledger: UncheckedAccount<'info>,
    /// CHECK: The loader derives its address from its stored owner.
    #[account(mut)]
    pub view: UncheckedAccount<'info>,
    /// CHECK: Checked against registered custody seeds.
    pub custody_authority: UncheckedAccount<'info>,
    /// CHECK: Checked against registered custody.
    #[account(mut)]
    pub custody: UncheckedAccount<'info>,
    /// CHECK: Must be the owner's associated token account.
    #[account(mut)]
    pub to: UncheckedAccount<'info>,
    /// CHECK: Checked by custody_leg.
    pub token_program: UncheckedAccount<'info>,
}

/// RULES 3.0 and 11: expiry is accepted before the key is consumed. A refusal
/// rolls back the key swap along with the seat and custody changes.
pub fn withdraw_tokens_by_key(
    ctx: Context<WithdrawByKey>,
    expires_at: i64,
    replacement: Pubkey,
    asset: AssetKind,
    amount: u64,
) -> Result<()> {
    now_before(expires_at)?;
    let owner = {
        let mut view = crate::loader::load_view_mut(&ctx.accounts.view)?;
        use_order_key(&mut view, ctx.accounts.order_key.key, &replacement)?;
        Pubkey::new_from_array(view.owner)
    };
    let accounts = &ctx.accounts;
    withdraw_core(
        &accounts.exchange,
        &accounts.ledger,
        &accounts.view,
        &accounts.custody_authority,
        &accounts.custody,
        &accounts.to,
        &accounts.token_program,
        ctx.remaining_accounts,
        &owner,
        true,
        asset,
        amount,
    )
}

#[allow(clippy::too_many_arguments)]
fn withdraw_core<'info>(
    exchange: &Account<'info, Exchange>,
    ledger_info: &AccountInfo<'info>,
    view_info: &AccountInfo<'info>,
    custody_authority: &AccountInfo<'info>,
    custody: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    remaining: &[AccountInfo],
    owner: &Pubkey,
    require_ata: bool,
    asset: AssetKind,
    amount: u64,
) -> Result<()> {
    let (token_index, pool) = asset.resolve(exchange);
    let token = custody_leg(
        exchange,
        token_index,
        custody_authority,
        custody,
        token_program,
    )?;
    checked_holding(to, &token.mint, owner)?;
    if require_ata {
        require_keys_eq!(
            *to.key,
            associated_token_address(owner, &token.mint),
            OrderbookError::WrongWithdrawDestination
        );
    }

    let mut risk = RiskTable::new();
    risk.add_remaining(remaining)?;
    risk.require_all(exchange.perp_markets)?;
    let env = env(exchange, Clock::get()?.unix_timestamp, &risk.markets);
    {
        let mut view = load_mut::<ViewData>(view_info, Scope::Owner(owner))?;
        require!(view.owner == owner.to_bytes(), OrderbookError::NotViewOwner);
        let mut ledger = load_ledger_mut(ledger_info)?;
        debit_view(&env, &mut view, &mut ledger.engine(), pool, amount)?;
    }
    transfer_out(custody, to, custody_authority, token, amount)
}

/// Debits the view's seat, and gives the seat back when that left it empty and unpinned.
/// Security: a view that does not hold the seat it records is refused with `NotSeated`
/// before the engine runs, so a withdrawal never touches another owner's seat.
pub(crate) fn debit_view(
    env: &Env<'_>,
    view: &mut ViewData,
    ledger: &mut LedgerMut<'_>,
    pool: Asset,
    amount: u64,
) -> Result<()> {
    let index = seated_index(view, ledger.seats)?;
    withdraw(ledger, env, trader(view), pool, amount).map_err(engine)?;
    if release_if_empty(ledger, index) {
        unseat(view);
        return Ok(());
    }
    let seat = *ledger
        .seats
        .get(index as usize)
        .ok_or(OrderbookError::SeatOutOfRange)?;
    refresh_seat(view, index, &seat);
    Ok(())
}

#[derive(Accounts)]
pub struct ReleaseEmptySeats<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [EXCHANGE_SEED], bump = exchange.bump)]
    pub exchange: Account<'info, Exchange>,
    /// CHECK: Checked by the loader against its seeds, tag, size and readiness.
    #[account(mut, seeds = [LEDGER_SEED], bump)]
    pub ledger: UncheckedAccount<'info>,
}

/// RULES 12: anyone may release the seats of `start..start + count` that hold nothing
/// and carry no list entry or block, so seats left empty by a view that was never
/// withdrawn from go back on the free list. The accounts are the same for every call
/// and the call returns nothing, so it tells nobody which seats it released. The owner
/// loses an index, not money: the next deposit takes another.
pub fn release_empty_seats(ctx: Context<ReleaseEmptySeats>, start: u32, count: u16) -> Result<()> {
    let accounts = &ctx.accounts;
    accounts.exchange.require_migrated()?;
    require!(
        (1..=RELEASE_SEATS_PER_CALL).contains(&count),
        OrderbookError::InvalidSettings
    );
    let mut ledger = load_ledger_mut(&accounts.ledger)?;
    engine_release_empty_seats(&mut ledger.engine(), start, count);
    Ok(())
}

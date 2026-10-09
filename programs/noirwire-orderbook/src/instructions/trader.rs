use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID};
use noirwire_orderbook_engine::{
    close_seat, deposit, open_seat, withdraw, Asset, Env, LedgerMut, INSURANCE_SEAT, RESERVED_SEATS,
};

use crate::custody::{
    checked_custody, checked_holding, require_token_program, transfer_in, transfer_out,
};
use crate::ephemeral::{self, PermissionAccounts};
use crate::errors::{engine, OrderbookError};
use crate::instructions::trading::{sha256, stated_owner};
use crate::loader::{finalize, load, load_mut, Scope};
use crate::risk::RiskTable;
use crate::state::{
    Exchange, LedgerData, ViewData, CUSTODY_SEED, EXCHANGE_SEED, LEDGER_SEED, ORDER_KEYS,
    PERMISSION_SEED, VIEW_SEED,
};
use crate::view::{check_order_keys, set_order_keys as replace_keys, trader};

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
    /// CHECK: Checked by the loader against its seeds, tag, size and readiness.
    #[account(mut, seeds = [LEDGER_SEED], bump)]
    pub ledger: UncheckedAccount<'info>,
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

/// Opens a seat and creates the owner's view with its owner-only permission
/// and its four order keys, all at once, so the view is never readable by
/// anyone else and never exists without its keys.
pub fn open_trader(ctx: Context<OpenTrader>, order_keys: [Pubkey; ORDER_KEYS]) -> Result<()> {
    require!(
        !ctx.accounts.exchange.paused,
        OrderbookError::ExchangePaused
    );
    // Security: the exchange pays for every seat, so a stolen gate key is held
    // to a daily number of them.
    let now = Clock::get()?.unix_timestamp;
    ctx.accounts.exchange.count_new_seat(now)?;
    let accounts = &ctx.accounts;
    let owner = accounts.owner.key();
    check_order_keys(&owner, &order_keys)?;

    ephemeral::create::<ViewData>(
        &accounts.exchange,
        &accounts.view,
        &accounts.vault,
        Scope::Owner(&owner),
        ctx.bumps.view,
    )?;
    ephemeral::reserve_for_owner::<ViewData>(
        &accounts.exchange,
        &accounts.view,
        &PermissionAccounts {
            permission: &accounts.permission,
            permission_program: &accounts.permission_program,
            vault: &accounts.vault,
            magic_program: &accounts.magic_program,
        },
        &owner,
        ctx.bumps.view,
    )?;

    let mut ledger_account = load_mut::<LedgerData>(&accounts.ledger, Scope::Global)?;
    let ledger = &mut *ledger_account;
    let seat = {
        let mut seats = LedgerMut {
            header: &mut ledger.header,
            seats: &mut ledger.seats,
        };
        open_seat(&mut seats, &owner.to_bytes()).map_err(engine)?
    };
    let seat_copy = ledger.seats[seat as usize];
    finalize::<ViewData>(&accounts.view, Scope::Owner(&owner), |view| {
        view.owner = owner.to_bytes();
        replace_keys(view, &order_keys)?;
        view.seat = seat;
        view.snapshot.seat = seat_copy;
        view.snapshot.seat_index = seat;
        view.opened_version = seat_copy.version;
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
    replace_keys(&mut view, &order_keys)
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

/// Closes an empty seat, then the view and its permission. The rent goes back
/// to the exchange.
pub fn close_trader(ctx: Context<CloseTrader>) -> Result<()> {
    let accounts = &ctx.accounts;
    let owner = accounts.owner.key();
    {
        let view = load_mut::<ViewData>(&accounts.view, Scope::Owner(&owner))?;
        require!(view.owner == owner.to_bytes(), OrderbookError::NotViewOwner);
        let mut ledger_account = load_mut::<LedgerData>(&accounts.ledger, Scope::Global)?;
        let ledger = &mut *ledger_account;
        let mut seats = LedgerMut {
            header: &mut ledger.header,
            seats: &mut ledger.seats,
        };
        close_seat(&mut seats, trader(&view)).map_err(engine)?;
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

/// The admin closes a seat nobody ever used, and its view and permission, so
/// seats opened through a stolen gate key give their rent and their place in
/// the table back. Security: only a seat whose version is still the one it
/// was opened with qualifies, so a seat that ever took a deposit, an order or
/// a transfer stays its owner's to close.
pub fn close_unused_trader(ctx: Context<CloseUnusedTrader>, owner: Pubkey) -> Result<()> {
    let accounts = &ctx.accounts;
    {
        let view = load_mut::<ViewData>(&accounts.view, Scope::Owner(&owner))?;
        let mut ledger_account = load_mut::<LedgerData>(&accounts.ledger, Scope::Global)?;
        let ledger = &mut *ledger_account;
        let seat = ledger
            .seats
            .get(view.seat as usize)
            .ok_or(OrderbookError::SeatOutOfRange)?;
        require!(
            seat.version == view.opened_version,
            OrderbookError::SeatUsed
        );
        let mut seats = LedgerMut {
            header: &mut ledger.header,
            seats: &mut ledger.seats,
        };
        close_seat(&mut seats, trader(&view)).map_err(engine)?;
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
    /// address checked against that owner by the loader. Only read.
    pub view: UncheckedAccount<'info>,
    /// CHECK: The address that owns every custody token account. It never holds data.
    #[account(seeds = [CUSTODY_SEED], bump)]
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

/// RULES 11: credits a seat and moves the tokens into custody in one
/// instruction. The beneficiary is named by its view, whose address anyone
/// derives from the owner's key, so a depositor needs no seat number. Anyone
/// may deposit for any trader. Security: the fee seat and the insurance seat
/// have no view and are refused besides, so nobody but the admin changes
/// what the admin can collect or what insurance can pay.
pub fn deposit_tokens(ctx: Context<Deposit>, asset: AssetKind, amount: u64) -> Result<()> {
    let accounts = &ctx.accounts;
    let seat = {
        let owner = stated_owner(&accounts.view)?;
        load::<ViewData>(&accounts.view, Scope::Owner(&owner))?.seat
    };
    require!(
        seat as usize >= RESERVED_SEATS,
        OrderbookError::ReservedSeat
    );
    require_token_program(&accounts.token_program)?;
    let (token_index, pool) = asset.resolve(&accounts.exchange);
    let token = accounts.exchange.token(token_index)?;
    let custody_authority = accounts.custody_authority.key();
    checked_custody(token, &custody_authority, &accounts.custody)?;
    checked_holding(&accounts.from, &token.mint, accounts.depositor.key)?;

    let mut ledger_account = load_mut::<LedgerData>(&accounts.ledger, Scope::Global)?;
    let ledger = &mut *ledger_account;
    let mut seats = LedgerMut {
        header: &mut ledger.header,
        seats: &mut ledger.seats,
    };
    deposit(&mut seats, seat, pool, amount).map_err(engine)?;
    transfer_in(
        &accounts.from,
        &accounts.custody,
        &accounts.depositor,
        amount,
    )
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
    /// CHECK: The address that owns every custody token account. It never holds data.
    #[account(seeds = [CUSTODY_SEED], bump)]
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
    require_token_program(&accounts.token_program)?;
    let token = accounts
        .exchange
        .token(accounts.exchange.collateral_token)?;
    let custody_authority = accounts.custody_authority.key();
    checked_custody(token, &custody_authority, &accounts.custody)?;
    checked_holding(&accounts.from, &token.mint, accounts.admin.key)?;

    let mut ledger_account = load_mut::<LedgerData>(&accounts.ledger, Scope::Global)?;
    let ledger = &mut *ledger_account;
    let mut seats = LedgerMut {
        header: &mut ledger.header,
        seats: &mut ledger.seats,
    };
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
    /// CHECK: The address that owns every custody token account. It never holds data.
    #[account(seeds = [CUSTODY_SEED], bump)]
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
    require_token_program(&accounts.token_program)?;
    let owner = accounts.owner.key();
    let (token_index, pool) = asset.resolve(&accounts.exchange);
    let token = accounts.exchange.token(token_index)?;
    let custody_authority = accounts.custody_authority.key();
    checked_custody(token, &custody_authority, &accounts.custody)?;
    checked_holding(&accounts.to, &token.mint, &owner)?;

    let mut risk = RiskTable::new();
    risk.add_remaining(ctx.remaining_accounts)?;
    risk.require_all(accounts.exchange.perp_markets)?;
    let env = Env {
        now: Clock::get()?.unix_timestamp,
        exchange_paused: accounts.exchange.paused,
        max_steps: u32::from(accounts.exchange.max_steps),
        markets: &risk.markets,
        hash: sha256,
    };
    {
        let mut view = load_mut::<ViewData>(&accounts.view, Scope::Owner(&owner))?;
        require!(view.owner == owner.to_bytes(), OrderbookError::NotViewOwner);
        let mut ledger_account = load_mut::<LedgerData>(&accounts.ledger, Scope::Global)?;
        let ledger = &mut *ledger_account;
        let seat = view.seat;
        {
            let mut seats = LedgerMut {
                header: &mut ledger.header,
                seats: &mut ledger.seats,
            };
            withdraw(&mut seats, &env, trader(&view), pool, amount).map_err(engine)?;
        }
        view.snapshot.seat = ledger.seats[seat as usize];
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

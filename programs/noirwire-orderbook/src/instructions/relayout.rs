use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID};

use crate::ephemeral::{self, PermissionAccounts};
use crate::errors::OrderbookError;
use crate::loader::{edit_unready_ledger, finalize_ledger, load_legacy_ledger, Scope};
use crate::relayout::{copy_seats, verify_copy, LEGACY_SEATS};
use crate::state::{
    Exchange, LedgerData, EXCHANGE_SEED, LAYOUT_V2, LEDGER_SEED, LEGACY_LEDGER_SEED, MIN_SEATS,
    PERMISSION_SEED, RELAYOUT_SEATS_PER_CALL,
};

#[derive(Accounts)]
pub struct CreateRelayoutLedger<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [EXCHANGE_SEED],
        bump = exchange.bump,
        has_one = admin @ OrderbookError::NotAdmin
    )]
    pub exchange: Account<'info, Exchange>,
    /// CHECK: Created here, inside the rollup.
    #[account(mut, seeds = [LEDGER_SEED], bump)]
    pub ledger: UncheckedAccount<'info>,
    /// CHECK: The ledger's permission, at the one address the permission program derives for it.
    #[account(
        mut,
        seeds = [PERMISSION_SEED, ledger.key().as_ref()],
        bump,
        seeds::program = PERMISSION_PROGRAM_ID
    )]
    pub ledger_permission: UncheckedAccount<'info>,
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

/// The relayout runs only on the paused exchange that `migrate_exchange` has moved to the
/// relayout layout, and never again once `finish_relayout` has switched it.
fn require_relayout_open(exchange: &Exchange) -> Result<()> {
    exchange.require_relayout()?;
    require!(exchange.paused, OrderbookError::RelayoutOutOfOrder);
    Ok(())
}

/// Creates the sealed ledger of 304-byte seats at its first growth step. It is grown to
/// its full size with `grow_account`, filled by `relayout_seats` and made usable by
/// `finish_relayout`.
pub fn create_relayout_ledger(ctx: Context<CreateRelayoutLedger>) -> Result<()> {
    let accounts = &ctx.accounts;
    require_relayout_open(&accounts.exchange)?;
    ephemeral::create::<LedgerData>(
        &accounts.exchange,
        &accounts.ledger,
        &accounts.vault,
        Scope::Global,
        ctx.bumps.ledger,
    )?;
    ephemeral::seal::<LedgerData>(
        &accounts.exchange,
        &accounts.ledger,
        &PermissionAccounts {
            permission: &accounts.ledger_permission,
            permission_program: &accounts.permission_program,
            vault: &accounts.vault,
            magic_program: &accounts.magic_program,
        },
        Scope::Global,
        ctx.bumps.ledger,
    )
}

#[derive(Accounts)]
pub struct RelayoutSeats<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [EXCHANGE_SEED],
        bump = exchange.bump,
        has_one = admin @ OrderbookError::NotAdmin
    )]
    pub exchange: Account<'info, Exchange>,
    /// CHECK: The ledger the exchange was first built with, checked by the loader against
    /// its seeds, tag, size and readiness. Only read.
    #[account(seeds = [LEGACY_LEDGER_SEED], bump)]
    pub legacy_ledger: UncheckedAccount<'info>,
    /// CHECK: The new ledger, checked by the loader against its seeds, tag and size, and
    /// not ready until `finish_relayout`.
    #[account(mut, seeds = [LEDGER_SEED], bump)]
    pub ledger: UncheckedAccount<'info>,
}

/// Copies the next `count` seats of the old ledger, from where the last call stopped,
/// into the same indices of the new one. Each seat is converted, converted back and
/// compared with the original before it is written, so a conversion bug cannot write.
/// Security: the old ledger is never written, so until `finish_relayout` the previous
/// program can still be put back.
pub fn relayout_seats(ctx: Context<RelayoutSeats>, count: u16) -> Result<()> {
    let accounts = ctx.accounts;
    require_relayout_open(&accounts.exchange)?;
    let start = usize::try_from(accounts.exchange.relayout_next)
        .map_err(|_| OrderbookError::MathOverflow)?;
    require!(start < LEGACY_SEATS, OrderbookError::RelayoutOutOfOrder);
    require!(
        (1..=RELAYOUT_SEATS_PER_CALL).contains(&count),
        OrderbookError::InvalidSettings
    );
    let end = start.saturating_add(usize::from(count)).min(LEGACY_SEATS);
    let legacy = load_legacy_ledger(&accounts.legacy_ledger)?;
    edit_unready_ledger(&accounts.ledger, |ledger| {
        copy_seats(&legacy.seats, ledger, start, end)
    })?;
    accounts.exchange.relayout_next =
        u32::try_from(end).map_err(|_| OrderbookError::MathOverflow)?;
    Ok(())
}

/// Once every seat is copied: proves the two ledgers hold the same totals and a whole
/// free list, stamps the new ledger ready, and switches the exchange to it. It is the
/// point of no return, so it runs only on the paused exchange.
pub fn finish_relayout(ctx: Context<RelayoutSeats>) -> Result<()> {
    let accounts = ctx.accounts;
    require_relayout_open(&accounts.exchange)?;
    let copied = usize::try_from(accounts.exchange.relayout_next)
        .map_err(|_| OrderbookError::MathOverflow)?;
    require!(copied == LEGACY_SEATS, OrderbookError::RelayoutIncomplete);
    let legacy = load_legacy_ledger(&accounts.legacy_ledger)?;
    finalize_ledger(&accounts.ledger, |ledger| {
        verify_copy(&legacy.seats, legacy.open_seats, ledger)
    })?;
    let exchange = &mut accounts.exchange;
    exchange.seat_capacity = u32::try_from(MIN_SEATS).map_err(|_| OrderbookError::MathOverflow)?;
    exchange.layout = LAYOUT_V2;
    exchange.relayout_next = 0;
    Ok(())
}

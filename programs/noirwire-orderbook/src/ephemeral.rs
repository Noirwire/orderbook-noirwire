use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::access_control::instructions::{
    CloseEphemeralPermissionCpi, CreateEphemeralPermissionCpi,
};
use ephemeral_rollups_sdk::access_control::structs::{
    EphemeralMembersArgs, Member, TX_BALANCES_FLAG, TX_LOGS_FLAG, TX_MESSAGE_FLAG,
};
use ephemeral_rollups_sdk::ephemeral_accounts::EphemeralAccount;

use crate::errors::OrderbookError;
use crate::loader::{write_header, Scope};
use crate::state::{Exchange, RollupAccount, GROWTH_STEP};

const OWNER_READS: u8 = TX_LOGS_FLAG | TX_MESSAGE_FLAG | TX_BALANCES_FLAG;

/// The accounts every permission call names besides the guarded account.
pub struct PermissionAccounts<'a, 'info> {
    pub permission: &'a AccountInfo<'info>,
    pub permission_program: &'a AccountInfo<'info>,
    pub vault: &'a AccountInfo<'info>,
    pub magic_program: &'a AccountInfo<'info>,
}

fn scope_extra<'a>(scope: &'a Scope<'a>) -> &'a [u8] {
    match scope {
        Scope::Global => &[],
        Scope::Market(id) => core::slice::from_ref(id),
        Scope::Owner(owner) => owner.as_ref(),
    }
}

/// Creates an account inside the rollup, paid by the exchange, and stamps its
/// header. An account above one growth step starts at one step and is grown.
pub fn create<'info, T: RollupAccount>(
    exchange: &Account<'info, Exchange>,
    account: &AccountInfo<'info>,
    vault: &AccountInfo<'info>,
    scope: Scope<'_>,
    bump: u8,
) -> Result<()> {
    require!(account.data_is_empty(), OrderbookError::AccountExists);
    let full = u32::try_from(T::LEN).map_err(|_| OrderbookError::MathOverflow)?;
    let initial = full.min(GROWTH_STEP);
    let sponsor_seeds = exchange.signer_seeds();
    let bump_bytes = [bump];
    let extra = scope_extra(&scope);
    let own_seeds: [&[u8]; 3] = [T::SEED, extra, &bump_bytes];
    EphemeralAccount::new(&exchange.to_account_info(), account, vault)
        .with_signer_seeds(&[&sponsor_seeds, &own_seeds])
        .create(initial)?;
    let market_id = match scope {
        Scope::Market(id) => id,
        _ => 0,
    };
    write_header::<T>(account, market_id, bump)
}

/// Grows an account by at most one step, never past its full size.
pub fn grow<'info>(
    exchange: &Account<'info, Exchange>,
    account: &AccountInfo<'info>,
    vault: &AccountInfo<'info>,
    full: usize,
    new_len: u32,
) -> Result<()> {
    let current = u32::try_from(account.data_len()).map_err(|_| OrderbookError::MathOverflow)?;
    let full = u32::try_from(full).map_err(|_| OrderbookError::MathOverflow)?;
    let one_step = new_len > current && new_len - current <= GROWTH_STEP && new_len <= full;
    require!(one_step, OrderbookError::InvalidGrowth);
    let sponsor_seeds = exchange.signer_seeds();
    EphemeralAccount::new(&exchange.to_account_info(), account, vault)
        .with_signer_seeds(&[&sponsor_seeds])
        .resize(new_len)?;
    Ok(())
}

/// Removes an account the exchange paid for. The rent returns to the exchange.
pub fn close<'info>(
    exchange: &Account<'info, Exchange>,
    account: &AccountInfo<'info>,
    vault: &AccountInfo<'info>,
) -> Result<()> {
    let sponsor_seeds = exchange.signer_seeds();
    EphemeralAccount::new(&exchange.to_account_info(), account, vault)
        .with_signer_seeds(&[&sponsor_seeds])
        .close()?;
    Ok(())
}

fn permit<'info, T: RollupAccount>(
    exchange: &Account<'info, Exchange>,
    account: &AccountInfo<'info>,
    accounts: &PermissionAccounts<'_, 'info>,
    scope: Scope<'_>,
    bump: u8,
    members: Vec<Member>,
) -> Result<()> {
    let sponsor_seeds = exchange.signer_seeds();
    let bump_bytes = [bump];
    let extra = scope_extra(&scope);
    let own_seeds: [&[u8]; 3] = [T::SEED, extra, &bump_bytes];
    CreateEphemeralPermissionCpi {
        payer: exchange.to_account_info(),
        permissioned_account: account.clone(),
        permission: accounts.permission.clone(),
        vault: accounts.vault.clone(),
        magic_program: accounts.magic_program.clone(),
        permission_program: accounts.permission_program.clone(),
        args: EphemeralMembersArgs {
            is_private: true,
            members,
        },
    }
    .invoke_signed(&[&sponsor_seeds, &own_seeds])?;
    Ok(())
}

/// A permission that is private with no members: only the program reads the
/// account, through the rollup; the query filter serves it to nobody.
pub fn seal<'info, T: RollupAccount>(
    exchange: &Account<'info, Exchange>,
    account: &AccountInfo<'info>,
    accounts: &PermissionAccounts<'_, 'info>,
    scope: Scope<'_>,
    bump: u8,
) -> Result<()> {
    permit::<T>(exchange, account, accounts, scope, bump, vec![])
}

/// A permission whose only member is the owner, so the query filter serves
/// the account to that key and to nobody else.
pub fn reserve_for_owner<'info, T: RollupAccount>(
    exchange: &Account<'info, Exchange>,
    account: &AccountInfo<'info>,
    accounts: &PermissionAccounts<'_, 'info>,
    owner: &Pubkey,
    bump: u8,
) -> Result<()> {
    let member = Member {
        flags: OWNER_READS,
        pubkey: *owner,
    };
    permit::<T>(
        exchange,
        account,
        accounts,
        Scope::Owner(owner),
        bump,
        vec![member],
    )
}

/// Removes a permission the exchange paid for. The guarded account signs as
/// its authority through its seeds.
pub fn close_permission<'info, T: RollupAccount>(
    exchange: &Account<'info, Exchange>,
    account: &AccountInfo<'info>,
    accounts: &PermissionAccounts<'_, 'info>,
    scope: Scope<'_>,
    bump: u8,
) -> Result<()> {
    let sponsor_seeds = exchange.signer_seeds();
    let bump_bytes = [bump];
    let extra = scope_extra(&scope);
    let own_seeds: [&[u8]; 3] = [T::SEED, extra, &bump_bytes];
    CloseEphemeralPermissionCpi {
        payer: exchange.to_account_info(),
        authority: account.clone(),
        permissioned_account: account.clone(),
        permission: accounts.permission.clone(),
        vault: accounts.vault.clone(),
        magic_program: accounts.magic_program.clone(),
        permission_program: accounts.permission_program.clone(),
        authority_is_signer: false,
    }
    .invoke_signed(&[&sponsor_seeds, &own_seeds])?;
    Ok(())
}

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::{invoke, invoke_signed};

use ephemeral_rollups_sdk::access_control::structs::{
    ACCOUNT_SIGNATURES_FLAG, TX_BALANCES_FLAG, TX_LOGS_FLAG, TX_MESSAGE_FLAG,
};
use ephemeral_rollups_sdk::consts::{ESPL_TOKEN_PROGRAM_ID, PERMISSION_PROGRAM_ID};

use crate::errors::OrderbookError;
use crate::state::{TokenInfo, PERMISSION_SEED};

pub const TOKEN_PROGRAM_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const ASSOCIATED_TOKEN_PROGRAM_ID: Pubkey =
    pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/// The SPL Token account layout, as far as this program reads it.
const TOKEN_ACCOUNT_LEN: usize = 165;
const MINT_OFFSET: usize = 0;
const OWNER_OFFSET: usize = 32;
const AMOUNT_OFFSET: usize = 64;
const STATE_OFFSET: usize = 108;
const STATE_INITIALIZED: u8 = 1;
const TRANSFER_INSTRUCTION: u8 = 3;

pub struct TokenAccount {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
}

/// Reads an SPL token account, refusing anything the token program does not own.
pub fn token_account(info: &AccountInfo) -> Result<TokenAccount> {
    require_keys_eq!(
        *info.owner,
        TOKEN_PROGRAM_ID,
        OrderbookError::WrongTokenProgram
    );
    let data = info.try_borrow_data()?;
    require!(
        data.len() >= TOKEN_ACCOUNT_LEN,
        OrderbookError::TokenAccountUninitialised
    );
    require!(
        data[STATE_OFFSET] == STATE_INITIALIZED,
        OrderbookError::TokenAccountUninitialised
    );
    let key = |at: usize| Pubkey::new_from_array(data[at..at + 32].try_into().unwrap());
    Ok(TokenAccount {
        mint: key(MINT_OFFSET),
        owner: key(OWNER_OFFSET),
        amount: u64::from_le_bytes(data[AMOUNT_OFFSET..AMOUNT_OFFSET + 8].try_into().unwrap()),
    })
}

/// The associated token account of `owner` for `mint`: where custody keeps a token.
pub fn associated_token_address(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[owner.as_ref(), TOKEN_PROGRAM_ID.as_ref(), mint.as_ref()],
        &ASSOCIATED_TOKEN_PROGRAM_ID,
    )
    .0
}

/// The custody token account of one registered token, checked on every call:
/// the address the exchange recorded, owned by the token program, holding the
/// registered mint, and owned by the custody authority.
pub fn checked_custody(
    token: &TokenInfo,
    custody_authority: &Pubkey,
    account: &AccountInfo,
) -> Result<TokenAccount> {
    require_keys_eq!(*account.key, token.custody, OrderbookError::WrongCustody);
    let parsed = token_account(account)?;
    require_keys_eq!(parsed.mint, token.mint, OrderbookError::WrongMint);
    require_keys_eq!(
        parsed.owner,
        *custody_authority,
        OrderbookError::WrongTokenAccountOwner
    );
    Ok(parsed)
}

/// The permission account layout, as the permission program writes it on
/// Solana: discriminator, bump, the guarded account, whether a member list is
/// present, the member count, then one flag byte and one key per member.
const PERMISSION_ACCOUNT_OFFSET: usize = 2;
const PERMISSION_PRIVATE_OFFSET: usize = 34;
const PERMISSION_COUNT_OFFSET: usize = 35;
const PERMISSION_MEMBERS_OFFSET: usize = 39;
const MEMBER_LEN: usize = 33;
const PRIVATE: u8 = 1;
const MEMBER_READS: u8 =
    TX_LOGS_FLAG | TX_BALANCES_FLAG | TX_MESSAGE_FLAG | ACCOUNT_SIGNATURES_FLAG;

/// Security: a custody balance anyone can read publishes the sum of every
/// seat's holdings of that token and every deposit and payout as it happens.
/// A token is registered only with a custody balance that is private.
///
/// A custody token account is the rollup's face of an ephemeral token balance,
/// and the permission guards that balance. `permission` must be the one
/// address the permission program derives for it, be owned by the permission
/// program, name that balance, be private, and list no member with any read
/// flag. The check is made once: every later change needs the custody
/// authority's signature, which this program gives to nothing but a token
/// transfer. SECURITY.md has the reasoning.
pub fn require_sealed_custody(
    custody_authority: &Pubkey,
    mint: &Pubkey,
    permission: &AccountInfo,
) -> Result<()> {
    let balance = require_custody_permission_address(custody_authority, mint, permission)?;
    require_keys_eq!(
        *permission.owner,
        PERMISSION_PROGRAM_ID,
        OrderbookError::CustodyNotPrivate
    );
    let data = permission.try_borrow_data()?;
    let sealed = data
        .get(PERMISSION_ACCOUNT_OFFSET..PERMISSION_PRIVATE_OFFSET)
        .is_some_and(|guarded| guarded == balance.as_ref())
        && data.get(PERMISSION_PRIVATE_OFFSET) == Some(&PRIVATE)
        && no_member_reads(&data);
    require!(sealed, OrderbookError::CustodyNotPrivate);
    Ok(())
}

/// A custody registered public must have no permission at all, so the
/// recorded visibility is true when it is recorded: `permission`, the one
/// address the permission program derives for the custody balance, holds
/// nothing and belongs to no program.
///
/// Security: this is checked once. Whether a permission can be attached to
/// the balance later is the token program's rule, not this program's.
pub fn require_public_custody(
    custody_authority: &Pubkey,
    mint: &Pubkey,
    permission: &AccountInfo,
) -> Result<()> {
    require_custody_permission_address(custody_authority, mint, permission)?;
    require!(
        permission.data_is_empty() && *permission.owner == anchor_lang::system_program::ID,
        OrderbookError::CustodyNotPublic
    );
    Ok(())
}

/// Checks `permission` is the permission address of the custody balance of
/// `mint`, and returns that balance's address.
fn require_custody_permission_address(
    custody_authority: &Pubkey,
    mint: &Pubkey,
    permission: &AccountInfo,
) -> Result<Pubkey> {
    let (balance, _) = Pubkey::find_program_address(
        &[custody_authority.as_ref(), mint.as_ref()],
        &ESPL_TOKEN_PROGRAM_ID,
    );
    let (expected, _) =
        Pubkey::find_program_address(&[PERMISSION_SEED, balance.as_ref()], &PERMISSION_PROGRAM_ID);
    require_keys_eq!(*permission.key, expected, OrderbookError::WrongDerivation);
    Ok(balance)
}

fn no_member_reads(data: &[u8]) -> bool {
    let Some(count) = data
        .get(PERMISSION_COUNT_OFFSET..PERMISSION_MEMBERS_OFFSET)
        .and_then(|bytes| bytes.try_into().ok())
        .map(u32::from_le_bytes)
    else {
        return false;
    };
    let Some(members) = usize::try_from(count)
        .ok()
        .and_then(|count| count.checked_mul(MEMBER_LEN))
        .and_then(|len| PERMISSION_MEMBERS_OFFSET.checked_add(len))
        .and_then(|end| data.get(PERMISSION_MEMBERS_OFFSET..end))
    else {
        return false;
    };
    members
        .chunks_exact(MEMBER_LEN)
        .all(|member| member[0] & MEMBER_READS == 0)
}

/// A token account of `mint` that `owner` controls, as the counterparty of a
/// deposit or a payout.
pub fn checked_holding(
    account: &AccountInfo,
    mint: &Pubkey,
    owner: &Pubkey,
) -> Result<TokenAccount> {
    let parsed = token_account(account)?;
    require_keys_eq!(parsed.mint, *mint, OrderbookError::WrongMint);
    require_keys_eq!(parsed.owner, *owner, OrderbookError::WrongTokenAccountOwner);
    Ok(parsed)
}

pub fn require_token_program(program: &AccountInfo) -> Result<()> {
    require_keys_eq!(
        *program.key,
        TOKEN_PROGRAM_ID,
        OrderbookError::WrongTokenProgram
    );
    Ok(())
}

fn transfer_instruction(
    from: &Pubkey,
    to: &Pubkey,
    authority: &Pubkey,
    amount: u64,
) -> Instruction {
    let mut data = Vec::with_capacity(9);
    data.push(TRANSFER_INSTRUCTION);
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*from, false),
            AccountMeta::new(*to, false),
            AccountMeta::new_readonly(*authority, true),
        ],
        data,
    }
}

/// Moves tokens the signing depositor holds into custody.
pub fn transfer_in<'info>(
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    depositor: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    invoke(
        &transfer_instruction(from.key, to.key, depositor.key, amount),
        &[from.clone(), to.clone(), depositor.clone()],
    )?;
    Ok(())
}

/// Pays tokens out of custody. Only the custody authority's seeds can sign it,
/// so a payout happens only where this program decides one.
pub fn transfer_out<'info>(
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    custody_authority: &AccountInfo<'info>,
    custody_seeds: &[&[u8]],
    amount: u64,
) -> Result<()> {
    invoke_signed(
        &transfer_instruction(from.key, to.key, custody_authority.key, amount),
        &[from.clone(), to.clone(), custody_authority.clone()],
        &[custody_seeds],
    )?;
    Ok(())
}

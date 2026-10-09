use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::{invoke, invoke_signed};

use crate::errors::OrderbookError;
use crate::state::TokenInfo;

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

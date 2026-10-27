use anchor_lang::prelude::*;
use solana_instructions_sysvar as instructions;
use solana_sdk_ids::ed25519_program;

use crate::errors::OrderbookError;
use crate::state::ORDER_KEYS;

pub const MAX_OWNER_EXPIRY_AHEAD: i64 = 120;
const ED_HEADER: usize = 16;
const SIGNATURE_OFFSET: usize = ED_HEADER + 32;
const MESSAGE_OFFSET: usize = SIGNATURE_OFFSET + 64;

pub fn check_expiry(expires_at: i64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    check_expiry_at(now, expires_at)
}

fn check_expiry_at(now: i64, expires_at: i64) -> Result<()> {
    require!(now <= expires_at, OrderbookError::Expired);
    let ahead = expires_at
        .checked_sub(now)
        .ok_or(OrderbookError::MathOverflow)?;
    require!(
        ahead <= MAX_OWNER_EXPIRY_AHEAD,
        OrderbookError::OwnerExpiryTooFar
    );
    Ok(())
}

pub fn message(
    open: bool,
    owner: &Pubkey,
    keys: &[Pubkey; ORDER_KEYS],
    nonce: Option<u32>,
    expires_at: i64,
) -> String {
    let action = if open {
        "open trading account"
    } else {
        "replace order keys"
    };
    let mut text = format!(
        "NoirWire: {action}\nprogram {}\nowner {owner}\nkeys {} {} {} {}",
        crate::ID,
        keys[0],
        keys[1],
        keys[2],
        keys[3]
    );
    if let Some(nonce) = nonce {
        text.push_str(&format!("\nnonce {nonce}"));
    }
    text.push_str(&format!("\nexpires {expires_at}"));
    text
}

fn read_u16(data: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(data.get(at..at + 2)?.try_into().ok()?))
}

/// RULES 3.0: only the immediately preceding, self-contained Ed25519 proof
/// can authorize an owner action. Its public key and message are bound here.
pub fn verify(sysvar: &AccountInfo, owner: &Pubkey, expected: &[u8]) -> Result<()> {
    let current = instructions::load_current_index_checked(sysvar)
        .map_err(|_| OrderbookError::InvalidOwnerProof)?;
    let previous = current
        .checked_sub(1)
        .ok_or(OrderbookError::InvalidOwnerProof)?;
    let instruction = instructions::load_instruction_at_checked(previous as usize, sysvar)
        .map_err(|_| OrderbookError::InvalidOwnerProof)?;
    require_keys_eq!(
        instruction.program_id,
        ed25519_program::ID,
        OrderbookError::InvalidOwnerProof
    );
    verify_data(&instruction.data, owner, expected)
}

fn verify_data(data: &[u8], owner: &Pubkey, expected: &[u8]) -> Result<()> {
    require!(
        data.len() == MESSAGE_OFFSET + expected.len()
            && data[0] == 1
            && data[1] == 0
            && read_u16(data, 2) == Some(SIGNATURE_OFFSET as u16)
            && read_u16(data, 4) == Some(u16::MAX)
            && read_u16(data, 6) == Some(ED_HEADER as u16)
            && read_u16(data, 8) == Some(u16::MAX)
            && read_u16(data, 10) == Some(MESSAGE_OFFSET as u16)
            && read_u16(data, 12) == Some(expected.len() as u16)
            && read_u16(data, 14) == Some(u16::MAX)
            && data.get(ED_HEADER..SIGNATURE_OFFSET) == Some(owner.as_ref())
            && data.get(MESSAGE_OFFSET..) == Some(expected),
        OrderbookError::InvalidOwnerProof
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::solana_program::instruction::BorrowedInstruction;
    use solana_instructions_sysvar::{construct_instructions_data, store_current_index_checked};

    fn proof(owner: &Pubkey, message: &[u8]) -> Vec<u8> {
        let mut data = vec![0; MESSAGE_OFFSET + message.len()];
        data[0] = 1;
        for (at, value) in [
            (2, SIGNATURE_OFFSET as u16),
            (4, u16::MAX),
            (6, ED_HEADER as u16),
            (8, u16::MAX),
            (10, MESSAGE_OFFSET as u16),
            (12, message.len() as u16),
            (14, u16::MAX),
        ] {
            data[at..at + 2].copy_from_slice(&value.to_le_bytes());
        }
        data[ED_HEADER..SIGNATURE_OFFSET].copy_from_slice(owner.as_ref());
        data[MESSAGE_OFFSET..].copy_from_slice(message);
        data
    }

    fn verify_sequence(
        programs: &[Pubkey],
        proof_data: &[u8],
        current: u16,
        owner: &Pubkey,
        message: &[u8],
    ) -> bool {
        let payloads: Vec<&[u8]> = programs
            .iter()
            .enumerate()
            .map(|(at, _)| if at == 0 { proof_data } else { &[] })
            .collect();
        let borrowed: Vec<BorrowedInstruction> = programs
            .iter()
            .zip(payloads)
            .map(|(program_id, data)| BorrowedInstruction {
                program_id,
                accounts: vec![],
                data,
            })
            .collect();
        let mut data = construct_instructions_data(&borrowed);
        store_current_index_checked(&mut data, current).unwrap();
        let key = instructions::ID;
        let sysvar_owner = solana_sdk_ids::sysvar::ID;
        let mut lamports = 0;
        let info = AccountInfo::new(
            &key,
            false,
            false,
            &mut lamports,
            &mut data,
            &sysvar_owner,
            false,
        );
        verify(&info, owner, message).is_ok()
    }

    #[test]
    fn proof_requires_adjacent_canonical_owner_and_message() {
        let owner = Pubkey::new_unique();
        let other = Pubkey::new_unique();
        let message = b"exact owner action";
        let ed = ed25519_program::ID;
        let program = crate::ID;
        let valid = proof(&owner, message);
        assert!(verify_sequence(&[ed, program], &valid, 1, &owner, message));
        assert!(!verify_sequence(&[ed, program], &valid, 1, &other, message));
        assert!(!verify_sequence(
            &[ed, program],
            &valid,
            1,
            &owner,
            b"wrong message"
        ));
        assert!(!verify_sequence(&[program], &valid, 0, &owner, message));
        assert!(!verify_sequence(
            &[ed, program, program],
            &valid,
            2,
            &owner,
            message
        ));
        let mut two = valid.clone();
        two[0] = 2;
        assert!(!verify_sequence(&[ed, program], &two, 1, &owner, message));
        let mut cross = valid;
        cross[4..6].copy_from_slice(&1u16.to_le_bytes());
        assert!(!verify_sequence(&[ed, program], &cross, 1, &owner, message));
    }

    #[test]
    fn owner_expiry_boundaries() {
        assert!(check_expiry_at(1_000, 1_000).is_ok());
        assert!(check_expiry_at(1_000, 1_120).is_ok());
        assert!(check_expiry_at(1_000, 999).is_err());
        assert!(check_expiry_at(1_000, 1_121).is_err());
    }

    #[test]
    fn message_vectors_match_the_client() {
        let owner = Pubkey::new_from_array([1; 32]);
        let keys = [2, 3, 4, 5].map(|byte| Pubkey::new_from_array([byte; 32]));
        for (open, nonce, expected) in [
            (
                true,
                None,
                "78b22efd8b43797377c045292134f6706b22b76dd99ef92a09b6b6dfb5a6aaf6",
            ),
            (
                false,
                Some(u32::MAX),
                "4a73fa6da661e1f231533a4431b87bdef8f0dbbef84658b5fe2013ad8b652511",
            ),
        ] {
            let text = message(open, &owner, &keys, nonce, 1_800_000_000);
            let digest = solana_sha256_hasher::hash(text.as_bytes());
            let hex: String = digest
                .to_bytes()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect();
            assert_eq!(hex, expected);
        }
    }
}

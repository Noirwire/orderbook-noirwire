use anchor_lang::prelude::*;
use solana_instructions_sysvar as instructions;
use solana_sdk_ids::ed25519_program;

use crate::errors::OrderbookError;
use crate::state::ORDER_KEYS;

pub const MAX_OWNER_EXPIRY_AHEAD: i64 = 120;
const ED_HEADER: usize = 16;
const SIGNATURE_OFFSET: usize = ED_HEADER + 32;
const MESSAGE_OFFSET: usize = SIGNATURE_OFFSET + 64;
const OFFCHAIN_DOMAIN: &[u8] = b"\xffsolana offchain";
const OFFCHAIN_VERSION: u8 = 0;
const OFFCHAIN_LIMITED_UTF8: u8 = 1;
const OFFCHAIN_HEADER: usize = OFFCHAIN_DOMAIN.len() + 4;
/// The Anza off-chain message header's version 0 carries the application
/// domain, the signer count and the signers between the version and the
/// format, so its header is longer by those.
const OFFCHAIN_SPEC_HEADER: usize = OFFCHAIN_DOMAIN.len() + 1 + 32 + 1 + 1 + 32 + 2;

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

/// The bytes a hardware wallet signs for `text`: the Solana off-chain message
/// format, version 0, the limited UTF-8 format (the text has line breaks, so it
/// is not restricted ASCII), then the length as two little-endian bytes.
fn envelope(text: &[u8]) -> Option<Vec<u8>> {
    let length = u16::try_from(text.len()).ok()?;
    let mut bytes = Vec::with_capacity(OFFCHAIN_HEADER + text.len());
    bytes.extend_from_slice(OFFCHAIN_DOMAIN);
    bytes.extend_from_slice(&[OFFCHAIN_VERSION, OFFCHAIN_LIMITED_UTF8]);
    bytes.extend_from_slice(&length.to_le_bytes());
    bytes.extend_from_slice(text);
    Some(bytes)
}

/// The same text in the Anza off-chain message format's version 0 header:
/// the signing domain, the version, the application domain (this program's
/// id), the message format, one signer (the owner), then the length.
fn spec_envelope(text: &[u8], owner: &Pubkey) -> Option<Vec<u8>> {
    let length = u16::try_from(text.len()).ok()?;
    let mut bytes = Vec::with_capacity(OFFCHAIN_SPEC_HEADER + text.len());
    bytes.extend_from_slice(OFFCHAIN_DOMAIN);
    bytes.push(OFFCHAIN_VERSION);
    bytes.extend_from_slice(crate::ID.as_ref());
    bytes.extend_from_slice(&[OFFCHAIN_LIMITED_UTF8, 1]);
    bytes.extend_from_slice(owner.as_ref());
    bytes.extend_from_slice(&length.to_le_bytes());
    bytes.extend_from_slice(text);
    Some(bytes)
}

fn verify_data(data: &[u8], owner: &Pubkey, expected: &[u8]) -> Result<()> {
    let signed = data.get(MESSAGE_OFFSET..).unwrap_or_default();
    let wrapped = envelope(expected);
    let spec = spec_envelope(expected, owner);
    require!(
        data.len() >= MESSAGE_OFFSET
            && data[0] == 1
            && data[1] == 0
            && read_u16(data, 2) == Some(SIGNATURE_OFFSET as u16)
            && read_u16(data, 4) == Some(u16::MAX)
            && read_u16(data, 6) == Some(ED_HEADER as u16)
            && read_u16(data, 8) == Some(u16::MAX)
            && read_u16(data, 10) == Some(MESSAGE_OFFSET as u16)
            && read_u16(data, 12) == u16::try_from(signed.len()).ok()
            && read_u16(data, 14) == Some(u16::MAX)
            && data.get(ED_HEADER..SIGNATURE_OFFSET) == Some(owner.as_ref())
            && (signed == expected
                || wrapped.as_deref() == Some(signed)
                || spec.as_deref() == Some(signed)),
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
    fn proof_accepts_the_off_chain_envelope_of_exactly_the_text() {
        let owner = Pubkey::new_unique();
        let text = b"NoirWire: exact\nowner action";
        let accepts = |signed: &[u8]| verify_data(&proof(&owner, signed), &owner, text).is_ok();
        let wrapped = envelope(text).unwrap();
        assert!(accepts(text));
        assert!(accepts(&wrapped));
        assert_eq!(&wrapped[..17], b"\xffsolana offchain\0");
        assert_eq!(wrapped[17], 1);
        assert_eq!(wrapped[18..20], (text.len() as u16).to_le_bytes());

        let other = envelope(b"NoirWire: other\nowner action").unwrap();
        assert!(!accepts(&other));

        for (at, byte) in [(0, 0xfe), (16, 1), (17, 0), (17, 2), (18, 0), (19, 9)] {
            let mut bad = wrapped.clone();
            bad[at] = byte;
            assert!(!accepts(&bad), "header byte {at}");
        }
        let mut trailing = wrapped.clone();
        trailing.push(b'\n');
        assert!(!accepts(&trailing));
        assert!(!accepts(&wrapped[..wrapped.len() - 1]));
        assert!(!accepts(&envelope(&wrapped).unwrap()));
        assert!(!accepts(&[]));

        let mut shifted = proof(&owner, &wrapped);
        shifted[12..14].copy_from_slice(&(text.len() as u16).to_le_bytes());
        assert!(verify_data(&shifted, &owner, text).is_err());
    }

    #[test]
    fn proof_accepts_the_spec_header_of_exactly_the_text_and_its_one_signer() {
        let owner = Pubkey::new_unique();
        let text = b"NoirWire: exact\nowner action";
        let accepts = |signed: &[u8]| verify_data(&proof(&owner, signed), &owner, text).is_ok();
        let spec = spec_envelope(text, &owner).unwrap();
        assert!(accepts(&spec));
        assert_eq!(spec.len(), OFFCHAIN_SPEC_HEADER + text.len());
        assert_eq!(&spec[..16], b"\xffsolana offchain");
        assert_eq!(spec[16], 0);
        assert_eq!(&spec[17..49], crate::ID.as_ref());
        assert_eq!(spec[49], OFFCHAIN_LIMITED_UTF8);
        assert_eq!(spec[50], 1);
        assert_eq!(&spec[51..83], owner.as_ref());
        assert_eq!(spec[83..85], (text.len() as u16).to_le_bytes());

        let other = Pubkey::new_unique();
        assert!(!accepts(&spec_envelope(text, &other).unwrap()));
        assert!(!accepts(
            &spec_envelope(b"NoirWire: other\nowner action", &owner).unwrap()
        ));
        for (at, flip) in [
            (0, 1),
            (16, 1),
            (17, 1),
            (48, 1),
            (49, 1),
            (49, 3),
            (50, 1),
            (50, 3),
            (51, 1),
            (82, 1),
            (83, 1),
        ] {
            let mut bad = spec.clone();
            bad[at] ^= flip;
            assert!(!accepts(&bad), "header byte {at}");
        }
        let mut trailing = spec.clone();
        trailing.push(b'\n');
        assert!(!accepts(&trailing));
        assert!(!accepts(&spec[..spec.len() - 1]));
        assert!(!accepts(&spec_envelope(&spec, &owner).unwrap()));
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

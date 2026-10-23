//! The upgradeable loader's program and program data accounts, read by hand.
//!
//! Anchor reads them with bincode, which brings serde's error formatting, and
//! with it float printing, into the program for two fixed layouts. These
//! readers accept and refuse exactly the bytes bincode does, with the same
//! errors, so `initialize_exchange` behaves as it did with Anchor's types.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::bpf_loader_upgradeable;

const UNINITIALIZED: u32 = 0;
const BUFFER: u32 = 1;
const PROGRAM: u32 = 2;
const PROGRAM_DATA: u32 = 3;

/// The upgradeable loader's account states, as far as this program reads them.
#[derive(Debug, PartialEq, Eq)]
enum LoaderState {
    Uninitialized,
    Buffer,
    Program {
        programdata_address: Pubkey,
    },
    ProgramData {
        slot: u64,
        upgrade_authority_address: Option<Pubkey>,
    },
}

struct Reader<'a> {
    data: &'a [u8],
}

impl<'a> Reader<'a> {
    fn take<const N: usize>(&mut self) -> Option<[u8; N]> {
        let (head, rest) = self.data.split_first_chunk::<N>()?;
        self.data = rest;
        Some(*head)
    }

    fn pubkey(&mut self) -> Option<Pubkey> {
        self.take::<32>().map(Pubkey::new_from_array)
    }

    fn optional_pubkey(&mut self) -> Option<Option<Pubkey>> {
        match self.take::<1>()? {
            [0] => Some(None),
            [1] => self.pubkey().map(Some),
            _ => None,
        }
    }
}

/// The state at the start of `data`, laid out as the loader serializes it:
/// a little-endian u32 variant index, then the variant's fields, with any
/// bytes after them ignored. `None` for anything bincode refuses.
fn loader_state(data: &[u8]) -> Option<LoaderState> {
    let mut reader = Reader { data };
    let state = match u32::from_le_bytes(reader.take::<4>()?) {
        UNINITIALIZED => LoaderState::Uninitialized,
        BUFFER => {
            reader.optional_pubkey()?;
            LoaderState::Buffer
        }
        PROGRAM => LoaderState::Program {
            programdata_address: reader.pubkey()?,
        },
        PROGRAM_DATA => LoaderState::ProgramData {
            slot: u64::from_le_bytes(reader.take::<8>()?),
            upgrade_authority_address: reader.optional_pubkey()?,
        },
        _ => return None,
    };
    Some(state)
}

fn read_loader_state(data: &[u8]) -> Result<LoaderState> {
    loader_state(data).ok_or_else(|| ProgramError::InvalidAccountData.into())
}

/// A program data account of the upgradeable loader.
#[derive(Clone)]
pub struct ProgramData {
    pub slot: u64,
    pub upgrade_authority_address: Option<Pubkey>,
}

impl AccountDeserialize for ProgramData {
    fn try_deserialize(buf: &mut &[u8]) -> Result<Self> {
        Self::try_deserialize_unchecked(buf)
    }

    fn try_deserialize_unchecked(buf: &mut &[u8]) -> Result<Self> {
        match read_loader_state(buf)? {
            LoaderState::ProgramData {
                slot,
                upgrade_authority_address,
            } => Ok(ProgramData {
                slot,
                upgrade_authority_address,
            }),
            _ => Err(ErrorCode::AccountNotProgramData.into()),
        }
    }
}

impl AccountSerialize for ProgramData {}

impl Owner for ProgramData {
    fn owner() -> Pubkey {
        bpf_loader_upgradeable::ID
    }
}

#[cfg(feature = "idl-build")]
impl anchor_lang::IdlBuild for ProgramData {}

#[cfg(feature = "idl-build")]
impl anchor_lang::Discriminator for ProgramData {
    const DISCRIMINATOR: &'static [u8] = &[];
}

/// The program data address a program account names: `None` unless the
/// upgradeable loader owns it. The program is executable, so the loader's
/// state for it is always a program account.
pub fn programdata_address(program: &AccountInfo) -> Result<Option<Pubkey>> {
    if *program.owner != bpf_loader_upgradeable::ID {
        return Ok(None);
    }
    match read_loader_state(&program.try_borrow_data()?)? {
        LoaderState::Program {
            programdata_address,
        } => Ok(Some(programdata_address)),
        _ => Err(ErrorCode::AccountNotProgramData.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::prelude::ProgramData as AnchorProgramData;

    fn anchor_state(data: &[u8]) -> Option<LoaderState> {
        let state = UpgradeableLoaderState::try_deserialize_unchecked(&mut &data[..]).ok()?;
        Some(match state {
            UpgradeableLoaderState::Uninitialized => LoaderState::Uninitialized,
            UpgradeableLoaderState::Buffer { .. } => LoaderState::Buffer,
            UpgradeableLoaderState::Program {
                programdata_address,
            } => LoaderState::Program {
                programdata_address,
            },
            UpgradeableLoaderState::ProgramData {
                slot,
                upgrade_authority_address,
            } => LoaderState::ProgramData {
                slot,
                upgrade_authority_address,
            },
        })
    }

    /// Every variant index around the four real ones, every option tag
    /// around 0 and 1, and every length from empty to past the longest
    /// layout, over patterned bytes.
    fn inputs() -> Vec<Vec<u8>> {
        let mut inputs = Vec::new();
        for index in [0u32, 1, 2, 3, 4, 5, 255, 256, 0x0100_0003, u32::MAX] {
            for tag in [0u8, 1, 2, 255] {
                let mut full = index.to_le_bytes().to_vec();
                for byte in 0..60u8 {
                    full.push(byte.wrapping_mul(37).wrapping_add(11));
                }
                full[4] = tag;
                full[12] = tag;
                for len in 0..=full.len() {
                    inputs.push(full[..len].to_vec());
                }
            }
        }
        inputs
    }

    #[test]
    fn loader_state_accepts_and_refuses_what_bincode_does() {
        for data in inputs() {
            assert_eq!(loader_state(&data), anchor_state(&data), "{data:?}");
        }
    }

    #[test]
    fn program_data_reads_as_anchors_type_does() {
        for data in inputs() {
            let ours = ProgramData::try_deserialize(&mut &data[..])
                .map(|read| (read.slot, read.upgrade_authority_address));
            let anchors = AnchorProgramData::try_deserialize(&mut &data[..])
                .map(|read| (read.slot, read.upgrade_authority_address));
            assert_eq!(ours, anchors, "{data:?}");
        }
    }

    #[test]
    fn program_data_has_the_loaders_owner() {
        assert_eq!(ProgramData::owner(), AnchorProgramData::owner());
    }

    #[test]
    fn programdata_address_reads_the_program_account() {
        let key = crate::ID;
        let programdata = Pubkey::new_unique();
        let mut lamports = 1;
        let mut data = PROGRAM.to_le_bytes().to_vec();
        data.extend_from_slice(programdata.as_ref());
        let loader = bpf_loader_upgradeable::ID;
        let program = AccountInfo::new(&key, false, false, &mut lamports, &mut data, &loader, true);
        assert_eq!(programdata_address(&program), Ok(Some(programdata)));

        let mut lamports = 1;
        let mut data = vec![PROGRAM as u8];
        let program = AccountInfo::new(&key, false, false, &mut lamports, &mut data, &loader, true);
        assert_eq!(
            programdata_address(&program),
            Err(ProgramError::InvalidAccountData.into())
        );

        let other = Pubkey::new_unique();
        let mut lamports = 1;
        let mut data = Vec::new();
        let program = AccountInfo::new(&key, false, false, &mut lamports, &mut data, &other, true);
        assert_eq!(programdata_address(&program), Ok(None));
    }
}

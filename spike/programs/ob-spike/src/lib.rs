//! Throwaway program. Each instruction exists to answer one measured question
//! about a private rollup. Nothing here is a design to keep.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use anchor_lang::solana_program::system_instruction;
use bytemuck::{Pod, Zeroable};
use ephemeral_rollups_sdk::access_control::instructions::{
    CreateEphemeralPermissionCpi, UpdateEphemeralPermissionCpi,
};
use ephemeral_rollups_sdk::access_control::structs::{EphemeralMembersArgs, Member};
use ephemeral_rollups_sdk::anchor::{delegate, ephemeral};
use ephemeral_rollups_sdk::consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephemeral_accounts::EphemeralAccount;
use magicblock_magic_program_api::args::ScheduleTaskArgs;
use magicblock_magic_program_api::instruction::MagicBlockInstruction;

declare_id!("Ab9x45Ua1aKfBe2VU6SoGjzGgN4kR2DsdzQfFYsK7s4z");

pub const SPONSOR_SEED: &[u8] = b"sponsor";
pub const CELL_SEED: &[u8] = b"cell";
pub const BIG_SEED: &[u8] = b"big";
pub const CUSTODY_SEED: &[u8] = b"custody";
pub const PERMISSION_SEED: &[u8] = b"permission:";

pub const SIDE_LEN: usize = 512;
pub const SEATS: usize = 4096;
pub const BID: u8 = 0;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct Order {
    pub price: u64,
    pub size: u64,
    pub seq: u64,
    pub tag: u64,
    pub seat: u32,
    pub pad: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct Seat {
    pub owner: [u8; 32],
    pub base: i64,
    pub quote: i64,
    pub locked: u64,
    pub open_orders: u32,
    pub pad: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct Book {
    pub seq: u64,
    pub fills: u64,
    /// Resting orders per side: bids, then asks.
    pub len: [u32; 2],
    /// Each side is kept worst first, best last, so the best order pops off the end.
    pub sides: [[Order; SIDE_LEN]; 2],
    pub seats: [Seat; SEATS],
}

pub const BOOK_BYTES: usize = std::mem::size_of::<Book>();

fn outranks(side: u8, price: u64, than: u64) -> bool {
    if side == BID {
        price > than
    } else {
        price < than
    }
}

impl Book {
    fn rest(&mut self, side: u8, price: u64, size: u64, seat: u32) -> Result<()> {
        let s = side as usize;
        let len = self.len[s] as usize;
        require!(len < SIDE_LEN, SpikeError::BookFull);
        require!((seat as usize) < SEATS, SpikeError::BadSeat);
        let orders = &mut self.sides[s];
        // A new order goes below every order it does not outrank, so an older
        // order at the same price stays nearer the end and fills first.
        let at = orders[..len].partition_point(|resting| outranks(side, price, resting.price));
        orders.copy_within(at..len, at + 1);
        self.seq += 1;
        orders[at] = Order {
            price,
            size,
            seq: self.seq,
            tag: self.seq,
            seat,
            pad: 0,
        };
        self.len[s] = (len + 1) as u32;
        let seat = &mut self.seats[seat as usize];
        seat.open_orders += 1;
        seat.locked = seat.locked.checked_add(size).ok_or(SpikeError::Overflow)?;
        Ok(())
    }

    /// Fills `taker` against the other side of the book. Returns the fill count.
    fn take(&mut self, side: u8, limit: u64, size: u64, taker: u32) -> Result<u32> {
        require!((taker as usize) < SEATS, SpikeError::BadSeat);
        let maker_side = (1 - side) as usize;
        let mut left = size;
        let mut fills = 0u32;
        while left > 0 && self.len[maker_side] > 0 {
            let top = self.len[maker_side] as usize - 1;
            let resting = self.sides[maker_side][top];
            if outranks(maker_side as u8, limit, resting.price) {
                break;
            }
            let lots = left.min(resting.size);
            let quote = (lots.checked_mul(resting.price).ok_or(SpikeError::Overflow)?) as i64;
            let signed = if side == BID {
                lots as i64
            } else {
                -(lots as i64)
            };
            let cost = if side == BID { quote } else { -quote };

            let maker = &mut self.seats[resting.seat as usize];
            maker.base = maker.base.checked_sub(signed).ok_or(SpikeError::Overflow)?;
            maker.quote = maker.quote.checked_add(cost).ok_or(SpikeError::Overflow)?;
            maker.locked = maker.locked.checked_sub(lots).ok_or(SpikeError::Overflow)?;
            let seat = &mut self.seats[taker as usize];
            seat.base = seat.base.checked_add(signed).ok_or(SpikeError::Overflow)?;
            seat.quote = seat.quote.checked_sub(cost).ok_or(SpikeError::Overflow)?;

            if lots == resting.size {
                self.len[maker_side] -= 1;
                self.seats[resting.seat as usize].open_orders -= 1;
            } else {
                self.sides[maker_side][top].size -= lots;
            }
            left -= lots;
            fills += 1;
        }
        self.fills += fills as u64;
        Ok(fills)
    }
}

fn with_book<T>(account: &AccountInfo, work: impl FnOnce(&mut Book) -> Result<T>) -> Result<T> {
    require_keys_eq!(*account.owner, crate::ID, SpikeError::NotOurs);
    let mut data = account.try_borrow_mut_data()?;
    require!(data.len() >= BOOK_BYTES, SpikeError::TooSmall);
    work(bytemuck::from_bytes_mut::<Book>(&mut data[..BOOK_BYTES]))
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Reader {
    pub flags: u8,
    pub key: Pubkey,
}

fn members(readers: Vec<Reader>) -> Vec<Member> {
    readers
        .into_iter()
        .map(|reader| Member {
            flags: reader.flags,
            pubkey: reader.key,
        })
        .collect()
}

#[ephemeral]
#[program]
pub mod ob_spike {
    use super::*;

    pub fn init_sponsor(ctx: Context<InitSponsor>) -> Result<()> {
        ctx.accounts.sponsor.bump = ctx.bumps.sponsor;
        Ok(())
    }

    pub fn delegate_sponsor(ctx: Context<DelegateSponsor>, validator: Pubkey) -> Result<()> {
        ctx.accounts.delegate_sponsor(
            &ctx.accounts.payer,
            &[SPONSOR_SEED],
            DelegateConfig {
                validator: Some(validator),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// An account that exists only in the rollup, with or without a permission.
    pub fn create_cell(
        ctx: Context<CreateCell>,
        id: u8,
        size: u32,
        guarded: bool,
        is_private: bool,
        readers: Vec<Reader>,
    ) -> Result<()> {
        let accounts = &ctx.accounts;
        let sponsor_seeds: [&[u8]; 2] = [SPONSOR_SEED, &[accounts.sponsor.bump]];
        let cell_seeds: [&[u8]; 3] = [CELL_SEED, &[id], &[ctx.bumps.cell]];
        EphemeralAccount::new(
            &accounts.sponsor.to_account_info(),
            &accounts.cell.to_account_info(),
            &accounts.vault.to_account_info(),
        )
        .with_signer_seeds(&[&sponsor_seeds, &cell_seeds])
        .create(size)?;
        if guarded {
            CreateEphemeralPermissionCpi {
                payer: accounts.sponsor.to_account_info(),
                permissioned_account: accounts.cell.to_account_info(),
                permission: accounts.permission.to_account_info(),
                vault: accounts.vault.to_account_info(),
                magic_program: accounts.magic_program.to_account_info(),
                permission_program: accounts.permission_program.to_account_info(),
                args: EphemeralMembersArgs {
                    is_private,
                    members: members(readers),
                },
            }
            .invoke_signed(&[&sponsor_seeds, &cell_seeds])?;
        }
        Ok(())
    }

    pub fn grow_cell(ctx: Context<GrowCell>, _id: u8, new_len: u32) -> Result<()> {
        let accounts = &ctx.accounts;
        let sponsor_seeds: [&[u8]; 2] = [SPONSOR_SEED, &[accounts.sponsor.bump]];
        EphemeralAccount::new(
            &accounts.sponsor.to_account_info(),
            &accounts.cell.to_account_info(),
            &accounts.vault.to_account_info(),
        )
        .with_signer_seeds(&[&sponsor_seeds])
        .resize(new_len)?;
        Ok(())
    }

    pub fn set_readers(
        ctx: Context<CreateCell>,
        id: u8,
        is_private: bool,
        readers: Vec<Reader>,
    ) -> Result<()> {
        let accounts = &ctx.accounts;
        let sponsor_seeds: [&[u8]; 2] = [SPONSOR_SEED, &[accounts.sponsor.bump]];
        let cell_seeds: [&[u8]; 3] = [CELL_SEED, &[id], &[ctx.bumps.cell]];
        UpdateEphemeralPermissionCpi {
            payer: accounts.sponsor.to_account_info(),
            authority: accounts.cell.to_account_info(),
            permissioned_account: accounts.cell.to_account_info(),
            permission: accounts.permission.to_account_info(),
            vault: accounts.vault.to_account_info(),
            magic_program: accounts.magic_program.to_account_info(),
            permission_program: accounts.permission_program.to_account_info(),
            authority_is_signer: false,
            args: EphemeralMembersArgs {
                is_private,
                members: members(readers),
            },
        }
        .invoke_signed(&[&sponsor_seeds, &cell_seeds])?;
        Ok(())
    }

    /// Stands in for an order: the caller is anyone, the numbers travel in the
    /// instruction data, the program reads the account and writes it back.
    pub fn poke(ctx: Context<Poke>, _id: u8, price: u64, size: u64) -> Result<()> {
        let mut data = ctx.accounts.cell.try_borrow_mut_data()?;
        let count = u64::from_le_bytes(data[0..8].try_into().unwrap()) + 1;
        data[0..8].copy_from_slice(&count.to_le_bytes());
        data[8..16].copy_from_slice(&price.to_le_bytes());
        data[16..24].copy_from_slice(&size.to_le_bytes());
        msg!("poke count={} price={} size={}", count, price, size);
        Ok(())
    }

    /// What the scheduler calls. Nobody signs it.
    pub fn tick(ctx: Context<Tick>, _id: u8) -> Result<()> {
        let mut data = ctx.accounts.cell.try_borrow_mut_data()?;
        let count = u64::from_le_bytes(data[0..8].try_into().unwrap()) + 1;
        let clock = Clock::get()?;
        data[0..8].copy_from_slice(&count.to_le_bytes());
        data[8..16].copy_from_slice(&clock.slot.to_le_bytes());
        data[16..24].copy_from_slice(&clock.unix_timestamp.to_le_bytes());
        Ok(())
    }

    pub fn schedule(
        ctx: Context<Schedule>,
        id: u8,
        task_id: i64,
        interval_ms: i64,
        iterations: i64,
    ) -> Result<()> {
        let cell = ctx.accounts.cell.key();
        let tick = Instruction {
            program_id: crate::ID,
            accounts: vec![AccountMeta::new(cell, false)],
            data: anchor_lang::InstructionData::data(&crate::instruction::Tick { _id: id }),
        };
        let schedule = Instruction::new_with_bincode(
            MAGIC_PROGRAM_ID,
            &MagicBlockInstruction::ScheduleTask(ScheduleTaskArgs {
                task_id,
                execution_interval_millis: interval_ms,
                iterations,
                instructions: vec![tick],
            }),
            vec![
                AccountMeta::new(ctx.accounts.payer.key(), true),
                AccountMeta::new(cell, false),
            ],
        );
        invoke(
            &schedule,
            &[
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.cell.to_account_info(),
            ],
        )?;
        Ok(())
    }

    /// Spends compute and nothing else, to find the ceiling.
    pub fn burn(_ctx: Context<Burn>, rounds: u32) -> Result<()> {
        let mut mixed = 0u64;
        for round in 0..rounds {
            mixed = std::hint::black_box(mixed.wrapping_mul(31).wrapping_add(round as u64));
        }
        msg!("burned {} rounds {}", rounds, mixed);
        Ok(())
    }

    pub fn init_big(ctx: Context<InitBig>, id: u8, space: u64) -> Result<()> {
        let accounts = &ctx.accounts;
        let lamports = Rent::get()?.minimum_balance(space as usize);
        invoke_signed(
            &system_instruction::create_account(
                accounts.payer.key,
                accounts.big.key,
                lamports,
                space,
                &crate::ID,
            ),
            &[
                accounts.payer.to_account_info(),
                accounts.big.to_account_info(),
            ],
            &[&[BIG_SEED, &[id], &[ctx.bumps.big]]],
        )?;
        Ok(())
    }

    pub fn grow_big(ctx: Context<GrowBig>, _id: u8, new_len: u64) -> Result<()> {
        let accounts = &ctx.accounts;
        let big = accounts.big.to_account_info();
        let owed = Rent::get()?
            .minimum_balance(new_len as usize)
            .saturating_sub(big.lamports());
        if owed > 0 {
            invoke(
                &system_instruction::transfer(accounts.payer.key, big.key, owed),
                &[accounts.payer.to_account_info(), big.clone()],
            )?;
        }
        big.resize(new_len as usize)?;
        Ok(())
    }

    pub fn delegate_big(ctx: Context<DelegateBig>, id: u8, validator: Pubkey) -> Result<()> {
        ctx.accounts.delegate_big(
            &ctx.accounts.payer,
            &[BIG_SEED, &[id]],
            DelegateConfig {
                validator: Some(validator),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    pub fn rest(ctx: Context<UseBook>, side: u8, price: u64, size: u64, seat: u32) -> Result<()> {
        with_book(&ctx.accounts.book, |book| book.rest(side, price, size, seat))
    }

    /// Rests `count` orders of `size`, one price step apart, one seat each.
    pub fn rest_many(
        ctx: Context<UseBook>,
        side: u8,
        first_price: u64,
        step: i64,
        size: u64,
        first_seat: u32,
        count: u32,
    ) -> Result<()> {
        with_book(&ctx.accounts.book, |book| {
            for nth in 0..count {
                let price = (first_price as i64 + step * nth as i64) as u64;
                book.rest(side, price, size, first_seat + nth)?;
            }
            Ok(())
        })
    }

    pub fn take(ctx: Context<UseBook>, side: u8, limit: u64, size: u64, seat: u32) -> Result<()> {
        let fills = with_book(&ctx.accounts.book, |book| {
            book.take(side, limit, size, seat)
        })?;
        msg!("fills={}", fills);
        Ok(())
    }

    pub fn clear_book(ctx: Context<UseBook>) -> Result<()> {
        with_book(&ctx.accounts.book, |book| {
            book.len = [0, 0];
            Ok(())
        })
    }

    /// A payout the program signs: tokens leave an account its own address owns.
    pub fn pay_out(ctx: Context<PayOut>, amount: u64) -> Result<()> {
        let accounts = &ctx.accounts;
        let mut data = vec![3u8];
        data.extend_from_slice(&amount.to_le_bytes());
        let transfer = Instruction {
            program_id: accounts.token_program.key(),
            accounts: vec![
                AccountMeta::new(accounts.from.key(), false),
                AccountMeta::new(accounts.to.key(), false),
                AccountMeta::new_readonly(accounts.custody.key(), true),
            ],
            data,
        };
        invoke_signed(
            &transfer,
            &[
                accounts.from.to_account_info(),
                accounts.to.to_account_info(),
                accounts.custody.to_account_info(),
            ],
            &[&[CUSTODY_SEED, &[ctx.bumps.custody]]],
        )?;
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct Sponsor {
    pub bump: u8,
}

#[derive(Accounts)]
pub struct InitSponsor<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + Sponsor::INIT_SPACE, seeds = [SPONSOR_SEED], bump)]
    pub sponsor: Account<'info, Sponsor>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateSponsor<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The sponsor PDA, handed to the delegation program.
    #[account(mut, del, seeds = [SPONSOR_SEED], bump)]
    pub sponsor: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(id: u8)]
pub struct CreateCell<'info> {
    pub user: Signer<'info>,
    #[account(mut, seeds = [SPONSOR_SEED], bump = sponsor.bump)]
    pub sponsor: Account<'info, Sponsor>,
    /// CHECK: Created here, inside the rollup.
    #[account(mut, seeds = [CELL_SEED, &[id]], bump)]
    pub cell: UncheckedAccount<'info>,
    /// CHECK: The cell's permission, where the permission program derives it.
    /// Writable only when the caller marks it so: the rollup fails a
    /// transaction that names an account writable and leaves it nonexistent.
    #[account(seeds = [PERMISSION_SEED, cell.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: Fixed address.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: Fixed address.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: Fixed address.
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(id: u8)]
pub struct GrowCell<'info> {
    pub user: Signer<'info>,
    #[account(mut, seeds = [SPONSOR_SEED], bump = sponsor.bump)]
    pub sponsor: Account<'info, Sponsor>,
    /// CHECK: An account this program created in the rollup.
    #[account(mut, seeds = [CELL_SEED, &[id]], bump)]
    pub cell: UncheckedAccount<'info>,
    /// CHECK: Fixed address.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: Fixed address.
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(id: u8)]
pub struct Poke<'info> {
    pub user: Signer<'info>,
    /// CHECK: An account this program created in the rollup.
    #[account(mut, seeds = [CELL_SEED, &[id]], bump, owner = crate::ID)]
    pub cell: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(id: u8)]
pub struct Tick<'info> {
    /// CHECK: An account this program created in the rollup.
    #[account(mut, seeds = [CELL_SEED, &[id]], bump, owner = crate::ID)]
    pub cell: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(id: u8)]
pub struct Schedule<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The account each tick writes.
    #[account(mut, seeds = [CELL_SEED, &[id]], bump)]
    pub cell: UncheckedAccount<'info>,
    /// CHECK: Fixed address.
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Burn<'info> {
    pub user: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(id: u8)]
pub struct InitBig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Created here, on Solana.
    #[account(mut, seeds = [BIG_SEED, &[id]], bump)]
    pub big: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(id: u8)]
pub struct GrowBig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: A Solana account this program owns.
    #[account(mut, seeds = [BIG_SEED, &[id]], bump, owner = crate::ID)]
    pub big: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateBig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The big PDA, handed to the delegation program, which checks its seeds.
    #[account(mut, del)]
    pub big: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct UseBook<'info> {
    pub user: Signer<'info>,
    /// CHECK: Owner and size are checked in the handler.
    #[account(mut)]
    pub book: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct PayOut<'info> {
    pub user: Signer<'info>,
    /// CHECK: The address that owns the paying token account. It only signs.
    #[account(seeds = [CUSTODY_SEED], bump)]
    pub custody: UncheckedAccount<'info>,
    /// CHECK: Checked by the token program.
    #[account(mut)]
    pub from: UncheckedAccount<'info>,
    /// CHECK: Checked by the token program.
    #[account(mut)]
    pub to: UncheckedAccount<'info>,
    /// CHECK: Whichever token program the caller names; the test names it.
    pub token_program: UncheckedAccount<'info>,
}

#[error_code]
pub enum SpikeError {
    #[msg("That side of the book is full")]
    BookFull,
    #[msg("No such seat")]
    BadSeat,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("The account is not owned by this program")]
    NotOurs,
    #[msg("The account is smaller than a book")]
    TooSmall,
}

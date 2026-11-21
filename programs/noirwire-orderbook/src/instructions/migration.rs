//! The two instructions that move an exchange the earlier build made onto the active
//! layout. See `layout.rs` for the phases.

use anchor_lang::prelude::*;
use core::ops::Range;
use ephemeral_rollups_sdk::consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID};
use noirwire_orderbook_engine::Seat;

use crate::ephemeral;
use crate::errors::OrderbookError;
use crate::layout::require_gate;
use crate::loader::{finalize, load, load_mut, load_scan_ledger, Scope};
use crate::state::{
    Exchange, ScanData, EXCHANGE_SEED, LAYOUT_V3, LEDGER_SEED, SCAN_SEED, SCAN_VERSION,
};

/// The bytes of a seat that the earlier build wrote as the high bytes of two access masks
/// and as the padding and high half of a free list link, and that this build reads as the
/// seat's epoch and the high bytes of its position generations. All of them are zero in a
/// seat the earlier build wrote, whether the seat is open, reserved or free.
const IDENTITY_BYTES: [Range<usize>; 4] = [113..120, 121..128, 298..300, 302..304];

/// Whether every reused byte of `seat` is zero.
fn identity_bytes_are_zero(seat: &Seat) -> bool {
    let bytes = bytemuck::bytes_of(seat);
    IDENTITY_BYTES.iter().all(|range| {
        bytes
            .get(range.clone())
            .is_some_and(|bytes| bytes.iter().all(|byte| *byte == 0))
    })
}

#[derive(Accounts)]
pub struct ScanSeatLayout<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [EXCHANGE_SEED],
        bump = exchange.bump,
        has_one = admin @ OrderbookError::NotAdmin
    )]
    pub exchange: Account<'info, Exchange>,
    /// CHECK: Checked by the loader against its seeds, tag, size and readiness.
    #[account(seeds = [LEDGER_SEED], bump)]
    pub ledger: UncheckedAccount<'info>,
    /// CHECK: Created by the first call; checked by the loader against its seeds, tag and size.
    #[account(mut, seeds = [SCAN_SEED], bump)]
    pub scan: UncheckedAccount<'info>,
    /// CHECK: The rollup's rent vault, by its fixed address.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: The magic program, by its fixed address; creating the scan account calls it.
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

/// Reads the next `count` seats of the ledger, from where the last call stopped, and
/// requires the bytes this build reuses to be zero in every one of them, reserved and free
/// seats included. The first call creates the scan account. A seat holding anything else
/// refuses the call with `SeatLayoutUnexpected` and the scan does not advance; the error
/// and the logs name no seat and no owner. The call stops at the ledger's capacity as it
/// stands now, so a ledger that has grown since the scan began is scanned to its new end.
///
/// Security: the migration never rewrites bytes it did not expect. Normalising them would
/// hide a surprise instead of reporting it.
pub fn scan_seat_layout(ctx: Context<ScanSeatLayout>, count: u16) -> Result<()> {
    let accounts = &ctx.accounts;
    require_gate!(accounts.exchange, "scan_seat_layout")?;
    require!(accounts.exchange.paused, OrderbookError::ExchangeNotPaused);
    require!(count > 0, OrderbookError::InvalidSettings);
    let ledger = load_scan_ledger(&accounts.exchange, &accounts.ledger)?;
    let capacity = u32::try_from(ledger.seats.len()).map_err(|_| OrderbookError::MathOverflow)?;
    if accounts.scan.data_is_empty() {
        ephemeral::create::<ScanData>(
            &accounts.exchange,
            &accounts.scan,
            &accounts.vault,
            Scope::Global,
            ctx.bumps.scan,
        )?;
        finalize::<ScanData>(&accounts.scan, Scope::Global, |scan| {
            scan.version = SCAN_VERSION;
            scan.cursor = 0;
            scan.capacity = capacity;
            Ok(())
        })?;
    }
    let mut scan = load_mut::<ScanData>(&accounts.scan, Scope::Global)?;
    require!(
        scan.version == SCAN_VERSION && scan.cursor <= capacity && scan.capacity <= capacity,
        OrderbookError::WrongKind
    );
    let start = usize::try_from(scan.cursor).map_err(|_| OrderbookError::MathOverflow)?;
    let end = start
        .saturating_add(usize::from(count))
        .min(ledger.seats.len());
    let seats = ledger
        .seats
        .get(start..end)
        .ok_or(OrderbookError::SeatOutOfRange)?;
    require!(
        seats.iter().all(identity_bytes_are_zero),
        OrderbookError::SeatLayoutUnexpected
    );
    scan.cursor = u32::try_from(end).map_err(|_| OrderbookError::MathOverflow)?;
    Ok(())
}

#[derive(Accounts)]
pub struct ActivateLayout<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [EXCHANGE_SEED],
        bump = exchange.bump,
        has_one = admin @ OrderbookError::NotAdmin
    )]
    pub exchange: Account<'info, Exchange>,
    /// CHECK: Checked by the loader against its seeds, tag, size and readiness.
    #[account(seeds = [LEDGER_SEED], bump)]
    pub ledger: UncheckedAccount<'info>,
    /// CHECK: Checked by the loader against its seeds, tag and size.
    #[account(seeds = [SCAN_SEED], bump)]
    pub scan: UncheckedAccount<'info>,
}

/// Stamps the active layout once the scan has read every seat of the ledger. After it the
/// earlier build must not run again on this data: the seats carry bytes it would read as
/// access mask bits. It needs neither a bound price source nor a trigger book, and leaves
/// `Exchange::_reserved` alone.
pub fn activate_layout(ctx: Context<ActivateLayout>) -> Result<()> {
    let accounts = &ctx.accounts;
    require_gate!(accounts.exchange, "activate_layout")?;
    require!(accounts.exchange.paused, OrderbookError::ExchangeNotPaused);
    let seats = load_scan_ledger(&accounts.exchange, &accounts.ledger)?
        .seats
        .len();
    require!(
        !accounts.scan.data_is_empty(),
        OrderbookError::LayoutScanIncomplete
    );
    {
        let scan = load::<ScanData>(&accounts.scan, Scope::Global)?;
        require!(scan.version == SCAN_VERSION, OrderbookError::WrongKind);
        require!(
            usize::try_from(scan.cursor).is_ok_and(|cursor| cursor == seats),
            OrderbookError::LayoutScanIncomplete
        );
    }
    ctx.accounts.exchange.layout = LAYOUT_V3;
    Ok(())
}

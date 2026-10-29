use anchor_lang::prelude::*;
use core::cell::{Ref, RefMut};
use core::mem::size_of;
use noirwire_orderbook_engine::{LedgerHeader, LedgerMut, Seat};

use crate::errors::OrderbookError;
use crate::relayout::{LegacySeat, LEGACY_LEDGER_LEN, LEGACY_LEDGER_PREFIX};
use crate::state::{
    ledger_seats, Header, LedgerData, RollupAccount, ViewData, HEADER_LEN, LEGACY_LEDGER_SEED,
    READY,
};

/// What the address of an account is derived from besides its kind's seed.
#[derive(Clone, Copy)]
pub enum Scope<'a> {
    Global,
    Market(u8),
    Owner(&'a Pubkey),
}

impl Scope<'_> {
    fn extra(&self) -> &[u8] {
        match self {
            Scope::Global => &[],
            Scope::Market(id) => core::slice::from_ref(id),
            Scope::Owner(owner) => owner.as_ref(),
        }
    }

    /// The seeds an account of kind `T` in this scope is derived from, with its bump.
    pub(crate) fn seeds<'s, T: RollupAccount>(&'s self, bump: &'s [u8; 1]) -> [&'s [u8]; 3] {
        self.seeds_for(T::SEED, bump)
    }

    /// The seeds an account of the kind with `seed` in this scope is derived from, with its bump.
    pub(crate) fn seeds_for<'s>(&'s self, seed: &'s [u8], bump: &'s [u8; 1]) -> [&'s [u8]; 3] {
        [seed, self.extra(), bump]
    }

    fn market_id(&self) -> Option<u8> {
        match self {
            Scope::Market(id) => Some(*id),
            _ => None,
        }
    }

    /// The market id a new account's header records: zero outside a market.
    pub(crate) fn header_market_id(&self) -> u8 {
        self.market_id().unwrap_or(0)
    }
}

/// The checks every load performs before a byte of the body is read: the
/// account is owned by this program, is at the address its seeds derive with
/// the bump it stores, and carries the tag of the expected kind. Readiness
/// and size are checked by the caller's loader, since growth needs the
/// account before it is ready.
///
/// The kind comes as its tag and seed rather than as a type parameter, here
/// and in the loaders' other checks, so the program carries one copy of each
/// check rather than one per kind.
#[inline(never)]
fn checked_header(
    account: &AccountInfo,
    scope: Scope<'_>,
    data: &[u8],
    tag: [u8; 8],
    seed: &[u8],
) -> Result<Header> {
    require_keys_eq!(*account.owner, crate::ID, OrderbookError::WrongOwner);
    let bytes = data
        .get(..HEADER_LEN)
        .ok_or(OrderbookError::AccountMissing)?;
    let header: Header = *bytemuck::try_from_bytes(bytes).map_err(|_| OrderbookError::Unaligned)?;
    require!(header.tag == tag, OrderbookError::WrongKind);
    let bump = [header.bump];
    let seeds = scope.seeds_for(seed, &bump);
    let expected = Pubkey::create_program_address(&seeds, &crate::ID)
        .map_err(|_| OrderbookError::WrongDerivation)?;
    require_keys_eq!(*account.key, expected, OrderbookError::WrongDerivation);
    if let Some(market_id) = scope.market_id() {
        require!(header.market_id == market_id, OrderbookError::WrongMarket);
    }
    Ok(header)
}

fn ready_body(data: &[u8], header: &Header, len: usize) -> Result<()> {
    require!(data.len() == len, OrderbookError::WrongSize);
    require!(header.ready == READY, OrderbookError::NotReady);
    Ok(())
}

/// The data of a ready account of the kind with `tag`, `seed` and full
/// length `len`, borrowed for reading once every check has passed.
#[inline(never)]
fn ready_data<'a>(
    account: &'a AccountInfo<'_>,
    scope: Scope<'_>,
    tag: [u8; 8],
    seed: &[u8],
    len: usize,
) -> Result<Ref<'a, &'a mut [u8]>> {
    let data = account.try_borrow_data()?;
    let header = checked_header(account, scope, &data, tag, seed)?;
    ready_body(&data, &header, len)?;
    Ok(data)
}

/// `ready_data`, borrowed for writing.
#[inline(never)]
fn ready_data_mut<'a, 'info>(
    account: &'a AccountInfo<'info>,
    scope: Scope<'_>,
    tag: [u8; 8],
    seed: &[u8],
    len: usize,
) -> Result<RefMut<'a, &'info mut [u8]>> {
    require!(account.is_writable, ErrorCode::ConstraintMut);
    let data = account.try_borrow_mut_data()?;
    let header = checked_header(account, scope, &data, tag, seed)?;
    ready_body(&data, &header, len)?;
    Ok(data)
}

/// The body of a ready account, for reading.
pub fn load<'a, T: RollupAccount>(
    account: &'a AccountInfo<'_>,
    scope: Scope<'_>,
) -> Result<Ref<'a, T>> {
    let data = ready_data(account, scope, T::TAG, T::SEED, T::LEN)?;
    Ref::filter_map(data, |data| {
        data.get(HEADER_LEN..HEADER_LEN + size_of::<T>())
            .and_then(|body| bytemuck::try_from_bytes(body).ok())
    })
    .map_err(|_| OrderbookError::Unaligned.into())
}

/// The body of a ready account, for writing. The account must be writable in
/// the transaction, or the runtime refuses the write at the end.
pub fn load_mut<'a, T: RollupAccount>(
    account: &'a AccountInfo<'_>,
    scope: Scope<'_>,
) -> Result<RefMut<'a, T>> {
    let data = ready_data_mut(account, scope, T::TAG, T::SEED, T::LEN)?;
    RefMut::filter_map(data, |data| {
        data.get_mut(HEADER_LEN..HEADER_LEN + size_of::<T>())
            .and_then(|body| bytemuck::try_from_bytes_mut(body).ok())
    })
    .map_err(|_| OrderbookError::Unaligned.into())
}

/// A ready ledger, mapped in place for reading: the engine's header and every seat the
/// account holds.
pub struct LedgerRef<'a> {
    pub header: Ref<'a, LedgerHeader>,
    pub seats: Ref<'a, [Seat]>,
}

/// A ready ledger, mapped in place for writing.
pub struct LedgerAccount<'a> {
    pub header: RefMut<'a, LedgerHeader>,
    pub seats: RefMut<'a, [Seat]>,
}

impl LedgerAccount<'_> {
    /// The ledger as the engine takes it.
    pub fn engine(&mut self) -> LedgerMut<'_> {
        LedgerMut {
            header: &mut self.header,
            seats: &mut self.seats,
        }
    }
}

/// A ledger is ready when it has a length a ledger may have, a whole number of seats
/// from `MIN_SEATS` to `MAX_SEATS`, and has been finalised.
fn ready_ledger_body(data: &[u8], header: &Header) -> Result<()> {
    require!(
        ledger_seats(data.len()).is_some(),
        OrderbookError::WrongSize
    );
    require!(header.ready == READY, OrderbookError::NotReady);
    Ok(())
}

/// The ledger's data once every check has passed, for reading.
#[inline(never)]
fn ready_ledger_data<'a>(account: &'a AccountInfo<'_>) -> Result<Ref<'a, &'a mut [u8]>> {
    let data = account.try_borrow_data()?;
    let header = checked_header(
        account,
        Scope::Global,
        &data,
        LedgerData::TAG,
        LedgerData::SEED,
    )?;
    ready_ledger_body(&data, &header)?;
    Ok(data)
}

/// The ledger's data once every check has passed, for writing.
#[inline(never)]
fn ready_ledger_data_mut<'a, 'info>(
    account: &'a AccountInfo<'info>,
) -> Result<RefMut<'a, &'info mut [u8]>> {
    require!(account.is_writable, ErrorCode::ConstraintMut);
    let data = account.try_borrow_mut_data()?;
    let header = checked_header(
        account,
        Scope::Global,
        &data,
        LedgerData::TAG,
        LedgerData::SEED,
    )?;
    ready_ledger_body(&data, &header)?;
    Ok(data)
}

/// The ledger, for reading. Its length may be any a ledger may have, so a ledger
/// that has grown loads as the one created.
pub fn load_ledger<'a>(account: &'a AccountInfo<'_>) -> Result<LedgerRef<'a>> {
    let data = ready_ledger_data(account)?;
    let body = Ref::map(data, |data| data.get(HEADER_LEN..).unwrap_or_default());
    let (header, seats) = Ref::map_split(body, |body| body.split_at(size_of::<LedgerHeader>()));
    let header = Ref::filter_map(header, |bytes| {
        bytemuck::try_from_bytes::<LedgerHeader>(bytes).ok()
    })
    .map_err(|_| OrderbookError::Unaligned)?;
    let seats = Ref::filter_map(seats, |bytes| {
        bytemuck::try_cast_slice::<u8, Seat>(bytes).ok()
    })
    .map_err(|_| OrderbookError::Unaligned)?;
    Ok(LedgerRef { header, seats })
}

/// The ledger, for writing. The account must be writable in the transaction, or the
/// runtime refuses the write at the end.
pub fn load_ledger_mut<'a>(account: &'a AccountInfo<'_>) -> Result<LedgerAccount<'a>> {
    let data = ready_ledger_data_mut(account)?;
    let body = RefMut::map(data, |data| data.get_mut(HEADER_LEN..).unwrap_or_default());
    let (header, seats) =
        RefMut::map_split(body, |body| body.split_at_mut(size_of::<LedgerHeader>()));
    let header = RefMut::filter_map(header, |bytes| {
        bytemuck::try_from_bytes_mut::<LedgerHeader>(bytes).ok()
    })
    .map_err(|_| OrderbookError::Unaligned)?;
    let seats = RefMut::filter_map(seats, |bytes| {
        bytemuck::try_cast_slice_mut::<u8, Seat>(bytes).ok()
    })
    .map_err(|_| OrderbookError::Unaligned)?;
    Ok(LedgerAccount { header, seats })
}

/// The engine's view of a ledger account's data: its header and every whole seat.
fn engine_ledger(data: &mut [u8]) -> Result<LedgerMut<'_>> {
    let body = data.get_mut(HEADER_LEN..).unwrap_or_default();
    require!(
        body.len() >= size_of::<LedgerHeader>(),
        OrderbookError::WrongSize
    );
    let (ledger_header, seats) = body.split_at_mut(size_of::<LedgerHeader>());
    Ok(LedgerMut {
        header: bytemuck::try_from_bytes_mut(ledger_header)
            .map_err(|_| OrderbookError::Unaligned)?,
        seats: bytemuck::try_cast_slice_mut(seats).map_err(|_| OrderbookError::Unaligned)?,
    })
}

/// Marks the ledger ready once it has the length it is created with, handing the
/// engine its header and seats once for the seats that must be open before first use.
pub fn finalize_ledger(
    account: &AccountInfo,
    prepare: impl FnOnce(&mut LedgerMut<'_>) -> Result<()>,
) -> Result<()> {
    let (header, mut data) = unready_full_data(
        account,
        Scope::Global,
        LedgerData::TAG,
        LedgerData::SEED,
        LedgerData::LEN,
    )?;
    prepare(&mut engine_ledger(&mut data[..])?)?;
    mark_ready(&mut data, header)
}

/// Hands the engine the header and seats of a full-size ledger that is not ready yet,
/// and leaves it not ready: what the relayout fills before `finish_relayout` stamps it.
pub fn edit_unready_ledger<R>(
    account: &AccountInfo,
    edit: impl FnOnce(&mut LedgerMut<'_>) -> Result<R>,
) -> Result<R> {
    let (_, mut data) = unready_full_data(
        account,
        Scope::Global,
        LedgerData::TAG,
        LedgerData::SEED,
        LedgerData::LEN,
    )?;
    edit(&mut engine_ledger(&mut data[..])?)
}

/// The ledger the exchange was first built with, ready and read in place: the seats of
/// the old 448-byte layout and the count of them that are open.
pub struct LegacyLedgerRef<'a> {
    pub open_seats: u32,
    pub seats: Ref<'a, [LegacySeat]>,
}

/// The old ledger at `LEGACY_LEDGER_SEED`, for reading. It must be this program's, at its
/// address, of the old ledger's kind, ready, and exactly `LEGACY_LEDGER_LEN` bytes.
pub fn load_legacy_ledger<'a>(account: &'a AccountInfo<'_>) -> Result<LegacyLedgerRef<'a>> {
    let data = account.try_borrow_data()?;
    let header = checked_header(
        account,
        Scope::Global,
        &data,
        LedgerData::TAG,
        LEGACY_LEDGER_SEED,
    )?;
    ready_body(&data, &header, LEGACY_LEDGER_LEN)?;
    let body = Ref::map(data, |data| {
        data.get(HEADER_LEN..LEGACY_LEDGER_LEN).unwrap_or_default()
    });
    let (count, seats) = Ref::map_split(body, |body| {
        body.split_at(LEGACY_LEDGER_PREFIX - HEADER_LEN)
    });
    let open_seats = count
        .get(..size_of::<u32>())
        .and_then(|bytes| <[u8; 4]>::try_from(bytes).ok())
        .map(u32::from_le_bytes)
        .ok_or(OrderbookError::WrongSize)?;
    let seats = Ref::filter_map(seats, |bytes| {
        bytemuck::try_cast_slice::<u8, LegacySeat>(bytes).ok()
    })
    .map_err(|_| OrderbookError::Unaligned)?;
    Ok(LegacyLedgerRef { open_seats, seats })
}

/// The owner a view claims in its own data, before the loader checks that the
/// view sits at the address derived from that owner.
fn stated_owner(view: &AccountInfo) -> Result<Pubkey> {
    let data = view.try_borrow_data()?;
    let bytes = data
        .get(HEADER_LEN..HEADER_LEN + 32)
        .ok_or(OrderbookError::AccountMissing)?;
    Ok(Pubkey::new_from_array(
        bytes
            .try_into()
            .map_err(|_| OrderbookError::AccountMissing)?,
    ))
}

/// The market id an account claims in its header, before the loader checks it
/// against the address.
fn stated_market_id(account: &AccountInfo) -> Result<u8> {
    let data = account.try_borrow_data()?;
    let bytes = data
        .get(..HEADER_LEN)
        .ok_or(OrderbookError::AccountMissing)?;
    let header: Header = *bytemuck::try_from_bytes(bytes).map_err(|_| OrderbookError::Unaligned)?;
    Ok(header.market_id)
}

/// A view named by its address alone, for writing.
#[inline(always)]
pub(crate) fn load_view_mut<'a>(account: &'a AccountInfo<'_>) -> Result<RefMut<'a, ViewData>> {
    let owner = stated_owner(account)?;
    load_mut::<ViewData>(account, Scope::Owner(&owner))
}

/// A market account named by its address alone, for reading: loaded in the
/// market it states, and returned with that market's id.
#[inline(always)]
pub(crate) fn load_market_ref<'a, T: RollupAccount>(
    account: &'a AccountInfo<'_>,
) -> Result<(u8, Ref<'a, T>)> {
    let market_id = stated_market_id(account)?;
    Ok((market_id, load::<T>(account, Scope::Market(market_id))?))
}

/// A market account named by its address alone, for writing.
#[inline(always)]
pub(crate) fn load_market_mut<'a, T: RollupAccount>(
    account: &'a AccountInfo<'_>,
) -> Result<(u8, RefMut<'a, T>)> {
    let market_id = stated_market_id(account)?;
    Ok((market_id, load_mut::<T>(account, Scope::Market(market_id))?))
}

/// The header of an account that is not ready yet: what growth and
/// finalisation work on. Refuses an account that is already ready.
#[inline(always)]
pub fn unready_header<T: RollupAccount>(account: &AccountInfo, scope: Scope<'_>) -> Result<Header> {
    unready_header_of(account, scope, T::TAG, T::SEED)
}

#[inline(never)]
fn unready_header_of(
    account: &AccountInfo,
    scope: Scope<'_>,
    tag: [u8; 8],
    seed: &[u8],
) -> Result<Header> {
    let data = account.try_borrow_data()?;
    let header = checked_header(account, scope, &data, tag, seed)?;
    require!(header.ready != READY, OrderbookError::AlreadyReady);
    Ok(header)
}

/// Writes the header of a freshly created account of the kind with `tag`.
/// The account must be empty of any header, which is what a new ephemeral
/// account is.
pub fn write_header(account: &AccountInfo, tag: [u8; 8], market_id: u8, bump: u8) -> Result<()> {
    let mut data = account.try_borrow_mut_data()?;
    let bytes = data
        .get_mut(..HEADER_LEN)
        .ok_or(OrderbookError::AccountMissing)?;
    require!(
        bytes.iter().all(|byte| *byte == 0),
        OrderbookError::AccountExists
    );
    let header = Header {
        tag,
        ready: 0,
        market_id,
        bump,
        _padding: [0; 5],
    };
    bytes.copy_from_slice(bytemuck::bytes_of(&header));
    Ok(())
}

/// Marks a full-size account ready and hands its body to `prepare` once, for
/// the engine fields that must be set before first use.
pub fn finalize<T: RollupAccount>(
    account: &AccountInfo,
    scope: Scope<'_>,
    prepare: impl FnOnce(&mut T) -> Result<()>,
) -> Result<()> {
    let (header, mut data) = unready_full_data(account, scope, T::TAG, T::SEED, T::LEN)?;
    {
        let body = data
            .get_mut(HEADER_LEN..HEADER_LEN + size_of::<T>())
            .and_then(|body| bytemuck::try_from_bytes_mut::<T>(body).ok())
            .ok_or(OrderbookError::Unaligned)?;
        prepare(body)?;
    }
    mark_ready(&mut data, header)
}

/// The header and data of an unready account of the kind with `tag`, `seed`
/// and full length `len`, borrowed for writing once it has that length.
#[inline(never)]
fn unready_full_data<'a, 'info>(
    account: &'a AccountInfo<'info>,
    scope: Scope<'_>,
    tag: [u8; 8],
    seed: &[u8],
    len: usize,
) -> Result<(Header, RefMut<'a, &'info mut [u8]>)> {
    let header = unready_header_of(account, scope, tag, seed)?;
    let data = account.try_borrow_mut_data()?;
    require!(data.len() == len, OrderbookError::WrongSize);
    Ok((header, data))
}

#[inline(never)]
fn mark_ready(data: &mut [u8], header: Header) -> Result<()> {
    let ready = Header {
        ready: READY,
        ..header
    };
    data.get_mut(..HEADER_LEN)
        .ok_or(OrderbookError::AccountMissing)?
        .copy_from_slice(bytemuck::bytes_of(&ready));
    Ok(())
}

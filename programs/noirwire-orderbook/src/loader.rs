use anchor_lang::prelude::*;
use core::cell::{Ref, RefMut};
use core::mem::size_of;

use crate::errors::OrderbookError;
use crate::state::{Header, RollupAccount, ViewData, HEADER_LEN, READY};

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
        [T::SEED, self.extra(), bump]
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
fn checked_header<T: RollupAccount>(
    account: &AccountInfo,
    scope: Scope<'_>,
    data: &[u8],
) -> Result<Header> {
    require_keys_eq!(*account.owner, crate::ID, OrderbookError::WrongOwner);
    let bytes = data
        .get(..HEADER_LEN)
        .ok_or(OrderbookError::AccountMissing)?;
    let header: Header = *bytemuck::try_from_bytes(bytes).map_err(|_| OrderbookError::Unaligned)?;
    require!(header.tag == T::TAG, OrderbookError::WrongKind);
    let bump = [header.bump];
    let seeds = scope.seeds::<T>(&bump);
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

/// The body of a ready account, for reading.
pub fn load<'a, T: RollupAccount>(
    account: &'a AccountInfo<'_>,
    scope: Scope<'_>,
) -> Result<Ref<'a, T>> {
    let data = account.try_borrow_data()?;
    let header = checked_header::<T>(account, scope, &data)?;
    ready_body(&data, &header, T::LEN)?;
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
    require!(account.is_writable, ErrorCode::ConstraintMut);
    let data = account.try_borrow_mut_data()?;
    let header = checked_header::<T>(account, scope, &data)?;
    ready_body(&data, &header, T::LEN)?;
    RefMut::filter_map(data, |data| {
        data.get_mut(HEADER_LEN..HEADER_LEN + size_of::<T>())
            .and_then(|body| bytemuck::try_from_bytes_mut(body).ok())
    })
    .map_err(|_| OrderbookError::Unaligned.into())
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

/// A view named by its address alone, for reading: loaded at the address
/// derived from the owner it states.
#[inline(always)]
pub(crate) fn load_view<'a>(account: &'a AccountInfo<'_>) -> Result<Ref<'a, ViewData>> {
    let owner = stated_owner(account)?;
    load::<ViewData>(account, Scope::Owner(&owner))
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
pub fn unready_header<T: RollupAccount>(account: &AccountInfo, scope: Scope<'_>) -> Result<Header> {
    let data = account.try_borrow_data()?;
    let header = checked_header::<T>(account, scope, &data)?;
    require!(header.ready != READY, OrderbookError::AlreadyReady);
    Ok(header)
}

/// Writes the header of a freshly created account. The account must be
/// empty of any header, which is what a new ephemeral account is.
pub fn write_header<T: RollupAccount>(
    account: &AccountInfo,
    market_id: u8,
    bump: u8,
) -> Result<()> {
    let mut data = account.try_borrow_mut_data()?;
    let bytes = data
        .get_mut(..HEADER_LEN)
        .ok_or(OrderbookError::AccountMissing)?;
    require!(
        bytes.iter().all(|byte| *byte == 0),
        OrderbookError::AccountExists
    );
    let header = Header {
        tag: T::TAG,
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
    let header = unready_header::<T>(account, scope)?;
    let mut data = account.try_borrow_mut_data()?;
    require!(data.len() == T::LEN, OrderbookError::WrongSize);
    {
        let body = data
            .get_mut(HEADER_LEN..HEADER_LEN + size_of::<T>())
            .and_then(|body| bytemuck::try_from_bytes_mut::<T>(body).ok())
            .ok_or(OrderbookError::Unaligned)?;
        prepare(body)?;
    }
    let ready = Header {
        ready: READY,
        ..header
    };
    data.get_mut(..HEADER_LEN)
        .ok_or(OrderbookError::AccountMissing)?
        .copy_from_slice(bytemuck::bytes_of(&ready));
    Ok(())
}

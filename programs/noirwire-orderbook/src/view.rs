use anchor_lang::prelude::*;
use noirwire_orderbook_engine::{PlaceOutcome, Trader};

use crate::errors::OrderbookError;
use crate::state::{OrderResult, ViewData, ORDER_KEYS, RESULTS, RESULT_PLACE};

/// A usable order key is a real key that is not the owner and not already one
/// of the four, so no two live keys are equal and the owner never signs a trade.
pub fn check_order_keys(owner: &Pubkey, keys: &[Pubkey; ORDER_KEYS]) -> Result<()> {
    for (position, key) in keys.iter().enumerate() {
        require!(*key != Pubkey::default(), OrderbookError::InvalidOrderKey);
        require!(key != owner, OrderbookError::InvalidOrderKey);
        require!(
            !keys[..position].contains(key),
            OrderbookError::InvalidOrderKey
        );
    }
    Ok(())
}

fn check_replacement(view: &ViewData, replacement: &Pubkey) -> Result<()> {
    let bytes = replacement.to_bytes();
    require!(
        *replacement != Pubkey::default(),
        OrderbookError::InvalidOrderKey
    );
    require!(bytes != view.owner, OrderbookError::InvalidOrderKey);
    require!(
        !view.order_keys.contains(&bytes),
        OrderbookError::InvalidOrderKey
    );
    Ok(())
}

/// Consumes the order key that signed and puts the replacement in its place.
/// It runs before anything else an order-key instruction does, so a key that
/// was used once is gone whatever happens next.
pub fn use_order_key(view: &mut ViewData, signer: &Pubkey, replacement: &Pubkey) -> Result<()> {
    let position = view
        .order_keys
        .iter()
        .position(|key| *key == signer.to_bytes())
        .ok_or(OrderbookError::NotOrderKey)?;
    check_replacement(view, replacement)?;
    view.order_keys[position] = replacement.to_bytes();
    Ok(())
}

pub fn set_order_keys(view: &mut ViewData, keys: &[Pubkey; ORDER_KEYS]) -> Result<()> {
    check_order_keys(&Pubkey::new_from_array(view.owner), keys)?;
    for (slot, key) in view.order_keys.iter_mut().zip(keys) {
        *slot = key.to_bytes();
    }
    Ok(())
}

pub fn trader(view: &ViewData) -> Trader<'_> {
    Trader {
        seat: view.seat,
        owner: &view.owner,
    }
}

pub fn push_result(view: &mut ViewData, result: OrderResult) -> Result<()> {
    let at = usize::try_from(view.results_written % RESULTS as u32)
        .map_err(|_| OrderbookError::MathOverflow)?;
    view.results[at] = result;
    view.results_written = view
        .results_written
        .checked_add(1)
        .ok_or(OrderbookError::MathOverflow)?;
    Ok(())
}

pub fn placed(client_order_id: u64, outcome: &PlaceOutcome) -> OrderResult {
    OrderResult {
        client_order_id,
        order_seq: outcome.resting_order_seq.unwrap_or(0),
        filled: outcome.filled,
        filled_notional: outcome.filled_notional,
        rested: outcome.rested,
        cancelled: outcome.cancelled,
        fee: outcome.fee_paid,
        kind: RESULT_PLACE,
        status: outcome.status.code(),
        code: 0,
        _padding: [0; 4],
    }
}

pub fn refused(client_order_id: u64, kind: u8, status: u8, code: u16, size: u64) -> OrderResult {
    OrderResult {
        client_order_id,
        cancelled: size,
        kind,
        status,
        code,
        ..OrderResult::default()
    }
}

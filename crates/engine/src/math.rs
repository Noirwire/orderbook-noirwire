use crate::error::{EngineError, EngineResult};
use crate::state::{TokenBalance, BALANCE_CAP};

pub(crate) const BPS_DENOMINATOR: u128 = 10_000;
pub(crate) const BPS_DENOMINATOR_SIGNED: i128 = 10_000;
const BPS_ROUND_UP: u128 = 9_999;

/// RULES 1: notional is `price * size` in quote atoms. Two u64 always fit a u128.
pub(crate) fn notional(price: u64, size: u64) -> EngineResult<u128> {
    u128::from(price)
        .checked_mul(u128::from(size))
        .ok_or(EngineError::MathOverflow)
}

/// RULES 1: fees and penalties round up against the payer.
pub(crate) fn bps_ceil(amount: u128, bps: u16) -> EngineResult<u128> {
    amount
        .checked_mul(u128::from(bps))
        .and_then(|scaled| scaled.checked_add(BPS_ROUND_UP))
        .and_then(|rounded| rounded.checked_div(BPS_DENOMINATOR))
        .ok_or(EngineError::MathOverflow)
}

/// RULES 5: a spot bid locks its notional plus the taker fee on that notional.
pub(crate) fn bid_lock(price: u64, size: u64, fee_bps: u16) -> EngineResult<u128> {
    let amount = notional(price, size)?;
    amount
        .checked_add(bps_ceil(amount, fee_bps)?)
        .ok_or(EngineError::MathOverflow)
}

pub(crate) fn base_atoms(size: u64, base_lot: u64) -> EngineResult<u128> {
    notional(size, base_lot)
}

pub(crate) fn u64_from(value: u128) -> EngineResult<u64> {
    u64::try_from(value).map_err(|_| EngineError::MathOverflow)
}

pub(crate) fn i64_from(value: i128) -> EngineResult<i64> {
    i64::try_from(value).map_err(|_| EngineError::MathOverflow)
}

pub(crate) fn signed(value: u128) -> EngineResult<i128> {
    i128::try_from(value).map_err(|_| EngineError::MathOverflow)
}

pub(crate) fn index(value: u32) -> EngineResult<usize> {
    usize::try_from(value).map_err(|_| EngineError::MathOverflow)
}

pub(crate) fn count(value: usize) -> EngineResult<u32> {
    u32::try_from(value).map_err(|_| EngineError::MathOverflow)
}

pub(crate) fn add(a: i128, b: i128) -> EngineResult<i128> {
    a.checked_add(b).ok_or(EngineError::MathOverflow)
}

pub(crate) fn sub(a: i128, b: i128) -> EngineResult<i128> {
    a.checked_sub(b).ok_or(EngineError::MathOverflow)
}

pub(crate) fn mul(a: i128, b: i128) -> EngineResult<i128> {
    a.checked_mul(b).ok_or(EngineError::MathOverflow)
}

pub(crate) fn increment(value: u64) -> EngineResult<u64> {
    value.checked_add(1).ok_or(EngineError::MathOverflow)
}

pub(crate) fn credit(balance: &mut u64, amount: u128) -> EngineResult<()> {
    *balance = u128::from(*balance)
        .checked_add(amount)
        .ok_or(EngineError::MathOverflow)
        .and_then(u64_from)?;
    Ok(())
}

pub(crate) fn debit(balance: &mut u64, amount: u128, shortfall: EngineError) -> EngineResult<()> {
    *balance = u128::from(*balance)
        .checked_sub(amount)
        .ok_or(shortfall)
        .and_then(u64_from)?;
    Ok(())
}

/// RULES 12: a credit that would take a seat's holding of one token, available plus
/// locked, above the cap is refused.
pub(crate) fn credit_token(balance: &mut TokenBalance, amount: u128) -> EngineResult<()> {
    let held = u128::from(balance.available)
        .checked_add(u128::from(balance.locked))
        .and_then(|held| held.checked_add(amount));
    match held {
        Some(held) if held <= u128::from(BALANCE_CAP) => credit(&mut balance.available, amount),
        _ => Err(EngineError::BalanceCapExceeded),
    }
}

/// RULES 12: collateral stays within the cap in both directions.
pub(crate) fn credit_signed(balance: &mut i64, amount: i128) -> EngineResult<()> {
    let after = add(i128::from(*balance), amount)?;
    if after.unsigned_abs() > u128::from(BALANCE_CAP) {
        return Err(EngineError::BalanceCapExceeded);
    }
    *balance = i64_from(after)?;
    Ok(())
}

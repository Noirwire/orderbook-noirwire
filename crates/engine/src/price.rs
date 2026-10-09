use crate::error::{EngineError, EngineResult};
use crate::math::{notional, BPS_DENOMINATOR};
use crate::state::{MarketParams, Price};

/// RULES 9: publish time must not go backwards, and a price that differs from the
/// previous one by more than `max_move_bps` is rejected. The first price is accepted
/// as it is. Who may publish is the caller's check.
pub fn publish_price(
    feed: &mut Price,
    params: &MarketParams,
    price: u64,
    publish_time: i64,
) -> EngineResult<()> {
    if price == 0 {
        return Err(EngineError::ZeroPrice);
    }
    if publish_time < feed.publish_time {
        return Err(EngineError::PriceTimeWentBackwards);
    }
    if feed.price != 0 {
        let moved = u128::from(price.abs_diff(feed.price))
            .checked_mul(BPS_DENOMINATOR)
            .ok_or(EngineError::MathOverflow)?;
        let allowed = notional(feed.price, u64::from(params.max_move_bps))?;
        if moved > allowed {
            return Err(EngineError::PriceMoveTooLarge);
        }
    }
    *feed = Price {
        price,
        publish_time,
    };
    Ok(())
}

/// RULES 9: the admin's reset. It skips the move limit and the time check.
pub fn reset_price(feed: &mut Price, price: u64, publish_time: i64) -> EngineResult<()> {
    if price == 0 {
        return Err(EngineError::ZeroPrice);
    }
    *feed = Price {
        price,
        publish_time,
    };
    Ok(())
}

/// RULES 3.3: the price is within `band_bps` of the mark, both ends included.
pub(crate) fn within_band(price: u64, mark: u64, band_bps: u16) -> EngineResult<bool> {
    let distance = u128::from(price.abs_diff(mark))
        .checked_mul(BPS_DENOMINATOR)
        .ok_or(EngineError::MathOverflow)?;
    Ok(distance <= notional(mark, u64::from(band_bps))?)
}

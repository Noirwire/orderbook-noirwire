use crate::error::{EngineError, EngineResult};
use crate::math::{notional, BPS_DENOMINATOR};
use crate::state::{MarketParams, Price, Side, OUTER_BAND_BPS, STATUS_REDUCE_ONLY};

/// RULES 9: publish time must be later than the previous one by at least
/// `min_publish_gap` seconds and must not be later than `now`. A price that differs
/// from the previous one by more than `max_move_bps` is rejected; together with the gap
/// this bounds how fast the mark can move. The first price of a feed has nothing to
/// be compared with. Who may publish is the caller's check.
pub fn publish_price(
    feed: &mut Price,
    params: &MarketParams,
    price: u64,
    publish_time: i64,
    now: i64,
) -> EngineResult<()> {
    if price == 0 {
        return Err(EngineError::ZeroPrice);
    }
    if publish_time > now {
        return Err(EngineError::PriceFromTheFuture);
    }
    if publish_time <= feed.publish_time {
        return Err(EngineError::PriceTimeWentBackwards);
    }
    if feed.price != 0 {
        let elapsed = publish_time
            .checked_sub(feed.publish_time)
            .ok_or(EngineError::MathOverflow)?;
        if elapsed < i64::from(params.min_publish_gap) {
            return Err(EngineError::PricePublishedTooSoon);
        }
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

/// RULES 9: the admin's reset. It skips the move limit and the time checks, and puts
/// the market in reduce-only status until the admin returns it to normal.
pub fn reset_price(
    feed: &mut Price,
    params: &mut MarketParams,
    price: u64,
    publish_time: i64,
) -> EngineResult<()> {
    if price == 0 {
        return Err(EngineError::ZeroPrice);
    }
    *feed = Price {
        price,
        publish_time,
    };
    params.status = STATUS_REDUCE_ONLY;
    Ok(())
}

fn further_than(price: u64, mark: u64, band_bps: u16) -> EngineResult<bool> {
    let distance = u128::from(price.abs_diff(mark))
        .checked_mul(BPS_DENOMINATOR)
        .ok_or(EngineError::MathOverflow)?;
    Ok(distance > notional(mark, u64::from(band_bps))?)
}

/// RULES 3.3, the crossing band: a bid more than `band_bps` above the mark, or an ask
/// more than `band_bps` below it. The edge itself is allowed. Checked when an order is
/// placed and again, against the mark of that moment, when matching reaches it resting.
pub(crate) fn breaches_crossing_band(
    side: Side,
    price: u64,
    mark: u64,
    band_bps: u16,
) -> EngineResult<bool> {
    let on_the_crossing_side = match side {
        Side::Bid => price > mark,
        Side::Ask => price < mark,
    };
    Ok(on_the_crossing_side && further_than(price, mark, band_bps)?)
}

/// RULES 3.3, the outer band: further than 50% from the mark in either direction.
pub(crate) fn breaches_outer_band(price: u64, mark: u64) -> EngineResult<bool> {
    further_than(price, mark, OUTER_BAND_BPS)
}

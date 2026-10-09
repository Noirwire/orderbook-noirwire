use crate::error::{EngineError, EngineResult};
use crate::margin::is_fresh;
use crate::math::{add, i64_from, mul, sub, BPS_DENOMINATOR_SIGNED};
use crate::seats::Env;
use crate::state::{MarketKind, MarketMut, STATUS_PAUSED};

const MID_DENOMINATOR: i128 = 2;

/// RULES 7: the change of `F` for one interval. Premium is `(mid - mark) / mark`, zero
/// when either side of the book is empty, clamped to `funding_cap_bps`. The only
/// rounding is the final one, toward zero.
fn index_step(
    best_bid: Option<u64>,
    best_ask: Option<u64>,
    mark: u64,
    cap_bps: u16,
) -> EngineResult<i128> {
    let (Some(bid), Some(ask)) = (best_bid, best_ask) else {
        return Ok(0);
    };
    let mark = i128::from(mark);
    let twice_mark = mul(mark, MID_DENOMINATOR)?;
    let twice_premium = sub(add(i128::from(bid), i128::from(ask))?, twice_mark)?;
    let cap = i128::from(cap_bps);
    let beyond_cap = mul(twice_premium.abs(), BPS_DENOMINATOR_SIGNED)? > mul(cap, twice_mark)?;
    let step = if beyond_cap {
        let capped = mul(mark, cap)?
            .checked_div(BPS_DENOMINATOR_SIGNED)
            .ok_or(EngineError::MathOverflow)?;
        if twice_premium < 0 {
            sub(0, capped)?
        } else {
            capped
        }
    } else {
        twice_premium
            .checked_div(MID_DENOMINATOR)
            .ok_or(EngineError::MathOverflow)?
    };
    Ok(step)
}

/// RULES 7: anyone may call. Does nothing, and returns `false`, unless
/// `funding_interval` has passed. Otherwise applies exactly one interval and sets the
/// last update time to now. Missed intervals are not caught up.
pub fn update_funding(market: &mut MarketMut<'_>, env: &Env<'_>) -> EngineResult<bool> {
    if market.checked_kind()? != MarketKind::Perp {
        return Err(EngineError::NotPerpMarket);
    }
    if env.exchange_paused {
        return Err(EngineError::ExchangePaused);
    }
    if market.params.status == STATUS_PAUSED {
        return Err(EngineError::MarketPaused);
    }
    let elapsed = env
        .now
        .checked_sub(market.book.last_funding_time)
        .ok_or(EngineError::MathOverflow)?;
    if elapsed < market.params.funding_interval {
        return Ok(false);
    }
    let mark = market.price.price;
    if mark == 0 {
        return Err(EngineError::PriceUnavailable);
    }
    if !is_fresh(
        market.price.publish_time,
        market.params.max_price_age,
        env.now,
    ) {
        return Err(EngineError::StalePrice);
    }
    let step = index_step(
        market.best_bid(),
        market.best_ask(),
        mark,
        market.params.funding_cap_bps,
    )?;
    market.book.funding_index = i64_from(add(i128::from(market.book.funding_index), step)?)?;
    market.book.last_funding_time = env.now;
    Ok(true)
}

use crate::error::{EngineError, EngineResult};
use crate::margin::is_fresh;
use crate::math::BPS_DENOMINATOR;
use crate::seats::Env;
use crate::state::{MarketKind, MarketMut, STATUS_PAUSED};

/// RULES 7: the change of `F` for one interval. Premium is `(traded - mark) / mark`,
/// where `traded` is the size-weighted average fill price since the last update, and
/// zero when nothing traded. It is clamped to `funding_cap_bps`. Inside the cap the
/// step is exactly `traded - mark`; the only rounding is the final one, toward zero.
/// `None` when the totals do not fit the arithmetic.
fn index_step(traded_notional: u64, traded_size: u64, mark: u64, cap_bps: u16) -> Option<i64> {
    if traded_size == 0 {
        return Some(0);
    }
    let size = u128::from(traded_size);
    let at_mark = u128::from(mark).checked_mul(size)?;
    let traded = u128::from(traded_notional);
    let distance = traded.abs_diff(at_mark);
    let cap = u128::from(cap_bps);
    let beyond_cap = distance.checked_mul(BPS_DENOMINATOR)? > at_mark.checked_mul(cap)?;
    let magnitude = if beyond_cap {
        u128::from(mark)
            .checked_mul(cap)?
            .checked_div(BPS_DENOMINATOR)?
    } else {
        distance.checked_div(size)?
    };
    let magnitude = i64::try_from(magnitude).ok()?;
    if traded >= at_mark {
        Some(magnitude)
    } else {
        magnitude.checked_neg()
    }
}

/// RULES 7: anyone may call. Does nothing, and returns `false`, unless
/// `funding_interval` has passed. Otherwise applies exactly one interval, starts a new
/// traded average and sets the last update time to now. Missed intervals are not
/// caught up. An interval whose step does not fit the arithmetic moves `F` by nothing
/// rather than failing, so the next interval can always begin.
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
        market.book.traded_notional,
        market.book.traded_size,
        mark,
        market.params.funding_cap_bps,
    );
    let moved = step.and_then(|step| market.book.funding_index.checked_add(step));
    market.book.funding_index = moved.unwrap_or(market.book.funding_index);
    market.book.traded_notional = 0;
    market.book.traded_size = 0;
    market.book.last_funding_time = env.now;
    Ok(true)
}

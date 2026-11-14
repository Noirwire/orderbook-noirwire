use crate::error::{EngineError, EngineResult};
use crate::margin::is_fresh;
use crate::math::BPS_DENOMINATOR_SIGNED;
use crate::seats::Env;
use crate::state::{
    BookHeader, Incident, MarketKind, MarketMut, MarketParams, FUNDING_CARRY_SCALE,
    FUNDING_FEE_MARGIN, FUNDING_PERIOD, ORACLE_HEALTHY, STATUS_PAUSED,
};

/// RULES 7: one interval's change of `F` and the new carry. The step per lot is
/// `P * interval * fee / max(V * fee * period, K * OI * cap * interval)` in
/// 1/`FUNDING_CARRY_SCALE` of an atom, rounded toward zero, then clamped to
/// `+-mark * cap * interval / (10000 * period)` and added to the carry. `F` takes the
/// whole atoms, rounded toward zero, and the rest is the new carry. No division comes
/// before a multiplication, and every rounding only shrinks a magnitude. `None` when
/// the totals do not fit the arithmetic.
fn index_step(book: &BookHeader, params: &MarketParams, mark: u64) -> Option<(i64, i32)> {
    let fee = i128::from(params.taker_fee_bps);
    let cap = i128::from(params.funding_cap_bps);
    let interval = i128::from(params.funding_interval);
    let period = i128::from(FUNDING_PERIOD);
    let by_volume = i128::from(book.traded_size)
        .checked_mul(fee)?
        .checked_mul(period)?;
    let by_interest = i128::from(book.open_interest)
        .checked_mul(FUNDING_FEE_MARGIN)?
        .checked_mul(cap)?
        .checked_mul(interval)?;
    let depth = by_volume.max(by_interest);
    let raw = if depth == 0 {
        0
    } else {
        i128::from(book.traded_premium)
            .checked_mul(interval)?
            .checked_mul(fee)?
            .checked_mul(FUNDING_CARRY_SCALE)?
            .checked_div(depth)?
    };
    let limit = i128::from(mark)
        .checked_mul(cap)?
        .checked_mul(interval)?
        .checked_mul(FUNDING_CARRY_SCALE)?
        .checked_div(BPS_DENOMINATOR_SIGNED.checked_mul(period)?)?;
    let total = raw
        .clamp(limit.checked_neg()?, limit)
        .checked_add(i128::from(book.funding_carry))?;
    let step = total.checked_div(FUNDING_CARRY_SCALE)?;
    let carry = total.checked_sub(step.checked_mul(FUNDING_CARRY_SCALE)?)?;
    Some((i64::try_from(step).ok()?, i32::try_from(carry).ok()?))
}

/// RULES 7: anyone may call. Does nothing, and returns `false`, while
/// `funding_interval` has not passed, the price source is dislocated or settling, or
/// the mark is 0 or stale; the totals are then kept for the next call. Otherwise
/// applies exactly one interval, starts new totals and sets the last update time to
/// now. Missed intervals are not caught up. An interval whose step does not fit the
/// arithmetic moves neither `F` nor the carry rather than failing, so the next interval
/// can always begin. RULES 9: an interval the source was not healthy at some time in is
/// discarded: new totals start and `F` does not move. `incident` is the market's last
/// one, kept after it ends; the last update time only moves while the source is
/// healthy, so an incident reached into the interval exactly when it opened at or
/// after that time.
pub fn update_funding(
    market: &mut MarketMut<'_>,
    incident: &Incident,
    env: &Env<'_>,
) -> EngineResult<bool> {
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
    if market.params.oracle_health != ORACLE_HEALTHY {
        return Ok(false);
    }
    let incident_in_interval =
        incident.reason != 0 && incident.since >= market.book.last_funding_time;
    if incident_in_interval {
        market.book.traded_premium = 0;
        market.book.traded_size = 0;
        market.book.last_funding_time = env.now;
        return Ok(true);
    }
    let mark = market.price.price;
    let fresh = is_fresh(
        market.price.publish_time,
        market.params.max_price_age,
        env.now,
    );
    if mark == 0 || !fresh {
        return Ok(false);
    }
    let moved = index_step(market.book, market.params, mark).and_then(|(step, carry)| {
        let index = market.book.funding_index.checked_add(step)?;
        Some((index, carry))
    });
    if let Some((index, carry)) = moved {
        market.book.funding_index = index;
        market.book.funding_carry = carry;
    }
    market.book.traded_premium = 0;
    market.book.traded_size = 0;
    market.book.last_funding_time = env.now;
    Ok(true)
}

use crate::error::{EngineError, EngineResult};
use crate::math::{notional, BPS_DENOMINATOR};
use crate::state::{
    Incident, MarketParams, Price, PriceFeed, Side, SourceBinding, SourceRecord,
    INCIDENT_MOVE_BEYOND_LIMIT, INCIDENT_SETTLED_GAP, MAX_PRICE, ORACLE_DISLOCATED, ORACLE_HEALTHY,
    ORACLE_SETTLING, OUTER_BAND_BPS, STATUS_PAUSED, STATUS_REDUCE_ONLY,
};

/// RULES 9: the furthest `expo + quote_decimals - base_decimals` may be from zero.
/// 10^30 times the largest `price * base_lot` still fits the arithmetic.
pub const MAX_PRICE_SCALE: u32 = 30;

/// RULES 9: one reading of a price source as the program parsed it from the bound
/// account. `price * 10^expo` is the price in USD, with the binding's `expo`, which the
/// program has already compared with the account's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Observation {
    pub price: i64,
    pub conf: u64,
    pub publish_time: i64,
}

/// RULES 9 and 12: a mark is above zero and at most `MAX_PRICE`, whoever sets it.
fn require_price_in_range(price: u64) -> EngineResult<()> {
    if price == 0 {
        Err(EngineError::ZeroPrice)
    } else if price > MAX_PRICE {
        Err(EngineError::PriceTooHigh)
    } else {
        Ok(())
    }
}

/// RULES 9: the next mark is stamped at least `min_publish_gap` seconds after the
/// current one and accepted at least that long after it, so stamps in the past cannot
/// stack several steps into one instant.
fn require_gap(
    mark: &Price,
    params: &MarketParams,
    publish_time: i64,
    now: i64,
) -> EngineResult<()> {
    let gap = i64::from(params.min_publish_gap);
    let stamped = publish_time
        .checked_sub(mark.publish_time)
        .ok_or(EngineError::MathOverflow)?;
    let waited = now
        .checked_sub(mark.accepted_at)
        .ok_or(EngineError::MathOverflow)?;
    if stamped < gap || waited < gap {
        Err(EngineError::PricePublishedTooSoon)
    } else {
        Ok(())
    }
}

/// RULES 9: publish time must be later than the previous one by at least
/// `min_publish_gap` seconds and must not be later than `now`, and `now` must be at
/// least `min_publish_gap` seconds after the previous price was accepted, so stamps
/// in the past cannot stack several steps into one instant. A price that differs from
/// the previous one by more than `max_move_bps` is rejected; together with the gap
/// this bounds how fast the mark can move. A feed that has never had a price is
/// refused, since there is nothing to bound its first price by: that one is the
/// admin's `reset_price`, which leaves the market reduce-only until `resume_market`.
/// Who may publish is the caller's check: only a test network's program has an
/// instruction that calls this.
pub fn publish_price(
    feed: &mut Price,
    params: &MarketParams,
    price: u64,
    publish_time: i64,
    now: i64,
) -> EngineResult<()> {
    if feed.price == 0 {
        return Err(EngineError::FeedNotSeeded);
    }
    require_price_in_range(price)?;
    if publish_time > now {
        return Err(EngineError::PriceFromTheFuture);
    }
    if publish_time <= feed.publish_time {
        return Err(EngineError::PriceTimeWentBackwards);
    }
    require_gap(feed, params, publish_time, now)?;
    if further_than(price, feed.price, params.max_move_bps)? {
        return Err(EngineError::PriceMoveTooLarge);
    }
    *feed = Price {
        price,
        publish_time,
        accepted_at: now,
    };
    Ok(())
}

/// RULES 9: a test network's reset. It skips the move limit and the gap but not
/// `MAX_PRICE`, and puts the market in reduce-only status until the admin returns it to
/// normal. It is also how an unbound feed gets its first price, so no market opens on
/// an unbounded one. A publish time later than `now` is refused: no publish could
/// follow it and the feed would read as stale until the clock caught up. One in the
/// past is allowed.
pub fn reset_price(
    feed: &mut Price,
    params: &mut MarketParams,
    price: u64,
    publish_time: i64,
    now: i64,
) -> EngineResult<()> {
    require_price_in_range(price)?;
    if publish_time > now {
        return Err(EngineError::PriceFromTheFuture);
    }
    *feed = Price {
        price,
        publish_time,
        accepted_at: now,
    };
    params.status = STATUS_REDUCE_ONLY;
    Ok(())
}

/// RULES 9, checks 8 to 12: a positive price, a confidence interval no wider than
/// `max_conf_bps` of it, a publish time not after `now`, not older than `max_age` and
/// later than the last one taken from this source. Returns the price. A source that
/// provides no confidence (`max_conf_bps` is `None`) is not measured by it: its
/// confidence field is never read, so a zero there cannot pass for a tight interval.
fn accepted(
    observed: &Observation,
    max_conf_bps: Option<u16>,
    max_age: i64,
    last_publish_time: i64,
    now: i64,
) -> EngineResult<u64> {
    let price = u64::try_from(observed.price)
        .ok()
        .filter(|price| *price > 0)
        .ok_or(EngineError::ZeroPrice)?;
    if let Some(max_conf_bps) = max_conf_bps {
        let conf = u128::from(observed.conf)
            .checked_mul(BPS_DENOMINATOR)
            .ok_or(EngineError::MathOverflow)?;
        if conf > notional(price, u64::from(max_conf_bps))? {
            return Err(EngineError::PriceConfidenceTooWide);
        }
    }
    if observed.publish_time > now {
        return Err(EngineError::PriceFromTheFuture);
    }
    let age = now
        .checked_sub(observed.publish_time)
        .ok_or(EngineError::MathOverflow)?;
    if age > max_age {
        return Err(EngineError::PriceTooOld);
    }
    if observed.publish_time <= last_publish_time {
        return Err(EngineError::PriceTimeWentBackwards);
    }
    Ok(price)
}

/// RULES 9: `expo + quote_decimals - base_decimals`, the power of ten that turns a
/// source price times a lot into quote atoms. Refused beyond `MAX_PRICE_SCALE`.
pub fn price_scale(expo: i32, base_decimals: u8, quote_decimals: u8) -> EngineResult<i32> {
    let scale = expo
        .checked_add(i32::from(quote_decimals))
        .and_then(|scale| scale.checked_sub(i32::from(base_decimals)))
        .ok_or(EngineError::MathOverflow)?;
    if scale.unsigned_abs() > MAX_PRICE_SCALE {
        Err(EngineError::InvalidMarketParams)
    } else {
        Ok(scale)
    }
}

/// RULES 9: a source price in quote atoms per lot, `price * base_lot * 10^scale`,
/// rounded down when the scale is negative, so it is less than one atom low. Refused
/// unless it lands in `1..=MAX_PRICE`.
pub fn observed_mark(price: u64, base_lot: u64, binding: &SourceBinding) -> EngineResult<u64> {
    let scale = price_scale(binding.expo, binding.base_decimals, binding.quote_decimals)?;
    let power = 10u128
        .checked_pow(scale.unsigned_abs())
        .ok_or(EngineError::MathOverflow)?;
    let per_lot = notional(price, base_lot)?;
    let scaled = if scale >= 0 {
        per_lot.checked_mul(power)
    } else {
        per_lot.checked_div(power)
    };
    match scaled {
        Some(0) => Err(EngineError::ZeroPrice),
        Some(mark) if mark <= u128::from(MAX_PRICE) => {
            u64::try_from(mark).map_err(|_| EngineError::PriceTooHigh)
        }
        _ => Err(EngineError::PriceTooHigh),
    }
}

/// How far `target` is from `mark`, in bps of `mark`, rounded down. `mark` is not zero.
fn gap_bps(mark: u64, target: u64) -> EngineResult<u16> {
    let distance = u128::from(mark.abs_diff(target))
        .checked_mul(BPS_DENOMINATOR)
        .and_then(|scaled| scaled.checked_div(u128::from(mark)))
        .ok_or(EngineError::MathOverflow)?;
    Ok(u16::try_from(distance).unwrap_or(u16::MAX))
}

/// RULES 9: `sync_price`, after the program has checked the account it read, its
/// format, feed and exponent. The observation must pass checks 8 to 12 against the
/// market's last observation and `max_price_age`. Then:
///
/// - a feed with no mark yet takes the observation as its first mark, which nothing
///   bounds, so the market turns reduce-only, or stays paused, until `resume_market`;
/// - otherwise the gap rule applies as for any mark, and an observation within
///   `max_move_bps` of the mark becomes the mark. That ends a dislocation, and ends a
///   settlement once its window has passed. A dislocation opened while settling
///   returns to `ORACLE_SETTLING` until that window has passed;
/// - one beyond the limit leaves the mark where it is and opens an incident
///   (`ORACLE_DISLOCATED`), keeping the end of a window still running;
/// - one beyond the limit while dislocated, at least `min_publish_gap` seconds after the
///   incident opened, settles it: the mark jumps to the observation, the market turns
///   `ORACLE_SETTLING` for `settle_window` seconds, or until the end of a window still
///   running if that is later, and reduce-only, or stays paused.
///
/// Each of these is written; an error writes nothing, so a refused account can never
/// open an incident. Settling is the only way the mark moves beyond the limit.
pub fn sync_source(
    feed: &mut PriceFeed,
    params: &mut MarketParams,
    observed: &Observation,
    now: i64,
) -> EngineResult<()> {
    params.check()?;
    let price = accepted(
        observed,
        Some(feed.binding.max_conf_bps),
        params.max_price_age,
        feed.source.publish_time,
        now,
    )?;
    advance(feed, params, observed, price, now, None)
}

/// RULES 9b: how a market's primary price is held by Pyth, which is only a circuit
/// breaker beside it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Breaker {
    /// The most the primary may be from Pyth's latest price, in bps of Pyth's. It is the
    /// one fixed limit: it is never widened for age. It also bounds how far the mark may
    /// drift from the last Pyth price while Pyth is silent.
    pub bps: u16,
    /// Seconds an observation of Pyth stays fresh enough to trip the breaker and to
    /// confirm a liquidation.
    pub max_age: u16,
}

/// RULES 9b: `sync_price` on a market whose mark is a primary price with Pyth beside it
/// as a circuit breaker. `primary` is the observation the mark follows. `pyth` is what
/// the program could read of the market's bound Pyth account, `None` when that account
/// was missing, malformed, owned by another program or for another feed or exponent:
/// such an account is never read as a price and never freezes the mark. A refusal
/// writes nothing, so a primary that is refused can neither move the mark nor open an
/// incident. The primary always has to pass checks 8, 10, 11 and 12 of section 9, with
/// `max_price_age`, the last compared with the mark's publish time and, while the market
/// is dislocated, with the time the dislocation was seen; its confidence is not
/// provided, so check 9 does not apply to it.
///
/// Pyth's latest valid observation is kept in the source record: a price above zero,
/// with a confidence within the binding's `max_conf_bps`, not stamped after the clock
/// and newer than the one kept. It is kept whether or not it is fresh. Then:
///
/// - **Breaker.** With a kept observation at most `breaker.max_age` old, the primary's
///   raw price must be within `breaker.bps` of its raw price, one fixed limit with no
///   allowance for age, or the call is refused (`GuardDisagrees`) and the mark freezes.
///   Within it, the primary is applied exactly as `sync_source` applies an observation.
/// - **Unguarded.** Without one, the primary stands alone, so the mark may follow it
///   only a step of `max_move_bps` at a time (the gap rule allows one step per
///   `min_publish_gap` seconds), and never further than `breaker.bps` from the last
///   Pyth price however long that was ago. A first mark, or a step beyond the limit, is
///   refused (`UnguardedMoveTooLarge`); a mark that would be beyond the cumulative limit,
///   or one with no Pyth price at all to measure from, is refused
///   (`UnguardedDriftTooLarge`). An unguarded call neither opens a dislocation nor
///   settles one.
///
/// No path takes Pyth's price for the mark. A stale primary, a tripped breaker or an
/// unguarded jump leave the mark where it is to age as any mark does. What the mark
/// settles, a liquidation, is the gate's to allow (`LiquidationGate`).
pub fn sync_guarded(
    feed: &mut PriceFeed,
    params: &mut MarketParams,
    primary: &Observation,
    pyth: Option<&Observation>,
    breaker: &Breaker,
    now: i64,
) -> EngineResult<()> {
    params.check()?;
    if breaker.bps == 0 || breaker.max_age == 0 {
        return Err(EngineError::InvalidMarketParams);
    }
    let price = accepted(
        primary,
        None,
        params.max_price_age,
        feed.price.publish_time,
        now,
    )?;
    if params.oracle_health == ORACLE_DISLOCATED && primary.publish_time <= feed.incident.since {
        return Err(EngineError::PriceTimeWentBackwards);
    }
    let latest = latest_pyth(feed, params.base_lot, pyth, now)?;
    let age = now
        .checked_sub(latest.publish_time)
        .ok_or(EngineError::MathOverflow)?;
    let fresh = latest.target != 0 && (0..=i64::from(breaker.max_age)).contains(&age);
    if fresh {
        let pyth_price = u64::try_from(latest.raw_price).map_err(|_| EngineError::ZeroPrice)?;
        if further_than(price, pyth_price, breaker.bps)? {
            return Err(EngineError::GuardDisagrees);
        }
    } else {
        let target = observed_mark(price, params.base_lot, &feed.binding)?;
        let mark = feed.price.price;
        if mark == 0 || further_than(target, mark, params.max_move_bps)? {
            return Err(EngineError::UnguardedMoveTooLarge);
        }
        if latest.target == 0 || further_than(target, latest.target, breaker.bps)? {
            return Err(EngineError::UnguardedDriftTooLarge);
        }
    }
    advance(feed, params, primary, price, now, Some(latest))
}

/// RULES 9b: the source record after `pyth` is read: the observation when it is usable
/// and newer than the one kept, else the one kept.
fn latest_pyth(
    feed: &PriceFeed,
    base_lot: u64,
    pyth: Option<&Observation>,
    now: i64,
) -> EngineResult<SourceRecord> {
    let kept = feed.source;
    let Some(read) = pyth else {
        return Ok(kept);
    };
    let Some(price) = u64::try_from(read.price).ok().filter(|price| *price > 0) else {
        return Ok(kept);
    };
    let conf = u128::from(read.conf)
        .checked_mul(BPS_DENOMINATOR)
        .ok_or(EngineError::MathOverflow)?;
    let within = conf <= notional(price, u64::from(feed.binding.max_conf_bps))?;
    let newer = read.publish_time > kept.publish_time && read.publish_time <= now;
    let target = observed_mark(price, base_lot, &feed.binding);
    Ok(match target {
        Ok(target) if within && newer => SourceRecord {
            raw_price: read.price,
            conf: read.conf,
            publish_time: read.publish_time,
            target,
            observed_at: now,
        },
        _ => kept,
    })
}

/// RULES 8 and 9b: what lets a mark settle money. A liquidation, and the draws on the
/// insurance and fee seats it makes, are done only while Pyth's latest observation,
/// `reference` in quote atoms per lot, is at most `max_age` seconds old and within
/// `band_bps` of the mark.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LiquidationGate {
    pub reference: u64,
    pub published: i64,
    pub max_age: i64,
    pub band_bps: u16,
}

impl LiquidationGate {
    pub fn confirms(&self, mark: u64, now: i64) -> bool {
        let fresh = now
            .checked_sub(self.published)
            .is_some_and(|age| (0..=self.max_age).contains(&age));
        self.reference != 0
            && fresh
            && matches!(further_than(self.reference, mark, self.band_bps), Ok(false))
    }
}

/// RULES 9: an observation that has passed its checks becomes the source record, unless
/// `source` names the record to keep (a primary price's observation is not Pyth's), and
/// the mark follows it, or an incident is opened or settled, as `sync_source` lists.
fn advance(
    feed: &mut PriceFeed,
    params: &mut MarketParams,
    observed: &Observation,
    price: u64,
    now: i64,
    source: Option<SourceRecord>,
) -> EngineResult<()> {
    let target = observed_mark(price, params.base_lot, &feed.binding)?;
    let mut next = *feed;
    let mut market = *params;
    next.source = source.unwrap_or(SourceRecord {
        raw_price: observed.price,
        conf: observed.conf,
        publish_time: observed.publish_time,
        target,
        observed_at: now,
    });
    let follow = Price {
        price: target,
        publish_time: observed.publish_time,
        accepted_at: now,
    };
    let mark = feed.price.price;
    if mark == 0 {
        next.price = follow;
        restrict_unless_paused(&mut market);
    } else {
        require_gap(&feed.price, params, observed.publish_time, now)?;
        let gap_bps = gap_bps(mark, target)?;
        if !further_than(target, mark, params.max_move_bps)? {
            next.price = follow;
            let window_open =
                params.oracle_health != ORACLE_HEALTHY && now < feed.incident.settle_until;
            market.oracle_health = if window_open {
                ORACLE_SETTLING
            } else {
                ORACLE_HEALTHY
            };
        } else if params.oracle_health == ORACLE_DISLOCATED {
            let confirmed_after = now
                .checked_sub(feed.incident.since)
                .ok_or(EngineError::MathOverflow)?;
            if confirmed_after < i64::from(params.min_publish_gap) {
                return Err(EngineError::PricePublishedTooSoon);
            }
            let window_end = now
                .checked_add(params.settle_window)
                .ok_or(EngineError::MathOverflow)?;
            next.price = follow;
            next.incident = Incident {
                settle_until: window_end.max(feed.incident.settle_until),
                gap_bps,
                reason: INCIDENT_SETTLED_GAP,
                ..feed.incident
            };
            market.oracle_health = ORACLE_SETTLING;
            restrict_unless_paused(&mut market);
        } else {
            let unfinished_settlement = if params.oracle_health == ORACLE_SETTLING {
                feed.incident.settle_until
            } else {
                0
            };
            next.incident = Incident {
                since: now,
                settle_until: unfinished_settlement,
                gap_bps,
                reason: INCIDENT_MOVE_BEYOND_LIMIT,
                _padding: [0; 5],
            };
            market.oracle_health = ORACLE_DISLOCATED;
        }
    }
    *feed = next;
    *params = market;
    Ok(())
}

/// RULES 9: a mark nothing bounded leaves the market reduce-only until the admin's
/// `resume_market`; a paused market stays paused.
fn restrict_unless_paused(market: &mut MarketParams) {
    if market.status != STATUS_PAUSED {
        market.status = STATUS_REDUCE_ONLY;
    }
}

/// RULES 9a: how the USDC guard reads its source.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct QuoteRules {
    /// Zero or negative: one dollar is `10^-expo`.
    pub expo: i32,
    pub max_conf_bps: u16,
    /// How far from one dollar, in bps, the price may be.
    pub depeg_bps: u16,
    /// How long one healthy observation keeps the guard healthy.
    pub max_age: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QuoteVerdict {
    /// The guard passes until `ok_until`, its publish time plus `max_age`.
    Healthy {
        ok_until: i64,
    },
    Depegged,
}

/// RULES 9a: `sync_quote`, after the program has checked the account it read. The
/// observation passes checks 8 to 12 against `last_publish_time` and `max_age`; then it
/// is a depeg when it is more than `depeg_bps` from one dollar.
pub fn check_quote(
    rules: &QuoteRules,
    last_publish_time: i64,
    observed: &Observation,
    now: i64,
) -> EngineResult<QuoteVerdict> {
    let price = accepted(
        observed,
        Some(rules.max_conf_bps),
        rules.max_age,
        last_publish_time,
        now,
    )?;
    let digits = rules
        .expo
        .checked_neg()
        .and_then(|digits| u32::try_from(digits).ok())
        .ok_or(EngineError::InvalidMarketParams)?;
    let one = 10u64
        .checked_pow(digits)
        .ok_or(EngineError::InvalidMarketParams)?;
    if further_than(price, one, rules.depeg_bps)? {
        return Ok(QuoteVerdict::Depegged);
    }
    let ok_until = observed
        .publish_time
        .checked_add(rules.max_age)
        .ok_or(EngineError::MathOverflow)?;
    Ok(QuoteVerdict::Healthy { ok_until })
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

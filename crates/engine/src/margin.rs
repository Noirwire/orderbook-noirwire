use crate::error::{EngineError, EngineResult};
use crate::math::{add, i64_from, mul, signed, sub, BPS_DENOMINATOR_SIGNED};
use crate::state::{BookHeader, MarketKind, MarketParams, PerpSlot, Price, Seat, Side};

/// What a margin calculation needs to know about one market. The caller builds one per
/// market, indexed by market id, so a cross-margin account can be valued in one call.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MarketRisk {
    pub is_perp: bool,
    pub mark: u64,
    pub publish_time: i64,
    pub max_price_age: i64,
    pub max_age_liquidation: i64,
    pub funding_index: i64,
    /// RULES 6: a recorded shortfall on any market stops collateral withdrawals.
    pub uncovered_shortfall: u64,
    pub im_bps: u16,
    pub mm_bps: u16,
}

impl MarketRisk {
    pub const NONE: MarketRisk = MarketRisk {
        is_perp: false,
        mark: 0,
        publish_time: 0,
        max_price_age: 0,
        max_age_liquidation: 0,
        funding_index: 0,
        uncovered_shortfall: 0,
        im_bps: 0,
        mm_bps: 0,
    };

    pub fn new(params: &MarketParams, price: &Price, book: &BookHeader) -> MarketRisk {
        MarketRisk {
            is_perp: matches!(params.kind(), Ok(MarketKind::Perp)),
            mark: price.price,
            publish_time: price.publish_time,
            max_price_age: params.max_price_age,
            max_age_liquidation: params.max_age_liquidation,
            funding_index: book.funding_index,
            uncovered_shortfall: params.uncovered_shortfall,
            im_bps: params.im_bps,
            mm_bps: params.mm_bps,
        }
    }

    /// RULES 9: a feed older than `max_age` is stale. A missing price, or one stamped
    /// later than `now`, is treated as stale too.
    pub fn is_fresh(&self, now: i64) -> bool {
        self.mark > 0 && is_fresh(self.publish_time, self.max_price_age, now)
    }

    /// RULES 9: liquidation tolerates an older feed, up to `max_age_liquidation`.
    pub fn is_fresh_for_liquidation(&self, now: i64) -> bool {
        self.mark > 0 && is_fresh(self.publish_time, self.max_age_liquidation, now)
    }
}

pub(crate) fn is_fresh(publish_time: i64, max_age: i64, now: i64) -> bool {
    now.checked_sub(publish_time)
        .is_some_and(|age| age >= 0 && age <= max_age)
}

/// The caller's per-market data, with the market being traded replaced by the values
/// the engine reads itself from that market's own accounts.
pub(crate) struct Risk<'a> {
    markets: &'a [MarketRisk],
    active: Option<(usize, MarketRisk)>,
}

impl<'a> Risk<'a> {
    pub(crate) fn new(markets: &'a [MarketRisk]) -> Self {
        Risk {
            markets,
            active: None,
        }
    }

    pub(crate) fn with_active(markets: &'a [MarketRisk], market: usize, risk: MarketRisk) -> Self {
        Risk {
            markets,
            active: Some((market, risk)),
        }
    }

    pub(crate) fn priced(&self, market: usize) -> EngineResult<MarketRisk> {
        let found = match self.active {
            Some((active, risk)) if active == market => Some(risk),
            _ => self.markets.get(market).copied(),
        };
        match found {
            Some(risk) if risk.is_perp && risk.mark > 0 => Ok(risk),
            Some(risk) if risk.is_perp => Err(EngineError::PriceUnavailable),
            _ => Err(EngineError::MarketDataMissing),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum MarginKind {
    Initial,
    Maintenance,
}

/// What an order could do to one market's worst-case size, judged before it touches
/// the book so the verdict cannot depend on what the book holds (RULES 3).
#[derive(Clone, Copy)]
pub(crate) struct PendingOrder {
    pub(crate) market: usize,
    /// RULES 6: an order that may rest is counted as resting in full.
    pub(crate) resting: Option<(Side, u64)>,
    /// A reduce-only order is counted as filled in full: the signed change of `base`.
    pub(crate) base_change: i128,
    pub(crate) fee: u128,
}

/// A fill as a signed change of `base`: positive for the buyer.
pub(crate) fn signed_lots(side: Side, size: u64) -> EngineResult<i128> {
    match side {
        Side::Bid => Ok(i128::from(size)),
        Side::Ask => sub(0, i128::from(size)),
    }
}

fn pending_funding(slot: &PerpSlot, funding_index: i64) -> EngineResult<i128> {
    let moved = sub(
        i128::from(funding_index),
        i128::from(slot.funding_checkpoint),
    )?;
    mul(i128::from(slot.base), moved)
}

/// RULES 7: a touched position first pays `base * (F - checkpoint)` out of `quote`.
/// Longs pay when `F` rose.
pub(crate) fn settle_slot(slot: &mut PerpSlot, funding_index: i64) -> EngineResult<()> {
    let payment = pending_funding(slot, funding_index)?;
    slot.quote = i64_from(sub(i128::from(slot.quote), payment)?)?;
    slot.funding_checkpoint = funding_index;
    Ok(())
}

pub(crate) fn settle_positions(seat: &mut Seat, risk: &Risk<'_>) -> EngineResult<()> {
    for (market, slot) in seat.perp.iter_mut().enumerate() {
        if slot.base != 0 {
            settle_slot(slot, risk.priced(market)?.funding_index)?;
        }
    }
    Ok(())
}

/// RULES 6: buyer `base += s`, `quote -= p*s`; seller the reverse. When `base` returns
/// to zero, `quote` is added to collateral and reset. No division.
pub(crate) fn apply_trade(
    seat: &mut Seat,
    market: usize,
    signed_lots: i128,
    price: u64,
) -> EngineResult<()> {
    let slot = seat.slot_mut(market)?;
    let base = i64_from(add(i128::from(slot.base), signed_lots)?)?;
    let quote = sub(i128::from(slot.quote), mul(i128::from(price), signed_lots)?)?;
    slot.base = base;
    if base == 0 {
        slot.quote = 0;
        seat.collateral = i64_from(add(i128::from(seat.collateral), quote)?)?;
    } else {
        slot.quote = i64_from(quote)?;
    }
    Ok(())
}

/// RULES 6: worst-case size = max(max(0, base + open bids), max(0, -base + open asks)).
pub(crate) fn worst_case_lots(
    slot: &PerpSlot,
    pending: Option<&PendingOrder>,
) -> EngineResult<i128> {
    let (extra_bids, extra_asks) = match pending.and_then(|order| order.resting) {
        Some((Side::Bid, size)) => (size, 0),
        Some((Side::Ask, size)) => (0, size),
        None => (0, 0),
    };
    let base_change = pending.map_or(0, |order| order.base_change);
    let base = add(i128::from(slot.base), base_change)?;
    let bids = add(i128::from(slot.open_bid_lots), i128::from(extra_bids))?;
    let asks = add(i128::from(slot.open_ask_lots), i128::from(extra_asks))?;
    let long = add(base, bids)?.max(0);
    let short = sub(asks, base)?.max(0);
    Ok(long.max(short))
}

/// RULES 6: equity = collateral + sum of (`base * mark + quote`), funding settled.
pub(crate) fn equity_of(seat: &Seat, risk: &Risk<'_>) -> EngineResult<i128> {
    let mut total = i128::from(seat.collateral);
    for (market, slot) in seat.perp.iter().enumerate() {
        if slot.base == 0 && slot.quote == 0 {
            continue;
        }
        let priced = risk.priced(market)?;
        let value = mul(i128::from(slot.base), i128::from(priced.mark))?;
        let unpaid = pending_funding(slot, priced.funding_index)?;
        total = add(total, sub(add(value, i128::from(slot.quote))?, unpaid)?)?;
    }
    Ok(total)
}

/// RULES 6: the margin requirement multiplied by 10,000, so no division is needed.
/// Initial uses worst-case size, maintenance uses `|base|`.
pub(crate) fn margin_times_bps(
    seat: &Seat,
    risk: &Risk<'_>,
    kind: MarginKind,
    pending: Option<&PendingOrder>,
) -> EngineResult<i128> {
    let mut total: i128 = 0;
    for (market, slot) in seat.perp.iter().enumerate() {
        let on_this_market = pending.filter(|order| order.market == market);
        let size = match kind {
            MarginKind::Initial => worst_case_lots(slot, on_this_market)?,
            MarginKind::Maintenance => signed(u128::from(slot.base.unsigned_abs()))?,
        };
        if size == 0 {
            continue;
        }
        let priced = risk.priced(market)?;
        let bps = match kind {
            MarginKind::Initial => priced.im_bps,
            MarginKind::Maintenance => priced.mm_bps,
        };
        let requirement = mul(mul(size, i128::from(priced.mark))?, i128::from(bps))?;
        total = add(total, requirement)?;
    }
    Ok(total)
}

/// RULES 6: accepted only if equity, less the reserved fee, is at least initial margin.
pub(crate) fn meets_initial_margin(
    seat: &Seat,
    risk: &Risk<'_>,
    pending: Option<&PendingOrder>,
) -> EngineResult<bool> {
    let reserved_fee = match pending {
        Some(order) => signed(order.fee)?,
        None => 0,
    };
    let equity = sub(equity_of(seat, risk)?, reserved_fee)?;
    let required = margin_times_bps(seat, risk, MarginKind::Initial, pending)?;
    Ok(mul(equity, BPS_DENOMINATOR_SIGNED)? >= required)
}

/// RULES 8: liquidatable when equity is below maintenance margin.
pub(crate) fn below_maintenance(seat: &Seat, risk: &Risk<'_>) -> EngineResult<bool> {
    let equity = equity_of(seat, risk)?;
    let required = margin_times_bps(seat, risk, MarginKind::Maintenance, None)?;
    Ok(mul(equity, BPS_DENOMINATOR_SIGNED)? < required)
}

pub(crate) fn positions_are_fresh(seat: &Seat, risk: &Risk<'_>, now: i64) -> EngineResult<bool> {
    for (market, slot) in seat.perp.iter().enumerate() {
        if slot.base != 0 && !risk.priced(market)?.is_fresh(now) {
            return Ok(false);
        }
    }
    Ok(true)
}

/// RULES 9: a stale feed on any market where the seat holds a position blocks every
/// decision that depends on the seat's equity.
pub(crate) fn require_fresh_positions(seat: &Seat, risk: &Risk<'_>, now: i64) -> EngineResult<()> {
    if positions_are_fresh(seat, risk, now)? {
        Ok(())
    } else {
        Err(EngineError::StalePrice)
    }
}

fn round_up_to_atoms(times_bps: i128) -> EngineResult<i128> {
    let whole = times_bps
        .checked_div(BPS_DENOMINATOR_SIGNED)
        .ok_or(EngineError::MathOverflow)?;
    let exact = mul(whole, BPS_DENOMINATOR_SIGNED)? == times_bps;
    if exact {
        Ok(whole)
    } else {
        add(whole, 1)
    }
}

/// RULES 6: equity in quote atoms, with unpaid funding counted as already paid.
pub fn equity(seat: &Seat, markets: &[MarketRisk]) -> EngineResult<i128> {
    equity_of(seat, &Risk::new(markets))
}

/// RULES 6: initial margin in quote atoms, rounded up. For whole-atom equity,
/// `equity >= initial_margin` is exactly the unrounded comparison.
pub fn initial_margin(seat: &Seat, markets: &[MarketRisk]) -> EngineResult<i128> {
    round_up_to_atoms(margin_times_bps(
        seat,
        &Risk::new(markets),
        MarginKind::Initial,
        None,
    )?)
}

/// RULES 6: maintenance margin in quote atoms, rounded up.
pub fn maintenance_margin(seat: &Seat, markets: &[MarketRisk]) -> EngineResult<i128> {
    round_up_to_atoms(margin_times_bps(
        seat,
        &Risk::new(markets),
        MarginKind::Maintenance,
        None,
    )?)
}

/// RULES 8: equity below maintenance margin and a fresh feed on `market`, the one to
/// be liquidated. Positions on other markets are valued at their last price.
pub fn is_liquidatable(
    seat: &Seat,
    markets: &[MarketRisk],
    market: usize,
    now: i64,
) -> EngineResult<bool> {
    let risk = Risk::new(markets);
    let fresh = risk.priced(market)?.is_fresh_for_liquidation(now);
    Ok(fresh && below_maintenance(seat, &risk)?)
}

/// RULES 6, "Fill checks", for a fill that does not grow the position: the account
/// must not come out riskier. Maintenance margin must not rise and equity divided by
/// maintenance margin must not fall. The ratios are compared by cross-multiplication;
/// both margins are non-negative, so the direction of the comparison is kept. An
/// account left with no position on any market, which is what a maintenance margin of
/// zero means, carries no risk at all: the fill passes if equity is not negative, so a
/// trader held below initial margin by resting orders can still close completely.
pub(crate) fn not_riskier(
    equity_before: i128,
    maintenance_before: i128,
    equity_after: i128,
    maintenance_after: i128,
) -> EngineResult<bool> {
    if maintenance_after == 0 {
        return Ok(equity_after >= 0);
    }
    if maintenance_after > maintenance_before {
        return Ok(false);
    }
    Ok(mul(equity_after, maintenance_before)? >= mul(equity_before, maintenance_after)?)
}

/// RULES 6, "Fill checks": whether a fill grows a position. A position that ends flat,
/// or ends smaller on the same side, does not. Everything else does, a change of side
/// included, because the account then carries a new exposure.
pub(crate) fn fill_grows_position(base_before: i64, base_after: i64) -> bool {
    let same_side = (base_before > 0) == (base_after > 0);
    let smaller = base_after.unsigned_abs() < base_before.unsigned_abs();
    !(base_after == 0 || (same_side && smaller))
}

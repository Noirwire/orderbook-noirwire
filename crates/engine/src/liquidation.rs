use crate::book::{release_seat_orders, remove_seat_orders, SeatRelease};
use crate::error::{EngineError, EngineResult};
use crate::journal::{Journal, Tx, LIQUIDATION_JOURNAL_ENTRIES};
use crate::margin::{
    apply_trade, below_maintenance, equity_of, margin_times_bps, meets_initial_margin,
    settle_positions, settle_slot, signed_lots, MarginKind, MarketRisk, Risk,
};
use crate::math::{
    add, bps_ceil, count, credit_signed, mul, sub, u64_from, BPS_DENOMINATOR,
    BPS_DENOMINATOR_SIGNED,
};
use crate::seats::{owned_seat, refuse_reserved_seat, Env};
use crate::state::{
    LedgerMut, MarketKind, MarketMut, MarketParams, Seat, Side, Trader, INSURANCE_SEAT,
    STATUS_PAUSED, STATUS_REDUCE_ONLY,
};

/// How a liquidation attempt ended. The numeric codes are stable.
///
/// RULES 8: a liquidator names a seat blind. Whether that seat exists, holds a
/// position or is healthy must not be public, so those cases are `Ok` with a status
/// and change nothing. The caller stores the status where only the liquidator reads it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum LiquidationStatus {
    Liquidated = 1,
    TargetSeatNotOpen = 2,
    NoPosition = 3,
    NotLiquidatable = 4,
    /// The feed of the market being liquidated is older than `max_age_liquidation`.
    StalePrice = 5,
    /// RULES 8.3: the liquidation price is worse for the liquidator than the worst
    /// price it stated.
    WorstPriceExceeded = 6,
    /// RULES 8.4: the liquidator would not meet initial margin after the takeover.
    /// This can only happen when the target was liquidatable, so it is not an error.
    LiquidatorMarginInsufficient = 7,
}

/// What a liquidator asks for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LiquidationRequest {
    pub target: u32,
    /// The most lots the liquidator wants to take over.
    pub size: u64,
    /// RULES 8.3: the worst price the liquidator accepts. It buys a long target's
    /// position, so a higher price is worse; it sells into a short target's, so a
    /// lower price is worse.
    pub worst_price: u64,
}

impl LiquidationStatus {
    pub const fn code(self) -> u8 {
        self as u8
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LiquidationOutcome {
    pub status: LiquidationStatus,
    /// Lots the liquidator took over.
    pub liquidated: u64,
    /// RULES 8.3: mark less the penalty for a long target, mark plus it for a short one.
    pub price: u64,
    pub orders_cancelled: u32,
    /// RULES 8.3a: the part of the penalty that went to the insurance seat.
    pub penalty_to_insurance: u64,
    /// RULES 8.5: what the insurance seat paid toward the target's negative equity.
    pub insurance_paid: u64,
    /// RULES 8.5: what insurance could not cover. When this is not zero the market is
    /// now reduce-only and the amount was added to its recorded shortfall.
    pub uncovered: u64,
}

impl LiquidationOutcome {
    fn nothing_done(status: LiquidationStatus) -> Self {
        LiquidationOutcome {
            status,
            liquidated: 0,
            price: 0,
            orders_cancelled: 0,
            penalty_to_insurance: 0,
            insurance_paid: 0,
            uncovered: 0,
        }
    }
}

struct LiquidationPlan {
    outcome: LiquidationOutcome,
    target: u32,
    bids: SeatRelease,
    asks: SeatRelease,
    bid_len: usize,
    ask_len: usize,
    bid_count: u32,
    ask_count: u32,
    uncovered_shortfall: u64,
    open_interest: u64,
}

enum Planned {
    NothingDone(LiquidationStatus),
    Takeover(LiquidationPlan),
}

impl LiquidationPlan {
    fn apply(&self, market: &mut MarketMut<'_>) {
        remove_seat_orders(market.bids, self.bid_len, self.target, self.bids.from);
        remove_seat_orders(market.asks, self.ask_len, self.target, self.asks.from);
        market.book.bid_count = self.bid_count;
        market.book.ask_count = self.ask_count;
        market.book.open_interest = self.open_interest;
        if self.outcome.uncovered > 0 {
            market.params.uncovered_shortfall = self.uncovered_shortfall;
            market.params.status = STATUS_REDUCE_ONLY;
        }
    }
}

/// RULES 8.3: the penalty per lot rounds up against the target (RULES 1).
fn liquidation_price(mark: u64, penalty_bps: u16, target_is_long: bool) -> EngineResult<u64> {
    let penalty = u64_from(bps_ceil(u128::from(mark), penalty_bps)?)?;
    let price = if target_is_long {
        mark.checked_sub(penalty)
    } else {
        mark.checked_add(penalty)
    };
    price.ok_or(EngineError::MathOverflow)
}

/// RULES 8.5: a target left with no position and negative equity is made whole from
/// the insurance seat as far as its collateral reaches. Returns (paid, uncovered).
fn settle_shortfall(tx: &mut Tx<'_, '_, '_>, target: u32) -> EngineResult<(u64, u64)> {
    let seat = tx.seat(target)?;
    let flat = seat.perp.iter().all(|slot| slot.base == 0);
    if !flat || seat.collateral >= 0 {
        return Ok((0, 0));
    }
    let shortfall = seat.collateral.unsigned_abs();
    let insurance = match tx.seat(INSURANCE_SEAT) {
        Ok(seat) => u64::try_from(seat.collateral).unwrap_or(0),
        Err(_) => 0,
    };
    let paid = shortfall.min(insurance);
    if paid > 0 {
        let amount = i128::from(paid);
        credit_signed(
            &mut tx.seat_mut(INSURANCE_SEAT)?.collateral,
            sub(0, amount)?,
        )?;
        credit_signed(&mut tx.seat_mut(target)?.collateral, amount)?;
    }
    let uncovered = shortfall
        .checked_sub(paid)
        .ok_or(EngineError::InvariantBroken)?;
    Ok((paid, uncovered))
}

/// What the target's side of a takeover comes to, once it is known to be liquidatable.
struct Takeover {
    bids: SeatRelease,
    asks: SeatRelease,
    liquidated: u64,
    price: u64,
    liquidator_side: Side,
}

/// RULES 8.3: the fewest lots whose takeover brings the target back to maintenance
/// margin plus the buffer. Closing one lot costs the target the penalty and frees the
/// lot's maintenance margin and buffer, so with margin linear in size the answer is
/// `ceil(shortage / (mark * (mm_bps + buffer_bps - liq_penalty_bps)))`, both sides
/// already multiplied by 10,000. RULES 12 keeps the divisor positive.
fn lots_that_restore_margin(
    seat: &Seat,
    params: &MarketParams,
    risk: &Risk<'_>,
) -> EngineResult<u64> {
    let market_index = usize::from(params.market_id);
    let mark = i128::from(risk.priced(market_index)?.mark);
    let position = i128::from(seat.slot(market_index)?.base.unsigned_abs());
    let buffer = mul(mul(position, mark)?, i128::from(params.liq_buffer_bps))?;
    let wanted = add(
        margin_times_bps(seat, risk, MarginKind::Maintenance, None)?,
        buffer,
    )?;
    let held = mul(equity_of(seat, risk)?, BPS_DENOMINATOR_SIGNED)?;
    let shortage = sub(wanted, held)?.max(0);
    let freed_bps = add(i128::from(params.mm_bps), i128::from(params.liq_buffer_bps))?;
    let freed_per_lot = mul(mark, sub(freed_bps, i128::from(params.liq_penalty_bps))?)?;
    if freed_per_lot <= 0 {
        return Ok(u64::MAX);
    }
    let whole = shortage
        .checked_div(freed_per_lot)
        .ok_or(EngineError::MathOverflow)?;
    let exact = mul(whole, freed_per_lot)? == shortage;
    let lots = if exact { whole } else { add(whole, 1)? };
    Ok(u64::try_from(lots).unwrap_or(u64::MAX))
}

/// RULES 8.3: the smallest of the requested size, the position and the size that
/// restores margin; the whole position if less than the minimum size would remain.
fn liquidation_size(
    seat: &Seat,
    params: &MarketParams,
    risk: &Risk<'_>,
    requested: u64,
) -> EngineResult<u64> {
    let position = seat
        .slot(usize::from(params.market_id))?
        .base
        .unsigned_abs();
    let size = requested
        .min(position)
        .min(lots_that_restore_margin(seat, params, risk)?);
    let left = position
        .checked_sub(size)
        .ok_or(EngineError::InvariantBroken)?;
    if left > 0 && left < params.min_size {
        Ok(position)
    } else {
        Ok(size)
    }
}

/// RULES 8.1 to 8.3 on the target's seat alone. `Ok(Err(status))` is a target that is
/// not to be liquidated; the seat may have been touched and the caller rolls it back.
fn take_from_target(
    seat: &mut Seat,
    market: &MarketMut<'_>,
    risk: &Risk<'_>,
    request: &LiquidationRequest,
) -> EngineResult<Result<Takeover, LiquidationStatus>> {
    let params = &*market.params;
    let market_index = usize::from(params.market_id);
    let target = request.target;
    settle_positions(seat, risk)?;
    let position = seat.slot(market_index)?.base;
    if position == 0 {
        return Ok(Err(LiquidationStatus::NoPosition));
    }
    if !below_maintenance(seat, risk)? {
        return Ok(Err(LiquidationStatus::NotLiquidatable));
    }
    let target_is_long = position > 0;
    let mark = risk.priced(market_index)?.mark;
    let price = liquidation_price(mark, params.liq_penalty_bps, target_is_long)?;
    let too_expensive = if target_is_long {
        price > request.worst_price
    } else {
        price < request.worst_price
    };
    if too_expensive {
        return Ok(Err(LiquidationStatus::WorstPriceExceeded));
    }
    let liquidated = liquidation_size(seat, params, risk, request.size)?;
    let bids = market.live(Side::Bid)?;
    let asks = market.live(Side::Ask)?;
    let bids = release_seat_orders(seat, params, Side::Bid, bids, target, usize::MAX)?;
    let asks = release_seat_orders(seat, params, Side::Ask, asks, target, usize::MAX)?;
    let liquidator_side = if target_is_long { Side::Bid } else { Side::Ask };
    apply_trade(
        seat,
        market_index,
        signed_lots(liquidator_side.opposite(), liquidated)?,
        price,
    )?;
    Ok(Ok(Takeover {
        bids,
        asks,
        liquidated,
        price,
        liquidator_side,
    }))
}

/// RULES 8.3a: `liq_insurance_share_bps` of the penalty, rounded down, goes to the
/// insurance seat and the liquidator keeps the rest. Zero when the insurance seat is
/// closed or could not take the credit, so the reason never fails a liquidation.
fn insurance_share_of_penalty(
    tx: &Tx<'_, '_, '_>,
    params: &MarketParams,
    mark: u64,
    takeover: &Takeover,
) -> EngineResult<u64> {
    let penalty = u128::from(mark.abs_diff(takeover.price))
        .checked_mul(u128::from(takeover.liquidated))
        .ok_or(EngineError::MathOverflow)?;
    let share = penalty
        .checked_mul(u128::from(params.liq_insurance_share_bps))
        .and_then(|scaled| scaled.checked_div(BPS_DENOMINATOR))
        .ok_or(EngineError::MathOverflow)?;
    let share = u64_from(share)?;
    let fits = match tx.seat(INSURANCE_SEAT) {
        Ok(insurance) => {
            let mut collateral = insurance.collateral;
            credit_signed(&mut collateral, i128::from(share)).is_ok()
        }
        Err(_) => false,
    };
    Ok(if fits { share } else { 0 })
}

/// RULES 8.3a and 8.4 on the liquidator's seat: it receives the position, hands the
/// insurance seat its share of the penalty and must then meet initial margin. Returns
/// that share, or `None` when the margin is not met. Whatever stops the liquidator
/// here, an arithmetic limit included, is reached only once the target was found
/// liquidatable, so the caller reports all of it as a status and never as an error.
fn take_as_liquidator(
    tx: &mut Tx<'_, '_, '_>,
    market: &MarketMut<'_>,
    risk: &Risk<'_>,
    liquidator: u32,
    takeover: &Takeover,
) -> EngineResult<Option<u64>> {
    let params = &*market.params;
    let market_index = usize::from(params.market_id);
    let active = risk.priced(market_index)?;
    let taker = tx.seat_mut(liquidator)?;
    settle_positions(taker, risk)?;
    settle_slot(taker.slot_mut(market_index)?, active.funding_index)?;
    apply_trade(
        taker,
        market_index,
        signed_lots(takeover.liquidator_side, takeover.liquidated)?,
        takeover.price,
    )?;
    let penalty_to_insurance = insurance_share_of_penalty(tx, params, active.mark, takeover)?;
    if penalty_to_insurance > 0 {
        let amount = i128::from(penalty_to_insurance);
        credit_signed(&mut tx.seat_mut(liquidator)?.collateral, sub(0, amount)?)?;
        credit_signed(&mut tx.seat_mut(INSURANCE_SEAT)?.collateral, amount)?;
    }
    let meets = meets_initial_margin(tx.seat(liquidator)?, risk, None)?;
    Ok(meets.then_some(penalty_to_insurance))
}

fn plan_liquidation(
    tx: &mut Tx<'_, '_, '_>,
    market: &MarketMut<'_>,
    env: &Env<'_>,
    liquidator: Trader<'_>,
    request: &LiquidationRequest,
) -> EngineResult<Planned> {
    if market.checked_kind()? != MarketKind::Perp {
        return Err(EngineError::NotPerpMarket);
    }
    let params = &*market.params;
    let market_index = usize::from(params.market_id);
    let (target, size) = (request.target, request.size);
    if env.exchange_paused {
        return Err(EngineError::ExchangePaused);
    }
    if params.status == STATUS_PAUSED {
        return Err(EngineError::MarketPaused);
    }
    if size == 0 {
        return Err(EngineError::ZeroAmount);
    }
    refuse_reserved_seat(liquidator.seat)?;
    if liquidator.seat == target {
        return Err(EngineError::SelfLiquidation);
    }
    tx.journal.require_capacity(LIQUIDATION_JOURNAL_ENTRIES)?;
    owned_seat(tx.seats, liquidator)?;
    let active = MarketRisk::new(params, market.price, market.book);
    let risk = Risk::with_active(env.markets, market_index, active);
    if !active.is_fresh_for_liquidation(env.now) {
        return Ok(Planned::NothingDone(LiquidationStatus::StalePrice));
    }

    let long_lots = |tx: &Tx<'_, '_, '_>, seat: u32| -> EngineResult<i128> {
        Ok(i128::from(tx.seat(seat)?.slot(market_index)?.base.max(0)))
    };
    let longs_before = long_lots(tx, target).and_then(|a| add(a, long_lots(tx, liquidator.seat)?));
    let Ok(seat) = tx.seat_mut(target) else {
        return Ok(Planned::NothingDone(LiquidationStatus::TargetSeatNotOpen));
    };
    let takeover = match take_from_target(seat, market, &risk, request) {
        Ok(Ok(takeover)) => takeover,
        Ok(Err(status)) => return Ok(Planned::NothingDone(status)),
        Err(_) => return Ok(Planned::NothingDone(LiquidationStatus::NotLiquidatable)),
    };

    let Ok(Some(penalty_to_insurance)) =
        take_as_liquidator(tx, market, &risk, liquidator.seat, &takeover)
    else {
        let status = LiquidationStatus::LiquidatorMarginInsufficient;
        return Ok(Planned::NothingDone(status));
    };

    let Ok((insurance_paid, uncovered)) = settle_shortfall(tx, target) else {
        return Ok(Planned::NothingDone(LiquidationStatus::NotLiquidatable));
    };
    let uncovered_shortfall = params.uncovered_shortfall.saturating_add(uncovered);
    let longs_after = add(long_lots(tx, target)?, long_lots(tx, liquidator.seat)?)?;
    let open_interest = add(
        i128::from(market.book.open_interest),
        sub(longs_after, longs_before?)?,
    )?;
    let open_interest = u64::try_from(open_interest).map_err(|_| EngineError::InvariantBroken)?;
    let (bid_len, ask_len) = (market.live(Side::Bid)?.len(), market.live(Side::Ask)?.len());
    let cancelled = takeover
        .bids
        .released
        .checked_add(takeover.asks.released)
        .ok_or(EngineError::InvariantBroken)?;
    let bids_left = bid_len
        .checked_sub(takeover.bids.released)
        .ok_or(EngineError::InvariantBroken)?;
    let asks_left = ask_len
        .checked_sub(takeover.asks.released)
        .ok_or(EngineError::InvariantBroken)?;
    Ok(Planned::Takeover(LiquidationPlan {
        outcome: LiquidationOutcome {
            status: LiquidationStatus::Liquidated,
            liquidated: takeover.liquidated,
            price: takeover.price,
            orders_cancelled: count(cancelled)?,
            penalty_to_insurance,
            insurance_paid,
            uncovered,
        },
        target,
        bids: takeover.bids,
        asks: takeover.asks,
        bid_len,
        ask_len,
        bid_count: count(bids_left)?,
        ask_count: count(asks_left)?,
        uncovered_shortfall,
        open_interest,
    }))
}

/// RULES 8. Blind: when the target seat is not open, holds no position on this
/// market, is not below maintenance margin, this market's feed is older than
/// `max_age_liquidation`, or the liquidation price is beyond the liquidator's worst
/// price, the call succeeds with that status and changes nothing. Otherwise the
/// target's open orders on this market are cancelled, the liquidator takes over the
/// size of RULES 8.3 at the liquidation price, the penalty is split with the insurance
/// seat, and a flat target with negative equity is covered by the insurance seat or,
/// failing that, recorded on the market. Positions on other markets are valued at
/// their last price with no freshness requirement, for the target and the liquidator.
///
/// An `Err` comes only from: a liquidator that is not the seat's owner, whose seat is
/// not open or is reserved, a paused exchange or market, or invalid arguments. A
/// liquidator that would not meet initial margin afterwards is a status too.
pub fn liquidate(
    ledger: &mut LedgerMut<'_>,
    market: &mut MarketMut<'_>,
    journal: &mut Journal<'_>,
    env: &Env<'_>,
    liquidator: Trader<'_>,
    request: &LiquidationRequest,
) -> EngineResult<LiquidationOutcome> {
    journal.begin();
    let planned = {
        let mut tx = Tx {
            seats: &mut *ledger.seats,
            journal: &mut *journal,
        };
        plan_liquidation(&mut tx, market, env, liquidator, request)
    };
    let takeover = match planned {
        Ok(Planned::NothingDone(status)) => {
            journal.rollback(ledger.seats);
            return Ok(LiquidationOutcome::nothing_done(status));
        }
        Ok(Planned::Takeover(plan)) => Ok(plan),
        Err(error) => Err(error),
    };
    let plan = journal.conclude(ledger.seats, takeover)?;
    plan.apply(market);
    Ok(plan.outcome)
}

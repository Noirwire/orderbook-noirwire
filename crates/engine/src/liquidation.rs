use crate::book::{release_seat_orders, remove_seat_orders, SeatRelease};
use crate::error::{EngineError, EngineResult};
use crate::journal::{Journal, Tx, LIQUIDATION_JOURNAL_ENTRIES};
use crate::margin::{
    apply_trade, below_maintenance, meets_initial_margin, require_fresh_positions,
    settle_positions, settle_slot, signed_lots, MarketRisk, Risk,
};
use crate::math::{bps_ceil, count, credit_signed, sub, u64_from};
use crate::seats::{owned_seat, Env};
use crate::state::{
    LedgerMut, MarketKind, MarketMut, Side, Trader, INSURANCE_SEAT, STATUS_PAUSED,
    STATUS_REDUCE_ONLY,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LiquidationOutcome {
    /// Lots the liquidator took over.
    pub liquidated: u64,
    /// RULES 8.3: mark less the penalty for a long target, mark plus it for a short one.
    pub price: u64,
    pub orders_cancelled: u32,
    /// RULES 8.5: what the insurance seat paid toward the target's negative equity.
    pub insurance_paid: u64,
    /// RULES 8.5: what insurance could not cover. When this is not zero the market is
    /// now reduce-only and the amount was added to its recorded shortfall.
    pub uncovered: u64,
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
}

impl LiquidationPlan {
    fn apply(&self, market: &mut MarketMut<'_>) {
        remove_seat_orders(market.bids, self.bid_len, self.target, self.bids.from);
        remove_seat_orders(market.asks, self.ask_len, self.target, self.asks.from);
        market.book.bid_count = self.bid_count;
        market.book.ask_count = self.ask_count;
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
fn cover_shortfall(tx: &mut Tx<'_, '_, '_>, target: u32) -> EngineResult<(u64, u64)> {
    let seat = tx.seat(target)?;
    let flat = seat.perp.iter().all(|slot| slot.base == 0);
    if !flat || seat.collateral >= 0 {
        return Ok((0, 0));
    }
    let shortfall = seat.collateral.unsigned_abs();
    let insurance = if target == INSURANCE_SEAT {
        0
    } else {
        match tx.seat(INSURANCE_SEAT) {
            Ok(seat) => u64::try_from(seat.collateral).unwrap_or(0),
            Err(_) => 0,
        }
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

fn plan_liquidation(
    tx: &mut Tx<'_, '_, '_>,
    market: &MarketMut<'_>,
    env: &Env<'_>,
    liquidator: Trader<'_>,
    target: u32,
    size: u64,
) -> EngineResult<LiquidationPlan> {
    if market.checked_kind()? != MarketKind::Perp {
        return Err(EngineError::NotPerpMarket);
    }
    let params = &*market.params;
    let market_index = usize::from(params.market_id);
    if env.exchange_paused {
        return Err(EngineError::ExchangePaused);
    }
    if params.status == STATUS_PAUSED {
        return Err(EngineError::MarketPaused);
    }
    if size == 0 {
        return Err(EngineError::ZeroAmount);
    }
    if liquidator.seat == target {
        return Err(EngineError::SelfLiquidation);
    }
    tx.journal.require_capacity(LIQUIDATION_JOURNAL_ENTRIES)?;
    owned_seat(tx.seats, liquidator)?;
    let active = MarketRisk::new(params, market.price, market.book);
    let risk = Risk::with_active(env.markets, market_index, active);
    let mark = risk.priced(market_index)?.mark;
    if !active.is_fresh(env.now) {
        return Err(EngineError::StalePrice);
    }

    let seat = tx.seat_mut(target)?;
    require_fresh_positions(seat, &risk, env.now)?;
    settle_positions(seat, &risk)?;
    if !below_maintenance(seat, &risk)? {
        return Err(EngineError::NotLiquidatable);
    }
    let position = seat.slot(market_index)?.base;
    if position == 0 {
        return Err(EngineError::NoPosition);
    }
    let live_bids = market.live(Side::Bid)?;
    let live_asks = market.live(Side::Ask)?;
    let bids = release_seat_orders(seat, params, Side::Bid, live_bids, target, usize::MAX)?;
    let asks = release_seat_orders(seat, params, Side::Ask, live_asks, target, usize::MAX)?;

    let target_is_long = position > 0;
    let liquidated = size.min(position.unsigned_abs());
    let price = liquidation_price(mark, params.liq_penalty_bps, target_is_long)?;
    let liquidator_side = if target_is_long { Side::Bid } else { Side::Ask };
    apply_trade(
        seat,
        market_index,
        signed_lots(liquidator_side.opposite(), liquidated)?,
        price,
    )?;

    let taker = tx.seat_mut(liquidator.seat)?;
    settle_positions(taker, &risk)?;
    settle_slot(taker.slot_mut(market_index)?, active.funding_index)?;
    apply_trade(
        taker,
        market_index,
        signed_lots(liquidator_side, liquidated)?,
        price,
    )?;
    require_fresh_positions(taker, &risk, env.now)?;
    if !meets_initial_margin(taker, &risk, None)? {
        return Err(EngineError::InsufficientMargin);
    }

    let (insurance_paid, uncovered) = cover_shortfall(tx, target)?;
    let uncovered_shortfall = params
        .uncovered_shortfall
        .checked_add(uncovered)
        .ok_or(EngineError::MathOverflow)?;
    let cancelled = bids
        .released
        .checked_add(asks.released)
        .ok_or(EngineError::MathOverflow)?;
    Ok(LiquidationPlan {
        outcome: LiquidationOutcome {
            liquidated,
            price,
            orders_cancelled: count(cancelled)?,
            insurance_paid,
            uncovered,
        },
        target,
        bids,
        asks,
        bid_len: live_bids.len(),
        ask_len: live_asks.len(),
        bid_count: count(
            live_bids
                .len()
                .checked_sub(bids.released)
                .ok_or(EngineError::InvariantBroken)?,
        )?,
        ask_count: count(
            live_asks
                .len()
                .checked_sub(asks.released)
                .ok_or(EngineError::InvariantBroken)?,
        )?,
        uncovered_shortfall,
    })
}

/// RULES 8. Refused, changing nothing, unless the target's equity is below maintenance
/// margin with a fresh price. Then: the target's open orders on this market are
/// cancelled, the liquidator takes over up to `size` lots at the liquidation price and
/// must meet initial margin afterwards, and a flat target with negative equity is
/// covered by the insurance seat or, failing that, recorded on the market.
pub fn liquidate(
    ledger: &mut LedgerMut<'_>,
    market: &mut MarketMut<'_>,
    journal: &mut Journal<'_>,
    env: &Env<'_>,
    liquidator: Trader<'_>,
    target: u32,
    size: u64,
) -> EngineResult<LiquidationOutcome> {
    journal.begin();
    let planned = {
        let mut tx = Tx {
            seats: &mut *ledger.seats,
            journal: &mut *journal,
        };
        plan_liquidation(&mut tx, market, env, liquidator, target, size)
    };
    let plan = journal.conclude(ledger.seats, planned)?;
    plan.apply(market);
    Ok(plan.outcome)
}

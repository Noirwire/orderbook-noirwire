use bytemuck::Zeroable;

use crate::book::{
    close_order_slot, crosses, find_by_sequence, insert_at, insert_index, release_order,
    release_seat_orders, remove_at, remove_seat_orders, truncate,
};
use crate::error::{EngineError, EngineResult};
use crate::journal::{commit_seat, Journal, Tx, PLACE_JOURNAL_EXTRA_ENTRIES};
use crate::margin::{
    apply_trade, is_fresh, meets_initial_margin, require_fresh_positions, settle_positions,
    settle_slot, signed_lots, worst_case_lots, MarketRisk, PendingOrder, Risk,
};
use crate::math::{
    base_atoms, bid_lock, bps_ceil, count, credit, credit_signed, debit, increment, index,
    notional, signed, sub, u64_from,
};
use crate::price::within_band;
use crate::seats::{owned_seat, owned_seat_mut, Env, Sha256};
use crate::state::{
    LedgerMut, MarketKind, MarketMut, MarketParams, Order, Side, Trader, FEE_SEAT, MAX_FILLS,
    ORDER_FLAG_ASK, STATUS_PAUSED, STATUS_REDUCE_ONLY,
};

/// RULES 10: the role byte that ends a receipt's hash input.
pub const ROLE_MAKER: u8 = 0;
pub const ROLE_TAKER: u8 = 1;

const RECEIPT_INPUT_LEN: usize = 25;

/// RULES 2.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OrderType {
    Limit,
    PostOnly,
    ImmediateOrCancel,
    Market,
}

impl OrderType {
    fn rests(self) -> bool {
        matches!(self, OrderType::Limit | OrderType::PostOnly)
    }
}

/// RULES 2: a market order's price is its worst acceptable price.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NewOrder {
    pub side: Side,
    pub order_type: OrderType,
    pub price: u64,
    pub size: u64,
    pub secret: [u8; 16],
    pub reduce_only: bool,
}

/// One fill. The seat indices are for the caller's private bookkeeping only; the
/// public tape carries the rest (RULES 10).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fill {
    pub fill_seq: u64,
    pub price: u64,
    pub size: u64,
    pub taker_side: Side,
    pub maker_receipt: [u8; 8],
    pub taker_receipt: [u8; 8],
    pub maker_seat: u32,
    pub taker_seat: u32,
}

impl Fill {
    const EMPTY: Fill = Fill {
        fill_seq: 0,
        price: 0,
        size: 0,
        taker_side: Side::Bid,
        maker_receipt: [0; 8],
        taker_receipt: [0; 8],
        maker_seat: 0,
        taker_seat: 0,
    };
}

/// The fills of one `place_order`, in execution order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fills {
    len: usize,
    items: [Fill; MAX_FILLS],
}

impl Default for Fills {
    fn default() -> Self {
        Fills::new()
    }
}

impl Fills {
    pub const fn new() -> Self {
        Fills {
            len: 0,
            items: [Fill::EMPTY; MAX_FILLS],
        }
    }

    pub fn as_slice(&self) -> &[Fill] {
        self.items.get(..self.len).unwrap_or(&[])
    }

    fn clear(&mut self) {
        self.len = 0;
    }

    fn push(&mut self, fill: Fill) -> EngineResult<()> {
        let slot = self
            .items
            .get_mut(self.len)
            .ok_or(EngineError::StepLimitTooLarge)?;
        *slot = fill;
        self.len = self.len.checked_add(1).ok_or(EngineError::MathOverflow)?;
        Ok(())
    }
}

/// How an accepted order ended. The numeric codes are stable.
///
/// RULES 3: whatever depends on the contents of the book is reported here and never as
/// an error, because errors are public and the book is not.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum PlaceStatus {
    /// The whole size was filled.
    Filled = 1,
    /// A remainder, or the whole order, rests on the book.
    Rested = 2,
    /// RULES 2: nothing rests by the order's type or flag; what did not match was
    /// cancelled. Covers an order that matched nothing at all.
    RemainderCancelled = 3,
    /// RULES 4: the step limit was reached while the order could still match.
    RemainderCancelledStepLimit = 4,
    /// RULES 3.8: the remainder would rest but that side of the book is full.
    RemainderCancelledBookFull = 5,
    /// RULES 3.7: a post-only order that would match. Nothing at all was changed.
    RefusedPostOnlyWouldMatch = 6,
}

impl PlaceStatus {
    pub const fn code(self) -> u8 {
        self as u8
    }
}

/// Everything a trader's private record of the order needs, since a trader can read
/// neither logs nor return data. `filled + rested + cancelled` equals the size asked for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PlaceOutcome {
    pub status: PlaceStatus,
    pub filled: u64,
    /// Sum of `fill_price * fill_size` over this order's fills, in quote atoms.
    pub filled_notional: u64,
    pub rested: u64,
    pub cancelled: u64,
    pub fee_paid: u64,
    /// The sequence number to cancel the resting remainder by. `None` if nothing rests.
    pub resting_order_seq: Option<u64>,
    /// RULES 4: the step limit was reached while the order could still match.
    pub truncated: bool,
}

/// RULES 10: the first 8 bytes of `sha256(secret || fill sequence LE || role byte)`.
pub fn receipt(hash: Sha256, secret: &[u8; 16], fill_seq: u64, role: u8) -> [u8; 8] {
    let sequence = fill_seq.to_le_bytes();
    let role = [role];
    let mut input = [0u8; RECEIPT_INPUT_LEN];
    let parts = secret.iter().chain(sequence.iter()).chain(role.iter());
    for (target, source) in input.iter_mut().zip(parts) {
        *target = *source;
    }
    let digest = hash(&input);
    let mut receipt = [0u8; 8];
    for (target, source) in receipt.iter_mut().zip(digest.iter()) {
        *target = *source;
    }
    receipt
}

struct Matching<'a> {
    params: &'a MarketParams,
    kind: MarketKind,
    market: usize,
    funding_index: i64,
    taker: u32,
    taker_side: Side,
}

#[derive(Clone, Copy)]
struct PartialFill {
    position: usize,
    remaining: u64,
    locked: u64,
}

struct PlacePlan {
    outcome: PlaceOutcome,
    maker_side: Side,
    maker_len: usize,
    maker_keep: usize,
    maker_count: u32,
    partial: Option<PartialFill>,
    own_len: usize,
    own_count: u32,
    rest: Option<(usize, Order)>,
    next_order_seq: u64,
    next_fill_seq: u64,
}

enum Planned {
    Refused(PlaceOutcome),
    Accepted(PlacePlan),
}

impl PlacePlan {
    fn apply(&self, market: &mut MarketMut<'_>) {
        let (makers, maker_count) = market.side_mut(self.maker_side);
        truncate(makers, self.maker_len, self.maker_keep);
        if let Some(partial) = self.partial {
            if let Some(order) = makers.get_mut(partial.position) {
                order.remaining = partial.remaining;
                order.locked = partial.locked;
            }
        }
        *maker_count = self.maker_count;
        let (own, own_count) = market.side_mut(self.maker_side.opposite());
        if let Some((position, order)) = self.rest {
            insert_at(own, self.own_len, position, order);
        }
        *own_count = self.own_count;
        market.book.next_order_seq = self.next_order_seq;
        market.book.next_fill_seq = self.next_fill_seq;
    }
}

fn taker_fee(params: &MarketParams, price: u64, size: u64) -> EngineResult<u128> {
    bps_ceil(notional(price, size)?, params.taker_fee_bps)
}

/// RULES 5 and 6: the taker fee goes to the fee seat. Spot fees are quote tokens,
/// perp fees are collateral.
fn credit_fee_seat(tx: &mut Tx<'_, '_, '_>, ctx: &Matching<'_>, fee: u128) -> EngineResult<()> {
    if fee == 0 {
        return Ok(());
    }
    let fee_seat = tx.seat_mut(FEE_SEAT).map_err(|error| match error {
        EngineError::JournalFull => error,
        _ => EngineError::FeeSeatNotOpen,
    })?;
    match ctx.kind {
        MarketKind::Spot => credit(
            &mut fee_seat.token_mut(ctx.params.quote_token)?.available,
            fee,
        ),
        MarketKind::Perp => credit_signed(&mut fee_seat.collateral, signed(fee)?),
    }
}

/// RULES 5, seller side as maker: `locked` base falls by the filled lots and quote
/// `available` rises by `fill_price * fill_size`.
/// RULES 5, buyer side as maker: `locked` quote falls by the amount reserved for the
/// filled size, the buyer pays the fill notional, the difference returns to `available`
/// and base `available` rises by the filled lots. Makers pay no fee.
fn settle_spot_maker(
    tx: &mut Tx<'_, '_, '_>,
    ctx: &Matching<'_>,
    maker: &Order,
    size: u64,
) -> EngineResult<u64> {
    let params = ctx.params;
    let paid = notional(maker.price, size)?;
    let lots = base_atoms(size, params.base_lot)?;
    let seat = tx.seat_mut(maker.seat)?;
    let locked_after = match ctx.taker_side {
        Side::Bid => {
            debit(
                &mut seat.token_mut(params.base_token)?.locked,
                lots,
                EngineError::InvariantBroken,
            )?;
            credit(&mut seat.token_mut(params.quote_token)?.available, paid)?;
            0
        }
        Side::Ask => {
            let left = maker
                .remaining
                .checked_sub(size)
                .ok_or(EngineError::InvariantBroken)?;
            let after_payment = u128::from(maker.locked)
                .checked_sub(paid)
                .ok_or(EngineError::InvariantBroken)?;
            let locked_after =
                after_payment.min(bid_lock(maker.price, left, params.taker_fee_bps)?);
            let leaves_lock = u128::from(maker.locked)
                .checked_sub(locked_after)
                .ok_or(EngineError::InvariantBroken)?;
            let returned = after_payment
                .checked_sub(locked_after)
                .ok_or(EngineError::InvariantBroken)?;
            let quote = seat.token_mut(params.quote_token)?;
            debit(&mut quote.locked, leaves_lock, EngineError::InvariantBroken)?;
            credit(&mut quote.available, returned)?;
            credit(&mut seat.token_mut(params.base_token)?.available, lots)?;
            u64_from(locked_after)?
        }
    };
    if size == maker.remaining {
        close_order_slot(seat, ctx.market)?;
    }
    Ok(locked_after)
}

/// RULES 5, taker side. A buyer pays the fill notional plus the fee from `available`,
/// so any price improvement never leaves it. A seller receives the notional and then
/// pays the fee from it.
fn settle_spot_taker(
    tx: &mut Tx<'_, '_, '_>,
    ctx: &Matching<'_>,
    price: u64,
    size: u64,
    fee: u128,
) -> EngineResult<()> {
    let params = ctx.params;
    let paid = notional(price, size)?;
    let lots = base_atoms(size, params.base_lot)?;
    let seat = tx.seat_mut(ctx.taker)?;
    match ctx.taker_side {
        Side::Bid => {
            let cost = paid.checked_add(fee).ok_or(EngineError::MathOverflow)?;
            debit(
                &mut seat.token_mut(params.quote_token)?.available,
                cost,
                EngineError::InsufficientBalance,
            )?;
            credit(&mut seat.token_mut(params.base_token)?.available, lots)
        }
        Side::Ask => {
            debit(
                &mut seat.token_mut(params.base_token)?.available,
                lots,
                EngineError::InsufficientBalance,
            )?;
            let quote = seat.token_mut(params.quote_token)?;
            credit(&mut quote.available, paid)?;
            debit(&mut quote.available, fee, EngineError::InsufficientBalance)
        }
    }
}

/// RULES 4 and 6: a resting maker order is filled without re-checking the maker's
/// margin. Its funding is settled first (RULES 7).
fn settle_perp_maker(
    tx: &mut Tx<'_, '_, '_>,
    ctx: &Matching<'_>,
    maker: &Order,
    size: u64,
) -> EngineResult<()> {
    let maker_side = ctx.taker_side.opposite();
    let seat = tx.seat_mut(maker.seat)?;
    settle_slot(seat.slot_mut(ctx.market)?, ctx.funding_index)?;
    apply_trade(
        seat,
        ctx.market,
        signed_lots(maker_side, size)?,
        maker.price,
    )?;
    let slot = seat.slot_mut(ctx.market)?;
    let open_lots = match maker_side {
        Side::Bid => &mut slot.open_bid_lots,
        Side::Ask => &mut slot.open_ask_lots,
    };
    *open_lots = open_lots
        .checked_sub(size)
        .ok_or(EngineError::InvariantBroken)?;
    if size == maker.remaining {
        close_order_slot(seat, ctx.market)?;
    }
    Ok(())
}

/// RULES 6: the taker's fee is taken from collateral.
fn settle_perp_taker(
    tx: &mut Tx<'_, '_, '_>,
    ctx: &Matching<'_>,
    price: u64,
    size: u64,
    fee: u128,
) -> EngineResult<()> {
    let seat = tx.seat_mut(ctx.taker)?;
    apply_trade(seat, ctx.market, signed_lots(ctx.taker_side, size)?, price)?;
    credit_signed(&mut seat.collateral, sub(0, signed(fee)?)?)
}

/// Settles one fill for the maker, the taker and the fee seat. Returns the fee and
/// what the maker's order still has locked.
fn settle_fill(
    tx: &mut Tx<'_, '_, '_>,
    ctx: &Matching<'_>,
    maker: &Order,
    size: u64,
) -> EngineResult<(u128, u64)> {
    let fee = taker_fee(ctx.params, maker.price, size)?;
    let locked_after = match ctx.kind {
        MarketKind::Spot => {
            let locked_after = settle_spot_maker(tx, ctx, maker, size)?;
            settle_spot_taker(tx, ctx, maker.price, size, fee)?;
            locked_after
        }
        MarketKind::Perp => {
            settle_perp_maker(tx, ctx, maker, size)?;
            settle_perp_taker(tx, ctx, maker.price, size, fee)?;
            0
        }
    };
    credit_fee_seat(tx, ctx, fee)?;
    Ok((fee, locked_after))
}

/// RULES 5 charges the fee per fill, rounded up, so `n` fills can cost up to `n` atoms
/// more than the single rounding inside the lock. A bid that can take must hold that
/// many atoms on top of its lock. Otherwise a shortfall would surface only when the
/// book happened to supply the fills, and an error would then reveal the book (RULES 3).
fn fee_rounding_headroom(order: &NewOrder, max_steps: u32) -> u128 {
    match order.order_type {
        OrderType::PostOnly => 0,
        _ => u128::from(max_steps),
    }
}

/// RULES 3.6, spot: the trader's available balance covers the lock.
fn accept_spot(
    tx: &Tx<'_, '_, '_>,
    ctx: &Matching<'_>,
    order: &NewOrder,
    max_steps: u32,
) -> EngineResult<()> {
    let params = ctx.params;
    let seat = tx.seat(ctx.taker)?;
    let (available, needed) = match order.side {
        Side::Bid => (
            seat.token(params.quote_token)?.available,
            bid_lock(order.price, order.size, params.taker_fee_bps)?
                .checked_add(fee_rounding_headroom(order, max_steps))
                .ok_or(EngineError::MathOverflow)?,
        ),
        Side::Ask => (
            seat.token(params.base_token)?.available,
            base_atoms(order.size, params.base_lot)?,
        ),
    };
    if u128::from(available) >= needed {
        Ok(())
    } else {
        Err(EngineError::InsufficientBalance)
    }
}

/// RULES 3.6, perps: the margin check on everything the seat holds, with `pending`
/// counted the way it could weigh most. RULES 9: needs a fresh feed on this market
/// and on every market where the seat holds a position.
fn require_initial_margin(
    tx: &mut Tx<'_, '_, '_>,
    ctx: &Matching<'_>,
    risk: &Risk<'_>,
    pending: &PendingOrder,
    now: i64,
) -> EngineResult<()> {
    if !risk.priced(ctx.market)?.is_fresh(now) {
        return Err(EngineError::StalePrice);
    }
    let seat = tx.seat_mut(ctx.taker)?;
    require_fresh_positions(seat, risk, now)?;
    settle_positions(seat, risk)?;
    if meets_initial_margin(seat, risk, Some(pending))? {
        Ok(())
    } else {
        Err(EngineError::InsufficientMargin)
    }
}

/// RULES 2: a reduce-only order may only shrink the position, and its size is capped
/// to the position at placement. Returns the capped size.
///
/// RULES 9 lets it through on a stale feed and without a margin check, but only while
/// it cannot raise the worst-case size. It can when the seat has resting orders on the
/// same side: once the position is gone they stand alone. That case is judged as if the
/// order filled in full, so the verdict never depends on the book (RULES 3).
fn accept_reduce_only(
    tx: &mut Tx<'_, '_, '_>,
    ctx: &Matching<'_>,
    risk: &Risk<'_>,
    order: &NewOrder,
    now: i64,
) -> EngineResult<u64> {
    let seat = tx.seat_mut(ctx.taker)?;
    let slot = seat.slot_mut(ctx.market)?;
    settle_slot(slot, ctx.funding_index)?;
    let shrinks = match order.side {
        Side::Ask => slot.base > 0,
        Side::Bid => slot.base < 0,
    };
    if !shrinks {
        return Err(EngineError::ReduceOnlyWouldIncrease);
    }
    let size = order.size.min(slot.base.unsigned_abs());
    let filled_in_full = PendingOrder {
        market: ctx.market,
        resting: None,
        base_change: signed_lots(order.side, size)?,
        fee: taker_fee(ctx.params, order.price, size)?,
    };
    let grows = worst_case_lots(slot, Some(&filled_in_full))? > worst_case_lots(slot, None)?;
    if grows {
        require_initial_margin(tx, ctx, risk, &filled_in_full, now)?;
    }
    Ok(size)
}

/// RULES 3.6, perps: counting the order as resting in full and reserving its taker
/// fee, equity is at least initial margin.
fn accept_perp(
    tx: &mut Tx<'_, '_, '_>,
    ctx: &Matching<'_>,
    risk: &Risk<'_>,
    order: &NewOrder,
    now: i64,
) -> EngineResult<()> {
    let seat = tx.seat_mut(ctx.taker)?;
    settle_slot(seat.slot_mut(ctx.market)?, ctx.funding_index)?;
    let resting_in_full = PendingOrder {
        market: ctx.market,
        resting: Some((order.side, order.size)),
        base_change: 0,
        fee: taker_fee(ctx.params, order.price, order.size)?,
    };
    require_initial_margin(tx, ctx, risk, &resting_in_full, now)
}

/// RULES 5: a resting spot order locks what it could spend. A resting perp order
/// counts its lots toward worst-case size.
fn rest_on_seat(
    tx: &mut Tx<'_, '_, '_>,
    ctx: &Matching<'_>,
    price: u64,
    size: u64,
) -> EngineResult<u64> {
    let params = ctx.params;
    let seat = tx.seat_mut(ctx.taker)?;
    let mut order_lock = 0u64;
    match (ctx.kind, ctx.taker_side) {
        (MarketKind::Spot, Side::Bid) => {
            let amount = bid_lock(price, size, params.taker_fee_bps)?;
            let quote = seat.token_mut(params.quote_token)?;
            debit(
                &mut quote.available,
                amount,
                EngineError::InsufficientBalance,
            )?;
            credit(&mut quote.locked, amount)?;
            order_lock = u64_from(amount)?;
        }
        (MarketKind::Spot, Side::Ask) => {
            let amount = base_atoms(size, params.base_lot)?;
            let base = seat.token_mut(params.base_token)?;
            debit(
                &mut base.available,
                amount,
                EngineError::InsufficientBalance,
            )?;
            credit(&mut base.locked, amount)?;
        }
        (MarketKind::Perp, side) => {
            let slot = seat.slot_mut(ctx.market)?;
            let open_lots = match side {
                Side::Bid => &mut slot.open_bid_lots,
                Side::Ask => &mut slot.open_ask_lots,
            };
            *open_lots = open_lots
                .checked_add(size)
                .ok_or(EngineError::MathOverflow)?;
        }
    }
    let open = seat.open_order_count_mut(ctx.market)?;
    *open = open.checked_add(1).ok_or(EngineError::MathOverflow)?;
    Ok(order_lock)
}

/// RULES 3.1 to 3.5, in order.
fn check_acceptance(
    market: &MarketMut<'_>,
    env: &Env<'_>,
    kind: MarketKind,
    open_orders: u8,
    order: &NewOrder,
) -> EngineResult<()> {
    let params = &*market.params;
    if env.exchange_paused {
        return Err(EngineError::ExchangePaused);
    }
    if params.status == STATUS_PAUSED {
        return Err(EngineError::MarketPaused);
    }
    let unusable_flags =
        order.reduce_only && (kind == MarketKind::Spot || order.order_type == OrderType::PostOnly);
    if unusable_flags {
        return Err(EngineError::InvalidOrderFlags);
    }
    if params.status == STATUS_REDUCE_ONLY && !order.reduce_only {
        return Err(EngineError::MarketReduceOnly);
    }
    if order.size == 0 || order.size < params.min_size {
        return Err(EngineError::SizeTooSmall);
    }
    let on_tick = order.price > 0 && order.price.checked_rem(params.tick) == Some(0);
    if !on_tick {
        return Err(EngineError::PriceOffTick);
    }
    if notional(order.price, order.size)? < u128::from(params.min_notional) {
        return Err(EngineError::NotionalTooSmall);
    }
    let mark = market.price.price;
    if mark == 0 {
        return Err(EngineError::PriceUnavailable);
    }
    if !within_band(order.price, mark, params.band_bps)? {
        return Err(EngineError::PriceOutsideBand);
    }
    let fresh = is_fresh(market.price.publish_time, params.max_price_age, env.now);
    if !order.reduce_only && !fresh {
        return Err(EngineError::StalePrice);
    }
    let may_rest = order.order_type.rests() && !order.reduce_only;
    if may_rest && u16::from(open_orders) >= params.max_open_orders {
        return Err(EngineError::TooManyOpenOrders);
    }
    Ok(())
}

fn plan_place(
    tx: &mut Tx<'_, '_, '_>,
    market: &MarketMut<'_>,
    env: &Env<'_>,
    trader: Trader<'_>,
    order: &NewOrder,
    fills: &mut Fills,
) -> EngineResult<Planned> {
    let kind = market.checked_kind()?;
    let params = &*market.params;
    let market_index = usize::from(params.market_id);
    let max_steps = index(env.max_steps)?;
    if max_steps > MAX_FILLS {
        return Err(EngineError::StepLimitTooLarge);
    }
    tx.journal.require_capacity(
        max_steps
            .checked_add(PLACE_JOURNAL_EXTRA_ENTRIES)
            .ok_or(EngineError::MathOverflow)?,
    )?;
    let open_orders = owned_seat(tx.seats, trader)?.open_order_count(market_index)?;
    if params.taker_fee_bps > 0 && tx.seat(FEE_SEAT).is_err() {
        return Err(EngineError::FeeSeatNotOpen);
    }
    check_acceptance(market, env, kind, open_orders, order)?;

    let maker_side = order.side.opposite();
    let makers = market.live(maker_side)?;
    let own = market.live(order.side)?;
    let best_crosses = |cursor: usize| {
        cursor
            .checked_sub(1)
            .and_then(|position| makers.get(position).map(|maker| (position, *maker)))
            .filter(|(_, maker)| crosses(order.side, order.price, maker.price))
    };

    let ctx = Matching {
        params,
        kind,
        market: market_index,
        funding_index: market.book.funding_index,
        taker: trader.seat,
        taker_side: order.side,
    };
    let risk = Risk::with_active(
        env.markets,
        market_index,
        MarketRisk::new(params, market.price, market.book),
    );
    let mut remaining = order.size;
    match kind {
        MarketKind::Spot => accept_spot(tx, &ctx, order, env.max_steps)?,
        MarketKind::Perp if order.reduce_only => {
            remaining = accept_reduce_only(tx, &ctx, &risk, order, env.now)?;
        }
        MarketKind::Perp => accept_perp(tx, &ctx, &risk, order, env.now)?,
    }

    if order.order_type == OrderType::PostOnly && best_crosses(makers.len()).is_some() {
        return Ok(Planned::Refused(PlaceOutcome {
            status: PlaceStatus::RefusedPostOnlyWouldMatch,
            filled: 0,
            filled_notional: 0,
            rested: 0,
            cancelled: order.size,
            fee_paid: 0,
            resting_order_seq: None,
            truncated: false,
        }));
    }

    let mut cursor = makers.len();
    let mut steps = 0u32;
    let mut filled = 0u64;
    let mut filled_notional = 0u128;
    let mut fee_paid = 0u128;
    let mut truncated = false;
    let mut partial = None;
    let mut next_fill_seq = market.book.next_fill_seq;
    while remaining > 0 {
        if order.reduce_only {
            let position = tx
                .seat(trader.seat)?
                .slot(market_index)?
                .base
                .unsigned_abs();
            remaining = remaining.min(position);
            if remaining == 0 {
                break;
            }
        }
        let Some((position, maker)) = best_crosses(cursor) else {
            break;
        };
        if steps >= env.max_steps {
            truncated = true;
            break;
        }
        steps = steps.checked_add(1).ok_or(EngineError::MathOverflow)?;
        if maker.seat == trader.seat {
            release_order(tx.seat_mut(trader.seat)?, params, maker_side, &maker)?;
            cursor = position;
            continue;
        }
        let size = remaining.min(maker.remaining);
        let (fee, locked_after) = settle_fill(tx, &ctx, &maker, size)?;
        fills.push(Fill {
            fill_seq: next_fill_seq,
            price: maker.price,
            size,
            taker_side: order.side,
            maker_receipt: receipt(env.hash, &maker.secret, next_fill_seq, ROLE_MAKER),
            taker_receipt: receipt(env.hash, &order.secret, next_fill_seq, ROLE_TAKER),
            maker_seat: maker.seat,
            taker_seat: trader.seat,
        })?;
        next_fill_seq = increment(next_fill_seq)?;
        fee_paid = fee_paid.checked_add(fee).ok_or(EngineError::MathOverflow)?;
        filled = filled.checked_add(size).ok_or(EngineError::MathOverflow)?;
        filled_notional = filled_notional
            .checked_add(notional(maker.price, size)?)
            .ok_or(EngineError::MathOverflow)?;
        remaining = remaining
            .checked_sub(size)
            .ok_or(EngineError::InvariantBroken)?;
        if size == maker.remaining {
            cursor = position;
        } else {
            partial = Some(PartialFill {
                position,
                remaining: maker
                    .remaining
                    .checked_sub(size)
                    .ok_or(EngineError::InvariantBroken)?,
                locked: locked_after,
            });
        }
    }

    let order_seq = market.book.next_order_seq;
    let would_rest = remaining > 0 && !truncated && order.order_type.rests() && !order.reduce_only;
    let side_is_full = own.len() >= market.capacity(order.side);
    let rests = would_rest && !side_is_full;
    let mut rest = None;
    let mut own_len_after = own.len();
    if rests {
        let locked = rest_on_seat(tx, &ctx, order.price, remaining)?;
        let resting = Order {
            price: order.price,
            remaining,
            sequence: order_seq,
            locked,
            secret: order.secret,
            seat: trader.seat,
            flags: match order.side {
                Side::Bid => 0,
                Side::Ask => ORDER_FLAG_ASK,
            },
            ..Order::zeroed()
        };
        rest = Some((insert_index(own, order.side, order.price), resting));
        own_len_after = own.len().checked_add(1).ok_or(EngineError::MathOverflow)?;
    }

    let rested = if rests { remaining } else { 0 };
    let cancelled = order
        .size
        .checked_sub(filled)
        .and_then(|unfilled| unfilled.checked_sub(rested))
        .ok_or(EngineError::InvariantBroken)?;
    let status = if truncated {
        PlaceStatus::RemainderCancelledStepLimit
    } else if rests {
        PlaceStatus::Rested
    } else if would_rest {
        PlaceStatus::RemainderCancelledBookFull
    } else if cancelled > 0 {
        PlaceStatus::RemainderCancelled
    } else {
        PlaceStatus::Filled
    };
    Ok(Planned::Accepted(PlacePlan {
        outcome: PlaceOutcome {
            status,
            filled,
            filled_notional: u64_from(filled_notional)?,
            rested,
            cancelled,
            fee_paid: u64_from(fee_paid)?,
            resting_order_seq: rests.then_some(order_seq),
            truncated,
        },
        maker_side,
        maker_len: makers.len(),
        maker_keep: cursor,
        maker_count: count(cursor)?,
        partial,
        own_len: own.len(),
        own_count: count(own_len_after)?,
        rest,
        next_order_seq: increment(order_seq)?,
        next_fill_seq,
    }))
}

/// RULES 2 to 6: validates, locks funds or checks margin, matches against the book for
/// at most `env.max_steps` fills and self-cancels, and rests the remainder if the
/// order type allows.
///
/// RULES 3: an `Err` depends only on public settings, the mark price and the trader's
/// own state, and changes nothing. What depends on the book comes back as `Ok` with a
/// status. `RefusedPostOnlyWouldMatch` also changes nothing, byte for byte.
///
/// RULES 3.0, the order's expiry time, is the caller's check: it is made against the
/// rollup clock before this function is reached.
pub fn place_order(
    ledger: &mut LedgerMut<'_>,
    market: &mut MarketMut<'_>,
    journal: &mut Journal<'_>,
    env: &Env<'_>,
    trader: Trader<'_>,
    order: &NewOrder,
    fills: &mut Fills,
) -> EngineResult<PlaceOutcome> {
    fills.clear();
    journal.begin();
    let planned = {
        let mut tx = Tx {
            seats: &mut *ledger.seats,
            journal: &mut *journal,
        };
        plan_place(&mut tx, market, env, trader, order, fills)
    };
    let accepted = match planned {
        Ok(Planned::Refused(outcome)) => {
            journal.rollback(ledger.seats);
            fills.clear();
            return Ok(outcome);
        }
        Ok(Planned::Accepted(plan)) => Ok(plan),
        Err(error) => Err(error),
    };
    match journal.conclude(ledger.seats, accepted) {
        Ok(plan) => {
            plan.apply(market);
            Ok(plan.outcome)
        }
        Err(error) => {
            fills.clear();
            Err(error)
        }
    }
}

/// RULES 5: cancels one resting order by its sequence number and returns what it had
/// locked. Never blocked by a pause or a stale price (RULES 9). An order of another
/// trader is reported as not found, so a sequence number reveals nothing.
pub fn cancel_order(
    ledger: &mut LedgerMut<'_>,
    market: &mut MarketMut<'_>,
    trader: Trader<'_>,
    order_seq: u64,
) -> EngineResult<()> {
    market.checked_kind()?;
    let stored = owned_seat_mut(ledger.seats, trader)?;
    let on_bids = find_by_sequence(market.live(Side::Bid)?, order_seq).map(|hit| (Side::Bid, hit));
    let on_asks = find_by_sequence(market.live(Side::Ask)?, order_seq).map(|hit| (Side::Ask, hit));
    let (side, (position, order)) = on_bids
        .or(on_asks)
        .filter(|(_, (_, order))| order.seat == trader.seat)
        .ok_or(EngineError::OrderNotFound)?;
    let len = market.live(side)?.len();
    let count_after = count(len.checked_sub(1).ok_or(EngineError::InvariantBroken)?)?;
    let mut working = *stored;
    release_order(&mut working, market.params, side, &order)?;
    commit_seat(stored, working)?;
    let (orders, live_count) = market.side_mut(side);
    remove_at(orders, len, position);
    *live_count = count_after;
    Ok(())
}

/// Cancels up to `max_cancels` of the trader's resting orders on one market, bids
/// first, best price first within a side. Returns how many were cancelled.
pub fn cancel_all(
    ledger: &mut LedgerMut<'_>,
    market: &mut MarketMut<'_>,
    trader: Trader<'_>,
    max_cancels: u32,
) -> EngineResult<u32> {
    market.checked_kind()?;
    let stored = owned_seat_mut(ledger.seats, trader)?;
    let budget = index(max_cancels)?;
    let mut working = *stored;
    let bids = market.live(Side::Bid)?;
    let asks = market.live(Side::Ask)?;
    let from_bids = release_seat_orders(
        &mut working,
        market.params,
        Side::Bid,
        bids,
        trader.seat,
        budget,
    )?;
    let ask_budget = budget
        .checked_sub(from_bids.released)
        .ok_or(EngineError::InvariantBroken)?;
    let from_asks = release_seat_orders(
        &mut working,
        market.params,
        Side::Ask,
        asks,
        trader.seat,
        ask_budget,
    )?;
    let (bid_len, ask_len) = (bids.len(), asks.len());
    let bid_count = count(
        bid_len
            .checked_sub(from_bids.released)
            .ok_or(EngineError::InvariantBroken)?,
    )?;
    let ask_count = count(
        ask_len
            .checked_sub(from_asks.released)
            .ok_or(EngineError::InvariantBroken)?,
    )?;
    let cancelled = count(
        from_bids
            .released
            .checked_add(from_asks.released)
            .ok_or(EngineError::MathOverflow)?,
    )?;
    commit_seat(stored, working)?;
    remove_seat_orders(market.bids, bid_len, trader.seat, from_bids.from);
    remove_seat_orders(market.asks, ask_len, trader.seat, from_asks.from);
    market.book.bid_count = bid_count;
    market.book.ask_count = ask_count;
    Ok(cancelled)
}

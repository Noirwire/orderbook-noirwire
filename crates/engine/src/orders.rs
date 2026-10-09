use bytemuck::Zeroable;

use crate::book::{
    close_order_slot, crosses, find_by_sequence, insert_at, insert_index, release_order,
    release_seat_orders, remove_at, remove_seat_orders, truncate,
};
use crate::error::{EngineError, EngineResult};
use crate::journal::{commit_seat, Journal, Tx, PLACE_JOURNAL_EXTRA_ENTRIES};
use crate::margin::{
    apply_trade, equity_of, fill_grows_position, is_fresh, margin_times_bps, meets_initial_margin,
    not_riskier, require_fresh_positions, settle_positions, settle_slot, signed_lots,
    worst_case_lots, MarginKind, MarketRisk, PendingOrder, Risk,
};
use crate::math::{
    add, base_atoms, bid_lock, bps_ceil, count, credit, credit_signed, credit_token, debit,
    increment, index, mul, notional, signed, sub, u64_from, BPS_DENOMINATOR,
    BPS_DENOMINATOR_SIGNED,
};
use crate::price::{breaches_crossing_band, breaches_outer_band};
use crate::seats::{owned_seat, owned_seat_mut, refuse_reserved_seat, Env, Sha256};
use crate::state::{
    LedgerMut, MarketKind, MarketMut, MarketParams, Order, Seat, Side, TokenBalance, Trader,
    FEE_SEAT, INSURANCE_SEAT, MAX_FILLS, ORDER_FLAG_ASK, STATUS_PAUSED, STATUS_REDUCE_ONLY,
};

/// RULES 6: the maker's requirement for a growing fill is `(initial + maintenance) / 2`,
/// compared as `2 * equity >= initial + maintenance` so nothing is divided.
const MIDPOINT_DIVISOR: i128 = 2;

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
    /// RULES 4: unix seconds after which the resting remainder is removed when
    /// matching reaches it. Zero means it rests until filled or cancelled.
    pub expiry: i64,
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
    /// RULES 4 and 6: the next fill would have left the taker with negative equity or,
    /// growing its position, below initial margin. Matching stopped there.
    RemainderCancelledFillCheck = 7,
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
    traded_notional: u64,
    traded_size: u64,
    open_interest: u64,
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
        market.book.traded_notional = self.traded_notional;
        market.book.traded_size = self.traded_size;
        market.book.open_interest = self.open_interest;
    }
}

fn taker_fee(params: &MarketParams, price: u64, size: u64) -> EngineResult<u128> {
    bps_ceil(notional(price, size)?, params.taker_fee_bps)
}

/// A seat's fee-receiving balance as it will be once a share of a fee is credited.
/// Spot fees are quote tokens, perp fees are collateral.
#[derive(Clone, Copy)]
enum FeeBalance {
    Tokens(TokenBalance),
    Collateral(i64),
}

/// RULES 5: of each taker fee, `fee_insurance_share_bps` goes to the insurance seat,
/// rounded down, and the fee seat gets the rest, so the two always add up to the fee.
fn split_fee(params: &MarketParams, fee: u128) -> EngineResult<(u128, u128)> {
    let to_insurance = fee
        .checked_mul(u128::from(params.fee_insurance_share_bps))
        .and_then(|scaled| scaled.checked_div(BPS_DENOMINATOR))
        .ok_or(EngineError::MathOverflow)?;
    let to_fee_seat = fee
        .checked_sub(to_insurance)
        .ok_or(EngineError::InvariantBroken)?;
    Ok((to_fee_seat, to_insurance))
}

fn fee_balance_after(seat: &Seat, ctx: &Matching<'_>, amount: u128) -> EngineResult<FeeBalance> {
    match ctx.kind {
        MarketKind::Spot => {
            let mut balance = *seat.token(ctx.params.quote_token)?;
            credit_token(&mut balance, amount)?;
            Ok(FeeBalance::Tokens(balance))
        }
        MarketKind::Perp => {
            let mut collateral = seat.collateral;
            credit_signed(&mut collateral, signed(amount)?)?;
            Ok(FeeBalance::Collateral(collateral))
        }
    }
}

fn store_fee_balance(
    tx: &mut Tx<'_, '_, '_>,
    ctx: &Matching<'_>,
    seat: u32,
    balance: FeeBalance,
) -> EngineResult<()> {
    let seat = tx.seat_mut(seat)?;
    match balance {
        FeeBalance::Tokens(tokens) => *seat.token_mut(ctx.params.quote_token)? = tokens,
        FeeBalance::Collateral(collateral) => seat.collateral = collateral,
    }
    Ok(())
}

/// RULES 5, seller side as maker: `locked` base falls by the filled lots and quote
/// `available` rises by `fill_price * fill_size`.
/// RULES 5, buyer side as maker: `locked` quote falls by the amount reserved for the
/// filled size, the buyer pays the fill notional, the difference returns to `available`
/// and base `available` rises by the filled lots. Makers pay no fee.
fn settle_spot_maker(
    seat: &mut Seat,
    ctx: &Matching<'_>,
    maker: &Order,
    size: u64,
) -> EngineResult<u64> {
    let params = ctx.params;
    let paid = notional(maker.price, size)?;
    let lots = base_atoms(size, params.base_lot)?;
    let locked_after = match ctx.taker_side {
        Side::Bid => {
            debit(
                &mut seat.token_mut(params.base_token)?.locked,
                lots,
                EngineError::InvariantBroken,
            )?;
            credit_token(seat.token_mut(params.quote_token)?, paid)?;
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
            credit_token(seat.token_mut(params.base_token)?, lots)?;
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
    seat: &mut Seat,
    ctx: &Matching<'_>,
    price: u64,
    size: u64,
    fee: u128,
) -> EngineResult<()> {
    let params = ctx.params;
    let paid = notional(price, size)?;
    let lots = base_atoms(size, params.base_lot)?;
    match ctx.taker_side {
        Side::Bid => {
            let cost = paid.checked_add(fee).ok_or(EngineError::MathOverflow)?;
            debit(
                &mut seat.token_mut(params.quote_token)?.available,
                cost,
                EngineError::InsufficientBalance,
            )?;
            credit_token(seat.token_mut(params.base_token)?, lots)
        }
        Side::Ask => {
            debit(
                &mut seat.token_mut(params.base_token)?.available,
                lots,
                EngineError::InsufficientBalance,
            )?;
            let net = paid.checked_sub(fee).ok_or(EngineError::MathOverflow)?;
            credit_token(seat.token_mut(params.quote_token)?, net)
        }
    }
}

/// RULES 6 and 7: the maker's funding is settled, then its side of the fill applied.
fn settle_perp_maker(
    seat: &mut Seat,
    ctx: &Matching<'_>,
    maker: &Order,
    size: u64,
) -> EngineResult<()> {
    let maker_side = ctx.taker_side.opposite();
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
    seat: &mut Seat,
    ctx: &Matching<'_>,
    price: u64,
    size: u64,
    fee: u128,
) -> EngineResult<()> {
    apply_trade(seat, ctx.market, signed_lots(ctx.taker_side, size)?, price)?;
    credit_signed(&mut seat.collateral, sub(0, signed(fee)?)?)
}

/// Which margin a side must still meet after a fill that grows its position.
#[derive(Clone, Copy)]
enum FillRole {
    Maker,
    Taker,
}

/// RULES 6, "Fill checks", with the fill already applied to `after` and everything
/// valued at the current mark, fresh or not. Equity must never be negative. A fill that
/// grows the position needs equity of at least initial margin for the taker and at
/// least the midpoint of initial and maintenance margin for the maker. A fill that does
/// not grow it passes if initial margin holds afterwards, or else if it leaves the
/// account no riskier than it found it.
fn passes_fill_check(
    before: &Seat,
    after: &Seat,
    ctx: &Matching<'_>,
    risk: &Risk<'_>,
    role: FillRole,
) -> EngineResult<bool> {
    if ctx.kind == MarketKind::Spot {
        return Ok(true);
    }
    let equity = equity_of(after, risk)?;
    if equity < 0 {
        return Ok(false);
    }
    let equity_times_bps = mul(equity, BPS_DENOMINATOR_SIGNED)?;
    let initial = margin_times_bps(after, risk, MarginKind::Initial, None)?;
    let maintenance = margin_times_bps(after, risk, MarginKind::Maintenance, None)?;
    let grows = fill_grows_position(before.slot(ctx.market)?.base, after.slot(ctx.market)?.base);
    if grows {
        return match role {
            FillRole::Taker => Ok(equity_times_bps >= initial),
            FillRole::Maker => {
                Ok(mul(equity_times_bps, MIDPOINT_DIVISOR)? >= add(initial, maintenance)?)
            }
        };
    }
    if equity_times_bps >= initial {
        return Ok(true);
    }
    let maintenance_before = margin_times_bps(before, risk, MarginKind::Maintenance, None)?;
    not_riskier(
        equity_of(before, risk)?,
        maintenance_before,
        equity,
        maintenance,
    )
}

fn long_lots(seat: &Seat, market: usize) -> EngineResult<i128> {
    Ok(i128::from(seat.slot(market)?.base.max(0)))
}

/// RULES 6: total long size after a fill, or `None` when the fill would raise it above
/// the market's cap.
fn open_interest_after(
    ctx: &Matching<'_>,
    open_interest: u64,
    before: [&Seat; 2],
    after: [&Seat; 2],
) -> EngineResult<Option<u64>> {
    if ctx.kind == MarketKind::Spot {
        return Ok(Some(open_interest));
    }
    let mut total = i128::from(open_interest);
    for (seat_before, seat_after) in before.iter().zip(after.iter()) {
        let change = sub(
            long_lots(seat_after, ctx.market)?,
            long_lots(seat_before, ctx.market)?,
        )?;
        total = add(total, change)?;
    }
    let total = u64::try_from(total).map_err(|_| EngineError::InvariantBroken)?;
    let raised_above_cap = total > open_interest && total > ctx.params.open_interest_cap;
    Ok((!raised_above_cap).then_some(total))
}

/// What became of one proposed fill.
enum FillVerdict {
    Filled {
        fee: u128,
        maker_locked_after: u64,
        open_interest_after: u64,
    },
    /// RULES 4: the resting order fails its check, or cannot take the fill at all.
    MakerFails,
    /// RULES 4: the taker fails its check, or cannot take the fill at all.
    TakerFails,
}

/// Applies one fill to copies of both seats, checks them (RULES 6), and only then
/// writes anything. A side that cannot take the fill for any reason, an arithmetic
/// limit included, is a verdict and never an error, because the reason lies in the
/// book or in another trader's seat (RULES 3).
#[inline(never)]
fn try_fill(
    tx: &mut Tx<'_, '_, '_>,
    ctx: &Matching<'_>,
    risk: &Risk<'_>,
    maker: &Order,
    size: u64,
    open_interest: u64,
) -> EngineResult<FillVerdict> {
    let Ok(fee) = taker_fee(ctx.params, maker.price, size) else {
        return Ok(FillVerdict::TakerFails);
    };
    let (to_fee_seat, to_insurance) = split_fee(ctx.params, fee)?;

    let maker_before = tx.seat(maker.seat)?;
    let mut maker_after = *maker_before;
    let maker_settled = match ctx.kind {
        MarketKind::Spot => settle_spot_maker(&mut maker_after, ctx, maker, size),
        MarketKind::Perp => settle_perp_maker(&mut maker_after, ctx, maker, size).map(|()| 0),
    };
    let maker_passes = maker_settled.and_then(|locked| {
        passes_fill_check(maker_before, &maker_after, ctx, risk, FillRole::Maker)
            .map(|passes| passes.then_some(locked))
    });
    let Ok(Some(maker_locked_after)) = maker_passes else {
        return Ok(FillVerdict::MakerFails);
    };

    let taker_before = tx.seat(ctx.taker)?;
    let mut taker_after = *taker_before;
    let taker_settled = match ctx.kind {
        MarketKind::Spot => settle_spot_taker(&mut taker_after, ctx, maker.price, size, fee),
        MarketKind::Perp => settle_perp_taker(&mut taker_after, ctx, maker.price, size, fee),
    };
    let taker_passes = taker_settled
        .and_then(|()| passes_fill_check(taker_before, &taker_after, ctx, risk, FillRole::Taker));
    if taker_passes != Ok(true) {
        return Ok(FillVerdict::TakerFails);
    }
    let Some(open_interest_after) = open_interest_after(
        ctx,
        open_interest,
        [maker_before, taker_before],
        [&maker_after, &taker_after],
    )?
    else {
        return Ok(FillVerdict::TakerFails);
    };

    let fee_seat_after = match to_fee_seat {
        0 => None,
        amount => Some(fee_balance_after(tx.seat(FEE_SEAT)?, ctx, amount)),
    };
    let insurance_after = match to_insurance {
        0 => None,
        amount => Some(fee_balance_after(tx.seat(INSURANCE_SEAT)?, ctx, amount)),
    };
    if matches!(fee_seat_after, Some(Err(_))) || matches!(insurance_after, Some(Err(_))) {
        return Ok(FillVerdict::TakerFails);
    }
    if let Some(Ok(balance)) = fee_seat_after {
        store_fee_balance(tx, ctx, FEE_SEAT, balance)?;
    }
    if let Some(Ok(balance)) = insurance_after {
        store_fee_balance(tx, ctx, INSURANCE_SEAT, balance)?;
    }
    *tx.seat_mut(maker.seat)? = maker_after;
    *tx.seat_mut(ctx.taker)? = taker_after;
    Ok(FillVerdict::Filled {
        fee,
        maker_locked_after,
        open_interest_after,
    })
}

/// RULES 5 charges the fee per fill, rounded up, so `n` fills can cost up to `n` atoms
/// more than the single rounding inside the lock. A bid that can take must hold that
/// many atoms on top of its lock. Otherwise a shortfall would surface only when the
/// book happened to supply the fills, and an error would then reveal the book (RULES 3).
/// With a zero fee nothing is rounded and nothing extra is needed.
fn fee_rounding_headroom(params: &MarketParams, order: &NewOrder, max_steps: u32) -> u128 {
    if params.taker_fee_bps == 0 || order.order_type == OrderType::PostOnly {
        0
    } else {
        u128::from(max_steps)
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
                .checked_add(fee_rounding_headroom(params, order, max_steps))
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
    let already_expired = order.expiry != 0 && env.now > order.expiry;
    if already_expired {
        return Err(EngineError::OrderExpired);
    }
    let mark = market.price.price;
    if mark == 0 {
        return Err(EngineError::PriceUnavailable);
    }
    let outside_bands = breaches_crossing_band(order.side, order.price, mark, params.band_bps)?
        || breaches_outer_band(order.price, mark)?;
    if outside_bands {
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
    refuse_reserved_seat(trader.seat)?;
    tx.journal.require_capacity(
        max_steps
            .checked_add(PLACE_JOURNAL_EXTRA_ENTRIES)
            .ok_or(EngineError::MathOverflow)?,
    )?;
    let open_orders = owned_seat(tx.seats, trader)?.open_order_count(market_index)?;
    if params.taker_fee_bps > 0 && tx.seat(FEE_SEAT).is_err() {
        return Err(EngineError::FeeSeatNotOpen);
    }
    let insurance_takes_fees = params.taker_fee_bps > 0 && params.fee_insurance_share_bps > 0;
    if insurance_takes_fees && tx.seat(INSURANCE_SEAT).is_err() {
        return Err(EngineError::InsuranceSeatNotOpen);
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
    let mut filled_notional = 0u64;
    let mut fee_paid = 0u128;
    let mut truncated = false;
    let mut taker_failed = false;
    let mut partial = None;
    let mut next_fill_seq = market.book.next_fill_seq;
    let mut open_interest = market.book.open_interest;
    let mark = market.price.price;
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
        let breaches_band = breaches_crossing_band(maker_side, maker.price, mark, params.band_bps)?;
        if maker.seat == trader.seat || breaches_band || maker.is_expired(env.now) {
            release_order(tx.seat_mut(maker.seat)?, params, maker_side, &maker)?;
            cursor = position;
            continue;
        }
        let size = remaining.min(maker.remaining);
        let verdict = try_fill(tx, &ctx, &risk, &maker, size, open_interest)?;
        let (fee, locked_after) = match verdict {
            FillVerdict::Filled {
                fee,
                maker_locked_after,
                open_interest_after,
            } => {
                open_interest = open_interest_after;
                (fee, maker_locked_after)
            }
            FillVerdict::MakerFails => {
                release_order(tx.seat_mut(maker.seat)?, params, maker_side, &maker)?;
                cursor = position;
                continue;
            }
            FillVerdict::TakerFails => {
                taker_failed = true;
                break;
            }
        };
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
        let fill_notional = u64::try_from(notional(maker.price, size)?).unwrap_or(u64::MAX);
        filled_notional = filled_notional.saturating_add(fill_notional);
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
    let stopped = truncated || taker_failed;
    let would_rest = remaining > 0 && !stopped && order.order_type.rests() && !order.reduce_only;
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
            expiry: order.expiry,
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
    } else if taker_failed {
        PlaceStatus::RemainderCancelledFillCheck
    } else if rests {
        PlaceStatus::Rested
    } else if would_rest {
        PlaceStatus::RemainderCancelledBookFull
    } else if cancelled > 0 {
        PlaceStatus::RemainderCancelled
    } else {
        PlaceStatus::Filled
    };
    let traded = market
        .book
        .traded_notional
        .checked_add(filled_notional)
        .zip(market.book.traded_size.checked_add(filled));
    let (traded_notional, traded_size) =
        traded.unwrap_or((market.book.traded_notional, market.book.traded_size));
    Ok(Planned::Accepted(PlacePlan {
        outcome: PlaceOutcome {
            status,
            filled,
            filled_notional,
            rested,
            cancelled,
            fee_paid: u64::try_from(fee_paid).unwrap_or(u64::MAX),
            resting_order_seq: rests.then_some(order_seq),
            truncated,
        },
        traded_notional,
        traded_size,
        open_interest,
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

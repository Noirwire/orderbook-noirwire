use bytemuck::{Pod, Zeroable};
use core::mem::{align_of, size_of};

use crate::error::{EngineError, EngineResult};

pub const SEATS: usize = 2_048;
pub const ORDERS_PER_SIDE: usize = 1_024;
pub const MARKETS: usize = 8;
pub const SPOT_TOKENS: usize = 4;
pub const MAX_OPEN_ORDERS: usize = 32;
/// Upper bound for the `max_steps` argument of one `place_order` (RULES 4).
pub const MAX_FILLS: usize = 32;

/// RULES 5: taker fees are credited to this seat.
pub const FEE_SEAT: u32 = 0;
/// RULES 8: liquidation shortfalls are paid from this seat.
pub const INSURANCE_SEAT: u32 = 1;
pub const RESERVED_SEATS: usize = 2;

pub const SEAT_FREE: u8 = 0;
pub const SEAT_OPEN: u8 = 1;

pub const KIND_SPOT: u8 = 1;
pub const KIND_PERP: u8 = 2;

pub const STATUS_ACTIVE: u8 = 0;
pub const STATUS_PAUSED: u8 = 1;
pub const STATUS_REDUCE_ONLY: u8 = 2;

/// RULES 9: what the market's price source last showed. Only `sync_price` sets it.
pub const ORACLE_HEALTHY: u8 = 0;
/// RULES 9: the source moved beyond the move limit and the mark did not follow.
pub const ORACLE_DISLOCATED: u8 = 1;
/// RULES 9: the mark jumped to the source; the window in which that is settled is open.
pub const ORACLE_SETTLING: u8 = 2;

/// RULES 9: why the last incident opened.
pub const INCIDENT_MOVE_BEYOND_LIMIT: u8 = 1;
pub const INCIDENT_SETTLED_GAP: u8 = 2;

pub const ORDER_FLAG_ASK: u8 = 1;

const MAX_BPS: u16 = 10_000;
/// RULES 12.
pub const MAX_TAKER_FEE_BPS: u16 = 100;
/// RULES 3.3: the outer band. No order may be further from the mark in either direction.
pub const OUTER_BAND_BPS: u16 = 5_000;

/// RULES 12: the most a seat may hold of one token, and the most deposits, fees,
/// penalties and insurance may take its collateral in either direction. 2^62 atoms is 4.6 trillion nUSD at 6 decimals, far above any
/// real supply, and two capped amounts still add up inside 63 bits, so no credit to a
/// capped balance can overflow whatever the other side of a fill holds.
pub const BALANCE_CAP: u64 = 1 << 62;

/// RULES 9 and 12: the highest price a feed accepts, in quote atoms per lot. 2^35
/// atoms is about 34,000 nUSD at 6 decimals; a dearer asset takes a smaller lot.
pub const MAX_PRICE: u64 = 1 << 35;

/// RULES 12: the highest `open_interest_cap` a market may have, in lots. A position is
/// at most its market's open interest, so a seat holding the cap on every market, at
/// the highest price, holds `BALANCE_CAP` of notional and no more.
pub const MAX_OPEN_INTEREST_CAP: u64 = 1 << 24;

const _: () = assert!(
    MAX_OPEN_INTEREST_CAP as u128 * MAX_PRICE as u128 * MARKETS as u128 <= BALANCE_CAP as u128
);

/// RULES 7: funding is quoted per this many seconds, 8 hours.
pub const FUNDING_PERIOD: i64 = 28_800;
/// RULES 7: the carry counts fractions of an atom per lot in these units.
pub const FUNDING_CARRY_SCALE: i128 = 1 << 16;
/// RULES 7: `K`, how many times over the taker fees must pay for the funding they move.
pub const FUNDING_FEE_MARGIN: i128 = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarketKind {
    Spot,
    Perp,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Bid,
    Ask,
}

impl Side {
    pub const fn opposite(self) -> Side {
        match self {
            Side::Bid => Side::Ask,
            Side::Ask => Side::Bid,
        }
    }
}

/// RULES 5: two disjoint amounts per token. Unsigned, so neither can go negative.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Pod, Zeroable)]
pub struct TokenBalance {
    pub available: u64,
    pub locked: u64,
}

/// RULES 6: one perpetual position. `quote` is zero whenever `base` is zero.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Pod, Zeroable)]
pub struct PerpSlot {
    pub base: i64,
    pub quote: i64,
    pub funding_checkpoint: i64,
    pub open_bid_lots: u64,
    pub open_ask_lots: u64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Pod, Zeroable)]
pub struct Seat {
    pub owner: [u8; 32],
    /// Increases by one in every call that changes any other byte of the seat.
    pub version: u64,
    /// RULES 6: cross-margin collateral in quote atoms. Negative only after a loss that
    /// the insurance seat could not cover (RULES 8.5).
    pub collateral: i64,
    pub spot: [TokenBalance; SPOT_TOKENS],
    pub perp: [PerpSlot; MARKETS],
    /// At most `MAX_OPEN_ORDERS` per market, so one byte each.
    pub open_orders: [u8; MARKETS],
    pub status: u8,
    pub _padding: [u8; 7],
}

impl Seat {
    pub fn is_open(&self) -> bool {
        self.status == SEAT_OPEN
    }

    pub(crate) fn token(&self, token: u8) -> EngineResult<&TokenBalance> {
        self.spot
            .get(usize::from(token))
            .ok_or(EngineError::InvalidToken)
    }

    pub(crate) fn token_mut(&mut self, token: u8) -> EngineResult<&mut TokenBalance> {
        self.spot
            .get_mut(usize::from(token))
            .ok_or(EngineError::InvalidToken)
    }

    pub(crate) fn slot(&self, market: usize) -> EngineResult<&PerpSlot> {
        self.perp
            .get(market)
            .ok_or(EngineError::InvalidMarketParams)
    }

    pub(crate) fn slot_mut(&mut self, market: usize) -> EngineResult<&mut PerpSlot> {
        self.perp
            .get_mut(market)
            .ok_or(EngineError::InvalidMarketParams)
    }

    pub(crate) fn open_order_count(&self, market: usize) -> EngineResult<u8> {
        self.open_orders
            .get(market)
            .copied()
            .ok_or(EngineError::InvalidMarketParams)
    }

    pub(crate) fn open_order_count_mut(&mut self, market: usize) -> EngineResult<&mut u8> {
        self.open_orders
            .get_mut(market)
            .ok_or(EngineError::InvalidMarketParams)
    }

    pub(crate) fn holds_nothing(&self) -> bool {
        self.collateral == 0
            && self.spot.iter().all(|b| *b == TokenBalance::default())
            && self.perp.iter().all(|s| {
                s.base == 0 && s.quote == 0 && s.open_bid_lots == 0 && s.open_ask_lots == 0
            })
            && self.open_orders.iter().all(|n| *n == 0)
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Pod, Zeroable)]
pub struct LedgerHeader {
    pub open_seats: u32,
    pub _padding: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Pod, Zeroable)]
pub struct Ledger {
    pub header: LedgerHeader,
    pub seats: [Seat; SEATS],
}

impl Ledger {
    pub fn as_mut(&mut self) -> LedgerMut<'_> {
        LedgerMut {
            header: &mut self.header,
            seats: &mut self.seats,
        }
    }
}

/// The ledger as the engine sees it: a header and any number of seats.
pub struct LedgerMut<'a> {
    pub header: &'a mut LedgerHeader,
    pub seats: &'a mut [Seat],
}

/// One resting order. An empty slot is all zero.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Pod, Zeroable)]
pub struct Order {
    pub price: u64,
    pub remaining: u64,
    pub sequence: u64,
    /// RULES 5: quote atoms still locked for a spot bid. Zero for every other order.
    pub locked: u64,
    /// RULES 4: unix seconds after which the order is removed when matching reaches
    /// it. Zero means it never expires.
    pub expiry: i64,
    pub secret: [u8; 16],
    pub seat: u32,
    pub flags: u8,
    pub _padding: [u8; 3],
}

impl Order {
    /// RULES 4: a resting order whose own expiry time has passed.
    pub fn is_expired(&self, now: i64) -> bool {
        self.expiry != 0 && now > self.expiry
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Pod, Zeroable)]
pub struct BookHeader {
    pub next_order_seq: u64,
    pub next_fill_seq: u64,
    /// RULES 7: cumulative funding index `F`, signed quote atoms per lot.
    pub funding_index: i64,
    pub last_funding_time: i64,
    pub bid_count: u32,
    pub ask_count: u32,
    pub market_id: u8,
    pub _padding: [u8; 3],
    /// RULES 7: the part of a funding step below one atom per lot, in
    /// 1/`FUNDING_CARRY_SCALE` of an atom. Its magnitude stays below one atom.
    pub funding_carry: i32,
    /// RULES 7: `P`, the sum of `size * clamp(price - mark_at_fill, -c, +c)` over the
    /// counted fills since the last funding update.
    pub traded_premium: i64,
    /// RULES 7: `V`, the sum of the counted fill sizes since the last funding update.
    pub traded_size: u64,
    /// RULES 6: total long size on this market in lots, which equals total short size.
    pub open_interest: u64,
}

/// RULES 4: each side is kept sorted worst first, so the best order is the last live
/// element. Within one price the lowest sequence is nearest the end.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Pod, Zeroable)]
pub struct Book {
    pub header: BookHeader,
    pub bids: [Order; ORDERS_PER_SIDE],
    pub asks: [Order; ORDERS_PER_SIDE],
}

impl Book {
    pub fn as_market<'a>(
        &'a mut self,
        params: &'a mut MarketParams,
        price: &'a Price,
    ) -> MarketMut<'a> {
        MarketMut {
            params,
            book: &mut self.header,
            bids: &mut self.bids,
            asks: &mut self.asks,
            price,
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Pod, Zeroable)]
pub struct MarketParams {
    pub tick: u64,
    pub base_lot: u64,
    pub min_size: u64,
    pub min_notional: u64,
    /// RULES 8.5: loss the insurance seat could not cover, for the admin to resolve.
    pub uncovered_shortfall: u64,
    pub funding_interval: i64,
    /// RULES 9: a feed older than this blocks orders that add exposure and withdrawals.
    pub max_price_age: i64,
    /// RULES 9: a feed older than this blocks liquidation. Never the shorter of the two.
    pub max_age_liquidation: i64,
    /// RULES 6: the most total long size, in lots, that fills may build up.
    pub open_interest_cap: u64,
    /// RULES 9: seconds a settled gap keeps the market `ORACLE_SETTLING`, and so keeps
    /// collateral from leaving any seat.
    pub settle_window: i64,
    /// RULES 6: the largest position, long or short in lots, that a fill may build on
    /// one seat.
    pub position_cap: u64,
    /// RULES 3.3: the crossing band.
    pub band_bps: u16,
    pub im_bps: u16,
    pub mm_bps: u16,
    pub taker_fee_bps: u16,
    pub liq_penalty_bps: u16,
    /// RULES 7: the most funding can charge in one `FUNDING_PERIOD`, in bps of the mark.
    pub funding_cap_bps: u16,
    pub max_move_bps: u16,
    pub max_open_orders: u16,
    /// RULES 8.3: a liquidation aims this far above maintenance margin.
    pub liq_buffer_bps: u16,
    /// RULES 8.3a: the insurance seat's share of a liquidation penalty.
    pub liq_insurance_share_bps: u16,
    /// RULES 5: the insurance seat's share of every taker fee.
    pub fee_insurance_share_bps: u16,
    /// RULES 9: seconds that must pass between two published prices.
    pub min_publish_gap: u16,
    pub kind: u8,
    pub status: u8,
    pub market_id: u8,
    pub base_token: u8,
    pub quote_token: u8,
    /// RULES 9: `ORACLE_HEALTHY`, `ORACLE_DISLOCATED` or `ORACLE_SETTLING`.
    pub oracle_health: u8,
    pub _padding: [u8; 2],
}

impl MarketParams {
    pub fn kind(&self) -> EngineResult<MarketKind> {
        match self.kind {
            KIND_SPOT => Ok(MarketKind::Spot),
            KIND_PERP => Ok(MarketKind::Perp),
            _ => Err(EngineError::InvalidMarketParams),
        }
    }

    /// RULES 12: the settings every market must satisfy, spot or perp. A market that
    /// fails is refused by every entry point before anything else is read.
    pub fn check(&self) -> EngineResult<MarketKind> {
        let kind = self.kind()?;
        let margins = 0 < self.mm_bps && self.mm_bps < self.im_bps && self.im_bps <= MAX_BPS;
        let margin_gap = self.im_bps.saturating_sub(self.mm_bps);
        let after_penalty = self.mm_bps.saturating_sub(self.liq_penalty_bps);
        let costs = u32::from(self.liq_penalty_bps).saturating_add(u32::from(self.taker_fee_bps));
        let ratios = costs < u32::from(self.mm_bps)
            && 0 < self.band_bps
            && self.band_bps <= margin_gap
            && self.funding_cap_bps <= margin_gap
            && self.taker_fee_bps <= MAX_TAKER_FEE_BPS
            && self.liq_insurance_share_bps <= MAX_BPS
            && self.fee_insurance_share_bps <= MAX_BPS;
        let positive = self.tick > 0
            && self.base_lot > 0
            && self.min_size > 0
            && self.funding_interval > 0
            && self.min_publish_gap > 0
            && (1..=MAX_OPEN_INTEREST_CAP).contains(&self.open_interest_cap)
            && (1..=MAX_OPEN_INTEREST_CAP).contains(&self.position_cap)
            && self.max_price_age > 0
            && self.max_price_age <= self.max_age_liquidation;
        let layout = self.status <= STATUS_REDUCE_ONLY
            && self.oracle_health <= ORACLE_SETTLING
            && self.settle_window >= 0
            && usize::from(self.market_id) < MARKETS
            && usize::from(self.max_open_orders) <= MAX_OPEN_ORDERS;
        let by_kind = match kind {
            MarketKind::Spot => {
                self.max_move_bps < after_penalty
                    && usize::from(self.base_token) < SPOT_TOKENS
                    && usize::from(self.quote_token) < SPOT_TOKENS
                    && self.base_token != self.quote_token
            }
            MarketKind::Perp => self.funding_fits(after_penalty),
        };
        if margins && ratios && positive && layout && by_kind {
            Ok(kind)
        } else {
            Err(EngineError::InvalidMarketParams)
        }
    }

    /// RULES 12, perps: the interval is at most one period, funding at a nonzero cap
    /// costs a taker fee, and one price update plus one interval at the cap leave a seat
    /// that was at maintenance with more than the penalty, both measured at the moved
    /// mark. A short is the worse side: a rise of `m` costs it `m` of the old notional
    /// while its penalty and funding grow by `1 + m`. So with `f = funding_cap_bps *
    /// funding_interval`, `f * (10000 + m) + m * period * (10000 + penalty) < (mm -
    /// penalty) * period * 10000`.
    fn funding_fits(&self, after_penalty: u16) -> bool {
        let interval_fits = 0 < self.funding_interval && self.funding_interval <= FUNDING_PERIOD;
        let paid_for = self.funding_cap_bps == 0 || self.taker_fee_bps > 0;
        let bps = u128::from(MAX_BPS);
        let interval = u128::from(self.funding_interval.unsigned_abs());
        let period = u128::from(FUNDING_PERIOD.unsigned_abs());
        let moved = u128::from(self.max_move_bps);
        let funding = u128::from(self.funding_cap_bps).saturating_mul(interval);
        let penalty = u128::from(self.liq_penalty_bps);
        let worst = funding
            .saturating_mul(bps.saturating_add(moved))
            .saturating_add(
                moved
                    .saturating_mul(period)
                    .saturating_mul(bps.saturating_add(penalty)),
            );
        let room = u128::from(after_penalty)
            .saturating_mul(period)
            .saturating_mul(bps);
        interval_fits && paid_for && worst < room
    }
}

/// RULES 9: the mark price, when it was published and the rollup time it was
/// accepted, unix seconds.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Pod, Zeroable)]
pub struct Price {
    pub price: u64,
    pub publish_time: i64,
    pub accepted_at: i64,
}

/// RULES 9: the newest observation the price source gave, whether or not the mark
/// followed it. `target` is `raw_price` in quote atoms per lot and `observed_at` the
/// rollup time it was read. `publish_time` only ever rises.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Pod, Zeroable)]
pub struct SourceRecord {
    pub raw_price: i64,
    pub conf: u64,
    pub publish_time: i64,
    pub target: u64,
    pub observed_at: i64,
}

/// RULES 9: the one source a market reads and how its numbers become quote atoms per
/// lot. Set when the market is created; `account`, `feed_id` and `expo` change only
/// while nothing is open on the market.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Pod, Zeroable)]
pub struct SourceBinding {
    pub account: [u8; 32],
    pub feed_id: [u8; 32],
    pub expo: i32,
    /// RULES 9: an observation whose confidence is wider than this share of its price
    /// is refused.
    pub max_conf_bps: u16,
    pub base_decimals: u8,
    pub quote_decimals: u8,
}

/// RULES 9: the last incident. It is kept after the market is healthy again; the
/// market's `oracle_health` says whether it is still open.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Pod, Zeroable)]
pub struct Incident {
    /// When the source was first seen beyond the move limit.
    pub since: i64,
    /// While `ORACLE_SETTLING`, the end of the settlement window. A dislocation opened
    /// while settling keeps it, so the window cannot end early; one opened while healthy
    /// has 0.
    pub settle_until: i64,
    /// How far the source was from the mark, in bps of the mark, rounded down.
    pub gap_bps: u16,
    /// `INCIDENT_MOVE_BEYOND_LIMIT` or `INCIDENT_SETTLED_GAP`.
    pub reason: u8,
    pub _padding: [u8; 5],
}

/// RULES 9: one market's price feed: the mark every decision uses, what the source
/// last said, which source that is, and the last incident.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Pod, Zeroable)]
pub struct PriceFeed {
    pub price: Price,
    pub source: SourceRecord,
    pub binding: SourceBinding,
    pub incident: Incident,
}

/// One market as the engine sees it: settings, book header, both sides, mark price.
pub struct MarketMut<'a> {
    pub params: &'a mut MarketParams,
    pub book: &'a mut BookHeader,
    pub bids: &'a mut [Order],
    pub asks: &'a mut [Order],
    pub price: &'a Price,
}

impl MarketMut<'_> {
    pub(crate) fn checked_kind(&self) -> EngineResult<MarketKind> {
        let kind = self.params.check()?;
        if self.book.market_id == self.params.market_id {
            Ok(kind)
        } else {
            Err(EngineError::MarketMismatch)
        }
    }

    pub(crate) fn live(&self, side: Side) -> EngineResult<&[Order]> {
        let (orders, count) = match side {
            Side::Bid => (&*self.bids, self.book.bid_count),
            Side::Ask => (&*self.asks, self.book.ask_count),
        };
        usize::try_from(count)
            .ok()
            .and_then(|len| orders.get(..len))
            .ok_or(EngineError::InvariantBroken)
    }

    pub(crate) fn capacity(&self, side: Side) -> usize {
        match side {
            Side::Bid => self.bids.len(),
            Side::Ask => self.asks.len(),
        }
    }

    pub(crate) fn side_mut(&mut self, side: Side) -> (&mut [Order], &mut u32) {
        match side {
            Side::Bid => (&mut *self.bids, &mut self.book.bid_count),
            Side::Ask => (&mut *self.asks, &mut self.book.ask_count),
        }
    }

    pub fn best_bid(&self) -> Option<u64> {
        self.live(Side::Bid).ok()?.last().map(|order| order.price)
    }

    pub fn best_ask(&self) -> Option<u64> {
        self.live(Side::Ask).ok()?.last().map(|order| order.price)
    }
}

/// A trader acting on a seat: the seat index and the key that claims to own it.
/// RULES 13.3: every call made for a trader checks the claim against the seat.
#[derive(Clone, Copy, Debug)]
pub struct Trader<'a> {
    pub seat: u32,
    pub owner: &'a [u8; 32],
}

const _: () = assert!(size_of::<TokenBalance>() == 16);
const _: () = assert!(size_of::<PerpSlot>() == 40);
const _: () = assert!(size_of::<Seat>() == 448);
const _: () = assert!(size_of::<LedgerHeader>() == 8);
const _: () = assert!(size_of::<Ledger>() == 8 + SEATS * 448);
const _: () = assert!(size_of::<Order>() == 64);
const _: () = assert!(size_of::<BookHeader>() == 72);
const _: () = assert!(size_of::<Book>() == 72 + 2 * ORDERS_PER_SIDE * 64);
const _: () = assert!(size_of::<MarketParams>() == 120);
const _: () = assert!(size_of::<Price>() == 24);
const _: () = assert!(size_of::<SourceRecord>() == 40);
const _: () = assert!(size_of::<SourceBinding>() == 72);
const _: () = assert!(size_of::<Incident>() == 24);
const _: () = assert!(size_of::<PriceFeed>() == 160);
const _: () = assert!(align_of::<PriceFeed>() == 8);
const _: () = assert!(align_of::<Seat>() == 8);
const _: () = assert!(align_of::<Ledger>() == 8);
const _: () = assert!(align_of::<Order>() == 8);
const _: () = assert!(align_of::<Book>() == 8);
const _: () = assert!(align_of::<MarketParams>() == 8);
const _: () = assert!(align_of::<Price>() == 8);

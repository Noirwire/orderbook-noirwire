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

pub const ORDER_FLAG_ASK: u8 = 1;

const MAX_BPS: u16 = 10_000;

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
    pub secret: [u8; 16],
    pub seat: u32,
    pub flags: u8,
    pub _padding: [u8; 3],
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
    pub _padding: [u8; 7],
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
    pub max_price_age: i64,
    pub band_bps: u16,
    pub im_bps: u16,
    pub mm_bps: u16,
    pub taker_fee_bps: u16,
    pub liq_penalty_bps: u16,
    pub funding_cap_bps: u16,
    pub max_move_bps: u16,
    pub max_open_orders: u16,
    pub kind: u8,
    pub status: u8,
    pub market_id: u8,
    pub base_token: u8,
    pub quote_token: u8,
    pub _padding: [u8; 3],
}

impl MarketParams {
    pub fn kind(&self) -> EngineResult<MarketKind> {
        match self.kind {
            KIND_SPOT => Ok(MarketKind::Spot),
            KIND_PERP => Ok(MarketKind::Perp),
            _ => Err(EngineError::InvalidMarketParams),
        }
    }

    /// Settings the engine cannot run on are refused before anything else is read.
    pub fn check(&self) -> EngineResult<MarketKind> {
        let kind = self.kind()?;
        let sane = self.tick > 0
            && self.base_lot > 0
            && self.status <= STATUS_REDUCE_ONLY
            && usize::from(self.market_id) < MARKETS
            && usize::from(self.max_open_orders) <= MAX_OPEN_ORDERS
            && self.taker_fee_bps <= MAX_BPS
            && self.liq_penalty_bps <= MAX_BPS
            && self.max_price_age >= 0;
        let kind_sane = match kind {
            MarketKind::Spot => {
                usize::from(self.base_token) < SPOT_TOKENS
                    && usize::from(self.quote_token) < SPOT_TOKENS
                    && self.base_token != self.quote_token
            }
            MarketKind::Perp => self.funding_interval > 0,
        };
        if sane && kind_sane {
            Ok(kind)
        } else {
            Err(EngineError::InvalidMarketParams)
        }
    }
}

/// RULES 9: the mark price and when it was published, unix seconds.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Pod, Zeroable)]
pub struct Price {
    pub price: u64,
    pub publish_time: i64,
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
const _: () = assert!(size_of::<Order>() == 56);
const _: () = assert!(size_of::<BookHeader>() == 48);
const _: () = assert!(size_of::<Book>() == 48 + 2 * ORDERS_PER_SIDE * 56);
const _: () = assert!(size_of::<MarketParams>() == 80);
const _: () = assert!(size_of::<Price>() == 16);
const _: () = assert!(align_of::<Seat>() == 8);
const _: () = assert!(align_of::<Ledger>() == 8);
const _: () = assert!(align_of::<Order>() == 8);
const _: () = assert!(align_of::<Book>() == 8);
const _: () = assert!(align_of::<MarketParams>() == 8);
const _: () = assert!(align_of::<Price>() == 8);

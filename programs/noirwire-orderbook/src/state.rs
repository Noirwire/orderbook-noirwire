use anchor_lang::prelude::*;
use bytemuck::{Pod, Zeroable};
use core::mem::size_of;
use noirwire_orderbook_engine::{
    Book, LedgerHeader, LiquidationStatus, MarketParams, PlaceStatus, Price, Seat, SeatSnapshot,
    MARKETS, MAX_FILLS, SPOT_TOKENS,
};

use crate::errors::OrderbookError;

pub const EXCHANGE_SEED: &[u8] = b"exchange";
pub const CUSTODY_SEED: &[u8] = b"custody";
pub const LEDGER_SEED: &[u8] = b"ledger";
pub const STATS_SEED: &[u8] = b"stats";
pub const BOOK_SEED: &[u8] = b"book";
pub const MARKET_SEED: &[u8] = b"market";
pub const TAPE_SEED: &[u8] = b"tape";
pub const PRICE_SEED: &[u8] = b"price";
pub const VIEW_SEED: &[u8] = b"view";

/// The seed the permission program derives a permission's address from,
/// followed by the address of the account it guards.
pub const PERMISSION_SEED: &[u8] = b"permission:";

pub const SEATS: usize = 2_048;
pub const TAPE_FILLS: usize = 512;
pub const RESULTS: usize = 16;
pub const ORDER_KEYS: usize = 4;
pub const TOKENS: usize = SPOT_TOKENS;
pub const MAX_MARKETS: usize = MARKETS;
pub const MAX_STEPS_LIMIT: u8 = MAX_FILLS as u8;

/// The most an ephemeral account grows in one instruction.
pub const GROWTH_STEP: u32 = 10_240;

/// RULES 3.0: the furthest ahead an order-key instruction may set its expiry.
pub const MAX_EXPIRY_AHEAD: i64 = 60;

/// RULES 12: bounds the admin's market settings must stay within.
pub const MAX_FEE_BPS: u16 = 100;
pub const MAX_FUNDING_CAP_BPS: u16 = 100;
pub const MAX_BAND_BPS: u16 = 5_000;
pub const MAX_BPS: u16 = 10_000;
pub const MAX_PRICE_AGE: i64 = 86_400;
pub const MAX_FUNDING_INTERVAL: i64 = 7 * 86_400;

pub const HEADER_LEN: usize = size_of::<Header>();

/// The first 16 bytes of every account this program creates inside the rollup.
///
/// `ready` is zero from creation until the account has its full size and its
/// engine header is written; every loader refuses an account that is not ready.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Pod, Zeroable)]
pub struct Header {
    pub tag: [u8; 8],
    pub ready: u8,
    pub market_id: u8,
    pub bump: u8,
    pub _padding: [u8; 5],
}

pub const READY: u8 = 1;

/// One account kind the program keeps inside the rollup, mapped zero-copy.
pub trait RollupAccount: Pod {
    const TAG: [u8; 8];
    const SEED: &'static [u8];
    const PER_MARKET: bool;

    const LEN: usize = HEADER_LEN + size_of::<Self>();
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct LedgerData {
    pub header: LedgerHeader,
    pub seats: [Seat; SEATS],
}

impl RollupAccount for LedgerData {
    const TAG: [u8; 8] = *b"nwledger";
    const SEED: &'static [u8] = LEDGER_SEED;
    const PER_MARKET: bool = false;
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct BookData {
    pub book: Book,
}

impl RollupAccount for BookData {
    const TAG: [u8; 8] = *b"nwbook\0\0";
    const SEED: &'static [u8] = BOOK_SEED;
    const PER_MARKET: bool = true;
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct MarketData {
    pub params: MarketParams,
    pub base_symbol: [u8; 8],
    pub quote_symbol: [u8; 8],
    /// Resting orders per side this market uses of its book, at most `ORDERS_PER_SIDE`.
    pub capacity: u16,
    pub _padding: [u8; 6],
}

impl RollupAccount for MarketData {
    const TAG: [u8; 8] = *b"nwmarket";
    const SEED: &'static [u8] = MARKET_SEED;
    const PER_MARKET: bool = true;
}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Pod, Zeroable)]
pub struct TapeFill {
    pub fill_seq: u64,
    pub price: u64,
    pub size: u64,
    pub time: i64,
    pub maker_receipt: [u8; 8],
    pub taker_receipt: [u8; 8],
    pub taker_side: u8,
    pub _padding: [u8; 7],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct TapeData {
    pub last_price: u64,
    pub last_fill_seq: u64,
    /// Fills ever appended. The newest sits at `(written - 1) % TAPE_FILLS`.
    pub written: u64,
    pub fills: [TapeFill; TAPE_FILLS],
}

impl RollupAccount for TapeData {
    const TAG: [u8; 8] = *b"nwtape\0\0";
    const SEED: &'static [u8] = TAPE_SEED;
    const PER_MARKET: bool = true;
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct PriceData {
    pub price: Price,
}

impl RollupAccount for PriceData {
    const TAG: [u8; 8] = *b"nwprice\0";
    const SEED: &'static [u8] = PRICE_SEED;
    const PER_MARKET: bool = true;
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct StatsData {
    pub orders: u64,
    pub fills: u64,
    /// Quote atoms traded, per market.
    pub volume: [u64; MAX_MARKETS],
    /// Lots held long, per market. Zero on a spot market.
    pub open_interest: [u64; MAX_MARKETS],
}

impl RollupAccount for StatsData {
    const TAG: [u8; 8] = *b"nwstats\0";
    const SEED: &'static [u8] = STATS_SEED;
    const PER_MARKET: bool = false;
}

pub const RESULT_PLACE: u8 = 1;
pub const RESULT_CANCEL: u8 = 2;
pub const RESULT_CANCEL_ALL: u8 = 3;
pub const RESULT_SYNC: u8 = 4;
pub const RESULT_LIQUIDATE: u8 = 5;
pub const RESULT_TRANSFER: u8 = 6;

/// The numbers say what happened. Cancels and syncs end here.
pub const STATUS_DONE: u8 = 0;
/// A placed order's status is the engine's `PlaceStatus` code, one to one.
pub const STATUS_FILLED: u8 = 1;
pub const STATUS_RESTED: u8 = 2;
pub const STATUS_REMAINDER_CANCELLED: u8 = 3;
pub const STATUS_REMAINDER_CANCELLED_STEP_LIMIT: u8 = 4;
pub const STATUS_REMAINDER_CANCELLED_BOOK_FULL: u8 = 5;
pub const STATUS_REFUSED_POST_ONLY_WOULD_MATCH: u8 = 6;
pub const STATUS_REMAINDER_CANCELLED_FILL_CHECK: u8 = 7;
/// A liquidation's status is the engine's `LiquidationStatus` code, one to one.
pub const STATUS_LIQUIDATED: u8 = 1;
/// The engine refused a cancel; `code` carries its error code.
pub const STATUS_REFUSED: u8 = 100;

const _: () = assert!(STATUS_FILLED == PlaceStatus::Filled.code());
const _: () = assert!(STATUS_RESTED == PlaceStatus::Rested.code());
const _: () = assert!(STATUS_REMAINDER_CANCELLED == PlaceStatus::RemainderCancelled.code());
const _: () = assert!(
    STATUS_REMAINDER_CANCELLED_STEP_LIMIT == PlaceStatus::RemainderCancelledStepLimit.code()
);
const _: () =
    assert!(STATUS_REMAINDER_CANCELLED_BOOK_FULL == PlaceStatus::RemainderCancelledBookFull.code());
const _: () =
    assert!(STATUS_REFUSED_POST_ONLY_WOULD_MATCH == PlaceStatus::RefusedPostOnlyWouldMatch.code());
const _: () = assert!(
    STATUS_REMAINDER_CANCELLED_FILL_CHECK == PlaceStatus::RemainderCancelledFillCheck.code()
);
const _: () = assert!(STATUS_LIQUIDATED == LiquidationStatus::Liquidated.code());

/// What one instruction signed by an order key did, as the trader reads it.
/// For a placed order `order_seq` is the resting remainder's sequence number
/// and means nothing when `rested` is zero.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Pod, Zeroable)]
pub struct OrderResult {
    pub client_order_id: u64,
    pub order_seq: u64,
    pub filled: u64,
    pub filled_notional: u64,
    pub rested: u64,
    pub cancelled: u64,
    pub fee: u64,
    pub kind: u8,
    pub status: u8,
    pub code: u16,
    pub _padding: [u8; 4],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct ViewData {
    pub owner: [u8; 32],
    pub order_keys: [[u8; 32]; ORDER_KEYS],
    pub seat: u32,
    /// Results ever written. The newest sits at `(written - 1) % RESULTS`.
    pub results_written: u32,
    pub results: [OrderResult; RESULTS],
    pub snapshot: SeatSnapshot,
}

impl RollupAccount for ViewData {
    const TAG: [u8; 8] = *b"nwview\0\0";
    const SEED: &'static [u8] = VIEW_SEED;
    const PER_MARKET: bool = false;
}

const _: () = assert!(HEADER_LEN == 16);
const _: () = assert!(size_of::<TapeFill>() == 56);
const _: () = assert!(size_of::<OrderResult>() == 64);
const _: () = assert!(size_of::<MarketData>() == 128);
const _: () = assert!(LedgerData::LEN == 16 + 8 + SEATS * 448);
const _: () = assert!(BookData::LEN == 16 + 72 + 2 * 1_024 * 64);
const _: () = assert!(TapeData::LEN == 16 + 24 + TAPE_FILLS * 56);
const _: () = assert!(ViewData::LEN == 16 + 32 + 128 + 8 + RESULTS * 64 + 2_512);
const _: () = assert!(PriceData::LEN == 32);
const _: () = assert!(StatsData::LEN == 16 + 16 + 2 * 8 * MAX_MARKETS);

/// A token the exchange keeps in custody: its mint and the custody token
/// account, an associated token account of the custody authority.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace, PartialEq, Eq)]
pub struct TokenInfo {
    pub mint: Pubkey,
    pub custody: Pubkey,
}

impl TokenInfo {
    pub fn is_set(&self) -> bool {
        self.mint != Pubkey::default()
    }
}

/// The one account that holds the deployment's settings and pays the rent of
/// every account the program creates inside the rollup.
#[account]
#[derive(InitSpace)]
pub struct Exchange {
    pub bump: u8,
    /// May change the settings, add markets, pause, move the exchange and name a successor.
    pub admin: Pubkey,
    /// Becomes the admin only by signing its acceptance.
    pub pending_admin: Option<Pubkey>,
    /// Must sign `open_trader`, so a stranger cannot fill the seat table or drain the rent.
    pub gate: Pubkey,
    /// The one key that may publish prices.
    pub oracle: Pubkey,
    pub paused: bool,
    /// RULES 4: `MAX_STEPS`, the most fills and self-cancels one order performs.
    pub max_steps: u8,
    /// The token that backs perpetual collateral, by index.
    pub collateral_token: u8,
    pub tokens: [TokenInfo; TOKENS],
    /// One bit per perp market that exists, by market id. A cross-margin
    /// decision must see every one of them, so a caller cannot hide a market
    /// that holds a position or a recorded shortfall.
    pub perp_markets: u8,
}

impl Exchange {
    pub fn signer_seeds(&self) -> [&[u8]; 2] {
        [EXCHANGE_SEED, std::slice::from_ref(&self.bump)]
    }

    pub fn token(&self, index: u8) -> Result<&TokenInfo> {
        let info = self
            .tokens
            .get(usize::from(index))
            .ok_or(OrderbookError::UnknownToken)?;
        require!(info.is_set(), OrderbookError::UnknownToken);
        Ok(info)
    }
}

/// What the admin may change after the exchange exists.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ExchangeSettings {
    pub gate: Pubkey,
    pub oracle: Pubkey,
    pub max_steps: u8,
    pub collateral_token: u8,
}

impl ExchangeSettings {
    pub fn apply_to(self, exchange: &mut Exchange) -> Result<()> {
        require!(
            self.max_steps > 0 && self.max_steps <= MAX_STEPS_LIMIT,
            OrderbookError::InvalidSettings
        );
        require!(
            usize::from(self.collateral_token) < TOKENS,
            OrderbookError::InvalidSettings
        );
        exchange.gate = self.gate;
        exchange.oracle = self.oracle;
        exchange.max_steps = self.max_steps;
        exchange.collateral_token = self.collateral_token;
        Ok(())
    }
}

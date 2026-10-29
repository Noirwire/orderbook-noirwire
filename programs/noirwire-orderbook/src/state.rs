use anchor_lang::prelude::*;
use bytemuck::{Pod, Zeroable};
use core::mem::{offset_of, size_of};
use noirwire_orderbook_engine::{
    Book, LedgerHeader, LiquidationStatus, MarketParams, PlaceStatus, PriceFeed, Seat,
    SeatSnapshot, MARKETS, MAX_FILLS, SPOT_TOKENS,
};

use crate::errors::OrderbookError;

pub const EXCHANGE_SEED: &[u8] = b"exchange";
pub const CUSTODY_SEED: &[u8] = b"custody";
/// RULES 12: the ledger of 304-byte seats. The ledger of 448-byte seats the exchange
/// was first built with lives at `LEGACY_LEDGER_SEED`, which only the relayout reads.
pub const LEDGER_SEED: &[u8] = b"ledger-v2";
pub const LEGACY_LEDGER_SEED: &[u8] = b"ledger";
pub const STATS_SEED: &[u8] = b"stats";
pub const BOOK_SEED: &[u8] = b"book";
pub const MARKET_SEED: &[u8] = b"market";
pub const TAPE_SEED: &[u8] = b"tape";
pub const PRICE_SEED: &[u8] = b"price";
pub const VIEW_SEED: &[u8] = b"view";

/// The seed the permission program derives a permission's address from,
/// followed by the address of the account it guards.
pub const PERMISSION_SEED: &[u8] = b"permission:";

/// The seats a ledger is created with, and the fewest a ledger may have.
pub const MIN_SEATS: usize = noirwire_orderbook_engine::MIN_SEATS;
/// The most bytes an account may have.
pub const MAX_ACCOUNT_LEN: usize = 10 * 1_024 * 1_024;
pub const SEAT_LEN: usize = size_of::<Seat>();
/// The most seats a ledger may hold: the largest whole number of seats that fit in the
/// most an account may have.
pub const MAX_SEATS: usize = (MAX_ACCOUNT_LEN - LEDGER_PREFIX) / SEAT_LEN;
/// RULES 8.6: the seats the keeper has one `reconcile_shortfall` call read, a batch
/// measured to fit one transaction's compute. The program takes any nonzero count.
pub const RECONCILE_SEATS_PER_CALL: u16 = 8_192;
/// The seats one `release_empty_seats` call looks at, at the most.
pub const RELEASE_SEATS_PER_CALL: u16 = 2_048;
/// The seats one `relayout_seats` call copies, at the most.
pub const RELAYOUT_SEATS_PER_CALL: u16 = 256;
/// A view that holds no seat records this index.
pub const NO_SEAT: u32 = u32::MAX;
pub const TAPE_FILLS: usize = 512;
pub const RESULTS: usize = 16;
pub const ORDER_KEYS: usize = 4;
pub const TOKENS: usize = SPOT_TOKENS;
pub const MAX_MARKETS: usize = MARKETS;
pub const MAX_STEPS_LIMIT: u8 = MAX_FILLS as u8;

/// The most an ephemeral account grows in one instruction.
pub const GROWTH_STEP: u32 = 10_240;

/// The seats `extend_ledger` adds in one call: the most that fit in one growth step,
/// so every call ends on a seat boundary and the ledger always loads between calls.
pub const EXTEND_SEATS_PER_CALL: u16 = (GROWTH_STEP as usize / SEAT_LEN) as u16;

/// RULES 3.0: the furthest ahead an order-key instruction may set its expiry.
pub const MAX_EXPIRY_AHEAD: i64 = 60;

/// RULES 12: bounds the admin's market settings must stay within.
/// The funding cap is per funding period (the engine's `FUNDING_PERIOD`, 8 hours).
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

    const LEN: usize = HEADER_LEN + size_of::<Self>();
}

/// What precedes the seats in the ledger account: the account header and the engine's
/// ledger header.
pub const LEDGER_PREFIX: usize = HEADER_LEN + size_of::<LedgerHeader>();

/// The length of a ledger account that holds `seats` seats.
pub const fn ledger_len(seats: usize) -> usize {
    LEDGER_PREFIX + seats * SEAT_LEN
}

/// The seats a ledger account of `len` bytes holds, when `len` is a length a ledger may
/// have: whole seats, from `MIN_SEATS` to `MAX_SEATS`.
pub const fn ledger_seats(len: usize) -> Option<usize> {
    let Some(body) = len.checked_sub(LEDGER_PREFIX) else {
        return None;
    };
    let seats = body / SEAT_LEN;
    if body % SEAT_LEN == 0 && seats >= MIN_SEATS && seats <= MAX_SEATS {
        Some(seats)
    } else {
        None
    }
}

/// The ledger's kind, address and engine header. The seats follow the header and the
/// account may hold any number of them (`ledger_len`), so the loaders of
/// `loader.rs` map the whole account; this type names the account for its tag, seed,
/// creation and the length it is created with.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct LedgerData {
    pub header: LedgerHeader,
}

impl RollupAccount for LedgerData {
    const TAG: [u8; 8] = *b"nwledger";
    const SEED: &'static [u8] = LEDGER_SEED;
    const LEN: usize = ledger_len(MIN_SEATS);
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct BookData {
    pub book: Book,
}

impl RollupAccount for BookData {
    const TAG: [u8; 8] = *b"nwbook\0\0";
    const SEED: &'static [u8] = BOOK_SEED;
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
}

/// RULES 9: a market's price feed is the engine's: the mark, what the bound source
/// last said, the binding itself and the last incident.
pub type PriceData = PriceFeed;

impl RollupAccount for PriceData {
    const TAG: [u8; 8] = *b"nwprice\0";
    const SEED: &'static [u8] = PRICE_SEED;
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
}

/// RULES: the order count, the fill count and the volume are statistics. They
/// stop at their largest value instead of failing the trade that moves them.
impl StatsData {
    pub fn count_order(&mut self) {
        self.orders = self.orders.saturating_add(1);
    }

    pub fn count_fill(&mut self, market: usize, price: u64, size: u64) -> Result<()> {
        let volume = self
            .volume
            .get_mut(market)
            .ok_or(OrderbookError::InvalidMarketParams)?;
        let notional = u128::from(price).saturating_mul(u128::from(size));
        *volume = volume.saturating_add(u64::try_from(notional).unwrap_or(u64::MAX));
        self.fills = self.fills.saturating_add(1);
        Ok(())
    }
}

pub const RESULT_PLACE: u8 = 1;
pub const RESULT_CANCEL: u8 = 2;
pub const RESULT_CANCEL_ALL: u8 = 3;
pub const RESULT_SYNC: u8 = 4;
pub const RESULT_LIQUIDATE: u8 = 5;
pub const RESULT_TRANSFER: u8 = 6;
pub const RESULT_LIQUIDATE_RANGE: u8 = 9;

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
/// A liquidation that happened, a stale feed and a liquidator short of margin
/// keep the engine's `LiquidationStatus` code.
pub const STATUS_LIQUIDATED: u8 = 1;
/// Security: every outcome that depends on the target's seat and changed
/// nothing is recorded as this one value, so a liquidator cannot probe whether
/// a seat exists, holds a position, or is below maintenance margin.
pub const STATUS_NOTHING_TO_LIQUIDATE: u8 = 8;
/// RULES 6: the liquidator's own seat holds positions or orders on `SEAT_SLOTS` other
/// markets, so it cannot take this one over. Its own state, not the target's, so it is
/// reported as itself and never collapsed into `STATUS_NOTHING_TO_LIQUIDATE`.
pub const STATUS_LIQUIDATOR_SLOTS_FULL: u8 = 9;
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
const _: () = assert!(STATUS_LIQUIDATOR_SLOTS_FULL != STATUS_NOTHING_TO_LIQUIDATE);
const _: () =
    assert!(STATUS_LIQUIDATOR_SLOTS_FULL != LiquidationStatus::LiquidatorSlotsFull.code());

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
    /// RULES 12: the seat this view's owner holds, or `NO_SEAT`. The sweep that releases
    /// empty seats cannot write views, so an index recorded here may name a seat that
    /// was released and taken by another owner; `view::is_seated` is the test.
    pub seat: u32,
    pub owner_nonce: u32,
    /// Results ever written. The newest sits at `(written - 1) % RESULTS`.
    /// 64 bits, so no seat can ever write enough results to run it out.
    pub results_written: u64,
    pub results: [OrderResult; RESULTS],
    pub snapshot: SeatSnapshot,
    /// Nonzero once the view has taken a seat, and never cleared. A view carried over
    /// from the layout where this held the seat's opening version is nonzero too.
    pub used: u64,
}

impl RollupAccount for ViewData {
    const TAG: [u8; 8] = *b"nwview\0\0";
    const SEED: &'static [u8] = VIEW_SEED;
}

const _: () = assert!(HEADER_LEN == 16);
const _: () = assert!(size_of::<TapeFill>() == 56);
const _: () = assert!(size_of::<OrderResult>() == 64);
const _: () = assert!(size_of::<MarketData>() == 144);
const _: () = assert!(SEAT_LEN == 304);
const _: () = assert!(LEDGER_PREFIX == 48);
const _: () = assert!(ledger_len(MIN_SEATS) == 622_640);
const _: () = assert!(ledger_len(8_192) == 2_490_416);
const _: () = assert!(MAX_SEATS == 34_492);
const _: () = assert!(EXTEND_SEATS_PER_CALL == 33);
const _: () = assert!(ledger_len(MAX_SEATS) == 10_485_616);
const _: () = assert!(ledger_len(MAX_SEATS) <= MAX_ACCOUNT_LEN);
const _: () = assert!(ledger_len(MAX_SEATS + 1) > MAX_ACCOUNT_LEN);
const _: () = assert!(LedgerData::LEN == ledger_len(MIN_SEATS));
const _: () =
    assert!(ledger_len(MIN_SEATS) == HEADER_LEN + size_of::<noirwire_orderbook_engine::Ledger>());
const _: () = assert!(EXTEND_SEATS_PER_CALL as usize * SEAT_LEN <= GROWTH_STEP as usize);
const _: () = assert!((EXTEND_SEATS_PER_CALL as usize + 1) * SEAT_LEN > GROWTH_STEP as usize);
const _: () = assert!(BookData::LEN == 16 + 72 + 2 * 1_024 * 64);
const _: () = assert!(TapeData::LEN == 16 + 24 + TAPE_FILLS * 56);
const _: () = assert!(ViewData::LEN == 16 + 32 + 128 + 16 + RESULTS * 64 + 2_512 + 8);
const _: () = assert!(size_of::<ViewData>() == 3_720);
const _: () = assert!(PriceData::LEN == 16 + 24 + 40 + 72 + 24);
const _: () = assert!(StatsData::LEN == 16 + 16 + 2 * 8 * MAX_MARKETS);

/// RULES 3a: where the access bytes sit in the accounts, so an upgrade can read them
/// in place. A market's switches are byte 134 of the `Market` account, and seat `i`'s
/// lists are the two `u64`s at bytes 112 and 120 of its 304 and its block flag byte 297,
/// at `16 + 32 + i * 304`.
const MARKET_ACCESS_OFFSET: usize =
    HEADER_LEN + offset_of!(MarketData, params) + offset_of!(MarketParams, access);
const SEAT_ACCESS_OFFSET: usize = offset_of!(Seat, maker_markets);

const _: () = assert!(MARKET_ACCESS_OFFSET == 134);
const _: () = assert!(HEADER_LEN + size_of::<LedgerHeader>() == 16 + 32);
const _: () = assert!(SEAT_ACCESS_OFFSET == 112);
const _: () = assert!(offset_of!(Seat, taker_markets) == 120);
const _: () = assert!(offset_of!(Seat, blocked) == 297);

/// A token the exchange keeps in custody: its mint, the custody token
/// account, an associated token account of the token's custody authority,
/// and what that authority is derived from.
///
/// Security: the custody authority is `[CUSTODY_SEED, custody_nonce]`, with a
/// nonce the admin chooses at registration. A custody address is then not
/// known before the admin uses it, and one a stranger claimed first is left
/// behind for another nonce. Every payout signs with these recorded seeds.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace, PartialEq, Eq)]
pub struct TokenInfo {
    pub mint: Pubkey,
    pub custody: Pubkey,
    pub custody_nonce: u64,
    pub custody_bump: u8,
}

impl TokenInfo {
    pub fn is_set(&self) -> bool {
        self.mint != Pubkey::default()
    }

    /// The custody authority this token was registered with.
    pub fn custody_authority(&self) -> Result<Pubkey> {
        Pubkey::create_program_address(
            &[
                CUSTODY_SEED,
                &self.custody_nonce.to_le_bytes(),
                &[self.custody_bump],
            ],
            &crate::ID,
        )
        .map_err(|_| error!(OrderbookError::WrongDerivation))
    }
}

/// Who may read a token's custody balance, chosen when the token is
/// registered and never changed.
///
/// Security: a public custody balance publishes the token's total in custody,
/// and so the size and time of every deposit and withdrawal. It exists because
/// a private endpoint may refuse any transaction of this program that names a
/// private token balance, which leaves a sealed custody without deposits.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum CustodyVisibility {
    Sealed,
    Public,
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
    /// On a test network's build, the one key that may publish prices for a market bound
    /// to no source. The mainnet build has no instruction that reads it.
    pub oracle: Pubkey,
    pub paused: bool,
    /// RULES 4: `MAX_STEPS`, the most fills and self-cancels one order performs.
    pub max_steps: u8,
    /// The token that backs perpetual collateral, by index. Fixed for life:
    /// it names the custody account every collateral balance is paid from.
    pub collateral_token: u8,
    pub tokens: [TokenInfo; TOKENS],
    /// One bit per perp market that exists, by market id. A cross-margin
    /// decision must see every one of them, so a caller cannot hide a market
    /// that holds a position or a recorded shortfall.
    pub perp_markets: u8,
    /// The most views `open_trader` opens in one UTC day of the rollup clock. A view is
    /// what a seat needs, and what the gate signs for, so this bounds the seats too.
    pub max_seats_per_day: u32,
    /// The UTC day, in days since the epoch, that `seats_opened` counts.
    pub seats_day: i64,
    /// The views opened on `seats_day`.
    pub seats_opened: u32,
    /// One bit per token index whose custody was registered public.
    pub public_custody: u8,
    /// RULES 9a: the USDC guard every perp's increases depend on.
    pub quote: QuoteGuard,
    /// Seats the ledger holds, from its length. Written by `finalize_ledger`,
    /// `finish_relayout` and `extend_ledger` only. Public: a keeper's sweep bound.
    ///
    /// These 32 bytes held the per-token custody caps before the layout changed. Until
    /// `migrate_exchange` runs they still hold those caps, so nothing reads
    /// `seat_capacity` while `layout` is not `LAYOUT_V2`.
    pub seat_capacity: u32,
    /// `LAYOUT_V2` once the exchange has the layout with `seat_capacity` and its ledger
    /// is the one at `LEDGER_SEED`; `LAYOUT_RELAYOUT` while the seats are being copied
    /// into it; the old caps' bytes before `migrate_exchange` ran.
    pub layout: u32,
    /// RULES 11: the collateral atoms a deposit must bring to take a seat. Zero is no
    /// minimum: any positive collateral deposit takes one.
    pub min_seat_deposit: u64,
    /// Seats copied into the new ledger so far, while `layout` is `LAYOUT_RELAYOUT`.
    pub relayout_next: u32,
    pub _reserved: [u8; 12],
}

/// `Exchange::layout` once the exchange has the layout with `seat_capacity`.
pub const LAYOUT_V2: u32 = u32::from_le_bytes(*b"NWX2");
/// `Exchange::layout` between `migrate_exchange` and `finish_relayout`.
pub const LAYOUT_RELAYOUT: u32 = u32::from_le_bytes(*b"NWXR");

const _: () = assert!(TOKENS <= u8::BITS as usize);
const _: () = assert!(Exchange::INIT_SPACE == 588);

/// RULES 9a: the guard has a healthy observation that has not aged out.
pub const QUOTE_HEALTHY: u8 = 0;
/// RULES 9a: the last observation was more than `depeg_bps` from one dollar.
pub const QUOTE_DEPEGGED: u8 = 1;
/// RULES 9a: no observation since the source was set, or no source at all.
pub const QUOTE_UNBOUND: u8 = 2;

/// RULES 9a: the USDC guard. The admin sets its source and limits with
/// `set_quote_source`; only `sync_quote` writes the rest.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace, PartialEq, Eq)]
pub struct QuoteGuard {
    /// The Pyth price account of USDC/USD, derived from `feed_id`.
    pub account: Pubkey,
    pub feed_id: [u8; 32],
    pub expo: i32,
    pub max_conf_bps: u16,
    pub depeg_bps: u16,
    /// How long one healthy observation keeps the guard passing.
    pub max_age: i64,
    pub price: i64,
    pub conf: u64,
    pub publish_time: i64,
    /// The guard passes until this rollup time.
    pub ok_until: i64,
    /// `QUOTE_HEALTHY`, `QUOTE_DEPEGGED` or `QUOTE_UNBOUND`.
    pub state: u8,
}

impl QuoteGuard {
    pub fn unbound() -> QuoteGuard {
        QuoteGuard {
            state: QUOTE_UNBOUND,
            ..QuoteGuard::default()
        }
    }

    /// RULES 9a: whether every perp may take orders that add exposure at `now`. A
    /// test network has no USDC feed, so its build lets a guard that was never bound
    /// pass; the mainnet build fails closed until the first healthy observation.
    pub fn passes(&self, now: i64) -> bool {
        let never_bound = self.account == Pubkey::default();
        now <= self.ok_until || (cfg!(feature = "test-oracle") && never_bound)
    }
}

impl Exchange {
    pub fn custody_visibility(&self, index: u8) -> CustodyVisibility {
        if self.public_custody & (1 << index) == 0 {
            CustodyVisibility::Sealed
        } else {
            CustodyVisibility::Public
        }
    }

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

    /// Security: a payout into a custody account debits a seat and credits
    /// none. Into its own custody SPL Token moves nothing, since it accepts a
    /// transfer whose source and destination are one account; into another
    /// custody the tokens arrive where no seat holds them. Either way custody
    /// holds more than the seats sum to, and nothing can ever pay it out.
    pub fn require_not_custody(&self, destination: &Pubkey) -> Result<()> {
        require!(
            self.tokens
                .iter()
                .all(|token| !token.is_set() || token.custody != *destination),
            OrderbookError::PayoutIntoCustody
        );
        Ok(())
    }

    /// Security: `transfer_between_balances` moves value between the
    /// collateral and `spot_token` with no token moving, which conserves
    /// custody only while both are kept in one custody account. The same mint
    /// is not enough: each custody nonce gives a mint its own custody account.
    pub fn require_collateral_custody(&self, spot_token: u8) -> Result<()> {
        require_keys_eq!(
            self.token(spot_token)?.custody,
            self.token(self.collateral_token)?.custody,
            OrderbookError::WrongCustody
        );
        Ok(())
    }

    /// Security: one mint is kept in one custody account, whatever its index,
    /// so a mint registered again at another index must name the custody
    /// nonce it already has.
    pub fn require_one_custody_per_mint(&self, token: &TokenInfo) -> Result<()> {
        require!(
            self.tokens
                .iter()
                .all(|recorded| recorded.mint != token.mint || recorded.custody == token.custody),
            OrderbookError::WrongCustody
        );
        Ok(())
    }

    /// Security: until `migrate_exchange` has run, the bytes of `seat_capacity` and
    /// `layout` are the old custody caps, so anything that reads the capacity refuses
    /// first.
    pub fn require_migrated(&self) -> Result<()> {
        require!(self.layout == LAYOUT_V2, OrderbookError::LayoutNotMigrated);
        Ok(())
    }

    /// Security: the relayout instructions run only between `migrate_exchange` and
    /// `finish_relayout`, and never again once the exchange has the new ledger.
    pub fn require_relayout(&self) -> Result<()> {
        require!(
            self.layout == LAYOUT_RELAYOUT,
            OrderbookError::RelayoutOutOfOrder
        );
        Ok(())
    }

    /// Counts one more view opened on the UTC day of `now`, refusing past the cap.
    pub fn count_new_seat(&mut self, now: i64) -> Result<()> {
        (self.seats_day, self.seats_opened) =
            seats_counted_on(self.seats_day, self.seats_opened, now);
        require!(
            self.seats_opened < self.max_seats_per_day,
            OrderbookError::DailySeatLimitReached
        );
        self.seats_opened += 1;
        Ok(())
    }
}

pub const SECONDS_PER_DAY: i64 = 86_400;

/// The day the seat counter stands on at `now`, and what it has counted so
/// far. The day only moves forward: a clock that reads an earlier day counts
/// against the stored one, so stepping the clock back resets nothing.
fn seats_counted_on(stored_day: i64, opened: u32, now: i64) -> (i64, u32) {
    let day = now.div_euclid(SECONDS_PER_DAY);
    if day > stored_day {
        (day, 0)
    } else {
        (stored_day, opened)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_seat_counter_resets_on_a_later_day_and_never_on_an_earlier_one() {
        let noon = |day: i64| day * SECONDS_PER_DAY + SECONDS_PER_DAY / 2;
        assert_eq!(seats_counted_on(10, 7, noon(10)), (10, 7));
        assert_eq!(seats_counted_on(10, 7, noon(11)), (11, 0));
        assert_eq!(seats_counted_on(10, 7, noon(9)), (10, 7));
        assert_eq!(seats_counted_on(10, 7, noon(-3)), (10, 7));
        assert_eq!(seats_counted_on(10, 7, 11 * SECONDS_PER_DAY - 1), (10, 7));
        assert_eq!(seats_counted_on(10, 7, 11 * SECONDS_PER_DAY), (11, 0));

        let (day, opened) = seats_counted_on(10, 7, noon(9));
        assert_eq!(seats_counted_on(day, opened + 1, noon(10)), (10, 8));
    }

    #[test]
    fn a_full_statistic_stops_at_its_largest_value_and_never_fails_the_trade() {
        let mut stats = StatsData::zeroed();
        stats.orders = u64::MAX;
        stats.fills = u64::MAX;
        stats.volume[2] = u64::MAX - 5;

        stats.count_order();
        assert!(stats.count_fill(2, 150_000, 10_000_000).is_ok());
        assert!(stats.count_fill(2, u64::MAX, u64::MAX).is_ok());

        assert_eq!(stats.orders, u64::MAX);
        assert_eq!(stats.fills, u64::MAX);
        assert_eq!(stats.volume[2], u64::MAX);
        assert_eq!(stats.volume[3], 0, "another market's volume is untouched");
    }

    #[test]
    fn a_fill_adds_its_notional_to_its_own_market_and_counts_once() {
        let mut stats = StatsData::zeroed();
        assert!(stats.count_fill(1, 150_000, 7).is_ok());
        assert_eq!(stats.volume[1], 1_050_000);
        assert_eq!(stats.fills, 1);
        assert!(stats.count_fill(MAX_MARKETS, 1, 1).is_err());
        assert_eq!(stats.fills, 1, "a fill on no market counts nothing");
    }

    fn exchange_with(tokens: [TokenInfo; TOKENS]) -> Exchange {
        Exchange {
            bump: 0,
            admin: Pubkey::new_unique(),
            pending_admin: None,
            gate: Pubkey::new_unique(),
            oracle: Pubkey::new_unique(),
            paused: false,
            max_steps: 1,
            collateral_token: 0,
            tokens,
            perp_markets: 0,
            max_seats_per_day: 1,
            seats_day: 0,
            seats_opened: 0,
            public_custody: 0,
            quote: QuoteGuard::unbound(),
            seat_capacity: 0,
            layout: 0,
            min_seat_deposit: 0,
            relayout_next: 0,
            _reserved: [0; 12],
        }
    }

    #[test]
    fn the_exchange_account_keeps_the_size_it_was_deployed_with() {
        assert_eq!(Exchange::INIT_SPACE, 588);
        assert_eq!(8 + Exchange::INIT_SPACE, 596);
    }

    #[test]
    fn the_usdc_guard_passes_until_its_observation_ages_out() {
        let bound = QuoteGuard {
            account: Pubkey::new_unique(),
            ok_until: 1_000,
            state: QUOTE_HEALTHY,
            ..QuoteGuard::unbound()
        };
        assert!(bound.passes(1_000));
        assert!(!bound.passes(1_001));
        let rebound = QuoteGuard {
            account: bound.account,
            ..QuoteGuard::unbound()
        };
        assert!(
            !rebound.passes(1),
            "a new source fails closed until it is read"
        );
        assert_eq!(
            QuoteGuard::unbound().passes(1),
            cfg!(feature = "test-oracle"),
            "only a test network's build lets a guard that was never bound pass"
        );
    }

    fn registered(nonce: u64) -> TokenInfo {
        let (authority, bump) =
            Pubkey::find_program_address(&[CUSTODY_SEED, &nonce.to_le_bytes()], &crate::ID);
        let token = TokenInfo {
            mint: Pubkey::new_unique(),
            custody: Pubkey::new_unique(),
            custody_nonce: nonce,
            custody_bump: bump,
        };
        assert_eq!(token.custody_authority().unwrap(), authority);
        token
    }

    #[test]
    fn a_payout_into_any_registered_custody_is_refused() {
        let collateral = registered(7);
        let spot = registered(u64::MAX);
        let mut tokens = [TokenInfo::default(); TOKENS];
        tokens[0] = collateral;
        tokens[2] = spot;
        let exchange = exchange_with(tokens);

        for custody in [collateral.custody, spot.custody] {
            let refused = exchange.require_not_custody(&custody).unwrap_err();
            assert_eq!(refused, error!(OrderbookError::PayoutIntoCustody));
        }
        assert!(exchange.require_not_custody(&Pubkey::new_unique()).is_ok());
        assert!(
            exchange.require_not_custody(&Pubkey::default()).is_ok(),
            "an unregistered slot names no custody"
        );
    }

    fn kept_with(mint: Pubkey, nonce: u64) -> TokenInfo {
        let (authority, bump) =
            Pubkey::find_program_address(&[CUSTODY_SEED, &nonce.to_le_bytes()], &crate::ID);
        TokenInfo {
            mint,
            custody: crate::custody::associated_token_address(&authority, &mint),
            custody_nonce: nonce,
            custody_bump: bump,
        }
    }

    #[test]
    fn the_collateral_mint_under_another_custody_nonce_is_refused_at_registration_and_in_transfers()
    {
        let mint = Pubkey::new_unique();
        let collateral = kept_with(mint, 7);
        let same_custody = kept_with(mint, 7);
        let other_custody = kept_with(mint, 8);
        assert_ne!(collateral.custody, other_custody.custody);
        let mut tokens = [TokenInfo::default(); TOKENS];
        tokens[0] = collateral;
        let exchange = exchange_with(tokens);

        assert_eq!(
            exchange
                .require_one_custody_per_mint(&other_custody)
                .unwrap_err(),
            error!(OrderbookError::WrongCustody)
        );
        assert!(exchange.require_one_custody_per_mint(&same_custody).is_ok());
        assert!(exchange
            .require_one_custody_per_mint(&registered(9))
            .is_ok());

        tokens[1] = same_custody;
        tokens[2] = other_custody;
        tokens[3] = registered(9);
        let exchange = exchange_with(tokens);
        assert!(exchange.require_collateral_custody(0).is_ok());
        assert!(exchange.require_collateral_custody(1).is_ok());
        for index in [2, 3] {
            assert_eq!(
                exchange.require_collateral_custody(index).unwrap_err(),
                error!(OrderbookError::WrongCustody),
                "token {index} is kept in another custody account"
            );
        }
    }

    fn serialized(exchange: &Exchange) -> Vec<u8> {
        let mut bytes = Vec::new();
        exchange.try_serialize(&mut bytes).unwrap();
        bytes
    }

    #[test]
    fn the_capacity_layout_minimum_and_relayout_cursor_sit_in_the_last_32_bytes_the_custody_caps_held(
    ) {
        for (pending_admin, length) in [(Some(Pubkey::new_unique()), 596), (None, 564)] {
            let exchange = Exchange {
                seat_capacity: 8_192,
                layout: LAYOUT_RELAYOUT,
                min_seat_deposit: 10_000_000,
                relayout_next: 768,
                pending_admin,
                ..exchange_with([TokenInfo::default(); TOKENS])
            };
            let bytes = serialized(&exchange);
            assert_eq!(bytes.len(), length, "a nominee takes 32 bytes more");
            let tail = &bytes[bytes.len() - 32..];
            assert_eq!(tail[..4], 8_192u32.to_le_bytes());
            assert_eq!(tail[4..8], *b"NWXR");
            assert_eq!(tail[8..16], 10_000_000u64.to_le_bytes());
            assert_eq!(tail[16..20], 768u32.to_le_bytes());
            assert_eq!(tail[20..], [0; 12]);
            let live = Exchange {
                layout: LAYOUT_V2,
                ..exchange
            };
            assert_eq!(serialized(&live)[bytes.len() - 28..][..4], *b"NWX2");
        }
    }

    #[test]
    fn an_exchange_with_custody_caps_in_those_bytes_still_loads_and_is_not_migrated() {
        let mut bytes = serialized(&exchange_with([TokenInfo::default(); TOKENS]));
        let caps: [u64; TOKENS] = [1_800_000_000, 0, 5, u64::MAX];
        let at = bytes.len() - 32;
        for (cap, slot) in caps.iter().zip(bytes[at..].chunks_exact_mut(8)) {
            slot.copy_from_slice(&cap.to_le_bytes());
        }

        let exchange = Exchange::try_deserialize(&mut &bytes[..]).unwrap();

        assert_ne!(exchange.layout, LAYOUT_V2);
        assert_eq!(
            exchange.require_migrated().unwrap_err(),
            error!(OrderbookError::LayoutNotMigrated)
        );
        assert_eq!(serialized(&exchange), bytes, "loading keeps the cap bytes");
    }

    #[test]
    fn only_the_current_layout_passes_the_migration_check() {
        let mut exchange = exchange_with([TokenInfo::default(); TOKENS]);
        assert!(exchange.require_migrated().is_err());
        exchange.layout = LAYOUT_V2;
        assert!(exchange.require_migrated().is_ok());
        exchange.layout = LAYOUT_V2.wrapping_add(1);
        assert!(exchange.require_migrated().is_err());
        exchange.layout = LAYOUT_RELAYOUT;
        assert_eq!(
            exchange.require_migrated().unwrap_err(),
            error!(OrderbookError::LayoutNotMigrated),
            "the seats are not all in the new ledger yet"
        );
        assert!(exchange.require_relayout().is_ok());
        exchange.layout = LAYOUT_V2;
        assert_eq!(
            exchange.require_relayout().unwrap_err(),
            error!(OrderbookError::RelayoutOutOfOrder)
        );
    }

    #[test]
    fn a_ledger_length_is_whole_seats_from_the_creation_size_to_the_account_limit() {
        assert_eq!(ledger_seats(622_640), Some(MIN_SEATS));
        assert_eq!(ledger_seats(2_490_416), Some(8_192));
        assert_eq!(ledger_seats(3_735_600), Some(12_288));
        assert_eq!(ledger_seats(ledger_len(MAX_SEATS)), Some(MAX_SEATS));
        assert!(ledger_len(MAX_SEATS) <= MAX_ACCOUNT_LEN);
        for refused in [
            0,
            LEDGER_PREFIX,
            ledger_len(MIN_SEATS - 1),
            ledger_len(MIN_SEATS) - 1,
            ledger_len(MIN_SEATS) + 1,
            ledger_len(MIN_SEATS) + SEAT_LEN - 1,
            ledger_len(MAX_SEATS) + 1,
            ledger_len(MAX_SEATS + 1),
            MAX_ACCOUNT_LEN,
        ] {
            assert_eq!(ledger_seats(refused), None, "{refused}");
        }
    }

    #[test]
    fn each_nonce_names_its_own_custody_authority_and_the_recorded_seeds_derive_it() {
        let first = registered(1);
        let second = registered(2);
        assert_ne!(
            first.custody_authority().unwrap(),
            second.custody_authority().unwrap()
        );
        let wrong_bump = TokenInfo {
            custody_bump: first.custody_bump.wrapping_sub(1),
            ..first
        };
        assert_ne!(
            wrong_bump.custody_authority().ok(),
            first.custody_authority().ok()
        );
    }
}

/// What the admin may change after the exchange exists. The collateral token
/// is not among it: changing it would pay collateral balances and collateral
/// fees out of another mint's custody.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ExchangeUpdate {
    pub gate: Pubkey,
    pub oracle: Pubkey,
    pub max_steps: u8,
    pub max_seats_per_day: u32,
    pub min_seat_deposit: u64,
}

impl ExchangeUpdate {
    pub fn apply_to(self, exchange: &mut Exchange) -> Result<()> {
        require!(
            self.max_steps > 0 && self.max_steps <= MAX_STEPS_LIMIT,
            OrderbookError::InvalidSettings
        );
        exchange.gate = self.gate;
        exchange.oracle = self.oracle;
        exchange.max_steps = self.max_steps;
        exchange.max_seats_per_day = self.max_seats_per_day;
        exchange.min_seat_deposit = self.min_seat_deposit;
        Ok(())
    }
}

/// What the exchange is created with.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ExchangeSettings {
    pub gate: Pubkey,
    pub oracle: Pubkey,
    pub max_steps: u8,
    pub collateral_token: u8,
    pub max_seats_per_day: u32,
    pub min_seat_deposit: u64,
}

impl ExchangeSettings {
    pub fn apply_to(self, exchange: &mut Exchange) -> Result<()> {
        require!(
            usize::from(self.collateral_token) < TOKENS,
            OrderbookError::InvalidSettings
        );
        exchange.collateral_token = self.collateral_token;
        ExchangeUpdate {
            gate: self.gate,
            oracle: self.oracle,
            max_steps: self.max_steps,
            max_seats_per_day: self.max_seats_per_day,
            min_seat_deposit: self.min_seat_deposit,
        }
        .apply_to(exchange)
    }
}

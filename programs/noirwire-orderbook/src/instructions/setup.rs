use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID};
use noirwire_orderbook_engine::{
    open_reserved_seat, LedgerMut, MarketParams, FEE_SEAT, INSURANCE_SEAT, KIND_PERP, KIND_SPOT,
    ORDERS_PER_SIDE,
};

use crate::ephemeral::{self, PermissionAccounts};
use crate::errors::{engine, OrderbookError};
use crate::loader::{finalize, load_mut, unready_header, Scope};
use crate::state::{
    BookData, Exchange, LedgerData, MarketData, PriceData, RollupAccount, StatsData, TapeData,
    BOOK_SEED, EXCHANGE_SEED, HEADER_LEN, LEDGER_SEED, MARKET_SEED, MAX_BAND_BPS, MAX_BPS,
    MAX_FUNDING_INTERVAL, MAX_MARKETS, MAX_PRICE_AGE, PERMISSION_SEED, PRICE_SEED, STATS_SEED,
    TAPE_SEED,
};

pub const GROW_LEDGER: u8 = 0;
pub const GROW_BOOK: u8 = 1;
pub const GROW_TAPE: u8 = 2;

#[derive(Accounts)]
pub struct CreateLedger<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [EXCHANGE_SEED],
        bump = exchange.bump,
        has_one = admin @ OrderbookError::NotAdmin
    )]
    pub exchange: Account<'info, Exchange>,
    /// CHECK: Created here, inside the rollup.
    #[account(mut, seeds = [LEDGER_SEED], bump)]
    pub ledger: UncheckedAccount<'info>,
    /// CHECK: Created here, inside the rollup.
    #[account(mut, seeds = [STATS_SEED], bump)]
    pub stats: UncheckedAccount<'info>,
    /// CHECK: The ledger's permission, at the one address the permission program derives for it.
    #[account(
        mut,
        seeds = [PERMISSION_SEED, ledger.key().as_ref()],
        bump,
        seeds::program = PERMISSION_PROGRAM_ID
    )]
    pub ledger_permission: UncheckedAccount<'info>,
    /// CHECK: The permission program, by its fixed address.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: The rollup's rent vault, by its fixed address.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: The magic program, by its fixed address.
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

/// Creates the sealed ledger at its first growth step and the public stats
/// account at full size. Neither is usable until `finalize_ledger`.
pub fn create_ledger(ctx: Context<CreateLedger>) -> Result<()> {
    let accounts = &ctx.accounts;
    ephemeral::create::<LedgerData>(
        &accounts.exchange,
        &accounts.ledger,
        &accounts.vault,
        Scope::Global,
        ctx.bumps.ledger,
    )?;
    ephemeral::seal::<LedgerData>(
        &accounts.exchange,
        &accounts.ledger,
        &PermissionAccounts {
            permission: &accounts.ledger_permission,
            permission_program: &accounts.permission_program,
            vault: &accounts.vault,
            magic_program: &accounts.magic_program,
        },
        Scope::Global,
        ctx.bumps.ledger,
    )?;
    ephemeral::create::<StatsData>(
        &accounts.exchange,
        &accounts.stats,
        &accounts.vault,
        Scope::Global,
        ctx.bumps.stats,
    )
}

#[derive(Accounts)]
pub struct FinalizeLedger<'info> {
    pub admin: Signer<'info>,
    #[account(
        seeds = [EXCHANGE_SEED],
        bump = exchange.bump,
        has_one = admin @ OrderbookError::NotAdmin
    )]
    pub exchange: Account<'info, Exchange>,
    /// CHECK: Checked by the loader against its seeds, tag and size.
    #[account(mut, seeds = [LEDGER_SEED], bump)]
    pub ledger: UncheckedAccount<'info>,
    /// CHECK: Checked by the loader against its seeds, tag and size.
    #[account(mut, seeds = [STATS_SEED], bump)]
    pub stats: UncheckedAccount<'info>,
}

/// Marks the full-size ledger ready and opens the fee and insurance seats.
/// RULES 12a: their owner is the program's own id, an address nobody can sign
/// for, so no ordinary instruction can ever act on them.
pub fn finalize_ledger(ctx: Context<FinalizeLedger>) -> Result<()> {
    let accounts = &ctx.accounts;
    let nobody = crate::ID.to_bytes();
    finalize::<LedgerData>(&accounts.ledger, Scope::Global, |ledger| {
        let mut seats = LedgerMut {
            header: &mut ledger.header,
            seats: &mut ledger.seats,
        };
        for seat in [FEE_SEAT, INSURANCE_SEAT] {
            open_reserved_seat(&mut seats, seat, &nobody).map_err(engine)?;
        }
        Ok(())
    })?;
    finalize::<StatsData>(&accounts.stats, Scope::Global, |_| Ok(()))
}

/// Everything a market is created with. Identity fields never change later.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct MarketSettings {
    pub kind: u8,
    pub base_symbol: [u8; 8],
    pub quote_symbol: [u8; 8],
    pub base_token: u8,
    pub quote_token: u8,
    pub tick: u64,
    pub base_lot: u64,
    pub capacity: u16,
    pub limits: MarketLimits,
}

/// What the admin may change after a market exists, within fixed bounds.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct MarketLimits {
    pub min_size: u64,
    pub min_notional: u64,
    pub band_bps: u16,
    pub im_bps: u16,
    pub mm_bps: u16,
    pub taker_fee_bps: u16,
    pub liq_penalty_bps: u16,
    pub funding_cap_bps: u16,
    pub max_move_bps: u16,
    pub max_open_orders: u16,
    pub max_price_age: i64,
    pub funding_interval: i64,
    pub status: u8,
    pub min_publish_gap: u16,
    pub max_age_liquidation: i64,
    pub open_interest_cap: u64,
    pub liq_buffer_bps: u16,
    pub liq_insurance_share_bps: u16,
    pub fee_insurance_share_bps: u16,
}

impl MarketLimits {
    /// RULES 12 is the engine's `check`; these are the bounds on top of it
    /// that keep a clock-based setting from being set to never or forever.
    fn apply_to(self, params: &mut MarketParams) -> Result<()> {
        let within = |value: u16, low: u16, high: u16| value >= low && value <= high;
        let sane = within(self.band_bps, 1, MAX_BAND_BPS)
            && within(self.max_move_bps, 1, MAX_BPS)
            && self.max_price_age <= MAX_PRICE_AGE
            && self.funding_interval <= MAX_FUNDING_INTERVAL
            && self.max_open_orders > 0;
        require!(sane, OrderbookError::InvalidSettings);
        params.min_size = self.min_size;
        params.min_notional = self.min_notional;
        params.band_bps = self.band_bps;
        params.im_bps = self.im_bps;
        params.mm_bps = self.mm_bps;
        params.taker_fee_bps = self.taker_fee_bps;
        params.liq_penalty_bps = self.liq_penalty_bps;
        params.funding_cap_bps = self.funding_cap_bps;
        params.max_move_bps = self.max_move_bps;
        params.max_open_orders = self.max_open_orders;
        params.max_price_age = self.max_price_age;
        params.funding_interval = self.funding_interval;
        params.status = self.status;
        params.min_publish_gap = self.min_publish_gap;
        params.max_age_liquidation = self.max_age_liquidation;
        params.open_interest_cap = self.open_interest_cap;
        params.liq_buffer_bps = self.liq_buffer_bps;
        params.liq_insurance_share_bps = self.liq_insurance_share_bps;
        params.fee_insurance_share_bps = self.fee_insurance_share_bps;
        params.check().map_err(engine)?;
        Ok(())
    }
}

impl MarketSettings {
    fn params(&self, exchange: &Exchange, market_id: u8) -> Result<MarketParams> {
        require!(
            self.kind == KIND_SPOT || self.kind == KIND_PERP,
            OrderbookError::InvalidSettings
        );
        let (base_token, quote_token) = if self.kind == KIND_SPOT {
            exchange.token(self.base_token)?;
            exchange.token(self.quote_token)?;
            (self.base_token, self.quote_token)
        } else {
            (exchange.collateral_token, exchange.collateral_token)
        };
        let mut params = MarketParams {
            tick: self.tick,
            base_lot: self.base_lot,
            kind: self.kind,
            market_id,
            base_token,
            quote_token,
            ..bytemuck::Zeroable::zeroed()
        };
        self.limits.apply_to(&mut params)?;
        Ok(params)
    }
}

#[derive(Accounts)]
#[instruction(market_id: u8)]
pub struct CreateMarket<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [EXCHANGE_SEED],
        bump = exchange.bump,
        has_one = admin @ OrderbookError::NotAdmin
    )]
    pub exchange: Account<'info, Exchange>,
    /// CHECK: Created here, inside the rollup.
    #[account(mut, seeds = [MARKET_SEED, &[market_id]], bump)]
    pub market: UncheckedAccount<'info>,
    /// CHECK: Created here, inside the rollup.
    #[account(mut, seeds = [BOOK_SEED, &[market_id]], bump)]
    pub book: UncheckedAccount<'info>,
    /// CHECK: Created here, inside the rollup.
    #[account(mut, seeds = [TAPE_SEED, &[market_id]], bump)]
    pub tape: UncheckedAccount<'info>,
    /// CHECK: Created here, inside the rollup.
    #[account(mut, seeds = [PRICE_SEED, &[market_id]], bump)]
    pub price_feed: UncheckedAccount<'info>,
    /// CHECK: The book's permission, at the one address the permission program derives for it.
    #[account(
        mut,
        seeds = [PERMISSION_SEED, book.key().as_ref()],
        bump,
        seeds::program = PERMISSION_PROGRAM_ID
    )]
    pub book_permission: UncheckedAccount<'info>,
    /// CHECK: The permission program, by its fixed address.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: The rollup's rent vault, by its fixed address.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: The magic program, by its fixed address.
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

/// Creates a market's four accounts: the public market, tape and price feed,
/// and the sealed book. The book and the tape start at one growth step; the
/// market is not usable until `finalize_market`.
pub fn create_market(
    ctx: Context<CreateMarket>,
    market_id: u8,
    settings: MarketSettings,
) -> Result<()> {
    let accounts = &ctx.accounts;
    require!(
        usize::from(market_id) < MAX_MARKETS,
        OrderbookError::InvalidSettings
    );
    require!(
        settings.capacity > 0 && usize::from(settings.capacity) <= ORDERS_PER_SIDE,
        OrderbookError::InvalidCapacity
    );
    let params = settings.params(&accounts.exchange, market_id)?;
    let scope = Scope::Market(market_id);

    ephemeral::create::<MarketData>(
        &accounts.exchange,
        &accounts.market,
        &accounts.vault,
        scope,
        ctx.bumps.market,
    )?;
    {
        let mut data = accounts.market.try_borrow_mut_data()?;
        let body = data
            .get_mut(HEADER_LEN..MarketData::LEN)
            .and_then(|body| bytemuck::try_from_bytes_mut::<MarketData>(body).ok())
            .ok_or(OrderbookError::Unaligned)?;
        body.params = params;
        body.base_symbol = settings.base_symbol;
        body.quote_symbol = settings.quote_symbol;
        body.capacity = settings.capacity;
    }
    ephemeral::create::<PriceData>(
        &accounts.exchange,
        &accounts.price_feed,
        &accounts.vault,
        scope,
        ctx.bumps.price_feed,
    )?;
    ephemeral::create::<TapeData>(
        &accounts.exchange,
        &accounts.tape,
        &accounts.vault,
        scope,
        ctx.bumps.tape,
    )?;
    ephemeral::create::<BookData>(
        &accounts.exchange,
        &accounts.book,
        &accounts.vault,
        scope,
        ctx.bumps.book,
    )?;
    ephemeral::seal::<BookData>(
        &accounts.exchange,
        &accounts.book,
        &PermissionAccounts {
            permission: &accounts.book_permission,
            permission_program: &accounts.permission_program,
            vault: &accounts.vault,
            magic_program: &accounts.magic_program,
        },
        scope,
        ctx.bumps.book,
    )
}

#[derive(Accounts)]
pub struct GrowAccount<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [EXCHANGE_SEED],
        bump = exchange.bump,
        has_one = admin @ OrderbookError::NotAdmin
    )]
    pub exchange: Account<'info, Exchange>,
    /// CHECK: Which account it is, and that it is this program's, unready and
    /// at the right address, is checked in the handler by its stored header.
    #[account(mut)]
    pub target: UncheckedAccount<'info>,
    /// CHECK: The rollup's rent vault, by its fixed address.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: The magic program, by its fixed address.
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

/// Grows an unready ledger, book or tape by at most one step, never past its
/// full size. The exchange pays the rent of the new bytes.
pub fn grow_account(
    ctx: Context<GrowAccount>,
    kind: u8,
    market_id: u8,
    new_len: u32,
) -> Result<()> {
    let accounts = &ctx.accounts;
    let full = match kind {
        GROW_LEDGER => {
            unready_header::<LedgerData>(&accounts.target, Scope::Global)?;
            LedgerData::LEN
        }
        GROW_BOOK => {
            unready_header::<BookData>(&accounts.target, Scope::Market(market_id))?;
            BookData::LEN
        }
        GROW_TAPE => {
            unready_header::<TapeData>(&accounts.target, Scope::Market(market_id))?;
            TapeData::LEN
        }
        _ => return Err(OrderbookError::WrongKind.into()),
    };
    ephemeral::grow(
        &accounts.exchange,
        &accounts.target,
        &accounts.vault,
        full,
        new_len,
    )
}

#[derive(Accounts)]
#[instruction(market_id: u8)]
pub struct FinalizeMarket<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [EXCHANGE_SEED],
        bump = exchange.bump,
        has_one = admin @ OrderbookError::NotAdmin
    )]
    pub exchange: Account<'info, Exchange>,
    /// CHECK: Checked by the loader against its seeds, tag and size.
    #[account(mut, seeds = [MARKET_SEED, &[market_id]], bump)]
    pub market: UncheckedAccount<'info>,
    /// CHECK: Checked by the loader against its seeds, tag and size.
    #[account(mut, seeds = [BOOK_SEED, &[market_id]], bump)]
    pub book: UncheckedAccount<'info>,
    /// CHECK: Checked by the loader against its seeds, tag and size.
    #[account(mut, seeds = [TAPE_SEED, &[market_id]], bump)]
    pub tape: UncheckedAccount<'info>,
    /// CHECK: Checked by the loader against its seeds, tag and size.
    #[account(mut, seeds = [PRICE_SEED, &[market_id]], bump)]
    pub price_feed: UncheckedAccount<'info>,
}

/// Marks a market's four accounts ready once the book and the tape have their
/// full size, and starts the funding clock.
pub fn finalize_market(ctx: Context<FinalizeMarket>, market_id: u8) -> Result<()> {
    let accounts = &ctx.accounts;
    let scope = Scope::Market(market_id);
    let now = Clock::get()?.unix_timestamp;
    finalize::<BookData>(&accounts.book, scope, |book| {
        book.book.header.market_id = market_id;
        book.book.header.last_funding_time = now;
        Ok(())
    })?;
    finalize::<TapeData>(&accounts.tape, scope, |_| Ok(()))?;
    finalize::<PriceData>(&accounts.price_feed, scope, |_| Ok(()))?;
    let mut is_perp = false;
    finalize::<MarketData>(&accounts.market, scope, |market| {
        is_perp = market.params.kind == KIND_PERP;
        Ok(())
    })?;
    if is_perp {
        ctx.accounts.exchange.perp_markets |= 1 << market_id;
    }
    Ok(())
}

#[derive(Accounts)]
#[instruction(market_id: u8)]
pub struct UpdateMarket<'info> {
    pub admin: Signer<'info>,
    #[account(
        seeds = [EXCHANGE_SEED],
        bump = exchange.bump,
        has_one = admin @ OrderbookError::NotAdmin
    )]
    pub exchange: Account<'info, Exchange>,
    /// CHECK: Checked by the loader against its seeds, tag, size and readiness.
    #[account(mut, seeds = [MARKET_SEED, &[market_id]], bump)]
    pub market: UncheckedAccount<'info>,
}

/// Changes a market's limits and status. Its kind, tokens, tick, lot and
/// capacity are fixed for life, and the recorded shortfall is the engine's.
pub fn update_market(
    ctx: Context<UpdateMarket>,
    market_id: u8,
    limits: MarketLimits,
) -> Result<()> {
    let mut market = load_mut::<MarketData>(&ctx.accounts.market, Scope::Market(market_id))?;
    limits.apply_to(&mut market.params)
}

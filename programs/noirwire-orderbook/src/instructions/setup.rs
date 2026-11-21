use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID};
use noirwire_orderbook_engine::{
    open_reserved_seat, push_new_seats, EngineError, MarketParams, FEE_SEAT, INSURANCE_SEAT,
    KIND_PERP, KIND_SPOT, ORACLE_HEALTHY, ORDERS_PER_SIDE, STATUS_PAUSED, STATUS_REDUCE_ONLY,
};

use crate::ephemeral::{self, PermissionAccounts};
use crate::errors::{engine, OrderbookError};
use crate::instructions::price_source::PriceSourceSettings;
use crate::layout::require_gate;
use crate::loader::{
    finalize, finalize_ledger as finalize_ledger_account,
    finalize_trigger_book as finalize_trigger_book_account, load, load_ledger, load_ledger_mut,
    load_mut, unready_header, Scope,
};
use crate::state::{
    ledger_len, ledger_seats, trigger_account_len, BookData, Exchange, LedgerData, MarketData,
    PriceData, RollupAccount, StatsData, TapeData, TriggerData, BOOK_SEED, EXCHANGE_SEED,
    EXTEND_SEATS_PER_CALL, HEADER_LEN, LEDGER_SEED, MARKET_SEED, MAX_BAND_BPS, MAX_BPS,
    MAX_FUNDING_CAP_BPS, MAX_FUNDING_INTERVAL, MAX_MARKETS, MAX_PERP_MARKETS, MAX_PRICE_AGE,
    MAX_SEATS, MIN_SEATS, PERMISSION_SEED, PRICE_SEED, STATS_SEED, TAPE_SEED, TRIGGER_SEED,
};

pub const GROW_LEDGER: u8 = 0;
pub const GROW_BOOK: u8 = 1;
pub const GROW_TAPE: u8 = 2;
pub const GROW_TRIGGERS: u8 = 3;

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
    require_gate!(accounts.exchange, "create_ledger")?;
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
        mut,
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

/// Marks the full-size ledger ready, opens the fee and insurance seats, recorded with
/// the program's id as their owner, and puts every other seat on the free list.
/// RULES 12a: what keeps every trader instruction off the reserved seats is their
/// index, which no view ever holds and every entry point refuses, not that owner: the
/// program id is a key its deploy keypair can sign for.
pub fn finalize_ledger(mut ctx: Context<FinalizeLedger>) -> Result<()> {
    let accounts = &mut ctx.accounts;
    require_gate!(accounts.exchange, "finalize_ledger")?;
    let owner = crate::ID.to_bytes();
    let capacity = u32::try_from(MIN_SEATS).map_err(|_| OrderbookError::MathOverflow)?;
    finalize_ledger_account(&accounts.ledger, |seats| {
        for seat in [FEE_SEAT, INSURANCE_SEAT] {
            open_reserved_seat(seats, seat, &owner).map_err(engine)?;
        }
        push_new_seats(seats, INSURANCE_SEAT + 1, capacity).map_err(engine)
    })?;
    accounts.exchange.seat_capacity = capacity;
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
    pub price_source: PriceSourceSettings,
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
    pub min_publish_gap: u16,
    pub open_interest_cap: u64,
    pub liq_buffer_bps: u16,
    pub liq_insurance_share_bps: u16,
    pub fee_insurance_share_bps: u16,
    pub settle_window: i64,
    pub position_cap: u64,
}

impl MarketLimits {
    /// RULES 12 is the engine's `check`; these are the bounds on top of it
    /// that keep a clock-based setting from being set to never or forever.
    /// RULES 9: refused while the market's price source is not healthy, so no
    /// limit an open incident is judged by can change under it.
    fn apply_to(self, params: &mut MarketParams) -> Result<()> {
        if params.oracle_health != ORACLE_HEALTHY {
            return Err(engine(EngineError::OracleIncident));
        }
        let within = |value: u16, low: u16, high: u16| value >= low && value <= high;
        let sane = within(self.band_bps, 1, MAX_BAND_BPS)
            && within(self.max_move_bps, 1, MAX_BPS)
            && self.max_price_age <= MAX_PRICE_AGE
            && self.funding_interval <= MAX_FUNDING_INTERVAL
            && self.funding_cap_bps <= MAX_FUNDING_CAP_BPS
            && (1..=MAX_PRICE_AGE).contains(&self.settle_window)
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
        params.min_publish_gap = self.min_publish_gap;
        params.open_interest_cap = self.open_interest_cap;
        params.liq_buffer_bps = self.liq_buffer_bps;
        params.liq_insurance_share_bps = self.liq_insurance_share_bps;
        params.fee_insurance_share_bps = self.fee_insurance_share_bps;
        params.settle_window = self.settle_window;
        params.position_cap = self.position_cap;
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
/// market is not usable until `finalize_market`. RULES 9: the price feed is
/// bound to its oracle account here and has no mark until the first `sync_price`.
/// A perp market past `MAX_PERP_MARKETS` is refused here, as `finalize_market` would
/// refuse it later, so no accounts are paid for that could never open.
pub fn create_market_v2(
    ctx: Context<CreateMarket>,
    market_id: u8,
    settings: MarketSettings,
) -> Result<()> {
    let accounts = &ctx.accounts;
    require_gate!(accounts.exchange, "create_market_v2")?;
    require!(
        usize::from(market_id) < MAX_MARKETS,
        OrderbookError::InvalidSettings
    );
    if settings.kind == KIND_PERP {
        require_perp_room(accounts.exchange.perp_markets)?;
    }
    require!(
        settings.capacity > 0 && usize::from(settings.capacity) <= ORDERS_PER_SIDE,
        OrderbookError::InvalidCapacity
    );
    let params = settings.params(&accounts.exchange, market_id)?;
    let binding = settings.price_source.binding()?;
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
    {
        let mut data = accounts.price_feed.try_borrow_mut_data()?;
        let body = data
            .get_mut(HEADER_LEN..PriceData::LEN)
            .and_then(|body| bytemuck::try_from_bytes_mut::<PriceData>(body).ok())
            .ok_or(OrderbookError::Unaligned)?;
        body.binding = binding;
    }
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
    require_gate!(accounts.exchange, "grow_account", kind == GROW_TRIGGERS)?;
    let full = match kind {
        GROW_TRIGGERS => {
            unready_header::<TriggerData>(&accounts.target, Scope::Market(market_id))?;
            trigger_account_len(MAX_SEATS).ok_or(OrderbookError::MathOverflow)?
        }
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
    let old_len = accounts.target.data_len();
    ephemeral::grow(
        &accounts.exchange,
        &accounts.target,
        &accounts.vault,
        full,
        new_len,
    )?;
    zero_new_bytes(&accounts.target, old_len, new_len)?;
    Ok(())
}

/// Security: the engine reads a grown ledger, book, tape or trigger book as empty only
/// when its new bytes are zero, so the grown range is zeroed here and not left to the
/// rollup.
fn zero_new_bytes(account: &AccountInfo, old_len: usize, new_len: u32) -> Result<()> {
    let mut data = account.try_borrow_mut_data()?;
    require!(
        data.len() == new_len as usize,
        OrderbookError::InvalidGrowth
    );
    data.get_mut(old_len..)
        .ok_or(OrderbookError::InvalidGrowth)?
        .fill(0);
    Ok(())
}

#[derive(Accounts)]
#[instruction(market_id: u8)]
pub struct CreateTriggerBook<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [EXCHANGE_SEED],
        bump = exchange.bump,
        has_one = admin @ OrderbookError::NotAdmin
    )]
    pub exchange: Account<'info, Exchange>,
    /// CHECK: Checked by the loader against its seeds, tag, size, readiness and market id.
    #[account(seeds = [MARKET_SEED, &[market_id]], bump)]
    pub market: UncheckedAccount<'info>,
    /// CHECK: Created here, inside the rollup.
    #[account(mut, seeds = [TRIGGER_SEED, &[market_id]], bump)]
    pub triggers: UncheckedAccount<'info>,
    /// CHECK: The trigger book's permission, at the one address the permission program derives for it.
    #[account(
        mut,
        seeds = [PERMISSION_SEED, triggers.key().as_ref()],
        bump,
        seeds::program = PERMISSION_PROGRAM_ID
    )]
    pub triggers_permission: UncheckedAccount<'info>,
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

/// The seats a market's trigger book holds: `MAX_SEATS`, the most a ledger can ever
/// hold, for a perp whatever the ledger holds today; none for a spot market, which holds
/// no trigger but must still have the account every order-key instruction names.
fn trigger_seats(market: &AccountInfo, market_id: u8) -> Result<u32> {
    require!(
        usize::from(market_id) < MAX_MARKETS,
        OrderbookError::InvalidSettings
    );
    let kind = load::<MarketData>(market, Scope::Market(market_id))?
        .params
        .kind;
    if kind == KIND_PERP {
        u32::try_from(MAX_SEATS).map_err(|_| OrderbookError::MathOverflow.into())
    } else {
        Ok(0)
    }
}

/// Creates a market's sealed trigger book at its first growth step. Every perp book is
/// sized for `MAX_SEATS` and never resized, so it can be created at any point of the
/// ledger's growth and the ledger can be extended to its maximum afterwards. Not usable
/// until `finalize_trigger_book`.
pub fn create_trigger_book(ctx: Context<CreateTriggerBook>, market_id: u8) -> Result<()> {
    let accounts = &ctx.accounts;
    require_gate!(accounts.exchange, "create_trigger_book")?;
    let seats = trigger_seats(&accounts.market, market_id)?;
    let len = trigger_account_len(seats as usize).ok_or(OrderbookError::MathOverflow)?;
    let scope = Scope::Market(market_id);
    ephemeral::create_with_len::<TriggerData>(
        &accounts.exchange,
        &accounts.triggers,
        &accounts.vault,
        scope,
        ctx.bumps.triggers,
        len,
    )?;
    ephemeral::seal::<TriggerData>(
        &accounts.exchange,
        &accounts.triggers,
        &PermissionAccounts {
            permission: &accounts.triggers_permission,
            permission_program: &accounts.permission_program,
            vault: &accounts.vault,
            magic_program: &accounts.magic_program,
        },
        scope,
        ctx.bumps.triggers,
    )
}

#[derive(Accounts)]
#[instruction(market_id: u8)]
pub struct FinalizeTriggerBook<'info> {
    pub admin: Signer<'info>,
    #[account(
        seeds = [EXCHANGE_SEED],
        bump = exchange.bump,
        has_one = admin @ OrderbookError::NotAdmin
    )]
    pub exchange: Account<'info, Exchange>,
    /// CHECK: Checked by the loader against its seeds, tag, size, readiness and market id.
    #[account(seeds = [MARKET_SEED, &[market_id]], bump)]
    pub market: UncheckedAccount<'info>,
    /// CHECK: Checked by the loader against its seeds, tag and size.
    #[account(mut, seeds = [TRIGGER_SEED, &[market_id]], bump)]
    pub triggers: UncheckedAccount<'info>,
}

/// Marks a trigger book ready once it has the full length its market's kind asks for,
/// whatever the ledger's seat capacity is.
pub fn finalize_trigger_book(ctx: Context<FinalizeTriggerBook>, market_id: u8) -> Result<()> {
    let accounts = &ctx.accounts;
    require_gate!(accounts.exchange, "finalize_trigger_book")?;
    let seats = trigger_seats(&accounts.market, market_id)?;
    finalize_trigger_book_account(&accounts.triggers, market_id, seats)
}

#[derive(Accounts)]
pub struct ExtendLedger<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [EXCHANGE_SEED],
        bump = exchange.bump,
        has_one = admin @ OrderbookError::NotAdmin
    )]
    pub exchange: Account<'info, Exchange>,
    /// CHECK: Checked by the loader against its seeds, tag, size and readiness.
    #[account(mut, seeds = [LEDGER_SEED], bump)]
    pub ledger: UncheckedAccount<'info>,
    /// CHECK: The rollup's rent vault, by its fixed address.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: The magic program, by its fixed address.
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

/// Adds `seats` closed seats to the ready ledger, at most `EXTEND_SEATS_PER_CALL`, puts
/// them on the free list, and records the new capacity on the exchange. Each call stays
/// inside one growth step and ends on a seat boundary, so the ledger loads between
/// calls. The exchange pays the rent of the new bytes. Security: the new bytes are
/// zeroed here and not left to the rollup, since zero is a closed seat. Refused until
/// the exchange has the new ledger, since the capacity lives in bytes that held custody
/// caps before, and past `MAX_SEATS`, the most seats an account can hold.
pub fn extend_ledger(ctx: Context<ExtendLedger>, seats: u16) -> Result<()> {
    let accounts = ctx.accounts;
    require_gate!(accounts.exchange, "extend_ledger")?;
    let (old_len, new_len) = extension(&accounts.exchange, &accounts.ledger, seats)?;
    ephemeral::grow(
        &accounts.exchange,
        &accounts.ledger,
        &accounts.vault,
        ledger_len(MAX_SEATS),
        u32::try_from(new_len).map_err(|_| OrderbookError::MathOverflow)?,
    )?;
    zero_and_record(&mut accounts.exchange, &accounts.ledger, old_len, new_len)
}

/// What `extend_ledger` checks before it grows anything: the call adds between one
/// and `EXTEND_SEATS_PER_CALL` seats, the ledger loads and stays within
/// `MAX_SEATS`. Returns the ledger's length now and the length it grows to.
pub(crate) fn extension(
    exchange: &Exchange,
    ledger: &AccountInfo,
    seats: u16,
) -> Result<(usize, usize)> {
    require!(
        (1..=EXTEND_SEATS_PER_CALL).contains(&seats),
        OrderbookError::InvalidGrowth
    );
    let current = load_ledger(exchange, ledger)?.seats.len();
    let grown = current
        .checked_add(usize::from(seats))
        .ok_or(OrderbookError::MathOverflow)?;
    require!(grown <= MAX_SEATS, OrderbookError::LedgerTooLarge);
    Ok((ledger_len(current), ledger_len(grown)))
}

/// What `extend_ledger` does once the ledger has its new length: zeroes every new byte,
/// puts the new seats on the free list, and records the capacity.
pub(crate) fn zero_and_record(
    exchange: &mut Exchange,
    ledger: &AccountInfo,
    old_len: usize,
    new_len: usize,
) -> Result<()> {
    {
        let mut data = ledger.try_borrow_mut_data()?;
        require!(data.len() == new_len, OrderbookError::InvalidGrowth);
        data.get_mut(old_len..)
            .ok_or(OrderbookError::InvalidGrowth)?
            .fill(0);
    }
    let capacity = ledger_seats(new_len).ok_or(OrderbookError::WrongSize)?;
    let first = ledger_seats(old_len).ok_or(OrderbookError::WrongSize)?;
    let (first, capacity) = (
        u32::try_from(first).map_err(|_| OrderbookError::MathOverflow)?,
        u32::try_from(capacity).map_err(|_| OrderbookError::MathOverflow)?,
    );
    push_new_seats(
        &mut load_ledger_mut(exchange, ledger)?.engine(),
        first,
        capacity,
    )
    .map_err(engine)?;
    exchange.seat_capacity = capacity;
    Ok(())
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
/// full size, and starts the funding clock. A seventh perp market is refused
/// (`MAX_PERP_MARKETS`), so the accounts a liquidation or a withdrawal names stay within
/// a transaction's limits.
pub fn finalize_market(ctx: Context<FinalizeMarket>, market_id: u8) -> Result<()> {
    let accounts = &ctx.accounts;
    require_gate!(accounts.exchange, "finalize_market")?;
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
        if is_perp {
            require_perp_room(accounts.exchange.perp_markets)?;
        }
        Ok(())
    })?;
    if is_perp {
        ctx.accounts.exchange.perp_markets |= 1 << market_id;
    }
    Ok(())
}

/// Refuses another perp market once the exchange has `MAX_PERP_MARKETS` of them.
pub(crate) fn require_perp_room(perp_markets: u8) -> Result<()> {
    require!(
        perp_markets.count_ones() < MAX_PERP_MARKETS,
        OrderbookError::TooManyPerpMarkets
    );
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

/// Changes a market's limits. Its kind, tokens, tick, lot and capacity are
/// fixed for life, the recorded shortfall is the engine's, and its status
/// moves only through `restrict_market` and `resume_market`.
pub fn update_market_v2(
    ctx: Context<UpdateMarket>,
    market_id: u8,
    limits: MarketLimits,
) -> Result<()> {
    require_gate!(ctx.accounts.exchange, "update_market_v2")?;
    let mut market = load_mut::<MarketData>(&ctx.accounts.market, Scope::Market(market_id))?;
    limits.apply_to(&mut market.params)
}

/// Sets a market to paused or reduce-only, at any time. Security: active is
/// refused here, because `resume_market` is the one way back and it checks
/// that nothing is owed on the market.
pub fn restrict_market(ctx: Context<UpdateMarket>, market_id: u8, status: u8) -> Result<()> {
    require_gate!(ctx.accounts.exchange, "restrict_market")?;
    require!(
        status == STATUS_PAUSED || status == STATUS_REDUCE_ONLY,
        OrderbookError::ResumeOnly
    );
    let mut market = load_mut::<MarketData>(&ctx.accounts.market, Scope::Market(market_id))?;
    market.params.status = status;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use noirwire_orderbook_engine::MAX_OPEN_INTEREST_CAP;

    fn deployed() -> MarketLimits {
        MarketLimits {
            min_size: 1,
            min_notional: 1_000_000,
            band_bps: 400,
            im_bps: 1_000,
            mm_bps: 500,
            taker_fee_bps: 5,
            liq_penalty_bps: 200,
            funding_cap_bps: 50,
            max_move_bps: 250,
            max_open_orders: 32,
            max_price_age: 10,
            funding_interval: 60,
            min_publish_gap: 1,
            open_interest_cap: 10_000_000,
            liq_buffer_bps: 100,
            liq_insurance_share_bps: 5_000,
            fee_insurance_share_bps: 5_000,
            settle_window: 900,
            position_cap: 2_000_000,
        }
    }

    fn perp() -> MarketParams {
        MarketParams {
            tick: 100,
            base_lot: 1_000_000,
            kind: KIND_PERP,
            ..bytemuck::Zeroable::zeroed()
        }
    }

    fn applies(limits: MarketLimits) -> bool {
        limits.apply_to(&mut perp()).is_ok()
    }

    #[test]
    fn the_settle_window_is_at_least_a_second_and_at_most_a_day() {
        for settle_window in [1, MAX_PRICE_AGE] {
            assert!(applies(MarketLimits {
                settle_window,
                ..deployed()
            }));
        }
        for settle_window in [0, -1, MAX_PRICE_AGE + 1] {
            assert!(!applies(MarketLimits {
                settle_window,
                ..deployed()
            }));
        }
    }

    #[test]
    fn the_limits_change_only_while_the_price_source_is_healthy() {
        use noirwire_orderbook_engine::{ORACLE_DISLOCATED, ORACLE_SETTLING};
        for health in [ORACLE_DISLOCATED, ORACLE_SETTLING] {
            let mut params = MarketParams {
                oracle_health: health,
                ..perp()
            };
            let before = params;
            assert_eq!(
                deployed().apply_to(&mut params).unwrap_err(),
                error!(OrderbookError::OracleIncident)
            );
            assert_eq!(params, before);
        }
    }

    #[test]
    fn the_funding_cap_is_bounded_per_period() {
        assert!(applies(deployed()));
        let at_bound = MarketLimits {
            funding_cap_bps: MAX_FUNDING_CAP_BPS,
            ..deployed()
        };
        assert!(applies(at_bound));
        let above = MarketLimits {
            funding_cap_bps: MAX_FUNDING_CAP_BPS + 1,
            ..deployed()
        };
        assert!(!applies(above));
    }

    #[test]
    fn the_open_interest_cap_is_bounded_by_the_engine() {
        let at_bound = MarketLimits {
            open_interest_cap: MAX_OPEN_INTEREST_CAP,
            ..deployed()
        };
        assert!(applies(at_bound));
        for open_interest_cap in [MAX_OPEN_INTEREST_CAP + 1, u64::MAX] {
            let above = MarketLimits {
                open_interest_cap,
                ..deployed()
            };
            assert!(!applies(above));
        }
    }

    #[test]
    fn the_position_cap_is_bounded_like_the_open_interest_cap() {
        for position_cap in [1, MAX_OPEN_INTEREST_CAP] {
            let within = MarketLimits {
                position_cap,
                ..deployed()
            };
            assert!(applies(within));
        }
        for position_cap in [0, MAX_OPEN_INTEREST_CAP + 1, u64::MAX] {
            let outside = MarketLimits {
                position_cap,
                ..deployed()
            };
            assert!(!applies(outside));
        }
        let mut params = MarketParams {
            tick: 100,
            base_lot: 1_000_000,
            kind: KIND_PERP,
            ..bytemuck::Zeroable::zeroed()
        };
        deployed().apply_to(&mut params).unwrap();
        assert_eq!(params.position_cap, 2_000_000);
    }

    /// RULES 3a: only `set_market_access` moves the switches, so no limits
    /// payload can turn a list off or on.
    #[test]
    fn an_update_of_the_limits_keeps_the_access_switches() {
        use noirwire_orderbook_engine::{ACCESS_MAKERS_LISTED, ACCESS_TAKERS_LISTED};
        for access in [
            0,
            ACCESS_MAKERS_LISTED,
            ACCESS_TAKERS_LISTED,
            ACCESS_MAKERS_LISTED | ACCESS_TAKERS_LISTED,
        ] {
            let mut params = MarketParams { access, ..perp() };
            deployed().apply_to(&mut params).unwrap();
            assert_eq!(params.access, access);
            let tighter = MarketLimits {
                position_cap: 1,
                ..deployed()
            };
            tighter.apply_to(&mut params).unwrap();
            assert_eq!(params.access, access);
        }
    }
}

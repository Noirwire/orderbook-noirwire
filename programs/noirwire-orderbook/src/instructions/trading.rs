use anchor_lang::prelude::*;
use bytemuck::Zeroable;
use core::cell::RefMut;
use noirwire_orderbook_engine::{
    self as engine_api, Asset, EngineError, Env, Fill, Fills, Journal, JournalEntry,
    LiquidationOutcome, LiquidationRequest, LiquidationStatus, NewOrder, OrderType, Side, Trader,
    LIQUIDATION_JOURNAL_ENTRIES, PLACE_JOURNAL_EXTRA_ENTRIES,
};

use crate::errors::{engine, OrderbookError};
use crate::loader::{load, load_mut, load_view_mut, Scope};
use crate::market::{env, MarketAccounts};
use crate::risk::RiskTable;
use crate::state::{
    Exchange, LedgerData, OrderResult, StatsData, TapeData, TapeFill, ViewData, BOOK_SEED,
    EXCHANGE_SEED, LEDGER_SEED, MARKET_SEED, MAX_EXPIRY_AHEAD, PRICE_SEED, RESULT_CANCEL,
    RESULT_CANCEL_ALL, RESULT_LIQUIDATE, RESULT_SYNC, RESULT_TRANSFER, STATS_SEED, STATUS_DONE,
    STATUS_NOTHING_TO_LIQUIDATE, STATUS_REFUSED, TAPE_FILLS, TAPE_SEED,
};
use crate::view::{placed, push_result, refused, use_order_key};

/// RULES 3.0: the clock, once the expiry it is measured against is accepted.
/// This runs before anything else an order-key instruction does, including the
/// key swap, so a refused instruction leaves the key live.
fn now_before(expires_at: i64) -> Result<i64> {
    let now = Clock::get()?.unix_timestamp;
    require!(now <= expires_at, OrderbookError::Expired);
    let ahead = expires_at
        .checked_sub(now)
        .ok_or(OrderbookError::MathOverflow)?;
    require!(ahead <= MAX_EXPIRY_AHEAD, OrderbookError::ExpiryTooFar);
    Ok(now)
}

/// RULES 3.0: what every order-key instruction does first. The expiry is
/// accepted, then the view the key acts on is loaded and the key consumed.
/// Returns the clock, the view for the result, and the trader the engine sees.
fn key_call<'a>(
    accounts: &'a OrderKeyCall<'_>,
    expires_at: i64,
    replacement: &Pubkey,
) -> Result<(i64, RefMut<'a, ViewData>, u32, [u8; 32])> {
    let now = now_before(expires_at)?;
    let mut view = load_view_mut(&accounts.view)?;
    use_order_key(&mut view, accounts.order_key.key, replacement)?;
    let seat = view.seat;
    let owner = view.owner;
    Ok((now, view, seat, owner))
}

/// RULES 8: what a liquidator asks for, tried blind against seat `target`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct LiquidationInput {
    pub target: u32,
    pub size: u64,
    /// The worst liquidation price the liquidator accepts: the highest when
    /// buying a long target's position, the lowest when selling into a short one's.
    pub worst_price: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct OrderInput {
    /// 0 bid, 1 ask.
    pub side: u8,
    /// 0 limit, 1 post only, 2 immediate or cancel, 3 market.
    pub order_type: u8,
    pub price: u64,
    pub size: u64,
    pub secret: [u8; 16],
    pub reduce_only: bool,
    /// RULES 4: when a resting remainder stops being valid, unix seconds; zero for never.
    pub expiry: i64,
}

impl OrderInput {
    fn to_engine(self) -> Result<NewOrder> {
        let side = match self.side {
            0 => Side::Bid,
            1 => Side::Ask,
            _ => return Err(OrderbookError::InvalidOrderFlags.into()),
        };
        let order_type = match self.order_type {
            0 => OrderType::Limit,
            1 => OrderType::PostOnly,
            2 => OrderType::ImmediateOrCancel,
            3 => OrderType::Market,
            _ => return Err(OrderbookError::InvalidOrderFlags.into()),
        };
        Ok(NewOrder {
            side,
            order_type,
            price: self.price,
            size: self.size,
            secret: self.secret,
            reduce_only: self.reduce_only,
            expiry: self.expiry,
        })
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct TransferInput {
    pub to_collateral: bool,
    pub spot_token: u8,
    pub amount: u64,
}

/// The accounts of every instruction an order key signs, the same for each,
/// so that no public account's signature list tells one kind from another
/// (DESIGN 1). The remaining accounts are the perp markets other than
/// `market`, as `risk.rs` describes.
#[derive(Accounts)]
#[instruction(expires_at: i64, replacement: Pubkey, client_order_id: u64, market_id: u8)]
pub struct OrderKeyCall<'info> {
    pub order_key: Signer<'info>,
    /// CHECK: Its owner is read from its data and its address checked against that owner by the loader.
    #[account(mut)]
    pub view: UncheckedAccount<'info>,
    #[account(seeds = [EXCHANGE_SEED], bump = exchange.bump)]
    pub exchange: Account<'info, Exchange>,
    /// CHECK: Checked by the loader against its seeds, tag, size and readiness.
    #[account(mut, seeds = [LEDGER_SEED], bump)]
    pub ledger: UncheckedAccount<'info>,
    /// CHECK: Checked by the loader against its seeds, tag, size, readiness and market id.
    #[account(mut, seeds = [MARKET_SEED, &[market_id]], bump)]
    pub market: UncheckedAccount<'info>,
    /// CHECK: Checked by the loader against its seeds, tag, size, readiness and market id.
    #[account(mut, seeds = [BOOK_SEED, &[market_id]], bump)]
    pub book: UncheckedAccount<'info>,
    /// CHECK: Checked by the loader against its seeds, tag, size, readiness and market id.
    #[account(seeds = [PRICE_SEED, &[market_id]], bump)]
    pub price_feed: UncheckedAccount<'info>,
    /// CHECK: Checked by the loader against its seeds, tag, size, readiness and market id.
    #[account(mut, seeds = [TAPE_SEED, &[market_id]], bump)]
    pub tape: UncheckedAccount<'info>,
    /// CHECK: Checked by the loader against its seeds, tag, size and readiness.
    #[account(mut, seeds = [STATS_SEED], bump)]
    pub stats: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ExtendCompute {}

/// Does nothing. A transaction that asks for no compute gets 200,000 units
/// for each instruction of a program, so an order-key instruction sent with
/// this one may use 400,000 without naming the compute budget program, which
/// would set its transaction apart from every other order-key transaction.
pub fn extend_compute(_ctx: Context<ExtendCompute>) -> Result<()> {
    Ok(())
}

/// RULES 2 to 6 through the engine. A refusal that depends on the book is
/// written to the view as an outcome; every other refusal is an error that
/// changes nothing.
pub fn place_order(
    ctx: Context<OrderKeyCall>,
    expires_at: i64,
    replacement: Pubkey,
    client_order_id: u64,
    market_id: u8,
    order: OrderInput,
) -> Result<()> {
    let accounts = &ctx.accounts;
    let (now, mut view, seat, owner) = key_call(accounts, expires_at, &replacement)?;
    let trader = Trader {
        seat,
        owner: &owner,
    };
    let new_order = order.to_engine()?;

    let mut ledger_account = load_mut::<LedgerData>(&accounts.ledger, Scope::Global)?;
    let mut loaded = MarketAccounts::load(
        &accounts.market,
        &accounts.book,
        &accounts.price_feed,
        market_id,
    )?;
    let mut tape = load_mut::<TapeData>(&accounts.tape, Scope::Market(market_id))?;
    let mut stats = load_mut::<StatsData>(&accounts.stats, Scope::Global)?;

    let mut risk = RiskTable::new();
    risk.set(market_id, loaded.risk())?;
    risk.add_remaining(ctx.remaining_accounts)?;
    if loaded.is_perp() {
        risk.require_all(accounts.exchange.perp_markets)?;
    }
    let env = env(&accounts.exchange, now, &risk.markets);
    let mut placement = Placement {
        env: &env,
        trader,
        order: &new_order,
        client_order_id,
        market_id,
        ledger: &mut ledger_account,
        loaded: &mut loaded,
        tape: &mut tape,
        stats: &mut stats,
        view: &mut view,
    };
    matched(&mut placement)
}

/// Everything the match needs, handed over by reference so the frame that
/// holds the fills is its own: the runtime allows 4 KB per frame.
struct Placement<'a, 'b> {
    env: &'a Env<'a>,
    trader: Trader<'a>,
    order: &'a NewOrder,
    client_order_id: u64,
    market_id: u8,
    ledger: &'a mut LedgerData,
    loaded: &'a mut MarketAccounts<'b>,
    tape: &'a mut TapeData,
    stats: &'a mut StatsData,
    view: &'a mut ViewData,
}

#[inline(never)]
fn matched(placement: &mut Placement<'_, '_>) -> Result<()> {
    let is_perp = placement.loaded.is_perp();
    let market_id = placement.market_id;
    let mut entries = vec![
        JournalEntry::zeroed();
        usize::try_from(placement.env.max_steps)
            .map_err(|_| OrderbookError::MathOverflow)?
            + PLACE_JOURNAL_EXTRA_ENTRIES
    ];
    let mut journal = Journal::new(&mut entries);
    let mut fills = Fills::new();
    let mut market = placement.loaded.as_engine();
    let ledger = &mut *placement.ledger;
    let outcome = {
        let mut seats = ledger.engine();
        engine_api::place_order(
            &mut seats,
            &mut market,
            &mut journal,
            placement.env,
            placement.trader,
            placement.order,
            &mut fills,
        )
        .map_err(engine)?
    };
    record_fills(
        placement.tape,
        placement.stats,
        market_id,
        fills.as_slice(),
        placement.env.now,
    )?;
    if is_perp {
        publish_open_interest(placement.stats, market_id, market.book.open_interest)?;
    }
    placement.stats.count_order();
    engine_api::snapshot_seat(
        &ledger.seats,
        &market,
        placement.trader,
        &mut placement.view.snapshot,
    )
    .map_err(engine)?;
    push_result(placement.view, placed(placement.client_order_id, &outcome))
}

/// Appends each fill to the public tape and moves the public counters.
fn record_fills(
    tape: &mut TapeData,
    stats: &mut StatsData,
    market_id: u8,
    fills: &[Fill],
    now: i64,
) -> Result<()> {
    let market = usize::from(market_id);
    for fill in fills {
        let at = usize::try_from(tape.written % TAPE_FILLS as u64)
            .map_err(|_| OrderbookError::CounterOverflow)?;
        tape.fills[at] = TapeFill {
            fill_seq: fill.fill_seq,
            price: fill.price,
            size: fill.size,
            time: now,
            maker_receipt: fill.maker_receipt,
            taker_receipt: fill.taker_receipt,
            taker_side: match fill.taker_side {
                Side::Bid => 0,
                Side::Ask => 1,
            },
            _padding: [0; 7],
        };
        tape.written = tape
            .written
            .checked_add(1)
            .ok_or(OrderbookError::CounterOverflow)?;
        tape.last_price = fill.price;
        tape.last_fill_seq = fill.fill_seq;
        stats.count_fill(market, fill.price, fill.size)?;
    }
    Ok(())
}

/// RULES 6: the public open interest of a perp market is the figure its book
/// keeps, the total long size in lots.
fn publish_open_interest(stats: &mut StatsData, market_id: u8, open_interest: u64) -> Result<()> {
    *stats
        .open_interest
        .get_mut(usize::from(market_id))
        .ok_or(OrderbookError::InvalidMarketParams)? = open_interest;
    Ok(())
}

fn result(client_order_id: u64, kind: u8) -> OrderResult {
    OrderResult {
        client_order_id,
        kind,
        status: STATUS_DONE,
        ..OrderResult::default()
    }
}

/// RULES 5: cancels one resting order by its sequence number. An order that is
/// not on the book, whoever it belonged to, is an outcome: whether a sequence
/// number is still resting is a fact about the book.
pub fn cancel_order(
    ctx: Context<OrderKeyCall>,
    expires_at: i64,
    replacement: Pubkey,
    client_order_id: u64,
    market_id: u8,
    order_seq: u64,
) -> Result<()> {
    let accounts = &ctx.accounts;
    let (_, mut view, seat, owner) = key_call(accounts, expires_at, &replacement)?;
    let trader = Trader {
        seat,
        owner: &owner,
    };
    let mut ledger_account = load_mut::<LedgerData>(&accounts.ledger, Scope::Global)?;
    let ledger = &mut *ledger_account;
    let mut loaded = MarketAccounts::load(
        &accounts.market,
        &accounts.book,
        &accounts.price_feed,
        market_id,
    )?;
    let mut market = loaded.as_engine();
    let cancelled = {
        let mut seats = ledger.engine();
        engine_api::cancel_order(&mut seats, &mut market, trader, order_seq)
    };
    let outcome = match cancelled {
        Ok(()) => OrderResult {
            order_seq,
            cancelled: 1,
            ..result(client_order_id, RESULT_CANCEL)
        },
        Err(EngineError::OrderNotFound) => OrderResult {
            order_seq,
            ..refused(
                client_order_id,
                RESULT_CANCEL,
                STATUS_REFUSED,
                EngineError::OrderNotFound.code() as u16,
                0,
            )
        },
        Err(error) => return Err(engine(error)),
    };
    engine_api::snapshot_seat(&ledger.seats, &market, trader, &mut view.snapshot)
        .map_err(engine)?;
    push_result(&mut view, outcome)
}

/// Cancels up to `max_cancels` of the trader's resting orders on one market.
pub fn cancel_all(
    ctx: Context<OrderKeyCall>,
    expires_at: i64,
    replacement: Pubkey,
    client_order_id: u64,
    market_id: u8,
    max_cancels: u32,
) -> Result<()> {
    let accounts = &ctx.accounts;
    let (_, mut view, seat, owner) = key_call(accounts, expires_at, &replacement)?;
    let trader = Trader {
        seat,
        owner: &owner,
    };
    let mut ledger_account = load_mut::<LedgerData>(&accounts.ledger, Scope::Global)?;
    let ledger = &mut *ledger_account;
    let mut loaded = MarketAccounts::load(
        &accounts.market,
        &accounts.book,
        &accounts.price_feed,
        market_id,
    )?;
    let mut market = loaded.as_engine();
    let cancelled = {
        let mut seats = ledger.engine();
        engine_api::cancel_all(&mut seats, &mut market, trader, max_cancels).map_err(engine)?
    };
    engine_api::snapshot_seat(&ledger.seats, &market, trader, &mut view.snapshot)
        .map_err(engine)?;
    push_result(
        &mut view,
        OrderResult {
            cancelled: u64::from(cancelled),
            ..result(client_order_id, RESULT_CANCEL_ALL)
        },
    )
}

/// Copies the seat and the open orders on one market into the view.
pub fn sync_view(
    ctx: Context<OrderKeyCall>,
    expires_at: i64,
    replacement: Pubkey,
    client_order_id: u64,
    market_id: u8,
) -> Result<()> {
    let accounts = &ctx.accounts;
    let (_, mut view, seat, owner) = key_call(accounts, expires_at, &replacement)?;
    let trader = Trader {
        seat,
        owner: &owner,
    };
    let ledger = load::<LedgerData>(&accounts.ledger, Scope::Global)?;
    let mut loaded = MarketAccounts::load(
        &accounts.market,
        &accounts.book,
        &accounts.price_feed,
        market_id,
    )?;
    let market = loaded.as_engine();
    engine_api::snapshot_seat(&ledger.seats, &market, trader, &mut view.snapshot)
        .map_err(engine)?;
    push_result(&mut view, result(client_order_id, RESULT_SYNC))
}

/// RULES 8 through the engine. Every refusal is an outcome, because each one
/// would otherwise tell the caller something about the target's seat.
pub fn liquidate(
    ctx: Context<OrderKeyCall>,
    expires_at: i64,
    replacement: Pubkey,
    client_order_id: u64,
    market_id: u8,
    request: LiquidationInput,
) -> Result<()> {
    let LiquidationInput {
        target,
        size,
        worst_price,
    } = request;
    let accounts = &ctx.accounts;
    let (now, mut view, seat, owner) = key_call(accounts, expires_at, &replacement)?;
    let trader = Trader {
        seat,
        owner: &owner,
    };
    let mut ledger_account = load_mut::<LedgerData>(&accounts.ledger, Scope::Global)?;
    let ledger = &mut *ledger_account;
    let mut loaded = MarketAccounts::load(
        &accounts.market,
        &accounts.book,
        &accounts.price_feed,
        market_id,
    )?;
    let mut stats = load_mut::<StatsData>(&accounts.stats, Scope::Global)?;
    let mut risk = RiskTable::new();
    risk.set(market_id, loaded.risk())?;
    risk.add_remaining(ctx.remaining_accounts)?;
    risk.require_all(accounts.exchange.perp_markets)?;
    let env = env(&accounts.exchange, now, &risk.markets);

    let mut entries = vec![JournalEntry::zeroed(); LIQUIDATION_JOURNAL_ENTRIES];
    let mut journal = Journal::new(&mut entries);
    let mut market = loaded.as_engine();
    let outcome = {
        let mut seats = ledger.engine();
        engine_api::liquidate(
            &mut seats,
            &mut market,
            &mut journal,
            &env,
            trader,
            &LiquidationRequest {
                target,
                size,
                worst_price,
            },
        )
    };
    let outcome = outcome.map_err(engine)?;
    if outcome.status == LiquidationStatus::Liquidated {
        // Security: a liquidation moves no public volume or fill counter, so
        // a prober cannot read its success from the stats. Open interest is
        // public and has to stay true, so the book's figure is published, and
        // it does move when the liquidator's own position offsets what it
        // takes over.
        publish_open_interest(&mut stats, market_id, market.book.open_interest)?;
    }
    engine_api::snapshot_seat(&ledger.seats, &market, trader, &mut view.snapshot)
        .map_err(engine)?;
    push_result(&mut view, liquidated(client_order_id, &outcome)?)
}

/// What the liquidator's view records. `filled` is the lots taken over at
/// `filled_notional`, `cancelled` the target's orders removed, `fee` what
/// insurance paid and `rested` what it could not cover. Security: the
/// outcomes that say something about the target without anything having
/// happened (no such seat, no position, not below maintenance, and a worst
/// price that is only compared once the target is below maintenance) are all
/// written as the same result with every number zero.
fn liquidated(client_order_id: u64, outcome: &LiquidationOutcome) -> Result<OrderResult> {
    let status = match outcome.status {
        LiquidationStatus::Liquidated
        | LiquidationStatus::StalePrice
        | LiquidationStatus::LiquidatorMarginInsufficient => outcome.status.code(),
        LiquidationStatus::TargetSeatNotOpen
        | LiquidationStatus::NoPosition
        | LiquidationStatus::NotLiquidatable
        | LiquidationStatus::WorstPriceExceeded => {
            return Ok(OrderResult {
                status: STATUS_NOTHING_TO_LIQUIDATE,
                ..result(client_order_id, RESULT_LIQUIDATE)
            })
        }
    };
    let notional = u128::from(outcome.price)
        .checked_mul(u128::from(outcome.liquidated))
        .and_then(|value| u64::try_from(value).ok())
        .ok_or(OrderbookError::MathOverflow)?;
    Ok(OrderResult {
        filled: outcome.liquidated,
        filled_notional: notional,
        cancelled: u64::from(outcome.orders_cancelled),
        fee: outcome.insurance_paid,
        rested: outcome.uncovered,
        order_seq: outcome.penalty_to_insurance,
        status,
        ..result(client_order_id, RESULT_LIQUIDATE)
    })
}

/// Moves `amount` of the collateral token between the trader's perpetuals
/// collateral and their spot balance of a token kept in the same custody
/// account, with no token moving.
/// The debited side goes through the engine's withdrawal checks (margin,
/// freshness, recorded shortfall); the credited side is a deposit. The market
/// it names is any the caller chooses and counts in the risk table like the
/// remaining accounts; nothing on it changes.
pub fn transfer_between_balances(
    ctx: Context<OrderKeyCall>,
    expires_at: i64,
    replacement: Pubkey,
    client_order_id: u64,
    market_id: u8,
    transfer: TransferInput,
) -> Result<()> {
    let TransferInput {
        to_collateral,
        spot_token,
        amount,
    } = transfer;
    let accounts = &ctx.accounts;
    let (now, mut view, seat, owner) = key_call(accounts, expires_at, &replacement)?;
    let trader = Trader {
        seat,
        owner: &owner,
    };
    let exchange = &accounts.exchange;
    exchange.require_collateral_custody(spot_token)?;
    let (from, to) = if to_collateral {
        (Asset::Spot(spot_token), Asset::Collateral)
    } else {
        (Asset::Collateral, Asset::Spot(spot_token))
    };
    let mut risk = RiskTable::new();
    risk.set(
        market_id,
        MarketAccounts::load(
            &accounts.market,
            &accounts.book,
            &accounts.price_feed,
            market_id,
        )?
        .risk(),
    )?;
    risk.add_remaining(ctx.remaining_accounts)?;
    risk.require_all(exchange.perp_markets)?;
    let env = env(exchange, now, &risk.markets);
    let mut ledger_account = load_mut::<LedgerData>(&accounts.ledger, Scope::Global)?;
    let ledger = &mut *ledger_account;
    {
        let mut seats = ledger.engine();
        engine_api::withdraw(&mut seats, &env, trader, from, amount).map_err(engine)?;
        engine_api::deposit(&mut seats, seat, to, amount).map_err(engine)?;
    }
    view.snapshot.seat = ledger.seats[seat as usize];
    push_result(
        &mut view,
        OrderResult {
            filled: amount,
            ..result(client_order_id, RESULT_TRANSFER)
        },
    )
}

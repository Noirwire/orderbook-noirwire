use anchor_lang::prelude::*;
use bytemuck::Zeroable;
use core::cell::{Ref, RefMut};
use noirwire_orderbook_engine::{
    self as engine_api, Asset, EngineError, Env, Fill, Fills, Journal, JournalEntry, LedgerMut,
    LiquidationOutcome, LiquidationRequest, LiquidationStatus, MarketMut, MarketRisk, NewOrder,
    OrderType, Seat, Side, Trader, KIND_PERP, LIQUIDATION_JOURNAL_ENTRIES, MAX_FILLS,
    ORDERS_PER_SIDE, PLACE_JOURNAL_EXTRA_ENTRIES,
};

use crate::errors::{engine, OrderbookError};
use crate::loader::{load, load_mut, Scope};
use crate::risk::RiskTable;
use crate::state::{
    BookData, Exchange, LedgerData, MarketData, OrderResult, PriceData, StatsData, TapeData,
    TapeFill, ViewData, BOOK_SEED, EXCHANGE_SEED, HEADER_LEN, LEDGER_SEED, MARKET_SEED,
    MAX_EXPIRY_AHEAD, PRICE_SEED, RESULT_CANCEL, RESULT_CANCEL_ALL, RESULT_LIQUIDATE, RESULT_SYNC,
    RESULT_TRANSFER, STATS_SEED, STATUS_DONE, STATUS_NOTHING_TO_LIQUIDATE, STATUS_REFUSED,
    TAPE_FILLS, TAPE_SEED,
};
use crate::view::{placed, push_result, refused, use_order_key};

/// RULES 10: receipts are SHA-256 as the runtime computes it.
pub fn sha256(data: &[u8]) -> [u8; 32] {
    solana_sha256_hasher::hash(data).to_bytes()
}

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

/// The owner a view claims in its own data, before the loader checks that the
/// view sits at the address derived from that owner.
pub fn stated_owner(view: &AccountInfo) -> Result<Pubkey> {
    let data = view.try_borrow_data()?;
    let bytes = data
        .get(HEADER_LEN..HEADER_LEN + 32)
        .ok_or(OrderbookError::AccountMissing)?;
    Ok(Pubkey::new_from_array(
        bytes
            .try_into()
            .map_err(|_| OrderbookError::AccountMissing)?,
    ))
}

/// The view an order key acts on, with the key consumed. Returns the trader
/// the engine sees and the view for the result.
fn consume_key<'a>(
    view_account: &'a AccountInfo<'_>,
    order_key: &Pubkey,
    replacement: &Pubkey,
) -> Result<(RefMut<'a, ViewData>, u32, [u8; 32])> {
    let owner = stated_owner(view_account)?;
    let mut view = load_mut::<ViewData>(view_account, Scope::Owner(&owner))?;
    use_order_key(&mut view, order_key, replacement)?;
    let seat = view.seat;
    let owner = view.owner;
    Ok((view, seat, owner))
}

struct MarketAccounts<'a> {
    market: RefMut<'a, MarketData>,
    book: RefMut<'a, BookData>,
    price: Ref<'a, PriceData>,
}

impl<'a> MarketAccounts<'a> {
    fn load(
        market: &'a AccountInfo<'_>,
        book: &'a AccountInfo<'_>,
        price: &'a AccountInfo<'_>,
        market_id: u8,
    ) -> Result<Self> {
        let scope = Scope::Market(market_id);
        Ok(MarketAccounts {
            market: load_mut::<MarketData>(market, scope)?,
            book: load_mut::<BookData>(book, scope)?,
            price: load::<PriceData>(price, scope)?,
        })
    }

    fn risk(&self) -> MarketRisk {
        MarketRisk::new(
            &self.market.params,
            &self.price.price,
            &self.book.book.header,
        )
    }

    fn is_perp(&self) -> bool {
        self.market.params.kind == KIND_PERP
    }

    /// The market as the engine sees it, each side cut to the market's capacity.
    fn as_engine(&mut self) -> MarketMut<'_> {
        let capacity = usize::from(self.market.capacity).min(ORDERS_PER_SIDE);
        let book = &mut self.book.book;
        MarketMut {
            params: &mut self.market.params,
            book: &mut book.header,
            bids: &mut book.bids[..capacity],
            asks: &mut book.asks[..capacity],
            price: &self.price.price,
        }
    }
}

fn env<'a>(exchange: &Exchange, now: i64, risk: &'a RiskTable) -> Env<'a> {
    Env {
        now,
        exchange_paused: exchange.paused,
        max_steps: u32::from(exchange.max_steps),
        markets: &risk.markets,
        hash: sha256,
    }
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

#[derive(Accounts)]
#[instruction(expires_at: i64, replacement: Pubkey, client_order_id: u64, market_id: u8)]
pub struct PlaceOrder<'info> {
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

/// RULES 2 to 6 through the engine. A refusal that depends on the book is
/// written to the view as an outcome; every other refusal is an error that
/// changes nothing. The remaining accounts are the other perp markets.
pub fn place_order(
    ctx: Context<PlaceOrder>,
    expires_at: i64,
    replacement: Pubkey,
    client_order_id: u64,
    market_id: u8,
    order: OrderInput,
) -> Result<()> {
    let accounts = &ctx.accounts;
    let now = now_before(expires_at)?;
    let (mut view, seat, owner) =
        consume_key(&accounts.view, accounts.order_key.key, &replacement)?;
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
    let env = env(&accounts.exchange, now, &risk);
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
        let mut seats = LedgerMut {
            header: &mut ledger.header,
            seats: &mut ledger.seats,
        };
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
        is_perp,
        &ledger.seats,
        fills.as_slice(),
        placement.env.now,
    )?;
    placement.stats.orders = placement
        .stats
        .orders
        .checked_add(1)
        .ok_or(OrderbookError::CounterOverflow)?;
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
    is_perp: bool,
    seats: &[Seat],
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
        stats.fills = stats
            .fills
            .checked_add(1)
            .ok_or(OrderbookError::CounterOverflow)?;
        add_volume(stats, market, fill.price, fill.size)?;
    }
    if is_perp && !fills.is_empty() {
        let change = open_interest_change(seats, market, fills)?;
        add_open_interest(stats, market, change)?;
    }
    Ok(())
}

fn add_volume(stats: &mut StatsData, market: usize, price: u64, size: u64) -> Result<()> {
    let notional = u128::from(price)
        .checked_mul(u128::from(size))
        .ok_or(OrderbookError::MathOverflow)?;
    let slot = stats
        .volume
        .get_mut(market)
        .ok_or(OrderbookError::InvalidMarketParams)?;
    *slot = u128::from(*slot)
        .checked_add(notional)
        .and_then(|total| u64::try_from(total).ok())
        .ok_or(OrderbookError::CounterOverflow)?;
    Ok(())
}

fn add_open_interest(stats: &mut StatsData, market: usize, change: i128) -> Result<()> {
    let slot = stats
        .open_interest
        .get_mut(market)
        .ok_or(OrderbookError::InvalidMarketParams)?;
    *slot = i128::from(*slot)
        .checked_add(change)
        .and_then(|total| u64::try_from(total).ok())
        .ok_or(OrderbookError::CounterOverflow)?;
    Ok(())
}

fn positive(base: i128) -> i128 {
    base.max(0)
}

/// How much the lots held long on `market` changed over `fills`, walked back
/// from the seats as they are now, so a seat filled several times is undone
/// one fill at a time.
fn open_interest_change(seats: &[Seat], market: usize, fills: &[Fill]) -> Result<i128> {
    let mut tracked: [(u32, i128); MAX_FILLS + 1] = [(u32::MAX, 0); MAX_FILLS + 1];
    let mut tracked_len = 0usize;
    let mut change: i128 = 0;
    for fill in fills.iter().rev() {
        let size = i128::from(fill.size);
        let (taker_delta, maker_delta) = match fill.taker_side {
            Side::Bid => (size, -size),
            Side::Ask => (-size, size),
        };
        for (seat_index, delta) in [
            (fill.taker_seat, taker_delta),
            (fill.maker_seat, maker_delta),
        ] {
            let known = tracked[..tracked_len]
                .iter()
                .position(|(index, _)| *index == seat_index);
            let after = match known {
                Some(at) => tracked[at].1,
                None => {
                    let seat = seats
                        .get(
                            usize::try_from(seat_index)
                                .map_err(|_| OrderbookError::MathOverflow)?,
                        )
                        .ok_or(OrderbookError::InvariantBroken)?;
                    let slot = seat
                        .perp
                        .get(market)
                        .ok_or(OrderbookError::InvalidMarketParams)?;
                    i128::from(slot.base)
                }
            };
            let before = after
                .checked_sub(delta)
                .ok_or(OrderbookError::MathOverflow)?;
            change = change
                .checked_add(positive(after) - positive(before))
                .ok_or(OrderbookError::MathOverflow)?;
            match known {
                Some(at) => tracked[at].1 = before,
                None => {
                    let slot = tracked
                        .get_mut(tracked_len)
                        .ok_or(OrderbookError::InvariantBroken)?;
                    *slot = (seat_index, before);
                    tracked_len += 1;
                }
            }
        }
    }
    Ok(change)
}

#[derive(Accounts)]
#[instruction(expires_at: i64, replacement: Pubkey, client_order_id: u64, market_id: u8)]
pub struct AdjustOrders<'info> {
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
    ctx: Context<AdjustOrders>,
    expires_at: i64,
    replacement: Pubkey,
    client_order_id: u64,
    market_id: u8,
    order_seq: u64,
) -> Result<()> {
    let accounts = &ctx.accounts;
    now_before(expires_at)?;
    let (mut view, seat, owner) =
        consume_key(&accounts.view, accounts.order_key.key, &replacement)?;
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
        let mut seats = LedgerMut {
            header: &mut ledger.header,
            seats: &mut ledger.seats,
        };
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
    ctx: Context<AdjustOrders>,
    expires_at: i64,
    replacement: Pubkey,
    client_order_id: u64,
    market_id: u8,
    max_cancels: u32,
) -> Result<()> {
    let accounts = &ctx.accounts;
    now_before(expires_at)?;
    let (mut view, seat, owner) =
        consume_key(&accounts.view, accounts.order_key.key, &replacement)?;
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
        let mut seats = LedgerMut {
            header: &mut ledger.header,
            seats: &mut ledger.seats,
        };
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
    ctx: Context<AdjustOrders>,
    expires_at: i64,
    replacement: Pubkey,
    client_order_id: u64,
    market_id: u8,
) -> Result<()> {
    let accounts = &ctx.accounts;
    now_before(expires_at)?;
    let (mut view, seat, owner) =
        consume_key(&accounts.view, accounts.order_key.key, &replacement)?;
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

#[derive(Accounts)]
#[instruction(expires_at: i64, replacement: Pubkey, client_order_id: u64, market_id: u8)]
pub struct Liquidate<'info> {
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
    /// CHECK: Checked by the loader against its seeds, tag, size and readiness.
    #[account(mut, seeds = [STATS_SEED], bump)]
    pub stats: UncheckedAccount<'info>,
}

fn long_lots(seats: &[Seat], seat: u32, market: usize) -> i128 {
    usize::try_from(seat)
        .ok()
        .and_then(|index| seats.get(index))
        .and_then(|seat| seat.perp.get(market))
        .map(|slot| positive(i128::from(slot.base)))
        .unwrap_or(0)
}

/// RULES 8 through the engine. Every refusal is an outcome, because each one
/// would otherwise tell the caller something about the target's seat. The
/// remaining accounts are the other perp markets.
pub fn liquidate(
    ctx: Context<Liquidate>,
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
    let now = now_before(expires_at)?;
    let (mut view, seat, owner) =
        consume_key(&accounts.view, accounts.order_key.key, &replacement)?;
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
    let env = env(&accounts.exchange, now, &risk);
    let market_index = usize::from(market_id);
    let long_before = long_lots(&ledger.seats, target, market_index)
        + long_lots(&ledger.seats, seat, market_index);

    let mut entries = vec![JournalEntry::zeroed(); LIQUIDATION_JOURNAL_ENTRIES];
    let mut journal = Journal::new(&mut entries);
    let mut market = loaded.as_engine();
    let outcome = {
        let mut seats = LedgerMut {
            header: &mut ledger.header,
            seats: &mut ledger.seats,
        };
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
        // public and has to stay true, so it does move when the liquidator's
        // own position offsets what it takes over.
        let long_after = long_lots(&ledger.seats, target, market_index)
            + long_lots(&ledger.seats, seat, market_index);
        add_open_interest(&mut stats, market_index, long_after - long_before)?;
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

#[derive(Accounts)]
#[instruction(expires_at: i64, replacement: Pubkey, client_order_id: u64)]
pub struct Rebalance<'info> {
    pub order_key: Signer<'info>,
    /// CHECK: Its owner is read from its data and its address checked against that owner by the loader.
    #[account(mut)]
    pub view: UncheckedAccount<'info>,
    #[account(seeds = [EXCHANGE_SEED], bump = exchange.bump)]
    pub exchange: Account<'info, Exchange>,
    /// CHECK: Checked by the loader against its seeds, tag, size and readiness.
    #[account(mut, seeds = [LEDGER_SEED], bump)]
    pub ledger: UncheckedAccount<'info>,
}

/// Moves `amount` of the collateral token between the trader's perpetuals
/// collateral and their spot balance of the same mint, with no token moving.
/// The debited side goes through the engine's withdrawal checks (margin,
/// freshness, recorded shortfall); the credited side is a deposit. The
/// remaining accounts are the perp markets, as `risk.rs` describes.
pub fn transfer_between_balances(
    ctx: Context<Rebalance>,
    expires_at: i64,
    replacement: Pubkey,
    client_order_id: u64,
    to_collateral: bool,
    spot_token: u8,
    amount: u64,
) -> Result<()> {
    let accounts = &ctx.accounts;
    let now = now_before(expires_at)?;
    let (mut view, seat, owner) =
        consume_key(&accounts.view, accounts.order_key.key, &replacement)?;
    let trader = Trader {
        seat,
        owner: &owner,
    };
    let exchange = &accounts.exchange;
    let collateral_mint = exchange.token(exchange.collateral_token)?.mint;
    require_keys_eq!(
        exchange.token(spot_token)?.mint,
        collateral_mint,
        OrderbookError::WrongMint
    );
    let (from, to) = if to_collateral {
        (Asset::Spot(spot_token), Asset::Collateral)
    } else {
        (Asset::Collateral, Asset::Spot(spot_token))
    };
    let mut risk = RiskTable::new();
    risk.add_remaining(ctx.remaining_accounts)?;
    risk.require_all(exchange.perp_markets)?;
    let env = env(exchange, now, &risk);
    let mut ledger_account = load_mut::<LedgerData>(&accounts.ledger, Scope::Global)?;
    let ledger = &mut *ledger_account;
    {
        let mut seats = LedgerMut {
            header: &mut ledger.header,
            seats: &mut ledger.seats,
        };
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

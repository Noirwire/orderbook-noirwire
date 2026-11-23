use anchor_lang::prelude::*;
use bytemuck::Zeroable;
use noirwire_orderbook_engine::{
    self as engine_api, Env, Fills, FireRules, Journal, JournalEntry, Kind, MarketParams,
    MarketRisk, Seat, Trader, TriggerBook, TriggerError, TriggerInput, TriggerSize,
    MAX_FIRES_PER_PASS, PLACE_JOURNAL_EXTRA_ENTRIES, TRIGGER_MAX_STEPS,
};

use super::trading::{key_call, publish_open_interest, record_fills, result, OrderKeyCall};
use crate::errors::{trigger, trigger_code, OrderbookError};
use crate::layout::require_gate;
use crate::loader::{
    load_ledger, load_ledger_mut, load_mut, load_triggers_mut, open_book, LedgerAccount, Scope,
};
use crate::market::{env, MarketAccounts};
use crate::risk::RiskTable;
use crate::state::{
    Exchange, OrderResult, StatsData, TapeData, ViewData, BOOK_SEED, EXCHANGE_SEED, LEDGER_SEED,
    MARKET_SEED, PRICE_SEED, RESULT_CANCEL_TRIGGER, RESULT_SET_TRIGGER, STATS_SEED, STATUS_REFUSED,
    SWEEP_TRIGGER_SLOTS_PER_CALL, TAPE_SEED, TRIGGER_RETRY_SECONDS, TRIGGER_SEED,
};
use crate::view::{forget_trigger_status, push_result, refused, seated_index};

/// What a trader asks `set_trigger` for.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct TriggerParams {
    /// 0 take-profit, 1 stop-loss.
    pub kind: u8,
    pub trigger_price: u64,
    /// The worst price of the reduce-only market order the trigger places.
    pub worst_price: u64,
    /// Zero for the whole position at the time of firing, else a fixed number of lots.
    pub size: u64,
    /// Unix seconds after which the trigger is dropped; zero for never.
    pub expiry: i64,
    /// The receipt secret the trader draws, as for `place_order`. Every order the trigger
    /// places carries it.
    pub secret: [u8; 16],
}

fn kind_of(byte: u8) -> Result<Kind> {
    match byte {
        0 => Ok(Kind::TakeProfit),
        1 => Ok(Kind::StopLoss),
        _ => Err(OrderbookError::TriggerKindInvalid.into()),
    }
}

/// A refusal of a trigger call is an outcome written to the view, because it depends on
/// the seat's position, its side, its other trigger or its slot, and a visible failure
/// would tell a prober which. A malformed or self-contradicting book (`TriggerBookInvalid`,
/// `TriggerBookCorrupt`, both public and naming no seat), or market settings the engine
/// cannot run on, depend on no private state and fail the transaction.
fn refusal_outcome(client_order_id: u64, kind: u8, error: TriggerError) -> Result<OrderResult> {
    match error {
        TriggerError::BadLayout | TriggerError::Corrupt | TriggerError::Engine(_) => {
            Err(trigger(error))
        }
        other => Ok(refused(
            client_order_id,
            kind,
            STATUS_REFUSED,
            trigger_code(other) as u16,
            0,
        )),
    }
}

/// What `apply_set_trigger` reads besides the book.
pub struct SetCall<'a> {
    pub trader: Trader<'a>,
    pub seat: &'a Seat,
    pub params: &'a MarketParams,
    /// The market's `usable_mark` (healthy and fresh), the one test `fire_triggers`, the
    /// status read and liquidation use too, or `None`.
    pub mark: Option<u64>,
    pub now: i64,
    /// Names the result the call writes to the view. The trigger does not store it.
    pub client_order_id: u64,
}

/// Sets, or replaces, a trigger and says what happened as the result the view records.
pub fn apply_set_trigger(
    book: &mut TriggerBook<'_>,
    call: &SetCall<'_>,
    request: &TriggerParams,
) -> Result<OrderResult> {
    let kind = kind_of(request.kind)?;
    let size = match request.size {
        0 => TriggerSize::WholePosition,
        lots => TriggerSize::Lots(lots),
    };
    let input = TriggerInput {
        kind,
        trigger_price: request.trigger_price,
        worst_price: request.worst_price,
        size,
        expiry: request.expiry,
        secret: request.secret,
    };
    match book.set_trigger(
        call.trader,
        call.seat,
        call.params,
        call.mark,
        call.now,
        &input,
    ) {
        Ok(set) => Ok(OrderResult {
            cancelled: u64::from(set.replaced),
            ..result(call.client_order_id, RESULT_SET_TRIGGER)
        }),
        Err(error) => refusal_outcome(call.client_order_id, RESULT_SET_TRIGGER, error),
    }
}

/// Cancels a trigger and says what happened as the result the view records. Cancelling
/// nothing is not a refusal.
pub fn apply_cancel_trigger(
    book: &mut TriggerBook<'_>,
    trader: Trader<'_>,
    seat: &Seat,
    kind: u8,
    now: i64,
    client_order_id: u64,
) -> Result<OrderResult> {
    let kind = kind_of(kind)?;
    match book.cancel_trigger(trader, seat, kind, now) {
        Ok(existed) => Ok(OrderResult {
            cancelled: u64::from(existed),
            ..result(client_order_id, RESULT_CANCEL_TRIGGER)
        }),
        Err(error) => refusal_outcome(client_order_id, RESULT_CANCEL_TRIGGER, error),
    }
}

/// Sets the trader's take-profit or stop-loss on one market. The refusals that depend on
/// the position are outcomes in the view; see `refusal_outcome`.
///
/// RULES 12c: allowed while the market is paused (a pause stops trading, not the
/// trader's protection), though `fire_triggers` is refused until it resumes. A usable
/// mark is still needed to set.
pub fn set_trigger(
    ctx: Context<OrderKeyCall>,
    expires_at: i64,
    replacement: Pubkey,
    client_order_id: u64,
    market_id: u8,
    request: TriggerParams,
) -> Result<()> {
    let accounts = &ctx.accounts;
    require_gate!(accounts.exchange, "set_trigger")?;
    let (now, mut view, owner) = key_call(accounts, expires_at, &replacement)?;
    let ledger = load_ledger(&accounts.exchange, &accounts.ledger)?;
    let seat_index = seated_index(&view, &ledger.seats)?;
    let seat = ledger
        .seats
        .get(seat_index as usize)
        .ok_or(OrderbookError::SeatOutOfRange)?;
    let mut loaded = MarketAccounts::load(
        &accounts.market,
        &accounts.book,
        &accounts.price_feed,
        market_id,
    )?;
    let risk = loaded.risk();
    let params = *loaded.as_engine().params;
    let mut data = load_triggers_mut(&accounts.triggers, market_id)?;
    let mut book = open_book(&mut data)?;
    let outcome = apply_set_trigger(
        &mut book,
        &SetCall {
            trader: Trader {
                seat: seat_index,
                owner: &owner,
            },
            seat,
            params: &params,
            mark: risk.usable_mark(now),
            now,
            client_order_id,
        },
        &request,
    )?;
    forget_status_after(&mut view, market_id, &outcome);
    push_result(&mut view, outcome)
}

/// Cancels the trader's take-profit or stop-loss on one market.
pub fn cancel_trigger(
    ctx: Context<OrderKeyCall>,
    expires_at: i64,
    replacement: Pubkey,
    client_order_id: u64,
    market_id: u8,
    kind: u8,
) -> Result<()> {
    let accounts = &ctx.accounts;
    require_gate!(accounts.exchange, "cancel_trigger")?;
    let (now, mut view, owner) = key_call(accounts, expires_at, &replacement)?;
    let ledger = load_ledger(&accounts.exchange, &accounts.ledger)?;
    let seat_index = seated_index(&view, &ledger.seats)?;
    let seat = ledger
        .seats
        .get(seat_index as usize)
        .ok_or(OrderbookError::SeatOutOfRange)?;
    let mut data = load_triggers_mut(&accounts.triggers, market_id)?;
    let mut book = open_book(&mut data)?;
    let outcome = apply_cancel_trigger(
        &mut book,
        Trader {
            seat: seat_index,
            owner: &owner,
        },
        seat,
        kind,
        now,
        client_order_id,
    )?;
    forget_status_after(&mut view, market_id, &outcome);
    push_result(&mut view, outcome)
}

/// A set or cancel that went through changed the book, so the view's status for that
/// market is no longer what the last sync read: it goes back to unknown. A refusal
/// changed nothing and leaves it.
pub(crate) fn forget_status_after(view: &mut ViewData, market_id: u8, outcome: &OrderResult) {
    if outcome.status != STATUS_REFUSED {
        forget_trigger_status(view, market_id);
    }
}

#[derive(Accounts)]
#[instruction(market_id: u8)]
pub struct FireTriggers<'info> {
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
    /// CHECK: Checked by the loader against its seeds, tag, size, readiness and market id.
    #[account(mut, seeds = [TRIGGER_SEED, &[market_id]], bump)]
    pub triggers: UncheckedAccount<'info>,
}

/// Everything one pass needs, handed over by reference so the frame that holds the
/// fills is its own: the runtime allows 4 KB per frame.
pub(crate) struct Firing<'a, 'b, 'l, 't> {
    pub env: &'a Env<'a>,
    pub market_id: u8,
    pub max_fires: usize,
    pub ledger: &'a mut LedgerAccount<'l>,
    pub loaded: &'a mut MarketAccounts<'b>,
    pub tape: &'a mut TapeData,
    pub stats: &'a mut StatsData,
    pub book: &'a mut TriggerBook<'t>,
}

/// One pass of the engine's firing, with the fills of each order recorded on the tape
/// and in the counters. A failure to record is returned, so the fills it belongs to are
/// rolled back with it.
#[inline(never)]
pub(crate) fn fired(firing: &mut Firing<'_, '_, '_, '_>) -> Result<engine_api::FirePass> {
    let market_id = firing.market_id;
    let now = firing.env.now;
    let mut entries = vec![
        JournalEntry::zeroed();
        usize::try_from(firing.env.max_steps)
            .map_err(|_| OrderbookError::MathOverflow)?
            + PLACE_JOURNAL_EXTRA_ENTRIES
    ];
    let mut journal = Journal::new(&mut entries);
    let mut fills = Fills::new();
    let mut market = firing.loaded.as_engine();
    let rules = FireRules {
        max: firing.max_fires,
        retry_delay: TRIGGER_RETRY_SECONDS,
    };
    let tape = &mut *firing.tape;
    let stats = &mut *firing.stats;
    let mut failure: Option<Error> = None;
    let pass = {
        let mut seats = firing.ledger.engine();
        engine_api::fire_triggers(
            firing.book,
            &mut seats,
            &mut market,
            &mut journal,
            firing.env,
            &mut fills,
            &rules,
            |_, fills, _| {
                if failure.is_some() {
                    return;
                }
                match record_fills(tape, stats, market_id, fills.as_slice(), now) {
                    Ok(()) => stats.count_order(),
                    Err(error) => failure = Some(error),
                }
            },
        )
    };
    if let Some(error) = failure {
        return Err(error);
    }
    if pass.idle == Some(engine_api::Idle::BookCorrupt) {
        return Err(trigger(TriggerError::Corrupt));
    }
    if pass.placed > 0 {
        publish_open_interest(stats, market_id, market.book.open_interest)?;
    }
    Ok(pass)
}

/// Places the reduce-only market orders of the triggers whose price the mark has reached,
/// at most `max_fires`. Anyone may call, and so may a scheduler: a paused exchange or
/// market, an unhealthy source, an old mark and nothing due all succeed and change
/// nothing. A refusal to load an account, to record a fill, or a trigger book that
/// disagrees with itself (`TriggerBookCorrupt`) fails the transaction, so a pass never
/// commits records it took off the heaps and did not settle.
pub fn fire_triggers(ctx: Context<FireTriggers>, market_id: u8, max_fires: u8) -> Result<()> {
    let accounts = &ctx.accounts;
    require_gate!(accounts.exchange, "fire_triggers")?;
    require!(
        (1..=MAX_FIRES_PER_PASS).contains(&usize::from(max_fires)),
        OrderbookError::InvalidSettings
    );
    let now = Clock::get()?.unix_timestamp;
    let mut ledger = load_ledger_mut(&accounts.exchange, &accounts.ledger)?;
    let mut loaded = MarketAccounts::load(
        &accounts.market,
        &accounts.book,
        &accounts.price_feed,
        market_id,
    )?;
    let mut tape = load_mut::<TapeData>(&accounts.tape, Scope::Market(market_id))?;
    let mut stats = load_mut::<StatsData>(&accounts.stats, Scope::Global)?;
    let mut data = load_triggers_mut(&accounts.triggers, market_id)?;
    let mut book = open_book(&mut data)?;

    let mut risk = RiskTable::new();
    risk.set(market_id, loaded.risk())?;
    risk.add_remaining(ctx.remaining_accounts)?;
    if loaded.is_perp() {
        risk.require_all(accounts.exchange.perp_markets)?;
    }
    let env = firing_env(&accounts.exchange, now, &risk.markets);
    fired(&mut Firing {
        env: &env,
        market_id,
        max_fires: usize::from(max_fires),
        ledger: &mut ledger,
        loaded: &mut loaded,
        tape: &mut tape,
        stats: &mut stats,
        book: &mut book,
    })?;
    Ok(())
}

/// The engine's environment for a firing pass: the exchange's, except that a fired order
/// makes at most `TRIGGER_MAX_STEPS` fills.
pub(crate) fn firing_env<'a>(exchange: &Exchange, now: i64, markets: &'a [MarketRisk]) -> Env<'a> {
    let mut firing = env(exchange, now, markets);
    firing.max_steps = firing.max_steps.min(u32::from(TRIGGER_MAX_STEPS));
    firing
}

#[derive(Accounts)]
#[instruction(market_id: u8)]
pub struct SweepTriggers<'info> {
    #[account(seeds = [EXCHANGE_SEED], bump = exchange.bump)]
    pub exchange: Account<'info, Exchange>,
    /// CHECK: Checked by the loader against its seeds, tag, size and readiness.
    #[account(seeds = [LEDGER_SEED], bump)]
    pub ledger: UncheckedAccount<'info>,
    /// CHECK: Checked by the loader against its seeds, tag, size, readiness and market id.
    #[account(mut, seeds = [TRIGGER_SEED, &[market_id]], bump)]
    pub triggers: UncheckedAccount<'info>,
}

/// Reads up to `count` seats of the ledger from the book's cursor: drops the triggers that
/// no longer belong to their seat and queues the ones a pass took and never settled. It
/// stops early at a fixed number of heap changes and leaves the cursor on the first seat
/// it did not finish, so the next call resumes there. Returns nothing, so it tells
/// nobody what it found.
pub(crate) fn sweep_slots(
    book: &mut TriggerBook<'_>,
    seats: &[Seat],
    count: u16,
    now: i64,
) -> Result<()> {
    require!(
        (1..=SWEEP_TRIGGER_SLOTS_PER_CALL).contains(&count),
        OrderbookError::InvalidSettings
    );
    book.sweep(seats, u32::from(count), now).map_err(trigger)?;
    Ok(())
}

/// Anyone may call. Upkeep only: a trigger is safe whether or not a sweep ever runs.
pub fn sweep_triggers(ctx: Context<SweepTriggers>, market_id: u8, count: u16) -> Result<()> {
    let accounts = &ctx.accounts;
    require_gate!(accounts.exchange, "sweep_triggers")?;
    let now = Clock::get()?.unix_timestamp;
    let ledger = load_ledger(&accounts.exchange, &accounts.ledger)?;
    let mut data = load_triggers_mut(&accounts.triggers, market_id)?;
    let mut book = open_book(&mut data)?;
    sweep_slots(&mut book, &ledger.seats, count, now)
}

#![forbid(unsafe_code)]

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::ephemeral;

pub mod custody;
pub mod ephemeral;
pub mod errors;
pub mod instructions;
pub mod loader;
pub mod risk;
pub mod state;
pub mod view;

use instructions::*;
use state::{ExchangeSettings, ORDER_KEYS};

declare_id!("9YiFamFrLbCiNYQczPwKfSwnnaTjDNWm9guokUGxB1z8");

#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "NoirWire Order Book",
    project_url: "https://noirwire.com",
    contacts: "email:ph1l1ph@proton.me",
    policy: "https://github.com/Noirwire/orderbook-noirwire/blob/main/SECURITY.md",
    preferred_languages: "en",
    source_code: "https://github.com/Noirwire/orderbook-noirwire"
}

#[ephemeral]
#[program]
pub mod noirwire_orderbook {
    use super::*;

    pub fn initialize_exchange(
        ctx: Context<InitializeExchange>,
        settings: ExchangeSettings,
    ) -> Result<()> {
        instructions::initialize_exchange(ctx, settings)
    }

    pub fn update_exchange(
        ctx: Context<AdministerExchange>,
        settings: ExchangeSettings,
    ) -> Result<()> {
        instructions::update_exchange(ctx, settings)
    }

    pub fn set_paused(ctx: Context<AdministerExchange>, paused: bool) -> Result<()> {
        instructions::set_paused(ctx, paused)
    }

    pub fn propose_admin(ctx: Context<AdministerExchange>, nominee: Option<Pubkey>) -> Result<()> {
        instructions::propose_admin(ctx, nominee)
    }

    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        instructions::accept_admin(ctx)
    }

    pub fn register_token(ctx: Context<RegisterToken>, index: u8, mint: Pubkey) -> Result<()> {
        instructions::register_token(ctx, index, mint)
    }

    pub fn delegate_exchange(ctx: Context<DelegateExchange>, validator: Pubkey) -> Result<()> {
        instructions::delegate_exchange(ctx, validator)
    }

    pub fn undelegate_exchange(ctx: Context<UndelegateExchange>) -> Result<()> {
        instructions::undelegate_exchange(ctx)
    }

    pub fn withdraw_exchange(ctx: Context<WithdrawExchange>, lamports: u64) -> Result<()> {
        instructions::withdraw_exchange(ctx, lamports)
    }

    pub fn create_ledger(ctx: Context<CreateLedger>) -> Result<()> {
        instructions::create_ledger(ctx)
    }

    pub fn finalize_ledger(ctx: Context<FinalizeLedger>) -> Result<()> {
        instructions::finalize_ledger(ctx)
    }

    pub fn create_market(
        ctx: Context<CreateMarket>,
        market_id: u8,
        settings: MarketSettings,
    ) -> Result<()> {
        instructions::create_market(ctx, market_id, settings)
    }

    pub fn grow_account(
        ctx: Context<GrowAccount>,
        kind: u8,
        market_id: u8,
        new_len: u32,
    ) -> Result<()> {
        instructions::grow_account(ctx, kind, market_id, new_len)
    }

    pub fn finalize_market(ctx: Context<FinalizeMarket>, market_id: u8) -> Result<()> {
        instructions::finalize_market(ctx, market_id)
    }

    pub fn update_market(
        ctx: Context<UpdateMarket>,
        market_id: u8,
        limits: MarketLimits,
    ) -> Result<()> {
        instructions::update_market(ctx, market_id, limits)
    }

    pub fn open_trader(ctx: Context<OpenTrader>, order_keys: [Pubkey; ORDER_KEYS]) -> Result<()> {
        instructions::open_trader(ctx, order_keys)
    }

    pub fn set_order_keys(ctx: Context<OwnView>, order_keys: [Pubkey; ORDER_KEYS]) -> Result<()> {
        instructions::set_order_keys(ctx, order_keys)
    }

    pub fn close_trader(ctx: Context<CloseTrader>) -> Result<()> {
        instructions::close_trader(ctx)
    }

    pub fn deposit(ctx: Context<Deposit>, seat: u32, asset: AssetKind, amount: u64) -> Result<()> {
        instructions::deposit_tokens(ctx, seat, asset, amount)
    }

    pub fn withdraw(ctx: Context<Withdraw>, asset: AssetKind, amount: u64) -> Result<()> {
        instructions::withdraw_tokens(ctx, asset, amount)
    }

    pub fn place_order(
        ctx: Context<PlaceOrder>,
        expires_at: i64,
        replacement: Pubkey,
        client_order_id: u64,
        market_id: u8,
        order: OrderInput,
    ) -> Result<()> {
        instructions::place_order(
            ctx,
            expires_at,
            replacement,
            client_order_id,
            market_id,
            order,
        )
    }

    pub fn cancel_order(
        ctx: Context<AdjustOrders>,
        expires_at: i64,
        replacement: Pubkey,
        client_order_id: u64,
        market_id: u8,
        order_seq: u64,
    ) -> Result<()> {
        instructions::cancel_order(
            ctx,
            expires_at,
            replacement,
            client_order_id,
            market_id,
            order_seq,
        )
    }

    pub fn cancel_all(
        ctx: Context<AdjustOrders>,
        expires_at: i64,
        replacement: Pubkey,
        client_order_id: u64,
        market_id: u8,
        max_cancels: u32,
    ) -> Result<()> {
        instructions::cancel_all(
            ctx,
            expires_at,
            replacement,
            client_order_id,
            market_id,
            max_cancels,
        )
    }

    pub fn sync_view(
        ctx: Context<AdjustOrders>,
        expires_at: i64,
        replacement: Pubkey,
        client_order_id: u64,
        market_id: u8,
    ) -> Result<()> {
        instructions::sync_view(ctx, expires_at, replacement, client_order_id, market_id)
    }

    pub fn liquidate(
        ctx: Context<Liquidate>,
        expires_at: i64,
        replacement: Pubkey,
        client_order_id: u64,
        market_id: u8,
        request: LiquidationInput,
    ) -> Result<()> {
        instructions::liquidate(
            ctx,
            expires_at,
            replacement,
            client_order_id,
            market_id,
            request,
        )
    }

    pub fn publish_price(
        ctx: Context<PublishPrice>,
        market_id: u8,
        price: u64,
        publish_time: i64,
    ) -> Result<()> {
        instructions::publish_price(ctx, market_id, price, publish_time)
    }

    pub fn reset_price(
        ctx: Context<ResetPrice>,
        market_id: u8,
        price: u64,
        publish_time: i64,
    ) -> Result<()> {
        instructions::reset_price(ctx, market_id, price, publish_time)
    }

    pub fn cover_shortfall(ctx: Context<CoverShortfall>, market_id: u8, seat: u32) -> Result<()> {
        instructions::cover_shortfall(ctx, market_id, seat)
    }

    pub fn reconcile_shortfall(ctx: Context<ReconcileShortfall>) -> Result<()> {
        instructions::reconcile_shortfall(ctx)
    }

    pub fn transfer_between_balances(
        ctx: Context<Rebalance>,
        expires_at: i64,
        replacement: Pubkey,
        client_order_id: u64,
        to_collateral: bool,
        spot_token: u8,
        amount: u64,
    ) -> Result<()> {
        instructions::transfer_between_balances(
            ctx,
            expires_at,
            replacement,
            client_order_id,
            to_collateral,
            spot_token,
            amount,
        )
    }

    pub fn resume_market(ctx: Context<ResumeMarket>, market_id: u8) -> Result<()> {
        instructions::resume_market(ctx, market_id)
    }

    pub fn move_fees_to_insurance(ctx: Context<MoveFees>, amount: u64) -> Result<()> {
        instructions::move_fees_to_insurance(ctx, amount)
    }

    pub fn collect_fees(ctx: Context<CollectFees>, asset: AssetKind, amount: u64) -> Result<()> {
        instructions::collect_fees(ctx, asset, amount)
    }

    pub fn update_funding(ctx: Context<UpdateFunding>, market_id: u8) -> Result<()> {
        instructions::update_funding(ctx, market_id)
    }

    pub fn schedule_funding(
        ctx: Context<ScheduleFunding>,
        market_id: u8,
        task_id: i64,
        interval_ms: i64,
        iterations: i64,
    ) -> Result<()> {
        instructions::schedule_funding(ctx, market_id, task_id, interval_ms, iterations)
    }
}

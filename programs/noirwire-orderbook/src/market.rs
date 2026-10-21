use anchor_lang::prelude::*;
use core::cell::{Ref, RefMut};
use noirwire_orderbook_engine::{Env, Incident, MarketMut, MarketRisk, KIND_PERP, ORDERS_PER_SIDE};

use crate::loader::{load, load_mut, Scope};
use crate::state::{BookData, Exchange, MarketData, PriceData};

/// RULES 10: receipts are SHA-256 as the runtime computes it.
pub(crate) fn sha256(data: &[u8]) -> [u8; 32] {
    solana_sha256_hasher::hash(data).to_bytes()
}

/// What the engine is told besides the accounts: the clock, the exchange's
/// settings, its USDC guard and the risk of every market it may value a
/// position on.
pub(crate) fn env<'a>(exchange: &Exchange, now: i64, markets: &'a [MarketRisk]) -> Env<'a> {
    Env {
        now,
        exchange_paused: exchange.paused,
        quote_ok: exchange.quote.passes(now),
        max_steps: u32::from(exchange.max_steps),
        markets,
        hash: sha256,
    }
}

/// One market's accounts, loaded and checked: its settings, its book and its
/// price feed.
pub(crate) struct MarketAccounts<'a> {
    market: RefMut<'a, MarketData>,
    book: RefMut<'a, BookData>,
    price: Ref<'a, PriceData>,
}

impl<'a> MarketAccounts<'a> {
    pub(crate) fn load(
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

    pub(crate) fn risk(&self) -> MarketRisk {
        MarketRisk::new(
            &self.market.params,
            &self.price.price,
            &self.book.book.header,
        )
    }

    pub(crate) fn is_perp(&self) -> bool {
        self.market.params.kind == KIND_PERP
    }

    /// RULES 9: the market's last price incident, kept after it ends.
    pub(crate) fn incident(&self) -> Incident {
        self.price.incident
    }

    /// The market as the engine sees it, each side cut to the market's capacity.
    pub(crate) fn as_engine(&mut self) -> MarketMut<'_> {
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

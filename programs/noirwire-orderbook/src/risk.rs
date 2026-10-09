use anchor_lang::prelude::*;
use noirwire_orderbook_engine::MarketRisk;

use crate::errors::OrderbookError;
use crate::loader::{load, Scope};
use crate::state::{BookData, Header, MarketData, PriceData, HEADER_LEN, MAX_MARKETS};

/// RULES 6: a cross-margin account is valued over every market it holds a
/// position on, so the caller passes the other markets as groups of three
/// accounts, market then book then price feed. Each group gets the same checks
/// as the market being traded; a market not supplied stays unknown to the
/// engine, which refuses to value a position on it rather than guess.
pub struct RiskTable {
    pub markets: [MarketRisk; MAX_MARKETS],
}

impl Default for RiskTable {
    fn default() -> Self {
        Self::new()
    }
}

impl RiskTable {
    pub fn new() -> Self {
        RiskTable {
            markets: [MarketRisk::NONE; MAX_MARKETS],
        }
    }

    fn slot(&mut self, market_id: u8) -> Result<&mut MarketRisk> {
        self.markets
            .get_mut(usize::from(market_id))
            .ok_or(OrderbookError::InvalidMarketParams.into())
    }

    pub fn set(&mut self, market_id: u8, risk: MarketRisk) -> Result<()> {
        let slot = self.slot(market_id)?;
        require!(*slot == MarketRisk::NONE, OrderbookError::DuplicateMarket);
        *slot = risk;
        Ok(())
    }

    /// Every perp market the exchange has must be in the table.
    pub fn require_all(&self, perp_markets: u8) -> Result<()> {
        for (market_id, risk) in self.markets.iter().enumerate() {
            let required = perp_markets & (1 << market_id) != 0;
            require!(
                !required || *risk != MarketRisk::NONE,
                OrderbookError::MarketDataMissing
            );
        }
        Ok(())
    }

    pub fn add_remaining(&mut self, remaining: &[AccountInfo]) -> Result<()> {
        require!(
            remaining.len() % 3 == 0,
            OrderbookError::MalformedRemainingAccounts
        );
        for group in remaining.chunks_exact(3) {
            let market_id = stated_market_id(&group[0])?;
            let scope = Scope::Market(market_id);
            let market = load::<MarketData>(&group[0], scope)?;
            let book = load::<BookData>(&group[1], scope)?;
            let price = load::<PriceData>(&group[2], scope)?;
            self.set(
                market_id,
                MarketRisk::new(&market.params, &price.price, &book.book.header),
            )?;
        }
        Ok(())
    }
}

/// The market id an account claims in its header, before the loader checks it
/// against the address.
pub fn stated_market_id(account: &AccountInfo) -> Result<u8> {
    let data = account.try_borrow_data()?;
    let bytes = data
        .get(..HEADER_LEN)
        .ok_or(OrderbookError::AccountMissing)?;
    let header: Header = *bytemuck::try_from_bytes(bytes).map_err(|_| OrderbookError::Unaligned)?;
    Ok(header.market_id)
}

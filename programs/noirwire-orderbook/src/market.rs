use anchor_lang::prelude::*;
use core::cell::{Ref, RefMut};
use noirwire_orderbook_engine::{
    Env, Incident, LiquidationGate, MarketMut, MarketRisk, KIND_PERP, ORDERS_PER_SIDE,
};

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
        MarketRisk {
            gate: self.gate(),
            ..MarketRisk::new(
                &self.market.params,
                &self.price.price,
                &self.book.book.header,
            )
        }
    }

    fn gate(&self) -> Option<LiquidationGate> {
        gate_of(&self.market, &self.price)
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

/// RULES 8 and 9b: what a liquidation, and a funding interval, on a market need Pyth to
/// confirm, when its mark is a primary price: Pyth's latest observation, kept in the
/// price feed's source record, the breaker's age and the liquidation band.
///
/// A market with no primary price follows Pyth alone and has none, with one exception: a
/// market whose primary price was taken away still holds the mark that price set, which
/// is stamped with the primary's time and not with the time of the Pyth observation
/// kept beside it. Until a `sync_price` has replaced it with a mark Pyth stamped, the
/// gate confirms nothing (a reference of zero), so the removal never leaves an
/// unconfirmed mark settling money. A market that has never read Pyth has no such
/// record, and none either.
pub fn gate_of(market: &MarketData, feed: &PriceData) -> Option<LiquidationGate> {
    if market.mark_feed_id().is_none() {
        let mark_is_not_pyths =
            feed.source.publish_time != 0 && feed.price.publish_time != feed.source.publish_time;
        return mark_is_not_pyths.then_some(LiquidationGate {
            reference: 0,
            published: 0,
            max_age: 0,
            band_bps: 0,
        });
    }
    Some(LiquidationGate {
        reference: feed.source.target,
        published: feed.source.publish_time,
        max_age: i64::from(market.breaker_age),
        band_bps: u16::from(market.liquidation_band),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytemuck::Zeroable;

    #[test]
    fn only_a_market_with_a_primary_price_has_a_gate_and_it_reads_pyths_record() {
        let mut market = MarketData::zeroed();
        let mut feed = PriceData::zeroed();
        feed.source.target = 80_000;
        feed.source.publish_time = 1_000;
        feed.price.publish_time = 1_000;
        assert_eq!(gate_of(&market, &feed), None);
        market.mark_feed = 6;
        market.breaker_age = 75;
        market.liquidation_band = 150;
        assert_eq!(
            gate_of(&market, &feed),
            Some(LiquidationGate {
                reference: 80_000,
                published: 1_000,
                max_age: 75,
                band_bps: 150,
            })
        );
    }

    #[test]
    fn a_market_whose_primary_was_removed_confirms_nothing_while_its_mark_is_not_pyths() {
        let market = MarketData::zeroed();
        let mut feed = PriceData::zeroed();
        feed.source.target = 80_000;
        feed.source.publish_time = 1_000;
        feed.price.price = 80_000;
        feed.price.publish_time = 1_000;
        assert_eq!(gate_of(&market, &feed), None, "Pyth stamped the mark");
        feed.price.publish_time = 1_004;
        let gate = gate_of(&market, &feed).expect("the primary's stamp");
        assert!(!gate.confirms(80_000, 1_004));
        assert!(!gate.confirms(80_000, 1_000));
        let mut never_read = PriceData::zeroed();
        never_read.price.price = 80_000;
        never_read.price.publish_time = 1_004;
        assert_eq!(gate_of(&market, &never_read), None, "a test network's mark");
    }

    #[test]
    fn a_market_that_never_read_pyth_has_a_gate_that_confirms_nothing() {
        let mut market = MarketData::zeroed();
        market.mark_feed = 6;
        market.breaker_age = 75;
        market.liquidation_band = 150;
        let gate = gate_of(&market, &PriceData::zeroed()).unwrap();
        assert!(!gate.confirms(80_000, 0));
        assert!(!gate.confirms(0, 0));
    }
}

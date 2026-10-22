use anchor_lang::prelude::*;
use noirwire_orderbook_engine::MarketRisk;

use crate::errors::OrderbookError;
use crate::loader::{load, load_market_ref, Scope};
use crate::state::{BookData, MarketData, PriceData, MAX_MARKETS};

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
            let (market_id, market) = load_market_ref::<MarketData>(&group[0])?;
            let scope = Scope::Market(market_id);
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

#[cfg(test)]
mod tests {
    use super::*;
    use bytemuck::Zeroable;
    use noirwire_orderbook_engine::{MarketParams, Price, KIND_PERP, KIND_SPOT};

    use crate::state::{Header, RollupAccount, HEADER_LEN, READY};

    /// One account as the runtime hands it to the program.
    struct Stored {
        key: Pubkey,
        owner: Pubkey,
        lamports: u64,
        data: Vec<u64>,
    }

    impl Stored {
        fn bytes(&mut self) -> &mut [u8] {
            bytemuck::cast_slice_mut(&mut self.data)
        }

        fn body<T: RollupAccount>(&mut self) -> &mut T {
            bytemuck::from_bytes_mut(&mut self.bytes()[HEADER_LEN..])
        }

        fn info(&mut self) -> AccountInfo<'_> {
            let Stored {
                key,
                owner,
                lamports,
                data,
            } = self;
            AccountInfo::new(
                key,
                false,
                false,
                lamports,
                bytemuck::cast_slice_mut(data),
                owner,
                false,
            )
        }
    }

    /// A ready account of kind `T` at its address in market `market_id`.
    fn ready<T: RollupAccount>(market_id: u8) -> Stored {
        let (key, bump) = Pubkey::find_program_address(&[T::SEED, &[market_id]], &crate::ID);
        let mut stored = Stored {
            key,
            owner: crate::ID,
            lamports: 0,
            data: vec![0; T::LEN / 8],
        };
        let header = Header {
            tag: T::TAG,
            ready: READY,
            market_id,
            bump,
            _padding: [0; 5],
        };
        stored.bytes()[..HEADER_LEN].copy_from_slice(bytemuck::bytes_of(&header));
        stored
    }

    /// A market's three accounts, market then book then price feed.
    fn triple(market_id: u8, kind: u8, mark: u64) -> Vec<Stored> {
        let mut market = ready::<MarketData>(market_id);
        market.body::<MarketData>().params = MarketParams {
            kind,
            market_id,
            im_bps: 1_000,
            mm_bps: 500,
            max_price_age: 60,
            max_age_liquidation: 60,
            ..MarketParams::zeroed()
        };
        let mut price = ready::<PriceData>(market_id);
        price.body::<PriceData>().price = Price {
            price: mark,
            publish_time: 1,
            accepted_at: 1,
        };
        vec![market, ready::<BookData>(market_id), price]
    }

    const PERP: u8 = 1;
    const SPOT: u8 = 0;
    const MARK: u64 = 150_000;

    fn loaded(accounts: &mut [Stored]) -> Result<RiskTable> {
        let infos: Vec<AccountInfo> = accounts.iter_mut().map(Stored::info).collect();
        let mut table = RiskTable::new();
        table.add_remaining(&infos)?;
        table.require_all(1 << PERP)?;
        Ok(table)
    }

    fn refusal(mut accounts: Vec<Stored>) -> Error {
        match loaded(&mut accounts) {
            Ok(_) => panic!("the risk accounts were accepted"),
            Err(error) => error,
        }
    }

    #[test]
    fn the_real_accounts_value_the_market_at_its_own_mark() {
        let mut accounts = triple(PERP, KIND_PERP, MARK);
        accounts.extend(triple(SPOT, KIND_SPOT, 1));
        let table = loaded(&mut accounts).unwrap();
        assert_eq!(table.markets[usize::from(PERP)].mark, MARK);
        assert!(table.markets[usize::from(PERP)].is_perp);
    }

    #[test]
    fn a_missing_or_repeated_market_is_refused() {
        let mut spot_only = triple(SPOT, KIND_SPOT, 1);
        assert_eq!(
            loaded(&mut spot_only).err(),
            Some(error!(OrderbookError::MarketDataMissing))
        );
        assert_eq!(
            loaded(&mut []).err(),
            Some(error!(OrderbookError::MarketDataMissing))
        );
        let mut twice = triple(PERP, KIND_PERP, MARK);
        twice.extend(triple(PERP, KIND_PERP, MARK));
        assert_eq!(refusal(twice), error!(OrderbookError::DuplicateMarket));
    }

    #[test]
    fn another_markets_feed_is_refused_in_a_triple() {
        let mut crossed = triple(PERP, KIND_PERP, MARK);
        crossed[2] = triple(SPOT, KIND_SPOT, MARK * 10).remove(2);
        assert_eq!(refusal(crossed), error!(OrderbookError::WrongDerivation));

        let mut crossed_book = triple(PERP, KIND_PERP, MARK);
        crossed_book[1] = triple(SPOT, KIND_SPOT, MARK).remove(1);
        assert_eq!(
            refusal(crossed_book),
            error!(OrderbookError::WrongDerivation)
        );
    }

    #[test]
    fn a_lookalike_feed_with_a_raised_mark_is_refused_wherever_it_lives() {
        let lookalike = |owner: Pubkey, key: Pubkey| {
            let mut accounts = triple(PERP, KIND_PERP, MARK);
            accounts[2].body::<PriceData>().price.price = MARK * 10;
            accounts[2].owner = owner;
            accounts[2].key = key;
            accounts
        };
        let feed = triple(PERP, KIND_PERP, MARK).remove(2).key;
        let elsewhere = Pubkey::new_unique();
        for owner in [anchor_lang::system_program::ID, Pubkey::new_unique()] {
            for key in [feed, elsewhere] {
                assert_eq!(
                    refusal(lookalike(owner, key)),
                    error!(OrderbookError::WrongOwner)
                );
            }
        }
        assert_eq!(
            refusal(lookalike(crate::ID, elsewhere)),
            error!(OrderbookError::WrongDerivation),
            "this program's own bytes at an address no seed derives"
        );
    }

    #[test]
    fn a_triple_out_of_order_or_short_is_refused() {
        let mut reversed = triple(PERP, KIND_PERP, MARK);
        reversed.reverse();
        assert_eq!(refusal(reversed), error!(OrderbookError::WrongKind));

        let mut short = triple(PERP, KIND_PERP, MARK);
        short.pop();
        assert_eq!(
            refusal(short),
            error!(OrderbookError::MalformedRemainingAccounts)
        );
    }

    #[test]
    fn a_market_that_is_not_ready_is_refused() {
        let mut unready = triple(PERP, KIND_PERP, MARK);
        unready[2].bytes()[8] = 0;
        assert_eq!(refusal(unready), error!(OrderbookError::NotReady));
    }
}

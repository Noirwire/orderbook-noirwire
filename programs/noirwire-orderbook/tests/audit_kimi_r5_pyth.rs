//! Audit, round 5: the Pyth account parser and the sync handlers from the
//! outside, through the public API only. Fixtures are synthetic `PriceUpdateV2`
//! accounts built byte by byte as `pyth.rs` documents the layout.

use anchor_lang::prelude::*;
use noirwire_orderbook::errors::OrderbookError;
use noirwire_orderbook::pyth::{
    self, PRICE_UPDATE_DISCRIMINATOR, PRICE_UPDATE_LEN, PUSH_ORACLE_ID, RECEIVER_ID, SHARD,
};

const EXPO: i32 = -8;
const FEED: [u8; 32] = [7; 32];

/// An account as the runtime hands it over: address, owning program and data.
struct Stored {
    key: Pubkey,
    owner: Pubkey,
    lamports: u64,
    data: Vec<u8>,
}

impl Stored {
    fn info(&mut self) -> AccountInfo<'_> {
        let Stored {
            key,
            owner,
            lamports,
            data,
        } = self;
        AccountInfo::new(key, false, false, lamports, data, owner, false)
    }
}

/// A fully verified `PriceUpdateV2` for `FEED`, as the push oracle would write it.
fn price_update(price: i64, conf: u64, publish_time: i64) -> Vec<u8> {
    let mut data = vec![0u8; PRICE_UPDATE_LEN];
    data[..8].copy_from_slice(&PRICE_UPDATE_DISCRIMINATOR);
    data[40] = 1; // verification level Full
    data[41..73].copy_from_slice(&FEED);
    data[73..81].copy_from_slice(&price.to_le_bytes());
    data[81..89].copy_from_slice(&conf.to_le_bytes());
    data[89..93].copy_from_slice(&EXPO.to_le_bytes());
    data[93..101].copy_from_slice(&publish_time.to_le_bytes());
    data
}

/// The account at `key` owned by `owner`, offered to `pyth::read` as the
/// market's bound source for `FEED`.
fn offer(key: Pubkey, owner: Pubkey, data: Vec<u8>) -> Result<Observation> {
    let mut stored = Stored {
        key,
        owner,
        lamports: 0,
        data,
    };
    pyth::read(&stored.info(), &pyth::feed_account(&FEED), &FEED, EXPO)
}

use noirwire_orderbook_engine::Observation;

fn refused(result: Result<Observation>, expected: OrderbookError) {
    assert_eq!(result.unwrap_err(), error!(expected));
}

/// R5-08: the push oracle derives one account per (shard, feed id). This
/// program only ever reads shard 0, but a real, receiver-owned, fully verified
/// account exists for every other shard: an attacker can hand `sync_price` the
/// shard-1 account of the same feed, holding a price the shard-0 account never
/// printed. If the shard is not pinned in the check, the mark follows it.
#[test]
fn r5_08_a_valid_account_for_another_shard_is_refused() {
    assert_eq!(SHARD, 0, "this test attacks the shard the program pins");
    let bound = pyth::feed_account(&FEED);
    let (other_shard, _) =
        Pubkey::find_program_address(&[&1u16.to_le_bytes(), &FEED], &PUSH_ORACLE_ID);
    assert_ne!(other_shard, bound, "setup: the shards must derive apart");

    let data = price_update(10_565_598_655, 2_539_594, 1_792_525_157);
    refused(
        offer(other_shard, RECEIVER_ID, data),
        OrderbookError::WrongPriceAccount,
    );
}

/// R5-09: the bound address alone is not enough. An attacker who could get a
/// payload under any program the address derivation does not exclude, most
/// interestingly the push oracle program itself (whose accounts the check might
/// be confused into trusting, since it is the derivation base), must still fail
/// the owner check: only the receiver's accounts are read.
#[test]
fn r5_09_a_forged_owner_is_refused_even_the_push_oracle_itself() {
    let bound = pyth::feed_account(&FEED);
    let data = || price_update(10_565_598_655, 2_539_594, 1_792_525_157);
    for owner in [
        PUSH_ORACLE_ID,
        anchor_lang::system_program::ID,
        pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        noirwire_orderbook::ID,
        Pubkey::new_unique(),
    ] {
        refused(
            offer(bound, owner, data()),
            OrderbookError::WrongPriceAccountOwner,
        );
    }
    // Control: the receiver's own account at the bound address reads fine.
    assert!(offer(bound, RECEIVER_ID, data()).is_ok());
}

mod sync_checks {
    use bytemuck::Zeroable;
    use noirwire_orderbook_engine::{
        check_quote, sync_source, EngineError, MarketParams, Observation, PriceFeed, QuoteRules,
        QuoteVerdict, SourceBinding, KIND_PERP,
    };

    const NOW: i64 = 1_000;

    fn feed() -> (PriceFeed, MarketParams) {
        let mut feed: PriceFeed = Zeroable::zeroed();
        feed.binding = SourceBinding {
            account: [9; 32],
            feed_id: [7; 32],
            expo: -8,
            max_conf_bps: 100,
            base_decimals: 9,
            quote_decimals: 6,
        };
        let params = MarketParams {
            tick: 100,
            base_lot: 1_000_000,
            min_size: 1,
            funding_interval: 60,
            max_price_age: 90,
            max_age_liquidation: 180,
            open_interest_cap: 1_000,
            settle_window: 900,
            position_cap: 1_000,
            band_bps: 400,
            im_bps: 1_000,
            mm_bps: 500,
            taker_fee_bps: 5,
            liq_penalty_bps: 200,
            funding_cap_bps: 100,
            max_move_bps: 250,
            min_publish_gap: 1,
            max_open_orders: 32,
            kind: KIND_PERP,
            ..Zeroable::zeroed()
        };
        (feed, params)
    }

    fn seen(price: i64, conf: u64, publish_time: i64) -> Observation {
        Observation {
            price,
            conf,
            publish_time,
        }
    }

    /// R5-10: what `sync_price` runs after the parser, checks 10 to 12 of
    /// RULES 9. A stamp ahead of the rollup clock would read as fresh
    /// everywhere else; one at or before the last accepted stamp could renew
    /// freshness or end an incident for free; one too old must never become
    /// the mark. Confidence exactly at `max_conf_bps` of the price is the
    /// documented edge; one atom wider must be refused.
    #[test]
    fn r5_10_future_backwards_stale_and_the_confidence_edge() {
        let (mut feed, mut params) = feed();
        assert_eq!(
            sync_source(&mut feed, &mut params, &seen(1_000_000, 0, NOW + 1), NOW),
            Err(EngineError::PriceFromTheFuture)
        );
        assert_eq!(
            sync_source(&mut feed, &mut params, &seen(1_000_000, 0, NOW - 91), NOW),
            Err(EngineError::PriceTooOld)
        );
        // The confidence edge: `conf * 10000 <= price * max_conf_bps`.
        assert_eq!(
            sync_source(&mut feed, &mut params, &seen(1_000_000, 10_001, NOW), NOW),
            Err(EngineError::PriceConfidenceTooWide)
        );
        sync_source(&mut feed, &mut params, &seen(1_000_000, 10_000, NOW), NOW).unwrap();
        assert_eq!(feed.price.price, 10);

        // A stamp equal to or before the last accepted one changes nothing.
        for publish_time in [NOW - 1, NOW] {
            let (mut feed, mut params) = (feed, params);
            assert_eq!(
                sync_source(
                    &mut feed,
                    &mut params,
                    &seen(1_000_000, 0, publish_time),
                    NOW + 5
                ),
                Err(EngineError::PriceTimeWentBackwards)
            );
        }
        assert_eq!(feed.price.publish_time, NOW);
    }

    /// R5-11: the USDC guard's own edges. An observation exactly `depeg_bps`
    /// from one dollar passes (the trip is strict); one atom further trips the
    /// guard. A repeat or older stamp is refused, so a tripped guard cannot be
    /// healed by replaying the last healthy print.
    #[test]
    fn r5_11_the_depeg_trip_is_strict_and_replays_are_refused() {
        let rules = QuoteRules {
            expo: -6,
            max_conf_bps: 100,
            depeg_bps: 200,
            max_age: 60,
        };
        let one = 1_000_000i64;
        let edge = check_quote(&rules, 0, &seen(one + 20_000, 0, NOW), NOW).unwrap();
        assert!(matches!(edge, QuoteVerdict::Healthy { .. }));
        let over = check_quote(&rules, 0, &seen(one + 20_001, 0, NOW), NOW).unwrap();
        assert_eq!(over, QuoteVerdict::Depegged);

        // After a healthy print at NOW, neither the same stamp nor an older
        // one is accepted again.
        for publish_time in [NOW - 1, NOW] {
            assert_eq!(
                check_quote(&rules, NOW, &seen(one, 0, publish_time), NOW + 5),
                Err(EngineError::PriceTimeWentBackwards)
            );
        }
        assert_eq!(
            check_quote(&rules, 0, &seen(one, 0, NOW + 1), NOW),
            Err(EngineError::PriceFromTheFuture)
        );
    }
}

mod token_accounts {
    use anchor_lang::prelude::*;
    use noirwire_orderbook::custody::{token_account, TOKEN_PROGRAM_ID};
    use noirwire_orderbook::errors::OrderbookError;

    const TOKEN_2022: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

    struct Stored {
        key: Pubkey,
        owner: Pubkey,
        lamports: u64,
        data: Vec<u8>,
    }

    impl Stored {
        fn info(&mut self) -> AccountInfo<'_> {
            let Stored {
                key,
                owner,
                lamports,
                data,
            } = self;
            AccountInfo::new(key, false, false, lamports, data, owner, false)
        }
    }

    fn account(owner: Pubkey, data: Vec<u8>) -> Stored {
        Stored {
            key: Pubkey::new_unique(),
            owner,
            lamports: 0,
            data,
        }
    }

    fn initialized(amount: u64) -> Vec<u8> {
        let mut data = vec![0u8; 165];
        data[64..72].copy_from_slice(&amount.to_le_bytes());
        data[108] = 1;
        data
    }

    /// R5-12: `deposit_tokens` trusts `token_account` twice: on the depositor's
    /// own account (before the CPI) and on custody after it, where the returned
    /// amount is what the custody cap is compared against. A parse that read a
    /// short, uninitialised, frozen or token-2022 account as a holding would
    /// let a forged custody understate its balance and beat the cap.
    #[test]
    fn r5_12_only_a_live_spl_token_account_reads_as_a_holding() {
        let short = &mut account(TOKEN_PROGRAM_ID, initialized(7)[..164].to_vec());
        assert_eq!(
            token_account(&short.info()).err(),
            Some(error!(OrderbookError::TokenAccountUninitialised))
        );
        for state in [0u8, 2, 3, 255] {
            let mut data = initialized(7);
            data[108] = state;
            let stored = &mut account(TOKEN_PROGRAM_ID, data);
            assert_eq!(
                token_account(&stored.info()).err(),
                Some(error!(OrderbookError::TokenAccountUninitialised)),
                "state byte {state} read as a holding"
            );
        }
        let wrong_owner = &mut account(TOKEN_2022, initialized(7));
        assert_eq!(
            token_account(&wrong_owner.info()).err(),
            Some(error!(OrderbookError::WrongTokenProgram))
        );
        // The amount the cap check uses is the account's whole balance.
        let live = &mut account(TOKEN_PROGRAM_ID, initialized(u64::MAX));
        assert_eq!(token_account(&live.info()).unwrap().amount, u64::MAX);
    }
}

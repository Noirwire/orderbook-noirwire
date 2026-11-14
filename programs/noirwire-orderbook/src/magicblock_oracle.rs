//! RULES 9: the price account this program reads, a `PriceUpdateV3` that MagicBlock's
//! price oracle keeps inside the rollup, one account per feed.
//!
//! It is read by hand, byte by byte and bounds-checked, never cast to a struct.
//! Little-endian:
//!
//! | Bytes      | Field                                                     |
//! | ---------- | --------------------------------------------------------- |
//! | `0..8`     | the account's discriminator                               |
//! | `8..40`    | write authority, all zero in the live account, not read   |
//! | `40`       | verification level, 1 is Full                             |
//! | `41..73`   | feed id, the account's own address                        |
//! | `73..81`   | price, i64                                                |
//! | `81..89`   | confidence, always zero, not read                         |
//! | `89..93`   | exponent, stored as `+8`                                  |
//! | `93..101`  | publish time, i64, whole seconds                          |
//! | `101..133` | previous publish time, EMA price and confidence, posted slot; not read |
//! | `133`      | unused, any value                                         |
//!
//! The exponent is the number of decimals, positive, so it is accepted only as `+8` and
//! only against a binding whose exponent is `-8`. The confidence is zero for every
//! price, so it is never read and no check is made on it.
//!
//! The program checks the account's address, its owner and its bytes, not who signed
//! the update that wrote them: the oracle's own key does, and nothing here can tell
//! one of its prices from a bad one. See `SECURITY.md`.

use anchor_lang::prelude::*;
use noirwire_orderbook_engine::Observation;

use crate::errors::OrderbookError;

/// The account's allocated size.
pub const PRICE_UPDATE_LEN: usize = 134;

/// MagicBlock's price oracle program, owner of every price account inside the rollup.
pub const ORACLE_ID: Pubkey = pubkey!("PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd");
/// The first seed of a feed's account address.
pub const SEED_PREFIX: &[u8] = b"price_feed";
/// The second: the provider whose prices the oracle republishes.
pub const PROVIDER: &[u8] = b"pyth-lazer";

/// The first eight bytes of SHA-256 of `account:PriceUpdateV3`.
pub const PRICE_UPDATE_DISCRIMINATOR: [u8; 8] = [234, 161, 14, 36, 172, 239, 15, 232];
/// What the account's exponent field holds for a price of eight decimals.
pub const STORED_DECIMALS: i32 = 8;
const FULL: u8 = 1;
const VERIFICATION_AT: usize = 40;
const FEED_ID_AT: usize = 41;
const PRICE_AT: usize = 73;
const EXPO_AT: usize = 89;
const PUBLISH_TIME_AT: usize = 93;

/// The oracle's account for feed number `feed`, the only account a market or the USDC
/// guard binds to. The feed number is the provider's, written in decimal as the third
/// seed: SOL/USD is 6 and USDC/USD is 7.
pub fn feed_account(feed: u32) -> Pubkey {
    let number = feed.to_string();
    Pubkey::find_program_address(&[SEED_PREFIX, PROVIDER, number.as_bytes()], &ORACLE_ID).0
}

/// RULES 9, checks 1 to 7: the bound address, the oracle program as owner, then the
/// account's own bytes. Each refusal is an error, so nothing about a wrong account is
/// ever written. `expo` is the binding's: the price is `price * 10^expo` USD.
pub fn read(account: &AccountInfo, bound: &Pubkey, expo: i32) -> Result<Observation> {
    let data = account.try_borrow_data()?;
    checked(account.key, account.owner, &data, bound, expo)
}

fn checked(
    key: &Pubkey,
    owner: &Pubkey,
    data: &[u8],
    bound: &Pubkey,
    expo: i32,
) -> Result<Observation> {
    require_keys_eq!(*key, *bound, OrderbookError::WrongPriceAccount);
    require_keys_eq!(*owner, ORACLE_ID, OrderbookError::WrongPriceAccountOwner);
    parse(data, key, expo)
}

/// Checks 3 to 7: the size, the discriminator, full verification, the feed and the exponent. The price and
/// publish time are the engine's to judge. The confidence is not read.
fn parse(data: &[u8], own_address: &Pubkey, expo: i32) -> Result<Observation> {
    require!(
        data.len() == PRICE_UPDATE_LEN,
        OrderbookError::WrongPriceAccountSize
    );
    require!(
        bytes::<8>(data, 0)? == PRICE_UPDATE_DISCRIMINATOR,
        OrderbookError::WrongPriceAccountKind
    );
    require!(
        bytes::<1>(data, VERIFICATION_AT)? == [FULL],
        OrderbookError::PriceNotFullyVerified
    );
    require!(
        bytes::<32>(data, FEED_ID_AT)? == own_address.to_bytes(),
        OrderbookError::WrongPriceFeed
    );
    require!(
        i32::from_le_bytes(bytes(data, EXPO_AT)?) == STORED_DECIMALS && expo == -STORED_DECIMALS,
        OrderbookError::WrongPriceExponent
    );
    Ok(Observation {
        price: i64::from_le_bytes(bytes(data, PRICE_AT)?),
        publish_time: i64::from_le_bytes(bytes(data, PUBLISH_TIME_AT)?),
    })
}

fn bytes<const N: usize>(data: &[u8], at: usize) -> Result<[u8; N]> {
    at.checked_add(N)
        .and_then(|end| data.get(at..end))
        .and_then(|slice| slice.try_into().ok())
        .ok_or_else(|| error!(OrderbookError::WrongPriceAccountSize))
}

#[cfg(test)]
mod tests {
    //! The fixture is the mainnet SOL/USD account as the rollup served it, read with
    //! one `getAccountInfo`: slot 437,332,565 of `mainnet-tee.magicblock.app`. Its
    //! layout is `PriceUpdateV3` in magicblock-labs/real-time-pricing-oracle
    //! (`program/ephemeral-oracle/programs/ephemeral-oracle/src/lib.rs`).

    use super::*;
    use noirwire_orderbook_engine::{
        sync_source, EngineError, MarketParams, PriceFeed, SourceBinding, KIND_PERP,
    };

    const SOL: [u8; PRICE_UPDATE_LEN] = [
        234, 161, 14, 36, 172, 239, 15, 232, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 198, 173, 62, 132, 29, 156, 15, 36, 138, 223,
        249, 12, 247, 118, 248, 57, 253, 89, 241, 203, 216, 255, 188, 143, 148, 2, 136, 62, 161,
        110, 132, 32, 223, 150, 2, 221, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 0, 0, 0, 200, 78,
        247, 106, 0, 0, 0, 0, 200, 78, 247, 106, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 85, 42, 17, 26, 0, 0, 0, 0, 0,
    ];

    const SOL_ACCOUNT: Pubkey = pubkey!("ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu");
    const USDC_ACCOUNT: Pubkey = pubkey!("Ekug3x6hs37Mf4XKCDptvRVCSCjJCAD7LKmKQXBAa541");
    const EXPO: i32 = -8;

    fn sol(data: &[u8]) -> Result<Observation> {
        checked(&SOL_ACCOUNT, &ORACLE_ID, data, &SOL_ACCOUNT, EXPO)
    }

    fn refused(result: Result<Observation>, expected: OrderbookError) {
        assert_eq!(result.unwrap_err(), error!(expected));
    }

    #[test]
    fn the_sol_fixture_reads_as_the_rollup_served_it() {
        assert_eq!(
            sol(&SOL).unwrap(),
            Observation {
                price: 8_002_901_727,
                publish_time: 1_794_592_456,
            }
        );
    }

    #[test]
    fn each_feeds_account_is_the_oracles_address_for_its_number() {
        assert_eq!(feed_account(6), SOL_ACCOUNT);
        assert_eq!(feed_account(7), USDC_ACCOUNT);
    }

    #[test]
    fn the_discriminator_leads_the_fixture_and_the_feed_id_is_the_accounts_address() {
        assert_eq!(SOL[..8], PRICE_UPDATE_DISCRIMINATOR);
        assert_eq!(SOL[FEED_ID_AT..FEED_ID_AT + 32], SOL_ACCOUNT.to_bytes());
        assert_eq!(SOL.len(), PRICE_UPDATE_LEN);
    }

    #[test]
    fn the_confidence_field_is_never_read() {
        let mut wide = SOL;
        wide[81..89].copy_from_slice(&u64::MAX.to_le_bytes());
        assert_eq!(sol(&wide).unwrap(), sol(&SOL).unwrap());
    }

    #[test]
    fn the_unused_write_authority_and_last_byte_may_hold_anything() {
        let mut other = SOL;
        other[8..40].fill(7);
        other[133] = 0xff;
        assert_eq!(sol(&other).unwrap(), sol(&SOL).unwrap());
    }

    #[test]
    fn an_account_of_any_other_size_is_refused() {
        refused(
            sol(&SOL[..PRICE_UPDATE_LEN - 1]),
            OrderbookError::WrongPriceAccountSize,
        );
        let mut longer = SOL.to_vec();
        longer.push(0);
        refused(sol(&longer), OrderbookError::WrongPriceAccountSize);
        refused(sol(&[]), OrderbookError::WrongPriceAccountSize);
    }

    #[test]
    fn another_discriminator_is_refused() {
        let mut other = SOL;
        other[0] ^= 1;
        refused(sol(&other), OrderbookError::WrongPriceAccountKind);
        let mut zeroed = SOL;
        zeroed[..8].fill(0);
        refused(sol(&zeroed), OrderbookError::WrongPriceAccountKind);
    }

    #[test]
    fn an_update_that_is_not_fully_verified_is_refused() {
        for level in [0u8, 2, 255] {
            let mut other = SOL;
            other[VERIFICATION_AT] = level;
            refused(sol(&other), OrderbookError::PriceNotFullyVerified);
        }
    }

    #[test]
    fn the_bound_address_owner_and_feed_are_each_checked() {
        refused(
            checked(&USDC_ACCOUNT, &ORACLE_ID, &SOL, &SOL_ACCOUNT, EXPO),
            OrderbookError::WrongPriceAccount,
        );
        refused(
            checked(&Pubkey::new_unique(), &ORACLE_ID, &SOL, &SOL_ACCOUNT, EXPO),
            OrderbookError::WrongPriceAccount,
        );
        for owner in [Pubkey::new_unique(), anchor_lang::system_program::ID] {
            refused(
                checked(&SOL_ACCOUNT, &owner, &SOL, &SOL_ACCOUNT, EXPO),
                OrderbookError::WrongPriceAccountOwner,
            );
        }
        let mut other_feed = SOL;
        other_feed[FEED_ID_AT] ^= 1;
        refused(sol(&other_feed), OrderbookError::WrongPriceFeed);
        let mut usdc_feed = SOL;
        usdc_feed[FEED_ID_AT..FEED_ID_AT + 32].copy_from_slice(&USDC_ACCOUNT.to_bytes());
        refused(sol(&usdc_feed), OrderbookError::WrongPriceFeed);
    }

    #[test]
    fn only_a_stored_plus_eight_against_a_binding_of_minus_eight_is_read() {
        for stored in [-8i32, 0, 7, 9, i32::MIN, i32::MAX] {
            let mut other = SOL;
            other[EXPO_AT..EXPO_AT + 4].copy_from_slice(&stored.to_le_bytes());
            refused(sol(&other), OrderbookError::WrongPriceExponent);
        }
        for binding in [8i32, 0, -7, -9, i32::MIN] {
            refused(
                checked(&SOL_ACCOUNT, &ORACLE_ID, &SOL, &SOL_ACCOUNT, binding),
                OrderbookError::WrongPriceExponent,
            );
        }
    }

    fn sol_feed() -> (PriceFeed, MarketParams) {
        let mut feed: PriceFeed = bytemuck::Zeroable::zeroed();
        feed.binding = SourceBinding {
            account: SOL_ACCOUNT.to_bytes(),
            feed: 6,
            expo: EXPO,
            base_decimals: 9,
            quote_decimals: 6,
            ..bytemuck::Zeroable::zeroed()
        };
        let params = MarketParams {
            tick: 100,
            base_lot: 1_000_000,
            min_size: 1,
            funding_interval: 60,
            max_price_age: 90,
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
            ..bytemuck::Zeroable::zeroed()
        };
        (feed, params)
    }

    #[test]
    fn the_sol_fixture_becomes_a_first_mark_of_80_029_atoms_per_lot() {
        let (mut feed, mut params) = sol_feed();
        let observed = sol(&SOL).unwrap();
        let now = observed.publish_time + 1;
        sync_source(&mut feed, &mut params, &observed, now).unwrap();
        assert_eq!(feed.price.price, 80_029);
        assert_eq!(feed.price.publish_time, observed.publish_time);
        assert_eq!(feed.source.raw_price, observed.price);
    }

    #[test]
    fn a_stale_account_that_reads_fine_is_refused_by_the_engine() {
        let (mut feed, mut params) = sol_feed();
        let observed = sol(&SOL).unwrap();
        let late = observed.publish_time + params.max_price_age + 1;
        assert_eq!(
            sync_source(&mut feed, &mut params, &observed, late),
            Err(EngineError::PriceTooOld)
        );
        assert_eq!(feed.price.price, 0);
        assert_eq!(feed.source.publish_time, 0);
    }
}

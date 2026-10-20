//! RULES 9: the one price account this program reads, a Pyth receiver
//! `PriceUpdateV2` that the Pyth push oracle keeps at a fixed address per feed.
//!
//! It is read by hand, byte by byte and bounds-checked, never cast to a struct.
//! With full verification the account holds, little-endian:
//!
//! | Bytes      | Field                           |
//! | ---------- | ------------------------------- |
//! | `0..8`     | the account's discriminator     |
//! | `8..40`    | write authority, not read       |
//! | `40`       | verification level, 1 is Full   |
//! | `41..73`   | feed id                         |
//! | `73..81`   | price, i64                      |
//! | `81..89`   | confidence, u64                 |
//! | `89..93`   | exponent, i32                   |
//! | `93..101`  | publish time, i64               |
//! | `101..133` | previous publish time, EMA price and confidence, posted slot; not read |
//! | `133`      | unused, any value               |
//!
//! A Partial update carries a signature count at byte 41, which moves every
//! later field, so the level is checked before any of them is read.

use anchor_lang::prelude::*;
use noirwire_orderbook_engine::Observation;

use crate::errors::OrderbookError;

/// The Pyth receiver program, owner of every price update account.
pub const RECEIVER_ID: Pubkey = pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
/// The Pyth push oracle, whose address derivation fixes each feed's account.
pub const PUSH_ORACLE_ID: Pubkey = pubkey!("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT");
/// The push oracle's shard this program reads.
pub const SHARD: u16 = 0;

/// The account's allocated size. The serialized update is one byte shorter.
pub const PRICE_UPDATE_LEN: usize = 134;
/// The first eight bytes of SHA-256 of `account:PriceUpdateV2`.
pub const PRICE_UPDATE_DISCRIMINATOR: [u8; 8] = [34, 241, 35, 99, 157, 126, 244, 205];
const FULL: u8 = 1;
const VERIFICATION_AT: usize = 40;
const FEED_ID_AT: usize = 41;
const PRICE_AT: usize = 73;
const CONF_AT: usize = 81;
const EXPO_AT: usize = 89;
const PUBLISH_TIME_AT: usize = 93;

/// The push oracle's account for `feed_id`, the only account a source binds to.
pub fn feed_account(feed_id: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(&[&SHARD.to_le_bytes(), feed_id], &PUSH_ORACLE_ID).0
}

/// RULES 9, checks 1 to 7, on the account a crank names: the bound address, the
/// receiver as owner, then the update's own bytes. Each refusal is an error, so
/// nothing about a wrong account is ever written.
pub fn read(
    account: &AccountInfo,
    bound: &Pubkey,
    feed_id: &[u8; 32],
    expo: i32,
) -> Result<Observation> {
    let data = account.try_borrow_data()?;
    checked(account.key, account.owner, &data, bound, feed_id, expo)
}

fn checked(
    key: &Pubkey,
    owner: &Pubkey,
    data: &[u8],
    bound: &Pubkey,
    feed_id: &[u8; 32],
    expo: i32,
) -> Result<Observation> {
    require_keys_eq!(*key, *bound, OrderbookError::WrongPriceAccount);
    require_keys_eq!(*owner, RECEIVER_ID, OrderbookError::WrongPriceAccountOwner);
    parse(data, feed_id, expo)
}

/// Checks 3 to 7: the size, the discriminator, full verification, the feed and
/// the exponent. The price, confidence and publish time are the engine's to judge.
fn parse(data: &[u8], feed_id: &[u8; 32], expo: i32) -> Result<Observation> {
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
        bytes::<32>(data, FEED_ID_AT)? == *feed_id,
        OrderbookError::WrongPriceFeed
    );
    require!(
        i32::from_le_bytes(bytes(data, EXPO_AT)?) == expo,
        OrderbookError::WrongPriceExponent
    );
    Ok(Observation {
        price: i64::from_le_bytes(bytes(data, PRICE_AT)?),
        conf: u64::from_le_bytes(bytes(data, CONF_AT)?),
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
    //! The fixtures are the two mainnet accounts as read at the slots below, laid
    //! out as `pyth_solana_receiver_sdk/src/price_update.rs` defines them at
    //! pyth-network/pyth-crosschain 4099cb15d0943e603bdc6ad12aecbd2b6eb0f2c0.

    use super::*;
    use noirwire_orderbook_engine::{
        sync_source, EngineError, MarketParams, PriceFeed, SourceBinding, KIND_PERP,
    };

    /// SOL/USD, `7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE` at slot 459,349,107.
    const SOL: [u8; PRICE_UPDATE_LEN] = [
        34, 241, 35, 99, 157, 126, 244, 205, 96, 49, 71, 4, 52, 13, 237, 223, 55, 31, 212, 36, 114,
        20, 143, 36, 142, 157, 26, 109, 26, 94, 178, 172, 58, 205, 139, 127, 213, 214, 178, 67, 1,
        239, 13, 139, 111, 218, 44, 235, 164, 29, 161, 93, 64, 149, 209, 218, 57, 42, 13, 47, 142,
        208, 198, 199, 188, 15, 76, 250, 200, 194, 128, 181, 109, 191, 61, 194, 117, 2, 0, 0, 0,
        74, 192, 38, 0, 0, 0, 0, 0, 248, 255, 255, 255, 101, 195, 215, 106, 0, 0, 0, 0, 100, 195,
        215, 106, 0, 0, 0, 0, 104, 238, 203, 118, 2, 0, 0, 0, 117, 202, 48, 0, 0, 0, 0, 0, 47, 28,
        97, 27, 0, 0, 0, 0, 0,
    ];

    /// USDC/USD, `Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX` at slot 459,349,108.
    const USDC: [u8; PRICE_UPDATE_LEN] = [
        34, 241, 35, 99, 157, 126, 244, 205, 190, 147, 154, 131, 9, 245, 100, 7, 24, 127, 255, 48,
        172, 84, 177, 105, 73, 139, 233, 159, 109, 142, 27, 253, 66, 68, 104, 12, 212, 247, 209,
        226, 1, 234, 160, 32, 198, 28, 196, 121, 113, 40, 19, 70, 28, 225, 83, 137, 74, 150, 166,
        192, 11, 33, 237, 12, 252, 39, 152, 209, 249, 169, 233, 201, 74, 109, 146, 245, 5, 0, 0, 0,
        0, 237, 35, 0, 0, 0, 0, 0, 0, 248, 255, 255, 255, 90, 195, 215, 106, 0, 0, 0, 0, 89, 195,
        215, 106, 0, 0, 0, 0, 156, 153, 245, 5, 0, 0, 0, 0, 65, 26, 0, 0, 0, 0, 0, 0, 252, 27, 97,
        27, 0, 0, 0, 0, 0,
    ];

    const SOL_ACCOUNT: Pubkey = pubkey!("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
    const USDC_ACCOUNT: Pubkey = pubkey!("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX");
    const EXPO: i32 = -8;

    fn feed_id(fixture: &[u8; PRICE_UPDATE_LEN]) -> [u8; 32] {
        fixture[FEED_ID_AT..FEED_ID_AT + 32].try_into().unwrap()
    }

    fn sol(data: &[u8]) -> Result<Observation> {
        checked(
            &SOL_ACCOUNT,
            &RECEIVER_ID,
            data,
            &SOL_ACCOUNT,
            &feed_id(&SOL),
            EXPO,
        )
    }

    fn refused(result: Result<Observation>, expected: OrderbookError) {
        assert_eq!(result.unwrap_err(), error!(expected));
    }

    #[test]
    fn the_sol_and_usdc_fixtures_read_as_published() {
        assert_eq!(
            sol(&SOL).unwrap(),
            Observation {
                price: 10_565_598_655,
                conf: 2_539_594,
                publish_time: 1_792_525_157,
            }
        );
        let usdc = checked(
            &USDC_ACCOUNT,
            &RECEIVER_ID,
            &USDC,
            &USDC_ACCOUNT,
            &feed_id(&USDC),
            EXPO,
        );
        assert_eq!(
            usdc.unwrap(),
            Observation {
                price: 99_979_885,
                conf: 9_197,
                publish_time: 1_792_525_146,
            }
        );
    }

    #[test]
    fn each_feed_account_is_the_push_oracles_address_for_its_feed_id() {
        assert_eq!(feed_account(&feed_id(&SOL)), SOL_ACCOUNT);
        assert_eq!(feed_account(&feed_id(&USDC)), USDC_ACCOUNT);
    }

    #[test]
    fn the_unchecked_write_authority_of_a_push_feed_is_the_account_itself() {
        assert_eq!(SOL[8..40], SOL_ACCOUNT.to_bytes());
        assert_eq!(USDC[8..40], USDC_ACCOUNT.to_bytes());
        let mut other_authority = SOL;
        other_authority[8..40].fill(7);
        assert!(sol(&other_authority).is_ok(), "it is not part of the check");
    }

    #[test]
    fn the_unused_last_byte_may_hold_anything() {
        let mut tail = SOL;
        tail[133] = 0xff;
        assert_eq!(sol(&tail).unwrap(), sol(&SOL).unwrap());
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
    }

    #[test]
    fn a_partial_update_is_refused_before_its_shifted_fields_are_read() {
        let mut partial = SOL;
        partial[VERIFICATION_AT] = 0;
        refused(sol(&partial), OrderbookError::PriceNotFullyVerified);
        let mut misleading = [0u8; PRICE_UPDATE_LEN];
        misleading[..VERIFICATION_AT].copy_from_slice(&SOL[..VERIFICATION_AT]);
        misleading[VERIFICATION_AT] = 0;
        misleading[VERIFICATION_AT + 1] = 13;
        misleading[FEED_ID_AT + 1..].copy_from_slice(&SOL[FEED_ID_AT..PRICE_UPDATE_LEN - 1]);
        refused(sol(&misleading), OrderbookError::PriceNotFullyVerified);
        let mut unknown = SOL;
        unknown[VERIFICATION_AT] = 2;
        refused(sol(&unknown), OrderbookError::PriceNotFullyVerified);
    }

    #[test]
    fn the_bound_address_owner_feed_and_exponent_are_each_checked() {
        refused(
            checked(
                &USDC_ACCOUNT,
                &RECEIVER_ID,
                &SOL,
                &SOL_ACCOUNT,
                &feed_id(&SOL),
                EXPO,
            ),
            OrderbookError::WrongPriceAccount,
        );
        let lookalike = Pubkey::new_unique();
        refused(
            checked(
                &lookalike,
                &RECEIVER_ID,
                &SOL,
                &SOL_ACCOUNT,
                &feed_id(&SOL),
                EXPO,
            ),
            OrderbookError::WrongPriceAccount,
        );
        refused(
            checked(
                &SOL_ACCOUNT,
                &Pubkey::new_unique(),
                &SOL,
                &SOL_ACCOUNT,
                &feed_id(&SOL),
                EXPO,
            ),
            OrderbookError::WrongPriceAccountOwner,
        );
        refused(
            checked(
                &SOL_ACCOUNT,
                &RECEIVER_ID,
                &USDC,
                &SOL_ACCOUNT,
                &feed_id(&SOL),
                EXPO,
            ),
            OrderbookError::WrongPriceFeed,
        );
        refused(
            checked(
                &SOL_ACCOUNT,
                &RECEIVER_ID,
                &SOL,
                &SOL_ACCOUNT,
                &feed_id(&SOL),
                -9,
            ),
            OrderbookError::WrongPriceExponent,
        );
    }

    fn sol_feed() -> (PriceFeed, MarketParams) {
        let mut feed: PriceFeed = bytemuck::Zeroable::zeroed();
        feed.binding = SourceBinding {
            account: SOL_ACCOUNT.to_bytes(),
            feed_id: feed_id(&SOL),
            expo: EXPO,
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
            ..bytemuck::Zeroable::zeroed()
        };
        (feed, params)
    }

    #[test]
    fn the_sol_fixture_becomes_a_first_mark_of_105_655_atoms_per_lot() {
        let (mut feed, mut params) = sol_feed();
        let observed = sol(&SOL).unwrap();
        sync_source(&mut feed, &mut params, &observed, 1_792_525_160).unwrap();
        assert_eq!(feed.price.price, 105_655);
        assert_eq!(feed.price.publish_time, 1_792_525_157);
    }

    #[test]
    fn a_price_of_zero_or_below_parses_and_the_engine_refuses_it() {
        for price in [0i64, -1, i64::MIN] {
            let mut negative = SOL;
            negative[PRICE_AT..PRICE_AT + 8].copy_from_slice(&price.to_le_bytes());
            let observed = sol(&negative).unwrap();
            assert_eq!(observed.price, price);
            let (mut feed, mut params) = sol_feed();
            assert_eq!(
                sync_source(&mut feed, &mut params, &observed, 1_792_525_160),
                Err(EngineError::ZeroPrice)
            );
        }
    }
}

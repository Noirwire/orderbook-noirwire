//! Round 4, accounts lens. The program's risk table treats a slot equal to
//! `MarketRisk::NONE` as "not supplied": `RiskTable::require_all` refuses a perp
//! market whose slot is still `NONE`, and `RiskTable::set` refuses a second
//! entry only when the slot is no longer `NONE`. These tests pin what that
//! sentinel can and cannot collide with.

use bytemuck::Zeroable;
use noirwire_orderbook_engine::{
    BookHeader, MarketParams, MarketRisk, Price, KIND_PERP, KIND_SPOT, ORACLE_HEALTHY,
};

fn params(kind: u8) -> MarketParams {
    MarketParams {
        kind,
        oracle_health: ORACLE_HEALTHY,
        ..MarketParams::zeroed()
    }
}

#[test]
fn a_perp_with_no_mark_and_zeroed_settings_is_never_mistaken_for_a_missing_market() {
    let risk = MarketRisk::new(&params(KIND_PERP), &Price::zeroed(), &BookHeader::zeroed());
    assert_ne!(
        risk,
        MarketRisk::NONE,
        "a perp just rebound by set_price_source (mark 0) still counts as supplied"
    );
    assert!(risk.is_perp);
}

#[test]
fn only_a_spot_market_with_nothing_set_can_equal_the_sentinel() {
    let bare_spot = MarketRisk::new(&params(KIND_SPOT), &Price::zeroed(), &BookHeader::zeroed());
    assert_eq!(
        bare_spot,
        MarketRisk::NONE,
        "such a slot can be set twice without DuplicateMarket, which is harmless: \
         both entries come from the same derived accounts, and a spot slot moves no margin"
    );
    let priced_spot = MarketRisk::new(
        &params(KIND_SPOT),
        &Price {
            price: 1,
            publish_time: 1,
            accepted_at: 1,
        },
        &BookHeader::zeroed(),
    );
    assert_ne!(priced_spot, MarketRisk::NONE);
}

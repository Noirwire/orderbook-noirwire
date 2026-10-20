mod common;

use common::*;
use noirwire_orderbook_engine::*;

#[test]
fn engine_check_accepts_max_age_liquidation_of_i64_max() {
    let mut params = perp_params(0);
    params.max_age_liquidation = i64::MAX;
    assert!(params.check().is_ok());
}

#[test]
fn a_ten_day_old_mark_is_fresh_for_liquidation_under_i64_max() {
    let mut params = perp_params(0);
    params.max_age_liquidation = i64::MAX;
    let price = Price {
        price: MARK,
        publish_time: START,
        accepted_at: START,
    };
    let book = bytemuck::Zeroable::zeroed();
    let risk = MarketRisk::new(&params, &price, &book);
    let ten_days = START + 10 * 86_400;
    assert!(!risk.is_fresh(ten_days));
    assert!(risk.is_fresh_for_liquidation(ten_days));
    assert!(risk.is_fresh_for_liquidation(i64::MAX));
}

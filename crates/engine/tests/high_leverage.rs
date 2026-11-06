//! RULES 12 at 100x: a perp with 1% initial margin and half of it as maintenance is a
//! valid market, and the price-move limit it allows is exactly the one `funding_fits`
//! computes.

mod common;

use common::*;
use noirwire_orderbook_engine::EngineError as E;
use noirwire_orderbook_engine::*;

fn hundred_x() -> MarketParams {
    let mut params = perp_params(1);
    params.funding_interval = 60;
    params.im_bps = 100;
    params.mm_bps = 50;
    params.liq_penalty_bps = 10;
    params.taker_fee_bps = 5;
    params.band_bps = 40;
    params.funding_cap_bps = 50;
    params.max_move_bps = 39;
    params.max_price_age = 30;
    params.max_age_liquidation = 60;
    params
}

#[test]
fn a_thirty_second_mark_age_with_a_sixty_second_liquidation_age_is_accepted() {
    assert!(hundred_x().check().is_ok());
}

#[test]
fn a_liquidation_age_shorter_than_the_mark_age_is_refused() {
    let mut params = hundred_x();
    params.max_age_liquidation = 29;
    assert_eq!(params.check(), Err(E::InvalidMarketParams));
}

#[test]
fn one_percent_initial_margin_with_a_39_bps_move_limit_is_accepted() {
    assert!(hundred_x().check().is_ok());
}

#[test]
fn a_move_limit_of_40_bps_is_refused_at_one_percent_initial_margin() {
    let mut params = hundred_x();
    params.max_move_bps = 40;
    assert_eq!(params.check(), Err(E::InvalidMarketParams));
}

#[test]
fn the_move_limit_stays_the_widest_one_even_with_funding_off() {
    let mut params = hundred_x();
    params.funding_cap_bps = 0;
    params.max_move_bps = 39;
    assert!(params.check().is_ok());
    params.max_move_bps = 40;
    assert_eq!(params.check(), Err(E::InvalidMarketParams));
}

#[test]
fn a_band_wider_than_the_gap_between_the_margins_is_refused() {
    let mut params = hundred_x();
    params.band_bps = 50;
    assert!(params.check().is_ok());
    params.band_bps = 51;
    assert_eq!(params.check(), Err(E::InvalidMarketParams));
}

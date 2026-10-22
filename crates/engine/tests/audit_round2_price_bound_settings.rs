//! RULES 9 and 12: no feed accepts a price above `MAX_PRICE` and no market an open
//! interest cap above `MAX_OPEN_INTEREST_CAP`. Without those bounds an admin's reset,
//! or enough publishes under extreme settings, could push `size * mark * bps` past 128
//! bits: the position could then not be liquidated and nobody holding it could
//! withdraw. At the bounds the widest margin arithmetic still fits.

mod common;

use common::*;
use noirwire_orderbook_engine::EngineError as E;
use noirwire_orderbook_engine::*;

fn funded(w: &mut World, collateral: u64) -> u32 {
    let seat = w.open();
    w.deposit(seat, Asset::Collateral, collateral).unwrap();
    seat
}

/// The loosest margins RULES 12 allows: a position must be paid for in full.
fn extreme_params(market_id: u8) -> MarketParams {
    let mut params = perp_params(market_id);
    params.im_bps = 10_000;
    params.mm_bps = 9_999;
    params.liq_penalty_bps = 1;
    params.taker_fee_bps = 1;
    params.band_bps = 1;
    params.funding_cap_bps = 1;
    params.max_move_bps = 9_000;
    params.open_interest_cap = MAX_OPEN_INTEREST_CAP;
    params.check().unwrap();
    params
}

#[test]
fn max_move_cannot_reach_ten_thousand() {
    let mut params = extreme_params(0);
    params.max_move_bps = 10_000;
    assert_eq!(params.check(), Err(E::InvalidMarketParams));
    params.max_move_bps = 9_997;
    assert_eq!(params.check(), Err(E::InvalidMarketParams));
    params.max_move_bps = 9_996;
    assert!(params.check().is_ok());
}

#[test]
fn an_open_interest_cap_above_the_bound_is_refused() {
    let mut params = perp_params(0);
    params.open_interest_cap = MAX_OPEN_INTEREST_CAP;
    assert!(params.check().is_ok());
    for cap in [MAX_OPEN_INTEREST_CAP + 1, 1 << 62, u64::MAX] {
        params.open_interest_cap = cap;
        assert_eq!(params.check(), Err(E::InvalidMarketParams));
    }
    let mut spot = spot_params(0);
    spot.open_interest_cap = MAX_OPEN_INTEREST_CAP + 1;
    assert_eq!(spot.check(), Err(E::InvalidMarketParams));
}

#[test]
fn publishing_walks_up_to_the_highest_price_and_no_further() {
    let mut w = World::new(16, 8);
    let m = w.add_market(extreme_params(0));
    let mut steps = 0u32;
    loop {
        let current = w.markets[m].price.price;
        let next = (u128::from(current) * 19_000 / 10_000) as u64;
        w.now += 1;
        let at = w.now;
        if next > MAX_PRICE {
            assert_eq!(w.publish(m, next, at), Err(E::PriceTooHigh));
            break;
        }
        w.publish(m, next, at).unwrap();
        steps += 1;
    }
    assert_eq!(steps, 27);
    let at = w.now;
    w.publish(m, MAX_PRICE, at).unwrap();
    assert_eq!(w.markets[m].price.price, MAX_PRICE);
    w.now += 1;
    let at = w.now;
    assert_eq!(w.publish(m, MAX_PRICE + 1, at), Err(E::PriceTooHigh));
    assert_eq!(w.markets[m].price.price, MAX_PRICE);
}

#[test]
fn a_reset_above_the_highest_price_is_refused_and_changes_nothing() {
    let mut w = World::new(16, 8);
    let m = w.add_market(extreme_params(0));
    w.now += 5;
    let at = w.now;
    let feed = w.markets[m].price;
    for price in [MAX_PRICE + 1, 5_000_000_000_000_000_000, u64::MAX] {
        assert_eq!(w.reset(m, price, at), Err(E::PriceTooHigh));
        assert_eq!(w.markets[m].price, feed);
        assert_eq!(w.markets[m].params.status, STATUS_ACTIVE);
    }
    w.reset(m, MAX_PRICE, at).unwrap();
    assert_eq!(w.markets[m].price.price, MAX_PRICE);
    assert_eq!(w.markets[m].params.status, STATUS_REDUCE_ONLY);
}

/// Every market at its open interest cap, the mark reset to `MAX_PRICE` on each, at the
/// loosest margins. The winner can still withdraw, every market can be liquidated, and
/// the loser's collateral stays within `BALANCE_CAP` once all of it is realised.
#[test]
fn positions_at_the_cap_on_every_market_stay_liquidatable_at_the_highest_price() {
    let mut w = World::new(16, 8);
    let markets: Vec<usize> = (0..MARKETS as u8)
        .map(|id| w.add_market(extreme_params(id)))
        .collect();
    let long = funded(&mut w, 1_000_000_000_000);
    let short = funded(&mut w, 1_000_000_000_000);
    for &m in &markets {
        w.place(m, long, limit(Side::Bid, MARK, MAX_OPEN_INTEREST_CAP))
            .unwrap();
        let opened = w
            .place(m, short, ioc(Side::Ask, MARK, MAX_OPEN_INTEREST_CAP))
            .unwrap();
        assert_eq!(opened.filled, MAX_OPEN_INTEREST_CAP);
    }

    w.now += 5;
    let at = w.now;
    for &m in &markets {
        w.reset(m, MAX_PRICE, at).unwrap();
    }
    let notional = i128::from(MAX_OPEN_INTEREST_CAP) * i128::from(MAX_PRICE);
    let all_markets = notional * MARKETS as i128;
    assert_eq!(all_markets, i128::from(BALANCE_CAP));
    assert_eq!(
        w.maintenance_margin(short),
        (all_markets * 9_999 + 9_999) / 10_000
    );
    assert_eq!(w.initial_margin(long), all_markets);
    assert!(w.equity(short) < 0);
    assert!(w.is_liquidatable(short, 0));

    w.withdraw(long, Asset::Collateral, 1).unwrap();

    for &m in &markets {
        let liquidator = funded(&mut w, (1 << 59) + 1_000_000_000_000);
        let outcome = w
            .liquidate(m, liquidator, short, MAX_OPEN_INTEREST_CAP)
            .unwrap();
        assert_eq!(outcome.status, LiquidationStatus::Liquidated);
        assert_eq!(outcome.liquidated, MAX_OPEN_INTEREST_CAP);
        assert_eq!(
            outcome.price, MAX_PRICE,
            "a bankrupt target pays no penalty"
        );
    }
    let debt = w.collateral(short);
    assert!(debt < 0);
    assert!(debt.unsigned_abs() <= BALANCE_CAP);
    let recorded: u64 = markets
        .iter()
        .map(|&m| w.markets[m].params.uncovered_shortfall)
        .sum();
    assert_eq!(recorded, debt.unsigned_abs());
    assert_eq!(
        w.withdraw(long, Asset::Collateral, 1),
        Err(E::ShortfallOutstanding),
        "the designed freeze, not an arithmetic failure"
    );
}

/// Resting orders are bounded by the position cap, not the open interest cap. An order
/// for the most lots a `u64` holds passes the margin check while the mark is low and
/// is then refused by the cap, so a seat rests the most the cap allows on every
/// market. After the mark is reset to `MAX_PRICE` and the margins raised to their
/// loosest, initial margin still computes, with an order of the most lots a `u64`
/// holds pending on top of it.
#[test]
fn initial_margin_with_the_largest_resting_orders_fits_at_the_highest_price() {
    let mut w = World::new(16, 8);
    let mut cheap = perp_params(0);
    cheap.tick = 1;
    cheap.im_bps = 300;
    cheap.mm_bps = 150;
    cheap.liq_penalty_bps = 10;
    cheap.taker_fee_bps = 5;
    cheap.band_bps = 100;
    cheap.max_move_bps = 100;
    let markets: Vec<usize> = (0..MARKETS as u8)
        .map(|id| {
            let mut params = cheap;
            params.market_id = id;
            params.check().unwrap();
            w.add_market(params)
        })
        .collect();
    let whale = funded(&mut w, BALANCE_CAP);
    for &m in &markets {
        w.set_price(m, 1);
        assert_eq!(
            w.place(m, whale, limit(Side::Bid, 1, u64::MAX)),
            Err(E::PositionCapExceeded)
        );
        let rested = w
            .place(m, whale, limit(Side::Bid, 1, MAX_OPEN_INTEREST_CAP))
            .unwrap();
        assert_eq!(rested.status, PlaceStatus::Rested);
    }

    w.now += 5;
    let at = w.now;
    for &m in &markets {
        w.reset(m, MAX_PRICE, at).unwrap();
        let mut loosest = extreme_params(m as u8);
        loosest.tick = 1;
        loosest.status = w.markets[m].params.status;
        w.markets[m].params = loosest;
        w.resume(m).unwrap();
    }
    let per_market = i128::from(MAX_OPEN_INTEREST_CAP) * i128::from(MAX_PRICE);
    assert_eq!(w.initial_margin(whale), per_market * MARKETS as i128);
    assert_eq!(
        w.withdraw(whale, Asset::Collateral, 1),
        Err(E::InsufficientMargin)
    );
    assert_eq!(
        w.place(0, whale, limit(Side::Bid, MAX_PRICE, u64::MAX)),
        Err(E::InsufficientMargin)
    );

    for &m in &markets {
        assert_eq!(w.cancel_all(m, whale, 32), Ok(1));
    }
    w.withdraw(whale, Asset::Collateral, BALANCE_CAP).unwrap();
}

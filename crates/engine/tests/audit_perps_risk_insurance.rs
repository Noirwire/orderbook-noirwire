//! Audit, perps risk: insurance accounting.

mod common;

use common::*;
use noirwire_orderbook_engine::EngineError as E;
use noirwire_orderbook_engine::*;

fn funded(w: &mut World, collateral: u64) -> u32 {
    let seat = w.open();
    w.deposit(seat, Asset::Collateral, collateral).unwrap();
    seat
}

fn buy_from(w: &mut World, m: usize, buyer: u32, seller: u32, price: u64, size: u64) {
    w.place(m, seller, limit(Side::Ask, price, size)).unwrap();
    let outcome = w.place(m, buyer, ioc(Side::Bid, price, size)).unwrap();
    assert_eq!(outcome.filled, size);
}

/// RULES 5 sends `fee_insurance_share_bps` of every spot fee to the insurance seat "so
/// insurance grows with trading". A spot fee is a spot token balance, while the
/// insurance seat pays only from collateral (RULES 8.5, 8.6), and no instruction moves
/// a reserved seat's spot balance: `withdraw` refuses reserved seats, `collect_fees`
/// and `move_fees_to_insurance` debit only the fee seat. The share is in custody for
/// good and never covers a shortfall, even when the spot quote token is the collateral
/// token, as in the deployment's NSOL-NUSD market.
#[test]
fn audit_perps_risk_the_insurance_share_of_spot_fees_can_never_cover_a_shortfall() {
    let mut w = World::new(12, 8);
    let perp = w.add_market(perp_params(0));
    let mut spot_market = spot_params(1);
    spot_market.fee_insurance_share_bps = 5_000;
    let spot = w.add_market(spot_market);
    let buyer = w.open();
    let seller = w.open();
    w.deposit(buyer, Asset::Spot(QUOTE), 10_000_000).unwrap();
    w.deposit(seller, Asset::Spot(BASE), 1_000_000).unwrap();
    for _ in 0..4 {
        buy_from(&mut w, spot, buyer, seller, 1_000, 1_000);
    }
    let insurance_spot = w.spot(INSURANCE_SEAT, QUOTE).available;
    assert_eq!(insurance_spot, 6_000);

    let maker = funded(&mut w, 100_000);
    let liquidator = funded(&mut w, 100_000);
    let debtor = funded(&mut w, 1_100);
    buy_from(&mut w, perp, debtor, maker, 1_000, 10);
    w.set_price(perp, 850);
    let outcome = w.liquidate(perp, liquidator, debtor, 10).unwrap();
    assert_eq!((outcome.insurance_paid, outcome.uncovered), (0, 520));

    let key = w.key(INSURANCE_SEAT);
    let reserved = w.withdraw_as(INSURANCE_SEAT, key, Asset::Spot(QUOTE), 1);
    assert_eq!(reserved, Err(E::ReservedSeat));
    assert_eq!(
        w.collect_fees(Asset::Spot(QUOTE), w.spot(FEE_SEAT, QUOTE).available + 1),
        Err(E::InsufficientBalance)
    );
    let covered = w.cover_shortfall(perp, debtor).unwrap();

    assert_eq!(w.spot(INSURANCE_SEAT, QUOTE).available, insurance_spot);
    assert!(
        covered > 0,
        "RULES 5 and 8.6: the insurance seat holds {insurance_spot} atoms of spot fees, \
         yet the market stays reduce-only with {} recorded and withdrawals frozen; no \
         instruction can move those atoms anywhere",
        w.markets[perp].params.uncovered_shortfall
    );
}

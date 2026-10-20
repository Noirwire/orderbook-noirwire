//! Audit, perps risk: insurance accounting.

mod common;

use common::*;
use noirwire_orderbook_engine::EngineError as E;
use noirwire_orderbook_engine::*;

/// The insurance seat pays only from collateral (RULES 8.5, 8.6), and no instruction
/// moves a reserved seat's spot balance: `withdraw` refuses reserved seats,
/// `collect_fees` and `move_fees_to_insurance` debit only the fee seat. A share of a
/// spot fee credited to the insurance seat would sit in custody for good and never
/// cover a shortfall, even when the spot quote token is the collateral token, as in the
/// deployment's NSOL-NUSD market. RULES 5 therefore sends every spot fee to the fee
/// seat, whatever `fee_insurance_share_bps` says, where the admin can collect it, even
/// while a shortfall freezes collateral.
#[test]
fn audit_perps_risk_no_share_of_a_spot_fee_is_stranded_in_the_insurance_seat() {
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
    let spot_fees = w.spot(FEE_SEAT, QUOTE).available;
    assert_eq!(spot_fees, 12_000);

    let maker = funded(&mut w, 100_000);
    let liquidator = funded(&mut w, 100_000);
    let debtor = funded(&mut w, 1_100);
    buy_from(&mut w, perp, debtor, maker, 1_000, 10);
    w.set_price(perp, 850);
    let outcome = w.liquidate(perp, liquidator, debtor, 10).unwrap();
    let paid = (
        outcome.insurance_paid,
        outcome.fee_seat_paid,
        outcome.uncovered,
    );
    assert_eq!(paid, (0, 30, 400), "the fee seat pays from collateral only");
    assert_eq!(w.spot(FEE_SEAT, QUOTE).available, spot_fees);

    let key = w.key(INSURANCE_SEAT);
    let reserved = w.withdraw_as(INSURANCE_SEAT, key, Asset::Spot(QUOTE), 1);
    assert_eq!(reserved, Err(E::ReservedSeat));
    assert_eq!(w.collect_fees(Asset::Spot(QUOTE), spot_fees), Ok(()));

    assert_eq!(
        w.spot(INSURANCE_SEAT, QUOTE),
        TokenBalance::default(),
        "RULES 5: a share of a spot fee in the insurance seat could never be moved or \
         cover the {} recorded",
        w.markets[perp].params.uncovered_shortfall
    );
    assert_eq!(w.spot(FEE_SEAT, QUOTE).available, 0);
}

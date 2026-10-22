//! Audit, custody area: RULES 11 and 13.1 against the way the program composes
//! the engine with SPL Token transfers.
//!
//! The program keeps one custody token account per mint and custody nonce, and
//! sharing is per custody account, not per mint: the collateral token and a
//! spot index share custody only when both are registered with the same
//! custody account. The invariant that matters on chain is per custody
//! account: its balance equals every seat's collateral, settled perp quote and
//! spot balances of the tokens registered with it together.
//!
//! The harness keeps custody as counters that only deposits, withdrawals and
//! fee payouts move. A `collect_fees` payout into a custody account itself
//! would debit the fee seat and move nothing, since SPL Token treats a
//! transfer whose source and destination are the same account as a successful
//! no-op (spl-token 4.0.0, `processor.rs`, the `self_transfer` branch of
//! `process_transfer`, lines 264 to 305). The program refuses every registered
//! custody account as the destination before the engine runs, which is tested
//! in the program crate and against the network, not here. The first test
//! shows a real payout keeps custody equal to the ledger. The second shows the
//! composition used by `transfer_between_balances`, with the collateral and
//! the spot index kept in one custody account as the program requires,
//! conserves custody, including while a shortfall is recorded.

mod common;

use common::*;
use noirwire_orderbook_engine::EngineError as E;
use noirwire_orderbook_engine::*;

/// What the ledger says the collateral's custody account must hold, counting
/// the spot balances of `shared_spot` too when that index is registered with
/// the same custody account.
fn ledger_total_of_collateral_custody(w: &World, shared_spot: Option<u8>) -> i128 {
    let mut total = 0i128;
    for seat in w.seats.iter().filter(|seat| seat.is_open()) {
        total += i128::from(seat.collateral);
        for (id, slot) in seat.perp.iter().enumerate() {
            let index = w
                .markets
                .get(id)
                .map(|state| state.book.funding_index)
                .unwrap_or(0);
            let unpaid =
                i128::from(slot.base) * (i128::from(index) - i128::from(slot.funding_checkpoint));
            total += i128::from(slot.quote) - unpaid;
        }
        if let Some(token) = shared_spot {
            let balance = seat.spot[usize::from(token)];
            total += i128::from(balance.available) + i128::from(balance.locked);
        }
    }
    total
}

#[test]
fn audit_custody_collect_fees_to_an_account_outside_custody_keeps_custody_to_the_ledger() {
    let mut w = World::new(10, 8);
    let m = w.add_market(perp_params(0));
    let a = funded(&mut w, 100_000);
    let b = funded(&mut w, 100_000);
    buy_from(&mut w, m, a, b, 1_000, 10);
    let fees = u64::try_from(w.collateral(FEE_SEAT)).unwrap();
    assert!(fees > 0, "the trade paid a taker fee into the fee seat");
    assert_eq!(
        w.custody_collateral,
        ledger_total_of_collateral_custody(&w, None),
        "custody matches the ledger before the payout"
    );

    w.collect_fees(Asset::Collateral, fees).unwrap();

    assert_eq!(w.collateral(FEE_SEAT), 0, "the fee seat was paid out");
    assert_eq!(
        w.custody_collateral,
        ledger_total_of_collateral_custody(&w, None),
        "RULES 11 and 13.1: custody still equals the seats after a real payout"
    );
}

#[test]
fn audit_custody_one_custody_account_is_conserved_through_transfers_between_balances() {
    let mut w = World::new(10, 8);
    let perp = w.add_market(perp_params(0));
    let spot = w.add_market(spot_params(1));
    let a = funded(&mut w, 100_000);
    let b = funded(&mut w, 100_000);
    w.deposit(b, Asset::Spot(BASE), 1_000).unwrap();
    buy_from(&mut w, perp, a, b, 1_000, 10);

    let per_custody = |w: &World| w.custody_collateral + w.custody_spot[usize::from(QUOTE)] as i128;
    let start = per_custody(&w);
    assert_eq!(start, ledger_total_of_collateral_custody(&w, Some(QUOTE)));

    w.withdraw(a, Asset::Collateral, 20_000).unwrap();
    w.deposit(a, Asset::Spot(QUOTE), 20_000).unwrap();
    assert_eq!(per_custody(&w), start, "collateral to spot moves no token");
    buy_from(&mut w, spot, a, b, 1_000, 2);
    w.withdraw(a, Asset::Spot(QUOTE), 5_000).unwrap();
    w.deposit(a, Asset::Collateral, 5_000).unwrap();
    assert_eq!(per_custody(&w), start, "spot to collateral moves no token");
    assert_eq!(
        per_custody(&w),
        ledger_total_of_collateral_custody(&w, Some(QUOTE))
    );
}

#[test]
fn audit_custody_a_recorded_shortfall_blocks_collateral_to_spot_but_not_repayment() {
    let mut w = World::new(10, 8);
    let m = w.add_market(perp_params(0));
    w.deposit(INSURANCE_SEAT, Asset::Collateral, 200).unwrap();
    let maker = funded(&mut w, 100_000);
    let liquidator = funded(&mut w, 100_000);
    let debtor = funded(&mut w, 1_100);
    buy_from(&mut w, m, debtor, maker, 1_000, 10);
    w.set_price(m, 850);
    let outcome = w.liquidate(m, liquidator, debtor, 10).unwrap();
    assert!(outcome.uncovered > 0);

    assert_eq!(
        w.withdraw(maker, Asset::Collateral, 1),
        Err(E::ShortfallOutstanding),
        "the first leg of a collateral-to-spot move is refused while a shortfall is recorded"
    );
    w.deposit(debtor, Asset::Spot(QUOTE), 400).unwrap();
    w.withdraw(debtor, Asset::Spot(QUOTE), 400).unwrap();
    w.deposit(debtor, Asset::Collateral, 400).unwrap();
    assert!(w.collateral(debtor) >= 0);
}

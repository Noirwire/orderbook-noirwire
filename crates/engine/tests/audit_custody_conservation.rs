//! Audit, custody area: RULES 11 and 13.1 against the way the program composes
//! the engine with SPL Token transfers.
//!
//! The program keeps one custody token account per mint. The collateral token
//! and any spot index registered with the same mint share it, so the invariant
//! that matters on chain is per mint: the custody balance equals every seat's
//! collateral, settled perp quote and spot balances of that mint together.
//!
//! The harness keeps custody as counters that only deposits, withdrawals and
//! fee payouts move. The program's `collect_fees` lets the admin name any token
//! account of the mint as the destination, the custody account included, and
//! SPL Token treats a transfer whose source and destination are the same
//! account as a successful no-op (spl-token 4.0.0, `processor.rs`, the
//! `self_transfer` branch of `process_transfer`, lines 264 to 305). The first
//! test reproduces that payout and shows RULES 13.1 broken. The second shows
//! the shared-mint composition used by `transfer_between_balances` conserves
//! custody, including while a shortfall is recorded.

mod common;

use common::*;
use noirwire_orderbook_engine::EngineError as E;
use noirwire_orderbook_engine::*;

fn funded(w: &mut World, collateral: u64) -> u32 {
    let trader = w.open();
    w.deposit(trader, Asset::Collateral, collateral).unwrap();
    trader
}

fn buy_from(w: &mut World, m: usize, buyer: u32, seller: u32, price: u64, size: u64) {
    w.place(m, seller, limit(Side::Ask, price, size)).unwrap();
    let outcome = w.place(m, buyer, ioc(Side::Bid, price, size)).unwrap();
    assert_eq!(outcome.filled, size);
}

/// What the ledger says custody of the collateral mint must hold, counting the
/// spot balances of `shared_spot` too when that index carries the same mint.
fn ledger_total_of_collateral_mint(w: &World, shared_spot: Option<u8>) -> i128 {
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

/// What `collect_fees` does on chain when its `to` account is the custody
/// account: the engine debits the fee seat, then the program signs an SPL
/// transfer from custody to custody, which SPL Token accepts and which moves
/// nothing. Custody keeps every token while the ledger forgets the fees.
fn collect_fees_into_custody(w: &mut World, asset: Asset, amount: u64) -> EngineResult<()> {
    let markets: Vec<MarketParams> = w.markets.iter().map(|m| m.params).collect();
    let mut ledger = LedgerMut {
        header: &mut w.header,
        seats: &mut w.seats,
    };
    collect_fees(&mut ledger, &markets, asset, amount)
}

#[test]
fn audit_custody_collect_fees_into_custody_itself_leaves_custody_above_the_ledger() {
    let mut w = World::new(10, 8);
    let m = w.add_market(perp_params(0));
    let a = funded(&mut w, 100_000);
    let b = funded(&mut w, 100_000);
    buy_from(&mut w, m, a, b, 1_000, 10);
    let fees = u64::try_from(w.collateral(FEE_SEAT)).unwrap();
    assert!(fees > 0, "the trade paid a taker fee into the fee seat");
    assert_eq!(
        i128::from(w.custody_collateral),
        ledger_total_of_collateral_mint(&w, None),
        "custody matches the ledger before the payout"
    );

    collect_fees_into_custody(&mut w, Asset::Collateral, fees).unwrap();

    assert_eq!(w.collateral(FEE_SEAT), 0, "the fee seat was debited");
    let custody = w.custody_collateral;
    let ledger = ledger_total_of_collateral_mint(&w, None);
    assert_eq!(
        custody, ledger,
        "RULES 11 and 13.1 broken: after collect_fees paid {fees} atoms into the custody \
         account itself, custody holds {custody} but the seats sum to {ledger}; the \
         difference belongs to no seat and no instruction can ever pay it out"
    );
}

#[test]
fn audit_custody_a_shared_mint_is_conserved_through_transfers_between_balances() {
    let mut w = World::new(10, 8);
    let perp = w.add_market(perp_params(0));
    let spot = w.add_market(spot_params(1));
    let a = funded(&mut w, 100_000);
    let b = funded(&mut w, 100_000);
    w.deposit(b, Asset::Spot(BASE), 1_000).unwrap();
    buy_from(&mut w, perp, a, b, 1_000, 10);

    let per_mint = |w: &World| w.custody_collateral + w.custody_spot[usize::from(QUOTE)] as i128;
    let start = per_mint(&w);
    assert_eq!(start, ledger_total_of_collateral_mint(&w, Some(QUOTE)));

    w.withdraw(a, Asset::Collateral, 20_000).unwrap();
    w.deposit(a, Asset::Spot(QUOTE), 20_000).unwrap();
    assert_eq!(per_mint(&w), start, "collateral to spot moves no token");
    buy_from(&mut w, spot, a, b, 1_000, 2);
    w.withdraw(a, Asset::Spot(QUOTE), 5_000).unwrap();
    w.deposit(a, Asset::Collateral, 5_000).unwrap();
    assert_eq!(per_mint(&w), start, "spot to collateral moves no token");
    assert_eq!(
        per_mint(&w),
        ledger_total_of_collateral_mint(&w, Some(QUOTE))
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

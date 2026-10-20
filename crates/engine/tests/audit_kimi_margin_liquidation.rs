//! Audit replay, margin and liquidation: hypotheses H12 to H18, H20, H24 and
//! H54 of the exploit catalogue, replayed against the engine. Each test asserts
//! the defensive behavior; a failure demonstrates the attack.

mod common;

use common::*;
use noirwire_orderbook_engine::EngineError as E;
use noirwire_orderbook_engine::*;

fn funded(w: &mut World, collateral: u64) -> u32 {
    let seat = w.open();
    w.deposit(seat, Asset::Collateral, collateral).unwrap();
    seat
}

/// `buyer` takes `size` lots from `seller`'s resting ask at `price`.
fn buy_from(w: &mut World, m: usize, buyer: u32, seller: u32, price: u64, size: u64) {
    w.place(m, seller, limit(Side::Ask, price, size)).unwrap();
    let outcome = w.place(m, buyer, ioc(Side::Bid, price, size)).unwrap();
    assert_eq!(outcome.filled, size);
}

/// H12 (Mango). Unrealized profit sits in the position's quote, never in
/// collateral, and withdrawals are bounded by collateral.
#[test]
fn h12_unrealized_pnl_is_not_withdrawable() {
    let mut w = World::new(10, 8);
    let m = w.add_market(perp_params(0));
    let maker = funded(&mut w, 1_000_000);
    let long = funded(&mut w, 10_500);
    buy_from(&mut w, m, long, maker, 1000, 100); // taker fee 300
    let deposited = w.collateral(long); // 10_200
    w.set_price(m, 1300); // +30% mark pump: +30_000 unrealized
    assert_eq!(w.equity(long), 40_200);
    assert_eq!(w.collateral(long), deposited, "the pump did not touch collateral");

    assert_eq!(
        w.withdraw(long, Asset::Collateral, deposited as u64 + 1),
        Err(E::InsufficientCollateral),
        "equity is 40_200 but only settled collateral may leave"
    );
    assert_eq!(w.withdraw(long, Asset::Collateral, deposited as u64), Ok(()));
    assert_eq!(w.withdraw(long, Asset::Collateral, 1), Err(E::InsufficientCollateral));
    assert_eq!(w.equity(long), 30_000, "the unrealized gain is still locked in the seat");
}

/// H13 (JELLY / ETH whale). Withdrawing down to exactly initial margin is
/// allowed; the liquidation that the move invites pays no insurance while the
/// target is solvent, and a liquidator without margin cannot take the position.
#[test]
fn h13_withdraw_to_minimum_then_liquidation_stays_solvent() {
    let mut w = World::new(10, 8);
    let m = w.add_market(perp_params(0));
    let maker = funded(&mut w, 1_000_000);
    let target = funded(&mut w, 2_000);
    buy_from(&mut w, m, target, maker, 1000, 10); // fee 30, equity 1_970

    assert_eq!(w.withdraw(target, Asset::Collateral, 970), Ok(()));
    assert_eq!(w.equity(target), 1_000);
    assert_eq!(
        w.withdraw(target, Asset::Collateral, 1),
        Err(E::InsufficientMargin),
        "one atom past initial margin is refused"
    );

    w.set_price(m, 940);
    assert!(w.is_liquidatable(target, m));
    let poor = funded(&mut w, 100);
    let attempt = w.liquidate(m, poor, target, 10).unwrap();
    assert_eq!(attempt.status, LiquidationStatus::LiquidatorMarginInsufficient);
    assert_eq!(attempt.liquidated, 0);

    let rich = funded(&mut w, 1_000_000);
    let outcome = w.liquidate(m, rich, target, 10).unwrap();
    assert_eq!(outcome.status, LiquidationStatus::Liquidated);
    assert_eq!(outcome.liquidated, 2, "the size that restores maintenance margin");
    assert_eq!((outcome.insurance_paid, outcome.uncovered), (0, 0));
    assert!(!w.is_liquidatable(target, m), "the target is healthy again");
}

/// H14. The receiving seat is margin-checked, and a liquidation touches only
/// the named market: the target keeps its positions elsewhere.
#[test]
fn h14_takeover_is_margin_checked_and_cannot_cherry_pick_markets() {
    let mut w = World::new(10, 8);
    let m0 = w.add_market(perp_params(0));
    let m1 = w.add_market(perp_params(1));
    let maker = funded(&mut w, 1_000_000);
    let target = funded(&mut w, 11_400);
    buy_from(&mut w, m0, target, maker, 1000, 100); // fee 300, equity 11_100
    // a short on market 1, kept after the market-0 liquidation
    w.place(m1, maker, limit(Side::Bid, 1000, 10)).unwrap();
    assert_eq!(w.place(m1, target, ioc(Side::Ask, 1000, 10)).unwrap().filled, 10);

    w.set_price(m0, 940); // equity 11_100 - 6_000 = 5_100, maintenance 4_700 + 500
    assert!(w.is_liquidatable(target, m0));

    let poor = funded(&mut w, 100);
    let attempt = w.liquidate(m0, poor, target, 100).unwrap();
    assert_eq!(attempt.status, LiquidationStatus::LiquidatorMarginInsufficient);
    assert_eq!(w.slot(target, m0).base, 100, "nothing moved");

    let rich = funded(&mut w, 1_000_000);
    let outcome = w.liquidate(m0, rich, target, 100).unwrap();
    assert_eq!(outcome.status, LiquidationStatus::Liquidated);
    assert_eq!(w.slot(target, m1).base, -10, "the other market is untouched");
    assert_eq!(w.slot(rich, m1).base, 0, "the liquidator took only market 0");
}

/// H15. Self-liquidation: the same seat is refused outright; across two seats
/// of one attacker the penalty share paid to the insurance seat makes the
/// round trip a loss while the target is solvent.
#[test]
fn h15_self_liquidation_is_refused_or_unprofitable() {
    let mut params = perp_params(0);
    params.liq_insurance_share_bps = 5_000;
    let mut w = World::new(10, 8);
    let m = w.add_market(params);
    let a = funded(&mut w, 10_500);
    let b = funded(&mut w, 10_500);
    assert_eq!(w.liquidate(m, a, a, 1), Err(E::SelfLiquidation));

    w.place(m, a, limit(Side::Bid, 1000, 100)).unwrap();
    assert_eq!(w.place(m, b, ioc(Side::Ask, 1000, 100)).unwrap().filled, 100);
    w.set_price(m, 920);
    assert!(w.is_liquidatable(a, m));
    let before = w.equity(a) + w.equity(b);
    let insurance_before = w.collateral(INSURANCE_SEAT);

    let outcome = w.liquidate(m, b, a, 100).unwrap();
    assert_eq!(outcome.status, LiquidationStatus::Liquidated);
    let after = w.equity(a) + w.equity(b);
    let insurance_gain = w.collateral(INSURANCE_SEAT) - insurance_before;
    assert!(insurance_gain > 0);
    assert_eq!(
        before - after,
        i128::from(insurance_gain),
        "the coalition loses exactly the insurance share of the penalty"
    );
}

/// H16. A bankrupt target is still taken over at mark minus the full penalty,
/// so part of what the insurance seat pays the target's debt with is the
/// liquidator's bonus. The defense to assert: insurance pays no more than the
/// deficit at the bankruptcy price, and the liquidator gains nothing from a
/// bankrupt target.
#[test]
fn h16_bankrupt_target_penalty_must_not_come_from_insurance() {
    let mut params = perp_params(0);
    params.liq_insurance_share_bps = 5_000; // the deployed split
    let mut w = World::new(10, 8);
    let m = w.add_market(params);
    w.deposit(INSURANCE_SEAT, Asset::Collateral, 100_000).unwrap();
    let maker = funded(&mut w, 1_000_000);
    let target = funded(&mut w, 10_300);
    buy_from(&mut w, m, target, maker, 1000, 100); // equity 10_000
    w.set_price(m, 850); // a 15% gap, five maximum publishes of -3%
    assert_eq!(w.equity(target), -5_000, "bankrupt at the mark");

    let liquidator = funded(&mut w, 100_000);
    let outcome = w.liquidate(m, liquidator, target, 100).unwrap();
    assert_eq!(outcome.status, LiquidationStatus::Liquidated);
    assert_eq!(outcome.liquidated, 100, "a bankrupt target is taken whole");

    let deficit_at_mark = 5_000i128; // what insurance would pay at the bankruptcy price
    let liquidator_gain = w.equity(liquidator) - 100_000;
    assert!(
        i128::from(outcome.insurance_paid) <= deficit_at_mark,
        "insurance paid {} where the bankruptcy-price deficit is {deficit_at_mark}: \
         the liquidator's bonus of {} per lot ({} total, minus the insurance share) \
         is paid out of the insurance seat",
        outcome.insurance_paid,
        850u64.abs_diff(outcome.price),
        850u64.abs_diff(outcome.price) * outcome.liquidated,
    );
    assert!(
        liquidator_gain <= 0,
        "the liquidator gained {liquidator_gain} atoms from a bankrupt target"
    );
}

/// H17. Dust: a liquidation whose remainder would be below the minimum size
/// takes the whole position, and a one-lot position at a tiny mark is still
/// liquidatable, with the shortfall recorded exactly once.
#[test]
fn h17_dust_positions_are_liquidated_whole() {
    let mut params = perp_params(0);
    params.min_size = 4;
    let mut w = World::new(10, 8);
    let m = w.add_market(params);
    let maker = funded(&mut w, 1_000_000);
    let liquidator = funded(&mut w, 1_000_000);
    let target = funded(&mut w, 1_100);
    buy_from(&mut w, m, target, maker, 1000, 10);
    w.set_price(m, 900);
    let outcome = w.liquidate(m, liquidator, target, 8).unwrap();
    assert_eq!(outcome.status, LiquidationStatus::Liquidated);
    assert_eq!(
        outcome.liquidated, 10,
        "8 would leave 2 lots, below the minimum size of 4, so all 10 go"
    );

    // one lot at a mark of 10, held with 2 atoms of collateral
    let mut w = World::new(10, 8);
    let m = w.add_market(perp_params(0));
    w.set_price(m, 10);
    let maker = funded(&mut w, 1_000);
    let liquidator = funded(&mut w, 1_000);
    let dust = funded(&mut w, 2);
    w.place(m, dust, limit(Side::Bid, 10, 1)).unwrap();
    assert_eq!(w.place(m, maker, ioc(Side::Ask, 10, 1)).unwrap().filled, 1);
    w.set_price(m, 5);
    let outcome = w.liquidate(m, liquidator, dust, 1).unwrap();
    assert_eq!(outcome.status, LiquidationStatus::Liquidated);
    assert_eq!(outcome.liquidated, 1, "no dust shield");
    assert_eq!(w.collateral(dust), -4);
    assert_eq!((outcome.insurance_paid, outcome.uncovered), (0, 4));
    assert_eq!(w.markets[m].params.status, STATUS_REDUCE_ONLY);
}

/// H18 (Filament). The spot quote balance and the perp collateral are separate
/// pools: each is spendable once, locks release exactly once, and withdrawing
/// one never frees the other.
#[test]
fn h18_spot_and_perp_pools_cannot_be_double_counted() {
    let mut w = World::new(10, 8);
    let spot = w.add_market(spot_params(0));
    let perp = w.add_market(perp_params(1));
    let seat = w.open();
    w.deposit(seat, Asset::Spot(QUOTE), 2_000).unwrap();
    w.deposit(seat, Asset::Collateral, 1_000).unwrap();

    let bid = w.place(spot, seat, limit(Side::Bid, 1000, 1)).unwrap();
    assert_eq!(bid.rested, 1);
    let locked = w.spot(seat, QUOTE);
    assert_eq!((locked.available, locked.locked), (997, 1003), "notional plus fee");
    assert_eq!(
        w.withdraw(seat, Asset::Spot(QUOTE), 998),
        Err(E::InsufficientBalance),
        "the locked 1_003 atoms cannot be spent a second time"
    );

    let perp_bid = w.place(perp, seat, limit(Side::Bid, 1000, 1)).unwrap();
    assert_eq!(perp_bid.rested, 1, "the perp pool is independent and usable");

    assert_eq!(w.cancel(spot, seat, seq(&bid)), Ok(()));
    let released = w.spot(seat, QUOTE);
    assert_eq!((released.available, released.locked), (2_000, 0));
    assert_eq!(w.cancel(spot, seat, seq(&bid)), Err(E::OrderNotFound));
    assert_eq!(w.withdraw(seat, Asset::Spot(QUOTE), 2_000), Ok(()));
    assert_eq!(w.slot(seat, perp).open_bid_lots, 1, "the perp order is unaffected");
}

/// H20. One seat may hold the whole open interest cap (no per-seat
/// concentration limit), but nothing may exceed the cap.
#[test]
fn h20_open_interest_cap_holds_under_parallel_pressure() {
    let mut params = perp_params(0);
    params.open_interest_cap = 200;
    let mut w = World::new(10, 8);
    let m = w.add_market(params);
    let a = funded(&mut w, 10_000_000);
    let b = funded(&mut w, 10_000_000);
    let c = funded(&mut w, 10_000_000);
    let d = funded(&mut w, 10_000_000);
    buy_from(&mut w, m, a, b, 1000, 100);
    assert_eq!(w.markets[m].book.open_interest, 100);

    w.place(m, d, limit(Side::Ask, 1000, 150)).unwrap();
    let over = w.place(m, c, ioc(Side::Bid, 1000, 150)).unwrap();
    assert_eq!(over.filled, 0, "a fill past the cap is refused like a failed check");
    assert_eq!(over.status, PlaceStatus::RemainderCancelledFillCheck);

    let at_cap = w.place(m, c, ioc(Side::Bid, 1000, 100)).unwrap();
    assert_eq!(at_cap.filled, 100);
    assert_eq!(w.markets[m].book.open_interest, 200);
    let past = w.place(m, c, ioc(Side::Bid, 1000, 1)).unwrap();
    assert_eq!(past.filled, 0);
    assert_eq!(w.markets[m].book.open_interest, 200);

    // no per-seat limit: one seat can hold the entire cap
    let mut w = World::new(10, 8);
    let m = w.add_market(params);
    let a = funded(&mut w, 10_000_000);
    let b = funded(&mut w, 10_000_000);
    buy_from(&mut w, m, a, b, 1000, 200);
    assert_eq!(w.slot(a, m).base, 200, "one seat holds 100% of the cap");
}

/// H24. A fill that flips a seat through zero keeps open interest exact, and
/// canceling resting orders never touches it.
#[test]
fn h24_open_interest_stays_exact_through_flips_and_cancels() {
    let mut params = perp_params(0);
    params.open_interest_cap = 150;
    let mut w = World::new(10, 8);
    let m = w.add_market(params);
    let a = funded(&mut w, 10_000_000);
    let b = funded(&mut w, 10_000_000);
    let c = funded(&mut w, 10_000_000);
    buy_from(&mut w, m, a, b, 1000, 100);

    w.place(m, a, limit(Side::Ask, 1000, 150)).unwrap();
    let flip = w.place(m, c, ioc(Side::Bid, 1000, 150)).unwrap();
    assert_eq!(flip.filled, 150);
    assert_eq!(w.slot(a, m).base, -50, "flipped through zero in one fill");
    assert_eq!(w.slot(c, m).base, 150);
    assert_eq!(w.markets[m].book.open_interest, 150, "OI follows total longs");

    let resting = w.place(m, c, limit(Side::Bid, 990, 1)).unwrap();
    assert_eq!(w.cancel(m, c, seq(&resting)), Ok(()));
    assert_eq!(w.markets[m].book.open_interest, 150, "cancels never move OI");
}

/// H54. A seat loaded with the maximum number of open orders is liquidated in
/// one bounded call: all its orders on the market are cancelled and the
/// takeover proceeds.
#[test]
fn h54_order_clutter_cannot_shield_a_seat_from_liquidation() {
    let mut w = World::new(10, 16);
    let m = w.add_market(perp_params(0));
    let maker = funded(&mut w, 1_000_000);
    let liquidator = funded(&mut w, 1_000_000);
    let target = funded(&mut w, 1_500);
    buy_from(&mut w, m, target, maker, 1000, 10); // fee 30, equity 1_470
    for (i, price) in [990, 980, 970, 960].iter().enumerate() {
        let placed = w.place(m, target, limit(Side::Bid, *price, 1)).unwrap();
        assert_eq!(placed.rested, 1, "order {i}");
    }
    assert_eq!(w.seat(target).open_orders[0], 4, "the per-market maximum");

    w.set_price(m, 890); // equity 370, maintenance 445
    assert!(w.is_liquidatable(target, m));
    let outcome = w.liquidate(m, liquidator, target, 10).unwrap();
    assert_eq!(outcome.status, LiquidationStatus::Liquidated);
    assert_eq!(outcome.orders_cancelled, 4, "every resting order of the target");
    assert_eq!(w.seat(target).open_orders[0], 0);
}

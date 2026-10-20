//! Round-3 red-team attacks on what is new after two fix rounds and the
//! refactor: the H16 bonus cap in `liquidation.rs` (`penalty_per_lot`), the
//! PR-4 stale-liquidator refusal, the price bounds (MAX_PRICE,
//! MAX_OPEN_INTEREST_CAP), the open-interest-as-book-figure publication, and
//! the journal sizing of a liquidation against a target with a full order
//! quota. Each test first tries the exploit; where the defense holds it pins
//! the defensive behavior.

mod common;

use common::*;
use noirwire_orderbook_engine::EngineError as E;
use noirwire_orderbook_engine::*;

fn funded(w: &mut World, collateral: u64) -> u32 {
    let seat = w.open();
    w.deposit(seat, Asset::Collateral, collateral).unwrap();
    seat
}

/// Opens a long of `size` lots at the mark of 1000 for `seat`, `other` taking
/// the other side. Returns the taker fee paid.
fn open_long(w: &mut World, m: usize, seat: u32, other: u32, size: u64) {
    w.place(m, other, limit(Side::Ask, 1000, size)).unwrap();
    let out = w.place(m, seat, ioc(Side::Bid, 1000, size)).unwrap();
    assert_eq!(out.filled, size);
}

/// R3-01. Attack the H16 cap by nibbling: liquidate one lot at a time so the
/// per-lot cap (`equity / lots`) is loose and the full `liq_penalty_bps`
/// applies on every call. If the cap leaked, the summed penalty could exceed
/// the target's equity at the first liquidation, or drag the target negative
/// while it still held a position. It must not: the bonus is bounded by the
/// target's equity, the target never goes below zero from penalties, and the
/// insurance seat only ever receives.
#[test]
fn r3_01_nibbling_liquidation_extracts_at_most_the_targets_equity() {
    let mut params = perp_params(0);
    params.liq_insurance_share_bps = 5_000;
    let mut w = World::new(16, 8);
    let m = w.add_market(params);

    let target = funded(&mut w, 12_000);
    let counter = funded(&mut w, 1_000_000);
    let liquidator = funded(&mut w, 1_000_000);
    open_long(&mut w, m, target, counter, 100);
    assert_eq!(w.collateral(target), 11_700, "300 of taker fee");
    w.set_price(m, 900);
    // equity = 11_700 + 100 * (900 - 1000) = 1_700; maintenance = 4_500.
    let equity_at_start = w.equity(target);
    assert_eq!(equity_at_start, 1_700);
    assert!(w.is_liquidatable(target, m));

    let insurance_before = w.collateral(INSURANCE_SEAT);
    let mut total_penalty = 0u128;
    let mut nibbles = 0u64;
    while w.is_liquidatable(target, m) {
        let insurance_step = w.collateral(INSURANCE_SEAT);
        let out = w.liquidate(m, liquidator, target, 1).unwrap();
        assert_eq!(out.status, LiquidationStatus::Liquidated);
        assert_eq!(out.liquidated, 1, "one lot per nibble");
        assert_eq!(out.price, 891, "full 1% penalty on a rich cap");
        total_penalty += 9;
        nibbles += 1;
        assert!(
            w.equity(target) >= 0,
            "the cap must keep the target non-negative at the mark in use"
        );
        assert!(
            w.collateral(INSURANCE_SEAT) >= insurance_step,
            "insurance never pays while the target can"
        );
    }
    assert_eq!(nibbles, 78, "78 lots restore maintenance exactly");
    assert!(
        total_penalty <= equity_at_start as u128,
        "nibbling cannot beat the cap: {total_penalty} <= {equity_at_start}"
    );
    assert!(w.collateral(INSURANCE_SEAT) >= insurance_before);
    assert_eq!(w.slot(target, m).base, 22, "22 lots survive");
    // One more attempt is a no-op.
    let out = w.liquidate(m, liquidator, target, 1).unwrap();
    assert_eq!(out.status, LiquidationStatus::NotLiquidatable);
}

/// R3-02. The round-1 self-deal, replayed against the cap: the attacker's
/// bankrupt seat is "liquidated" by the attacker's other seat. Before the cap
/// the liquidator was paid a bonus that the insurance seat then covered. Now a
/// bankrupt target pays no bonus: the takeover happens at the mark itself and
/// insurance covers exactly the deficit, no more.
#[test]
fn r3_02_a_bankrupt_self_deal_pays_the_liquidator_nothing() {
    let mut w = World::new(16, 8);
    let m = w.add_market(perp_params(0));

    let loser = funded(&mut w, 10_500);
    let confederate = funded(&mut w, 1_000_000);
    let counter = funded(&mut w, 1_000_000);
    open_long(&mut w, m, loser, counter, 100);
    w.set_price(m, 500);
    assert_eq!(w.equity(loser), -39_800, "bankrupt at the mark");

    // Insurance is funded, so it (not the liquidator) is the one who pays.
    w.deposit(INSURANCE_SEAT, Asset::Collateral, 50_000).unwrap();
    let insurance_before = w.collateral(INSURANCE_SEAT);
    let confederate_before = w.equity(confederate);

    let out = w.liquidate(m, confederate, loser, 100).unwrap();
    assert_eq!(out.status, LiquidationStatus::Liquidated);
    assert_eq!(out.liquidated, 100);
    assert_eq!(out.price, 500, "no penalty: the takeover is at the mark");
    assert_eq!(out.penalty_to_insurance, 0);
    assert_eq!(out.insurance_paid, 39_800, "insurance pays the deficit only");
    assert_eq!(out.uncovered, 0);
    assert_eq!(w.collateral(loser), 0, "made whole, not more");
    assert_eq!(
        w.collateral(INSURANCE_SEAT),
        insurance_before - 39_800
    );
    // The confederate gained nothing at the mark in use: it holds 100 lots
    // bought at the mark.
    assert_eq!(w.equity(confederate), confederate_before);
}

/// R3-03. The cap at its tightest: a target whose whole equity is smaller
/// than the full penalty on its whole position. The liquidation must take the
/// position at a penalty of `equity / lots` per lot, leave the target flat
/// with the remainder, and never touch insurance.
#[test]
fn r3_03_a_tight_cap_leaves_the_target_flat_with_its_remainder() {
    let mut w = World::new(16, 8);
    let m = w.add_market(perp_params(0));

    let target = funded(&mut w, 10_650);
    let counter = funded(&mut w, 1_000_000);
    let liquidator = funded(&mut w, 1_000_000);
    open_long(&mut w, m, target, counter, 100);
    w.set_price(m, 900);
    // equity = 10_350 - 10_000 = 350; full penalty would be 9 per lot, the cap
    // allows floor(350 / 100) = 3.
    assert_eq!(w.equity(target), 350);

    let liquidator_before = w.equity(liquidator);
    let out = w.liquidate(m, liquidator, target, u64::MAX).unwrap();
    assert_eq!(out.status, LiquidationStatus::Liquidated);
    assert_eq!(out.liquidated, 100, "the whole position: nothing restores it");
    assert_eq!(out.price, 897, "capped at 3 per lot, not 9");
    assert_eq!(w.collateral(target), 50, "the target keeps the rounding down");
    assert_eq!(out.insurance_paid, 0);
    assert_eq!(out.uncovered, 0);
    assert_eq!(w.equity(liquidator), liquidator_before + 300);
    assert_eq!(w.collateral(INSURANCE_SEAT), 0, "insurance untouched");
}

/// R3-04. PR-4: a liquidator holding a position on a market whose feed is
/// older than that market's `max_age_liquidation` is refused as StalePrice and
/// changes nothing, even though the market being liquidated is fresh and the
/// target is genuinely below maintenance. At exactly `max_age_liquidation`
/// seconds the same call succeeds. And a TARGET whose other-market feed is
/// stale does not block: the rules value the target's other positions at their
/// last price on purpose.
#[test]
fn r3_04_a_stale_liquidator_is_refused_and_a_stale_target_market_is_not() {
    let mut w = World::new(16, 8);
    let a = w.add_market(perp_params(0));
    let b = w.add_market(perp_params(1));
    let target = funded(&mut w, 12_000);
    let counter = funded(&mut w, 2_000_000);
    let liquidator = funded(&mut w, 1_000_000);
    open_long(&mut w, a, target, counter, 100);
    // The liquidator holds a position on market B.
    w.place(b, counter, limit(Side::Ask, 1000, 10)).unwrap();
    let out = w.place(b, liquidator, ioc(Side::Bid, 1000, 10)).unwrap();
    assert_eq!(out.filled, 10);

    // 301 seconds pass: both feeds are past max_age_liquidation (300).
    w.now += 301;
    // Market A's feed is refreshed at the crashed price; B stays stale.
    w.set_price(a, 900);
    assert!(w.is_liquidatable(target, a));

    let out = w.liquidate(a, liquidator, target, 100).unwrap();
    assert_eq!(
        out.status,
        LiquidationStatus::StalePrice,
        "the liquidator's stale market B position blocks the takeover"
    );

    // At exactly the boundary the refusal lapses.
    w.set_price(b, 1000);
    w.set_price(a, 900);
    w.now += 300;
    w.set_price(a, 900);
    let out = w.liquidate(a, liquidator, target, 100).unwrap();
    assert_eq!(
        out.status,
        LiquidationStatus::Liquidated,
        "both feeds exactly at max_age_liquidation still liquidate"
    );

    // Variant: the TARGET's stale other-market position does not block.
    let mut w = World::new(16, 8);
    let a = w.add_market(perp_params(0));
    let b = w.add_market(perp_params(1));
    let target = funded(&mut w, 12_000);
    let counter = funded(&mut w, 2_000_000);
    let liquidator = funded(&mut w, 1_000_000);
    open_long(&mut w, a, target, counter, 100);
    open_long(&mut w, b, target, counter, 10);
    w.now += 301;
    w.set_price(a, 900);
    let out = w.liquidate(a, liquidator, target, 100).unwrap();
    assert_eq!(
        out.status,
        LiquidationStatus::Liquidated,
        "the target's stale market B feed is valued at its last price"
    );
}

/// R3-05. The open-interest cap at its edge: a fill may land exactly on the
/// cap, never above it; after the cap is lowered below the live open interest
/// (an admin shrink), reducing fills and liquidations still work and only
/// growth is refused.
#[test]
fn r3_05_the_open_interest_cap_bites_exactly_and_a_shrink_only_stops_growth() {
    let mut params = perp_params(0);
    params.open_interest_cap = 100;
    let mut w = World::new(16, 8);
    let m = w.add_market(params);
    let a = funded(&mut w, 10_000_000);
    let b = funded(&mut w, 8_000);
    let c = funded(&mut w, 10_000_000);
    let liquidator = funded(&mut w, 10_000_000);

    open_long(&mut w, m, b, a, 60);
    assert_eq!(w.markets[m].book.open_interest, 60);

    // One lot above the cap: refused as a fill check, nothing filled.
    w.place(m, a, limit(Side::Ask, 1000, 41)).unwrap();
    let out = w.place(m, c, ioc(Side::Bid, 1000, 41)).unwrap();
    assert_eq!(out.filled, 0);
    assert_eq!(out.status, PlaceStatus::RemainderCancelledFillCheck);
    assert_eq!(w.markets[m].book.open_interest, 60);
    w.cancel_all(m, a, 32).unwrap();

    // Exactly to the cap: allowed.
    open_long(&mut w, m, c, a, 40);
    assert_eq!(w.markets[m].book.open_interest, 100);

    // The admin lowers the cap below the live figure.
    w.markets[m].params.open_interest_cap = 50;
    w.check_invariants();

    // Growth is refused, reduction and liquidation still work.
    w.place(m, a, limit(Side::Ask, 1000, 1)).unwrap();
    let out = w.place(m, c, ioc(Side::Bid, 1000, 1)).unwrap();
    assert_eq!(out.filled, 0);
    assert_eq!(out.status, PlaceStatus::RemainderCancelledFillCheck);
    w.place(m, b, limit(Side::Ask, 1000, 10)).unwrap();
    let out = w.place(m, a, ioc(Side::Bid, 1000, 10)).unwrap();
    assert_eq!(out.filled, 10, "reducing past a shrunk cap is fine");
    assert_eq!(w.markets[m].book.open_interest, 90);

    // A liquidation moves open interest sideways: allowed above the cap.
    w.set_price(m, 500);
    assert!(w.is_liquidatable(b, m), "b is bankrupt: 7_820 - 25_000");
    let before = w.markets[m].book.open_interest;
    let out = w.liquidate(m, liquidator, b, 50).unwrap();
    assert_eq!(out.status, LiquidationStatus::Liquidated);
    assert_eq!(
        w.markets[m].book.open_interest,
        before,
        "a takeover moves longs between seats, it does not grow them"
    );
}

/// R3-06. The price bound at its edge: `MAX_PRICE` itself is accepted and the
/// market still trades, settles funding and liquidates there; one atom above
/// is refused whoever sets it, oracle or admin, and changes nothing.
#[test]
fn r3_06_max_price_is_the_edge_on_both_sides() {
    let mut params = perp_params(0);
    params.tick = 1;
    let mut w = World::new(16, 8);
    let m = w.add_market(params);
    let loser = funded(&mut w, 9_000_000_000);
    let winner = funded(&mut w, 1 << 60);
    let liquidator = funded(&mut w, 1 << 60);

    w.now += 1;
    let at = w.now;
    assert_eq!(w.publish(m, MAX_PRICE + 1, at), Err(E::PriceTooHigh));
    assert_eq!(w.reset(m, MAX_PRICE + 1, at), Err(E::PriceTooHigh));
    // The move limit, not the bound, stops an ordinary publish that far away.
    assert_eq!(w.publish(m, MAX_PRICE, at), Err(E::PriceMoveTooLarge));

    // The admin's reset may jump straight to the edge; the market then works.
    w.reset(m, MAX_PRICE, at).unwrap();
    assert_eq!(w.markets[m].price.price, MAX_PRICE);
    assert_eq!(
        w.markets[m].params.status,
        STATUS_REDUCE_ONLY,
        "a reset leaves the market reduce-only"
    );

    // A trade at the edge: the band is measured from MAX_PRICE. The loser
    // buys 2 lots at one atom below the mark; im 10% of that notional is
    // about 6.9e9, within the funding.
    w.markets[m].params.status = STATUS_ACTIVE;
    let price = MAX_PRICE - 1; // on tick 1, inside the outer band
    w.place(m, winner, limit(Side::Ask, price, 2)).unwrap();
    let out = w.place(m, loser, ioc(Side::Bid, price, 2)).unwrap();
    assert_eq!(out.filled, 2);

    // Liquidation math at the edge: halve the mark (a reset again) so the
    // loser is bankrupt, and take the position over.
    w.now += 1;
    w.reset(m, MAX_PRICE / 2, w.now).unwrap();
    assert!(w.is_liquidatable(loser, m));
    let out = w.liquidate(m, liquidator, loser, 2).unwrap();
    assert_eq!(out.status, LiquidationStatus::Liquidated);
    assert_eq!(out.liquidated, 2);
}

/// R3-07. After a restore-size liquidation the target must be healthy: the H16
/// cap only ever makes the target pay LESS, so the size that restores margin
/// at the full penalty restores it at the capped one too. If this failed, a
/// liquidator could farm the same account again immediately.
#[test]
fn r3_07_a_restore_size_takeover_leaves_the_target_healthy() {
    let mut w = World::new(16, 8);
    let m = w.add_market(perp_params(0));
    let target = funded(&mut w, 12_000);
    let counter = funded(&mut w, 1_000_000);
    let liquidator = funded(&mut w, 1_000_000);
    open_long(&mut w, m, target, counter, 100);
    w.set_price(m, 900);

    let out = w.liquidate(m, liquidator, target, u64::MAX).unwrap();
    assert_eq!(out.status, LiquidationStatus::Liquidated);
    assert_eq!(out.liquidated, 78, "exactly the restoring size");
    assert!(
        !w.is_liquidatable(target, m),
        "restored: no second bite at the same mark"
    );
}

/// R3-08. Journal sizing: the target holds its full quota of open orders on
/// both sides (16 bids + 16 asks under `max_open_orders = 32`) plus the
/// position being liquidated. One liquidation must cancel all 32 orders with
/// the three journal entries it is allowed (target, liquidator, insurance).
#[test]
fn r3_08_liquidating_a_full_order_quota_fits_the_journal() {
    let mut w = World::new(16, 32);
    let m = w.add_market(deployed_perp(0));
    w.set_price(m, DEPLOYED_MARK);
    let target = funded(&mut w, 20_000_000);
    let counter = funded(&mut w, 1_000_000_000);
    let liquidator = funded(&mut w, 20_000_000);

    // 1000 lots long at the deployed mark of 150_000 (min_notional is 1e6, so
    // orders of 7 lots or more).
    w.place(m, counter, limit(Side::Ask, DEPLOYED_MARK, 1000))
        .unwrap();
    let out = w
        .place(m, target, ioc(Side::Bid, DEPLOYED_MARK, 1000))
        .unwrap();
    assert_eq!(out.filled, 1000);
    // The full quota: 16 bids below, 16 asks above, all inside the band.
    for k in 1..=16u64 {
        w.place(m, target, limit(Side::Bid, DEPLOYED_MARK - k * 100, 7))
            .unwrap();
        w.place(m, target, limit(Side::Ask, DEPLOYED_MARK + k * 100, 7))
            .unwrap();
    }
    assert_eq!(w.seat(target).open_orders[0], 32);

    // Crash the mark by a third: the target is bankrupt.
    w.set_price(m, 100_000);
    assert!(w.is_liquidatable(target, m));
    let out = w.liquidate(m, liquidator, target, 1000).unwrap();
    assert_eq!(out.status, LiquidationStatus::Liquidated);
    assert_eq!(out.liquidated, 1000);
    assert_eq!(out.orders_cancelled, 32, "every resting order released");
    assert_eq!(out.price, 100_000, "bankrupt: no bonus");
    // The fee share insurance earned (37_500) goes to the deficit first.
    assert_eq!(out.insurance_paid, 37_500);
    assert_eq!(out.uncovered, 30_037_500);
    assert_eq!(w.seat(target).open_orders[0], 0);
    assert_eq!(w.markets[m].book.bid_count, 0);
    assert_eq!(w.markets[m].book.ask_count, 0);
}

/// R3-09. The dust rule: a requested size that would leave less than
/// `min_size` behind takes the whole position instead, at the capped penalty.
/// A liquidator cannot leave a deliberate dust position that is too small to
/// liquidate profitably later.
#[test]
fn r3_09_a_takeover_may_not_leave_dust() {
    let mut params = perp_params(0);
    params.min_size = 10;
    let mut w = World::new(16, 8);
    let m = w.add_market(params);
    let target = funded(&mut w, 2_975);
    let counter = funded(&mut w, 1_000_000);
    let liquidator = funded(&mut w, 1_000_000);
    open_long(&mut w, m, target, counter, 25);
    w.set_price(m, 900);
    // equity = 2_900 + 25 * (900 - 1000) = 400; maintenance = 1_125.
    assert_eq!(w.equity(target), 400);

    let out = w.liquidate(m, liquidator, target, 20).unwrap();
    assert_eq!(out.status, LiquidationStatus::Liquidated);
    assert_eq!(
        out.liquidated, 25,
        "20 requested, but 5 lots of dust may not remain"
    );
    assert_eq!(w.slot(target, m).base, 0);
}

/// R3-10. Open interest as the book's own figure: a liquidator who already
/// holds the offsetting side shrinks the total by exactly the overlap, and the
/// book's figure matches the sum of longs seat by seat. This is the number
/// `Stats.open_interest` publishes after every trade and liquidation.
#[test]
fn r3_10_a_takeover_offsets_the_liquidators_own_position_in_open_interest() {
    let mut w = World::new(16, 8);
    let m = w.add_market(perp_params(0));
    let target = funded(&mut w, 12_000);
    let counter = funded(&mut w, 1_000_000);
    let backstop = funded(&mut w, 1_000_000);
    let liquidator = funded(&mut w, 1_000_000);
    open_long(&mut w, m, target, counter, 100);
    // The liquidator shorts 30 against a fresh long, so open interest grows.
    w.place(m, backstop, limit(Side::Bid, 1000, 30)).unwrap();
    let out = w.place(m, liquidator, ioc(Side::Ask, 1000, 30)).unwrap();
    assert_eq!(out.filled, 30);
    assert_eq!(w.markets[m].book.open_interest, 130);

    w.set_price(m, 900);
    let out = w.liquidate(m, liquidator, target, 40).unwrap();
    assert_eq!(out.status, LiquidationStatus::Liquidated);
    assert_eq!(out.liquidated, 40);
    // Target 100 -> 60 long; liquidator -30 -> +10. Longs: 60 + 10 + 30.
    assert_eq!(w.slot(liquidator, m).base, 10);
    assert_eq!(w.markets[m].book.open_interest, 100);
    let longs: i128 = w
        .seats
        .iter()
        .map(|seat| i128::from(seat.perp[0].base.max(0)))
        .sum();
    assert_eq!(i128::from(w.markets[m].book.open_interest), longs);
}

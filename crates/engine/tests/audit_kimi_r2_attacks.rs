//! Round-2 red-team attacks of kimi's own design (not replays). Each test
//! asserts the defensive behavior where the defense is claimed, and
//! demonstrates the hole where one was found. Results are logged in
//! scratchpad/audit/kimi-hunt.md.

mod common;

use common::*;
use noirwire_orderbook_engine::EngineError as E;
use noirwire_orderbook_engine::*;

fn funded(w: &mut World, collateral: u64) -> u32 {
    let seat = w.open();
    w.deposit(seat, Asset::Collateral, collateral).unwrap();
    seat
}

/// R2-01. The shortfall freeze (RULES 6: a recorded shortfall stops collateral
/// withdrawals) has a hole the size of the collateral mint's spot pool.
///
/// On-chain, `transfer_between_balances` exists precisely for the collateral
/// mint registered at a second token index sharing the one custody account
/// (`require_collateral_custody`). While healthy, the attacker moves excess
/// collateral into that spot pool (margin-checked then). Once a liquidation
/// records an uncovered shortfall, `withdraw` refuses `Asset::Collateral` for
/// everyone but still pays out `Asset::Spot` with no margin and no shortfall
/// check (seats.rs), and the tokens leave the shared custody account.
#[test]
fn r2_01_shortfall_freeze_is_evadable_through_the_collateral_mint_spot_pool() {
    let mut w = World::new(16, 8);
    let m = w.add_market(perp_params(0));

    let attacker = funded(&mut w, 100_000);
    let victim = funded(&mut w, 100_000);
    let loser = funded(&mut w, 10_500);
    let counter = funded(&mut w, 1_000_000);

    // The attacker keeps 90% of funds in the collateral mint's spot pool.
    // On-chain this is transfer_between_balances(to_collateral = false).
    w.withdraw(attacker, Asset::Collateral, 90_000).unwrap();
    w.deposit(attacker, Asset::Spot(0), 90_000).unwrap();
    fn shared_custody(w: &World) -> i128 {
        w.custody_collateral + w.custody_spot[0] as i128
    }
    let custody_before = shared_custody(&w);

    // A crash bankrupts `loser`; insurance is empty, so the loss is recorded.
    w.place(m, counter, limit(Side::Ask, 1000, 100)).unwrap();
    assert_eq!(w.place(m, loser, ioc(Side::Bid, 1000, 100)).unwrap().filled, 100);
    w.set_price(m, 500);
    let outcome = w.liquidate(m, counter, loser, 100).unwrap();
    assert_eq!(outcome.status, LiquidationStatus::Liquidated);
    assert_eq!(w.collateral(loser), -40_300);
    assert_eq!(outcome.insurance_paid, 0);
    assert_eq!(outcome.uncovered, 40_300);
    assert_eq!(w.markets[m].params.uncovered_shortfall, 40_300);

    // The freeze is on for collateral, for attacker and victim alike.
    assert_eq!(
        w.withdraw(attacker, Asset::Collateral, 1),
        Err(E::ShortfallOutstanding)
    );
    assert_eq!(
        w.withdraw(victim, Asset::Collateral, 1),
        Err(E::ShortfallOutstanding)
    );

    // ...but the attacker exits through the spot pool of the same mint.
    w.withdraw(attacker, Asset::Spot(0), 90_000).unwrap();
    assert_eq!(w.custody_spot[0], 0);
    assert_eq!(shared_custody(&w), custody_before - 90_000);

    // What is left in the shared custody is 40_300 short of the positive
    // claims on it: the frozen users absorb the bankrupt seat's debt, and
    // every atom the attacker drained widens their loss.
    let positive_collateral: i128 = w
        .seats
        .iter()
        .filter(|seat| seat.is_open())
        .map(|seat| i128::from(seat.collateral.max(0)))
        .sum();
    let spot_claims: i128 = w
        .seats
        .iter()
        .map(|seat| {
            i128::from(seat.spot[0].available) + i128::from(seat.spot[0].locked)
        })
        .sum();
    assert_eq!(
        positive_collateral + spot_claims - shared_custody(&w),
        40_300,
        "the debt falls on whoever is still frozen"
    );
}

/// R2-02. At extreme but allowed settings (no bound anywhere on the mark or on
/// open_interest_cap; max_move_bps may be 10_000, so the feed may legally move
/// 10x per publish), `size * mark * mm_bps` overflows i128 inside
/// `margin_times_bps`. From that moment the position can never be liquidated
/// (the error surfaces as `NotLiquidatable`), nobody holding it can withdraw
/// (meets_initial_margin errors) and resting liquidity at old prices is
/// uncrossable (band re-check cancels it), so the market is frozen with a
/// bankrupt account in it.
#[test]
fn r2_02_margin_overflow_locks_liquidation_withdrawal_and_closing() {
    let mut params = perp_params(0);
    params.tick = 1;
    params.im_bps = 10_000;
    params.mm_bps = 9_999;
    params.liq_penalty_bps = 1;
    params.taker_fee_bps = 1;
    params.band_bps = 1;
    params.funding_cap_bps = 1;
    params.max_move_bps = 9_000;
    params.open_interest_cap = 1 << 62;
    params.check().unwrap();

    let mut w = World::new(16, 8);
    let m = w.add_market(params);
    let rich = 4_600_000_000_000_000_000u64; // just under BALANCE_CAP
    let loser = funded(&mut w, rich);
    let winner = funded(&mut w, rich);
    let liquidator = funded(&mut w, rich);
    let maker = funded(&mut w, 1_000_000);

    // Loser shorts 4e15 lots at 1000 (notional 4e18, 100% initial margin).
    w.place(m, winner, limit(Side::Bid, 1000, 4_000_000_000_000_000)).unwrap();
    let opened = w
        .place(m, loser, ioc(Side::Ask, 1000, 4_000_000_000_000_000))
        .unwrap();
    assert_eq!(opened.filled, 4_000_000_000_000_000);
    assert_eq!(w.slot(loser, m).base, -4_000_000_000_000_000);
    // A third seat leaves one resting ask at the old mark, for later.
    w.place(m, maker, limit(Side::Ask, 1000, 1)).unwrap();

    // The feed moves to 5e18: legal in 16 publishes at max_move_bps = 10_000.
    w.set_price(m, 5_000_000_000_000_000_000);
    assert!(w.equity(loser) < 0, "catastrophically bankrupt");

    // Liquidation reports NotLiquidatable forever: below_maintenance overflows.
    let attempt = w.liquidate(m, liquidator, loser, 1_000).unwrap();
    assert_eq!(attempt.status, LiquidationStatus::NotLiquidatable);
    assert_eq!(attempt.liquidated, 0);

    // The winning side cannot withdraw one atom either.
    assert_eq!(
        w.withdraw(winner, Asset::Collateral, 1),
        Err(E::MathOverflow)
    );

    // The loser cannot close: the only resting ask is at the old mark and the
    // band re-check cancels it rather than filling it.
    let close = w
        .place(
            m,
            loser,
            reduce_only(ioc(Side::Bid, 5_000_000_000_000_000_000, 4_000_000_000_000_000)),
        )
        .unwrap();
    assert_eq!(close.filled, 0);
    assert_eq!(w.slot(loser, m).base, -4_000_000_000_000_000);

    // It is the arithmetic, not a flag: back at a mark where the multiplication
    // fits, liquidation works again.
    w.set_price(m, 2_000);
    let saved = w.liquidate(m, liquidator, loser, 1_000_000_000_000_000).unwrap();
    assert_eq!(saved.status, LiquidationStatus::Liquidated);
    assert_eq!(saved.liquidated, 1_000_000_000_000_000);
}

/// R2-03. New RULES 3.8 eviction: cycling one better-priced order keeps a
/// victim's order off a full side forever at zero cost (the evictor's lock
/// comes back on cancel, the victim's on eviction). Perp variant: no lock at
/// all, so the cycle costs exactly nothing.
#[test]
fn r2_03_eviction_churn_denies_the_worst_slot_at_zero_cost() {
    let mut w = World::new(16, 4);
    let m = w.add_market(perp_params(0));
    let victim = funded(&mut w, 1_000_000);
    let attacker = funded(&mut w, 1_000_000);
    let victim_collateral_before = w.collateral(victim);
    let attacker_collateral_before = w.collateral(attacker);

    for _cycle in 0..5 {
        for (i, price) in [1000, 1010, 1020, 1030].into_iter().enumerate() {
            let already = w.markets[m].book.bid_count as usize;
            if already < 4 || i > 0 {
                // refill only what is missing; the victim re-places 1000
                w.place(m, victim, limit(Side::Bid, price, 1)).ok();
            }
        }
        assert_eq!(w.markets[m].book.bid_count, 4, "side is full");
        // The attacker evicts the worst (the victim's 1000) with one tick better... 
        let out = w.place(m, attacker, limit(Side::Bid, 1040, 1)).unwrap();
        assert_eq!(out.status, PlaceStatus::Rested);
        assert_eq!(w.seat(victim).open_orders[0], 3, "victim evicted");
        // ...and cancels immediately, getting everything back.
        w.cancel(m, attacker, seq(&out)).unwrap();
        assert_eq!(w.seat(attacker).open_orders[0], 0);
    }
    assert_eq!(w.collateral(victim), victim_collateral_before);
    assert_eq!(w.collateral(attacker), attacker_collateral_before);

    // Spot variant: the evicted bid's lock is released exactly, so the victim
    // keeps every atom; the grief is queue position, not funds.
    let s = w.add_market(spot_params(1));
    w.deposit(victim, Asset::Spot(QUOTE), 1_000_000).unwrap();
    w.deposit(attacker, Asset::Spot(QUOTE), 1_000_000).unwrap();
    for price in [1000, 1010, 1020, 1030] {
        w.place(s, victim, limit(Side::Bid, price, 1)).unwrap();
    }
    let locked_before = w.spot(victim, QUOTE).locked;
    let available_before = w.spot(victim, QUOTE).available;
    let out = w.place(s, attacker, limit(Side::Bid, 1040, 1)).unwrap();
    assert_eq!(out.status, PlaceStatus::Rested);
    let released = bid_lock(1000, 1, 30) as u64;
    assert_eq!(w.spot(victim, QUOTE).locked, locked_before - released);
    assert_eq!(w.spot(victim, QUOTE).available, available_before + released);
}

/// R2-04. Eviction of an EXPIRED order sitting in the middle of a full side
/// (evicted index on both sides of the insert position) must keep the side
/// sorted, the counts exact and the evicted seat's state consistent.
#[test]
fn r2_04_evicting_an_expired_order_from_mid_side_keeps_the_book_exact() {
    let mut w = World::new(16, 8);
    let m = w.add_market(perp_params(0));
    let owners: Vec<u32> = (0..8).map(|_| funded(&mut w, 1_000_000)).collect();

    // Case A: the expired order (1040, index 4) sits above the insert point.
    // Bids cannot pass 1050 (band 500 bps around the mark of 1000), so three
    // orders share 1050 to fill the side.
    let prices = [1000, 1010, 1020, 1030, 1040, 1050, 1050, 1050];
    for (i, owner) in owners.iter().enumerate() {
        let order = if i == 4 {
            expiring(limit(Side::Bid, prices[i], 1), START + 10)
        } else {
            limit(Side::Bid, prices[i], 1)
        };
        w.place(m, *owner, order).unwrap();
    }
    w.now += 11;
    let out = w.place(m, owners[1], limit(Side::Bid, 1010, 1)).unwrap();
    assert_eq!(out.status, PlaceStatus::Rested, "evicts the expired 1040");
    assert_eq!(w.markets[m].book.bid_count, 8);
    let prices: Vec<u64> = w.markets[m].live(Side::Bid).iter().map(|o| o.price).collect();
    assert_eq!(prices, vec![1000, 1010, 1010, 1020, 1030, 1050, 1050, 1050]);
    assert_eq!(w.seat(owners[4]).open_orders[0], 0, "evicted owner released");

    // Case B: the expired order is the worst one (index 0), the new price
    // inserts near the top: evicted index below the insert point.
    let mut w = World::new(16, 8);
    let m = w.add_market(perp_params(0));
    let owners: Vec<u32> = (0..8).map(|_| funded(&mut w, 1_000_000)).collect();
    let prices = [1000, 1010, 1020, 1030, 1040, 1050, 1050, 1050];
    for (i, owner) in owners.iter().enumerate() {
        let order = if i == 0 {
            expiring(limit(Side::Bid, prices[i], 1), START + 10)
        } else {
            limit(Side::Bid, prices[i], 1)
        };
        w.place(m, *owner, order).unwrap();
    }
    w.now += 11;
    let out = w.place(m, owners[7], limit(Side::Bid, 1050, 1)).unwrap();
    assert_eq!(out.status, PlaceStatus::Rested);
    let prices: Vec<u64> = w.markets[m].live(Side::Bid).iter().map(|o| o.price).collect();
    assert_eq!(prices, vec![1010, 1020, 1030, 1040, 1050, 1050, 1050, 1050]);
    assert_eq!(w.seat(owners[0]).open_orders[0], 0);
}

/// R2-05. Rounding drift hunt: two accounts churn thousands of odd-sized fills
/// in both directions, on spot (locks with per-fill ceil fees) and perp
/// (funding settles in between). The harness re-checks custody, locks and
/// every margin invariant after each call; the end state must be exactly
/// closable with nothing trapped.
#[test]
fn r2_05_two_thousand_uneven_fills_leave_no_rounding_drift() {
    let mut w = World::new(16, 16);
    let s = w.add_market(spot_params(0));
    let p = w.add_market(perp_params(1));
    let maker = w.open();
    let taker = w.open();
    w.deposit(maker, Asset::Spot(QUOTE), 50_000_000).unwrap();
    w.deposit(taker, Asset::Spot(BASE), 5_000_000_000).unwrap();
    w.deposit(maker, Asset::Collateral, 50_000_000).unwrap();
    w.deposit(taker, Asset::Collateral, 50_000_000).unwrap();

    for i in 0..2_000u64 {
        let price = 990 + 10 * (i % 5); // 990..1030
        let size = 1 + (i * 37) % 7;
        match i % 4 {
            0 => {
                w.place(s, maker, limit(Side::Bid, price, size)).unwrap();
                w.place(s, taker, ioc(Side::Ask, price, size + 1)).unwrap();
            }
            1 => {
                w.place(s, taker, limit(Side::Ask, price, size)).unwrap();
                w.place(s, maker, ioc(Side::Bid, price, size + 2)).unwrap();
            }
            2 => {
                w.place(p, maker, limit(Side::Bid, price, size)).unwrap();
                w.place(p, taker, ioc(Side::Ask, price, size)).unwrap();
            }
            _ => {
                w.place(p, taker, limit(Side::Ask, price, size)).unwrap();
                w.place(p, maker, ioc(Side::Bid, price, size)).unwrap();
            }
        }
        if i % 25 == 24 {
            let _ = w.cancel_all(s, maker, 32);
            let _ = w.cancel_all(s, taker, 32);
            let _ = w.cancel_all(p, maker, 32);
            let _ = w.cancel_all(p, taker, 32);
        }
        if i % 100 == 99 {
            w.now += 3_600;
            w.set_price(p, 1000);
            w.fund(p).unwrap();
            w.set_price(s, 1000);
        }
    }

    // Close both perp positions flat and empty the books.
    let _ = w.cancel_all(s, maker, 32);
    let _ = w.cancel_all(s, taker, 32);
    let _ = w.cancel_all(p, maker, 32);
    let _ = w.cancel_all(p, taker, 32);
    let maker_base = w.slot(maker, p).base;
    let taker_base = w.slot(taker, p).base;
    assert_eq!(maker_base, -taker_base, "RULES 13.6");
    if maker_base != 0 {
        let (closer, closer_side, other, other_side) = if maker_base > 0 {
            (maker, Side::Ask, taker, Side::Bid)
        } else {
            (maker, Side::Bid, taker, Side::Ask)
        };
        let size = maker_base.unsigned_abs();
        w.place(p, closer, limit(closer_side, 1000, size)).unwrap();
        let out = w.place(p, other, ioc(other_side, 1000, size)).unwrap();
        assert_eq!(out.filled, size);
    }
    assert_eq!(w.slot(maker, p).base, 0);
    assert_eq!(w.slot(taker, p).base, 0);
    assert_eq!(w.slot(maker, p).quote, 0);
    assert_eq!(w.slot(taker, p).quote, 0);
    assert_eq!(w.markets[p].book.open_interest, 0);

    // Everything withdrawable, nothing trapped: the whole book can wind down.
    for seat in [maker, taker] {
        for token in [QUOTE, BASE] {
            let available = w.spot(seat, token).available;
            if available > 0 {
                w.withdraw(seat, Asset::Spot(token), available).unwrap();
            }
        }
        assert_eq!(w.spot(seat, QUOTE).locked, 0);
        assert_eq!(w.spot(seat, BASE).locked, 0);
    }
}

/// R2-06. Coalition attack on the new funding formula: the attacker is the
/// whole short side (Q = OI = 1000 lots, the best possible case), and two
/// colluding seats wash just over the volume-damping threshold
/// (V > OI * K * cap * interval / (fee * period)) at the band top every
/// interval, pinning funding at the cap. Eight intervals: the funding the
/// coalition collects must be weighed against the taker fees the wash burns.
/// The fee margin K = 4 is what should make this a loss.
#[test]
fn r2_06_coalition_wash_cannot_make_funding_profitable() {
    let mut w = World::new(16, 16);
    let m = w.add_market(perp_params(0));
    let attacker = funded(&mut w, 10_000_000); // the whole short side
    let honest_a = funded(&mut w, 10_000_000);
    let honest_b = funded(&mut w, 10_000_000);
    let wash1 = funded(&mut w, 10_000_000);
    let wash2 = funded(&mut w, 10_000_000);
    let coalition = [attacker, wash1, wash2];
    let net = |w: &World| coalition.iter().map(|s| w.equity(*s)).sum::<i128>();

    // Honest longs 1000; attacker shorts the whole 1000 at the mark.
    w.place(m, honest_a, limit(Side::Bid, 1000, 500)).unwrap();
    w.place(m, honest_b, limit(Side::Bid, 1000, 500)).unwrap();
    assert_eq!(w.place(m, attacker, ioc(Side::Ask, 1000, 1000)).unwrap().filled, 1000);
    let start = net(&w);

    for _ in 0..8 {
        // Wash 834 lots (> 0.833 * OI) at the band top, flat by round-tripping.
        w.place(m, wash1, limit(Side::Ask, 1050, 417)).unwrap();
        assert_eq!(w.place(m, wash2, ioc(Side::Bid, 1050, 417)).unwrap().filled, 417);
        w.place(m, wash2, limit(Side::Ask, 1050, 417)).unwrap();
        assert_eq!(w.place(m, wash1, ioc(Side::Bid, 1050, 417)).unwrap().filled, 417);
        w.now += 3_600;
        w.set_price(m, 1000);
        assert_eq!(w.fund(m), Ok(true));
    }
    // Funding moved at the cap: 1000 * 50bps * 3600/28800 = 0.625 atoms per
    // lot per interval, so 5 atoms per lot over eight intervals.
    assert_eq!(w.funding_units(m) / FUNDING_CARRY_SCALE, 5);
    let collected = 1_000 * 5; // the attacker's short collects 5 per lot
    let spent = start - net(&w);
    assert!(
        spent > collected,
        "the wash burned {spent} to collect {collected}: fee margin K=4 keeps it a loss"
    );
}

/// R2-07. Reduce-only on a stale feed (RULES 9 lets it through) must still be
/// refused when, filled in full, it would leave same-side resting orders
/// standing alone and so raise the worst-case size.
#[test]
fn r2_07_reduce_only_on_a_stale_feed_still_respects_the_grows_guard() {
    let mut w = World::new(16, 16);
    let m = w.add_market(perp_params(0));
    let seat = funded(&mut w, 1_000_000);
    let other = funded(&mut w, 1_000_000);

    w.place(m, other, limit(Side::Ask, 1000, 10)).unwrap();
    assert_eq!(w.place(m, seat, ioc(Side::Bid, 1000, 10)).unwrap().filled, 10);
    // Fifteen resting asks: worst case short 15 - 10 = 5, long 10.
    w.place(m, seat, limit(Side::Ask, 1010, 15)).unwrap();
    w.now += 61; // feed stale (max_price_age 60)

    // Closing all 10 would leave the 15 asks naked: worst case 15 > 10.
    assert_eq!(
        w.place(m, seat, reduce_only(ioc(Side::Ask, 1000, 10))),
        Err(E::StalePrice),
        "the grows guard still demands a fresh feed"
    );
    // Closing 5 leaves 15 asks against a 5 long: worst case 10, not worse.
    w.place(m, other, limit(Side::Bid, 1000, 5)).unwrap();
    let out = w.place(m, seat, reduce_only(ioc(Side::Ask, 1000, 5))).unwrap();
    assert_eq!(out.filled, 5, "a pure reduction still trades on a stale feed");
    assert_eq!(w.slot(seat, m).base, 5);
}

/// R2-08. Post-only on a full side: may evict and rest like any limit order,
/// and a post-only that would cross is refused with the book byte-identical.
#[test]
fn r2_08_post_only_evicts_on_a_full_side_and_never_leaks_a_cross() {
    let mut w = World::new(16, 4);
    let m = w.add_market(perp_params(0));
    let victim = funded(&mut w, 1_000_000);
    let attacker = funded(&mut w, 1_000_000);
    for price in [1000, 1010, 1020, 1030] {
        w.place(m, victim, limit(Side::Bid, price, 1)).unwrap();
    }
    let out = w.place(m, attacker, post_only(Side::Bid, 1040, 1)).unwrap();
    assert_eq!(out.status, PlaceStatus::Rested, "post-only may evict");
    assert_eq!(w.seat(victim).open_orders[0], 3);

    w.place(m, victim, limit(Side::Ask, 1040, 1)).unwrap();
    let out = w.place(m, attacker, post_only(Side::Bid, 1050, 1)).unwrap();
    assert_eq!(out.status, PlaceStatus::RefusedPostOnlyWouldMatch);
    assert_eq!(out.rested + out.filled, 0);
}

/// R2-09, companion to R2-01: even the bankrupt debtor's own spot tokens are
/// never frozen, never seized and never margin-checked. The seat owes 40,300
/// to the market's record and still walks its spot balance out of the shared
/// custody account.
#[test]
fn r2_09_a_bankrupt_seat_keeps_its_spot_tokens_past_every_freeze() {
    let mut w = World::new(16, 8);
    let m = w.add_market(perp_params(0));
    let loser = funded(&mut w, 10_500);
    let counter = funded(&mut w, 1_000_000);
    w.deposit(loser, Asset::Spot(BASE), 7_777).unwrap();

    w.place(m, counter, limit(Side::Ask, 1000, 100)).unwrap();
    assert_eq!(w.place(m, loser, ioc(Side::Bid, 1000, 100)).unwrap().filled, 100);
    w.set_price(m, 500);
    let outcome = w.liquidate(m, counter, loser, 100).unwrap();
    assert_eq!(outcome.uncovered, 40_300);
    assert_eq!(w.collateral(loser), -40_300);

    assert_eq!(
        w.withdraw(loser, Asset::Collateral, 1),
        Err(E::ShortfallOutstanding),
        "the debtor's collateral is frozen"
    );
    w.withdraw(loser, Asset::Spot(BASE), 7_777).unwrap();
    assert_eq!(w.spot(loser, BASE).available, 0, "but its tokens are not");
}

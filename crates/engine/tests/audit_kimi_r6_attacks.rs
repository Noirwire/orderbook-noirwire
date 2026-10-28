//! Round 6 attacks on the access lists (RULES 3a, 4, 8). One attack per test.
mod common;
use common::*;
use noirwire_orderbook_engine::*;

fn access(maker_markets: u64, taker_markets: u64, blocked: bool) -> SeatAccess {
    SeatAccess {
        maker_markets,
        taker_markets,
        blocked,
    }
}

fn book_orders(w: &World, m: usize, seat: u32) -> Vec<Order> {
    let state = &w.markets[m];
    [Side::Bid, Side::Ask]
        .into_iter()
        .flat_map(|side| state.live(side).to_vec())
        .filter(|order| order.seat == seat)
        .collect()
}

/// R6-01: on a maker-listed market an unlisted seat sends a Limit bid that would
/// partially fill a resting ask and rest the remainder, hoping the crossing part
/// executes before the maker check. The refusal must come before anything moves.
#[test]
fn r6_01_unlisted_maker_limit_that_would_partly_fill_then_rest_is_refused_whole() {
    let (mut w, m) = perp_world(perp_params(0));
    let maker = funded(&mut w, 100_000);
    let attacker = funded(&mut w, 100_000);
    w.set_seat_access(maker, access(0b1, 0, false)).unwrap();
    w.set_market_access(m, true, false).unwrap();
    w.place(m, maker, limit(Side::Ask, 1_000, 2)).unwrap();
    let before = w.bytes();

    let outcome = w.place(m, attacker, limit(Side::Bid, 1_010, 5));
    assert_eq!(outcome, Err(EngineError::MakerNotListed));
    assert_eq!(w.bytes(), before, "the refused order changed state");
    assert_eq!(w.slot(attacker, m).base, 0);
    assert_eq!(book_orders(&w, m, maker).len(), 1);
}

/// R6-02: the lists judge the order's type, not what it would do. On a
/// maker-listed-only market an unlisted seat can cross with an IOC (it can never
/// rest) but a Limit is refused even when it would fill in full; on a
/// taker-listed-only market an unlisted seat's IOC is refused even when the book
/// holds nothing to match, while its PostOnly rests.
#[test]
fn r6_02_refusals_are_type_based_not_book_based() {
    let (mut w, m) = perp_world(perp_params(0));
    let maker = funded(&mut w, 100_000);
    let attacker = funded(&mut w, 100_000);
    w.set_seat_access(maker, access(0b1, 0b1, false)).unwrap();

    // Maker list on, taker list off: IOC crosses, Limit is refused whole.
    w.set_market_access(m, true, false).unwrap();
    w.place(m, maker, limit(Side::Ask, 1_000, 10)).unwrap();
    let before = w.bytes();
    assert_eq!(
        w.place(m, attacker, limit(Side::Bid, 1_000, 2)),
        Err(EngineError::MakerNotListed),
        "a fully crossing Limit still could rest, so it is refused"
    );
    assert_eq!(w.bytes(), before);
    let outcome = w.place(m, attacker, ioc(Side::Bid, 1_000, 2)).unwrap();
    assert_eq!(
        sizes(&outcome),
        (2, 0, 0),
        "an IOC can never rest, so it crosses"
    );
    assert_eq!(w.slot(attacker, m).base, 2);
    w.place(m, attacker, reduce_only(ioc(Side::Ask, 1_000, 2)))
        .unwrap();

    // Taker list on, maker list off: an IOC that matches nothing is still
    // refused; a PostOnly that crosses nothing rests.
    let (mut w2, m2) = perp_world(perp_params(0));
    let po_seat = funded(&mut w2, 100_000);
    let probe = funded(&mut w2, 100_000);
    w2.set_market_access(m2, false, true).unwrap();
    assert_eq!(
        w2.place(m2, probe, ioc(Side::Bid, 1_000, 1)),
        Err(EngineError::TakerNotListed),
        "an IOC could match, whatever the empty book holds"
    );
    let outcome = w2.place(m2, po_seat, post_only(Side::Bid, 990, 1)).unwrap();
    assert_eq!(
        sizes(&outcome),
        (0, 1, 0),
        "a PostOnly can never match, so it rests"
    );
}

/// R6-03: a blocked seat sends an oversized reduce-only sell, hoping to close its
/// long and flip short through the same order. Reduce-only is re-capped to the
/// live position at every fill, so the flip must not happen and nothing may rest.
#[test]
fn r6_03_blocked_seat_cannot_flip_side_with_an_oversized_reduce_only() {
    let (mut w, m) = perp_world(perp_params(0));
    let attacker = funded(&mut w, 100_000);
    let other = funded(&mut w, 100_000);
    let bidder = funded(&mut w, 100_000);
    buy_from(&mut w, m, attacker, other, 1_000, 5);
    assert_eq!(w.slot(attacker, m).base, 5);
    w.set_seat_access(attacker, access(0, 0, true)).unwrap();
    w.place(m, bidder, limit(Side::Bid, 1_000, 20)).unwrap();

    let outcome = w
        .place(m, attacker, reduce_only(limit(Side::Ask, 950, 12)))
        .unwrap();
    assert_eq!(
        sizes(&outcome),
        (5, 0, 7),
        "fills the position, cancels the rest"
    );
    assert_eq!(w.slot(attacker, m).base, 0, "no flip to short");
    assert!(book_orders(&w, m, attacker).is_empty(), "nothing rests");
    assert_eq!(w.slot(bidder, m).base, 5);
}

/// R6-04: RULES 3a says an order left on the book by a switch or a block fills at
/// its old price once its owner may make again, and that an order cancelled by a
/// cleared maker bit never comes back. Try both promises: resurrect a delisted
/// maker's order after relisting, and after unblocking; then check the cleared-bit
/// case stays gone forever.
#[test]
fn r6_04_barred_orders_revive_as_documented_and_cleared_orders_never_do() {
    // A barred order is released when matching reaches it (the premise).
    let (mut w, m) = perp_world(perp_params(0));
    let maker = funded(&mut w, 100_000);
    let taker = funded(&mut w, 100_000);
    w.place(m, maker, limit(Side::Ask, 1_000, 3)).unwrap();
    w.set_market_access(m, true, false).unwrap();
    assert_eq!(
        book_orders(&w, m, maker).len(),
        1,
        "switching the list on cancels nothing"
    );
    let outcome = w.place(m, taker, ioc(Side::Bid, 1_000, 3)).unwrap();
    assert_eq!(sizes(&outcome), (0, 0, 3), "the barred maker cannot fill");
    assert!(book_orders(&w, m, maker).is_empty(), "matching released it");

    // Bullet 3 of RULES 3a: list the seat (bit 0 to 1) before matching reaches
    // the order, and it fills at its old price.
    let (mut w, m) = perp_world(perp_params(0));
    let maker = funded(&mut w, 100_000);
    let taker = funded(&mut w, 100_000);
    w.place(m, maker, limit(Side::Ask, 1_000, 3)).unwrap();
    w.set_market_access(m, true, false).unwrap();
    w.set_seat_access(maker, access(0b1, 0, false)).unwrap();
    let outcome = w.place(m, taker, ioc(Side::Bid, 1_000, 3)).unwrap();
    assert_eq!(
        sizes(&outcome),
        (3, 0, 0),
        "the relisted maker's old order fills"
    );
    assert_eq!(w.slot(taker, m).base, 3);

    // Bullet 1: a blocked seat's orders stay; unblocking revives them.
    let (mut w, m) = perp_world(perp_params(0));
    let maker = funded(&mut w, 100_000);
    let taker = funded(&mut w, 100_000);
    w.place(m, maker, limit(Side::Ask, 1_000, 3)).unwrap();
    w.set_seat_access(maker, access(0, 0, true)).unwrap();
    w.set_seat_access(maker, access(0, 0, false)).unwrap();
    let outcome = w.place(m, taker, ioc(Side::Bid, 1_000, 3)).unwrap();
    assert_eq!(
        sizes(&outcome),
        (3, 0, 0),
        "the unblocked maker's old order fills"
    );

    // The cleared-bit case: cancelled at once, and relisting cannot resurrect it.
    let (mut w, m) = perp_world(perp_params(0));
    let maker = funded(&mut w, 100_000);
    let taker = funded(&mut w, 100_000);
    w.set_seat_access(maker, access(0b1, 0, false)).unwrap();
    w.set_market_access(m, true, false).unwrap();
    w.place(m, maker, limit(Side::Ask, 1_000, 3)).unwrap();
    w.set_seat_access(maker, access(0, 0, false)).unwrap();
    assert!(
        book_orders(&w, m, maker).is_empty(),
        "a cleared bit cancels at once"
    );
    w.set_seat_access(maker, access(0b1, 0, false)).unwrap();
    let outcome = w.place(m, taker, ioc(Side::Bid, 1_000, 3)).unwrap();
    assert_eq!(
        sizes(&outcome),
        (0, 0, 3),
        "relisting does not resurrect the order"
    );
    assert_eq!(w.slot(taker, m).base, 0);
}

/// R6-05: a blocked seat wants the liquidation penalty. It cannot liquidate
/// itself, its owner cannot open a second seat under the same key, and the block
/// check fires before the stale-price outcome. A second seat under a second key is
/// an ordinary seat and liquidates fine: the block is per seat, and keeping one
/// person from re-entering is the gate's job (RULES 3a says so).
#[test]
fn r6_05_blocked_seat_cannot_liquidate_directly_or_by_seat_reuse() {
    let (mut w, m) = perp_world(perp_params(0));
    let maker = funded(&mut w, 100_000);
    let target = funded(&mut w, 1_100);
    buy_from(&mut w, m, target, maker, MARK, 10);
    let blocked = funded(&mut w, 100_000);
    w.set_seat_access(blocked, access(0, 0, true)).unwrap();
    w.set_price(m, 930);
    assert!(w.is_liquidatable(target, m));

    let before = w.bytes();
    assert_eq!(
        w.liquidate(m, blocked, target, 10),
        Err(EngineError::SeatBlocked)
    );
    assert_eq!(w.bytes(), before);

    // The same owner key cannot open a second seat to escape the block.
    assert_eq!(
        w.open_with_key(w.key(blocked)),
        Err(EngineError::SeatAlreadyOpen)
    );

    // The blocked check precedes the freshness outcome: still SeatBlocked on a
    // stale feed, where an unblocked seat gets the StalePrice outcome.
    w.now += 1_000;
    assert_eq!(
        w.liquidate(m, blocked, target, 10),
        Err(EngineError::SeatBlocked)
    );
    let fresh_key_seat = funded(&mut w, 100_000);
    w.set_market_access(m, true, true).unwrap();
    let outcome = w.liquidate(m, fresh_key_seat, target, 10).unwrap();
    assert_eq!(outcome.status, LiquidationStatus::StalePrice);

    // With the feed fresh again, the unlisted second-key seat takes the target
    // over even with both lists on.
    w.set_price(m, 930);
    let outcome = w.liquidate(m, fresh_key_seat, target, 10).unwrap();
    assert_eq!(outcome.status, LiquidationStatus::Liquidated);
    assert!(outcome.liquidated > 0);
    assert_eq!(
        w.slot(fresh_key_seat, m).base.unsigned_abs(),
        outcome.liquidated
    );
}

/// R6-06: a post-only probe against a barred maker. If the would-match refusal
/// read the maker's access, a sender could tell a barred quote from a live one,
/// learning a seat's listing from an outcome. It must behave identically, and the
/// barred quote must still block the price level until someone sweeps it.
#[test]
fn r6_06_post_only_cannot_tell_a_barred_quote_from_a_live_one() {
    let build = |blocked: bool| {
        let (mut w, m) = perp_world(perp_params(0));
        let maker = funded(&mut w, 100_000);
        let prober = funded(&mut w, 100_000);
        w.place(m, maker, limit(Side::Ask, 1_000, 3)).unwrap();
        if blocked {
            w.set_seat_access(maker, access(0, 0, true)).unwrap();
        }
        (w, m, maker, prober)
    };
    let (mut live_w, live_m, _, live_prober) = build(false);
    let (mut dead_w, dead_m, dead_maker, dead_prober) = build(true);

    let live_outcome = live_w
        .place(live_m, live_prober, post_only(Side::Bid, 1_000, 1))
        .unwrap();
    let dead_outcome = dead_w
        .place(dead_m, dead_prober, post_only(Side::Bid, 1_000, 1))
        .unwrap();
    assert_eq!(
        live_outcome, dead_outcome,
        "the outcome hides the maker's access"
    );
    assert_eq!(live_outcome.status, PlaceStatus::RefusedPostOnlyWouldMatch);
    assert_eq!(
        book_orders(&dead_w, dead_m, dead_maker).len(),
        1,
        "a barred quote still holds its price level against post-only orders"
    );

    // Once a taker sweeps the level (releasing the barred quote), the same
    // post-only rests.
    let sweeper = funded(&mut dead_w, 100_000);
    let swept = dead_w
        .place(dead_m, sweeper, ioc(Side::Bid, 1_000, 3))
        .unwrap();
    assert_eq!(
        sizes(&swept),
        (0, 0, 3),
        "the sweep fills nothing, only releases"
    );
    let rested = dead_w
        .place(dead_m, dead_prober, post_only(Side::Bid, 1_000, 1))
        .unwrap();
    assert_eq!(sizes(&rested), (0, 1, 0));
}

/// R6-07: trap attempt. A seat holding a position, a resting order and balances
/// is blocked while both lists are on and it is listed on neither. Every exit must
/// still work: cancel, reduce-only close, deposit, both withdrawals, close.
#[test]
fn r6_07_a_blocked_unlisted_seat_cannot_be_trapped() {
    let (mut w, m) = perp_world(perp_params(0));
    let seller = funded(&mut w, 100_000);
    let seat = funded(&mut w, 10_000);
    w.deposit(seat, Asset::Spot(BASE), 50).unwrap();
    let resting = w.place(m, seat, limit(Side::Bid, 990, 1)).unwrap();
    let resting_seq = seq(&resting);
    buy_from(&mut w, m, seat, seller, 1_000, 4);

    w.set_market_access(m, true, true).unwrap();
    w.set_seat_access(seat, access(0, 0, true)).unwrap();

    w.cancel(m, seat, resting_seq).unwrap();
    assert!(book_orders(&w, m, seat).is_empty());
    w.deposit(seat, Asset::Collateral, 1).unwrap();

    // The close crosses a listed maker's bid; reduce-only skips the lists.
    let counter = funded(&mut w, 100_000);
    w.set_seat_access(counter, access(0b1, 0b1, false)).unwrap();
    w.place(m, counter, limit(Side::Bid, 1_000, 4)).unwrap();
    let outcome = w
        .place(m, seat, reduce_only(ioc(Side::Ask, 980, 4)))
        .unwrap();
    assert_eq!(sizes(&outcome), (4, 0, 0));
    assert_eq!(w.slot(seat, m).base, 0);

    let collateral = w.collateral(seat);
    assert!(collateral > 0);
    w.withdraw(seat, Asset::Collateral, collateral as u64)
        .unwrap();
    w.withdraw(seat, Asset::Spot(BASE), 50).unwrap();
    w.close(seat).unwrap();
    assert!(!w.seat(seat).is_open());
}

/// R6-08: one `set_seat_access` clears a seat's maker bits on three perp markets
/// at once, with the seat holding bids and asks on each and other seats' orders
/// interleaved on every book. Everything of the seat must go, everywhere, in the
/// one call, and every other order must stay in place and in order.
#[test]
fn r6_08_clearing_maker_bits_cancels_across_all_markets_and_keeps_strangers() {
    let mut w = World::new(10, 8);
    let markets: Vec<usize> = (0..3).map(|id| w.add_market(perp_params(id))).collect();
    let seat = funded(&mut w, 1_000_000);
    let stranger = funded(&mut w, 1_000_000);
    w.set_seat_access(seat, access(0b111, 0, false)).unwrap();
    w.set_seat_access(stranger, access(0b111, 0, false))
        .unwrap();
    for (i, &m) in markets.iter().enumerate() {
        w.set_market_access(m, true, false).unwrap();
        w.place(m, stranger, limit(Side::Bid, 980 + i as u64 * 10, 1))
            .unwrap();
        w.place(m, seat, limit(Side::Bid, 990, 2)).unwrap();
        w.place(m, seat, limit(Side::Ask, 1_010, 1)).unwrap();
        w.place(m, stranger, limit(Side::Ask, 1_020, 3)).unwrap();
    }
    let strangers_of = |w: &World, m: usize| {
        let state = &w.markets[m];
        [Side::Bid, Side::Ask]
            .into_iter()
            .flat_map(|side| state.live(side).to_vec())
            .filter(|order| order.seat == stranger)
            .collect::<Vec<_>>()
    };
    let strangers_before: Vec<Vec<Order>> = markets.iter().map(|&m| strangers_of(&w, m)).collect();

    w.set_seat_access(seat, access(0, 0, false)).unwrap();

    for (i, &m) in markets.iter().enumerate() {
        assert!(
            book_orders(&w, m, seat).is_empty(),
            "market {m} still holds an order"
        );
        let slot = w.slot(seat, m);
        assert_eq!((slot.open_bid_lots, slot.open_ask_lots), (0, 0));
        assert_eq!(w.seat(seat).open_orders()[m], 0);
        let now = strangers_of(&w, m);
        assert_eq!(
            now, strangers_before[i],
            "a stranger's orders moved on market {m}"
        );
    }
}

/// R6-09: a barred quote deeper than a taker's limit price. Matching must release
/// an order only when it reaches it; if it swept the whole side (or filled the
/// barred one), the taker would pay for an admin action and the barred seat would
/// lose its quote early. The deep quote must sit untouched, still locking, until a
/// taker's price actually reaches it.
#[test]
fn r6_09_matching_releases_only_the_barred_orders_it_reaches() {
    let (mut w, m) = perp_world(perp_params(0));
    let near = funded(&mut w, 100_000);
    let deep = funded(&mut w, 100_000);
    let taker = funded(&mut w, 100_000);
    w.place(m, deep, limit(Side::Ask, 1_010, 2)).unwrap();
    w.place(m, near, limit(Side::Ask, 1_000, 1)).unwrap();
    w.set_seat_access(deep, access(0, 0, true)).unwrap();
    let lots_before = w.slot(deep, m).open_ask_lots;

    // A taker whose price stops at 1,000 fills the near ask and never touches the
    // barred one.
    let outcome = w.place(m, taker, ioc(Side::Bid, 1_000, 1)).unwrap();
    assert_eq!(sizes(&outcome), (1, 0, 0));
    let deep_orders = book_orders(&w, m, deep);
    assert_eq!(
        deep_orders.len(),
        1,
        "the deep barred quote was swept early"
    );
    assert_eq!(deep_orders[0].remaining, 2);
    assert_eq!(w.slot(deep, m).open_ask_lots, lots_before, "still locked");

    // A taker whose price reaches 1,010 releases it and fills nothing.
    let outcome = w.place(m, taker, ioc(Side::Bid, 1_010, 5)).unwrap();
    assert_eq!(sizes(&outcome), (0, 0, 5));
    assert!(
        book_orders(&w, m, deep).is_empty(),
        "matching reached it and released it"
    );
    assert_eq!(w.slot(deep, m).open_ask_lots, 0);
}

/// R6-10: spot. A blocked seat's resting bid holds a quote lock; a spot market
/// must refuse the list switches, the seat must not place new spot orders, and a
/// sweep that reaches the bid must release it and hand the whole lock back. The
/// seat then withdraws and closes.
#[test]
fn r6_10_blocked_seat_on_spot_is_swept_not_robbed() {
    let mut w = World::new(10, 8);
    let m = w.add_market(spot_params(0));
    let seat = w.open();
    w.deposit(seat, Asset::Spot(QUOTE), 100_000).unwrap();
    w.place(m, seat, limit(Side::Bid, 990, 2)).unwrap();
    let locked = w.spot(seat, QUOTE).locked;
    assert!(locked > 0);

    // Spot takes no lists.
    let before = w.bytes();
    assert_eq!(
        w.set_market_access(m, true, true),
        Err(EngineError::InvalidMarketParams)
    );
    assert_eq!(w.bytes(), before);

    w.set_seat_access(seat, access(0, 0, true)).unwrap();
    assert_eq!(
        w.place(m, seat, limit(Side::Bid, 980, 1)),
        Err(EngineError::SeatBlocked),
        "a blocked seat sends no spot orders"
    );

    let taker = w.open();
    w.deposit(taker, Asset::Spot(BASE), 1_000).unwrap();
    let outcome = w.place(m, taker, ioc(Side::Ask, 990, 2)).unwrap();
    assert_eq!(sizes(&outcome), (0, 0, 2), "the barred bid cannot fill");
    let balance = w.spot(seat, QUOTE);
    assert_eq!(balance.locked, 0, "the lock came back");
    assert_eq!(balance.available, 100_000);

    w.withdraw(seat, Asset::Spot(QUOTE), 100_000).unwrap();
    w.close(seat).unwrap();
    assert!(!w.seat(seat).is_open());
}

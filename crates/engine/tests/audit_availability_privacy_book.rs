//! Audit, availability and privacy of the book.
//!
//! Each test here pins how the book stands up to an availability or privacy attack.
//! A test named `accepted_limit_` pins a limit `SECURITY.md` accepts, and its bound. The market
//! settings are the deployment's (`ops/deployment.ts`: tick 100, min notional
//! 1,000,000 atoms, band 400 bps, initial margin 1,000 bps, maintenance 500 bps,
//! taker fee 5 bps, 32 open orders per trader, book capacity 1,024 per side) with
//! the mark at 150,000 quote atoms per lot and `max_steps` 16 (`ops/exchange.ts`).

mod common;

use common::*;
use noirwire_orderbook_engine::EngineError as E;
use noirwire_orderbook_engine::*;

const DEPLOY_MARK: u64 = 150_000;
const DEPLOY_STEPS: u32 = 16;
const DEPLOY_CAPACITY: usize = ORDERS_PER_SIDE;

fn deployment_perp(market_id: u8) -> MarketParams {
    MarketParams {
        tick: 100,
        base_lot: 1_000_000,
        min_size: 1,
        min_notional: 1_000_000,
        band_bps: 400,
        im_bps: 1_000,
        mm_bps: 500,
        taker_fee_bps: 5,
        liq_penalty_bps: 200,
        funding_cap_bps: 100,
        max_move_bps: 250,
        max_open_orders: 32,
        max_price_age: 10,
        funding_interval: 60,
        min_publish_gap: 1,
        max_age_liquidation: 60,
        open_interest_cap: 10_000_000,
        liq_buffer_bps: 100,
        liq_insurance_share_bps: 5_000,
        fee_insurance_share_bps: 5_000,
        ..perp_params(market_id)
    }
}

fn deployment_world(seats: usize) -> (World, usize) {
    let mut w = World::new(seats, DEPLOY_CAPACITY);
    w.max_steps = DEPLOY_STEPS;
    let m = w.add_market(deployment_perp(0));
    w.set_price(m, DEPLOY_MARK);
    (w, m)
}

fn funded_seat(w: &mut World, collateral: u64) -> u32 {
    let seat = w.open();
    w.deposit(seat, Asset::Collateral, collateral).unwrap();
    seat
}

/// The smallest size whose notional at `price` reaches the market's minimum.
fn min_lots(price: u64) -> u64 {
    1_000_000u64.div_ceil(price)
}

/// RULES 3.8 and 12 refuse a resting order on a full side and never evict. RULES 3.3
/// lets a bid rest anywhere down to 50% below the mark, and no taker can ever reach it
/// there: a taker ask may be at most `band_bps` below the mark. So orders parked at the
/// far edge stay until their owner cancels them, and a perp seat pays initial margin
/// only on the larger of its two sides (RULES 6 worst-case size). 64 seats, each with
/// 16 bids at half the mark and 16 asks at one and a half times it, fill both sides of
/// the deployment's SOL perp for about 215 nUSD of margin that is never at risk, and
/// every better-priced order of anyone else is then refused as "book full".
#[test]
fn far_away_orders_from_64_seats_lock_every_better_price_out_of_the_book() {
    let attackers = 2 * DEPLOY_CAPACITY / usize::from(deployment_perp(0).max_open_orders);
    assert_eq!(attackers, 64);
    let (mut w, m) = deployment_world(RESERVED_SEATS + attackers + 3);

    let far_bid = DEPLOY_MARK / 2;
    let far_ask = DEPLOY_MARK + DEPLOY_MARK / 2;
    let (bid_lots, ask_lots) = (min_lots(far_bid), min_lots(far_ask));
    assert_eq!((bid_lots, ask_lots), (14, 5));
    let per_seat_margin = 16 * bid_lots * DEPLOY_MARK / 10;
    let deposit = per_seat_margin + 40_000;
    let mut total_margin: i128 = 0;
    for _ in 0..attackers {
        let seat = funded_seat(&mut w, deposit);
        for _ in 0..16 {
            let rested = w
                .place(m, seat, limit(Side::Bid, far_bid, bid_lots))
                .unwrap();
            assert_eq!(rested.status, PlaceStatus::Rested);
            let rested = w
                .place(m, seat, limit(Side::Ask, far_ask, ask_lots))
                .unwrap();
            assert_eq!(rested.status, PlaceStatus::Rested);
        }
        total_margin += w.initial_margin(seat);
    }
    assert_eq!(w.markets[m].book.bid_count as usize, DEPLOY_CAPACITY);
    assert_eq!(w.markets[m].book.ask_count as usize, DEPLOY_CAPACITY);
    assert_eq!(
        total_margin,
        64 * 3_360_000,
        "about 215 nUSD of margin in all"
    );

    let taker = funded_seat(&mut w, 100_000_000);
    let lowest_ask = DEPLOY_MARK - DEPLOY_MARK * 400 / 10_000;
    let reach = w
        .place(m, taker, ioc(Side::Ask, lowest_ask, bid_lots))
        .unwrap();
    assert_eq!(reach.filled, 0, "no taker can reach the parked bids");
    assert_eq!(
        w.place(m, taker, ioc(Side::Ask, lowest_ask - 100, bid_lots)),
        Err(E::PriceOutsideBand)
    );

    let maker = funded_seat(&mut w, 100_000_000);
    let best_bid = w
        .place(m, maker, limit(Side::Bid, DEPLOY_MARK - 100, 10))
        .unwrap();
    let best_ask = w
        .place(m, maker, limit(Side::Ask, DEPLOY_MARK + 100, 10))
        .unwrap();
    assert!(
        best_bid.status == PlaceStatus::Rested && best_ask.status == PlaceStatus::Rested,
        "availability (RULES 3.8, 12): a quote one tick from the mark, better than every \
         resting order, must be able to rest; 64 seats holding {total_margin} atoms of margin \
         at 50% from the mark keep the whole book refused (bid {:?}, ask {:?})",
        best_bid.status,
        best_ask.status
    );
}

/// Accepted limit (`SECURITY.md`, "That one order reaches live liquidity behind dead
/// orders"). RULES 4 counts a resting order cancelled because its own expiry passed as
/// one step of the taker's `MAX_STEPS`. One seat rests bids one tick above the honest
/// best bid with `expiry = now`; a second later they are dead but still at the top, and
/// the next seller's order spends all 16 steps removing them and fills nothing. The
/// attacker loses nothing. The bound: every empty attempt removes the 16 dead orders it
/// reached, and one seat rests at most 32 orders on a market, so it costs a taker two
/// empty attempts and no more.
#[test]
fn accepted_limit_one_seats_dead_orders_cost_the_next_taker_at_most_two_empty_attempts() {
    let (mut w, m) = deployment_world(16);
    let honest_maker = funded_seat(&mut w, 100_000_000);
    let honest_bid = DEPLOY_MARK - 1_000;
    w.place(m, honest_maker, limit(Side::Bid, honest_bid, 100))
        .unwrap();

    let attacker = funded_seat(&mut w, 10_000_000);
    let attacker_equity = w.equity(attacker);
    let junk_price = honest_bid + 100;
    let junk = expiring(limit(Side::Bid, junk_price, min_lots(junk_price)), w.now);
    let most_orders = deployment_perp(0).max_open_orders;
    assert_eq!(most_orders, 2 * DEPLOY_STEPS as u16);
    for _ in 0..most_orders {
        assert_eq!(
            w.place(m, attacker, junk).unwrap().status,
            PlaceStatus::Rested
        );
    }
    assert_eq!(
        w.place(m, attacker, junk),
        Err(E::TooManyOpenOrders),
        "one seat rests no more than 32 orders on a market"
    );
    w.now += 1;

    let seller = funded_seat(&mut w, 100_000_000);
    for dead_left in [DEPLOY_STEPS, 0] {
        let empty = w.place(m, seller, ioc(Side::Ask, honest_bid, 100)).unwrap();
        assert_eq!(
            (empty.status, empty.filled),
            (PlaceStatus::RemainderCancelledStepLimit, 0),
            "accepted: an attempt behind 16 dead orders fills nothing"
        );
        assert_eq!(
            w.markets[m].book.bid_count,
            1 + dead_left,
            "the attempt removed the 16 dead orders it reached"
        );
    }
    let sold = w.place(m, seller, ioc(Side::Ask, honest_bid, 100)).unwrap();
    assert_eq!(
        (sold.status, sold.filled),
        (PlaceStatus::Filled, 100),
        "the third attempt reaches the live bid and fills in full"
    );
    assert_eq!(
        w.equity(attacker),
        attacker_equity,
        "the attack costs nothing"
    );
}

/// Binary-searches the best ask with post-only bids inside the crossing band. Returns
/// it, or `None` when no probe inside the band was refused, and the probes sent.
fn probe_best_ask(w: &mut World, m: usize, prober: u32) -> (Option<u64>, u32) {
    let tick = deployment_perp(0).tick;
    let band = DEPLOY_MARK * 400 / 10_000;
    let beyond_the_band = (DEPLOY_MARK + band) / tick + 1;
    let (mut low, mut high) = ((DEPLOY_MARK - band) / tick, beyond_the_band);
    let mut probes = 0;
    while low < high {
        let price = (low + high) / 2 * tick;
        probes += 1;
        let probe = w
            .place(m, prober, post_only(Side::Bid, price, min_lots(price)))
            .unwrap();
        if probe.status == PlaceStatus::RefusedPostOnlyWouldMatch {
            high = price / tick;
        } else {
            assert_eq!(probe.status, PlaceStatus::Rested);
            w.cancel(m, prober, seq(&probe)).unwrap();
            low = price / tick + 1;
        }
    }
    ((low < beyond_the_band).then_some(low * tick), probes)
}

/// Accepted limit (`SECURITY.md`, "Post-only probes"; `DESIGN.md` section 1, limit 4).
/// RULES 3.7 writes a post-only order that would match as an outcome in the sender's own
/// view and changes nothing else: no fill, no tape entry, no fee. Any seat can therefore
/// binary-search the best ask with post-only bids and learn it to the tick, in 7 probes
/// at the deployment's settings. The bound: that one price and nothing more. The probes
/// read the same whatever the resting size, and a best ask beyond the crossing band
/// reads only as "further than the band", since a bid past it is refused as an error.
#[test]
fn accepted_limit_post_only_probes_read_the_best_ask_inside_the_band_and_nothing_more() {
    let hidden_ask = 151_300;
    let mut readings = Vec::new();
    for resting_size in [min_lots(hidden_ask), 400] {
        let (mut w, m) = deployment_world(8);
        let maker = funded_seat(&mut w, 100_000_000);
        w.place(m, maker, limit(Side::Ask, hidden_ask, resting_size))
            .unwrap();
        let book_before = w.markets[m].resting(Side::Ask);
        let prober = funded_seat(&mut w, 2_000_000);
        let collateral = w.collateral(prober);
        let fill_seq = w.markets[m].book.next_fill_seq;

        let (learned, probes) = probe_best_ask(&mut w, m, prober);
        assert_eq!(
            learned,
            Some(hidden_ask),
            "accepted: the best ask, to the tick"
        );
        assert!(probes <= 7, "{probes} probes");
        assert_eq!(
            w.markets[m].book.next_fill_seq, fill_seq,
            "nothing on the tape"
        );
        assert_eq!(w.collateral(prober), collateral, "probing cost nothing");
        assert_eq!(w.markets[m].resting(Side::Ask), book_before);
        readings.push((learned, probes));
    }
    assert_eq!(readings[0], readings[1], "the probes do not read the size");

    let (mut w, m) = deployment_world(8);
    let maker = funded_seat(&mut w, 100_000_000);
    let band_edge = DEPLOY_MARK + DEPLOY_MARK * 400 / 10_000;
    let far_ask = band_edge + 1_000;
    w.place(m, maker, limit(Side::Ask, far_ask, 40)).unwrap();
    let prober = funded_seat(&mut w, 2_000_000);
    let (learned, _) = probe_best_ask(&mut w, m, prober);
    assert_eq!(learned, None, "a best ask beyond the band is not found");
    let past_the_edge = band_edge + 100;
    assert_eq!(
        w.place(
            m,
            prober,
            post_only(Side::Bid, past_the_edge, min_lots(past_the_edge))
        ),
        Err(E::PriceOutsideBand),
        "no probe reaches past the band"
    );
}

/// The size and side of every fill the last order printed on the public tape.
fn printed(w: &World) -> Vec<(u64, Side)> {
    w.fills
        .as_slice()
        .iter()
        .map(|fill| (fill.size, fill.taker_side))
        .collect()
}

/// Accepted limit (`SECURITY.md`, open interest; RULES 10). Open interest is public and
/// moves once per order by the net of its fills. Against the tape, an order with one
/// fill of `s` lots and open interest falling by `s` shows that both counterparties were
/// closing: the resting buyer a short and the selling taker a long of at least `s` lots.
/// The bound: an order with several fills shows only their net, so which of its makers
/// opened and which closed stays unknown, and no fill names a seat.
#[test]
fn accepted_limit_open_interest_against_the_tape_shows_opening_or_closing_but_not_who() {
    let (mut w, m) = deployment_world(10);
    let long = funded_seat(&mut w, 100_000_000);
    let short = funded_seat(&mut w, 100_000_000);
    w.place(m, short, limit(Side::Ask, DEPLOY_MARK, 50))
        .unwrap();
    w.place(m, long, ioc(Side::Bid, DEPLOY_MARK, 50)).unwrap();
    assert_eq!(w.markets[m].book.open_interest, 50);

    w.place(m, short, limit(Side::Bid, DEPLOY_MARK, 20))
        .unwrap();
    let open_interest_before = w.markets[m].book.open_interest;
    let sold = w.place(m, long, ioc(Side::Ask, DEPLOY_MARK, 20)).unwrap();
    assert_eq!(sold.filled, 20);
    assert_eq!(printed(&w), vec![(20, Side::Ask)]);
    assert_eq!(
        open_interest_before - w.markets[m].book.open_interest,
        20,
        "accepted: a fall by the one fill's size shows both counterparties were closing"
    );
    assert_eq!((w.slot(short, m).base, w.slot(long, m).base), (-30, 30));

    let newcomer = funded_seat(&mut w, 100_000_000);
    w.place(m, short, limit(Side::Bid, DEPLOY_MARK, 10))
        .unwrap();
    w.place(m, newcomer, limit(Side::Bid, DEPLOY_MARK, 10))
        .unwrap();
    let open_interest_before = w.markets[m].book.open_interest;
    w.place(m, long, ioc(Side::Ask, DEPLOY_MARK, 20)).unwrap();
    assert_eq!(printed(&w), vec![(10, Side::Ask), (10, Side::Ask)]);
    assert_eq!(
        open_interest_before - w.markets[m].book.open_interest,
        10,
        "two fills of 10 and a net fall of 10: one maker closed and one opened, and \
         nothing public says which"
    );
    assert!(
        w.slot(short, m).base < 0,
        "the first maker was closing a short"
    );
    assert_eq!(
        w.slot(newcomer, m).base,
        10,
        "the second was opening a long"
    );
}

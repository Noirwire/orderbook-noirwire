//! Audit, availability and privacy of the book.
//!
//! Every test here states a property the venue needs and fails today. The market
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

/// RULES 4 counts a resting order cancelled because its own expiry passed as one step
/// of the taker's `MAX_STEPS`. An order may carry an expiry equal to the current second
/// (`check_acceptance` refuses only `now > expiry`). So one seat rests 16 bids one tick
/// above the honest best bid with `expiry = now`; a second later they are dead but still
/// at the top. The next seller's order spends all 16 steps cancelling them and is cut
/// off with nothing filled, although live bids it crosses sit right behind. The
/// attacker loses nothing: each cancelled order's margin simply returns.
#[test]
fn sixteen_orders_that_expire_at_once_stop_the_next_taker_from_filling_at_all() {
    let (mut w, m) = deployment_world(16);
    let honest_maker = funded_seat(&mut w, 100_000_000);
    let honest_bid = DEPLOY_MARK - 1_000;
    w.place(m, honest_maker, limit(Side::Bid, honest_bid, 100))
        .unwrap();

    let attacker = funded_seat(&mut w, 10_000_000);
    let attacker_equity = w.equity(attacker);
    let junk_price = honest_bid + 100;
    for _ in 0..DEPLOY_STEPS {
        let junk = expiring(limit(Side::Bid, junk_price, min_lots(junk_price)), w.now);
        assert_eq!(
            w.place(m, attacker, junk).unwrap().status,
            PlaceStatus::Rested
        );
    }
    w.now += 1;

    let seller = funded_seat(&mut w, 100_000_000);
    let sold = w.place(m, seller, ioc(Side::Ask, honest_bid, 100)).unwrap();
    assert_eq!(
        w.equity(attacker),
        attacker_equity,
        "the attack costs nothing"
    );
    assert_eq!(
        w.markets[m].book.bid_count, 1,
        "the honest bid is still there"
    );
    assert_eq!(
        sold.filled, 100,
        "availability (RULES 4): a taker that crosses 100 live lots must fill; 16 bids that \
         expired at once in front of them used every step and the order ended {:?} with {} filled",
        sold.status, sold.filled
    );
}

/// DESIGN 1 lists every resting order's price as hidden. RULES 3.7 writes a post-only
/// order that would match as an outcome in the sender's own view and changes nothing
/// else: no fill, no tape entry, no fee. Any seat can therefore binary-search the best
/// ask with post-only bids inside the band, paying nothing, and learn it to the tick.
#[test]
fn post_only_probes_read_the_hidden_best_ask_to_the_tick_for_free() {
    let (mut w, m) = deployment_world(8);
    let maker = funded_seat(&mut w, 100_000_000);
    let hidden_ask = 151_300;
    w.place(m, maker, limit(Side::Ask, hidden_ask, 40)).unwrap();
    let book_before = w.markets[m].resting(Side::Ask);

    let prober = funded_seat(&mut w, 2_000_000);
    let collateral = w.collateral(prober);
    let band = DEPLOY_MARK * 400 / 10_000;
    let (mut low, mut high) = ((DEPLOY_MARK - band) / 100, (DEPLOY_MARK + band) / 100);
    let mut probes = 0;
    while low < high {
        let price = (low + high) / 2 * 100;
        probes += 1;
        let probe = w
            .place(m, prober, post_only(Side::Bid, price, min_lots(price)))
            .unwrap();
        if probe.status == PlaceStatus::RefusedPostOnlyWouldMatch {
            high = price / 100;
        } else {
            assert_eq!(probe.status, PlaceStatus::Rested);
            w.cancel(m, prober, seq(&probe)).unwrap();
            low = price / 100 + 1;
        }
    }
    let learned = low * 100;
    assert!(w.fills.as_slice().is_empty());
    assert_eq!(w.collateral(prober), collateral, "probing cost nothing");
    assert_eq!(w.markets[m].resting(Side::Ask), book_before);
    assert_ne!(
        learned, hidden_ask,
        "privacy (DESIGN 1, RULES 3): a resting order's price is hidden, yet {probes} free \
         post-only probes with no fill and no tape entry recovered the best ask {learned}"
    );
}

/// SECURITY.md says open interest is public and moves with fills. Read fill by fill
/// against the public tape it says more: a fill of `s` lots with no change of open
/// interest means one side opened and the other closed, and a fall of `s` means both
/// sides closed. Here the taker is a fresh seat whose sell prints with open interest
/// falling by the fill size, which tells everyone that the resting buyer held a short
/// position of at least that size and that the taker was closing a long: positions
/// that RULES 10 and DESIGN 1 list as private.
#[test]
fn open_interest_moving_with_each_printed_fill_reveals_both_sides_positions() {
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
    let printed: Vec<(u64, Side)> = w
        .fills
        .as_slice()
        .iter()
        .map(|fill| (fill.size, fill.taker_side))
        .collect();
    let open_interest_after = w.markets[m].book.open_interest;
    assert_eq!(sold.filled, 20);
    assert_eq!(printed, vec![(20, Side::Ask)]);

    let fell_by_the_fill = open_interest_before - open_interest_after == printed[0].0;
    let maker_was_short = w.slot(short, m).base < 0;
    assert!(maker_was_short);
    assert!(
        !fell_by_the_fill,
        "privacy (DESIGN 1, RULES 10): positions are private, yet the public tape (one taker \
         sell of 20) and the public open interest ({open_interest_before} to \
         {open_interest_after}) show that the resting buyer was closing a short of at least \
         20 lots and the seller a long of at least 20"
    );
}

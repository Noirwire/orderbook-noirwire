//! RULES 6 and 12: a seat holds positions and orders on any `SEAT_SLOTS` markets at
//! once, each slot owned by its market's tag, and seats move through an intrusive free
//! list. Every call goes through `World`, which asserts RULES 13 after it.

mod common;

use bytemuck::Zeroable;
use common::*;
use noirwire_orderbook_engine::EngineError as E;
use noirwire_orderbook_engine::*;

const BIG: u64 = 1_000_000_000;
const SPOT_FUNDS: u64 = 1_000_000;

fn perp_markets(count: u8) -> World {
    let mut w = World::new(64, 8);
    for id in 0..count {
        w.add_market(perp_params(id));
    }
    w
}

fn listed(seat: &Seat) -> usize {
    seat.slot_markets.iter().filter(|tag| **tag != 0).count()
}

/// A trader long `size` lots on market `m`, bought from `maker` at the mark, who is
/// liquidatable once the mark falls to 930.
fn weak_long(w: &mut World, m: usize, maker: u32, size: u64) -> u32 {
    let target = funded(w, 1_100 * size / 10);
    buy_from(w, m, target, maker, MARK, size);
    target
}

type Damage = Box<dyn Fn(&mut World)>;

fn access(maker_markets: u64, taker_markets: u64, blocked: bool) -> SeatAccess {
    SeatAccess {
        maker_markets,
        taker_markets,
        blocked,
    }
}

#[test]
fn a_fresh_list_hands_out_the_lowest_seat_first_and_a_full_table_refuses() {
    let mut w = World::new(5, 8);
    assert_eq!(w.header.free_head, RESERVED_SEATS as u32 + 1);
    let taken = [w.open(), w.open(), w.open()];
    assert_eq!(taken, [2, 3, 4]);
    assert_eq!(w.header.free_head, 0);
    assert_eq!(w.try_open(), Err(E::SeatTableFull));
    assert_eq!(w.header.open_seats, 5);
}

#[test]
fn a_released_seat_is_the_next_one_taken_with_a_higher_version() {
    let mut w = World::new(6, 8);
    let first = w.open();
    let second = w.open();
    let version = w.seat(first).version;
    w.close(first).unwrap();
    assert_eq!(w.header.free_head, first + 1);
    assert_eq!(w.seat(first).version, version + 1);
    let again = w.open();
    assert_eq!(again, first);
    assert_eq!(w.seat(again).version, version + 2);
    assert!(w.seat(second).is_open());
    assert_eq!(w.seat(again).next_free, 0);
}

#[test]
fn a_corrupted_head_or_link_fails_closed_and_changes_nothing() {
    let mut w = World::new(6, 8);
    let taken = w.open();
    let key = [0x77; 32];
    let corrupt: [(&str, Damage); 5] = [
        (
            "head at a reserved seat",
            Box::new(|w| w.header.free_head = 1),
        ),
        ("head past the table", Box::new(|w| w.header.free_head = 7)),
        (
            "head at a huge index",
            Box::new(|w| w.header.free_head = u32::MAX),
        ),
        (
            "head at an open seat",
            Box::new(move |w| w.header.free_head = taken + 1),
        ),
        (
            "link past the table",
            Box::new(|w| {
                let head = w.header.free_head as usize - 1;
                w.seats[head].next_free = 99;
            }),
        ),
    ];
    for (name, damage) in corrupt {
        let mut copy = w.clone();
        damage(&mut copy);
        let before = copy.bytes();
        let result = {
            let mut ledger = ledger(&mut copy.header, &mut copy.seats);
            take_seat(&mut ledger, &key)
        };
        assert_eq!(result, Err(E::InvariantBroken), "{name}");
        assert!(copy.bytes() == before, "{name} changed state");
    }
}

#[test]
fn push_new_seats_refuses_open_reserved_and_out_of_range_seats() {
    let mut w = World::new(6, 8);
    let taken = w.open();
    let before = w.bytes();
    let mut ledger = ledger(&mut w.header, &mut w.seats);
    assert_eq!(
        push_new_seats(&mut ledger, 0, 3),
        Err(E::InvariantBroken),
        "reserved"
    );
    assert_eq!(
        push_new_seats(&mut ledger, taken, taken + 1),
        Err(E::InvariantBroken),
        "open"
    );
    assert_eq!(
        push_new_seats(&mut ledger, 2, 7),
        Err(E::InvariantBroken),
        "past the table"
    );
    assert!(w.bytes() == before);
}

#[test]
fn release_empty_seats_skips_pinned_debtor_reserved_and_funded_seats() {
    let mut w = World::new(12, 8);
    w.add_market(perp_params(0));
    let empty = w.open();
    let funded_seat = funded(&mut w, 5);
    let pinned = w.open();
    let blocked = w.open();
    let debtor = w.open();
    let second_empty = w.open();
    w.set_seat_access(pinned, access(1, 0, false)).unwrap();
    w.seats[blocked as usize].blocked = 1;
    w.seats[debtor as usize].collateral = -7;
    let open_before = w.header.open_seats;

    {
        let mut ledger = ledger(&mut w.header, &mut w.seats);
        release_empty_seats(&mut ledger, 0, 3);
    }
    assert!(!w.seat(empty).is_open(), "inside the range");
    assert!(w.seat(second_empty).is_open(), "outside the range");
    {
        let mut ledger = ledger(&mut w.header, &mut w.seats);
        release_empty_seats(&mut ledger, 0, 64);
    }
    assert!(!w.seat(second_empty).is_open());
    for kept in [
        funded_seat,
        pinned,
        blocked,
        debtor,
        FEE_SEAT,
        INSURANCE_SEAT,
    ] {
        assert!(w.seat(kept).is_open(), "seat {kept} was released");
    }
    assert_eq!(w.header.open_seats, open_before - 2);
    w.check_free_list();

    let mut ledger = ledger(&mut w.header, &mut w.seats);
    assert!(!release_if_empty(&mut ledger, funded_seat));
    assert!(!release_if_empty(&mut ledger, debtor));
    assert!(!release_if_empty(&mut ledger, pinned));
    assert!(!release_if_empty(&mut ledger, FEE_SEAT));
    assert!(!release_if_empty(&mut ledger, empty), "already released");
    assert!(!release_if_empty(&mut ledger, u32::MAX));
    let key = [0x42; 32];
    let next = take_seat(&mut ledger, &key).unwrap();
    assert!(
        next == empty || next == second_empty,
        "a released seat comes back"
    );
}

#[test]
fn closing_a_pinned_seat_releases_it() {
    let mut w = World::new(6, 8);
    w.add_market(perp_params(0));
    let seat = w.open();
    w.set_seat_access(seat, access(1, 1, true)).unwrap();
    w.close(seat).unwrap();
    assert!(!w.seat(seat).is_open());
    assert_eq!(w.header.free_head, seat + 1);
}

#[test]
fn set_seat_access_by_index_refuses_a_wrong_owner_and_a_missing_seat() {
    let mut w = perp_markets(1);
    let a = funded(&mut w, BIG);
    let b = funded(&mut w, BIG);
    let (key_a, key_b) = (w.key(a), w.key(b));
    assert_eq!(
        w.set_seat_access_at(a, key_b, access(1, 0, false)),
        Err(E::NotSeatOwner)
    );
    assert_eq!(
        w.set_seat_access_at(FEE_SEAT, w.key(FEE_SEAT), access(1, 0, false)),
        Err(E::SeatNotOpen)
    );
    assert_eq!(
        w.set_seat_access_at(9, key_a, access(1, 0, false)),
        Err(E::SeatNotOpen)
    );
    assert_eq!(
        w.set_seat_access_at(999, key_a, access(1, 0, false)),
        Err(E::SeatOutOfRange)
    );
    w.set_seat_access_at(a, key_a, access(1, 0, false)).unwrap();
    w.place(0, a, limit(Side::Bid, MARK - 20, 3)).unwrap();
    assert_eq!(w.seat(a).open_orders()[0], 1);
    w.set_seat_access_at(a, key_a, access(0, 0, false)).unwrap();
    assert_eq!(
        w.seat(a).open_orders()[0],
        0,
        "the cleared bit cancelled it"
    );
    assert!(
        w.seat(a).slot_index(0).is_some(),
        "the tag outlives the order"
    );
}

#[test]
fn a_fifth_market_is_refused_while_four_slots_hold_positions() {
    let mut w = perp_markets(5);
    let maker = funded(&mut w, BIG);
    let trader = funded(&mut w, BIG);
    for m in 0..4 {
        buy_from(&mut w, m, trader, maker, MARK, 10);
    }
    assert_eq!(listed(w.seat(trader)), 4);
    let before = w.bytes();
    assert_eq!(
        w.place(4, trader, ioc(Side::Bid, MARK, 5)),
        Err(E::SlotsFull)
    );
    assert_eq!(
        w.place(4, trader, limit(Side::Bid, MARK - 20, 5)),
        Err(E::SlotsFull)
    );
    assert!(
        w.bytes() == before,
        "a refused order left the seat as it was"
    );
    assert_eq!(
        w.place(4, trader, reduce_only(ioc(Side::Ask, MARK, 1))),
        Err(E::ReduceOnlyWouldIncrease),
        "reduce-only claims nothing"
    );
    assert!(w.bytes() == before);
}

#[test]
fn flattening_a_market_lets_the_fifth_reuse_its_slot() {
    let mut w = perp_markets(5);
    let maker = funded(&mut w, BIG);
    let other = funded(&mut w, BIG);
    let trader = funded(&mut w, BIG);
    for m in 0..4 {
        buy_from(&mut w, m, trader, maker, MARK, 10);
    }
    let at = w.seat(trader).slot_index(0).unwrap();
    w.place(0, maker, limit(Side::Bid, MARK, 10)).unwrap();
    let closed = w.place(0, trader, ioc(Side::Ask, MARK, 10)).unwrap();
    assert_eq!(closed.filled, 10);
    assert_eq!(w.slot(trader, 0).base, 0);
    assert_eq!(
        w.seat(trader).slot_index(0),
        Some(at),
        "a flat slot keeps its tag"
    );

    buy_from(&mut w, 4, trader, other, MARK, 5);
    let seat = w.seat(trader);
    assert_eq!(seat.slot_index(4), Some(at), "the empty slot was reclaimed");
    assert_eq!(seat.slot_index(0), None);
    assert_eq!(w.slot(trader, 4).base, 5);
    assert_eq!(listed(seat), 4);
}

#[test]
fn a_slot_with_only_resting_orders_blocks_a_fifth_market() {
    let mut w = perp_markets(5);
    let trader = funded(&mut w, BIG);
    for m in 0..4 {
        w.place(m, trader, limit(Side::Bid, MARK - 20, 3)).unwrap();
    }
    let before = w.bytes();
    assert_eq!(
        w.place(4, trader, limit(Side::Bid, MARK - 20, 3)),
        Err(E::SlotsFull)
    );
    assert!(w.bytes() == before);
    assert_eq!(w.cancel_all(2, trader, 8), Ok(1));
    w.place(4, trader, limit(Side::Bid, MARK - 20, 3)).unwrap();
    assert_eq!(w.seat(trader).slot_index(2), None);
    assert!(w.seat(trader).slot_index(4).is_some());
}

#[test]
fn a_first_perp_order_claims_a_slot_before_it_rests() {
    let mut w = perp_markets(2);
    let trader = funded(&mut w, BIG);
    assert_eq!(w.seat(trader).slot_markets, [0; SEAT_SLOTS]);
    let rested = w.place(1, trader, limit(Side::Bid, MARK - 20, 3)).unwrap();
    assert_eq!(rested.status, PlaceStatus::Rested);
    let seat = w.seat(trader);
    assert_eq!(seat.slot_index(1), Some(0));
    assert_eq!(seat.slot_markets[0], 2);
    assert_eq!(seat.slot_orders[0], 1);
    assert_eq!(seat.perp[0].open_bid_lots, 3);
}

#[test]
fn a_spot_resting_order_takes_a_slot_and_a_spot_ioc_does_not() {
    let mut w = World::new(16, 8);
    w.add_market(perp_params(0));
    let spot = w.add_market(spot_params(1));
    let trader = w.open();
    w.deposit(trader, Asset::Spot(QUOTE), SPOT_FUNDS).unwrap();
    w.deposit(trader, Asset::Spot(BASE), SPOT_FUNDS).unwrap();

    let nothing = w.place(spot, trader, ioc(Side::Bid, MARK, 5)).unwrap();
    assert_eq!(nothing.filled, 0);
    assert_eq!(w.seat(trader).slot_markets, [0; SEAT_SLOTS]);
    let before_rest = *w.seat(trader);

    w.place(spot, trader, limit(Side::Bid, MARK, 5)).unwrap();
    let seat = w.seat(trader);
    assert_eq!(seat.slot_index(spot), Some(0));
    assert_eq!(seat.slot_orders[0], 1);
    assert_ne!(*seat, before_rest);
}

#[test]
fn a_spot_limit_that_fills_in_full_needs_no_slot_and_one_that_would_rest_is_refused() {
    let mut w = World::new(32, 8);
    for id in 0..3 {
        w.add_market(perp_params(id));
    }
    let resting_spot = w.add_market(spot_params(3));
    let fifth = w.add_market(spot_params(4));
    let maker = funded(&mut w, BIG);
    let trader = funded(&mut w, BIG);
    w.deposit(trader, Asset::Spot(QUOTE), SPOT_FUNDS).unwrap();
    for m in 0..3 {
        buy_from(&mut w, m, trader, maker, MARK, 10);
    }
    w.place(resting_spot, trader, limit(Side::Bid, MARK - 100, 2))
        .unwrap();
    assert_eq!(listed(w.seat(trader)), 4);

    let seller = w.open();
    w.deposit(seller, Asset::Spot(BASE), SPOT_FUNDS).unwrap();
    w.place(fifth, seller, limit(Side::Ask, MARK, 3)).unwrap();

    let before = w.bytes();
    let partial = w.place(fifth, trader, limit(Side::Bid, MARK, 5));
    assert_eq!(partial, Err(E::SlotsFull), "3 fill, 2 would rest");
    assert!(w.bytes() == before, "the fills were undone");
    let nothing = w.place(fifth, trader, limit(Side::Bid, MARK - 10, 2));
    assert_eq!(nothing, Err(E::SlotsFull));
    assert!(w.bytes() == before);

    let tags = w.seat(trader).slot_markets;
    let filled = w.place(fifth, trader, limit(Side::Bid, MARK, 3)).unwrap();
    assert_eq!(filled.status, PlaceStatus::Filled);
    assert_eq!(w.seat(trader).slot_markets, tags, "no slot was claimed");
    assert_eq!(w.seat(trader).slot_index(fifth), None);
}

#[test]
fn the_maker_recheck_counts_every_slot_of_the_maker() {
    let mut w = perp_markets(4);
    let source = funded(&mut w, BIG);
    let maker = funded(&mut w, 10_000);
    for m in 0..4 {
        buy_from(&mut w, m, maker, source, MARK, 10);
    }
    w.place(0, maker, limit(Side::Bid, MARK, 20)).unwrap();
    let taker = funded(&mut w, BIG);

    let mut healthy = w.clone();
    let filled = healthy.place(0, taker, ioc(Side::Ask, MARK, 20)).unwrap();
    assert_eq!(filled.filled, 20, "equity 9,880 covers the midpoint 4,500");
    assert_eq!(healthy.slot(maker, 0).base, 30);

    for m in 1..4 {
        w.set_price(m, 700);
    }
    let stressed = w.place(0, taker, ioc(Side::Ask, MARK, 20)).unwrap();
    assert_eq!(
        stressed.filled, 0,
        "the maker fails its check on the other slots"
    );
    assert_eq!(stressed.status, PlaceStatus::RemainderCancelled);
    assert_eq!(w.seat(maker).open_orders()[0], 0, "its order was released");
    assert_eq!(w.slot(maker, 0).base, 10);
    assert!(w.markets[0].live(Side::Bid).is_empty());
}

#[test]
fn a_reversal_that_goes_flat_between_two_fills_keeps_its_slot() {
    let mut w = perp_markets(4);
    let maker = funded(&mut w, BIG);
    let trader = funded(&mut w, BIG);
    for m in 0..4 {
        buy_from(&mut w, m, trader, maker, MARK, 5);
    }
    let tags = w.seat(trader).slot_markets;
    let first = funded(&mut w, BIG);
    let second = funded(&mut w, BIG);
    w.place(0, first, limit(Side::Bid, MARK, 5)).unwrap();
    w.place(0, second, limit(Side::Bid, MARK, 3)).unwrap();

    let flipped = w.place(0, trader, ioc(Side::Ask, MARK, 8)).unwrap();
    assert_eq!(flipped.filled, 8);
    assert_eq!(w.fills.as_slice().len(), 2);
    assert_eq!(w.slot(trader, 0).base, -3);
    assert_eq!(w.seat(trader).slot_markets, tags, "no slot moved");
    for m in 1..4 {
        assert_eq!(w.slot(trader, m).base, 5);
    }
}

#[test]
fn a_reclaimed_slot_never_charges_the_funding_of_its_old_market() {
    let mut w = perp_markets(5);
    let maker = funded(&mut w, BIG);
    let other = funded(&mut w, BIG);
    let trader = funded(&mut w, BIG);
    for m in 0..4 {
        buy_from(&mut w, m, trader, maker, MARK, 10);
    }
    w.set_funding_index(0, 500);
    w.place(0, maker, limit(Side::Bid, MARK, 10)).unwrap();
    w.place(0, trader, ioc(Side::Ask, MARK, 10)).unwrap();
    let at = w.seat(trader).slot_index(0).unwrap();
    assert_eq!(w.seat(trader).perp[at].funding_checkpoint, 500);

    w.set_funding_index(4, 40);
    w.place(4, other, limit(Side::Ask, MARK, 5)).unwrap();
    let equity_before = w.equity(trader);
    let opened = w.place(4, trader, ioc(Side::Bid, MARK, 5)).unwrap();
    assert_eq!(opened.filled, 5);
    assert_eq!(w.seat(trader).slot_index(4), Some(at));
    assert_eq!(w.slot(trader, 4).funding_checkpoint, 40);
    assert_eq!(
        w.equity(trader),
        equity_before - i128::from(opened.fee_paid),
        "only the fee left the seat"
    );
}

#[test]
fn a_first_liquidation_takeover_claims_the_liquidators_slot() {
    let mut w = perp_markets(4);
    let maker = funded(&mut w, BIG);
    let target = funded(&mut w, 4_500);
    for m in 0..4 {
        buy_from(&mut w, m, target, maker, MARK, 10);
    }
    for m in 0..4 {
        w.set_price(m, 930);
    }
    assert!(w.is_liquidatable(target, 0));
    let liquidator = funded(&mut w, BIG);
    assert_eq!(w.seat(liquidator).slot_markets, [0; SEAT_SLOTS]);

    let outcome = w.liquidate(0, liquidator, target, 10).unwrap();
    assert_eq!(outcome.status, LiquidationStatus::Liquidated);
    assert!(w.seat(liquidator).slot_index(0).is_some());
    assert_eq!(w.slot(liquidator, 0).base, outcome.liquidated as i64);
    assert_eq!(
        listed(w.seat(target)),
        4,
        "the target keeps its other markets"
    );
    for m in 1..4 {
        assert_eq!(w.slot(target, m).base, 10);
    }
}

#[test]
fn a_liquidator_with_four_full_slots_is_refused_and_a_sweep_stops_there() {
    let mut w = perp_markets(5);
    let maker = funded(&mut w, BIG);
    let fifth_maker = funded(&mut w, BIG);
    let first_four: Vec<u32> = (0..4).map(|m| weak_long(&mut w, m, maker, 10)).collect();
    let weak_one = weak_long(&mut w, 4, fifth_maker, 10);
    let weak_two = weak_long(&mut w, 4, fifth_maker, 10);
    let liquidator = funded(&mut w, BIG);
    for m in 0..5 {
        w.set_price(m, 930);
    }

    for (m, target) in first_four.iter().enumerate() {
        let outcome = w.liquidate(m, liquidator, *target, 10).unwrap();
        assert_eq!(outcome.status, LiquidationStatus::Liquidated, "market {m}");
    }
    assert_eq!(listed(w.seat(liquidator)), 4);

    let refused = w.liquidate(4, liquidator, weak_one, 10).unwrap();
    assert_eq!(refused.status, LiquidationStatus::LiquidatorSlotsFull);
    assert_eq!(refused.liquidated, 0);
    assert_eq!(w.slot(weak_one, 4).base, 10, "the target is untouched");

    let sweep = w
        .liquidate_range(
            4,
            liquidator,
            &RangeRequest {
                start: RESERVED_SEATS as u32,
                count: 64,
                size: 10,
                worst_price: u64::MAX,
                max_takeovers: 8,
            },
        )
        .unwrap();
    assert_eq!(sweep.taken, 0);
    assert_eq!(sweep.stopped, Some(LiquidationStatus::LiquidatorSlotsFull));
    assert_eq!(sweep.next_start, weak_one.min(weak_two));
    assert_eq!(w.slot(weak_two, 4).base, 10);
}

#[test]
fn a_snapshot_names_the_slot_layout_and_zeroes_the_old_room() {
    let mut w = perp_markets(1);
    let trader = funded(&mut w, BIG);
    w.place(0, trader, limit(Side::Bid, MARK - 20, 3)).unwrap();
    let key = w.key(trader);
    let snapshot = w.snapshot_as(0, trader, key).unwrap();
    assert_eq!(snapshot.layout, SNAPSHOT_LAYOUT_SLOTS);
    assert_eq!(snapshot._seat_reserved, [0; 144]);
    assert_eq!(snapshot.seat, *w.seat(trader));
    assert_eq!(snapshot.order_count, 1);
}

/// A tiny deterministic generator, so a failure can be replayed.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn between(&mut self, low: i64, high: i64) -> i64 {
        let span = (high - low + 1) as u64;
        low + (self.next() % span) as i64
    }
}

/// RULES 6 as the fixed eight-market seat computed it: every market in order, a flat
/// market adding nothing. Kept here as the reference the tagged slots are held to.
fn fixed_layout_margins(
    collateral: i64,
    perp: &[PerpSlot; MARKETS],
    risks: &[MarketRisk],
) -> (i128, i128, i128) {
    let mut equity = i128::from(collateral);
    let (mut initial, mut maintenance) = (0i128, 0i128);
    for (slot, risk) in perp.iter().zip(risks) {
        let (base, mark) = (i128::from(slot.base), i128::from(risk.mark));
        let unpaid = base * (i128::from(risk.funding_index) - i128::from(slot.funding_checkpoint));
        equity += base * mark + i128::from(slot.quote) - unpaid;
        let long = (base + i128::from(slot.open_bid_lots)).max(0);
        let short = (i128::from(slot.open_ask_lots) - base).max(0);
        initial += long.max(short) * mark * i128::from(risk.im_bps);
        maintenance += base.abs() * mark * i128::from(risk.mm_bps);
    }
    (equity, initial, maintenance)
}

#[test]
fn cross_margin_over_four_slots_equals_the_fixed_eight_market_model() {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let now = START;
    for round in 0..4_000 {
        let mut fixed = [PerpSlot::zeroed(); MARKETS];
        let mut markets: Vec<usize> = (0..MARKETS).collect();
        for at in (1..markets.len()).rev() {
            markets.swap(at, (rng.next() % (at as u64 + 1)) as usize);
        }
        let held = rng.between(0, SEAT_SLOTS as i64) as usize;
        let mut seat = Seat::zeroed();
        seat.collateral = rng.between(-1_000_000_000, 1_000_000_000);
        let mut places: Vec<usize> = (0..SEAT_SLOTS).collect();
        for at in (1..places.len()).rev() {
            places.swap(at, (rng.next() % (at as u64 + 1)) as usize);
        }
        for (market, place) in markets.iter().take(held).zip(&places) {
            let base = rng.between(-1_000, 1_000);
            let slot = PerpSlot {
                base,
                quote: if base == 0 {
                    0
                } else {
                    rng.between(-10_000_000, 10_000_000)
                },
                funding_checkpoint: rng.between(-1_000, 1_000),
                open_bid_lots: rng.between(0, 500) as u64,
                open_ask_lots: rng.between(0, 500) as u64,
            };
            fixed[*market] = slot;
            seat.perp[*place] = slot;
            seat.slot_markets[*place] = *market as u8 + 1;
            seat.slot_orders[*place] = rng.between(0, 4) as u8;
        }
        if held < SEAT_SLOTS && rng.next() % 2 == 0 {
            let place = places[held];
            seat.slot_markets[place] = markets[held] as u8 + 1;
        }
        let risks: Vec<MarketRisk> = (0..MARKETS)
            .map(|_| {
                let initial = rng.between(500, 3_000) as u16;
                MarketRisk {
                    is_perp: true,
                    mark: rng.between(1, 100_000) as u64,
                    publish_time: now,
                    max_price_age: 60,
                    max_age_liquidation: 300,
                    funding_index: rng.between(-2_000, 2_000),
                    uncovered_shortfall: 0,
                    im_bps: initial,
                    mm_bps: initial / 2,
                    oracle_health: ORACLE_HEALTHY,
                }
            })
            .collect();

        let (equity_fixed, initial_fixed, maintenance_fixed) =
            fixed_layout_margins(seat.collateral, &fixed, &risks);
        assert_eq!(
            equity(&seat, &risks),
            Ok(equity_fixed),
            "equity, round {round}"
        );
        let round_up = |times_bps: i128| (times_bps + 9_999).div_euclid(10_000);
        assert_eq!(
            initial_margin(&seat, &risks),
            Ok(round_up(initial_fixed)),
            "initial margin, round {round}"
        );
        assert_eq!(
            maintenance_margin(&seat, &risks),
            Ok(round_up(maintenance_fixed)),
            "maintenance margin, round {round}"
        );
        let market = (rng.next() % MARKETS as u64) as usize;
        assert_eq!(
            is_liquidatable(&seat, &risks, market, now),
            Ok(equity_fixed * 10_000 < maintenance_fixed),
            "liquidatable, round {round}"
        );
        for (market, expected) in fixed.iter().enumerate() {
            assert_eq!(seat.slot(market), Ok(expected), "slot read, round {round}");
        }
    }
}

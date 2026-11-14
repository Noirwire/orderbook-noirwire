//! Take-profit and stop-loss triggers: the book's layout and heaps, what `set_trigger`
//! refuses, how a record follows its position, and firing through `place_order`.

mod common;
mod trigger_rig;

use common::*;
use noirwire_orderbook_engine::EngineError as E;
use noirwire_orderbook_engine::*;
use proptest::prelude::*;
use trigger_rig::model::{op, run_model};
use trigger_rig::*;

#[test]
fn the_layout_sizes_are_what_the_account_budget_assumes() {
    assert_eq!(size_of::<TriggerHeader>(), 40);
    assert_eq!(size_of::<TriggerRecord>(), 80);
    assert_eq!(size_of::<TriggerSlot>(), 192);
    assert_eq!(size_of::<Seat>(), 304);
    assert_eq!(book_len(34_492), Some(7_174_376));
    assert_eq!(book_len(1), Some(40 + 192 + 4 * 4));
    assert_eq!(book_len(usize::MAX), None);
}

#[test]
fn a_book_is_refused_when_its_bytes_are_not_one() {
    let mut words = vec![0u64; book_len(4).unwrap().div_ceil(8) + 1];
    let bytes: &mut [u8] = bytemuck::cast_slice_mut(&mut words);
    let short = book_len(4).unwrap() - 1;
    for (name, init) in [
        ("short", TriggerBook::init(&mut bytes[..short], 0, 4)),
        ("unaligned", TriggerBook::init(&mut bytes[1..], 0, 4)),
        ("too many seats", TriggerBook::init(bytes, 0, u32::MAX)),
    ] {
        assert_eq!(init.unwrap_err(), TriggerError::BadLayout, "{name}");
    }
    assert_eq!(
        TriggerBook::open(&mut bytes[..8]).err(),
        Some(TriggerError::BadLayout)
    );
    assert_eq!(
        TriggerBook::open(bytes).err(),
        Some(TriggerError::BadLayout),
        "version zero is not a book"
    );
    TriggerBook::init(bytes, 0, 4).unwrap();
    assert!(TriggerBook::open(bytes).is_ok());
    assert_eq!(
        TriggerBook::open(&mut bytes[..short]).err(),
        Some(TriggerError::BadLayout)
    );
    TriggerBook::init(&mut bytes[4..], 0, 4).unwrap();
    assert_eq!(
        TriggerBook::open(&mut bytes[4..]).err(),
        Some(TriggerError::BadLayout),
        "the slots must sit on 8 bytes"
    );
    TriggerBook::init(bytes, 0, 4).unwrap();
    bytes[12] = 99;
    assert_eq!(
        TriggerBook::open(bytes).err(),
        Some(TriggerError::BadLayout),
        "a heap longer than its room"
    );
}

#[test]
fn set_trigger_refuses_what_it_should() {
    let mut r = Rig::new();
    let (a, maker) = (r.a, r.maker);
    let params = r.w.markets[0].params;
    let now = r.w.now;
    assert_eq!(r.set(stop(950, 900)), Err(TriggerError::NoPosition));
    r.open_long(100);
    assert_eq!(
        r.set_for(r.depth, stop(950, 900)),
        Err(TriggerError::NoPosition)
    );

    let too_high = (MAX_PRICE / 10 + 1) * 10;
    let expiring = |expiry| TriggerInput {
        expiry,
        ..stop(950, 900)
    };
    let refusals = [
        (stop(0, 0), TriggerError::InvalidPrice),
        (stop(955, 900), TriggerError::InvalidPrice),
        (stop(950, 905), TriggerError::InvalidPrice),
        (stop(950, 0), TriggerError::InvalidPrice),
        (take(too_high, 1_050), TriggerError::InvalidPrice),
        (stop(1_000, 900), TriggerError::WouldFireImmediately),
        (stop(1_050, 900), TriggerError::WouldFireImmediately),
        (take(1_000, 900), TriggerError::WouldFireImmediately),
        (take(900, 800), TriggerError::WouldFireImmediately),
        (stop(950, 960), TriggerError::InvalidWorstPrice),
        (take(1_100, 1_110), TriggerError::InvalidWorstPrice),
        (lots(stop(950, 900), 0), TriggerError::InvalidSize),
        (lots(stop(950, 900), 101), TriggerError::InvalidSize),
        (expiring(now), TriggerError::InvalidExpiry),
        (expiring(-5), TriggerError::InvalidExpiry),
    ];
    for (request, error) in refusals {
        assert_eq!(r.set(request), Err(error), "{request:?}");
    }

    let mut spot = spot_params(0);
    spot.market_id = 0;
    let mut broken = params;
    broken.tick = 0;
    let request = stop(950, 900);
    let raw = [
        (params, MARK, false, TriggerError::MarkNotFresh),
        (params, 0, true, TriggerError::MarkNotFresh),
        (spot, MARK, true, TriggerError::NotPerpMarket),
        (perp_params(1), MARK, true, TriggerError::MarketMismatch),
        (
            broken,
            MARK,
            true,
            TriggerError::Engine(E::InvalidMarketParams),
        ),
    ];
    for (params, mark, fresh, error) in raw {
        assert_eq!(r.set_raw(a, params, mark, fresh, now, request), Err(error));
    }
    let a_seat = r.stored(a);
    let by = |r: &mut Rig, seat: u32, owner: &[u8; 32]| {
        r.book().set_trigger(
            Trader { seat, owner },
            &a_seat,
            &params,
            MARK,
            true,
            now,
            &request,
        )
    };
    assert_eq!(
        by(&mut r, SEATS, &a_seat.owner),
        Err(TriggerError::SeatOutOfRange)
    );
    assert_eq!(r.set_for(9, request), Err(TriggerError::SeatNotOpen));
    assert_eq!(by(&mut r, a, &[0xAB; 32]), Err(TriggerError::NotSeatOwner));
    assert_eq!(r.book().active_records(), 0, "a refusal changes nothing");

    assert_eq!(r.set(stop(950, 900)), Ok(SetOutcome { replaced: false }));
    assert_eq!(r.set(stop(960, 900)), Ok(SetOutcome { replaced: true }));
    assert_eq!(r.book().active_records(), 1);
    assert_eq!(r.book().heap_len(BELOW_HEAP), 1);
    r.mark(950);
    assert_eq!(r.set(take(960, 950)), Err(TriggerError::CrossedPair));
    r.mark(MARK);

    assert_eq!(r.base(maker), -100);
    let fresh = Ok(SetOutcome { replaced: false });
    for (request, mark, expected) in [
        (take(900, 850), MARK, Err(TriggerError::InvalidWorstPrice)),
        (take(900, 950), MARK, fresh),
        (stop(880, 900), 850, Err(TriggerError::CrossedPair)),
        (stop(1_050, 1_100), MARK, fresh),
    ] {
        r.mark(mark);
        assert_eq!(r.set_for(maker, request), expected, "{request:?}");
    }
}

#[test]
fn records_are_queued_by_direction_replaced_in_place_and_cancelled_alone() {
    let mut r = Rig::new();
    r.open_long(100);
    let (a, maker, now) = (r.a, r.maker, r.w.now);
    r.set(stop(950, 900)).unwrap();
    r.set(take(1_100, 1_050)).unwrap();
    r.set_for(maker, take(900, 950)).unwrap();
    r.set_for(maker, stop(1_050, 1_100)).unwrap();
    assert_eq!(
        (r.book().heap_len(ABOVE_HEAP), r.book().heap_len(BELOW_HEAP)),
        (2, 2)
    );
    let before = r.record(a, Kind::StopLoss).unwrap();
    r.set(stop(940, 900)).unwrap();
    let after = r.record(a, Kind::StopLoss).unwrap();
    assert_ne!(before.record_version, after.record_version);
    assert_eq!(after.trigger_price, 940);
    assert_eq!(r.book().heap_len(BELOW_HEAP), 2);

    let stored = r.stored(a);
    let key = r.w.key(a);
    let trader = Trader {
        seat: a,
        owner: &key,
    };
    let closed = r.stored(9);
    let mut book = r.book();
    assert_eq!(
        book.cancel_trigger(trader, &stored, Kind::StopLoss, now),
        Ok(true)
    );
    assert_eq!(
        book.cancel_trigger(trader, &stored, Kind::StopLoss, now),
        Ok(false)
    );
    assert!(book.record(a, Kind::TakeProfit).is_some());
    let other = Trader {
        seat: a,
        owner: &[0xAB; 32],
    };
    assert_eq!(
        book.cancel_trigger(other, &stored, Kind::TakeProfit, now),
        Err(TriggerError::NotSeatOwner)
    );
    let nobody = Trader {
        seat: 9,
        owner: &[0; 32],
    };
    assert_eq!(
        book.cancel_trigger(nobody, &closed, Kind::TakeProfit, now),
        Err(TriggerError::SeatNotOpen)
    );
    let beyond = Trader {
        seat: SEATS,
        owner: &key,
    };
    assert_eq!(
        book.cancel_trigger(beyond, &stored, Kind::TakeProfit, now),
        Err(TriggerError::SeatOutOfRange)
    );
    book.check_invariants().unwrap();
}

#[test]
fn clear_seat_drops_everything_of_one_seat_only() {
    let mut r = Rig::new();
    r.open_long(100);
    let (a, maker) = (r.a, r.maker);
    r.set(stop(950, 900)).unwrap();
    r.set(take(1_100, 1_050)).unwrap();
    r.set_for(maker, take(900, 950)).unwrap();
    r.book().clear_seat(a).unwrap();
    r.book().clear_seat(a).unwrap();
    assert_eq!(r.book().active_records(), 1);
    assert!(r.book().record(maker, Kind::TakeProfit).is_some());
    assert_eq!(
        r.book().clear_seat(SEATS),
        Err(TriggerError::SeatOutOfRange)
    );
    r.book().check_invariants().unwrap();
}

#[test]
fn a_stop_never_fires_on_a_position_that_is_not_the_one_it_was_set_for() {
    type Next = fn(&mut Rig);
    let cases: [(&str, Next, i64); 3] = [
        (
            "flat, then long again",
            |r| {
                r.close_a();
                r.open_long(100);
            },
            100,
        ),
        (
            "flat, then short",
            |r| {
                r.close_a();
                let (a, maker) = (r.a, r.maker);
                buy_from(&mut r.w, 0, maker, a, MARK, 100);
            },
            -100,
        ),
        (
            "flipped through zero",
            |r| {
                r.bids(MARK, 150);
                r.w.place(0, r.a, ioc(Side::Ask, MARK, 150)).unwrap();
            },
            -50,
        ),
    ];
    for (name, next, expected) in cases {
        let mut r = Rig::new();
        r.open_long(100);
        r.set(stop(950, 900)).unwrap();
        r.set(take(1_100, 1_050)).unwrap();
        next(&mut r);
        assert_eq!(r.base(r.a), expected, "{name}");
        r.mark(940);
        let pass = r.fire(32);
        assert_eq!((pass.placed, pass.dropped), (0, 1), "{name}");
        assert_eq!(r.base(r.a), expected, "{name}");
        assert_eq!(r.book().active_records(), 0, "{name}: both are dropped");
    }

    let mut r = Rig::new();
    r.open_long(100);
    r.set(stop(950, 900)).unwrap();
    r.set(take(1_100, 1_050)).unwrap();
    r.bids(MARK, 150);
    r.w.place(0, r.a, ioc(Side::Ask, MARK, 150)).unwrap();
    let found = r.reconcile(r.a);
    assert_eq!(found.take_profit, Standing::Dropped(DropReason::Flip));
    assert_eq!(found.stop_loss, Standing::Dropped(DropReason::Flip));
}

#[test]
fn a_fixed_size_record_shrinks_with_the_position_and_a_whole_one_follows_it() {
    type Shrink = fn(&mut Rig);
    let cases: [(&str, Shrink, u64, u64); 2] = [
        ("a taker's sale", |r| r.sell_a(30), 70, 80),
        (
            "a passive fill",
            |r| {
                r.w.place(0, r.a, limit(Side::Ask, MARK, 30)).unwrap();
                r.w.place(0, r.depth, ioc(Side::Bid, MARK, 30)).unwrap();
            },
            70,
            80,
        ),
    ];
    for (name, shrink, position, size) in cases {
        let mut r = Rig::new();
        r.open_long(100);
        let a = r.a;
        r.set(lots(take(1_100, 1_050), size)).unwrap();
        r.set(stop(950, 900)).unwrap();
        shrink(&mut r);
        assert_eq!(r.base(a), i64::try_from(position).unwrap(), "{name}");
        let found = r.reconcile(a);
        assert_eq!(found.position, position, "{name}");
        assert_eq!(found.take_profit, Standing::Resized, "{name}");
        assert_eq!(found.stop_loss, Standing::Armed, "{name}");
        assert_eq!(r.record(a, Kind::TakeProfit).unwrap().size, position);
        assert_eq!(r.reconcile(a).take_profit, Standing::Armed);
    }
}

#[test]
fn a_partial_liquidation_keeps_and_resizes_a_stop_and_a_full_one_drops_it() {
    let mut r = Rig::new();
    let target = funded(&mut r.w, 11_000);
    buy_from(&mut r.w, 0, target, r.maker, MARK, 100);
    r.set_for(target, lots(stop(960, 900), 100)).unwrap();
    r.set_for(target, take(1_100, 1_050)).unwrap();
    let liquidator = funded(&mut r.w, 1_000_000);
    r.mark(930);
    let first = r.w.liquidate(0, liquidator, target, 10).unwrap();
    assert_eq!(first.status, LiquidationStatus::Liquidated);
    let left = r.base(target).unsigned_abs();
    assert!(left > 0 && left < 100);
    let found = r.reconcile(target);
    assert_eq!(found.position, left);
    assert_eq!(found.stop_loss, Standing::Resized);
    assert_eq!(found.take_profit, Standing::Armed);
    r.mark(800);
    while r.base(target) != 0 {
        r.w.liquidate(0, liquidator, target, 1_000).unwrap();
    }
    let found = r.reconcile(target);
    assert_eq!(found.stop_loss, Standing::Dropped(DropReason::Flat));
    assert_eq!(found.take_profit, Standing::Dropped(DropReason::Flat));
}

#[test]
fn a_whole_position_stop_follows_the_position_up_and_a_fixed_one_does_not() {
    let mut r = Rig::new();
    r.open_long(100);
    let a = r.a;
    r.set(stop(950, 900)).unwrap();
    r.set(lots(take(1_100, 1_050), 50)).unwrap();
    r.open_long(100);
    let found = r.reconcile(a);
    assert_eq!(found.position, 200);
    assert_eq!(found.stop_loss, Standing::Armed);
    assert_eq!(found.take_profit, Standing::Armed);
    assert_eq!(r.record(a, Kind::TakeProfit).unwrap().size, 50);
    r.mark(940);
    r.bids(930, 300);
    let pass = r.fire(32);
    assert_eq!(
        pass.filled_lots, 200,
        "the stop closed what was held, no more"
    );
    assert_eq!(r.base(a), 0);
}

#[test]
fn a_thin_book_fills_part_and_the_rest_waits_with_the_sibling_resized() {
    let mut r = Rig::new();
    r.open_long(100);
    let a = r.a;
    r.set(lots(take(1_100, 1_050), 100)).unwrap();
    r.set(lots(stop(950, 900), 100)).unwrap();
    r.mark(1_110);
    r.bids(1_100, 30);
    let pass = r.fire(32);
    assert_eq!((pass.placed, pass.filled_lots, pass.rearmed), (1, 30, 1));
    assert_eq!(r.base(a), 70);
    let waiting = r.record(a, Kind::TakeProfit).unwrap();
    assert_eq!(waiting.size, 70, "its remaining intent");
    assert_eq!(waiting.heap, heap_tag(TIME_HEAP));
    assert_eq!(waiting.next_attempt, r.w.now + DELAY);
    assert_eq!(r.record(a, Kind::StopLoss).unwrap().size, 70);
    assert_eq!(r.fire(32).due, 0, "nothing is due while it waits");
    r.w.now += DELAY;
    r.mark(1_110);
    r.bids(1_100, 70);
    let pass = r.fire(32);
    assert_eq!((pass.filled_lots, r.base(a)), (70, 0));
    assert_eq!(
        r.book().active_records(),
        0,
        "the stop went with the position"
    );
}

/// One pass through the real `place_order`, on a long of 100 lots (or `held` after a
/// sale) with `records` set, the mark at `mark` and `liquidity` lots of bids at `bid`.
struct Fire {
    name: &'static str,
    min_size: u64,
    min_notional: u64,
    held: u64,
    records: Vec<TriggerInput>,
    mark: u64,
    bid: u64,
    liquidity: u64,
    filled: u64,
    left: i64,
    standing: usize,
    unfillable: u32,
}

impl Fire {
    fn base(name: &'static str) -> Fire {
        Fire {
            name,
            min_size: 1,
            min_notional: 0,
            held: 100,
            records: vec![],
            mark: 1_110,
            bid: 1_100,
            liquidity: 100,
            filled: 0,
            left: 0,
            standing: 0,
            unfillable: 0,
        }
    }

    fn run(&self) {
        let mut r = Rig::new();
        r.open_long(100);
        if self.held < 100 {
            r.sell_a(100 - self.held);
        }
        let a = r.a;
        for record in &self.records {
            r.set(*record).unwrap();
        }
        r.w.markets[0].params.min_size = self.min_size;
        r.w.markets[0].params.min_notional = self.min_notional;
        r.mark(self.mark);
        r.bids(self.bid, self.liquidity);
        let pass = r.fire(32);
        let name = self.name;
        assert_eq!(pass.filled_lots, self.filled, "{name}: {pass:?}");
        assert_eq!(r.base(a), self.left, "{name}");
        assert_eq!(r.book().active_records(), self.standing, "{name}");
        assert_eq!(pass.unfillable, self.unfillable, "{name}");
        if self.unfillable > 0 {
            let waiting = r.record(a, Kind::StopLoss).unwrap();
            assert!(waiting.is_unfillable(), "{name}: the owner can see it");
        }
        r.book().check_invariants().unwrap();
    }
}

#[test]
fn a_pass_closes_what_the_records_authorize_and_never_more() {
    let both = vec![take(1_100, 1_050), stop(950, 900)];
    let low = |size| vec![lots(stop(950, 900), size)];
    let cases = [
        Fire {
            records: both.clone(),
            filled: 100,
            ..Fire::base("a take-profit closing everything takes its sibling with it")
        },
        Fire {
            records: vec![lots(take(1_100, 1_050), 40), stop(950, 900)],
            filled: 40,
            left: 60,
            standing: 1,
            ..Fire::base("a fixed record that completes its size is spent alone")
        },
        Fire {
            held: 3,
            min_size: 5,
            records: both.clone(),
            filled: 3,
            ..Fire::base("a position below the minimum size is closed exactly")
        },
        Fire {
            min_size: 6,
            records: vec![lots(stop(950, 900), 2)],
            mark: 940,
            bid: 930,
            left: 100,
            standing: 1,
            unfillable: 1,
            ..Fire::base("2 of 100 under a minimum size of 6 waits, not 6 closed")
        },
        Fire {
            min_notional: 5_000,
            records: low(2),
            mark: 940,
            bid: 930,
            left: 100,
            standing: 1,
            unfillable: 1,
            ..Fire::base("2 of 100 under a minimum notional waits, not 6 closed")
        },
        Fire {
            held: 2,
            min_size: 6,
            records: low(2),
            mark: 940,
            bid: 930,
            filled: 2,
            ..Fire::base(
                "a fixed size that is the whole position closes it though under the minimum",
            )
        },
        Fire {
            min_size: 6,
            records: low(6),
            mark: 940,
            bid: 930,
            filled: 6,
            left: 94,
            ..Fire::base("a fixed size at the minimum closes exactly that and is spent")
        },
    ];
    for case in cases {
        case.run();
    }
}

#[test]
fn a_manual_close_between_two_passes_leaves_one_net_reduction_and_no_error() {
    let mut r = Rig::new();
    r.open_long(100);
    let a = r.a;
    r.set(stop(950, 900)).unwrap();
    r.mark(940);
    r.bids(930, 40);
    let first = r.fire(32);
    assert_eq!(first.filled_lots, 40);
    r.w.now += DELAY;
    r.mark(940);
    r.bids(930, 60);
    r.w.place(0, a, ioc(Side::Ask, 930, 60)).unwrap();
    assert_eq!(r.base(a), 0);
    let second = r.fire(32);
    assert_eq!((second.placed, second.refused, second.dropped), (0, 0, 1));
    assert_eq!(r.base(a), 0);
}

#[test]
fn the_plan_is_clipped_to_the_bands_and_raised_to_a_minimum_only_for_the_whole_position() {
    let mut params = perp_params(0);
    params.min_notional = 5_000;
    let mut r = Rig::with(params);
    r.open_long(100);
    let (a, maker) = (r.a, r.maker);
    r.set(stop(950, 100)).unwrap();
    r.set_for(maker, stop(1_050, 5_000)).unwrap();
    for (seat, mark, side, worst, why) in [
        (
            maker,
            1_060,
            Side::Bid,
            1_110,
            "a ceiling falls to 1,060 + 5%",
        ),
        (a, 940, Side::Ask, 900, "a floor of 100 rises to 940 - 5%"),
    ] {
        r.mark(mark);
        let FireDecision::Fire(plan) = r.decide(seat, mark) else {
            panic!("{why}");
        };
        assert_eq!((plan.seat, plan.side, plan.size), (seat, side, 100));
        assert_eq!(plan.worst_price, worst, "{why}");
        assert!(plan.order_size * plan.worst_price >= 5_000);
        let order = plan.new_order([1; 16]);
        assert_eq!(
            (order.order_type, order.reduce_only, order.price),
            (OrderType::Market, true, worst)
        );
    }

    let planned = |sold: u64, request: TriggerInput| {
        let mut r = Rig::new();
        r.open_long(100);
        if sold > 0 {
            r.sell_a(sold);
        }
        r.set(request).unwrap();
        r.w.markets[0].params.min_notional = 5_000;
        r.decide(r.a, 940)
    };
    let FireDecision::Fire(plan) = planned(98, stop(950, 900)) else {
        panic!("the whole position");
    };
    assert_eq!(
        (plan.size, plan.order_size),
        (2, 6),
        "raised for the last lots"
    );
    assert_eq!(
        planned(0, lots(stop(950, 900), 2)),
        FireDecision::Unfillable,
        "never raised for part of a position"
    );
}

#[test]
fn the_engine_refuses_a_wrong_side_order_and_the_record_is_dropped_for_it() {
    let mut r = Rig::new();
    r.open_long(100);
    let a = r.a;
    assert_eq!(
        r.w.place(0, a, reduce_only(market(Side::Bid, 1_050, 10)))
            .unwrap_err(),
        E::ReduceOnlyWouldIncrease
    );
    r.set(stop(950, 900)).unwrap();
    r.mark(940);
    let due = r.due_one(940);
    let (stored, now) = (r.stored(a), r.w.now);
    let outcome = FireOutcome::Refused(E::ReduceOnlyWouldIncrease);
    assert_eq!(
        r.book()
            .record_fire_outcome(&due, outcome, &stored, now, DELAY),
        Ok(Settled::Dropped(DropReason::Refused))
    );
    assert_eq!(r.record(a, Kind::StopLoss), None);
}

#[test]
fn a_fixed_size_that_could_never_fill_is_refused_when_it_is_set() {
    let cases = [
        (
            "below the minimum size",
            6,
            0,
            lots(stop(950, 900), 2),
            false,
        ),
        ("at the minimum size", 6, 0, lots(stop(950, 900), 6), true),
        (
            "below the notional at the worst price",
            1,
            5_000,
            lots(stop(950, 900), 5),
            false,
        ),
        (
            "with a low worst price",
            1,
            5_000,
            lots(stop(950, 100), 5),
            false,
        ),
        ("at the notional", 1, 5_000, lots(stop(950, 900), 6), true),
        ("the whole position", 6, 5_000, stop(950, 900), true),
        (
            "the whole position as a fixed size",
            6,
            5_000,
            lots(stop(950, 900), 100),
            true,
        ),
    ];
    for (name, min_size, min_notional, request, accepted) in cases {
        let mut params = perp_params(0);
        params.min_size = min_size;
        params.min_notional = min_notional;
        let mut r = Rig::with(params);
        r.open_long(100);
        let expected = if accepted {
            Ok(SetOutcome { replaced: false })
        } else {
            Err(TriggerError::SizeBelowMinimum)
        };
        assert_eq!(r.set(request), expected, "{name}");
    }
    let mut params = perp_params(0);
    params.min_size = 6;
    let mut r = Rig::with(params);
    r.open_long(100);
    r.sell_a(98);
    assert_eq!(
        r.set(lots(stop(950, 900), 2)),
        Ok(SetOutcome { replaced: false }),
        "a size that is the whole position is never below the minimum"
    );
}

#[test]
fn a_fill_larger_than_the_record_is_an_error_not_a_clamp() {
    let mut r = Rig::new();
    r.open_long(100);
    let a = r.a;
    r.set(lots(stop(950, 900), 10)).unwrap();
    r.mark(940);
    let due = r.due_one(940);
    let (stored, now) = (r.stored(a), r.w.now);
    let over = FireOutcome::Placed { filled: 11 };
    assert_eq!(
        r.book()
            .record_fire_outcome(&due, over, &stored, now, DELAY),
        Err(TriggerError::FillExceedsSize)
    );
    assert_eq!(
        r.record(a, Kind::StopLoss).unwrap().size,
        10,
        "nothing changed"
    );
}

#[test]
fn an_error_that_may_pass_re_arms_the_record_and_a_stale_reference_is_refused() {
    let mut r = Rig::new();
    r.open_long(100);
    let a = r.a;
    r.set(stop(950, 900)).unwrap();
    r.mark(940);
    let due = r.due_one(940);
    let (stored, now) = (r.stored(a), r.w.now);
    let params = r.w.markets[0].params;
    let wrong = Due {
        record_version: due.record_version.wrapping_add(5),
        ..due
    };
    assert_eq!(
        r.book().begin_fire(&wrong, &stored, &params, 940, now),
        Ok(FireDecision::Stale)
    );
    let settle = |r: &mut Rig, due: &Due, outcome| {
        r.book()
            .record_fire_outcome(due, outcome, &stored, now, DELAY)
    };
    let placed = FireOutcome::Placed { filled: 0 };
    assert_eq!(settle(&mut r, &wrong, placed), Ok(Settled::Stale));
    assert_eq!(
        settle(&mut r, &due, FireOutcome::Refused(E::StalePrice)),
        Ok(Settled::Rearmed {
            next_attempt: now + DELAY
        })
    );
    assert!(is_queued(&r.record(a, Kind::StopLoss).unwrap()));
    assert_eq!(
        settle(&mut r, &due, placed),
        Ok(Settled::Stale),
        "settled once"
    );
    r.book().check_invariants().unwrap();
}

#[test]
fn a_record_the_mark_has_left_is_queued_again_and_not_fired() {
    let mut r = Rig::new();
    r.open_long(100);
    let a = r.a;
    r.set(stop(950, 900)).unwrap();
    let (stored, now) = (r.stored(a), r.w.now);
    let params = r.w.markets[0].params;
    let due = r.due_one(940);
    assert_eq!(
        r.book().begin_fire(&due, &stored, &params, 1_000, now),
        Ok(FireDecision::NotDue)
    );
    assert!(is_queued(&r.record(a, Kind::StopLoss).unwrap()));
    r.book().check_invariants().unwrap();
}

#[test]
fn begin_fire_refuses_what_it_cannot_plan() {
    let mut r = Rig::new();
    r.open_long(100);
    let (a, maker) = (r.a, r.maker);
    r.set(stop(950, 900)).unwrap();
    r.set_for(maker, stop(1_050, 1_100)).unwrap();
    let now = r.w.now;
    let mut params = r.w.markets[0].params;
    r.mark(940);
    let due = r.due_one(940);
    let stored = r.stored(a);
    let off_book = Due { seat: SEATS, ..due };
    assert_eq!(
        r.book().begin_fire(&off_book, &stored, &params, 940, now),
        Err(TriggerError::Corrupt)
    );
    params.tick = 0;
    assert_eq!(
        r.book().begin_fire(&due, &stored, &params, 940, now),
        Err(TriggerError::Corrupt)
    );
    r.mark(1_060);
    let due = r.due_one(1_060);
    params.tick = 10_000_000;
    let stored = r.stored(maker);
    assert_eq!(
        r.book().begin_fire(&due, &stored, &params, 1_060, now),
        Err(TriggerError::InvalidWorstPrice)
    );
}

#[test]
fn one_entry_that_errors_does_not_stop_the_others() {
    let mut r = Rig::new();
    let m1 = r.w.add_market(perp_params(1));
    let other = funded(&mut r.w, 1_000_000);
    r.open_long(100);
    buy_from(&mut r.w, 0, other, r.maker, MARK, 100);
    buy_from(&mut r.w, m1, r.a, r.maker, MARK, 10);
    let a = r.a;
    r.set(stop(950, 900)).unwrap();
    r.set_for(other, stop(950, 900)).unwrap();
    r.w.markets[m1].params.oracle_health = ORACLE_DISLOCATED;
    r.mark(940);
    r.bids(930, 200);
    let pass = r.fire(32);
    assert_eq!((pass.due, pass.refused, pass.placed), (2, 1, 1));
    assert_eq!((pass.rearmed, pass.dropped), (1, 1));
    assert_eq!(r.base(other), 0);
    assert_eq!(r.base(a), 100);
    let waiting = r.record(a, Kind::StopLoss).unwrap();
    assert_eq!(waiting.heap, heap_tag(TIME_HEAP));
}

#[test]
fn a_pass_reports_the_fills_of_each_accepted_order() {
    let mut r = Rig::new();
    r.open_long(100);
    r.set(stop(950, 900)).unwrap();
    r.mark(940);
    r.bids(930, 100);
    let mut seen = Vec::new();
    let rules = FireRules {
        max: 1,
        retry_delay: DELAY,
    };
    let pass = r.fire_with(&rules, |due, fills, outcome| {
        seen.push((due.seat, fills.as_slice().len(), outcome.filled))
    });
    assert_eq!(seen, [(r.a, 1, 100)]);
    assert_eq!(pass.filled_lots, 100);
}

#[test]
fn a_fired_order_carries_the_records_secret_and_a_new_secret_gives_new_receipts() {
    let mut r = Rig::new();
    r.open_long(100);
    let (first, second) = ([0x11; 16], [0x22; 16]);
    let with_secret = |secret| TriggerInput {
        client_id: 0xC11E,
        secret,
        ..stop(950, 900)
    };
    r.set(with_secret(first)).unwrap();
    assert_eq!(r.record(r.a, Kind::StopLoss).unwrap().secret, first);
    r.mark(940);
    r.bids(930, 40);
    let rules = FireRules {
        max: 1,
        retry_delay: DELAY,
    };
    let mut receipts = Vec::new();
    let fire = |r: &mut Rig| {
        let mut seen = Vec::new();
        r.fire_with(&rules, |_, fills, _| {
            seen.extend(
                fills
                    .as_slice()
                    .iter()
                    .map(|fill| (fill.fill_seq, fill.taker_receipt)),
            );
        });
        seen
    };
    for (seq, receipt_seen) in fire(&mut r) {
        assert_eq!(receipt_seen, receipt(sha, &first, seq, ROLE_TAKER));
        receipts.push((seq, receipt_seen));
    }
    assert_eq!(receipts.len(), 1);
    assert_eq!(r.record(r.a, Kind::StopLoss).unwrap().secret, first);

    r.w.now += DELAY + 1;
    r.mark(940);
    let replacement = TriggerInput {
        trigger_price: 930,
        ..with_secret(second)
    };
    assert_eq!(r.set(replacement), Ok(SetOutcome { replaced: true }));
    assert_eq!(r.record(r.a, Kind::StopLoss).unwrap().secret, second);
    r.mark(920);
    r.bids(910, 60);
    let fired = fire(&mut r);
    assert_eq!(fired.len(), 1);
    for (seq, receipt_seen) in fired {
        assert_eq!(receipt_seen, receipt(sha, &second, seq, ROLE_TAKER));
        assert_ne!(receipt_seen, receipt(sha, &first, seq, ROLE_TAKER));
    }
}

#[test]
fn the_secret_leaves_the_slot_when_a_record_is_dropped_or_cancelled() {
    let mut r = Rig::new();
    r.open_long(100);
    let a = r.a;
    let at = usize::try_from(a).unwrap();
    let slot = |r: &mut Rig| -> TriggerSlot {
        let slots: &[TriggerSlot] =
            bytemuck::cast_slice(&r.bytes()[HEADER_LEN..HEADER_LEN + SLOT_LEN * SEATS as usize]);
        slots[at]
    };
    let request = TriggerInput {
        secret: [0x33; 16],
        ..stop(950, 900)
    };
    r.set(request).unwrap();
    r.set(TriggerInput {
        secret: [0x44; 16],
        ..take(1_050, 1_000)
    })
    .unwrap();
    let held = slot(&mut r);
    assert_eq!(held.stop_loss.secret, [0x33; 16]);
    assert_eq!(held.take_profit.secret, [0x44; 16]);

    let stored = r.stored(a);
    let (now, key) = (r.w.now, r.w.key(a));
    let trader = Trader {
        seat: a,
        owner: &key,
    };
    assert_eq!(
        r.book()
            .cancel_trigger(trader, &stored, Kind::StopLoss, now),
        Ok(true)
    );
    let after_cancel = slot(&mut r);
    assert_eq!(after_cancel.stop_loss.secret, [0; 16]);
    assert_eq!(after_cancel.take_profit.secret, [0x44; 16]);

    r.close_a();
    r.reconcile(a);
    assert_eq!(slot(&mut r).take_profit.secret, [0; 16]);
}

#[test]
fn nothing_fires_and_nothing_is_dropped_while_the_market_cannot_be_trusted() {
    type Damage = fn(&mut Rig);
    let cases: [(&str, Damage, Idle); 6] = [
        ("old mark", |r| r.w.now += 1_000, Idle::MarkNotFresh),
        (
            "exchange paused",
            |r| r.w.paused = true,
            Idle::ExchangePaused,
        ),
        (
            "market paused",
            |r| r.w.markets[0].params.status = STATUS_PAUSED,
            Idle::MarketPaused,
        ),
        (
            "bad settings",
            |r| r.w.markets[0].params.max_price_age = 0,
            Idle::MarketUnusable,
        ),
        (
            "dislocated",
            |r| r.w.markets[0].params.oracle_health = ORACLE_DISLOCATED,
            Idle::OracleNotHealthy,
        ),
        (
            "settling",
            |r| r.w.markets[0].params.oracle_health = ORACLE_SETTLING,
            Idle::OracleNotHealthy,
        ),
    ];
    for (name, damage, idle) in cases {
        let mut r = Rig::new();
        r.open_long(100);
        let a = r.a;
        r.set(stop(950, 900)).unwrap();
        r.mark(940);
        r.bids(930, 100);
        damage(&mut r);
        let before = r.mem.clone();
        let pass = r.fire(32);
        assert_eq!(
            pass,
            FirePass {
                idle: Some(idle),
                ..FirePass::default()
            },
            "{name}"
        );
        assert_eq!(before, r.mem, "{name}: nothing changed");
        assert_eq!(r.base(a), 100, "{name}");
    }
}

#[test]
fn a_book_for_another_market_or_one_that_disagrees_with_itself_is_idle() {
    let mut r = Rig::build(perp_params(0), 1, SEATS);
    assert_eq!(r.fire(32).idle, Some(Idle::WrongBook));

    let mut r = Rig::new();
    r.open_long(100);
    r.set(stop(950, 900)).unwrap();
    r.mark(940);
    r.bytes()[12] = 1;
    let heaps = HEADER_LEN + usize::try_from(SEATS).unwrap() * SLOT_LEN;
    r.bytes()[heaps..heaps + 4].copy_from_slice(&0xFFFF_FFF0u32.to_le_bytes());
    let pass = r.fire(32);
    assert_eq!(pass.idle, Some(Idle::BookCorrupt));
    assert_eq!(r.book().check_invariants(), Err(TriggerError::Corrupt));
}

#[test]
fn the_mark_must_be_fresh_for_anything_to_be_due() {
    let mut r = Rig::new();
    r.open_long(100);
    r.set(stop(950, 900)).unwrap();
    let now = r.w.now;
    let mut out = [Due::EMPTY; 4];
    let before = r.mem.clone();
    assert_eq!(r.book().due_triggers(940, false, now, 4, &mut out), Ok(0));
    assert_eq!(r.book().due_triggers(0, true, now, 4, &mut out), Ok(0));
    assert_eq!(r.book().due_triggers(940, true, now, 0, &mut out), Ok(0));
    assert_eq!(r.book().due_triggers(940, true, now, 4, &mut []), Ok(0));
    assert_eq!(before, r.mem);
    assert_eq!(r.book().due_triggers(940, true, now, 4, &mut out), Ok(1));
}

#[test]
fn a_record_whose_seat_is_not_in_the_ledger_is_cleared_by_the_pass() {
    let mut r = Rig::build(perp_params(0), 0, 16);
    r.open_long(100);
    let mut stray = r.stored(r.a);
    stray.owner = [0x77; 32];
    let params = r.w.markets[0].params;
    let now = r.w.now;
    r.book()
        .set_trigger(
            Trader {
                seat: 12,
                owner: &stray.owner,
            },
            &stray,
            &params,
            MARK,
            true,
            now,
            &stop(950, 900),
        )
        .unwrap();
    r.mark(940);
    let pass = r.fire(32);
    assert_eq!((pass.due, pass.dropped, pass.placed), (1, 1, 0));
    assert_eq!(r.book().active_records(), 0);
}

#[test]
fn a_record_that_cannot_be_planned_is_counted_and_a_sweep_puts_it_back() {
    let mut r = Rig::new();
    r.open_long(100);
    r.set_for(r.maker, stop(1_050, 1_100)).unwrap();
    r.mark(1_060);
    r.w.markets[0].params.tick = 10_000_000;
    let pass = r.fire(32);
    assert_eq!((pass.due, pass.failed, pass.placed), (1, 1, 0));
    let stored = r.w.seats.clone();
    let now = r.w.now;
    assert_eq!(
        r.book().sweep(&stored, 10, now),
        Ok(SweepReport {
            dropped: 0,
            requeued: 1
        })
    );
    r.book().check_invariants().unwrap();
}

#[test]
fn an_expired_record_is_dropped_by_reconcile_and_never_returned_as_due() {
    let mut r = Rig::new();
    r.open_long(100);
    let (a, maker) = (r.a, r.maker);
    let expiring = |at| TriggerInput {
        expiry: at,
        ..stop(950, 900)
    };
    r.set(expiring(r.w.now + 100)).unwrap();
    r.w.now += 200;
    r.mark(MARK);
    assert_eq!(
        r.reconcile(a).stop_loss,
        Standing::Dropped(DropReason::Expired)
    );

    r.mark(MARK);
    let also = TriggerInput {
        expiry: r.w.now + 100,
        ..stop(1_050, 1_100)
    };
    r.set_for(maker, also).unwrap();
    r.w.now += 200;
    r.mark(1_060);
    let pass = r.fire(32);
    assert_eq!((pass.due, pass.placed), (0, 0));
    assert_eq!(r.book().active_records(), 0);
}

#[test]
fn only_the_owner_acts_on_a_seat_and_a_key_reset_clears_it() {
    let mut r = Rig::new();
    r.open_long(100);
    let a = r.a;
    r.set(stop(950, 900)).unwrap();
    let now = r.w.now;
    let stranger = r.stored(r.depth);
    assert_eq!(
        r.book().reconcile(SEATS, &stranger, now),
        Err(TriggerError::SeatOutOfRange)
    );
    let mut moved = r.stored(a);
    moved.owner = [0x55; 32];
    let found = r.book().reconcile(a, &moved, now).unwrap();
    assert_eq!(found.stop_loss, Standing::Dropped(DropReason::SeatGone));
}

#[test]
fn the_deepest_crossing_leaves_first_and_a_pass_stops_at_its_cap() {
    let mut p = Plain::new(8);
    for (seat, trigger) in [(2, 900), (3, 960), (4, 920), (5, 980), (6, 940)] {
        p.stop(seat, trigger);
    }
    let first = p.due(800, START, 3);
    assert_eq!(Plain::seats_of(&first), [5, 3, 6]);
    assert_eq!(p.book().heap_len(BELOW_HEAP), 2);
    p.book().check_invariants().unwrap();
    let rest = p.due(800, START, 10);
    assert_eq!(Plain::seats_of(&rest), [4, 2]);
}

#[test]
fn equal_records_are_served_in_turn_and_a_stuck_one_never_blocks_the_rest() {
    let mut p = Plain::new(8);
    for seat in 2..8 {
        p.stop(seat, 900);
    }
    let mut served = Vec::new();
    for pass in 0..3 {
        let due = p.due(800, START, 2);
        assert_eq!(due.len(), 2, "pass {pass}");
        for entry in &due {
            p.zero_fill(entry, START);
            served.push(entry.seat);
        }
    }
    assert_eq!(served, [2, 3, 4, 5, 6, 7]);
    assert!(p.due(800, START, 2).is_empty(), "all are waiting");
    let again = p.due(800, START + DELAY, 2);
    assert_eq!(Plain::seats_of(&again), [2, 3]);
    p.book().check_invariants().unwrap();
}

#[test]
fn a_record_waiting_for_a_retry_only_returns_while_the_mark_still_holds() {
    let mut p = Plain::new(4);
    p.stop(2, 900);
    let due = p.due(800, START, 1);
    p.zero_fill(&due[0], START);
    assert!(
        p.due(1_000, START + DELAY, 1).is_empty(),
        "the mark reversed"
    );
    assert_eq!(
        p.book().heap_len(BELOW_HEAP),
        1,
        "and it is back on its price heap"
    );
    assert_eq!(p.due(800, START + DELAY, 1).len(), 1);
}

/// Passes of `max` records each over `seats` seats, the first `deep` crossed far (and
/// never filled, so they come back every time) and `late` crossed only a little. The
/// number of passes until `late` is taken, if it is within `passes`.
fn passes_until_taken(seats: u32, deep: u32, late: u32, max: usize, passes: u32) -> Option<u32> {
    let mut p = Plain::new(seats);
    for seat in 2..2 + deep {
        p.stop(seat, 990);
    }
    p.stop(late, 810);
    let mut now = START;
    for _ in 0..2 {
        for entry in p.due(800, now, MAX_FIRES_PER_PASS) {
            p.zero_fill(&entry, now);
        }
    }
    for pass in 1..=passes {
        let due = p.due(800, now, max);
        assert!(due.len() <= max);
        for entry in &due {
            if entry.seat == late {
                return Some(pass);
            }
            p.zero_fill(entry, now);
        }
        p.book().check_invariants().unwrap();
        now += DELAY;
    }
    None
}

#[test]
fn a_shallow_stop_among_endless_deeper_ones_is_taken_within_the_bound() {
    let (seats, deep, max) = (200u32, 100u32, 8usize);
    let late = 150;
    let cursor_passes = u32::try_from(seats as usize / FAIR_WINDOW).unwrap() + 1;
    let share = u32::try_from(max / 4).unwrap();
    let bound = cursor_passes + deep.div_ceil(share);
    let taken = passes_until_taken(seats, deep, late, max, bound);
    assert!(taken.is_some(), "not taken within {bound} passes");
    assert_eq!(
        passes_until_taken(seats, deep, late, 3, 2 * bound),
        None,
        "a pass of fewer than 4 keeps no share for the cursor, and the deepest win"
    );
}

#[test]
fn a_sweep_removes_a_dead_record_within_a_bounded_number_of_calls() {
    let mut p = Plain::new(10);
    for seat in 2..10 {
        p.stop(seat, 900);
    }
    p.seats[7].perp[0].base = 0;
    let g = p.seats[7].generations();
    p.seats[7].set_generations([g[0] + 1, g[1], g[2], g[3]]);
    let Plain { seats, mem } = &mut p;
    let mut book = TriggerBook::open(bytemuck::cast_slice_mut(mem)).unwrap();
    assert_eq!(book.sweep(seats, 3, START), Ok(SweepReport::default()));
    assert_eq!(book.sweep(seats, 3, START), Ok(SweepReport::default()));
    assert!(book.record(7, Kind::StopLoss).is_some());
    assert_eq!(
        book.sweep(seats, 3, START),
        Ok(SweepReport {
            dropped: 1,
            requeued: 0
        })
    );
    assert!(book.record(7, Kind::StopLoss).is_none());
    assert_eq!(
        book.sweep(seats, 30, START),
        Ok(SweepReport::default()),
        "wrapped and clamped"
    );
    book.check_invariants().unwrap();
}

#[test]
fn a_sweep_queues_a_record_taken_and_never_settled_and_clears_seats_past_the_ledger() {
    let mut p = Plain::new(10);
    p.stop(2, 900);
    p.stop(8, 900);
    assert_eq!(p.due(800, START, 1).len(), 1);
    assert_eq!(p.book().heap_len(BELOW_HEAP), 1);
    let Plain { seats, mem } = &mut p;
    let mut book = TriggerBook::open(bytemuck::cast_slice_mut(mem)).unwrap();
    let report = book.sweep(&seats[..5], 10, START).unwrap();
    assert_eq!(
        report,
        SweepReport {
            dropped: 1,
            requeued: 1
        }
    );
    assert_eq!(book.heap_len(BELOW_HEAP), 1);
    assert!(book.record(8, Kind::StopLoss).is_none());
    book.check_invariants().unwrap();
    let mut empty = Plain::new(0);
    assert_eq!(
        empty.book().sweep(&[], 5, START),
        Ok(SweepReport::default())
    );
}

#[test]
fn a_sweep_and_a_pass_over_the_largest_book_read_no_more_than_their_own_slots() {
    const SEATS: u32 = 34_492;
    let mut p = Plain::new(SEATS);
    for seat in 2..SEATS {
        p.stop(seat, 900 + 10 * u64::from(seat % 5));
    }
    for seat in 40..48 {
        p.seats[seat].perp[0].base = 0;
        p.seats[seat].set_generations([1, 0, 0, 0]);
    }
    let Plain { seats, mem } = &mut p;
    let mut book = TriggerBook::open(bytemuck::cast_slice_mut(mem)).unwrap();
    assert_eq!(
        book.sweep(seats, 64, START),
        Ok(SweepReport {
            dropped: 8,
            requeued: 0
        })
    );
    let mut out = [Due::EMPTY; 32];
    assert_eq!(book.due_triggers(800, true, START, 32, &mut out), Ok(32));
    assert_eq!(
        book.slots_scanned(),
        0,
        "neither a sweep nor a pass reads the whole book"
    );
    assert_eq!(book.active_records(), SEATS as usize - 2 - 8);
    assert_eq!(
        book.slots_scanned(),
        u64::from(SEATS),
        "a whole-book read counts"
    );
}

#[test]
fn a_recycled_seat_of_the_same_owner_never_fires_an_old_stop() {
    let recycled = |r: &mut Rig| {
        r.open_long(100);
        let a = r.a;
        let key = r.w.key(a);
        r.set(stop(950, 900)).unwrap();
        r.close_a();
        let left = r.w.collateral(a);
        r.w.withdraw(a, Asset::Collateral, u64::try_from(left).unwrap())
            .unwrap();
        r.w.close(a).unwrap();
        let again = r.w.open_with_key(key).unwrap();
        assert_eq!(again, a, "the same owner gets the same seat back");
        r.w.deposit(again, Asset::Collateral, 1_000_000).unwrap();
        r.open_long(100);
    };
    let mut r = Rig::new();
    recycled(&mut r);
    let a = r.a;
    assert_eq!(r.w.seat(a).generations(), [1, 0, 0, 0]);
    r.mark(940);
    r.bids(930, 100);
    let pass = r.fire(32);
    assert_eq!((pass.placed, pass.dropped), (0, 1));
    assert_eq!(r.base(a), 100);

    let mut r = Rig::new();
    recycled(&mut r);
    r.w.seats[a as usize].set_generations([0; 4]);
    assert_eq!(
        r.reconcile(a).stop_loss,
        Standing::Armed,
        "without the carried generation the old stop would match the new position"
    );
}

#[test]
fn an_old_stop_stays_dead_however_many_times_the_slot_is_reopened_with_no_sweep() {
    let mut r = Rig::new();
    r.open_long(100);
    let a = r.a;
    r.set(stop(950, 900)).unwrap();
    r.close_a();
    r.end_positions(255);
    assert_eq!(r.w.seat(a).generations(), [GENERATION_RETIRED, 0, 0, 0]);
    r.open_long(100);
    r.mark(940);
    r.bids(930, 100);
    let pass = r.fire(32);
    assert_eq!((pass.placed, pass.dropped), (0, 1), "{pass:?}");
    assert_eq!(r.base(a), 100, "the new position was never closed");
    assert_eq!(r.book().active_records(), 0);
}

#[test]
fn a_retired_slot_takes_no_trigger_and_one_just_short_of_it_does() {
    let mut r = Rig::new();
    r.open_long(100);
    let a = r.a;
    r.close_a();
    r.end_positions(253);
    assert_eq!(r.w.seat(a).generation(0), 254);
    r.open_long(100);
    assert_eq!(r.set(stop(950, 900)), Ok(SetOutcome { replaced: false }));
    r.close_a();
    assert_eq!(r.w.seat(a).generation(0), GENERATION_RETIRED);
    r.open_long(100);
    assert_eq!(
        r.reconcile(a).stop_loss,
        Standing::Dropped(DropReason::Flip)
    );
    assert_eq!(r.set(stop(950, 900)), Err(TriggerError::SlotRetired));
    r.end_positions(10);
    assert_eq!(
        r.w.seat(a).generation(0),
        GENERATION_RETIRED,
        "it never wraps"
    );
}

#[test]
fn a_retired_slot_is_reset_once_every_book_is_empty_and_then_works_on_the_new_position() {
    let mut r = Rig::new();
    r.open_long(100);
    let a = r.a;
    r.set(stop(950, 900)).unwrap();
    r.close_a();
    r.end_positions(254);
    assert_eq!(r.w.seat(a).generation(0), GENERATION_RETIRED);
    let version = r.w.seat(a).version;
    let mut elsewhere = Plain::new(SEATS);
    let other = elsewhere.book();
    let Rig { w, mem, .. } = &mut r;
    let book = TriggerBook::open(bytemuck::cast_slice_mut(mem)).unwrap();
    let seat = &mut w.seats[a as usize];

    let refused = reset_slot_generation(seat, a, 0, &[&book, &other]);
    assert_eq!(
        refused,
        Err(TriggerError::RecordsRemain),
        "the dead stop is still set"
    );
    assert_eq!(seat.generation(0), GENERATION_RETIRED);

    r.reconcile(a);
    assert!(!r.book().holds_records_of(a));
    let Rig { w, mem, .. } = &mut r;
    let book = TriggerBook::open(bytemuck::cast_slice_mut(mem)).unwrap();
    reset_slot_generation(&mut w.seats[a as usize], a, 0, &[&book]).unwrap();
    assert_eq!(r.w.seat(a).generations(), [0; 4]);
    assert_eq!(r.w.seat(a).version, version + 1);
    r.w.check_invariants();

    r.open_long(100);
    assert_eq!(r.set(stop(950, 900)), Ok(SetOutcome { replaced: false }));
    r.mark(940);
    r.bids(930, 100);
    let pass = r.fire(32);
    assert_eq!(pass.filled_lots, 100, "{pass:?}");
    assert_eq!(r.base(a), 0);
}

#[test]
fn a_reset_is_refused_while_any_book_holds_a_record_of_the_seat_or_the_slot_is_in_use() {
    let mut r = Rig::new();
    r.open_long(100);
    let a = r.a;
    let mut elsewhere = Plain::new(SEATS);
    elsewhere.stop(a, 900);
    r.set(stop(950, 900)).unwrap();
    r.mark(940);
    r.due_one(940);
    assert!(r.record(a, Kind::StopLoss).is_some_and(|rec| rec.heap == 0));
    let other = elsewhere.book();
    let Rig { w, mem, .. } = &mut r;
    let book = TriggerBook::open(bytemuck::cast_slice_mut(mem)).unwrap();
    let seat = &mut w.seats[a as usize];
    assert_eq!(
        reset_slot_generation(seat, a, 0, &[&book]),
        Err(TriggerError::SlotNotEmpty),
        "a live position"
    );
    seat.perp[0].base = 0;
    seat.perp[0].quote = 0;
    assert_eq!(
        reset_slot_generation(seat, a, 0, &[&book]),
        Err(TriggerError::RecordsRemain),
        "an outstanding record outside every heap"
    );
    r.book().clear_seat(a).unwrap();
    let Rig { w, mem, .. } = &mut r;
    let book = TriggerBook::open(bytemuck::cast_slice_mut(mem)).unwrap();
    assert_eq!(
        reset_slot_generation(&mut w.seats[a as usize], a, 0, &[&book, &other]),
        Err(TriggerError::RecordsRemain),
        "a record in another market's book"
    );
    assert_eq!(
        reset_slot_generation(&mut w.seats[a as usize], a, 4, &[&book]),
        Err(TriggerError::SlotNotEmpty),
        "a slot that does not exist"
    );
    assert_eq!(
        reset_slot_generation(&mut w.seats[a as usize], a, 0, &[&book]),
        Ok(())
    );
}

#[test]
fn the_shallow_record_last_among_dense_crossed_seats_with_a_retry_backlog_is_taken_within_the_bound(
) {
    let (seats, deep, max) = (300u32, 248u32, 8usize);
    let share = u32::try_from(max / 4).unwrap();
    let cursor_passes = u32::try_from(seats as usize).unwrap().div_ceil(64);
    let bound = cursor_passes + deep.div_ceil(share);
    let taken = passes_until_taken(seats, deep, seats - 1, max, bound);
    assert!(taken.is_some(), "not taken within {bound} passes");
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    #[test]
    fn after_any_history_no_record_closes_more_than_it_may_or_acts_on_another_position(
        ops in prop::collection::vec(op(), 1..80)
    ) {
        run_model(&ops);
    }
}

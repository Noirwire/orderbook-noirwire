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
    assert_eq!(SLOT_LEN, 192);
    assert_eq!(book_len(34_492), Some(7_174_376));
    assert_eq!(book_len(1), Some(40 + 192 + 4 * 4));
    assert_eq!(book_len(usize::MAX), None);
}

#[test]
fn a_record_has_no_padding_holes() {
    use core::mem::offset_of;
    let fields = [
        (offset_of!(TriggerRecord, trigger_price), 0),
        (offset_of!(TriggerRecord, worst_price), 8),
        (offset_of!(TriggerRecord, size), 16),
        (offset_of!(TriggerRecord, expiry), 24),
        (offset_of!(TriggerRecord, next_attempt), 32),
        (offset_of!(TriggerRecord, seat_epoch), 40),
        (offset_of!(TriggerRecord, generation), 44),
        (offset_of!(TriggerRecord, record_version), 48),
        (offset_of!(TriggerRecord, pos), 52),
        (offset_of!(TriggerRecord, sequence), 56),
        (offset_of!(TriggerRecord, flags), 60),
        (offset_of!(TriggerRecord, perp_slot), 61),
        (offset_of!(TriggerRecord, heap), 62),
        (offset_of!(TriggerRecord, padding), 63),
        (offset_of!(TriggerRecord, secret), 64),
    ];
    for (found, expected) in fields {
        assert_eq!(found, expected);
    }
    assert_eq!(size_of::<TriggerRecord>(), 80);
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
            Some(MARK),
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
        let pass = r.fire(MAX_FIRES_PER_PASS);
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
    let pass = r.fire(MAX_FIRES_PER_PASS);
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
    let pass = r.fire(MAX_FIRES_PER_PASS);
    assert_eq!((pass.placed, pass.filled_lots, pass.rearmed), (1, 30, 1));
    assert_eq!(r.base(a), 70);
    let waiting = r.record(a, Kind::TakeProfit).unwrap();
    assert_eq!(waiting.size, 70, "its remaining intent");
    assert_eq!(waiting.heap, heap_tag(TIME_HEAP));
    assert_eq!(waiting.next_attempt, r.w.now + DELAY);
    assert_eq!(r.record(a, Kind::StopLoss).unwrap().size, 70);
    assert_eq!(
        r.fire(MAX_FIRES_PER_PASS).due,
        0,
        "nothing is due while it waits"
    );
    r.w.now += DELAY;
    r.mark(1_110);
    r.bids(1_100, 70);
    let pass = r.fire(MAX_FIRES_PER_PASS);
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
        let pass = r.fire(MAX_FIRES_PER_PASS);
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
    let first = r.fire(MAX_FIRES_PER_PASS);
    assert_eq!(first.filled_lots, 40);
    r.w.now += DELAY;
    r.mark(940);
    r.bids(930, 60);
    r.w.place(0, a, ioc(Side::Ask, 930, 60)).unwrap();
    assert_eq!(r.base(a), 0);
    let second = r.fire(MAX_FIRES_PER_PASS);
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
        Ok(FireDecision::Unfillable),
        "no on-tick bid inside the band is unfillable, not an error"
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
    let pass = r.fire(MAX_FIRES_PER_PASS);
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
        ("old mark", |r| r.w.now += 1_000, Idle::MarkNotUsable),
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
            Idle::MarkNotUsable,
        ),
        (
            "settling",
            |r| r.w.markets[0].params.oracle_health = ORACLE_SETTLING,
            Idle::MarkNotUsable,
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
        let pass = r.fire(MAX_FIRES_PER_PASS);
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
    assert_eq!(r.fire(MAX_FIRES_PER_PASS).idle, Some(Idle::WrongBook));

    let mut r = Rig::new();
    r.open_long(100);
    r.set(stop(950, 900)).unwrap();
    r.mark(940);
    r.bytes()[12] = 1;
    let heaps = HEADER_LEN + usize::try_from(SEATS).unwrap() * SLOT_LEN;
    r.bytes()[heaps..heaps + 4].copy_from_slice(&0xFFFF_FFF0u32.to_le_bytes());
    let pass = r.fire(MAX_FIRES_PER_PASS);
    assert_eq!(pass.idle, Some(Idle::BookCorrupt));
    assert_eq!(r.book().check_invariants(), Err(TriggerError::Corrupt));
}

#[test]
fn nothing_is_due_at_a_zero_mark_or_with_no_room_and_a_pass_refuses_a_bad_budget() {
    let mut r = Rig::new();
    r.open_long(100);
    r.set(stop(950, 900)).unwrap();
    let now = r.w.now;
    let mut out = [Due::EMPTY; 4];
    let before = r.mem.clone();
    assert_eq!(r.book().due_triggers(0, now, 4, 10, &mut out), Ok(0));
    assert_eq!(r.book().due_triggers(940, now, 0, 10, &mut out), Ok(0));
    assert_eq!(r.book().due_triggers(940, now, 4, 10, &mut []), Ok(0));
    assert_eq!(before, r.mem);
    r.mark(940);
    r.bids(930, 100);
    for max in [0, MAX_FIRES_PER_PASS + 1] {
        assert_eq!(r.fire(max).idle, Some(Idle::BadBudget), "{max}");
    }
    assert_eq!(r.base(r.a), 100);
    assert_eq!(r.book().due_triggers(940, now, 4, 10, &mut out), Ok(1));
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
            Some(MARK),
            now,
            &stop(950, 900),
        )
        .unwrap();
    r.mark(940);
    let pass = r.fire(MAX_FIRES_PER_PASS);
    assert_eq!((pass.due, pass.dropped, pass.placed), (1, 1, 0));
    assert_eq!(r.book().active_records(), 0);
}

#[test]
fn a_record_with_no_on_tick_price_in_the_band_is_unfillable_and_waits_for_the_retry_delay() {
    let mut r = Rig::new();
    r.open_long(100);
    let maker = r.maker;
    r.set_for(maker, stop(1_050, 1_100)).unwrap();
    r.mark(1_060);
    r.w.markets[0].params.tick = 10_000_000;
    let now = r.w.now;
    let pass = r.fire(MAX_FIRES_PER_PASS);
    assert_eq!(
        (pass.due, pass.failed, pass.placed, pass.unfillable),
        (1, 0, 0, 1)
    );
    let record = r.record(maker, Kind::StopLoss).unwrap();
    assert_eq!(record.next_attempt, now + DELAY);
    assert!(is_queued(&record), "waiting in the time heap");
    r.book().check_invariants().unwrap();

    let again = r.fire(MAX_FIRES_PER_PASS);
    assert_eq!(
        (again.due, again.failed),
        (0, 0),
        "it takes no slot until its time"
    );
}

#[test]
fn a_shrink_keeps_a_stop_blocked_by_resting_orders_blocked() {
    let mut r = Rig::new();
    r.open_long(100);
    let a = r.a;
    r.set(lots(stop(950, 900), 50)).unwrap();
    r.w.place(0, a, limit(Side::Ask, 1_050, 4_000)).unwrap();
    r.w.markets[0].params.im_bps = 5_000;
    r.mark(940);
    r.bids(930, 100);
    assert_eq!(r.fire(MAX_FIRES_PER_PASS).refused, 1);

    r.w.markets[0].params.im_bps = 1_000;
    r.mark(MARK);
    r.sell_a(60);
    assert_eq!(r.base(a), 40);
    let (stored, now) = (r.stored(a), r.w.now);
    let seats = r.w.seats.clone();
    r.book().sweep(&seats, 10, now).unwrap();
    assert_eq!(
        r.record(a, Kind::StopLoss).unwrap().size,
        40,
        "the fixed size followed the position down"
    );
    let params = r.w.markets[0].params;
    let status = r
        .book()
        .status_of(a, &stored, &params, Some(940), now)
        .unwrap();
    assert!(
        matches!(
            status.stop_loss,
            RecordStatus::BlockedByRestingOrders { .. }
        ),
        "{status:?}"
    );
}

#[test]
fn a_blocked_stop_reads_armed_while_no_mark_is_usable() {
    let mut r = Rig::new();
    r.open_long(100);
    let a = r.a;
    r.set(stop(950, 900)).unwrap();
    r.w.place(0, a, limit(Side::Ask, 1_050, 4_000)).unwrap();
    r.w.markets[0].params.im_bps = 5_000;
    r.mark(940);
    r.bids(930, 100);
    assert_eq!(r.fire(MAX_FIRES_PER_PASS).refused, 1);

    let stored = r.stored(a);
    let (params, now) = (r.w.markets[0].params, r.w.now);
    let status = r.book().status_of(a, &stored, &params, None, now).unwrap();
    assert_eq!(status.stop_loss, RecordStatus::Armed);
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
    let pass = r.fire(MAX_FIRES_PER_PASS);
    assert_eq!((pass.due, pass.placed), (0, 0));
    assert_eq!(pass.dropped, 1, "the expired record is counted as dropped");
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
    assert_eq!(
        Plain::seats_of(&first),
        [5, 3, 2],
        "two deepest, and one for the seat cursor, which starts at seat 0"
    );
    assert_eq!(p.book().heap_len(BELOW_HEAP), 2);
    p.book().check_invariants().unwrap();
    let rest = p.due(800, START, 10);
    assert_eq!(Plain::seats_of(&rest), [6, 4]);
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

#[test]
fn a_pass_takes_at_most_four_records_and_a_fired_order_at_most_sixteen_fills() {
    assert_eq!(MAX_FIRES_PER_PASS, 4);
    assert_eq!(TRIGGER_MAX_STEPS, 16);
    let mut p = Plain::new(40);
    for seat in 2..40 {
        p.stop(seat, 900);
    }
    assert_eq!(
        p.due(800, START, 32).len(),
        32,
        "the book itself takes what it is asked"
    );
    let mut r = Rig::new();
    r.open_long(100);
    r.set(stop(950, 900)).unwrap();
    r.set(take(1_100, 1_050)).unwrap();
    r.mark(940);
    assert!(r.fire(MAX_FIRES_PER_PASS).due as usize <= MAX_FIRES_PER_PASS);
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
    let share = u32::try_from(max.div_ceil(4)).unwrap();
    let bound = cursor_passes + deep.div_ceil(share);
    let taken = passes_until_taken(seats, deep, late, max, bound);
    assert!(taken.is_some(), "not taken within {bound} passes");
    for small in 1..4usize {
        let bound = cursor_passes + deep;
        assert!(
            passes_until_taken(seats, deep, late, small, bound).is_some(),
            "a pass of {small} keeps one record for the cursor, so the shallow stop is taken within {bound} passes"
        );
    }
}

#[test]
fn a_sweep_removes_a_dead_record_within_a_bounded_number_of_calls() {
    let mut p = Plain::new(10);
    for seat in 2..10 {
        p.stop(seat, 900);
    }
    p.seats[7].perp[0].base = 0;
    let g = p.seats[7].generations();
    p.seats[7]
        .set_generations([g[0] + 1, g[1], g[2], g[3]])
        .unwrap();
    let Plain { seats, mem } = &mut p;
    let mut book = TriggerBook::open(bytemuck::cast_slice_mut(mem)).unwrap();
    let three = SweepReport {
        examined: 3,
        ..SweepReport::default()
    };
    assert_eq!(book.sweep(seats, 3, START), Ok(three));
    assert_eq!(book.sweep(seats, 3, START), Ok(three));
    assert!(book.record(7, Kind::StopLoss).is_some());
    assert_eq!(
        book.sweep(seats, 3, START),
        Ok(SweepReport {
            examined: 3,
            dropped: 1,
            requeued: 0
        })
    );
    assert!(book.record(7, Kind::StopLoss).is_none());
    assert_eq!(
        book.sweep(seats, 30, START),
        Ok(SweepReport {
            examined: 10,
            ..SweepReport::default()
        }),
        "wrapped and clamped"
    );
    book.check_invariants().unwrap();
}

#[test]
fn a_sweep_queues_a_record_taken_and_never_settled_and_stops_at_the_ledgers_seats() {
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
            examined: 5,
            dropped: 0,
            requeued: 1
        }
    );
    assert_eq!(book.sweep_cursor(), 0, "wrapped at the ledger's 5 seats");
    assert_eq!(book.heap_len(BELOW_HEAP), 2);
    assert!(
        book.record(8, Kind::StopLoss).is_some(),
        "a seat past the ledger's count is never read"
    );
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
        p.seats[seat].set_generations([1, 0, 0, 0]).unwrap();
    }
    let Plain { seats, mem } = &mut p;
    let mut book = TriggerBook::open(bytemuck::cast_slice_mut(mem)).unwrap();
    assert_eq!(
        book.sweep(seats, 64, START),
        Ok(SweepReport {
            examined: 64,
            dropped: 8,
            requeued: 0
        })
    );
    let mut out = [Due::EMPTY; MAX_FIRES_PER_PASS];
    assert_eq!(
        book.due_triggers(800, START, MAX_FIRES_PER_PASS, SEATS as usize, &mut out),
        Ok(MAX_FIRES_PER_PASS)
    );
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
    let pass = r.fire(MAX_FIRES_PER_PASS);
    assert_eq!((pass.placed, pass.dropped), (0, 1));
    assert_eq!(r.base(a), 100);

    let mut r = Rig::new();
    recycled(&mut r);
    r.w.seats[a as usize].set_generations([0; 4]).unwrap();
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
    assert_eq!(r.w.seat(a).generations(), [256, 0, 0, 0]);
    r.open_long(100);
    r.mark(940);
    r.bids(930, 100);
    let pass = r.fire(MAX_FIRES_PER_PASS);
    assert_eq!((pass.placed, pass.dropped), (0, 1), "{pass:?}");
    assert_eq!(r.base(a), 100, "the new position was never closed");
    assert_eq!(r.book().active_records(), 0);
}

#[test]
fn a_slot_past_255_ended_positions_still_takes_a_trigger_and_the_old_one_stays_dead() {
    let mut r = Rig::new();
    r.open_long(100);
    let a = r.a;
    r.set(stop(950, 900)).unwrap();
    r.close_a();
    r.end_positions(300);
    assert_eq!(r.w.seat(a).generation(0), 301);
    r.open_long(100);
    assert_eq!(
        r.reconcile(a).stop_loss,
        Standing::Dropped(DropReason::Flip)
    );
    assert_eq!(r.set(stop(950, 900)), Ok(SetOutcome { replaced: false }));
    assert_eq!(r.record(a, Kind::StopLoss).unwrap().generation, 301);
}

/// Puts `a`'s slot of market 0 one position end short of the generation boundary.
fn at_the_boundary(r: &mut Rig, generations: [u32; 4]) {
    let a = r.a;
    r.w.seats[a as usize].set_generations(generations).unwrap();
}

#[test]
fn a_rollover_kills_a_record_set_before_it_on_another_slot_and_leaves_one_set_after_it_live() {
    let mut w = World::new(10, 8);
    w.add_market(perp_params(0));
    w.add_market(perp_params(1));
    let mut r = Rig::around(w, 0, SEATS);
    let (a, maker) = (r.a, r.maker);
    buy_from(&mut r.w, 1, a, maker, MARK, 10);
    r.open_long(100);
    let slot_one = r.w.seat(a).slot_index(1).unwrap();
    assert_ne!(r.w.seat(a).slot_index(0).unwrap(), slot_one);
    r.set(stop(950, 900)).unwrap();
    let before = r.record(a, Kind::StopLoss).unwrap();
    assert_eq!((before.seat_epoch, before.generation), (0, 0));

    let mut generations = [0; 4];
    generations[slot_one] = GENERATION_MAX - 1;
    at_the_boundary(&mut r, generations);
    sell_all(&mut r.w, 1, a, maker);
    assert_eq!(r.w.seat(a).generation(slot_one), GENERATION_MAX);
    assert_eq!(r.reconcile(a).stop_loss, Standing::Armed, "not yet");

    buy_from(&mut r.w, 1, a, maker, MARK, 10);
    sell_all(&mut r.w, 1, a, maker);

    assert_eq!(r.w.seat(a).seat_epoch(), 1);
    assert_eq!(r.w.seat(a).generations(), [0; 4]);
    assert_eq!(
        r.reconcile(a).stop_loss,
        Standing::Dropped(DropReason::Flip),
        "the other slot's record was set under epoch 0"
    );

    assert_eq!(r.set(stop(950, 900)), Ok(SetOutcome { replaced: false }));
    let after = r.record(a, Kind::StopLoss).unwrap();
    assert_eq!((after.seat_epoch, after.generation), (1, 0));
    assert_eq!(r.reconcile(a).stop_loss, Standing::Armed);
    r.mark(940);
    r.bids(930, 100);
    let pass = r.fire(MAX_FIRES_PER_PASS);
    assert_eq!(pass.filled_lots, 100, "{pass:?}");
}

fn sell_all(w: &mut World, market: usize, seat: u32, maker: u32) {
    let size = w.slot(seat, market).base.unsigned_abs();
    w.place(market, maker, limit(Side::Bid, MARK, size))
        .unwrap();
    w.place(market, seat, ioc(Side::Ask, MARK, size)).unwrap();
}

#[test]
fn an_epoch_bump_kills_a_record_with_the_same_generation_and_slot() {
    let mut r = Rig::new();
    r.open_long(100);
    let a = r.a;
    r.set(stop(950, 900)).unwrap();
    assert_eq!(r.reconcile(a).stop_loss, Standing::Armed);
    let key = r.w.key(a);
    {
        let Rig { w, .. } = &mut r;
        let mut led = ledger(&mut w.header, &mut w.seats);
        reset_seat_epoch(
            &mut led,
            Trader {
                seat: a,
                owner: &key,
            },
        )
        .unwrap();
    }
    assert_eq!(
        r.reconcile(a).stop_loss,
        Standing::Dropped(DropReason::Flip)
    );
    assert_eq!(r.set(stop(950, 900)), Ok(SetOutcome { replaced: false }));
    assert_eq!(r.reconcile(a).stop_loss, Standing::Armed);
}

#[test]
fn a_record_with_a_generation_past_the_maximum_is_corrupt() {
    let mut r = Rig::new();
    r.open_long(100);
    let a = r.a;
    r.set(stop(950, 900)).unwrap();
    let stop_loss = HEADER_LEN + SLOT_LEN * a as usize + 32 + size_of::<TriggerRecord>();
    let generation = stop_loss + core::mem::offset_of!(TriggerRecord, generation);
    r.bytes()[generation..generation + 4].copy_from_slice(&(GENERATION_MAX + 1).to_le_bytes());
    let (seat, now) = (r.w.seats[a as usize], r.w.now);
    let params = r.w.markets[0].params;

    assert_eq!(
        r.book().reconcile(a, &seat, now),
        Err(TriggerError::Corrupt)
    );
    assert_eq!(
        r.book().status_of(a, &seat, &params, None, now),
        Err(TriggerError::Corrupt)
    );
}

#[test]
fn a_live_stop_survives_unrelated_seat_mutations() {
    let mut w = World::new(10, 8);
    w.add_market(perp_params(0));
    w.add_market(perp_params(1));
    let mut r = Rig::around(w, 0, SEATS);
    let (a, maker) = (r.a, r.maker);
    r.open_long(100);
    r.set(stop(950, 900)).unwrap();
    let before = r.record(a, Kind::StopLoss).unwrap();

    r.w.deposit(a, Asset::Collateral, 5_000).unwrap();
    buy_from(&mut r.w, 1, a, maker, MARK, 10);
    r.w.set_seat_access(
        a,
        SeatAccess {
            maker_markets: 0b10,
            taker_markets: 0b10,
            blocked: false,
        },
    )
    .unwrap();
    r.w.set_seat_access(a, SeatAccess::default()).unwrap();
    sell_all(&mut r.w, 1, a, maker);

    assert_eq!(r.reconcile(a).stop_loss, Standing::Armed);
    assert_eq!(r.record(a, Kind::StopLoss).unwrap(), before);
    r.mark(940);
    r.bids(930, 100);
    let pass = r.fire(MAX_FIRES_PER_PASS);
    assert_eq!(pass.filled_lots, 100, "{pass:?}");
}

fn status(r: &mut Rig, seat: u32) -> SeatTriggerStatus {
    let stored = r.stored(seat);
    let now = r.w.now;
    let params = r.w.markets[0].params;
    let mark = Some(r.w.markets[0].price.price);
    r.book()
        .status_of(seat, &stored, &params, mark, now)
        .unwrap()
}

fn open_short(r: &mut Rig, size: u64) {
    let (maker, a) = (r.maker, r.a);
    r.w.place(0, maker, limit(Side::Bid, MARK, size)).unwrap();
    r.w.place(0, a, ioc(Side::Ask, MARK, size)).unwrap();
}

#[test]
fn a_short_take_profit_crossed_by_a_mark_below_one_tick_is_unfillable_not_a_failure() {
    let mut r = Rig::new();
    open_short(&mut r, 100);
    let a = r.a;
    assert_eq!(r.w.markets[0].params.tick, 10);
    r.set(take(900, 950)).unwrap();
    r.mark(1);
    assert_eq!(
        status(&mut r, a),
        SeatTriggerStatus {
            take_profit: RecordStatus::Unfillable { next_attempt: 0 },
            stop_loss: RecordStatus::Gone,
        }
    );

    let pass = r.fire(1);

    assert_eq!(
        (pass.due, pass.placed, pass.failed, pass.unfillable),
        (1, 0, 0, 1)
    );
    assert_eq!(r.base(a), -100);
    let record = r.record(a, Kind::TakeProfit).unwrap();
    assert!(record.is_unfillable());
    assert!(is_queued(&record), "rearmed through the unfillable path");
    r.book().check_invariants().unwrap();
}

#[test]
fn a_record_whose_generation_is_past_the_maximum_ends_the_pass_as_a_corrupt_book() {
    let mut r = Rig::new();
    r.open_long(100);
    let a = r.a;
    r.set(stop(950, 900)).unwrap();
    let stop_loss = HEADER_LEN + SLOT_LEN * a as usize + 32 + size_of::<TriggerRecord>();
    let generation = stop_loss + core::mem::offset_of!(TriggerRecord, generation);
    r.bytes()[generation..generation + 4].copy_from_slice(&(GENERATION_MAX + 1).to_le_bytes());
    r.mark(940);

    let pass = r.fire(MAX_FIRES_PER_PASS);

    assert_eq!(pass.idle, Some(Idle::BookCorrupt));
    assert_eq!(pass.failed, 0);
    assert_eq!(pass.placed, 0);
}

#[test]
fn a_crossed_record_whose_clipped_price_needs_more_lots_than_its_size_is_unfillable_without_a_flag()
{
    let mut r = Rig::new();
    open_short(&mut r, 100);
    let a = r.a;
    r.w.markets[0].params.min_notional = 1_200;
    r.set(lots(take(900, 950), 2)).unwrap();
    assert_eq!(status(&mut r, a).take_profit, RecordStatus::Armed);

    r.mark(500);
    assert_eq!(
        status(&mut r, a).take_profit,
        RecordStatus::Unfillable { next_attempt: 0 }
    );
    assert!(!r.record(a, Kind::TakeProfit).unwrap().is_unfillable());
    let now = r.w.now;
    let params = r.w.markets[0].params;
    let stored = r.stored(a);
    assert_eq!(
        r.book()
            .status_of(a, &stored, &params, None, now)
            .unwrap()
            .take_profit,
        RecordStatus::Armed,
        "without a usable mark only the set-time rule applies"
    );
}

#[test]
fn a_flagged_record_reads_armed_once_the_minimum_is_lowered() {
    let mut r = Rig::new();
    r.open_long(100);
    let a = r.a;
    r.set(lots(stop(950, 900), 2)).unwrap();
    r.w.markets[0].params.min_size = 6;
    r.mark(940);
    r.bids(930, 100);
    assert_eq!(r.fire(MAX_FIRES_PER_PASS).unfillable, 1);
    assert!(r.record(a, Kind::StopLoss).unwrap().is_unfillable());
    assert!(matches!(
        status(&mut r, a).stop_loss,
        RecordStatus::Unfillable { .. }
    ));

    r.w.markets[0].params.min_size = 1;
    assert_eq!(status(&mut r, a).stop_loss, RecordStatus::Armed);
}

#[test]
fn a_flagged_record_reads_armed_once_the_position_shrinks_to_its_size() {
    let mut r = Rig::new();
    r.open_long(100);
    let a = r.a;
    r.set(lots(stop(950, 900), 2)).unwrap();
    r.w.markets[0].params.min_size = 6;
    r.mark(940);
    r.bids(930, 100);
    assert_eq!(r.fire(MAX_FIRES_PER_PASS).unfillable, 1);
    assert!(r.record(a, Kind::StopLoss).unwrap().is_unfillable());

    r.mark(MARK);
    r.sell_a(98);
    r.mark(940);
    assert_eq!(r.base(a), 2);
    assert!(r.record(a, Kind::StopLoss).unwrap().is_unfillable());
    assert_eq!(status(&mut r, a).stop_loss, RecordStatus::Armed);
}

#[test]
fn a_seat_with_no_record_has_none_and_a_record_is_armed_beside_its_missing_sibling() {
    let mut r = Rig::new();
    r.open_long(100);
    let a = r.a;
    assert_eq!(status(&mut r, a), SeatTriggerStatus::default());

    r.set(stop(950, 900)).unwrap();
    assert_eq!(
        status(&mut r, a),
        SeatTriggerStatus {
            take_profit: RecordStatus::Gone,
            stop_loss: RecordStatus::Armed,
        }
    );
    r.set(take(1_100, 1_050)).unwrap();
    assert_eq!(status(&mut r, a).take_profit, RecordStatus::Armed);
}

#[test]
fn a_record_that_cannot_place_for_its_size_is_unfillable_with_its_next_attempt() {
    let mut r = Rig::new();
    r.open_long(100);
    let a = r.a;
    r.set(lots(stop(950, 900), 2)).unwrap();
    r.w.markets[0].params.min_size = 6;
    r.mark(940);
    r.bids(930, 100);
    let pass = r.fire(MAX_FIRES_PER_PASS);
    assert_eq!(pass.unfillable, 1);

    let next_attempt = r.record(a, Kind::StopLoss).unwrap().next_attempt;
    assert_ne!(next_attempt, 0);
    assert_eq!(
        status(&mut r, a).stop_loss,
        RecordStatus::Unfillable { next_attempt }
    );
}

#[test]
fn a_fixed_size_record_is_unfillable_once_the_minimum_passes_it_without_any_fire_attempt() {
    let mut r = Rig::new();
    r.open_long(100);
    let a = r.a;
    r.set(lots(stop(950, 900), 2)).unwrap();
    assert_eq!(status(&mut r, a).stop_loss, RecordStatus::Armed);

    r.w.markets[0].params.min_size = 6;
    assert_eq!(
        status(&mut r, a).stop_loss,
        RecordStatus::Unfillable { next_attempt: 0 }
    );
    assert!(
        !r.record(a, Kind::StopLoss).unwrap().is_unfillable(),
        "a read sets no flag"
    );

    r.w.markets[0].params.min_size = 1;
    assert_eq!(status(&mut r, a).stop_loss, RecordStatus::Armed);

    r.w.markets[0].params.min_size = 1_000;
    r.set(stop(960, 900)).unwrap();
    assert_eq!(
        status(&mut r, a).stop_loss,
        RecordStatus::Armed,
        "a whole-position record is never below the minimum"
    );
}

#[test]
fn a_fixed_size_record_that_is_the_whole_position_is_always_fillable() {
    let mut r = Rig::new();
    r.open_long(100);
    let a = r.a;
    r.set(lots(stop(950, 900), 100)).unwrap();
    r.w.markets[0].params.min_size = 1_000;
    assert_eq!(status(&mut r, a).stop_loss, RecordStatus::Armed);
}

#[test]
fn a_record_its_position_has_left_behind_is_gone_by_the_rules_reconcile_uses() {
    let mut r = Rig::new();
    r.open_long(100);
    let a = r.a;
    let expiring = TriggerInput {
        expiry: r.w.now + 100,
        ..stop(950, 900)
    };
    r.set(expiring).unwrap();
    let held = r.stored(a);

    let now = r.w.now;
    let params = r.w.markets[0].params;
    let at = |r: &mut Rig, seat: &Seat, now: i64| {
        r.book()
            .status_of(a, seat, &params, Some(MARK), now)
            .unwrap()
    };
    assert_eq!(at(&mut r, &held, now).stop_loss, RecordStatus::Armed);
    assert_eq!(
        at(&mut r, &held, now + 101).stop_loss,
        RecordStatus::Gone,
        "expired"
    );
    let mut other_owner = held;
    other_owner.owner = [7; 32];
    assert_eq!(
        at(&mut r, &other_owner, now).stop_loss,
        RecordStatus::Gone,
        "another owner"
    );

    r.close_a();
    assert_eq!(status(&mut r, a).stop_loss, RecordStatus::Gone, "flat");
    assert!(
        r.record(a, Kind::StopLoss).is_some(),
        "a read drops nothing"
    );

    r.open_long(100);
    assert_eq!(
        status(&mut r, a).stop_loss,
        RecordStatus::Gone,
        "a later position of the same side"
    );
}

#[test]
fn the_status_of_a_seat_says_nothing_of_the_records_of_any_other() {
    let mut r = Rig::new();
    r.open_long(100);
    let (a, maker, depth) = (r.a, r.maker, r.depth);
    r.set(stop(950, 900)).unwrap();
    r.set_for(maker, stop(1_050, 1_100)).unwrap();

    assert_eq!(status(&mut r, depth), SeatTriggerStatus::default());
    assert_eq!(status(&mut r, a).stop_loss, RecordStatus::Armed);
    assert_eq!(status(&mut r, a).take_profit, RecordStatus::Gone);
    let stored = r.stored(a);
    let params = r.w.markets[0].params;
    assert_eq!(
        r.book().status_of(SEATS + 5, &stored, &params, None, 0),
        Ok(SeatTriggerStatus::default()),
        "a seat the book has no slot for"
    );
}

#[test]
fn the_status_block_is_laid_at_the_start_of_the_reserve_and_a_zero_tag_means_unknown() {
    use bytemuck::Zeroable;
    assert_eq!(size_of::<TriggerStatusBlock>(), 24);
    let mut snapshot = SeatSnapshot::zeroed();
    assert_eq!(snapshot._seat_reserved[0], 0, "unwritten is unknown");

    write_trigger_status(
        &mut snapshot,
        3,
        &SeatTriggerStatus {
            take_profit: RecordStatus::Armed,
            stop_loss: RecordStatus::Unfillable { next_attempt: 77 },
        },
    );
    let reserve = &snapshot._seat_reserved;
    assert_eq!(
        reserve[..4],
        [
            TRIGGER_STATUS_TAG,
            3,
            TRIGGER_STATUS_ARMED,
            TRIGGER_STATUS_UNFILLABLE
        ]
    );
    assert_eq!(reserve[8..16], 0i64.to_le_bytes());
    assert_eq!(reserve[16..24], 77i64.to_le_bytes());
    assert!(reserve[24..].iter().all(|byte| *byte == 0));
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

#[test]
fn a_sweep_over_a_window_of_dead_records_finishes_over_several_calls_and_skips_no_seat() {
    let seats = 400u32;
    let mut p = Plain::new(seats);
    for seat in 2..seats {
        p.stop(seat, 900);
    }
    for seat in 2..seats as usize {
        p.seats[seat].perp[0].base = 0;
        p.seats[seat].set_generations([1, 0, 0, 0]).unwrap();
    }
    let Plain { seats: ledger, mem } = &mut p;
    let mut book = TriggerBook::open(bytemuck::cast_slice_mut(mem)).unwrap();

    let (mut calls, mut dropped) = (0u32, 0u32);
    while book.active_records() > 0 {
        let before = book.sweep_cursor();
        let report = book.sweep(ledger, 400, START).unwrap();
        calls += 1;
        dropped += report.dropped;
        assert!(report.examined >= 1, "every call makes progress");
        assert!(
            report.dropped <= SWEEP_MAX_HEAP_CHANGES + 2,
            "a call stops near the heap change limit, dropped {}",
            report.dropped
        );
        assert_eq!(
            book.sweep_cursor(),
            (before + report.examined) % 400,
            "the cursor rests on the first seat not handled"
        );
        for seat in 2..400u32 {
            let handled = seat >= before && seat < before + report.examined;
            let reached_earlier = seat < before;
            if handled || reached_earlier {
                assert!(
                    book.record(seat, Kind::StopLoss).is_none(),
                    "seat {seat} was skipped by call {calls}"
                );
            } else {
                assert!(
                    book.record(seat, Kind::StopLoss).is_some(),
                    "seat {seat} was touched before its turn in call {calls}"
                );
            }
        }
        assert!(calls < 50, "the sweep never finishes");
    }
    assert!(calls > 1, "one call could not have done all of it");
    assert_eq!(dropped, 398);
    book.check_invariants().unwrap();
}

#[test]
fn a_book_made_for_the_largest_ledger_works_on_a_small_one_and_after_the_ledger_grows() {
    const BOOK_SEATS: u32 = 34_492;
    let small: Vec<Seat> = (0..10).map(|i| plain_seat(i, 100)).collect();
    let mut p = Plain::sized(small, BOOK_SEATS);
    for seat in 2..10 {
        p.stop(seat, 900);
    }
    let header = |p: &Plain| -> TriggerHeader {
        *bytemuck::from_bytes(&bytemuck::cast_slice::<u64, u8>(&p.mem)[..HEADER_LEN])
    };
    assert_eq!(header(&p).seat_capacity, BOOK_SEATS);

    {
        let Plain { seats, mem } = &mut p;
        let mut book = TriggerBook::open(bytemuck::cast_slice_mut(mem)).unwrap();
        let first = book.sweep(seats, 7, START).unwrap();
        assert_eq!(first.examined, 7);
        assert_eq!(book.sweep_cursor(), 7);
        book.sweep(seats, 7, START).unwrap();
        assert_eq!(book.sweep_cursor(), 4, "wraps at the ledger's 10 seats");
        let wide = book.sweep(seats, 5_000, START).unwrap();
        assert_eq!(wide.examined, 10, "a sweep never reads past the ledger");
    }
    assert!(p.due(1_000, START, 4).is_empty());
    assert!(
        header(&p).fair_cursor < 10,
        "the fairness cursor stays on the ledger's seats"
    );

    p.seats.extend((10..50).map(|i| plain_seat(i, 100)));
    p.stop(40, 900);
    {
        let Plain { seats, mem } = &mut p;
        let mut book = TriggerBook::open(bytemuck::cast_slice_mut(mem)).unwrap();
        assert!(book.record(40, Kind::StopLoss).is_some());
        let swept = book.sweep(seats, 64, START).unwrap();
        assert_eq!(swept.examined, 50, "the grown ledger is swept in full");
        assert_eq!(swept.dropped, 0);
        book.check_invariants().unwrap();
    }
    let mut lone = Plain::sized((0..50).map(|i| plain_seat(i, 100)).collect(), BOOK_SEATS);
    lone.stop(40, 900);
    assert_eq!(
        Plain::seats_of(&lone.due(800, START, 1)),
        [40],
        "the fairness cursor reaches a seat past the old capacity"
    );
}

fn stop_loss_byte(seat: u32, offset: usize) -> usize {
    HEADER_LEN + SLOT_LEN * seat as usize + 32 + size_of::<TriggerRecord>() + offset
}

#[test]
fn a_record_or_heap_entry_that_disagrees_with_the_book_is_corrupt_wherever_it_is_met() {
    use core::mem::offset_of;
    let armed = || {
        let mut r = Rig::new();
        r.open_long(100);
        r.set(stop(950, 900)).unwrap();
        r
    };

    let mut r = armed();
    let (a, now) = (r.a, r.w.now);
    let at = stop_loss_byte(a, offset_of!(TriggerRecord, generation));
    r.bytes()[at..at + 4].copy_from_slice(&(GENERATION_MAX + 1).to_le_bytes());
    let stored = r.stored(a);
    let params = r.w.markets[0].params;
    assert_eq!(r.book().check_invariants(), Err(TriggerError::Corrupt));
    assert_eq!(
        r.book().reconcile(a, &stored, now),
        Err(TriggerError::Corrupt),
        "a generation no seat could have written"
    );
    assert_eq!(
        r.book().status_of(a, &stored, &params, Some(MARK), now),
        Err(TriggerError::Corrupt)
    );

    let mut r = armed();
    let (a, now) = (r.a, r.w.now);
    let at = stop_loss_byte(a, offset_of!(TriggerRecord, pos));
    r.bytes()[at..at + 4].copy_from_slice(&7u32.to_le_bytes());
    let (stored, key) = (r.stored(a), r.w.key(a));
    assert_eq!(r.book().check_invariants(), Err(TriggerError::Corrupt));
    assert_eq!(
        r.book().cancel_trigger(
            Trader {
                seat: a,
                owner: &key
            },
            &stored,
            Kind::StopLoss,
            now
        ),
        Err(TriggerError::Corrupt),
        "a heap position out of range"
    );

    let mut r = armed();
    let a = r.a;
    let at = stop_loss_byte(a, offset_of!(TriggerRecord, heap));
    r.bytes()[at] = 0;
    assert_eq!(r.book().check_invariants(), Err(TriggerError::Corrupt));
    r.mark(940);
    r.bids(930, 100);
    assert_eq!(
        r.fire(MAX_FIRES_PER_PASS).idle,
        Some(Idle::BookCorrupt),
        "a heap root whose record says it is in no heap"
    );
    assert_eq!(r.base(a), 100);
}

#[test]
fn a_stop_blocked_by_resting_orders_reads_blocked_and_closes_once_the_order_is_cancelled() {
    let mut r = Rig::new();
    r.open_long(100);
    let a = r.a;
    r.set(stop(950, 900)).unwrap();
    let ask = |r: &mut Rig| {
        r.w.place(0, a, limit(Side::Ask, 1_050, 4_000)).unwrap();
    };
    ask(&mut r);
    r.w.markets[0].params.im_bps = 5_000;
    r.mark(940);
    r.bids(930, 100);

    let pass = r.fire(MAX_FIRES_PER_PASS);
    assert_eq!(
        (pass.due, pass.placed, pass.refused, pass.rearmed),
        (1, 0, 1, 1)
    );
    assert_eq!(r.base(a), 100, "the position is still open");
    let stored = r.stored(a);
    let (params, now) = (r.w.markets[0].params, r.w.now);
    let status = |r: &mut Rig| {
        r.book()
            .status_of(a, &stored, &params, Some(940), now)
            .unwrap()
    };
    let retry = r.record(a, Kind::StopLoss).unwrap().next_attempt;
    assert_eq!(
        status(&mut r).stop_loss,
        RecordStatus::BlockedByRestingOrders {
            next_attempt: retry
        }
    );
    assert_eq!(status(&mut r).take_profit, RecordStatus::Gone);
    assert_eq!(
        r.w.cancel_all(0, a, 10).unwrap(),
        1,
        "the owner's order was left alone until the owner cancelled it"
    );

    r.w.now += DELAY;
    r.mark(940);
    let pass = r.fire(MAX_FIRES_PER_PASS);
    assert_eq!((pass.placed, pass.refused), (1, 0));
    assert_eq!(r.base(a), 0, "the next pass closes the position");
    assert!(r.record(a, Kind::StopLoss).is_none());
}

#[test]
fn a_trigger_can_be_set_while_the_market_is_paused_but_fires_only_after_it_resumes() {
    let mut r = Rig::new();
    r.open_long(100);
    r.bids(930, 100);
    let (a, active) = (r.a, r.w.markets[0].params.status);
    r.w.markets[0].params.status = STATUS_PAUSED;

    r.set(stop(950, 900)).unwrap();
    r.mark(940);
    assert_eq!(r.fire(MAX_FIRES_PER_PASS).idle, Some(Idle::MarketPaused));
    assert_eq!(r.base(a), 100);

    r.w.markets[0].params.status = active;
    assert_eq!(r.fire(MAX_FIRES_PER_PASS).placed, 1);
    assert_eq!(r.base(a), 0);
}

#[test]
fn a_mark_is_usable_only_while_healthy_and_fresh_and_a_pass_idles_on_every_other_one() {
    for (name, damage) in [
        ("old", (|r: &mut Rig| r.w.now += 1_000) as fn(&mut Rig)),
        ("dislocated", |r| {
            r.w.markets[0].params.oracle_health = ORACLE_DISLOCATED
        }),
        ("settling", |r| {
            r.w.markets[0].params.oracle_health = ORACLE_SETTLING
        }),
    ] {
        let mut r = Rig::new();
        r.open_long(100);
        damage(&mut r);
        let risk = r.w.risks()[0];
        assert_eq!(risk.usable_mark(r.w.now), None, "{name}");
        assert_eq!(
            r.fire(MAX_FIRES_PER_PASS).idle,
            Some(Idle::MarkNotUsable),
            "{name}"
        );
    }
    let mut r = Rig::new();
    r.open_long(100);
    let risk = r.w.risks()[0];
    assert_eq!(risk.usable_mark(r.w.now), Some(MARK));
}

#[test]
fn a_blocked_stop_reads_armed_again_once_the_mark_has_left_its_trigger() {
    let mut r = Rig::new();
    r.open_long(100);
    let a = r.a;
    r.set(stop(950, 900)).unwrap();
    r.w.place(0, a, limit(Side::Ask, 1_050, 4_000)).unwrap();
    r.w.markets[0].params.im_bps = 5_000;
    r.mark(940);
    r.bids(930, 100);
    assert_eq!(r.fire(MAX_FIRES_PER_PASS).refused, 1);

    let stored = r.stored(a);
    let (params, now) = (r.w.markets[0].params, r.w.now);
    let blocked = r
        .book()
        .status_of(a, &stored, &params, Some(940), now)
        .unwrap();
    assert!(matches!(
        blocked.stop_loss,
        RecordStatus::BlockedByRestingOrders { .. }
    ));
    let recovered = r
        .book()
        .status_of(a, &stored, &params, Some(1_000), now)
        .unwrap();
    assert_eq!(recovered.stop_loss, RecordStatus::Armed);
}

#[test]
fn a_record_never_acts_on_another_markets_position_that_took_over_its_physical_slot() {
    let mut w = World::new(10, 8);
    for id in 0..5u8 {
        let mut params = perp_params(id);
        params.market_id = id;
        w.add_market(params);
    }
    let mut r = Rig::around(w, 0, SEATS);
    let (a, maker) = (r.a, r.maker);

    r.open_long(100);
    for market in 2..5usize {
        r.w.place(market, a, limit(Side::Bid, MARK, 1)).unwrap();
    }
    let held = r.stored(a);
    assert_eq!(held.slot_index(0), Some(0));
    assert!(held.slot_index(1).is_none());
    assert_eq!(held.generation(0), 0);
    r.set(stop(950, 900)).unwrap();

    r.close_a();
    let ended = r.stored(a);
    assert_eq!(ended.generation(0), 1, "ending the position bumps the slot");
    assert_eq!(
        ended.slot_index(0),
        Some(0),
        "the slot keeps its market tag"
    );

    buy_from(&mut r.w, 1, a, maker, MARK, 100);
    let reused = r.stored(a);
    assert_eq!(
        reused.slot_index(1),
        Some(0),
        "market 1 takes the physical slot market 0 held, every slot being tagged"
    );
    assert_eq!(reused.slot_index(0), None);

    r.mark(900);
    r.bids(900, 1_000);
    let pass = r.fire(MAX_FIRES_PER_PASS);
    assert!(pass.idle.is_none(), "{pass:?}");
    assert_eq!((pass.due, pass.placed, pass.dropped), (1, 0, 1), "{pass:?}");
    assert_eq!(
        r.w.slot(a, 1).base,
        100,
        "the market 1 position in the reused slot is intact"
    );
    assert!(r.record(a, Kind::StopLoss).is_none());
}

#[test]
fn a_crossed_record_is_served_while_many_others_wait_in_the_time_heap_for_a_retry() {
    let mut w = World::new(40, 8);
    w.add_market(perp_params(0));
    let mut rig = Rig::around(w, 0, 20);
    rig.open_long(100);
    rig.set(stop(950, 900)).unwrap();
    let victim = rig.a;
    let seller = funded(&mut rig.w, 1_000_000);
    let mut flood = Vec::new();
    for _ in 0..4 {
        let seat = funded(&mut rig.w, 1_000_000);
        buy_from(&mut rig.w, 0, seat, seller, MARK, 10);
        rig.set_for(seat, take(1_100, 1_050)).unwrap();
        rig.set_for(seat, stop(950, 900)).unwrap();
        flood.push(seat);
    }
    rig.mark(900);
    let now = rig.w.now;
    for seat in flood.iter().copied().chain([victim]) {
        for kind in [Kind::TakeProfit, Kind::StopLoss] {
            let Some(record) = rig.record(seat, kind) else {
                continue;
            };
            let due = Due {
                seat,
                kind,
                record_version: record.record_version,
                secret: [7; 16],
            };
            let stored = rig.stored(seat);
            rig.book()
                .record_fire_outcome(
                    &due,
                    FireOutcome::Placed { filled: 0 },
                    &stored,
                    now - DELAY - 1,
                    DELAY,
                )
                .unwrap();
        }
    }

    rig.bids(900, 1_000);
    let first = rig.fire(4);
    assert!(first.idle.is_none(), "{first:?}");
    assert!(first.due > 0, "{first:?}");
    assert!(
        first.placed > 0,
        "crossed stops fill against the bids: {first:?}"
    );
    let mut served = rig.base(victim) == 0;
    for _ in 0..2 {
        if served {
            break;
        }
        rig.w.now += DELAY + 1;
        rig.mark(900);
        rig.bids(900, 1_000);
        rig.fire(4);
        served = rig.base(victim) == 0;
    }
    assert!(
        served,
        "the victim's crossed stop was held back by the retry backlog"
    );
}

#[test]
fn a_fired_order_cancels_the_owners_own_bids_it_meets_and_a_closing_stop_is_not_blocked_by_them() {
    let mut r = Rig::new();
    r.open_long(100);
    r.w.place(0, r.a, limit(Side::Bid, 920, 10)).unwrap();
    r.set(stop(950, 900)).unwrap();
    r.bids(900, 1_000);
    r.mark(900);
    let pass = r.fire(4);
    assert!(pass.idle.is_none(), "{pass:?}");
    assert_eq!((pass.placed, pass.refused), (1, 0), "{pass:?}");
    assert_eq!(pass.filled_lots, 100, "{pass:?}");
    assert_eq!(r.base(r.a), 0);
    assert!(
        r.w.markets[0]
            .resting(Side::Bid)
            .iter()
            .all(|order| order.seat != r.a),
        "the owner's own bid was met first and released, never filled"
    );
    assert!(r.record(r.a, Kind::StopLoss).is_none());
}

#[test]
fn a_fired_order_leaves_the_owners_own_bids_it_never_meets() {
    let mut r = Rig::new();
    r.open_long(100);
    r.w.place(0, r.a, limit(Side::Bid, 920, 10)).unwrap();
    r.w.place(0, r.a, limit(Side::Bid, 880, 10)).unwrap();
    r.set(stop(950, 900)).unwrap();
    r.bids(930, 1_000);
    r.mark(900);
    let pass = r.fire(4);
    assert_eq!((pass.placed, pass.filled_lots), (1, 100), "{pass:?}");
    let own: Vec<u64> = r.w.markets[0]
        .resting(Side::Bid)
        .iter()
        .filter(|order| order.seat == r.a)
        .map(|order| order.price)
        .collect();
    assert_eq!(
        own,
        [920, 880],
        "better bids filled the whole position first, and 880 is beyond the worst price"
    );
}

#[test]
fn an_expired_record_met_in_a_pass_is_dropped_counted_and_places_nothing() {
    for max in [MAX_FIRES_PER_PASS, 1] {
        let mut r = Rig::new();
        r.open_long(100);
        let mut request = stop(950, 900);
        request.expiry = r.w.now + DELAY - 1;
        r.set(request).unwrap();
        r.mark(MARK);
        let quiet = r.fire(max);
        assert_eq!(
            (quiet.due, quiet.placed, quiet.dropped),
            (0, 0, 0),
            "max {max}: nothing is due and nothing is dropped {quiet:?}"
        );

        let mut r = Rig::new();
        r.open_long(100);
        let mut request = stop(950, 900);
        request.expiry = r.w.now + DELAY - 1;
        r.set(request).unwrap();
        r.mark(900);
        r.bids(900, 1_000);
        r.w.now += DELAY;
        r.mark(900);
        let pass = r.fire(max);
        assert!(pass.idle.is_none(), "max {max}: {pass:?}");
        assert_eq!(
            (pass.due, pass.placed, pass.dropped),
            (0, 0, 1),
            "max {max}: {pass:?}"
        );
        assert_eq!(r.base(r.a), 100, "the position is untouched");
        assert!(r.record(r.a, Kind::StopLoss).is_none());

        let again = r.fire(max);
        assert_eq!(
            (again.due, again.placed, again.dropped),
            (0, 0, 0),
            "max {max}: nothing is left to drop {again:?}"
        );
    }
}

#[test]
fn a_stop_cannot_act_on_a_position_a_liquidation_already_took() {
    let mut w = World::new(10, 8);
    w.add_market(perp_params(0));
    let maker = funded(&mut w, 1_000_000);
    let victim = w.open();
    w.deposit(victim, Asset::Collateral, 10_900).unwrap();
    let depth = funded(&mut w, 1_000_000);
    let mut mem = vec![0u64; book_len(SEATS as usize).unwrap().div_ceil(8)];
    TriggerBook::init(bytemuck::cast_slice_mut(&mut mem), 0, SEATS).unwrap();
    let mut r = Rig {
        w,
        mem,
        maker,
        a: victim,
        depth,
    };

    buy_from(&mut r.w, 0, victim, maker, MARK, 100);
    r.set(stop(950, 900)).unwrap();
    r.mark(900);
    let liquidator = funded(&mut r.w, 1_000_000);
    let key = r.w.key(liquidator);
    let outcome = r.w.liquidate_as(0, liquidator, key, victim, 100).unwrap();
    assert_eq!(outcome.status, LiquidationStatus::Liquidated);
    assert_eq!(outcome.liquidated, 100, "the whole position is taken");
    assert_eq!(r.base(victim), 0);
    assert_eq!(r.base(liquidator), 100);

    r.bids(900, 1_000);
    let before: Vec<i64> = (0..r.w.seats.len() as u32)
        .map(|seat| r.base(seat))
        .collect();
    let pass = r.fire(4);
    assert_eq!((pass.due, pass.placed, pass.dropped), (1, 0, 1), "{pass:?}");
    let after: Vec<i64> = (0..r.w.seats.len() as u32)
        .map(|seat| r.base(seat))
        .collect();
    assert_eq!(before, after, "no seat's position moved");
    assert_eq!(
        r.base(liquidator),
        100,
        "the liquidator's position is intact"
    );
    assert!(r.record(victim, Kind::StopLoss).is_none());
}

#[test]
fn a_liquidation_after_a_stop_closed_the_position_finds_nothing_to_take() {
    let mut w = World::new(10, 8);
    w.add_market(perp_params(0));
    let maker = funded(&mut w, 1_000_000);
    let victim = w.open();
    w.deposit(victim, Asset::Collateral, 13_000).unwrap();
    let depth = funded(&mut w, 1_000_000);
    let mut mem = vec![0u64; book_len(SEATS as usize).unwrap().div_ceil(8)];
    TriggerBook::init(bytemuck::cast_slice_mut(&mut mem), 0, SEATS).unwrap();
    let mut r = Rig {
        w,
        mem,
        maker,
        a: victim,
        depth,
    };

    buy_from(&mut r.w, 0, victim, maker, MARK, 100);
    r.set(stop(950, 900)).unwrap();
    r.mark(900);
    r.bids(900, 1_000);
    let pass = r.fire(4);
    assert_eq!((pass.placed, pass.filled_lots), (1, 100), "{pass:?}");
    assert_eq!(r.base(victim), 0, "the stop closed the whole position");

    let liquidator = funded(&mut r.w, 1_000_000);
    let key = r.w.key(liquidator);
    let outcome = r.w.liquidate_as(0, liquidator, key, victim, 100).unwrap();
    assert_eq!(outcome.status, LiquidationStatus::NoPosition, "{outcome:?}");
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

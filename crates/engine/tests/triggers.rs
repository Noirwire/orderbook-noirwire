//! Take-profit and stop-loss triggers: the book's layout and heaps, what `set_trigger`
//! refuses, how a record follows its position, and firing through `place_order`.

mod common;

use bytemuck::Zeroable;
use common::*;
use noirwire_orderbook_engine::EngineError as E;
use noirwire_orderbook_engine::*;
use proptest::prelude::*;

const SEATS: u32 = 10;
const DELAY: i64 = 30;

fn input(kind: Kind, trigger: u64, worst: u64, size: TriggerSize) -> TriggerInput {
    TriggerInput {
        kind,
        trigger_price: trigger,
        worst_price: worst,
        size,
        expiry: 0,
        client_id: 7,
    }
}

fn stop(trigger: u64, worst: u64) -> TriggerInput {
    input(Kind::StopLoss, trigger, worst, TriggerSize::WholePosition)
}

fn take(trigger: u64, worst: u64) -> TriggerInput {
    input(Kind::TakeProfit, trigger, worst, TriggerSize::WholePosition)
}

fn lots(mut request: TriggerInput, size: u64) -> TriggerInput {
    request.size = TriggerSize::Lots(size);
    request
}

struct Rig {
    w: World,
    mem: Vec<u64>,
    maker: u32,
    a: u32,
    depth: u32,
}

impl Rig {
    fn new() -> Rig {
        Rig::build(perp_params(0), 0, SEATS)
    }

    fn with(params: MarketParams) -> Rig {
        Rig::build(params, 0, SEATS)
    }

    fn build(params: MarketParams, book_market: u8, book_seats: u32) -> Rig {
        let (mut w, _) = perp_world(params);
        let maker = funded(&mut w, 1_000_000);
        let a = funded(&mut w, 1_000_000);
        let depth = funded(&mut w, 1_000_000);
        let words = book_len(book_seats as usize).unwrap().div_ceil(8);
        let mut mem = vec![0u64; words];
        TriggerBook::init(bytemuck::cast_slice_mut(&mut mem), book_market, book_seats).unwrap();
        Rig {
            w,
            mem,
            maker,
            a,
            depth,
        }
    }

    fn bytes(&mut self) -> &mut [u8] {
        bytemuck::cast_slice_mut(&mut self.mem)
    }

    fn book(&mut self) -> TriggerBook<'_> {
        TriggerBook::open(self.bytes()).unwrap()
    }

    fn open_long(&mut self, size: u64) {
        buy_from(&mut self.w, 0, self.a, self.maker, MARK, size);
    }

    fn bids(&mut self, price: u64, size: u64) {
        self.w
            .place(0, self.depth, limit(Side::Bid, price, size))
            .unwrap();
    }

    fn mark(&mut self, price: u64) {
        self.w.set_price(0, price);
    }

    fn base(&self, seat: u32) -> i64 {
        self.w.slot(seat, 0).base
    }

    fn set_raw(
        &mut self,
        seat: u32,
        params: MarketParams,
        mark: u64,
        fresh: bool,
        now: i64,
        request: TriggerInput,
    ) -> TriggerResult<SetOutcome> {
        let stored = self.w.seats[seat as usize];
        let key = self.w.key(seat);
        let mut book = self.book();
        book.set_trigger(
            Trader { seat, owner: &key },
            &stored,
            &params,
            mark,
            fresh,
            now,
            &request,
        )
    }

    fn set_for(&mut self, seat: u32, request: TriggerInput) -> TriggerResult<SetOutcome> {
        let params = self.w.markets[0].params;
        let mark = self.w.markets[0].price.price;
        let now = self.w.now;
        self.set_raw(seat, params, mark, true, now, request)
    }

    fn set(&mut self, request: TriggerInput) -> TriggerResult<SetOutcome> {
        self.set_for(self.a, request)
    }

    fn reconcile(&mut self, seat: u32) -> Reconciled {
        let stored = self.w.seats[seat as usize];
        let now = self.w.now;
        self.book().reconcile(seat, &stored, now).unwrap()
    }

    fn record(&mut self, seat: u32, kind: Kind) -> Option<TriggerRecord> {
        self.book().record(seat, kind).copied()
    }

    fn fire(&mut self, max: usize) -> FirePass {
        let risks = self.w.risks();
        let env = Env {
            now: self.w.now,
            exchange_paused: self.w.paused,
            quote_ok: self.w.quote_ok,
            max_steps: self.w.max_steps,
            markets: &risks,
            hash: sha,
        };
        let mut view = self.w.markets[0].as_mut();
        let mut led = ledger(&mut self.w.header, &mut self.w.seats);
        let mut journal = Journal::new(&mut self.w.journal);
        let mut book = TriggerBook::open(bytemuck::cast_slice_mut(&mut self.mem)).unwrap();
        let rules = FireRules {
            max,
            retry_delay: DELAY,
        };
        let pass = fire_triggers(
            &mut book,
            &mut led,
            &mut view,
            &mut journal,
            &env,
            &mut self.w.fills,
            &rules,
            |_| [9; 16],
            |_, _, _| {},
        );
        self.w.check_invariants();
        pass
    }
}

fn is_queued(record: &TriggerRecord) -> bool {
    record.heap != 0
}

#[test]
fn the_layout_sizes_are_what_the_account_budget_assumes() {
    assert_eq!(size_of::<TriggerHeader>(), 32);
    assert_eq!(size_of::<TriggerRecord>(), 64);
    assert_eq!(size_of::<TriggerSlot>(), 248);
    assert_eq!(size_of::<Seat>(), 304);
    assert_eq!(book_len(34_492), Some(9_243_888));
    assert!(book_len(34_492).unwrap() <= 10_485_760);
    assert_eq!(book_len(usize::MAX), None);
}

#[test]
fn a_book_is_refused_when_its_bytes_are_not_one() {
    let mut words = vec![0u64; book_len(4).unwrap().div_ceil(8) + 1];
    let bytes: &mut [u8] = bytemuck::cast_slice_mut(&mut words);
    let short = book_len(4).unwrap() - 1;
    assert_eq!(
        TriggerBook::init(&mut bytes[..short], 0, 4).unwrap_err(),
        TriggerError::BadLayout
    );
    assert_eq!(
        TriggerBook::init(&mut bytes[1..], 0, 4).unwrap_err(),
        TriggerError::BadLayout
    );
    assert_eq!(
        TriggerBook::init(bytes, 0, u32::MAX).unwrap_err(),
        TriggerError::BadLayout
    );
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

    let refused = |r: &mut Rig, request: TriggerInput, error: TriggerError| {
        assert_eq!(r.set(request), Err(error), "{request:?}");
    };
    refused(&mut r, stop(0, 0), TriggerError::InvalidPrice);
    refused(&mut r, stop(955, 900), TriggerError::InvalidPrice);
    refused(&mut r, stop(950, 905), TriggerError::InvalidPrice);
    refused(&mut r, stop(950, 0), TriggerError::InvalidPrice);
    let too_high = (MAX_PRICE / 10 + 1) * 10;
    refused(&mut r, take(too_high, 1_050), TriggerError::InvalidPrice);
    refused(&mut r, stop(1_000, 900), TriggerError::WouldFireImmediately);
    refused(&mut r, stop(1_050, 900), TriggerError::WouldFireImmediately);
    refused(&mut r, take(1_000, 900), TriggerError::WouldFireImmediately);
    refused(&mut r, take(900, 800), TriggerError::WouldFireImmediately);
    refused(&mut r, stop(950, 960), TriggerError::InvalidWorstPrice);
    refused(&mut r, take(1_100, 1_110), TriggerError::InvalidWorstPrice);
    refused(&mut r, lots(stop(950, 900), 0), TriggerError::InvalidSize);
    refused(&mut r, lots(stop(950, 900), 101), TriggerError::InvalidSize);
    let mut late = stop(950, 900);
    late.expiry = now;
    refused(&mut r, late, TriggerError::InvalidExpiry);
    late.expiry = -5;
    refused(&mut r, late, TriggerError::InvalidExpiry);

    assert_eq!(
        r.set_raw(a, params, MARK, false, now, stop(950, 900)),
        Err(TriggerError::MarkNotFresh)
    );
    assert_eq!(
        r.set_raw(a, params, 0, true, now, stop(950, 900)),
        Err(TriggerError::MarkNotFresh)
    );
    let mut spot = spot_params(0);
    spot.market_id = 0;
    assert_eq!(
        r.set_raw(a, spot, MARK, true, now, stop(950, 900)),
        Err(TriggerError::NotPerpMarket)
    );
    assert_eq!(
        r.set_raw(a, perp_params(1), MARK, true, now, stop(950, 900)),
        Err(TriggerError::MarketMismatch)
    );
    let mut broken = params;
    broken.tick = 0;
    assert_eq!(
        r.set_raw(a, broken, MARK, true, now, stop(950, 900)),
        Err(TriggerError::Engine(E::InvalidMarketParams))
    );
    let a_seat = r.w.seats[a as usize];
    assert_eq!(
        r.book().set_trigger(
            Trader {
                seat: SEATS,
                owner: &a_seat.owner,
            },
            &a_seat,
            &params,
            MARK,
            true,
            now,
            &stop(950, 900)
        ),
        Err(TriggerError::SeatOutOfRange)
    );
    assert_eq!(r.set_for(9, stop(950, 900)), Err(TriggerError::SeatNotOpen));
    let stranger = {
        let key = [0xAB; 32];
        let stored = r.w.seats[a as usize];
        r.book().set_trigger(
            Trader {
                seat: a,
                owner: &key,
            },
            &stored,
            &params,
            MARK,
            true,
            now,
            &stop(950, 900),
        )
    };
    assert_eq!(stranger, Err(TriggerError::NotSeatOwner));
    assert_eq!(r.book().active_records(), 0, "a refusal changes nothing");

    assert_eq!(r.set(stop(950, 900)), Ok(SetOutcome { replaced: false }));
    assert_eq!(r.set(stop(960, 900)), Ok(SetOutcome { replaced: true }));
    assert_eq!(r.book().active_records(), 1);
    assert_eq!(r.book().heap_len(BELOW_HEAP), 1);
    r.mark(950);
    refused(&mut r, take(960, 950), TriggerError::CrossedPair);
    r.mark(MARK);

    assert_eq!(r.base(maker), -100);
    let short = |r: &mut Rig, request: TriggerInput| r.set_for(maker, request);
    assert_eq!(
        short(&mut r, take(900, 850)),
        Err(TriggerError::InvalidWorstPrice)
    );
    assert_eq!(
        short(&mut r, take(900, 950)),
        Ok(SetOutcome { replaced: false })
    );
    r.mark(850);
    assert_eq!(
        short(&mut r, stop(880, 900)),
        Err(TriggerError::CrossedPair)
    );
    r.mark(MARK);
    assert_eq!(
        short(&mut r, stop(1_050, 1_100)),
        Ok(SetOutcome { replaced: false })
    );
}

#[test]
fn a_record_is_queued_by_direction_and_replaced_in_place() {
    let mut r = Rig::new();
    r.open_long(100);
    let (a, maker) = (r.a, r.maker);
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
    r.book().check_invariants().unwrap();
}

#[test]
fn cancel_removes_one_record_and_repeating_it_is_harmless() {
    let mut r = Rig::new();
    r.open_long(100);
    let (a, now) = (r.a, r.w.now);
    r.set(stop(950, 900)).unwrap();
    r.set(take(1_100, 1_050)).unwrap();
    let stored = r.w.seats[a as usize];
    let key = r.w.key(a);
    let trader = Trader {
        seat: a,
        owner: &key,
    };
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
    let closed = r.w.seats[9];
    let mut book = r.book();
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
fn t13_flat_then_reopening_the_same_side_never_fires_the_old_stop() {
    let mut r = Rig::new();
    r.open_long(100);
    let a = r.a;
    r.set(stop(950, 900)).unwrap();
    r.bids(930, 100);
    r.bids(MARK, 100);
    r.w.place(0, a, ioc(Side::Ask, MARK, 100)).unwrap();
    assert_eq!(r.base(a), 0);
    r.open_long(100);
    r.mark(940);
    let pass = r.fire(32);
    assert_eq!((pass.due, pass.placed, pass.dropped), (1, 0, 1));
    assert_eq!(r.base(a), 100);
    assert_eq!(r.record(a, Kind::StopLoss), None);
}

#[test]
fn t14_flat_then_reopening_the_other_side_never_fires_the_old_stop() {
    let mut r = Rig::new();
    r.open_long(100);
    let (a, maker) = (r.a, r.maker);
    r.set(stop(950, 900)).unwrap();
    r.bids(MARK, 100);
    r.w.place(0, a, ioc(Side::Ask, MARK, 100)).unwrap();
    buy_from(&mut r.w, 0, maker, a, MARK, 100);
    assert_eq!(r.base(a), -100);
    r.mark(940);
    let pass = r.fire(32);
    assert_eq!((pass.placed, pass.dropped), (0, 1));
    assert_eq!(r.base(a), -100);
}

#[test]
fn t15_a_flip_drops_both_records_and_the_new_position_has_none() {
    let mut r = Rig::new();
    r.open_long(100);
    let a = r.a;
    r.set(stop(950, 900)).unwrap();
    r.set(take(1_100, 1_050)).unwrap();
    r.bids(MARK, 150);
    r.w.place(0, a, ioc(Side::Ask, MARK, 150)).unwrap();
    assert_eq!(r.base(a), -50);
    let found = r.reconcile(a);
    assert_eq!(found.take_profit, Standing::Dropped(DropReason::Flip));
    assert_eq!(found.stop_loss, Standing::Dropped(DropReason::Flip));
    assert_eq!(r.book().active_records(), 0);
}

#[test]
fn t16_a_fixed_size_record_shrinks_with_the_position_and_a_whole_one_follows_it() {
    let mut r = Rig::new();
    r.open_long(100);
    let a = r.a;
    r.set(lots(take(1_100, 1_050), 80)).unwrap();
    r.set(stop(950, 900)).unwrap();
    r.bids(MARK, 30);
    r.w.place(0, a, ioc(Side::Ask, MARK, 30)).unwrap();
    let found = r.reconcile(a);
    assert_eq!(found.position, 70);
    assert_eq!(found.take_profit, Standing::Resized);
    assert_eq!(found.stop_loss, Standing::Armed);
    assert_eq!(r.record(a, Kind::TakeProfit).unwrap().size, 70);
    assert_eq!(r.reconcile(a).take_profit, Standing::Armed);
}

#[test]
fn t17_a_position_shrunk_by_a_passive_fill_resizes_the_record_the_same_way() {
    let mut r = Rig::new();
    r.open_long(100);
    let a = r.a;
    r.set(lots(take(1_100, 1_050), 100)).unwrap();
    r.w.place(0, a, limit(Side::Ask, MARK, 40)).unwrap();
    let outcome = r.w.place(0, r.depth, ioc(Side::Bid, MARK, 40)).unwrap();
    assert_eq!(outcome.filled, 40);
    assert_eq!(r.base(a), 60);
    assert_eq!(r.reconcile(a).take_profit, Standing::Resized);
    assert_eq!(r.record(a, Kind::TakeProfit).unwrap().size, 60);
}

#[test]
fn t18_a_partial_liquidation_keeps_and_resizes_a_stop_and_a_full_one_drops_it() {
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
fn t19_a_whole_position_stop_follows_the_position_up_and_a_fixed_one_does_not() {
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
fn t20_a_thin_book_fills_part_and_the_rest_waits_with_the_sibling_resized() {
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
    assert_eq!(waiting.heap, u8::try_from(TIME_HEAP + 1).unwrap());
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

#[test]
fn t22_one_record_filling_the_position_takes_the_other_with_it() {
    let mut r = Rig::new();
    r.open_long(100);
    let a = r.a;
    r.set(take(1_100, 1_050)).unwrap();
    r.set(stop(950, 900)).unwrap();
    r.mark(1_110);
    r.bids(1_100, 100);
    let pass = r.fire(32);
    assert_eq!((pass.filled_lots, r.base(a)), (100, 0));
    assert_eq!(r.book().active_records(), 0);
}

#[test]
fn t22_a_fixed_record_that_completes_its_size_is_spent_alone() {
    let mut r = Rig::new();
    r.open_long(100);
    let a = r.a;
    r.set(lots(take(1_100, 1_050), 40)).unwrap();
    r.set(stop(950, 900)).unwrap();
    r.mark(1_110);
    r.bids(1_100, 100);
    let pass = r.fire(32);
    assert_eq!((pass.filled_lots, pass.dropped), (40, 1));
    assert_eq!(r.base(a), 60);
    assert!(r.record(a, Kind::TakeProfit).is_none());
    assert!(r.record(a, Kind::StopLoss).is_some());
}

#[test]
fn t23_a_manual_close_between_two_passes_leaves_one_net_reduction_and_no_error() {
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
fn t24_a_position_below_the_minimum_size_is_closed_exactly() {
    let mut params = perp_params(0);
    params.min_size = 5;
    let mut r = Rig::with(params);
    r.open_long(100);
    let a = r.a;
    r.bids(MARK, 97);
    r.w.place(0, a, ioc(Side::Ask, MARK, 97)).unwrap();
    assert_eq!(r.base(a), 3);
    r.set(stop(950, 900)).unwrap();
    r.mark(940);
    r.bids(930, 10);
    let pass = r.fire(32);
    assert_eq!(pass.filled_lots, 3);
    assert_eq!(r.base(a), 0);
}

#[test]
fn the_order_is_clipped_to_the_bands_and_raised_to_the_minimum_notional() {
    let mut params = perp_params(0);
    params.min_notional = 5_000;
    let mut r = Rig::with(params);
    r.open_long(100);
    let (a, maker) = (r.a, r.maker);
    r.set(stop(950, 100)).unwrap();
    r.set_for(maker, stop(1_050, 5_000)).unwrap();
    r.mark(1_060);
    let params = r.w.markets[0].params;
    let stored = r.w.seats[maker as usize];
    let now = r.w.now;
    let mut out = [Due::EMPTY; 4];
    let n = r
        .book()
        .due_triggers(1_060, true, now, 4, &mut out)
        .unwrap();
    assert_eq!(n, 1);
    let plan = match r
        .book()
        .begin_fire(&out[0], &stored, &params, 1_060, now)
        .unwrap()
    {
        FireDecision::Fire(plan) => plan,
        other => panic!("{other:?}"),
    };
    assert_eq!((plan.seat, plan.side, plan.size), (maker, Side::Bid, 100));
    assert_eq!(
        plan.worst_price, 1_110,
        "a ceiling falls to the band: 1,060 + 5%, on tick"
    );
    let order = plan.new_order([1; 16]);
    assert_eq!(
        (order.order_type, order.reduce_only, order.price),
        (OrderType::Market, true, 1_110)
    );
    r.mark(940);
    let stored = r.w.seats[a as usize];
    let n = r.book().due_triggers(940, true, now, 4, &mut out).unwrap();
    assert_eq!(n, 1);
    let plan = match r
        .book()
        .begin_fire(&out[0], &stored, &params, 940, now)
        .unwrap()
    {
        FireDecision::Fire(plan) => plan,
        other => panic!("{other:?}"),
    };
    assert_eq!(
        plan.worst_price, 900,
        "a floor of 100 rises to 940 - 5%, on tick"
    );
    assert_eq!(plan.size, 100);
    assert!(plan.order_size * plan.worst_price >= 5_000);
}

#[test]
fn an_order_that_is_too_small_for_the_notional_floor_is_made_big_enough() {
    let mut params = perp_params(0);
    params.min_notional = 5_000;
    let mut r = Rig::with(params);
    r.open_long(100);
    let a = r.a;
    r.bids(MARK, 98);
    r.w.place(0, a, ioc(Side::Ask, MARK, 98)).unwrap();
    r.set(stop(950, 900)).unwrap();
    r.mark(940);
    let stored = r.w.seats[a as usize];
    let now = r.w.now;
    let params = r.w.markets[0].params;
    let mut out = [Due::EMPTY; 1];
    r.book().due_triggers(940, true, now, 1, &mut out).unwrap();
    let FireDecision::Fire(plan) = r
        .book()
        .begin_fire(&out[0], &stored, &params, 940, now)
        .unwrap()
    else {
        panic!("a plan");
    };
    assert_eq!((plan.size, plan.order_size), (2, 6));
}

#[test]
fn t25_the_engine_refuses_a_wrong_side_order_and_the_record_is_dropped_for_it() {
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
    let stored = r.w.seats[a as usize];
    let now = r.w.now;
    let mut out = [Due::EMPTY; 1];
    r.book().due_triggers(940, true, now, 1, &mut out).unwrap();
    let outcome = FireOutcome::Refused(E::ReduceOnlyWouldIncrease);
    assert_eq!(
        r.book()
            .record_fire_outcome(&out[0], outcome, &stored, now, DELAY),
        Ok(Settled::Dropped(DropReason::Refused))
    );
    assert_eq!(r.record(a, Kind::StopLoss), None);
}

#[test]
fn an_error_that_may_pass_re_arms_the_record_and_a_stale_reference_is_refused() {
    let mut r = Rig::new();
    r.open_long(100);
    let a = r.a;
    r.set(stop(950, 900)).unwrap();
    r.mark(940);
    let stored = r.w.seats[a as usize];
    let now = r.w.now;
    let mut out = [Due::EMPTY; 1];
    r.book().due_triggers(940, true, now, 1, &mut out).unwrap();
    let due = out[0];
    let mut wrong = due;
    wrong.record_version = wrong.record_version.wrapping_add(5);
    let params = r.w.markets[0].params;
    assert_eq!(
        r.book().begin_fire(&wrong, &stored, &params, 940, now),
        Ok(FireDecision::Stale)
    );
    assert_eq!(
        r.book().record_fire_outcome(
            &wrong,
            FireOutcome::Placed { filled: 0 },
            &stored,
            now,
            DELAY
        ),
        Ok(Settled::Stale)
    );
    assert_eq!(
        r.book().record_fire_outcome(
            &due,
            FireOutcome::Refused(E::StalePrice),
            &stored,
            now,
            DELAY
        ),
        Ok(Settled::Rearmed {
            next_attempt: now + DELAY
        })
    );
    assert!(is_queued(&r.record(a, Kind::StopLoss).unwrap()));
    assert_eq!(
        r.book()
            .record_fire_outcome(&due, FireOutcome::Placed { filled: 0 }, &stored, now, DELAY),
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
    let stored = r.w.seats[a as usize];
    let now = r.w.now;
    let params = r.w.markets[0].params;
    let mut out = [Due::EMPTY; 1];
    r.book().due_triggers(940, true, now, 1, &mut out).unwrap();
    assert_eq!(
        r.book().begin_fire(&out[0], &stored, &params, 1_000, now),
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
    let mut out = [Due::EMPTY; 2];
    r.mark(940);
    r.book().due_triggers(940, true, now, 1, &mut out).unwrap();
    let stored = r.w.seats[a as usize];
    let mut off_book = out[0];
    off_book.seat = SEATS;
    assert_eq!(
        r.book().begin_fire(&off_book, &stored, &params, 940, now),
        Err(TriggerError::Corrupt)
    );
    params.tick = 0;
    assert_eq!(
        r.book().begin_fire(&out[0], &stored, &params, 940, now),
        Err(TriggerError::Corrupt)
    );
    r.mark(1_060);
    r.book()
        .due_triggers(1_060, true, now, 1, &mut out)
        .unwrap();
    params.tick = 10_000_000;
    let stored = r.w.seats[maker as usize];
    assert_eq!(
        r.book().begin_fire(&out[0], &stored, &params, 1_060, now),
        Err(TriggerError::InvalidWorstPrice)
    );
}

#[test]
fn t26_one_entry_that_errors_does_not_stop_the_others() {
    let mut r = Rig::new();
    let m1 = r.w.add_market(perp_params(1));
    let other = funded(&mut r.w, 1_000_000);
    r.open_long(100);
    buy_from(&mut r.w, 0, other, r.maker, MARK, 100);
    buy_from(&mut r.w, m1, r.a, r.maker, MARK, 10);
    let (a, other) = (r.a, other);
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
    assert_eq!(waiting.heap, u8::try_from(TIME_HEAP + 1).unwrap());
}

#[test]
fn a_pass_reports_the_fills_of_each_accepted_order() {
    let mut r = Rig::new();
    r.open_long(100);
    r.set(stop(950, 900)).unwrap();
    r.mark(940);
    r.bids(930, 100);
    let risks = r.w.risks();
    let env = Env {
        now: r.w.now,
        exchange_paused: false,
        quote_ok: true,
        max_steps: r.w.max_steps,
        markets: &risks,
        hash: sha,
    };
    let mut view = r.w.markets[0].as_mut();
    let mut led = ledger(&mut r.w.header, &mut r.w.seats);
    let mut journal = Journal::new(&mut r.w.journal);
    let mut book = TriggerBook::open(bytemuck::cast_slice_mut(&mut r.mem)).unwrap();
    let mut seen = Vec::new();
    let pass = fire_triggers(
        &mut book,
        &mut led,
        &mut view,
        &mut journal,
        &env,
        &mut r.w.fills,
        &FireRules {
            max: 1,
            retry_delay: DELAY,
        },
        |due| [due.seat as u8; 16],
        |due, fills, outcome| seen.push((due.seat, fills.as_slice().len(), outcome.filled)),
    );
    assert_eq!(seen, [(r.a, 1, 100)]);
    assert_eq!(pass.filled_lots, 100);
}

#[test]
fn t27_nothing_fires_and_nothing_is_dropped_while_the_market_cannot_be_trusted() {
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
    let word = 32 + usize::try_from(SEATS).unwrap() * 248;
    r.bytes()[word..word + 4].copy_from_slice(&0xFFFF_FFF0u32.to_le_bytes());
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
    let mut stray = r.w.seats[r.a as usize];
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
    let mut expiring = stop(950, 900);
    expiring.expiry = r.w.now + 100;
    r.set(expiring).unwrap();
    r.w.now += 200;
    r.mark(MARK);
    assert_eq!(
        r.reconcile(a).stop_loss,
        Standing::Dropped(DropReason::Expired)
    );

    r.mark(MARK);
    let mut also = stop(1_050, 1_100);
    also.expiry = r.w.now + 100;
    r.set_for(maker, also).unwrap();
    r.w.now += 200;
    r.mark(1_060);
    let pass = r.fire(32);
    assert_eq!((pass.due, pass.placed), (0, 0));
    assert_eq!(r.book().active_records(), 0);
}

#[test]
fn t28_only_the_owner_acts_on_a_seat_and_a_key_reset_clears_it() {
    let mut r = Rig::new();
    r.open_long(100);
    let a = r.a;
    r.set(stop(950, 900)).unwrap();
    let now = r.w.now;
    let stranger = r.w.seats[r.depth as usize];
    assert_eq!(
        r.book().reconcile(SEATS, &stranger, now),
        Err(TriggerError::SeatOutOfRange)
    );
    let mut moved = r.w.seats[a as usize];
    moved.owner = [0x55; 32];
    let found = r.book().reconcile(a, &moved, now).unwrap();
    assert_eq!(found.stop_loss, Standing::Dropped(DropReason::SeatGone));
}

fn plain_seat(index: u32, base: i64) -> Seat {
    let mut seat = Seat::zeroed();
    seat.owner = [u8::try_from(index).unwrap() + 1; 32];
    seat.status = SEAT_OPEN;
    seat.slot_markets[0] = 1;
    seat.perp[0].base = base;
    seat
}

fn plain_book(seats: u32) -> Vec<u64> {
    let mut mem = vec![0u64; book_len(seats as usize).unwrap().div_ceil(8)];
    TriggerBook::init(bytemuck::cast_slice_mut(&mut mem), 0, seats).unwrap();
    mem
}

fn longs(count: u32) -> Vec<Seat> {
    (0..count).map(|i| plain_seat(i, 100)).collect()
}

fn set_stop(book: &mut TriggerBook<'_>, seats: &[Seat], seat: u32, trigger: u64) {
    let stored = &seats[seat as usize];
    let params = perp_params(0);
    book.set_trigger(
        Trader {
            seat,
            owner: &stored.owner,
        },
        stored,
        &params,
        MARK,
        true,
        START,
        &stop(trigger, trigger - 10),
    )
    .unwrap();
}

fn take_due(book: &mut TriggerBook<'_>, mark: u64, now: i64, max: usize) -> Vec<Due> {
    let mut out = vec![Due::EMPTY; max];
    let n = book.due_triggers(mark, true, now, max, &mut out).unwrap();
    out.truncate(n);
    out
}

fn zero_fill(book: &mut TriggerBook<'_>, due: &Due, seats: &[Seat], now: i64) {
    let stored = &seats[due.seat as usize];
    let settled = book
        .record_fire_outcome(due, FireOutcome::Placed { filled: 0 }, stored, now, DELAY)
        .unwrap();
    assert_eq!(
        settled,
        Settled::Rearmed {
            next_attempt: now + DELAY
        }
    );
}

#[test]
fn the_deepest_crossing_leaves_first_and_a_pass_stops_at_its_cap() {
    let seats = longs(8);
    let mut mem = plain_book(8);
    let mut book = TriggerBook::open(bytemuck::cast_slice_mut(&mut mem)).unwrap();
    for (seat, trigger) in [(2, 900), (3, 960), (4, 920), (5, 980), (6, 940)] {
        set_stop(&mut book, &seats, seat, trigger);
    }
    let first = take_due(&mut book, 800, START, 3);
    assert_eq!(
        first.iter().map(|due| due.seat).collect::<Vec<_>>(),
        [5, 3, 6]
    );
    assert_eq!(book.heap_len(BELOW_HEAP), 2);
    book.check_invariants().unwrap();
    let rest = take_due(&mut book, 800, START, 10);
    assert_eq!(rest.iter().map(|due| due.seat).collect::<Vec<_>>(), [4, 2]);
}

#[test]
fn equal_records_are_served_in_turn_and_a_stuck_one_never_blocks_the_rest() {
    let seats = longs(8);
    let mut mem = plain_book(8);
    let mut book = TriggerBook::open(bytemuck::cast_slice_mut(&mut mem)).unwrap();
    for seat in 2..8 {
        set_stop(&mut book, &seats, seat, 900);
    }
    let mut served = Vec::new();
    for pass in 0..3 {
        let due = take_due(&mut book, 800, START, 2);
        assert_eq!(due.len(), 2, "pass {pass}");
        for entry in &due {
            zero_fill(&mut book, entry, &seats, START);
            served.push(entry.seat);
        }
    }
    assert_eq!(served, [2, 3, 4, 5, 6, 7]);
    assert!(
        take_due(&mut book, 800, START, 2).is_empty(),
        "all are waiting"
    );
    let again = take_due(&mut book, 800, START + DELAY, 2);
    assert_eq!(again.iter().map(|due| due.seat).collect::<Vec<_>>(), [2, 3]);
    book.check_invariants().unwrap();
}

#[test]
fn a_record_waiting_for_a_retry_only_returns_while_the_mark_still_holds() {
    let seats = longs(4);
    let mut mem = plain_book(4);
    let mut book = TriggerBook::open(bytemuck::cast_slice_mut(&mut mem)).unwrap();
    set_stop(&mut book, &seats, 2, 900);
    let due = take_due(&mut book, 800, START, 1);
    zero_fill(&mut book, &due[0], &seats, START);
    assert!(
        take_due(&mut book, 1_000, START + DELAY, 1).is_empty(),
        "the mark reversed"
    );
    assert_eq!(
        book.heap_len(BELOW_HEAP),
        1,
        "and it is back on its price heap"
    );
    assert_eq!(take_due(&mut book, 800, START + DELAY, 1).len(), 1);
}

#[test]
fn t21_a_sweep_removes_a_dead_record_within_a_bounded_number_of_calls() {
    let mut seats = longs(10);
    let mut mem = plain_book(10);
    let mut book = TriggerBook::open(bytemuck::cast_slice_mut(&mut mem)).unwrap();
    for seat in 2..10 {
        set_stop(&mut book, &seats, seat, 900);
    }
    seats[7].perp[0].base = 0;
    let g = seats[7].generations();
    seats[7].set_generations([g[0].wrapping_add(1), g[1], g[2], g[3]]);
    assert_eq!(book.sweep(&seats, 3, START), Ok(SweepReport::default()));
    assert_eq!(book.sweep(&seats, 3, START), Ok(SweepReport::default()));
    assert!(book.record(7, Kind::StopLoss).is_some());
    assert_eq!(
        book.sweep(&seats, 3, START),
        Ok(SweepReport {
            dropped: 1,
            requeued: 0
        })
    );
    assert!(book.record(7, Kind::StopLoss).is_none());
    assert_eq!(
        book.sweep(&seats, 30, START),
        Ok(SweepReport::default()),
        "wrapped and clamped"
    );
    book.check_invariants().unwrap();
}

#[test]
fn a_sweep_queues_a_record_taken_and_never_settled_and_clears_seats_past_the_ledger() {
    let seats = longs(10);
    let mut mem = plain_book(10);
    let mut book = TriggerBook::open(bytemuck::cast_slice_mut(&mut mem)).unwrap();
    set_stop(&mut book, &seats, 2, 900);
    set_stop(&mut book, &seats, 8, 900);
    let taken = take_due(&mut book, 800, START, 1);
    assert_eq!(taken.len(), 1);
    assert_eq!(book.heap_len(BELOW_HEAP), 1);
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
    let empty = plain_book(0);
    let mut empty = empty;
    let mut book = TriggerBook::open(bytemuck::cast_slice_mut(&mut empty)).unwrap();
    assert_eq!(book.sweep(&[], 5, START), Ok(SweepReport::default()));
}

fn recycled_seat(r: &mut Rig) -> u32 {
    r.open_long(100);
    let a = r.a;
    let key = r.w.key(a);
    r.set(stop(950, 900)).unwrap();
    r.bids(MARK, 100);
    r.w.place(0, a, ioc(Side::Ask, MARK, 100)).unwrap();
    let left = r.w.collateral(a);
    r.w.withdraw(a, Asset::Collateral, u64::try_from(left).unwrap())
        .unwrap();
    r.w.close(a).unwrap();
    let again = r.w.open_with_key(key).unwrap();
    assert_eq!(again, a, "the same owner gets the same seat back");
    r.w.deposit(again, Asset::Collateral, 1_000_000).unwrap();
    r.open_long(100);
    again
}

#[test]
fn t9_a_recycled_seat_of_the_same_owner_never_fires_an_old_stop() {
    let mut r = Rig::new();
    let a = recycled_seat(&mut r);
    assert_eq!(r.w.seat(a).generations(), [1, 0, 0, 0]);
    r.mark(940);
    r.bids(930, 100);
    let pass = r.fire(32);
    assert_eq!((pass.placed, pass.dropped), (0, 1));
    assert_eq!(r.base(a), 100);
}

#[test]
fn t9_without_the_carried_generation_the_old_stop_would_match_the_new_position() {
    let mut r = Rig::new();
    let a = recycled_seat(&mut r);
    r.w.seats[a as usize].set_generations([0; 4]);
    assert_eq!(r.reconcile(a).stop_loss, Standing::Armed);
}

#[test]
fn a_stop_whose_generation_wrapped_is_caught_by_the_sweep_before_it_can_match() {
    let mut r = Rig::new();
    r.open_long(100);
    let a = r.a;
    r.set(stop(950, 900)).unwrap();
    r.bids(MARK, 100);
    r.w.place(0, a, ioc(Side::Ask, MARK, 100)).unwrap();
    let stored = r.w.seats.clone();
    let now = r.w.now;
    assert_eq!(r.book().sweep(&stored, SEATS, now).unwrap().dropped, 1);
    assert_eq!(r.book().active_records(), 0);
}

#[derive(Clone, Debug)]
enum Op {
    Set {
        seat: u8,
        take_profit: bool,
        offset: u8,
        whole: bool,
    },
    Cancel {
        seat: u8,
        take_profit: bool,
    },
    Close {
        seat: u8,
    },
    Reopen {
        seat: u8,
        long: bool,
    },
    Pass {
        mark: u8,
        max: u8,
        delay: u8,
        fill: u8,
        refuse: bool,
    },
    Sweep,
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        4 => (any::<u8>(), any::<bool>(), any::<u8>(), any::<bool>())
            .prop_map(|(seat, take_profit, offset, whole)| Op::Set { seat, take_profit, offset, whole }),
        2 => (any::<u8>(), any::<bool>()).prop_map(|(seat, take_profit)| Op::Cancel { seat, take_profit }),
        1 => any::<u8>().prop_map(|seat| Op::Close { seat }),
        1 => (any::<u8>(), any::<bool>()).prop_map(|(seat, long)| Op::Reopen { seat, long }),
        4 => (any::<u8>(), any::<u8>(), any::<u8>(), any::<u8>(), any::<bool>())
            .prop_map(|(mark, max, delay, fill, refuse)| Op::Pass { mark, max, delay, fill, refuse }),
        1 => Just(Op::Sweep),
    ]
}

const MODEL_SEATS: u32 = 16;

fn identity_holds(record: &TriggerRecord, seat: &Seat) -> bool {
    let base = seat.perp[0].base;
    base != 0 && (base > 0) == (record.flags & 8 != 0) && seat.generation(0) == record.generation
}

fn end_position(seat: &mut Seat) {
    seat.perp[0].base = 0;
    let g = seat.generations();
    seat.set_generations([g[0].wrapping_add(1), g[1], g[2], g[3]]);
}

fn kind_of(take_profit: bool) -> Kind {
    if take_profit {
        Kind::TakeProfit
    } else {
        Kind::StopLoss
    }
}

fn run_model(ops: &[Op]) {
    let params = perp_params(0);
    let mut seats: Vec<Seat> = (0..MODEL_SEATS)
        .map(|i| plain_seat(i, if i % 2 == 0 { 100 } else { -100 }))
        .collect();
    let mut mem = plain_book(MODEL_SEATS);
    let mut book = TriggerBook::open(bytemuck::cast_slice_mut(&mut mem)).unwrap();
    let (mut mark, mut now) = (1_000u64, START);
    for op in ops {
        now += 1;
        match *op {
            Op::Set {
                seat,
                take_profit,
                offset,
                whole,
            } => {
                let s = u32::from(seat) % MODEL_SEATS;
                let stored = seats[s as usize];
                let long = stored.perp[0].base > 0;
                let step = 10 * (1 + u64::from(offset % 40));
                let kind = kind_of(take_profit);
                let up = take_profit == long;
                let trigger = if up { mark + step } else { mark - step };
                let worst = if long { trigger - 10 } else { trigger + 10 };
                let size = if whole {
                    TriggerSize::WholePosition
                } else {
                    TriggerSize::Lots(50)
                };
                let request = TriggerInput {
                    kind,
                    trigger_price: trigger,
                    worst_price: worst,
                    size,
                    expiry: 0,
                    client_id: 0,
                };
                let result = book.set_trigger(
                    Trader {
                        seat: s,
                        owner: &stored.owner,
                    },
                    &stored,
                    &params,
                    mark,
                    true,
                    now,
                    &request,
                );
                if stored.perp[0].base == 0 {
                    assert_eq!(result, Err(TriggerError::NoPosition));
                }
            }
            Op::Cancel { seat, take_profit } => {
                let s = u32::from(seat) % MODEL_SEATS;
                let stored = seats[s as usize];
                book.cancel_trigger(
                    Trader {
                        seat: s,
                        owner: &stored.owner,
                    },
                    &stored,
                    kind_of(take_profit),
                    now,
                )
                .unwrap();
            }
            Op::Close { seat } => {
                let s = &mut seats[usize::from(seat) % MODEL_SEATS as usize];
                if s.perp[0].base != 0 {
                    end_position(s);
                }
            }
            Op::Reopen { seat, long } => {
                let s = &mut seats[usize::from(seat) % MODEL_SEATS as usize];
                if s.perp[0].base == 0 {
                    s.perp[0].base = if long { 100 } else { -100 };
                }
            }
            Op::Pass {
                mark: new_mark,
                max,
                delay,
                fill,
                refuse,
            } => {
                mark = 500 + 10 * (u64::from(new_mark) % 100);
                let max = usize::from(max % 12);
                let mut expected = Vec::new();
                let mut due_to_return = 0;
                for seat in 0..MODEL_SEATS {
                    for take_profit in [true, false] {
                        if let Some(record) = book.record(seat, kind_of(take_profit)) {
                            assert_ne!(record.heap, 0, "nothing is outstanding between passes");
                            let waiting = record.heap == 3 && record.next_attempt > now;
                            due_to_return += usize::from(record.heap == 3 && !waiting);
                            let crossed = if record.flags & 2 != 0 {
                                mark <= record.trigger_price
                            } else {
                                mark >= record.trigger_price
                            };
                            if crossed && !waiting {
                                expected.push((seat, take_profit));
                            }
                        }
                    }
                }
                let due = take_due(&mut book, mark, now, max);
                let mut got: Vec<_> = due
                    .iter()
                    .map(|d| (d.seat, d.kind == Kind::TakeProfit))
                    .collect();
                got.sort();
                expected.sort();
                if due_to_return > 0 {
                    assert!(got.iter().all(|entry| expected.contains(entry)));
                    assert!(got.len() <= max);
                } else if expected.len() <= max {
                    assert_eq!(got, expected);
                } else {
                    assert_eq!(due.len(), max);
                }
                let depths: Vec<u64> = due.iter().map(|d| mark.abs_diff(d.trigger_price)).collect();
                assert!(
                    depths.windows(2).all(|pair| pair[0] >= pair[1]),
                    "{depths:?}"
                );
                for entry in &due {
                    let s = entry.seat as usize;
                    let decision = book
                        .begin_fire(entry, &seats[s], &params, mark, now)
                        .unwrap();
                    let FireDecision::Fire(plan) = decision else {
                        continue;
                    };
                    let base = seats[s].perp[0].base;
                    assert!(plan.size >= 1 && plan.size <= base.unsigned_abs());
                    assert_eq!(plan.side, if base > 0 { Side::Ask } else { Side::Bid });
                    let record = *book.record(entry.seat, entry.kind).unwrap();
                    assert!(
                        identity_holds(&record, &seats[s]),
                        "a record that cannot fire was planned"
                    );
                    let outcome = if refuse {
                        FireOutcome::Refused(E::StalePrice)
                    } else {
                        let filled = (u64::from(fill) % 120).min(base.unsigned_abs());
                        let step = i64::try_from(filled).unwrap();
                        seats[s].perp[0].base = base - base.signum() * step;
                        if seats[s].perp[0].base == 0 {
                            end_position(&mut seats[s]);
                        }
                        FireOutcome::Placed { filled }
                    };
                    book.record_fire_outcome(entry, outcome, &seats[s], now, i64::from(delay % 4))
                        .unwrap();
                }
                assert_eq!(
                    book.heap_len(0) + book.heap_len(1) + book.heap_len(2),
                    book.active_records()
                );
            }
            Op::Sweep => {
                book.sweep(&seats, MODEL_SEATS, now).unwrap();
                for seat in 0..MODEL_SEATS {
                    for take_profit in [true, false] {
                        if let Some(record) = book.record(seat, kind_of(take_profit)) {
                            assert!(
                                identity_holds(record, &seats[seat as usize]),
                                "a dead record survived a sweep"
                            );
                        }
                    }
                }
            }
        }
        book.check_invariants().unwrap();
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(96))]

    #[test]
    fn t30_after_any_history_no_record_can_fire_on_a_position_it_was_not_set_for(
        ops in prop::collection::vec(op(), 1..80)
    ) {
        run_model(&ops);
    }
}

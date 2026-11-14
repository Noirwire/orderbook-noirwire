//! What the trigger tests share: a real ledger and market with a trigger book beside
//! them (`Rig`), a bare book over hand-made seats (`Plain`), and request builders.

#![allow(dead_code)]

pub mod model;

use crate::common::*;
use bytemuck::Zeroable;
use noirwire_orderbook_engine::*;

pub const SEATS: u32 = 10;
pub const DELAY: i64 = 30;

pub fn input(kind: Kind, trigger: u64, worst: u64, size: TriggerSize) -> TriggerInput {
    TriggerInput {
        kind,
        trigger_price: trigger,
        worst_price: worst,
        size,
        expiry: 0,
        client_id: 7,
    }
}

pub fn stop(trigger: u64, worst: u64) -> TriggerInput {
    input(Kind::StopLoss, trigger, worst, TriggerSize::WholePosition)
}

pub fn take(trigger: u64, worst: u64) -> TriggerInput {
    input(Kind::TakeProfit, trigger, worst, TriggerSize::WholePosition)
}

pub fn lots(mut request: TriggerInput, size: u64) -> TriggerInput {
    request.size = TriggerSize::Lots(size);
    request
}

pub fn is_queued(record: &TriggerRecord) -> bool {
    record.heap != 0
}

pub fn heap_tag(heap: usize) -> u8 {
    u8::try_from(heap + 1).unwrap()
}

/// A world with a perp market 0, three funded seats and a trigger book for the market.
/// `maker` sells to `a` when `open_long` runs, and `depth` posts the bids a stop hits.
pub struct Rig {
    pub w: World,
    pub mem: Vec<u64>,
    pub maker: u32,
    pub a: u32,
    pub depth: u32,
}

impl Rig {
    pub fn new() -> Rig {
        Rig::build(perp_params(0), 0, SEATS)
    }

    pub fn with(params: MarketParams) -> Rig {
        Rig::build(params, 0, SEATS)
    }

    pub fn build(params: MarketParams, book_market: u8, book_seats: u32) -> Rig {
        let mut w = World::new(10, 8);
        w.add_market(params);
        Rig::around(w, book_market, book_seats)
    }

    pub fn around(mut w: World, book_market: u8, book_seats: u32) -> Rig {
        let maker = funded(&mut w, 1_000_000);
        let a = funded(&mut w, 1_000_000);
        let depth = funded(&mut w, 1_000_000);
        let mut mem = vec![0u64; book_len(book_seats as usize).unwrap().div_ceil(8)];
        TriggerBook::init(bytemuck::cast_slice_mut(&mut mem), book_market, book_seats).unwrap();
        Rig {
            w,
            mem,
            maker,
            a,
            depth,
        }
    }

    pub fn bytes(&mut self) -> &mut [u8] {
        bytemuck::cast_slice_mut(&mut self.mem)
    }

    pub fn book(&mut self) -> TriggerBook<'_> {
        TriggerBook::open(self.bytes()).unwrap()
    }

    pub fn open_long(&mut self, size: u64) {
        buy_from(&mut self.w, 0, self.a, self.maker, MARK, size);
    }

    pub fn bids(&mut self, price: u64, size: u64) {
        self.w
            .place(0, self.depth, limit(Side::Bid, price, size))
            .unwrap();
    }

    pub fn mark(&mut self, price: u64) {
        self.w.set_price(0, price);
    }

    pub fn base(&self, seat: u32) -> i64 {
        self.w.slot(seat, 0).base
    }

    /// `a` sells `lots` of its long position into fresh bids at the mark.
    pub fn sell_a(&mut self, lots: u64) {
        self.bids(MARK, lots);
        self.w.place(0, self.a, ioc(Side::Ask, MARK, lots)).unwrap();
    }

    /// `a` sells its whole position.
    pub fn close_a(&mut self) {
        self.sell_a(self.base(self.a).unsigned_abs());
        assert_eq!(self.base(self.a), 0);
    }

    /// `a` ends the position it holds `endings` times over, opening one lot between.
    pub fn end_positions(&mut self, endings: u32) {
        for _ in 0..endings {
            self.open_long(1);
            self.close_a();
        }
    }

    pub fn stored(&self, seat: u32) -> Seat {
        self.w.seats[seat as usize]
    }

    /// Takes the one due record at `mark`.
    pub fn due_one(&mut self, mark: u64) -> Due {
        let now = self.w.now;
        let mut out = [Due::EMPTY; 1];
        assert_eq!(
            self.book().due_triggers(mark, true, now, 1, &mut out),
            Ok(1)
        );
        out[0]
    }

    pub fn set_raw(
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
        self.book().set_trigger(
            Trader { seat, owner: &key },
            &stored,
            &params,
            mark,
            fresh,
            now,
            &request,
        )
    }

    pub fn set_for(&mut self, seat: u32, request: TriggerInput) -> TriggerResult<SetOutcome> {
        let params = self.w.markets[0].params;
        let mark = self.w.markets[0].price.price;
        let now = self.w.now;
        self.set_raw(seat, params, mark, true, now, request)
    }

    pub fn set(&mut self, request: TriggerInput) -> TriggerResult<SetOutcome> {
        self.set_for(self.a, request)
    }

    pub fn reconcile(&mut self, seat: u32) -> Reconciled {
        let stored = self.w.seats[seat as usize];
        let now = self.w.now;
        self.book().reconcile(seat, &stored, now).unwrap()
    }

    pub fn record(&mut self, seat: u32, kind: Kind) -> Option<TriggerRecord> {
        self.book().record(seat, kind).copied()
    }

    /// Takes the one due record at `mark` and judges it against its seat.
    pub fn decide(&mut self, seat: u32, mark: u64) -> FireDecision {
        let stored = self.stored(seat);
        let params = self.w.markets[0].params;
        let now = self.w.now;
        let due = self.due_one(mark);
        self.book()
            .begin_fire(&due, &stored, &params, mark, now)
            .unwrap()
    }

    pub fn fire_with<S, A>(&mut self, rules: &FireRules, secret: S, after_each: A) -> FirePass
    where
        S: FnMut(&Due) -> [u8; 16],
        A: FnMut(&Due, &Fills, &PlaceOutcome),
    {
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
        let pass = fire_triggers(
            &mut book,
            &mut led,
            &mut view,
            &mut journal,
            &env,
            &mut self.w.fills,
            rules,
            secret,
            after_each,
        );
        self.w.check_invariants();
        pass
    }

    pub fn fire(&mut self, max: usize) -> FirePass {
        let rules = FireRules {
            max,
            retry_delay: DELAY,
        };
        self.fire_with(&rules, |_| [9; 16], |_, _, _| {})
    }
}

/// A trigger book over hand-made seats that all hold a long (or short) position on
/// market 0, for the tests that need no ledger.
pub struct Plain {
    pub seats: Vec<Seat>,
    pub mem: Vec<u64>,
}

pub fn plain_seat(index: u32, base: i64) -> Seat {
    let mut seat = Seat::zeroed();
    seat.owner = [u8::try_from(index % 250).unwrap() + 1; 32];
    seat.status = SEAT_OPEN;
    seat.slot_markets[0] = 1;
    seat.perp[0].base = base;
    seat
}

impl Plain {
    pub fn new(count: u32) -> Plain {
        Plain::of((0..count).map(|i| plain_seat(i, 100)).collect())
    }

    pub fn of(seats: Vec<Seat>) -> Plain {
        let count = u32::try_from(seats.len()).unwrap();
        let mut mem = vec![0u64; book_len(seats.len()).unwrap().div_ceil(8)];
        TriggerBook::init(bytemuck::cast_slice_mut(&mut mem), 0, count).unwrap();
        Plain { seats, mem }
    }

    pub fn book(&mut self) -> TriggerBook<'_> {
        TriggerBook::open(bytemuck::cast_slice_mut(&mut self.mem)).unwrap()
    }

    pub fn stop(&mut self, seat: u32, trigger: u64) {
        let stored = self.seats[seat as usize];
        let params = perp_params(0);
        let request = stop(trigger, trigger - 10);
        TriggerBook::open(bytemuck::cast_slice_mut(&mut self.mem))
            .unwrap()
            .set_trigger(
                Trader {
                    seat,
                    owner: &stored.owner,
                },
                &stored,
                &params,
                MARK,
                true,
                START,
                &request,
            )
            .unwrap();
    }

    pub fn due(&mut self, mark: u64, now: i64, max: usize) -> Vec<Due> {
        let mut out = vec![Due::EMPTY; max];
        let n = self
            .book()
            .due_triggers(mark, true, now, max, &mut out)
            .unwrap();
        out.truncate(n);
        out
    }

    pub fn seats_of(due: &[Due]) -> Vec<u32> {
        due.iter().map(|entry| entry.seat).collect()
    }

    /// Settles `due` as an order that filled nothing: the record waits `DELAY` and returns.
    pub fn zero_fill(&mut self, due: &Due, now: i64) {
        let stored = self.seats[due.seat as usize];
        let settled = self
            .book()
            .record_fire_outcome(due, FireOutcome::Placed { filled: 0 }, &stored, now, DELAY)
            .unwrap();
        assert_eq!(
            settled,
            Settled::Rearmed {
                next_attempt: now + DELAY
            }
        );
    }
}

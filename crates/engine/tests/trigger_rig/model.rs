//! A stateful history against a real ledger: traders set, cancel, close and reopen
//! positions, liquidity comes and goes, and passes fire through `place_order`. After
//! every pass no seat has lost more lots than the records standing on its position
//! authorize, and after every sweep every record belongs to the position it stands on.

use super::*;
use proptest::prelude::*;

const TRADERS: usize = 6;
const MIN_SIZE: u64 = 5;
const TICK: u64 = 10;

#[derive(Clone, Debug)]
pub enum Op {
    Set(u8, bool, u8, u8),
    Cancel(u8, bool),
    Close(u8),
    Reopen(u8, bool),
    Pass(u8, u8, u8),
    Sweep,
}

pub fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        4 => (any::<u8>(), any::<bool>(), any::<u8>(), any::<u8>()).prop_map(|(a, b, c, d)| Op::Set(a, b, c, d)),
        2 => (any::<u8>(), any::<bool>()).prop_map(|(a, b)| Op::Cancel(a, b)),
        1 => any::<u8>().prop_map(Op::Close),
        1 => (any::<u8>(), any::<bool>()).prop_map(|(a, b)| Op::Reopen(a, b)),
        4 => (any::<u8>(), any::<u8>(), any::<u8>()).prop_map(|(a, b, c)| Op::Pass(a, b, c)),
        1 => Just(Op::Sweep),
    ]
}

fn kind_of(take_profit: bool) -> Kind {
    if take_profit {
        Kind::TakeProfit
    } else {
        Kind::StopLoss
    }
}

/// Whether `record` was set on the position `seat` holds now.
fn identity_holds(record: &TriggerRecord, seat: &Seat) -> bool {
    let base = seat.perp[0].base;
    base != 0 && (base > 0) == (record.flags & 8 != 0) && seat.generation(0) == record.generation
}

struct Model {
    rig: Rig,
    traders: Vec<u32>,
    bidder: u32,
    asker: u32,
}

impl Model {
    fn new() -> Model {
        let mut w = World::new(16, 64);
        w.add_market(perp_params(0));
        let mut rig = Rig::around(w, 0, 16);
        let traders = (0..TRADERS)
            .map(|_| funded(&mut rig.w, 10_000_000))
            .collect();
        let bidder = funded(&mut rig.w, 100_000_000);
        let asker = funded(&mut rig.w, 100_000_000);
        let mut model = Model {
            rig,
            traders,
            bidder,
            asker,
        };
        for (at, seat) in model.traders.clone().into_iter().enumerate() {
            model.trade(seat, [Side::Bid, Side::Ask][at % 2], 100, false);
        }
        model
    }

    fn mark(&self) -> u64 {
        self.rig.w.markets[0].price.price
    }

    /// The price of liquidity on `side`: a tick inside the mark, so the two sides rest
    /// without crossing each other.
    fn quote(&self, side: Side) -> u64 {
        match side {
            Side::Bid => self.mark() - TICK,
            Side::Ask => self.mark() + TICK,
        }
    }

    /// Replaces the resting liquidity with `size` lots on each side of the mark; a size
    /// under the market minimum leaves none.
    fn liquidity(&mut self, size: u64) {
        for (seat, side) in [(self.bidder, Side::Bid), (self.asker, Side::Ask)] {
            self.rig.w.cancel_all(0, seat, 100).unwrap();
            if size >= MIN_SIZE {
                let order = limit(side, self.quote(side), size);
                self.rig.w.place(0, seat, order).unwrap();
            }
        }
    }

    /// `seat` trades `size` lots against liquidity of exactly that size.
    fn trade(&mut self, seat: u32, side: Side, size: u64, reduce: bool) {
        let size = size.max(MIN_SIZE);
        self.liquidity(size);
        let order = ioc(side, self.quote(side.opposite()), size);
        let order = if reduce { reduce_only(order) } else { order };
        self.rig.w.place(0, seat, order).unwrap();
        self.liquidity(0);
    }

    fn set(&mut self, seat: u32, take_profit: bool, offset: u8, size: u8) {
        let base = self.rig.base(seat);
        let long = base > 0;
        let step = TICK * (1 + u64::from(offset % 40));
        let trigger = if take_profit == long {
            self.mark() + step
        } else {
            self.mark() - step
        };
        let gap = TICK * (1 + u64::from(size / 3 % 40));
        let worst = if long {
            trigger.saturating_sub(gap).max(TICK)
        } else {
            trigger + gap
        };
        let sizes = [
            TriggerSize::WholePosition,
            TriggerSize::Lots(2),
            TriggerSize::Lots(50),
        ];
        let request = TriggerInput {
            size: sizes[usize::from(size % 3)],
            ..input(
                kind_of(take_profit),
                trigger,
                worst,
                TriggerSize::WholePosition,
            )
        };
        let result = self.rig.set_for(seat, request);
        if base == 0 {
            assert_eq!(result, Err(TriggerError::NoPosition));
        }
    }

    /// The most lots the records standing on `seat`'s position may close in a pass at the
    /// current mark: only a record the mark has reached can fire.
    fn authorized(&mut self, seat: u32) -> u64 {
        let (stored, mark) = (self.rig.stored(seat), self.mark());
        let live = self.rig.base(seat).unsigned_abs();
        let mut total = 0u64;
        for kind in [Kind::TakeProfit, Kind::StopLoss] {
            let Some(record) = self.rig.record(seat, kind) else {
                continue;
            };
            let reached = if record.flags & 2 != 0 {
                mark <= record.trigger_price
            } else {
                mark >= record.trigger_price
            };
            if reached && identity_holds(&record, &stored) {
                let own = if record.flags & 4 != 0 {
                    live
                } else {
                    record.size
                };
                total = total.saturating_add(own);
            }
        }
        total.min(live)
    }

    fn pass(&mut self, mark: u8, max: u8, fill: u8) {
        self.rig
            .w
            .set_price(0, 500 + TICK * (u64::from(mark) % 100));
        self.liquidity(u64::from(fill) % 120);
        let seats = self.traders.clone();
        let before: Vec<_> = seats
            .iter()
            .map(|seat| (self.rig.base(*seat), self.authorized(*seat)))
            .collect();
        self.rig.w.markets[0].params.min_size = MIN_SIZE;
        self.rig.fire(usize::from(max) % 33);
        self.rig.w.markets[0].params.min_size = 1;
        for (seat, (was, allowed)) in seats.into_iter().zip(before) {
            let now = self.rig.base(seat);
            let closed = was.unsigned_abs().saturating_sub(now.unsigned_abs());
            assert!(now == 0 || now.signum() == was.signum(), "a fire flipped");
            assert!(
                now.unsigned_abs() <= was.unsigned_abs() && closed <= allowed,
                "seat {seat} closed {closed} lots, its records allow {allowed}"
            );
        }
        self.liquidity(0);
    }

    fn sweep(&mut self) {
        let (seats, now) = (self.rig.w.seats.clone(), self.rig.w.now);
        self.rig.book().sweep(&seats, 16, now).unwrap();
        for seat in self.traders.clone() {
            for kind in [Kind::TakeProfit, Kind::StopLoss] {
                if let Some(record) = self.rig.record(seat, kind) {
                    let held = identity_holds(&record, &seats[seat as usize]);
                    assert!(held, "a dead record survived a sweep");
                }
            }
        }
    }

    fn apply(&mut self, op: &Op) {
        let seat = |pick: u8| self.traders[usize::from(pick) % TRADERS];
        match *op {
            Op::Set(pick, take_profit, offset, size) => {
                self.set(seat(pick), take_profit, offset, size)
            }
            Op::Cancel(pick, take_profit) => {
                let seat = seat(pick);
                let (stored, key, now) =
                    (self.rig.stored(seat), self.rig.w.key(seat), self.rig.w.now);
                let trader = Trader { seat, owner: &key };
                let kind = kind_of(take_profit);
                self.rig
                    .book()
                    .cancel_trigger(trader, &stored, kind, now)
                    .unwrap();
            }
            Op::Close(pick) => {
                let seat = seat(pick);
                let base = self.rig.base(seat);
                if base != 0 {
                    let side = if base > 0 { Side::Ask } else { Side::Bid };
                    self.trade(seat, side, base.unsigned_abs(), true);
                }
            }
            Op::Reopen(pick, long) => {
                let seat = seat(pick);
                if self.rig.base(seat) == 0 {
                    self.trade(seat, if long { Side::Bid } else { Side::Ask }, 100, false);
                }
            }
            Op::Pass(mark, max, fill) => self.pass(mark, max, fill),
            Op::Sweep => self.sweep(),
        }
    }
}

pub fn run_model(ops: &[Op]) {
    let mut m = Model::new();
    for op in ops {
        m.rig.w.now += 1;
        m.rig.mark(m.mark());
        m.apply(op);
        let book = m.rig.book();
        book.check_invariants().unwrap();
        let queued = [ABOVE_HEAP, BELOW_HEAP, TIME_HEAP].map(|heap| book.heap_len(heap));
        assert_eq!(queued.iter().sum::<usize>(), book.active_records());
    }
}

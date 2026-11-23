//! A stateful history against a real ledger: traders set, cancel, close and reopen
//! positions, reset their keys, age a slot to the generation boundary, recycle a seat,
//! hold resting orders that block a stop, and passes fire through `place_order`. The book
//! is made for the largest ledger and the ledger is a small one. After every pass no seat
//! has lost more lots than the records standing on its position authorize, and after a
//! full lap of sweeps every record belongs to the position it stands on.
//!
//! The model keeps its own count of the positions each trader has had, and a record is
//! live only while the position it was set on is the one the trader holds. It reads no
//! generation, epoch or flag bit of the engine.

use super::*;
use proptest::prelude::*;

const TRADERS: usize = 40;
const MIN_SIZE: u64 = 5;
const TICK: u64 = 10;
const LEDGER_SEATS: usize = 64;
const BOOK_SEATS: u32 = 34_492;
const HOLD_LOTS: u64 = 80_000;

#[derive(Clone, Debug)]
pub enum Op {
    Set(u8, bool, u8, u8),
    Cancel(u8, bool),
    Close(u8),
    Reopen(u8, bool),
    Pass(u8, u8, u8),
    Sweep,
    SweepSome(u8),
    ResetKeys(u8),
    Age(u8),
    Recycle(u8),
    Hold(u8),
    Crash,
}

pub fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        4 => (any::<u8>(), any::<bool>(), any::<u8>(), any::<u8>()).prop_map(|(a, b, c, d)| Op::Set(a, b, c, d)),
        2 => (any::<u8>(), any::<bool>()).prop_map(|(a, b)| Op::Cancel(a, b)),
        2 => any::<u8>().prop_map(Op::Close),
        2 => (any::<u8>(), any::<bool>()).prop_map(|(a, b)| Op::Reopen(a, b)),
        4 => (any::<u8>(), any::<u8>(), any::<u8>()).prop_map(|(a, b, c)| Op::Pass(a, b, c)),
        1 => Just(Op::Sweep),
        2 => any::<u8>().prop_map(Op::SweepSome),
        1 => any::<u8>().prop_map(Op::ResetKeys),
        1 => any::<u8>().prop_map(Op::Age),
        1 => any::<u8>().prop_map(Op::Recycle),
        1 => any::<u8>().prop_map(Op::Hold),
        1 => Just(Op::Crash),
    ]
}

fn kind_of(take_profit: bool) -> Kind {
    if take_profit {
        Kind::TakeProfit
    } else {
        Kind::StopLoss
    }
}

/// What the model knows of a record it asked for: the position it was set on, counted by
/// the model itself, the side of that position and whether it follows the whole position.
#[derive(Clone, Copy, Debug)]
struct Asked {
    position: u64,
    long: bool,
    whole: bool,
}

struct Model {
    rig: Rig,
    traders: Vec<u32>,
    bidder: u32,
    asker: u32,
    /// The positions each trader has had so far, and the base seen after the last op.
    positions: Vec<u64>,
    last_base: Vec<i64>,
    asked: Vec<[Option<Asked>; 2]>,
}

impl Model {
    fn new() -> Model {
        let mut w = World::new(LEDGER_SEATS, 128);
        w.add_market(perp_params(0));
        let mut rig = Rig::around(w, 0, BOOK_SEATS);
        let traders: Vec<u32> = (0..TRADERS)
            .map(|_| funded(&mut rig.w, 10_000_000))
            .collect();
        let bidder = funded(&mut rig.w, 100_000_000);
        let asker = funded(&mut rig.w, 100_000_000);
        let mut model = Model {
            rig,
            bidder,
            asker,
            positions: vec![0; TRADERS],
            last_base: vec![0; TRADERS],
            asked: vec![[None; 2]; TRADERS],
            traders,
        };
        for (at, seat) in model.traders.clone().into_iter().enumerate() {
            model.trade(seat, [Side::Bid, Side::Ask][at % 2], 100, false);
        }
        model.observe();
        model
    }

    fn mark(&self) -> u64 {
        self.rig.w.markets[0].price.price
    }

    /// Counts a position that ended or flipped since the last look as a new one.
    fn observe(&mut self) {
        for at in 0..TRADERS {
            let base = self.rig.base(self.traders[at]);
            let before = self.last_base[at];
            if before != 0 && (base == 0 || (base > 0) != (before > 0)) {
                self.positions[at] += 1;
            }
            self.last_base[at] = base;
        }
    }

    /// Whether the record the model asked for at `(trader, kind)` still stands on the
    /// position its trader holds.
    fn live(&self, at: usize, take_profit: bool) -> Option<Asked> {
        let asked = self.asked[at][usize::from(take_profit)]?;
        let base = self.last_base[at];
        (base != 0 && (base > 0) == asked.long && asked.position == self.positions[at])
            .then_some(asked)
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
        self.rig.w.cancel_all(0, seat, 100).unwrap();
        self.liquidity(size);
        let order = ioc(side, self.quote(side.opposite()), size);
        let order = if reduce { reduce_only(order) } else { order };
        self.rig.w.place(0, seat, order).unwrap();
        self.liquidity(0);
    }

    fn set(&mut self, at: usize, take_profit: bool, offset: u8, size: u8) {
        let seat = self.traders[at];
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
        let whole = size % 3 == 0;
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
        if result.is_ok() {
            self.asked[at][usize::from(take_profit)] = Some(Asked {
                position: self.positions[at],
                long,
                whole,
            });
        }
    }

    /// The most lots the records standing on `seat`'s position may close in a pass at the
    /// current mark: only a live record the mark has reached can fire.
    fn authorized(&mut self, at: usize) -> u64 {
        let (seat, mark) = (self.traders[at], self.mark());
        let live_lots = self.rig.base(seat).unsigned_abs();
        let mut total = 0u64;
        for take_profit in [true, false] {
            let Some(record) = self.rig.record(seat, kind_of(take_profit)) else {
                continue;
            };
            let Some(asked) = self.live(at, take_profit) else {
                continue;
            };
            let fires_below = asked.long != take_profit;
            let reached = if fires_below {
                mark <= record.trigger_price
            } else {
                mark >= record.trigger_price
            };
            if reached {
                let own = if asked.whole { live_lots } else { record.size };
                total = total.saturating_add(own);
            }
        }
        total.min(live_lots)
    }

    fn pass(&mut self, mark: u8, max: u8, fill: u8) {
        self.rig
            .w
            .set_price(0, 500 + TICK * (u64::from(mark) % 100));
        self.liquidity(u64::from(fill) % 120);
        let before: Vec<_> = (0..TRADERS)
            .map(|at| {
                let seat = self.traders[at];
                let maker = self.rig.stored(seat).slot_orders.iter().any(|&n| n > 0);
                let allowed = (!maker).then(|| self.authorized(at));
                (self.rig.base(seat), allowed)
            })
            .collect();
        let params = &mut self.rig.w.markets[0].params;
        params.min_size = MIN_SIZE;
        let margin = params.im_bps;
        if fill >= 200 {
            params.im_bps = 5_000;
        }
        let budget = usize::from(max) % MAX_FIRES_PER_PASS + 1;
        self.rig.fire(budget);
        let params = &mut self.rig.w.markets[0].params;
        params.min_size = 1;
        params.im_bps = margin;
        for (at, (was, allowed)) in before.into_iter().enumerate() {
            let Some(allowed) = allowed else { continue };
            let now = self.rig.base(self.traders[at]);
            let closed = was.unsigned_abs().saturating_sub(now.unsigned_abs());
            assert!(now == 0 || now.signum() == was.signum(), "a fire flipped");
            assert!(
                now.unsigned_abs() <= was.unsigned_abs() && closed <= allowed,
                "trader {at} closed {closed} lots, its records allow {allowed}"
            );
        }
        self.liquidity(0);
    }

    /// Sweeps a whole lap of the ledger, in as many calls as the heap change limit needs.
    fn sweep(&mut self) {
        let (seats, now) = (self.rig.w.seats.clone(), self.rig.w.now);
        let mut examined = 0usize;
        for _ in 0..seats.len() * 2 {
            if examined >= seats.len() {
                break;
            }
            let report = self.rig.book().sweep(&seats, 16, now).unwrap();
            assert!(report.examined > 0, "a sweep made no progress");
            examined += usize::try_from(report.examined).unwrap();
        }
        assert!(examined >= seats.len(), "a lap did not finish");
        for at in 0..TRADERS {
            for take_profit in [true, false] {
                let seat = self.traders[at];
                if self.rig.record(seat, kind_of(take_profit)).is_some() {
                    assert!(
                        self.live(at, take_profit).is_some(),
                        "a dead record survived a lap of sweeps"
                    );
                }
            }
        }
    }

    fn sweep_some(&mut self, pick: u8) {
        let count = u32::from(pick % 48) + 1;
        let (seats, now) = (self.rig.w.seats.clone(), self.rig.w.now);
        let report = self.rig.book().sweep(&seats, count, now).unwrap();
        assert!(report.examined <= count);
        assert!(
            report.dropped + report.requeued <= SWEEP_MAX_HEAP_CHANGES + 2,
            "a call made {report:?}"
        );
    }

    fn reset_keys(&mut self, at: usize) {
        let seat = self.traders[at];
        let key = self.rig.w.key(seat);
        let mut led = ledger(&mut self.rig.w.header, &mut self.rig.w.seats);
        reset_seat_epoch(&mut led, Trader { seat, owner: &key }).unwrap();
        self.positions[at] += 1;
    }

    fn age(&mut self, at: usize, pick: u8) {
        let seat = self.traders[at];
        if self.rig.base(seat) == 0 {
            let generation = GENERATION_MAX - u32::from(pick % 2);
            self.rig.w.seats[seat as usize]
                .set_generations([generation, 0, 0, 0])
                .unwrap();
        }
    }

    fn recycle(&mut self, at: usize) {
        let seat = self.traders[at];
        let collateral = self.rig.w.collateral(seat);
        if self.rig.base(seat) != 0 || collateral <= 0 {
            return;
        }
        let key = self.rig.w.key(seat);
        self.rig.w.cancel_all(0, seat, 100).unwrap();
        self.rig
            .w
            .withdraw(seat, Asset::Collateral, u64::try_from(collateral).unwrap())
            .unwrap();
        self.rig.w.close(seat).unwrap();
        assert_eq!(self.rig.w.open_with_key(key).unwrap(), seat);
        self.rig
            .w
            .deposit(seat, Asset::Collateral, 10_000_000)
            .unwrap();
    }

    /// The trader rests a large order on the side its stop would close on, so a stop
    /// that fires while margin is tight is refused for the orders it would add to.
    fn hold(&mut self, at: usize) {
        let seat = self.traders[at];
        let base = self.rig.base(seat);
        self.rig.w.cancel_all(0, seat, 100).unwrap();
        if base != 0 {
            let order = if base > 0 {
                limit(Side::Ask, self.mark() + 5 * TICK, HOLD_LOTS)
            } else {
                limit(Side::Bid, self.mark() - 5 * TICK, HOLD_LOTS)
            };
            let _ = self.rig.w.place(0, seat, order);
        }
    }

    fn close(&mut self, seat: u32) {
        let base = self.rig.base(seat);
        if base != 0 {
            let side = if base > 0 { Side::Ask } else { Side::Bid };
            self.trade(seat, side, base.unsigned_abs(), true);
        }
    }

    fn apply(&mut self, op: &Op) {
        let at = |pick: u8| usize::from(pick) % TRADERS;
        match *op {
            Op::Set(pick, take_profit, offset, size) => {
                self.set(at(pick), take_profit, offset, size)
            }
            Op::Cancel(pick, take_profit) => {
                let seat = self.traders[at(pick)];
                let (stored, key, now) =
                    (self.rig.stored(seat), self.rig.w.key(seat), self.rig.w.now);
                let trader = Trader { seat, owner: &key };
                let kind = kind_of(take_profit);
                self.rig
                    .book()
                    .cancel_trigger(trader, &stored, kind, now)
                    .unwrap();
                self.asked[at(pick)][usize::from(take_profit)] = None;
            }
            Op::Close(pick) => self.close(self.traders[at(pick)]),
            Op::Reopen(pick, long) => {
                let seat = self.traders[at(pick)];
                if self.rig.base(seat) == 0 {
                    self.trade(seat, if long { Side::Bid } else { Side::Ask }, 100, false);
                }
            }
            Op::Pass(mark, max, fill) => self.pass(mark, max, fill),
            Op::Sweep => self.sweep(),
            Op::SweepSome(pick) => self.sweep_some(pick),
            Op::ResetKeys(pick) => self.reset_keys(at(pick)),
            Op::Age(pick) => self.age(at(pick), pick),
            Op::Recycle(pick) => self.recycle(at(pick)),
            Op::Hold(pick) => self.hold(at(pick)),
            Op::Crash => {
                for seat in self.traders.clone() {
                    self.close(seat);
                }
            }
        }
    }
}

pub fn run_model(ops: &[Op]) {
    let mut m = Model::new();
    for op in ops {
        m.rig.w.now += 1;
        m.rig.mark(m.mark());
        m.apply(op);
        m.observe();
        let book = m.rig.book();
        book.check_invariants().unwrap();
        let queued = [ABOVE_HEAP, BELOW_HEAP, TIME_HEAP].map(|heap| book.heap_len(heap));
        assert_eq!(queued.iter().sum::<usize>(), book.active_records());
        for at in 0..TRADERS {
            for take_profit in [true, false] {
                let standing = m.rig.record(m.traders[at], kind_of(take_profit)).is_some();
                assert!(
                    !standing || m.asked[at][usize::from(take_profit)].is_some(),
                    "a record nobody asked for"
                );
            }
        }
    }
}

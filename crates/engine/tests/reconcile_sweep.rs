//! RULES 8.6: `reconcile_shortfall` reads the seat table a range at a time. A sweep that
//! no debt moves under gives what one pass over the whole table gave, and a sweep that a
//! liquidation adding debt falls in applies nothing. Whatever happens between the
//! calls, the records never end below what flat seats truly owe.

mod common;

use bytemuck::Zeroable;
use common::*;
use noirwire_orderbook_engine::EngineError as E;
use noirwire_orderbook_engine::*;
use proptest::prelude::*;
use proptest::test_runner::{Config, RngAlgorithm, TestRng, TestRunner};

const DEBTOR_FUNDS: u64 = 1_100;
const LOTS: u64 = 10;

struct Scene {
    w: World,
    m: usize,
    liquidator: u32,
    maker: u32,
}

fn scene(seat_capacity: usize) -> Scene {
    let mut w = World::new(seat_capacity, 8);
    let m = w.add_market(perp_params(0));
    let maker = funded(&mut w, 1_000_000_000);
    let liquidator = funded(&mut w, 1_000_000_000);
    Scene {
        w,
        m,
        liquidator,
        maker,
    }
}

impl Scene {
    /// A new seat long ten lots at 1,000, which the mark falling to 700 bankrupts. A
    /// recorded shortfall leaves the market reduce-only, which a scene undoes so that
    /// debts can be made one after the other.
    fn long(&mut self) -> u32 {
        self.w.set_price(self.m, 1_000);
        self.w.markets[self.m].params.status = STATUS_ACTIVE;
        let seat = funded(&mut self.w, DEBTOR_FUNDS);
        buy_from(&mut self.w, self.m, seat, self.maker, 1_000, LOTS);
        seat
    }

    /// Liquidates `seat` at 700, far enough below its margin that what the insurance
    /// and fee seats hold cannot pay for it, so a shortfall is recorded. Returns it.
    fn bankrupt(&mut self, seat: u32) -> u64 {
        self.w.set_price(self.m, 700);
        let outcome = self
            .w
            .liquidate(self.m, self.liquidator, seat, LOTS)
            .unwrap();
        self.w.set_price(self.m, 1_000);
        outcome.uncovered
    }

    fn debtor(&mut self) -> u32 {
        let seat = self.long();
        let recorded = self.bankrupt(seat);
        assert!(recorded > 0, "setup: no shortfall was recorded");
        seat
    }

    fn cursor(&self) -> u32 {
        self.w.header.reconcile_cursor
    }
}

#[test]
fn a_sweep_nothing_interrupts_gives_what_one_pass_over_the_table_gave() {
    for per_call in [1u16, 2, 3, 5, 7, 64] {
        let mut s = scene(16);
        let first = s.debtor();
        let second = s.debtor();
        let _bystander = s.w.open();
        s.w.deposit(first, Asset::Collateral, 30).unwrap();
        let recorded = s.w.total_recorded();
        let owed = s.w.flat_debt();
        assert!(recorded > owed, "setup: nothing to lower");
        assert!(s.w.collateral(second) < 0);

        let mut removed = 0;
        let mut calls = 0;
        loop {
            removed += s.w.reconcile_in(per_call).unwrap();
            calls += 1;
            if s.cursor() == 0 {
                break;
            }
        }

        assert_eq!(removed, recorded - owed, "{per_call} seats a call");
        assert_eq!(s.w.total_recorded(), s.w.flat_debt());
        assert_eq!(calls, 16usize.div_ceil(usize::from(per_call)));
        assert_eq!(s.w.header.reconcile_owed, 0);
    }
}

#[test]
fn a_sweep_over_several_calls_changes_nothing_until_the_last_seat_is_read() {
    let mut s = scene(8);
    let debtor = s.debtor();
    s.w.deposit(debtor, Asset::Collateral, 30).unwrap();
    let recorded = s.w.total_recorded();
    assert!(recorded > s.w.flat_debt());

    for (call, cursor) in [(1, 3), (2, 6)] {
        assert_eq!(s.w.reconcile_in(3), Ok(0), "call {call}");
        assert_eq!(s.cursor(), cursor);
        assert_eq!(s.w.total_recorded(), recorded);
    }
    assert_eq!(s.w.header.reconcile_owed, s.w.flat_debt());
    assert_eq!(s.w.reconcile_in(3), Ok(recorded - s.w.flat_debt()));
    assert_eq!(s.cursor(), 0);
    assert_eq!(s.w.header.reconcile_owed, 0);
}

#[test]
fn a_count_larger_than_the_table_finishes_the_sweep_in_one_call() {
    let mut s = scene(8);
    let debtor = s.debtor();
    s.w.deposit(debtor, Asset::Collateral, 30).unwrap();
    let expected = s.w.total_recorded() - s.w.flat_debt();
    assert!(expected > 0);

    assert_eq!(s.w.reconcile_in(u16::MAX), Ok(expected));
    assert_eq!(s.cursor(), 0);
    assert_eq!(s.w.total_recorded(), s.w.flat_debt());
}

#[test]
fn a_count_of_zero_is_refused_and_changes_nothing() {
    let mut s = scene(8);
    let debtor = s.debtor();
    s.w.deposit(debtor, Asset::Collateral, 30).unwrap();
    assert_eq!(s.w.reconcile_in(0), Err(E::ZeroAmount));
    assert_eq!(s.w.reconcile_in(3), Ok(0));
    let header = s.w.header;
    assert_eq!(s.w.reconcile_in(0), Err(E::ZeroAmount));
    assert_eq!(s.w.header, header);
}

#[test]
fn a_call_only_moves_the_cursor_forward_and_cannot_restart_or_rewind_a_sweep() {
    let mut s = scene(12);
    let debtor = s.debtor();
    s.w.deposit(debtor, Asset::Collateral, 30).unwrap();
    let mut cursor = 0;
    let mut owed = 0;
    for count in [1u16, 1, 3, 1, 2, 1, 1, 1, 1] {
        s.w.reconcile_in(count).unwrap();
        if s.cursor() == 0 {
            break;
        }
        assert!(s.cursor() > cursor, "the cursor only advances");
        assert!(s.w.header.reconcile_owed >= owed, "the sum only grows");
        cursor = s.cursor();
        owed = s.w.header.reconcile_owed;
    }
    assert_eq!(s.cursor(), 0, "the sweep ran to its end");
}

#[test]
fn a_liquidation_that_leaves_a_read_seat_in_debt_makes_the_sweep_apply_nothing() {
    let mut s = scene(8);
    let repaid = s.long();
    let victim = s.long();
    s.bankrupt(repaid);
    s.w.deposit(repaid, Asset::Collateral, 10_000).unwrap();
    assert_eq!(s.w.flat_debt(), 0);
    let before = s.w.total_recorded();
    assert!(before > 0);

    assert_eq!(s.w.reconcile_in(victim as u16 + 1), Ok(0));
    assert_eq!(s.w.header.reconcile_owed, 0);
    let epoch = s.w.header.debt_epoch;
    let added = s.bankrupt(victim);
    assert!(added > 0);
    assert_eq!(s.w.header.debt_epoch, epoch.wrapping_add(1));

    assert_eq!(s.w.reconcile_in(u16::MAX), Ok(0));
    assert_eq!(s.cursor(), 0);
    assert_eq!(s.w.header.reconcile_owed, 0);
    assert_eq!(s.w.total_recorded(), before + added);
    assert!(s.w.total_recorded() >= s.w.flat_debt());

    assert_eq!(s.w.reconcile_in(u16::MAX), Ok(before));
    assert_eq!(s.w.total_recorded(), s.w.flat_debt());
}

#[test]
fn only_a_liquidation_that_records_a_shortfall_moves_the_debt_epoch() {
    let mut s = scene(8);
    let epoch = s.w.header.debt_epoch;
    let healthy = s.long();
    s.w.set_price(s.m, 900);
    let outcome = s.w.liquidate(s.m, s.liquidator, healthy, LOTS).unwrap();
    assert_eq!(outcome.uncovered, 0);
    s.w.set_price(s.m, 1_000);
    s.w.deposit(healthy, Asset::Collateral, 5).unwrap();
    s.w.reconcile();
    assert_eq!(s.w.header.debt_epoch, epoch);

    let debtor = s.long();
    s.bankrupt(debtor);
    assert_eq!(s.w.header.debt_epoch, epoch.wrapping_add(1));
}

#[test]
fn a_repayment_and_a_cover_during_a_sweep_never_leave_a_record_below_what_is_owed() {
    for read_seat_repays in [true, false] {
        let mut s = scene(8);
        let first = s.debtor();
        let second = s.debtor();
        let (repays, covered) = if read_seat_repays {
            (first, second)
        } else {
            (second, first)
        };
        let owed_first = -s.w.collateral(first);
        let owed_second = -s.w.collateral(second);
        assert_eq!(
            s.w.total_recorded(),
            u64::try_from(owed_first + owed_second).unwrap()
        );

        assert_eq!(s.w.reconcile_in(first as u16 + 1), Ok(0));
        s.w.deposit(repays, Asset::Collateral, 10_000).unwrap();
        s.w.deposit(INSURANCE_SEAT, Asset::Collateral, 50).unwrap();
        let paid = s.w.cover_shortfall(s.m, covered).unwrap();
        assert_eq!(paid, 50);
        assert!(s.w.total_recorded() >= s.w.flat_debt());

        let removed = s.w.reconcile_in(u16::MAX).unwrap();
        assert!(s.w.total_recorded() >= s.w.flat_debt());
        if read_seat_repays {
            assert_eq!(
                removed, 0,
                "the read seat's repayment is still counted as owed"
            );
        } else {
            let unread_debt = u64::try_from(owed_second).unwrap();
            assert_eq!(
                removed,
                unread_debt - paid,
                "the read seat's cover is not counted"
            );
            assert_eq!(s.w.total_recorded(), s.w.flat_debt() + paid);
        }
        s.w.reconcile();
        assert_eq!(s.w.total_recorded(), s.w.flat_debt());
    }
}

#[test]
fn a_seat_released_or_taken_during_a_sweep_adds_no_debt() {
    let mut s = scene(12);
    let early = s.w.open();
    let debtor = s.debtor();
    let idle = s.w.open();
    s.w.deposit(debtor, Asset::Collateral, 30).unwrap();
    assert_eq!(s.w.reconcile_in(debtor as u16 + 1), Ok(0));
    assert!(early < debtor && debtor < idle);
    s.w.close(early).unwrap();
    s.w.close(idle).unwrap();
    assert!(!s.w.seat(early).is_open() && !s.w.seat(idle).is_open());
    let retaken = s.w.open();
    assert!([early, idle].contains(&retaken));
    s.w.deposit(retaken, Asset::Collateral, 1).unwrap();
    assert!(s.w.total_recorded() >= s.w.flat_debt());
    s.w.reconcile_in(u16::MAX).unwrap();
    assert!(s.w.total_recorded() >= s.w.flat_debt());
    s.w.reconcile();
    assert_eq!(s.w.total_recorded(), s.w.flat_debt());
}

#[test]
fn debts_that_together_overflow_a_u64_make_the_completed_sweep_apply_nothing() {
    let debtor = Seat {
        status: SEAT_OPEN,
        collateral: i64::MIN,
        ..Seat::zeroed()
    };
    let mut seats = vec![debtor; 4];
    let mut header = LedgerHeader::zeroed();
    let mut markets = [perp_params(0)];
    markets[0].uncovered_shortfall = 1_000;
    for per_call in [1u16, 2, u16::MAX] {
        let mut view = ledger(&mut header, &mut seats);
        let mut removed = 0;
        loop {
            removed += reconcile_shortfall(&mut view, &mut markets, per_call).unwrap();
            if view.header.reconcile_cursor == 0 {
                break;
            }
        }
        assert_eq!(removed, 0, "{per_call} seats a call");
        assert_eq!(markets[0].uncovered_shortfall, 1_000);
        assert_eq!(view.header.reconcile_owed, 0);
    }
}

#[derive(Clone, Debug)]
enum Step {
    Debt,
    Repay { pick: u8, amount: u64 },
    Cover { pick: u8, insurance: u64 },
    Fill,
    Churn,
    Sweep { count: u16 },
}

fn steps() -> BoxedStrategy<Step> {
    prop_oneof![
        3 => Just(Step::Debt),
        3 => (any::<u8>(), 1u64..600).prop_map(|(pick, amount)| Step::Repay { pick, amount }),
        2 => (any::<u8>(), 1u64..400)
            .prop_map(|(pick, insurance)| Step::Cover { pick, insurance }),
        1 => Just(Step::Fill),
        1 => Just(Step::Churn),
        6 => (1u16..9).prop_map(|count| Step::Sweep { count }),
    ]
    .boxed()
}

/// Random interleavings of liquidations that leave debt, repayments, covers, real
/// fills, seats released and taken, and sweep steps of any size. After every step the records are at least what flat
/// seats owe, which is all a completed sweep may leave them at.
#[test]
fn no_interleaving_lowers_a_record_below_what_flat_seats_owe() {
    let config = Config {
        cases: Config::default().cases.max(64),
        failure_persistence: None,
        ..Config::default()
    };
    let rng = TestRng::from_seed(RngAlgorithm::ChaCha, &[7; 32]);
    let mut runner = TestRunner::new_with_rng(config, rng);
    let histories = prop::collection::vec(steps(), 20..120);

    runner
        .run(&histories, |history| {
            let mut s = scene(40);
            let mut debtors: Vec<u32> = Vec::new();
            for step in &history {
                match step {
                    Step::Debt => {
                        if s.w.seats.iter().filter(|seat| !seat.is_open()).count() > 2 {
                            let seat = s.debtor();
                            debtors.push(seat);
                        }
                    }
                    Step::Repay { pick, amount } => {
                        if let Some(seat) = pick_of(&debtors, *pick) {
                            s.w.deposit(seat, Asset::Collateral, *amount).unwrap();
                        }
                    }
                    Step::Cover { pick, insurance } => {
                        if let Some(seat) = pick_of(&debtors, *pick) {
                            s.w.deposit(INSURANCE_SEAT, Asset::Collateral, *insurance)
                                .unwrap();
                            s.w.cover_shortfall(s.m, seat).unwrap();
                        }
                    }
                    Step::Fill => {
                        if s.w.seats.iter().filter(|seat| !seat.is_open()).count() > 2 {
                            s.long();
                        }
                    }
                    Step::Churn => {
                        if s.w.seats.iter().filter(|seat| !seat.is_open()).count() > 2 {
                            let seat = s.w.open();
                            s.w.close(seat).unwrap();
                        }
                    }
                    Step::Sweep { count } => {
                        let epoch_before = s.w.header.debt_epoch;
                        let recorded_before = s.w.total_recorded();
                        let removed = s.w.reconcile_in(*count).unwrap();
                        let completed = s.cursor() == 0;
                        prop_assert!(completed || removed == 0);
                        prop_assert_eq!(epoch_before, s.w.header.debt_epoch);
                        prop_assert_eq!(recorded_before - removed, s.w.total_recorded());
                    }
                }
                prop_assert!(
                    s.w.total_recorded() >= s.w.flat_debt(),
                    "recorded {} owed {}",
                    s.w.total_recorded(),
                    s.w.flat_debt()
                );
            }
            Ok(())
        })
        .unwrap();
}

fn pick_of(debtors: &[u32], pick: u8) -> Option<u32> {
    if debtors.is_empty() {
        return None;
    }
    debtors.get(usize::from(pick) % debtors.len()).copied()
}

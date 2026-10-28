//! RULES 8 and 8.6 over a range of seats: `liquidate_range` is the sequence of single
//! `liquidate` calls on the seats a call could take something from, and
//! `cover_shortfall_range` is the sum of single `cover_shortfall` calls.

mod common;

use common::*;
use noirwire_orderbook_engine::*;

struct Staged {
    world: World,
    market: usize,
    liquidator: u32,
    /// Underwater longs at seats 4 to 7.
    targets: Vec<u32>,
    healthy: u32,
}

/// Four longs that a fall of the mark takes below maintenance margin, one long that
/// it does not, and a liquidator with room to take them all over. Insurance holds 300,
/// which covers part of the deficits and leaves the rest recorded on the market.
fn staged() -> Staged {
    let mut world = World::new(16, 8);
    let market = world.add_market(free_perp());
    let maker = funded(&mut world, 1_000_000);
    let liquidator = funded(&mut world, 10_000_000);
    let targets: Vec<u32> = (0..4).map(|_| funded(&mut world, 1_100)).collect();
    let healthy = funded(&mut world, 1_000_000);
    world
        .deposit(INSURANCE_SEAT, Asset::Collateral, 300)
        .unwrap();
    for target in &targets {
        buy_from(&mut world, market, *target, maker, 1_000, 10);
    }
    buy_from(&mut world, market, healthy, maker, 1_000, 1);
    world.set_price(market, 850);
    assert_eq!(targets, [4, 5, 6, 7]);
    for target in &targets {
        assert!(world.is_liquidatable(*target, market));
    }
    assert!(!world.is_liquidatable(healthy, market));
    Staged {
        world,
        market,
        liquidator,
        targets,
        healthy,
    }
}

fn sweep(start: u32, count: u16, max_takeovers: u8) -> RangeRequest {
    RangeRequest {
        start,
        count,
        size: 10,
        worst_price: u64::MAX,
        max_takeovers,
    }
}

/// A sweep's sums without its cursor, which single calls have no counterpart for.
fn sums(outcome: RangeOutcome) -> RangeOutcome {
    RangeOutcome {
        next_start: 0,
        ..outcome
    }
}

/// What the single calls over `seats` did, summed as a range sums them.
fn singles(staged: &mut Staged, seats: impl Iterator<Item = u32>) -> RangeOutcome {
    let mut total = RangeOutcome::default();
    for seat in seats {
        let Ok(outcome) = staged
            .world
            .liquidate(staged.market, staged.liquidator, seat, 10)
        else {
            continue;
        };
        if outcome.status != LiquidationStatus::Liquidated {
            continue;
        }
        total.taken += 1;
        total.lots += outcome.liquidated;
        total.notional += outcome.price * outcome.liquidated;
        total.paid += outcome.insurance_paid + outcome.fee_seat_paid;
        total.uncovered += outcome.uncovered;
        total.cancelled += u64::from(outcome.orders_cancelled);
    }
    total
}

#[test]
fn a_range_equals_the_single_calls_on_the_same_world() {
    let mut by_range = staged();
    let mut by_singles = staged();
    let table = u16::try_from(by_range.world.seats.len()).unwrap();

    let ranged = by_range
        .world
        .liquidate_range(by_range.market, by_range.liquidator, &sweep(0, table, 255))
        .unwrap();
    let one_by_one = singles(&mut by_singles, 0..u32::from(table));

    assert_eq!(sums(ranged), one_by_one);
    assert_eq!(ranged.next_start, u32::from(table));
    assert_eq!(ranged.taken, 4);
    assert_eq!(ranged.lots, 40);
    assert!(ranged.paid > 0 && ranged.uncovered > 0, "{ranged:?}");
    assert_eq!(ranged.stopped, None);
    assert_eq!(by_range.world.bytes(), by_singles.world.bytes());
    assert_eq!(by_range.world.slot(by_range.liquidator, 0).base, 40);
    assert_eq!(by_range.world.slot(by_range.healthy, 0).base, 1);
    for target in &by_range.targets {
        assert_eq!(by_range.world.slot(*target, 0).base, 0);
    }
}

#[test]
fn a_range_in_pieces_equals_the_range_whole() {
    let mut whole = staged();
    let mut pieces = staged();

    let all = whole
        .world
        .liquidate_range(whole.market, whole.liquidator, &sweep(0, 16, 255))
        .unwrap();
    let mut sum = RangeOutcome::default();
    for (start, count) in [(0u32, 5u16), (5, 1), (6, 10)] {
        let part = pieces
            .world
            .liquidate_range(pieces.market, pieces.liquidator, &sweep(start, count, 255))
            .unwrap();
        sum.taken += part.taken;
        sum.lots += part.lots;
        sum.notional += part.notional;
        sum.paid += part.paid;
        sum.uncovered += part.uncovered;
        sum.cancelled += part.cancelled;
    }

    assert_eq!(sum, sums(all));
    assert_eq!(whole.world.bytes(), pieces.world.bytes());
}

#[test]
fn a_range_stops_after_max_takeovers_and_leaves_the_rest() {
    let mut by_range = staged();
    let mut by_singles = staged();

    let ranged = by_range
        .world
        .liquidate_range(by_range.market, by_range.liquidator, &sweep(0, 16, 2))
        .unwrap();
    let first_two = singles(&mut by_singles, 4..6);

    assert_eq!(ranged.taken, 2);
    assert_eq!(sums(ranged), first_two);
    assert_eq!(ranged.next_start, 6);
    assert_eq!(ranged.stopped, None);
    assert_eq!(by_range.world.bytes(), by_singles.world.bytes());
    for target in &by_range.targets[2..] {
        assert_eq!(by_range.world.slot(*target, 0).base, 10, "seat {target}");
    }

    let none = by_range
        .world
        .liquidate_range(by_range.market, by_range.liquidator, &sweep(0, 16, 0))
        .unwrap();
    assert_eq!(sums(none), RangeOutcome::default());
    assert_eq!(none.next_start, 0);
    assert_eq!(by_range.world.bytes(), by_singles.world.bytes());
}

#[test]
fn an_early_stop_reports_the_first_seat_it_did_not_reach_and_the_next_call_takes_it() {
    let mut staged = staged();
    let first = staged
        .world
        .liquidate_range(staged.market, staged.liquidator, &sweep(4, 12, 2))
        .unwrap();
    assert_eq!(first.taken, 2);
    assert_eq!(first.next_start, staged.targets[2]);
    assert_eq!(staged.world.slot(staged.targets[2], 0).base, 10);

    let second = staged
        .world
        .liquidate_range(
            staged.market,
            staged.liquidator,
            &sweep(first.next_start, 12, 1),
        )
        .unwrap();
    assert_eq!(second.taken, 1);
    assert_eq!(second.next_start, staged.targets[3]);
    assert_eq!(staged.world.slot(staged.targets[2], 0).base, 0);
}

#[test]
fn a_liquidator_margin_stop_reports_the_seat_it_could_not_take() {
    let mut staged = staged();
    let poor = funded(&mut staged.world, 1_200);
    let outcome = staged
        .world
        .liquidate_range(staged.market, poor, &sweep(4, 4, 255))
        .unwrap();
    assert_eq!(
        outcome.stopped,
        Some(LiquidationStatus::LiquidatorMarginInsufficient)
    );
    assert_eq!(outcome.next_start, 4 + u32::from(outcome.taken));
}

/// A world with a flat seat at one end of the probed range and a seat holding a
/// position at the other, so a one-seat range reads either.
fn probe_staged() -> (Staged, u32, u32) {
    let mut staged = staged();
    let flat = funded(&mut staged.world, 1_000);
    (staged, flat, 4)
}

fn probe(
    prepare: impl Fn(&mut Staged),
    request: impl Fn(u32) -> RangeRequest,
) -> (EngineResult<RangeOutcome>, EngineResult<RangeOutcome>) {
    let (mut with_position, flat, held) = probe_staged();
    let (mut without, _, _) = probe_staged();
    prepare(&mut with_position);
    prepare(&mut without);
    let on_position = with_position.world.liquidate_range(
        with_position.market,
        with_position.liquidator,
        &request(held),
    );
    let on_flat = without
        .world
        .liquidate_range(without.market, without.liquidator, &request(flat));
    (on_position, on_flat)
}

fn one_seat(seat: u32, size: u64) -> RangeRequest {
    RangeRequest {
        start: seat,
        count: 1,
        size,
        worst_price: u64::MAX,
        max_takeovers: 255,
    }
}

#[test]
fn a_zero_size_is_refused_whether_the_seat_holds_a_position_or_not() {
    let (on_position, on_flat) = probe(|_| {}, |seat| one_seat(seat, 0));
    assert_eq!(on_position, Err(EngineError::ZeroAmount));
    assert_eq!(on_flat, Err(EngineError::ZeroAmount));
}

#[test]
fn a_paused_exchange_or_market_is_refused_whether_the_seat_holds_a_position_or_not() {
    let (on_position, on_flat) = probe(|s| s.world.paused = true, |seat| one_seat(seat, 10));
    assert_eq!(on_position, Err(EngineError::ExchangePaused));
    assert_eq!(on_flat, Err(EngineError::ExchangePaused));

    let (on_position, on_flat) = probe(
        |s| s.world.markets[s.market].params.status = STATUS_PAUSED,
        |seat| one_seat(seat, 10),
    );
    assert_eq!(on_position, Err(EngineError::MarketPaused));
    assert_eq!(on_flat, Err(EngineError::MarketPaused));
}

#[test]
fn a_blocked_liquidator_is_refused_whether_the_seat_holds_a_position_or_not() {
    let (on_position, on_flat) = probe(
        |s| s.world.seats[s.liquidator as usize].blocked = 1,
        |seat| one_seat(seat, 10),
    );
    assert_eq!(on_position, Err(EngineError::SeatBlocked));
    assert_eq!(on_flat, Err(EngineError::SeatBlocked));
}

#[test]
fn a_stale_price_reads_the_same_whether_the_seat_holds_a_position_or_not() {
    let (on_position, on_flat) = probe(|s| s.world.now += 1_000, |seat| one_seat(seat, 10));
    let stale = |seat: u32| RangeOutcome {
        stopped: Some(LiquidationStatus::StalePrice),
        next_start: seat,
        ..RangeOutcome::default()
    };
    assert_eq!(sums(on_position.unwrap()), sums(stale(0)));
    assert_eq!(sums(on_flat.unwrap()), sums(stale(0)));
}

#[test]
fn a_range_stops_at_a_stale_price_having_changed_nothing() {
    let mut staged = staged();
    let before = staged.world.bytes();
    staged.world.now += 1_000;

    let outcome = staged
        .world
        .liquidate_range(staged.market, staged.liquidator, &sweep(0, 16, 255))
        .unwrap();

    assert_eq!(outcome.taken, 0);
    assert_eq!(outcome.stopped, Some(LiquidationStatus::StalePrice));
    assert_eq!(
        sums(RangeOutcome {
            stopped: None,
            ..outcome
        }),
        RangeOutcome::default()
    );
    assert_eq!(outcome.next_start, 0);
    assert_eq!(staged.world.bytes(), before);
}

#[test]
fn a_range_past_the_end_of_the_table_is_cut_short_and_a_range_beyond_it_is_empty() {
    let mut by_range = staged();
    let mut by_singles = staged();

    let cut = by_range
        .world
        .liquidate_range(
            by_range.market,
            by_range.liquidator,
            &sweep(6, u16::MAX, 255),
        )
        .unwrap();
    let tail = singles(&mut by_singles, 6..16);
    assert_eq!(sums(cut), tail);
    assert_eq!(cut.taken, 2);

    for start in [16, 17, u32::MAX] {
        let empty = by_range
            .world
            .liquidate_range(
                by_range.market,
                by_range.liquidator,
                &sweep(start, 100, 255),
            )
            .unwrap();
        assert_eq!(sums(empty), RangeOutcome::default(), "start {start}");
    }
}

#[test]
fn a_range_never_targets_the_reserved_seats_or_the_liquidators_own() {
    let mut staged = staged();
    let liquidator_before = *staged.world.seat(staged.liquidator);
    let reserved_before = [*staged.world.seat(0), *staged.world.seat(1)];

    let outcome = staged
        .world
        .liquidate_range(staged.market, staged.liquidator, &sweep(0, 4, 255))
        .unwrap();

    assert_eq!(sums(outcome), RangeOutcome::default());
    assert_eq!(*staged.world.seat(staged.liquidator), liquidator_before);
    assert_eq!(*staged.world.seat(0), reserved_before[0]);
    assert_eq!(*staged.world.seat(1), reserved_before[1]);
}

#[test]
fn a_range_refuses_a_liquidator_that_is_not_the_owner_of_its_seat() {
    let mut staged = staged();
    let before = staged.world.bytes();
    let thief = [0xEE; 32];
    let risks = staged.world.risks();
    let env = Env {
        now: staged.world.now,
        exchange_paused: false,
        quote_ok: true,
        max_steps: 8,
        markets: &risks,
        hash: sha,
    };
    let world = &mut staged.world;
    let mut market = world.markets[staged.market].as_mut();
    let mut ledger = ledger(&mut world.header, &mut world.seats);
    let mut journal = Journal::new(&mut world.journal);

    let refused = liquidate_range(
        &mut ledger,
        &mut market,
        &mut journal,
        &env,
        Trader {
            seat: staged.liquidator,
            owner: &thief,
        },
        &sweep(0, 16, 255),
    );

    assert_eq!(refused, Err(EngineError::NotSeatOwner));
    assert_eq!(world.bytes(), before);
}

#[test]
fn covering_a_range_equals_the_single_covers_summed() {
    let mut by_range = staged();
    let mut by_singles = staged();
    for staged in [&mut by_range, &mut by_singles] {
        let all = staged
            .world
            .liquidate_range(staged.market, staged.liquidator, &sweep(0, 16, 255))
            .unwrap();
        assert!(all.uncovered > 0);
        staged
            .world
            .deposit(INSURANCE_SEAT, Asset::Collateral, 10_000)
            .unwrap();
    }
    let recorded = by_range.world.markets[0].params.uncovered_shortfall;
    assert!(recorded > 0);

    let covered = by_range
        .world
        .cover_shortfall_range(by_range.market, 0, 16)
        .unwrap();
    let mut summed = 0;
    for seat in 0..16 {
        summed += by_singles
            .world
            .cover_shortfall(by_singles.market, seat)
            .unwrap();
    }

    assert_eq!(covered, summed);
    assert!(covered > 0);
    assert_eq!(by_range.world.bytes(), by_singles.world.bytes());
    let left = by_range.world.markets[0].params.uncovered_shortfall;
    assert_eq!(left, recorded - covered);
}

#[test]
fn covering_in_pieces_covers_what_the_whole_covers_and_stops_at_the_table() {
    let mut whole = staged();
    let mut pieces = staged();
    for staged in [&mut whole, &mut pieces] {
        staged
            .world
            .liquidate_range(staged.market, staged.liquidator, &sweep(0, 16, 255))
            .unwrap();
        staged
            .world
            .deposit(INSURANCE_SEAT, Asset::Collateral, 10_000)
            .unwrap();
    }

    let all = whole
        .world
        .cover_shortfall_range(whole.market, 0, u16::MAX)
        .unwrap();
    let first = pieces
        .world
        .cover_shortfall_range(pieces.market, 0, 6)
        .unwrap();
    let second = pieces
        .world
        .cover_shortfall_range(pieces.market, 6, 1_000)
        .unwrap();
    let beyond = pieces
        .world
        .cover_shortfall_range(pieces.market, 16, 10)
        .unwrap();

    assert_eq!(first + second, all);
    assert_eq!(beyond, 0);
    assert_eq!(whole.world.bytes(), pieces.world.bytes());
}

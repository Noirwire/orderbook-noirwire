//! A position slot's generation changes whenever a nonzero position ends or flips, on
//! every path that writes a position, and is carried through the release and the taking
//! of a seat. Every call goes through `World`, which asserts RULES 13 after it.

mod common;

use bytemuck::Zeroable;
use common::*;
use noirwire_orderbook_engine::*;

fn sell_to(w: &mut World, m: usize, seller: u32, buyer: u32, size: u64) {
    w.place(m, buyer, limit(Side::Bid, MARK, size)).unwrap();
    let outcome = w.place(m, seller, ioc(Side::Ask, MARK, size)).unwrap();
    assert_eq!(outcome.filled, size);
}

fn generation(w: &World, seat: u32, m: usize) -> u32 {
    let seat = w.seat(seat);
    seat.generation(seat.slot_index(m).unwrap())
}

fn trio() -> (World, usize, u32, u32) {
    let (mut w, m) = perp_world(perp_params(0));
    let maker = funded(&mut w, 1_000_000);
    let trader = funded(&mut w, 1_000_000);
    (w, m, maker, trader)
}

#[test]
fn a_seat_is_still_304_bytes_and_the_generations_sit_around_the_link() {
    assert_eq!(size_of::<Seat>(), 304);
    let mut seat = Seat::zeroed();
    seat.set_generations([1, 2, 3, 4]).unwrap();
    seat.next_free = 0xBEEF;
    let bytes = bytemuck::bytes_of(&seat);
    assert_eq!(&bytes[298..300], &[1, 2]);
    assert_eq!(&bytes[300..302], &0xBEEFu16.to_le_bytes());
    assert_eq!(&bytes[302..304], &[3, 4]);
    assert_eq!(seat.generations(), [1, 2, 3, 4]);
    assert_eq!(
        (0..5).map(|slot| seat.generation(slot)).collect::<Vec<_>>(),
        [1, 2, 3, 4, 0]
    );
}

#[test]
fn the_seat_identity_bytes_sit_where_the_byte_map_puts_them() {
    assert_eq!(core::mem::offset_of!(Seat, maker_markets), 112);
    assert_eq!(core::mem::offset_of!(Seat, generation_ext), 113);
    assert_eq!(core::mem::offset_of!(Seat, taker_markets), 120);
    assert_eq!(core::mem::offset_of!(Seat, generation_ext_top), 121);
    assert_eq!(core::mem::offset_of!(Seat, seat_epoch), 124);
    assert_eq!(core::mem::offset_of!(Seat, perp), 128);

    let mut words = [0u64; 38];
    let bytes: &mut [u8] = bytemuck::cast_slice_mut(&mut words);
    bytes[112] = 0b101;
    bytes[113..=119].copy_from_slice(&[0x11, 0x12, 0x21, 0x22, 0x31, 0x32, 0x41]);
    bytes[120] = 0b010;
    bytes[121] = 0x42;
    bytes[124..128].copy_from_slice(&0xA1B2_C3D4u32.to_le_bytes());
    bytes[298] = 0x01;
    bytes[299] = 0x02;
    bytes[300..302].copy_from_slice(&1_234u16.to_le_bytes());
    bytes[302] = 0x03;
    bytes[303] = 0x04;
    let seat: &Seat = bytemuck::from_bytes(bytes);

    assert_eq!((seat.maker_markets, seat.taker_markets), (0b101, 0b010));
    assert_eq!(seat.seat_epoch(), 0xA1B2_C3D4);
    assert_eq!(seat.next_free, 1_234);
    assert_eq!(
        seat.generations(),
        [0x12_1101, 0x22_2102, 0x32_3103, 0x42_4104]
    );
    assert!(seat.is_pinned());
}

#[test]
fn writing_a_generation_writes_only_its_own_bytes() {
    for slot in 0..SEAT_SLOTS {
        let mut seat = Seat::zeroed();
        let mut generations = [0; SEAT_SLOTS];
        generations[slot] = 0x00AB_CDEF;
        seat.set_generations(generations).unwrap();
        let touched: Vec<usize> = bytemuck::bytes_of(&seat)
            .iter()
            .enumerate()
            .filter(|(_, byte)| **byte != 0)
            .map(|(at, _)| at)
            .collect();
        let expected = [
            [298, 113, 114],
            [299, 115, 116],
            [302, 117, 118],
            [303, 119, 121],
        ][slot];
        let mut expected = expected.to_vec();
        expected.sort_unstable();
        assert_eq!(touched, expected, "slot {slot}");
        assert_eq!(seat.generation(slot), 0x00AB_CDEF);
    }
    let mut seat = Seat::zeroed();
    assert_eq!(
        seat.set_generations([GENERATION_MAX + 1, 0, 0, 0]),
        Err(EngineError::InvariantBroken)
    );
    assert_eq!(seat, Seat::zeroed());
}

#[test]
fn t1_a_taker_that_closes_its_position_bumps_the_generation() {
    let (mut w, m, maker, a) = trio();
    buy_from(&mut w, m, a, maker, MARK, 100);
    assert_eq!(generation(&w, a, m), 0);
    sell_to(&mut w, m, a, maker, 100);
    assert_eq!(w.slot(a, m).base, 0);
    assert_eq!(generation(&w, a, m), 1);
}

#[test]
fn t2_a_maker_closed_by_a_passive_fill_is_bumped_without_a_call_of_its_own() {
    let (mut w, m, maker, a) = trio();
    let taker = funded(&mut w, 1_000_000);
    buy_from(&mut w, m, a, maker, MARK, 100);
    w.place(m, a, limit(Side::Ask, MARK, 100)).unwrap();
    let outcome = w.place(m, taker, ioc(Side::Bid, MARK, 100)).unwrap();
    assert_eq!(outcome.filled, 100);
    assert_eq!(w.slot(a, m).base, 0);
    assert_eq!(generation(&w, a, m), 1);
    assert_eq!(generation(&w, taker, m), 0);
}

#[test]
fn t3_a_flip_bumps_once_and_leaves_the_seat_on_the_other_side() {
    let (mut w, m, maker, a) = trio();
    buy_from(&mut w, m, a, maker, MARK, 100);
    w.place(m, maker, limit(Side::Bid, MARK, 150)).unwrap();
    let outcome = w.place(m, a, ioc(Side::Ask, MARK, 150)).unwrap();
    assert_eq!(outcome.filled, 150);
    assert_eq!(w.slot(a, m).base, -50);
    assert_eq!(generation(&w, a, m), 1);
    assert_eq!(w.slot(maker, m).base, 50);
    assert_eq!(generation(&w, maker, m), 1);
}

#[test]
fn t4_opening_adding_and_partly_reducing_do_not_bump() {
    let (mut w, m, maker, a) = trio();
    buy_from(&mut w, m, a, maker, MARK, 100);
    assert_eq!(generation(&w, a, m), 0);
    buy_from(&mut w, m, a, maker, MARK, 50);
    assert_eq!(generation(&w, a, m), 0);
    sell_to(&mut w, m, a, maker, 30);
    assert_eq!(w.slot(a, m).base, 120);
    assert_eq!(generation(&w, a, m), 0);
}

fn weak_long(w: &mut World, m: usize, maker: u32, size: u64) -> u32 {
    let target = funded(w, 1_100 * size / 10);
    buy_from(w, m, target, maker, MARK, size);
    target
}

#[test]
fn t5_liquidation_bumps_only_when_a_position_ends_or_flips() {
    let (mut w, m, maker, _) = trio();
    let target = weak_long(&mut w, m, maker, 100);
    let liquidator = funded(&mut w, 1_000_000);
    let buyer = funded(&mut w, 1_000_000);
    buy_from(&mut w, m, buyer, liquidator, MARK, 20);
    assert_eq!(w.slot(liquidator, m).base, -20);
    w.set_price(m, 930);
    let first = w.liquidate(m, liquidator, target, 30).unwrap();
    assert_eq!(first.status, LiquidationStatus::Liquidated);
    assert!(first.liquidated > 20 && first.liquidated < 100);
    assert_eq!(
        generation(&w, target, m),
        0,
        "a partial liquidation does not bump"
    );
    assert_eq!(
        w.slot(liquidator, m).base,
        i64::try_from(first.liquidated).unwrap() - 20
    );
    assert_eq!(
        generation(&w, liquidator, m),
        1,
        "the liquidator went from short to long"
    );
    w.set_price(m, 800);
    while w.slot(target, m).base != 0 {
        let step = w.liquidate(m, liquidator, target, 1_000).unwrap();
        assert_eq!(step.status, LiquidationStatus::Liquidated);
    }
    assert_eq!(generation(&w, target, m), 1, "a closed target is bumped");
}

#[test]
fn t6_a_refused_call_leaves_every_generation_alone() {
    let (mut w, m, maker, a) = trio();
    buy_from(&mut w, m, a, maker, MARK, 100);
    let before = (w.seat(a).generations(), w.seat(maker).generations());
    assert_eq!(
        w.place(m, a, ioc(Side::Ask, 5_000_000, 100)).unwrap_err(),
        EngineError::PriceOutsideBand
    );
    let refused = w.liquidate(m, maker, a, 100).unwrap();
    assert_eq!(refused.status, LiquidationStatus::NotLiquidatable);
    assert_eq!(
        before,
        (w.seat(a).generations(), w.seat(maker).generations())
    );
}

#[test]
fn t7_generations_are_per_slot() {
    let mut w = World::new(10, 8);
    let m0 = w.add_market(perp_params(0));
    let m1 = w.add_market(perp_params(1));
    let maker = funded(&mut w, 1_000_000);
    let a = funded(&mut w, 1_000_000);
    buy_from(&mut w, m0, a, maker, MARK, 100);
    buy_from(&mut w, m1, a, maker, MARK, 100);
    sell_to(&mut w, m1, a, maker, 100);
    assert_eq!(generation(&w, a, m1), 1);
    assert_eq!(generation(&w, a, m0), 0);
}

#[test]
fn t8_a_slot_given_to_another_market_keeps_its_byte_and_a_market_can_return_in_another_slot() {
    let mut w = World::new(10, 8);
    for id in 0..5 {
        w.add_market(perp_params(id));
    }
    let maker = funded(&mut w, 10_000_000);
    let a = funded(&mut w, 1_000_000);
    for m in 0..4 {
        buy_from(&mut w, m, a, maker, MARK, 10);
    }
    assert_eq!(w.seat(a).slot_index(0), Some(0));
    sell_to(&mut w, 0, a, maker, 10);
    assert_eq!(w.seat(a).generations(), [1, 0, 0, 0]);
    buy_from(&mut w, 4, a, maker, MARK, 10);
    assert_eq!(
        w.seat(a).slot_index(4),
        Some(0),
        "slot 0 was given to market 4"
    );
    assert_eq!(w.seat(a).generation(0), 1, "and kept its byte");
    sell_to(&mut w, 1, a, maker, 10);
    buy_from(&mut w, 0, a, maker, MARK, 10);
    assert_eq!(
        w.seat(a).slot_index(0),
        Some(1),
        "market 0 came back in another slot"
    );
    assert_eq!(w.seat(a).generation(1), 1);
}

#[test]
fn t10_release_and_take_carry_the_generations_and_zero_everything_else() {
    let (mut w, m, maker, a) = trio();
    let key = w.key(a);
    buy_from(&mut w, m, a, maker, MARK, 100);
    sell_to(&mut w, m, a, maker, 100);
    let left = w.collateral(a);
    w.withdraw(a, Asset::Collateral, u64::try_from(left).unwrap())
        .unwrap();
    w.close(a).unwrap();
    let released = *w.seat(a);
    assert!(!released.is_open());
    assert_eq!(released.generations(), [1, 0, 0, 0]);
    assert_eq!(released.owner, [0; 32]);
    let again = w.open_with_key(key).unwrap();
    assert_eq!(again, a, "the free list gives the same seat back");
    assert_eq!(w.seat(again).generations(), [1, 0, 0, 0]);
    assert_eq!(w.seat(again).next_free, 0);
}

#[test]
fn t11_a_slot_keeps_counting_past_255_positions_and_never_stops() {
    let (mut w, m, maker, a) = trio();
    buy_from(&mut w, m, a, maker, MARK, 1);
    sell_to(&mut w, m, a, maker, 1);
    for ending in 1..=300u32 {
        assert_eq!(generation(&w, a, m), ending);
        buy_from(&mut w, m, a, maker, MARK, 1);
        sell_to(&mut w, m, a, maker, 1);
    }
    assert_eq!(generation(&w, a, m), 301);
    assert_eq!(w.seat(a).seat_epoch(), 0);
}

fn age(w: &mut World, seat: u32, generations: [u32; SEAT_SLOTS]) {
    w.seats[seat as usize].set_generations(generations).unwrap();
}

#[test]
fn t13_the_generation_boundary_moves_the_seat_to_its_next_epoch_and_restarts_every_slot() {
    let (mut w, m, maker, a) = trio();
    age(&mut w, a, [GENERATION_MAX - 2, 7, 8, 9]);
    buy_from(&mut w, m, a, maker, MARK, 1);
    let slot = w.seat(a).slot_index(m).unwrap();
    let mut generations = w.seat(a).generations();
    generations[slot] = GENERATION_MAX - 1;
    age(&mut w, a, generations);
    sell_to(&mut w, m, a, maker, 1);
    assert_eq!(generation(&w, a, m), GENERATION_MAX);
    assert_eq!(w.seat(a).seat_epoch(), 0, "one short of the rollover");

    buy_from(&mut w, m, a, maker, MARK, 1);
    sell_to(&mut w, m, a, maker, 1);

    assert_eq!(w.seat(a).seat_epoch(), 1);
    assert_eq!(w.seat(a).generations(), [0; SEAT_SLOTS]);
    buy_from(&mut w, m, a, maker, MARK, 1);
    sell_to(&mut w, m, a, maker, 1);
    assert_eq!(generation(&w, a, m), 1);
    assert_eq!(w.seat(a).seat_epoch(), 1);
}

#[test]
fn t14_a_rollover_with_no_epoch_left_is_refused_and_changes_nothing() {
    let (mut w, m, maker, a) = trio();
    buy_from(&mut w, m, a, maker, MARK, 1);
    let slot = w.seat(a).slot_index(m).unwrap();
    let mut generations = [1, 2, 3, 4];
    generations[slot] = GENERATION_MAX;
    age(&mut w, a, generations);
    w.seats[a as usize].seat_epoch = u32::MAX;
    w.place(m, maker, limit(Side::Bid, MARK, 1)).unwrap();

    let outcome = w.place(m, a, ioc(Side::Ask, MARK, 1)).unwrap();

    assert_eq!(outcome.status, PlaceStatus::RemainderCancelledFillCheck);
    assert_eq!(
        outcome.filled, 0,
        "the fill that would end the position is refused"
    );
    assert_eq!(w.slot(a, m).base, 1);
    assert_eq!(w.seat(a).seat_epoch(), u32::MAX);
    assert_eq!(generation(&w, a, m), GENERATION_MAX);
}

fn age_slot(w: &mut World, seat: u32, m: usize) {
    let slot = w.seat(seat).slot_index(m).unwrap();
    let mut generations = w.seat(seat).generations();
    generations[slot] = GENERATION_MAX;
    age(w, seat, generations);
}

fn assert_rolled_over(w: &World, seat: u32, epoch: u32) {
    assert_eq!(w.seat(seat).seat_epoch(), epoch);
    assert_eq!(w.seat(seat).generations(), [0; SEAT_SLOTS]);
}

#[test]
fn t13b_a_flip_at_the_generation_boundary_rolls_the_seat_over() {
    let (mut w, m, maker, a) = trio();
    buy_from(&mut w, m, a, maker, MARK, 100);
    age_slot(&mut w, a, m);
    w.place(m, maker, limit(Side::Bid, MARK, 150)).unwrap();

    let outcome = w.place(m, a, ioc(Side::Ask, MARK, 150)).unwrap();

    assert_eq!(outcome.filled, 150);
    assert_eq!(w.slot(a, m).base, -50);
    assert_rolled_over(&w, a, 1);
    assert_eq!(
        w.seat(maker).seat_epoch(),
        0,
        "the maker's slot was not aged"
    );
}

#[test]
fn t13c_a_liquidation_at_the_generation_boundary_rolls_the_target_over() {
    let (mut w, m, maker, _) = trio();
    let target = weak_long(&mut w, m, maker, 100);
    age_slot(&mut w, target, m);
    let liquidator = funded(&mut w, 1_000_000);
    w.set_price(m, 800);
    while w.slot(target, m).base != 0 {
        let step = w.liquidate(m, liquidator, target, 1_000).unwrap();
        assert_eq!(step.status, LiquidationStatus::Liquidated);
    }
    assert_rolled_over(&w, target, 1);
}

#[test]
fn t13d_a_position_that_ends_in_the_last_step_of_a_partly_filled_order_rolls_over_once() {
    let (mut w, m, maker, a) = trio();
    let (second, third) = (funded(&mut w, 1_000_000), funded(&mut w, 1_000_000));
    buy_from(&mut w, m, a, maker, MARK, 100);
    age_slot(&mut w, a, m);
    sell_to(&mut w, m, a, second, 60);
    assert_eq!(w.slot(a, m).base, 40);
    assert_eq!(
        generation(&w, a, m),
        GENERATION_MAX,
        "a partial fill is no end"
    );
    assert_eq!(w.seat(a).seat_epoch(), 0);

    w.place(m, second, limit(Side::Bid, MARK, 25)).unwrap();
    w.place(m, third, limit(Side::Bid, MARK, 15)).unwrap();
    let outcome = w.place(m, a, ioc(Side::Ask, MARK, 40)).unwrap();

    assert_eq!(outcome.filled, 40);
    assert_eq!(w.slot(a, m).base, 0);
    assert_rolled_over(&w, a, 1);
}

#[test]
fn t13e_a_maker_closed_by_a_passive_fill_at_the_generation_boundary_rolls_over() {
    let (mut w, m, maker, a) = trio();
    let taker = funded(&mut w, 1_000_000);
    buy_from(&mut w, m, a, maker, MARK, 100);
    age_slot(&mut w, a, m);
    w.place(m, a, limit(Side::Ask, MARK, 100)).unwrap();

    let outcome = w.place(m, taker, ioc(Side::Bid, MARK, 100)).unwrap();

    assert_eq!(outcome.filled, 100);
    assert_eq!(w.slot(a, m).base, 0);
    assert_rolled_over(&w, a, 1);
    assert_eq!(w.seat(taker).seat_epoch(), 0);
}

#[test]
fn t15_an_owner_key_reset_moves_the_epoch_and_the_version_and_leaves_the_generations() {
    let (mut w, m, maker, a) = trio();
    buy_from(&mut w, m, a, maker, MARK, 1);
    sell_to(&mut w, m, a, maker, 1);
    let (version, generations) = (w.seat(a).version, w.seat(a).generations());
    let key = w.key(a);

    let mut led = ledger(&mut w.header, &mut w.seats);
    reset_seat_epoch(
        &mut led,
        Trader {
            seat: a,
            owner: &key,
        },
    )
    .unwrap();

    assert_eq!(w.seat(a).seat_epoch(), 1);
    assert_eq!(w.seat(a).version, version + 1);
    assert_eq!(w.seat(a).generations(), generations);
}

#[test]
fn t16_a_key_reset_is_refused_for_a_stranger_a_reserved_seat_and_a_spent_epoch() {
    let (mut w, _, _, a) = trio();
    let stranger = [0x77; 32];
    let key = w.key(a);
    let before = w.bytes();
    let mut led = ledger(&mut w.header, &mut w.seats);
    assert_eq!(
        reset_seat_epoch(
            &mut led,
            Trader {
                seat: a,
                owner: &stranger
            }
        ),
        Err(EngineError::NotSeatOwner)
    );
    assert_eq!(
        reset_seat_epoch(
            &mut led,
            Trader {
                seat: FEE_SEAT,
                owner: &key
            }
        ),
        Err(EngineError::SeatNotOpen)
    );
    assert_eq!(w.bytes(), before);

    w.seats[a as usize].seat_epoch = u32::MAX;
    let before = w.bytes();
    let mut led = ledger(&mut w.header, &mut w.seats);
    assert_eq!(
        reset_seat_epoch(
            &mut led,
            Trader {
                seat: a,
                owner: &key
            }
        ),
        Err(EngineError::SeatEpochExhausted)
    );
    assert_eq!(w.bytes(), before);
}

#[test]
fn t17_release_and_retake_by_the_same_owner_keep_the_epoch_and_every_generation() {
    let (mut w, m, maker, a) = trio();
    buy_from(&mut w, m, a, maker, MARK, 100);
    sell_to(&mut w, m, a, maker, 100);
    age(
        &mut w,
        a,
        [0x00AB_CDEF, 0x00_0102, 0x7F_0000, GENERATION_MAX],
    );
    w.seats[a as usize].seat_epoch = 41;
    let key = w.key(a);
    let left = w.collateral(a);
    w.withdraw(a, Asset::Collateral, u64::try_from(left).unwrap())
        .unwrap();
    w.close(a).unwrap();
    assert_eq!(w.seat(a).seat_epoch(), 41);
    assert_eq!(
        w.seat(a).generations(),
        [0x00AB_CDEF, 0x00_0102, 0x7F_0000, GENERATION_MAX]
    );

    let again = w.open_with_key(key).unwrap();

    assert_eq!(again, a);
    assert_eq!(w.seat(again).seat_epoch(), 41);
    assert_eq!(
        w.seat(again).generations(),
        [0x00AB_CDEF, 0x00_0102, 0x7F_0000, GENERATION_MAX]
    );
}

#[test]
fn t18_setting_the_access_lists_never_touches_the_identity_bytes() {
    let (mut w, m, maker, a) = trio();
    buy_from(&mut w, m, a, maker, MARK, 100);
    sell_to(&mut w, m, a, maker, 100);
    age(
        &mut w,
        a,
        [0x00AB_CDEF, 0x00_0102, 0x7F_0000, GENERATION_MAX],
    );
    w.seats[a as usize].seat_epoch = 0xDEAD_BEEF;
    let identity = |w: &World| {
        let bytes = bytemuck::bytes_of(w.seat(a)).to_vec();
        [
            &bytes[113..120],
            &bytes[121..128],
            &bytes[298..300],
            &bytes[302..304],
        ]
        .concat()
    };
    let before = identity(&w);

    w.set_seat_access(
        a,
        SeatAccess {
            maker_markets: 0b1,
            taker_markets: 0b1,
            blocked: true,
        },
    )
    .unwrap();
    assert_eq!(bytemuck::bytes_of(w.seat(a))[112], 0b1);
    assert_eq!(bytemuck::bytes_of(w.seat(a))[120], 0b1);
    assert_eq!(identity(&w), before);

    w.set_seat_access(a, SeatAccess::default()).unwrap();
    assert_eq!(bytemuck::bytes_of(w.seat(a))[112], 0);
    assert_eq!(identity(&w), before);
}

#[test]
fn releasing_a_seat_whose_free_list_link_does_not_fit_changes_nothing() {
    let (mut w, m, maker, a) = trio();
    buy_from(&mut w, m, a, maker, MARK, 100);
    sell_to(&mut w, m, a, maker, 100);
    let left = w.collateral(a);
    w.withdraw(a, Asset::Collateral, u64::try_from(left).unwrap())
        .unwrap();
    w.header.free_head = u32::from(u16::MAX) + 1;
    let before = *w.seat(a);
    let key = w.key(a);
    let mut led = ledger(&mut w.header, &mut w.seats);
    let trader = Trader {
        seat: a,
        owner: &key,
    };
    assert!(close_seat(&mut led, trader).is_err());
    assert_eq!(*w.seat(a), before, "the seat is as it was");
    assert!(w.seat(a).is_open());
}

#[test]
fn t12_a_seat_written_with_a_four_byte_link_reads_the_same_with_a_two_byte_one() {
    assert!(cfg!(target_endian = "little"));
    let mut words = [0u64; 38];
    let bytes: &mut [u8] = bytemuck::cast_slice_mut(&mut words);
    bytes[300..304].copy_from_slice(&34_493u32.to_le_bytes());
    let seat: &Seat = bytemuck::from_bytes(bytes);
    assert_eq!(seat.next_free, 34_493);
    assert_eq!(seat.generations(), [0; 4]);
    assert!(u32::from(u16::MAX) >= MAX_FREE_LINK);
}

#[test]
fn t12_the_free_list_walks_the_largest_table() {
    let w = World::new(34_492, 8);
    w.check_free_list();
    assert_eq!(w.header.free_head, RESERVED_SEATS as u32 + 1);
    assert_eq!(w.seats[34_491].next_free, 0);
    assert_eq!(w.seats[34_490].next_free, 34_492);
}

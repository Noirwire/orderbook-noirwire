//! RULES 7 and 13.8a: what moving funding costs. The total bound is checked on real
//! fills between many seats with a moving mark; the marginal bound and the carry are
//! checked on the funding step itself, with the interval's totals drawn at random in
//! both regimes (depth set by the counted size, and depth set by open interest).

mod common;

use bytemuck::Zeroable;
use common::*;
use noirwire_orderbook_engine::EngineError as E;
use noirwire_orderbook_engine::*;
use proptest::prelude::*;
use proptest::test_runner::{Config, RngAlgorithm, TestRng, TestRunner};
use std::cell::Cell;

const SCALE: i128 = FUNDING_CARRY_SCALE;

fn runner(seed: u8, cases: u32) -> TestRunner {
    let config = Config {
        cases,
        failure_persistence: None,
        ..Config::default()
    };
    let rng = TestRng::from_seed(RngAlgorithm::ChaCha, &[seed; 32]);
    TestRunner::new_with_rng(config, rng)
}

/// A perp whose cap, fee and interval are drawn, with a move limit low enough that
/// RULES 12 holds for every draw.
fn market(cap: u16, fee: u16, interval: i64) -> MarketParams {
    let mut params = perp_params(0);
    params.tick = 1;
    params.funding_cap_bps = cap;
    params.taker_fee_bps = fee;
    params.funding_interval = interval;
    params.max_move_bps = 100;
    params.open_interest_cap = MAX_OPEN_INTEREST_CAP;
    assert!(params.check().is_ok(), "{params:?}");
    params
}

fn any_market() -> impl Strategy<Value = MarketParams> {
    let intervals = prop::sample::select(vec![1, 60, 600, 3_600, FUNDING_PERIOD]);
    (1u16..=100, 1u16..=100, intervals).prop_map(|(cap, fee, interval)| market(cap, fee, interval))
}

/// One interval's funding step from the given totals, applied to `start`.
fn step(
    params: &MarketParams,
    totals: (i64, u64, u64),
    mark: u64,
    start: (i64, i32),
) -> (i64, i32) {
    let (premium, size, open_interest) = totals;
    let mut params = *params;
    let mut book = BookHeader {
        market_id: params.market_id,
        last_funding_time: START - params.funding_interval,
        funding_index: start.0,
        funding_carry: start.1,
        traded_premium: premium,
        traded_size: size,
        open_interest,
        ..BookHeader::zeroed()
    };
    let price = Price {
        price: mark,
        publish_time: START,
        accepted_at: START,
    };
    let mut view = MarketMut {
        params: &mut params,
        book: &mut book,
        bids: &mut [],
        asks: &mut [],
        price: &price,
    };
    let env = Env {
        now: START,
        exchange_paused: false,
        max_steps: 32,
        markets: &[],
        hash: sha,
    };
    assert_eq!(update_funding(&mut view, &env), Ok(true));
    assert_eq!((book.traded_premium, book.traded_size), (0, 0));
    (book.funding_index, book.funding_carry)
}

fn units(state: (i64, i32)) -> i128 {
    i128::from(state.0) * SCALE + i128::from(state.1)
}

/// RULES 7 written a second time: a fill's premium against the mark it was made at.
fn premium_of(params: &MarketParams, price: u64, mark: u64, size: u64) -> i128 {
    let bound = i128::from(price) * i128::from(params.funding_cap_bps) / 10_000;
    (i128::from(price) - i128::from(mark)).clamp(-bound, bound) * i128::from(size)
}

/// RULES 1: the taker fee rounds up.
fn fee_of(params: &MarketParams, price: u64, size: u64) -> i128 {
    let scaled = i128::from(price) * i128::from(size) * i128::from(params.taker_fee_bps);
    (scaled + 9_999) / 10_000
}

fn priced(mark: u64, offset_bps: i64) -> u64 {
    (i128::from(mark) + i128::from(mark) * i128::from(offset_bps) / 10_000) as u64
}

/// (offset from the mark in bps, inside the crossing band, and size).
fn any_fills(most: usize) -> impl Strategy<Value = Vec<(i64, u64)>> {
    prop::collection::vec((-500i64..=500, 1u64..=2_000), 1..=most)
}

#[test]
fn s13_8a_on_real_fills_funding_times_open_interest_is_at_most_a_quarter_of_the_fees() {
    let fills = prop::collection::vec(
        (
            0u32..6,
            1u32..6,
            any::<bool>(),
            -500i64..=500,
            1u64..=500,
            -300i64..=300,
        ),
        1..12,
    );
    let case = (any_market(), 10_000u64..=1_000_000, fills, -300i64..=300);
    let moved = Cell::new(0usize);
    runner(7, 300)
        .run(&case, |(params, first_mark, fills, last_move)| {
            let mut w = World::new(10, 8);
            let m = w.add_market(params);
            w.set_price(m, first_mark);
            let seats: Vec<u32> = (0..6).map(|_| w.open()).collect();
            for seat in &seats {
                w.deposit(*seat, Asset::Collateral, 1 << 50).unwrap();
            }
            let mut fees = 0i128;
            for (maker, shift, maker_bids, offset, size, mark_move) in fills {
                let mark = w.markets[m].price.price;
                let price = priced(mark, offset);
                let (maker, taker) = (seats[maker as usize], seats[((maker + shift) % 6) as usize]);
                let (maker_side, taker_side) = if maker_bids {
                    (Side::Bid, Side::Ask)
                } else {
                    (Side::Ask, Side::Bid)
                };
                w.place(m, maker, limit(maker_side, price, size)).unwrap();
                let taken = w.place(m, taker, ioc(taker_side, price, size)).unwrap();
                assert_eq!(taken.filled, size);
                fees += i128::from(taken.fee_paid);
                w.set_price(m, priced(mark, mark_move));
            }
            let open_interest = i128::from(w.markets[m].book.open_interest);
            let mark = w.markets[m].price.price;
            w.now += params.funding_interval;
            w.set_price(m, priced(mark, last_move));

            assert_eq!(w.fund(m), Ok(true));

            let step = w.funding_units(m);
            moved.set(moved.get() + usize::from(step != 0));
            assert!(
                step.abs() * open_interest * 4 <= fees * SCALE,
                "step {step}/65536 per lot on {open_interest} lots, fees {fees}"
            );
            Ok(())
        })
        .unwrap();
    assert!(
        moved.get() > 100,
        "only {} cases moved funding",
        moved.get()
    );
}

#[test]
fn s13_8a_added_fills_move_funding_times_open_interest_by_at_most_their_fees_share() {
    let case = (
        any_market(),
        1_000u64..=10_000_000,
        any_fills(8),
        any_fills(4),
        1u64..=200_000,
    );
    let regimes = [Cell::new(0usize), Cell::new(0usize)];
    runner(8, 4_000)
        .run(&case, |(params, mark, honest, attack, open_interest)| {
            let totals = |fills: &[(i64, u64)]| -> (i128, u64) {
                fills
                    .iter()
                    .fold((0, 0), |(premium, size), (offset, lots)| {
                        let price = priced(mark, *offset);
                        (
                            premium + premium_of(&params, price, mark, *lots),
                            size + lots,
                        )
                    })
            };
            let (honest_premium, honest_size) = totals(&honest);
            let (attack_premium, attack_size) = totals(&attack);
            let all_premium = i64::try_from(honest_premium + attack_premium).unwrap();
            let all_size = honest_size + attack_size;
            let alone = units(step(
                &params,
                (
                    i64::try_from(honest_premium).unwrap(),
                    honest_size,
                    open_interest,
                ),
                mark,
                (0, 0),
            ));
            let joined = units(step(
                &params,
                (all_premium, all_size, open_interest),
                mark,
                (0, 0),
            ));
            let by_volume = i128::from(all_size) * i128::from(params.taker_fee_bps) * 28_800;
            let by_interest = i128::from(open_interest)
                * 4
                * i128::from(params.funding_cap_bps)
                * i128::from(params.funding_interval);
            let regime = &regimes[usize::from(by_volume > by_interest)];
            regime.set(regime.get() + 1);

            let attack_fees: i128 = attack
                .iter()
                .map(|(offset, lots)| fee_of(&params, priced(mark, *offset), *lots))
                .sum();
            let lowest_attack = attack.iter().map(|(o, _)| priced(mark, *o)).min().unwrap();
            let highest = honest
                .iter()
                .chain(&attack)
                .map(|(o, _)| priced(mark, *o))
                .max()
                .unwrap();
            let rounding = 2;
            let moved = ((joined - alone).abs() - rounding).max(0);
            assert!(
                moved * i128::from(open_interest) * 4 * i128::from(lowest_attack)
                    <= (i128::from(lowest_attack) + i128::from(highest)) * attack_fees * SCALE,
                "moved {moved}/65536 per lot on {open_interest} lots for {attack_fees} in fees"
            );
            assert!(
                alone.abs() * i128::from(open_interest) * 4
                    <= honest
                        .iter()
                        .map(|(o, lots)| fee_of(&params, priced(mark, *o), *lots))
                        .sum::<i128>()
                        * SCALE
            );
            Ok(())
        })
        .unwrap();
    let [damped, by_volume] = regimes.map(|regime| regime.get());
    assert!(
        damped > 200 && by_volume > 200,
        "{damped} damped, {by_volume} by volume"
    );
}

#[test]
fn s13_8a_the_index_and_carry_add_up_to_the_sum_of_the_steps() {
    let interval = (
        -1_000_000_000i64..=1_000_000_000,
        0u64..=1_000_000,
        0u64..=1_000_000,
        1u64..=10_000_000,
    );
    let case = (any_market(), prop::collection::vec(interval, 1..40));
    runner(9, 2_000)
        .run(&case, |(params, intervals)| {
            let mut state = (0, 0);
            let mut sum = 0i128;
            for (premium, size, open_interest, mark) in intervals {
                let totals = (premium, size, open_interest);
                sum += units(step(&params, totals, mark, (0, 0)));
                state = step(&params, totals, mark, state);
                assert!(i128::from(state.1).abs() < SCALE);
                assert_eq!(units(state), sum);
            }
            Ok(())
        })
        .unwrap();
}

#[test]
fn s12_perp_funding_settings_outside_the_rules_are_refused() {
    let base = market(50, 30, 3_600);

    let mut free = base;
    free.taker_fee_bps = 0;
    assert_eq!(free.check(), Err(E::InvalidMarketParams));
    free.funding_cap_bps = 0;
    assert!(free.check().is_ok());

    let mut long_interval = base;
    long_interval.funding_interval = FUNDING_PERIOD + 1;
    assert_eq!(long_interval.check(), Err(E::InvalidMarketParams));
    long_interval.funding_interval = FUNDING_PERIOD;
    assert!(long_interval.check().is_ok());

    let mut tight = perp_params(0);
    tight.max_move_bps = 399;
    tight.funding_cap_bps = 7;
    tight.funding_interval = 3_600;
    assert!(
        tight.check().is_ok(),
        "7 * 3600 + 399 * 28800 < 400 * 28800"
    );
    tight.funding_cap_bps = 8;
    assert_eq!(
        tight.check(),
        Err(E::InvalidMarketParams),
        "8 * 3600 = 28800"
    );

    let mut spot = spot_params(0);
    spot.max_move_bps = 399;
    spot.funding_cap_bps = 8;
    spot.taker_fee_bps = 0;
    assert!(
        spot.check().is_ok(),
        "funding settings mean nothing on spot"
    );
}

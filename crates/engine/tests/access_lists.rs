//! RULES 3a, the access lists: each perp market's maker and taker switches, each
//! seat's per-market maker and taker lists and its block flag. Every call goes through
//! `World`, which asserts RULES 13 after it, including 9c (reserved seats are never
//! listed), 9d (no barred maker fills and no barred order rests) and 9e (no barred
//! taker fills, and the lists never refuse an exit).

mod common;

use common::*;
use noirwire_orderbook_engine::EngineError as E;
use noirwire_orderbook_engine::*;

const COLLATERAL: u64 = 1_000_000;
const ALL_PERPS: u8 = 0b11;

fn access(maker_markets: u8, taker_markets: u8, blocked: bool) -> SeatAccess {
    SeatAccess {
        maker_markets,
        taker_markets,
        blocked,
    }
}

/// Every resting order of `seat` on market `m`, bids then asks.
fn orders_of(w: &World, m: usize, seat: u32) -> Vec<Order> {
    let state = &w.markets[m];
    let mut orders = state.resting(Side::Bid);
    orders.extend(state.resting(Side::Ask));
    orders.retain(|order| order.seat == seat);
    orders
}

/// The world with every seat's version and access bytes set to zero, so two worlds
/// that differ only in who was listed, and how often, compare equal.
fn without_access(w: &World) -> Vec<u8> {
    let mut plain = w.clone();
    for seat in &mut plain.seats {
        seat.version = 0;
        seat.maker_markets = 0;
        seat.taker_markets = 0;
        seat.blocked = 0;
    }
    for state in &mut plain.markets {
        state.params.access = 0;
    }
    plain.bytes()
}

#[test]
fn the_new_codes_are_stable_and_the_layout_uses_the_old_padding() {
    assert_eq!(E::SeatBlocked.code(), 90);
    assert_eq!(E::MakerNotListed.code(), 91);
    assert_eq!(E::TakerNotListed.code(), 92);
    assert_eq!(ACCESS_MAKERS_LISTED, 1);
    assert_eq!(ACCESS_TAKERS_LISTED, 2);
    assert_eq!(core::mem::offset_of!(Seat, status), 440);
    assert_eq!(core::mem::offset_of!(Seat, maker_markets), 441);
    assert_eq!(core::mem::offset_of!(Seat, taker_markets), 442);
    assert_eq!(core::mem::offset_of!(Seat, blocked), 443);
    assert_eq!(core::mem::size_of::<Seat>(), 448);
    assert_eq!(core::mem::offset_of!(MarketParams, oracle_health), 117);
    assert_eq!(core::mem::offset_of!(MarketParams, access), 118);
    assert_eq!(core::mem::size_of::<MarketParams>(), 120);
}

/// Two worlds, one never touched by the lists and one where every trader seat is
/// listed on everything and both switches are on, run the same history of orders,
/// cancels, deposits and withdrawals and give the same results and the same state.
/// A third, with the switches off and every seat given arbitrary lists, does too.
#[test]
fn all_zero_access_and_everyone_listed_behave_exactly_as_before() {
    let build = || {
        let mut w = World::new(8, 8);
        w.max_steps = 4;
        w.add_market(spot_params(0));
        w.add_market(perp_params(1));
        w.deposit(INSURANCE_SEAT, Asset::Collateral, 500).unwrap();
        for _ in 0..5 {
            let trader = w.open();
            w.deposit(trader, Asset::Collateral, 50_000).unwrap();
            w.deposit(trader, Asset::Spot(QUOTE), 500_000).unwrap();
            w.deposit(trader, Asset::Spot(BASE), 50_000).unwrap();
        }
        w
    };
    let mut untouched = build();
    let mut listed = build();
    let mut arbitrary = build();
    for seat in 2..7 {
        listed
            .set_seat_access(seat, access(0b10, 0b10, false))
            .unwrap();
        let bits = (seat as u8 * 37) & 0b10;
        arbitrary
            .set_seat_access(seat, access(bits, bits ^ 0b10, false))
            .unwrap();
    }
    listed.set_market_access(1, true, true).unwrap();

    let mut state = 0x2545_f491_4f6c_dd1du64;
    let mut next = |bound: u64| {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state % bound
    };
    for _ in 0..3_000 {
        let market = next(2) as usize;
        let seat = 2 + next(5) as u32;
        let pick = next(10);
        let side = if next(2) == 0 { Side::Bid } else { Side::Ask };
        let order_type = [
            OrderType::Limit,
            OrderType::PostOnly,
            OrderType::ImmediateOrCancel,
            OrderType::Market,
        ][next(4) as usize];
        let mut new_order = order(side, order_type, MARK - 30 + 10 * next(7), 1 + next(6));
        new_order.reduce_only = market == 1 && next(6) == 0;
        let amount = next(300);
        let mut results = Vec::new();
        for w in [&mut untouched, &mut listed, &mut arbitrary] {
            let result = match pick {
                0..=6 => format!("{:?}", w.place(market, seat, new_order)),
                7 => format!("{:?}", w.cancel_all(market, seat, 2)),
                8 => format!("{:?}", w.withdraw(seat, Asset::Collateral, amount)),
                _ => format!("{:?}", w.deposit(seat, Asset::Collateral, amount)),
            };
            results.push(result);
        }
        assert_eq!(results[0], results[1], "listed on everything");
        assert_eq!(results[0], results[2], "lists set with the switches off");
    }
    assert_eq!(without_access(&untouched), without_access(&listed));
    assert_eq!(without_access(&untouched), without_access(&arbitrary));
    let resting = untouched.markets[1].book.bid_count + untouched.markets[1].book.ask_count;
    assert!(resting > 0, "the history left orders on the book");
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum SeatState {
    Listed,
    Unlisted,
    Blocked,
}

/// RULES 3a, the table: what a seat may send under each pair of switches. The order
/// is an ask from a seat that is long, so reduce-only is meaningful.
#[test]
fn the_switches_and_the_seat_lists_give_exactly_the_table() {
    let types = [
        OrderType::Limit,
        OrderType::PostOnly,
        OrderType::ImmediateOrCancel,
        OrderType::Market,
    ];
    let mut cases = 0;
    for makers_on in [false, true] {
        for takers_on in [false, true] {
            for state in [SeatState::Listed, SeatState::Unlisted, SeatState::Blocked] {
                for order_type in types {
                    for reduce in [false, true] {
                        if reduce && order_type == OrderType::PostOnly {
                            continue;
                        }
                        let (mut w, m) = perp_world(perp_params(0));
                        let maker = funded(&mut w, COLLATERAL);
                        let seat = funded(&mut w, COLLATERAL);
                        buy_from(&mut w, m, seat, maker, MARK, 5);
                        match state {
                            SeatState::Listed => {
                                w.set_seat_access(seat, access(1, 1, false)).unwrap();
                            }
                            SeatState::Unlisted => {}
                            SeatState::Blocked => {
                                w.set_seat_access(seat, access(1, 1, true)).unwrap();
                            }
                        }
                        w.set_market_access(m, makers_on, takers_on).unwrap();

                        let rests = matches!(order_type, OrderType::Limit | OrderType::PostOnly);
                        let takes = order_type != OrderType::PostOnly;
                        let expected = if reduce {
                            None
                        } else if state == SeatState::Blocked {
                            Some(E::SeatBlocked)
                        } else if rests && makers_on && state == SeatState::Unlisted {
                            Some(E::MakerNotListed)
                        } else if takes && takers_on && state == SeatState::Unlisted {
                            Some(E::TakerNotListed)
                        } else {
                            None
                        };
                        let mut new_order = order(Side::Ask, order_type, MARK, 2);
                        new_order.reduce_only = reduce;
                        let before = w.bytes();
                        let result = w.place(m, seat, new_order);
                        let what = format!("{state:?} {order_type:?} reduce {reduce} switches {makers_on} {takers_on}");
                        match expected {
                            Some(error) => {
                                assert_eq!(result, Err(error), "{what}");
                                assert!(w.bytes() == before, "{what}: a refusal changed state");
                            }
                            None => assert!(result.is_ok(), "{what}: {result:?}"),
                        }
                        cases += 1;
                    }
                }
            }
        }
    }
    assert_eq!(cases, 2 * 2 * 3 * 7);
}

/// RULES 3: an access refusal reads the switches, the order's own type and flag and
/// the sender's seat, never the book, so the same order gets the same error on an
/// empty book, a book it would cross and a full one. An unlisted seat cannot use a
/// post-only order to find the best price.
#[test]
fn an_access_refusal_is_the_same_whatever_the_book_holds() {
    let book = |fill: usize| {
        let (mut w, m) = perp_world(perp_params(0));
        let unlisted = funded(&mut w, COLLATERAL);
        let blocked = funded(&mut w, COLLATERAL);
        for _ in 0..2 * fill {
            let maker = funded(&mut w, COLLATERAL);
            w.set_seat_access(maker, access(1, 1, false)).unwrap();
            for level in 0..2 {
                w.place(m, maker, limit(Side::Bid, MARK - 10 * level, 1))
                    .unwrap();
                w.place(m, maker, limit(Side::Ask, MARK + 10 + 10 * level, 1))
                    .unwrap();
            }
        }
        w.set_seat_access(blocked, access(1, 1, true)).unwrap();
        w.set_market_access(m, true, true).unwrap();
        (w, m, unlisted, blocked)
    };
    let probes = [
        (false, post_only(Side::Ask, MARK, 1), E::MakerNotListed),
        (false, limit(Side::Ask, MARK, 1), E::MakerNotListed),
        (false, ioc(Side::Ask, MARK, 1), E::TakerNotListed),
        (false, market(Side::Bid, MARK + 40, 1), E::TakerNotListed),
        (true, post_only(Side::Bid, MARK + 10, 1), E::SeatBlocked),
        (true, ioc(Side::Bid, MARK + 40, 1), E::SeatBlocked),
    ];
    for (from_blocked, new_order, expected) in probes {
        let mut seen = Vec::new();
        for fill in [0usize, 1, 2] {
            let (mut w, m, unlisted, blocked) = book(fill);
            if fill == 2 {
                assert_eq!(w.markets[m].book.bid_count, 8, "the bid side is full");
                assert_eq!(w.markets[m].book.ask_count, 8, "the ask side is full");
            }
            let seat = if from_blocked { blocked } else { unlisted };
            let before = w.bytes();
            seen.push(w.place(m, seat, new_order));
            assert!(w.bytes() == before);
        }
        assert_eq!(seen, vec![Err(expected); 3], "{new_order:?}");
    }
}

#[test]
fn the_lists_come_after_the_public_checks_and_before_the_orders_own_numbers() {
    let blocked_world = || {
        let (mut w, m) = perp_world(perp_params(0));
        let seat = funded(&mut w, COLLATERAL);
        w.set_seat_access(seat, access(1, 1, true)).unwrap();
        (w, m, seat)
    };

    let (mut w, m, seat) = blocked_world();
    w.paused = true;
    assert_eq!(
        w.place(m, seat, limit(Side::Bid, MARK, 1)),
        Err(E::ExchangePaused)
    );

    let (mut w, m, seat) = blocked_world();
    w.markets[m].params.status = STATUS_PAUSED;
    assert_eq!(
        w.place(m, seat, limit(Side::Bid, MARK, 1)),
        Err(E::MarketPaused)
    );

    let (mut w, m, seat) = blocked_world();
    w.markets[m].params.status = STATUS_REDUCE_ONLY;
    assert_eq!(
        w.place(m, seat, limit(Side::Bid, MARK, 1)),
        Err(E::MarketReduceOnly)
    );

    let (mut w, m, seat) = blocked_world();
    w.quote_ok = false;
    assert_eq!(
        w.place(m, seat, limit(Side::Bid, MARK, 1)),
        Err(E::QuoteGuardTripped)
    );

    let (mut w, m, seat) = blocked_world();
    assert_eq!(
        w.place(m, seat, limit(Side::Bid, MARK + 1, 1)),
        Err(E::SeatBlocked),
        "off the tick"
    );
    assert_eq!(
        w.place(m, seat, limit(Side::Bid, MARK, 0)),
        Err(E::SeatBlocked),
        "size zero"
    );
    w.now += 1_000;
    assert_eq!(
        w.place(m, seat, limit(Side::Bid, MARK, 1)),
        Err(E::SeatBlocked),
        "a stale price"
    );
}

#[test]
fn the_lists_are_per_market_and_a_switch_takes_effect_on_the_next_order() {
    let mut w = World::new(10, 8);
    let first = w.add_market(perp_params(0));
    let second = w.add_market(perp_params(1));
    let seat = funded(&mut w, COLLATERAL);
    w.set_seat_access(seat, access(0b01, 0b01, false)).unwrap();
    w.set_market_access(first, true, true).unwrap();
    w.set_market_access(second, true, true).unwrap();

    let rested = w.place(first, seat, limit(Side::Bid, MARK, 1)).unwrap();
    assert_eq!(rested.status, PlaceStatus::Rested);
    assert_eq!(
        w.place(second, seat, limit(Side::Bid, MARK, 1)),
        Err(E::MakerNotListed)
    );
    assert_eq!(
        w.place(second, seat, ioc(Side::Bid, MARK, 1)),
        Err(E::TakerNotListed)
    );

    w.set_market_access(second, false, true).unwrap();
    assert_eq!(
        w.place(second, seat, post_only(Side::Bid, MARK, 1))
            .unwrap()
            .status,
        PlaceStatus::Rested
    );
    assert_eq!(
        w.place(second, seat, limit(Side::Bid, MARK, 1)),
        Err(E::TakerNotListed),
        "a limit order needs both"
    );
    w.set_market_access(second, false, false).unwrap();
    assert!(w.place(second, seat, limit(Side::Bid, MARK, 1)).is_ok());
}

/// RULES 3a and 4: a resting order whose owner may no longer make is cancelled when
/// matching reaches it, as an expired one is. Here the maker list is switched on over
/// a live book with an unlisted maker on it.
#[test]
fn a_list_switched_on_over_a_live_book_cancels_the_unlisted_order_when_matching_reaches_it() {
    let (mut w, m) = perp_world(perp_params(0));
    let unlisted = funded(&mut w, COLLATERAL);
    let listed = funded(&mut w, COLLATERAL);
    let taker = funded(&mut w, COLLATERAL);
    w.set_seat_access(listed, access(1, 0, false)).unwrap();
    w.place(m, unlisted, limit(Side::Ask, MARK, 3)).unwrap();
    w.place(m, listed, limit(Side::Ask, MARK + 10, 3)).unwrap();
    w.set_market_access(m, true, false).unwrap();
    assert_eq!(w.slot(unlisted, m).open_ask_lots, 3, "nothing is swept");
    let open_interest = w.markets[m].book.open_interest;

    w.max_steps = 1;
    let truncated = w.place(m, taker, ioc(Side::Bid, MARK + 10, 3)).unwrap();
    assert_eq!(truncated.status, PlaceStatus::RemainderCancelledStepLimit);
    assert_eq!(truncated.filled, 0, "the dead order took the one step");
    assert!(w.fills.as_slice().is_empty());
    assert!(orders_of(&w, m, unlisted).is_empty());
    assert_eq!(w.seat(unlisted).open_orders[m], 0);
    assert_eq!(w.slot(unlisted, m).open_ask_lots, 0);
    assert_eq!(w.markets[m].book.open_interest, open_interest);

    w.max_steps = 8;
    let filled = w.place(m, taker, ioc(Side::Bid, MARK + 10, 3)).unwrap();
    assert_eq!(filled.filled, 3);
    assert!(w
        .fills
        .as_slice()
        .iter()
        .all(|fill| fill.maker_seat == listed));
}

#[test]
fn a_blocked_makers_orders_are_cancelled_when_matching_reaches_them_on_perp_and_spot() {
    let (mut w, m) = perp_world(perp_params(0));
    let maker = funded(&mut w, COLLATERAL);
    let taker = funded(&mut w, COLLATERAL);
    w.place(m, maker, limit(Side::Ask, MARK, 3)).unwrap();
    w.place(m, maker, limit(Side::Bid, MARK - 20, 2)).unwrap();
    w.set_seat_access(maker, access(0, 0, true)).unwrap();
    assert_eq!(orders_of(&w, m, maker).len(), 2, "a block cancels nothing");
    let open_interest = w.markets[m].book.open_interest;
    let outcome = w.place(m, taker, ioc(Side::Bid, MARK, 3)).unwrap();
    assert_eq!(sizes(&outcome), (0, 0, 3));
    assert_eq!(w.slot(maker, m).open_ask_lots, 0);
    assert_eq!(
        w.slot(maker, m).open_bid_lots,
        2,
        "an order not reached stays"
    );
    assert_eq!(w.seat(maker).open_orders[m], 1);
    assert_eq!(w.markets[m].book.open_interest, open_interest);

    let mut w = World::new(10, 8);
    let s = w.add_market(spot_params(0));
    let maker = w.open();
    let taker = w.open();
    w.deposit(maker, Asset::Spot(BASE), 1_000).unwrap();
    w.deposit(taker, Asset::Spot(QUOTE), 100_000).unwrap();
    w.place(s, maker, limit(Side::Ask, MARK, 4)).unwrap();
    assert_eq!(w.spot(maker, BASE).locked, 400);
    w.set_seat_access(maker, access(0, 0, true)).unwrap();
    let outcome = w.place(s, taker, ioc(Side::Bid, MARK, 4)).unwrap();
    assert_eq!(outcome.filled, 0);
    assert_eq!(
        w.spot(maker, BASE),
        TokenBalance {
            available: 1_000,
            locked: 0
        }
    );
    assert_eq!(w.seat(maker).open_orders[s], 0);
}

/// RULES 4: each dead order counts one step, so 16 of them in front of a live one
/// end a 16-step order with nothing filled.
#[test]
fn sixteen_dead_orders_end_an_order_at_the_step_limit() {
    let mut params = perp_params(0);
    params.max_open_orders = 16;
    let mut w = World::new(10, 20);
    let m = w.add_market(params);
    w.max_steps = 16;
    let unlisted = funded(&mut w, COLLATERAL);
    let listed = funded(&mut w, COLLATERAL);
    let taker = funded(&mut w, COLLATERAL);
    w.set_seat_access(listed, access(1, 0, false)).unwrap();
    for _ in 0..16 {
        w.place(m, unlisted, limit(Side::Ask, MARK, 1)).unwrap();
    }
    w.place(m, listed, limit(Side::Ask, MARK, 1)).unwrap();
    w.set_market_access(m, true, false).unwrap();

    let outcome = w.place(m, taker, ioc(Side::Bid, MARK, 1)).unwrap();
    assert_eq!(outcome.status, PlaceStatus::RemainderCancelledStepLimit);
    assert!(outcome.truncated);
    assert_eq!(outcome.filled, 0);
    assert_eq!(w.seat(unlisted).open_orders[m], 0);
    assert_eq!(orders_of(&w, m, listed).len(), 1);
}

/// Clearing a seat's maker bit cancels its resting orders on that market in the same
/// call, both sides, so a relisting never brings an old quote back. Its orders on
/// other markets stay, and nothing is filled.
#[test]
fn clearing_a_maker_bit_cancels_the_seats_orders_on_that_market_at_once() {
    let mut w = World::new(10, 8);
    let first = w.add_market(perp_params(0));
    let second = w.add_market(perp_params(1));
    let maker = funded(&mut w, COLLATERAL);
    let other = funded(&mut w, COLLATERAL);
    w.set_seat_access(maker, access(ALL_PERPS, 0, false))
        .unwrap();
    w.set_seat_access(other, access(ALL_PERPS, 0, false))
        .unwrap();
    w.set_market_access(first, true, false).unwrap();
    w.place(first, other, limit(Side::Ask, MARK + 10, 2))
        .unwrap();
    w.place(first, maker, limit(Side::Bid, MARK - 10, 2))
        .unwrap();
    w.place(first, maker, limit(Side::Ask, MARK + 20, 3))
        .unwrap();
    w.place(first, other, limit(Side::Bid, MARK - 20, 1))
        .unwrap();
    w.place(second, maker, limit(Side::Ask, MARK + 10, 4))
        .unwrap();
    let version = w.seat(maker).version;
    let open_interest = w.markets[first].book.open_interest;
    let next_fill = w.markets[first].book.next_fill_seq;

    let seat = w.set_seat_access(maker, access(0b10, 0, false)).unwrap();
    assert_eq!(seat, maker);
    assert!(orders_of(&w, first, maker).is_empty());
    assert_eq!(w.seat(maker).open_orders, [0, 1, 0, 0, 0, 0, 0, 0]);
    let slot = w.slot(maker, first);
    assert_eq!((slot.open_bid_lots, slot.open_ask_lots), (0, 0));
    assert_eq!(
        orders_of(&w, first, other).len(),
        2,
        "another seat's orders stay"
    );
    assert_eq!(
        orders_of(&w, second, maker).len(),
        1,
        "another market's stay"
    );
    assert_eq!(
        w.seat(maker).version,
        version + 1,
        "one version for the whole call"
    );
    assert_eq!(w.markets[first].book.open_interest, open_interest);
    assert_eq!(w.markets[first].book.next_fill_seq, next_fill, "no fill");

    w.set_seat_access(maker, access(ALL_PERPS, 0, false))
        .unwrap();
    assert!(orders_of(&w, first, maker).is_empty(), "nothing comes back");
}

/// The cancellation follows the maker bit, not the switch: clearing it cancels with
/// the list off too. Setting a bit, changing the taker list or blocking cancels
/// nothing.
#[test]
fn only_clearing_a_maker_bit_cancels_and_it_does_so_with_the_list_off() {
    let mut w = World::new(10, 8);
    let first = w.add_market(perp_params(0));
    let second = w.add_market(perp_params(1));
    let maker = funded(&mut w, COLLATERAL);
    w.place(first, maker, limit(Side::Bid, MARK - 10, 2))
        .unwrap();
    for setting in [
        access(0b01, 0, false),
        access(0b11, 0b11, false),
        access(0b11, 0, false),
        access(0b11, 0, true),
        access(0b11, 0b01, false),
        access(0b01, 0b01, false),
    ] {
        w.set_seat_access(maker, setting).unwrap();
        assert_eq!(orders_of(&w, first, maker).len(), 1, "{setting:?}");
    }
    assert_eq!(w.markets[first].params.access, 0, "the list is off");
    w.set_seat_access(maker, access(0, 0b01, false)).unwrap();
    assert!(orders_of(&w, first, maker).is_empty());
    assert_eq!(w.markets[second].book.bid_count, 0);
}

#[test]
fn a_cleared_maker_bit_whose_book_is_missing_is_refused_and_changes_nothing() {
    let (mut w, m) = perp_world(perp_params(0));
    let maker = funded(&mut w, COLLATERAL);
    w.set_seat_access(maker, access(1, 0, false)).unwrap();
    w.place(m, maker, limit(Side::Bid, MARK, 1)).unwrap();
    let key = w.key(maker);
    let before = w.bytes();
    let refused = {
        let mut ledger = ledger(&mut w.header, &mut w.seats);
        set_seat_access(&mut ledger, &mut [], &key, access(0, 0, false))
    };
    assert_eq!(refused, Err(E::MarketDataMissing));
    assert!(w.bytes() == before);
    let kept = {
        let mut ledger = ledger(&mut w.header, &mut w.seats);
        set_seat_access(&mut ledger, &mut [], &key, access(1, 0, true))
    };
    assert_eq!(kept, Ok(maker), "no maker bit cleared, no book needed");
}

/// The engine takes a book's market from inside it, so the program checks each book
/// account against its header first. Without that check, a book that says market 1
/// but holds market 0's orders, and so not the seat's order on market 1, is refused
/// here and changes nothing, rather than leaving that order on market 1 behind a
/// cleared maker bit.
#[test]
fn a_book_under_another_markets_id_is_refused_and_changes_nothing() {
    let mut w = World::new(10, 8);
    let first = w.add_market(perp_params(0));
    let second = w.add_market(perp_params(1));
    let maker = funded(&mut w, COLLATERAL);
    let other = funded(&mut w, COLLATERAL);
    w.set_seat_access(maker, access(ALL_PERPS, 0, false))
        .unwrap();
    w.place(first, other, limit(Side::Bid, MARK - 10, 2))
        .unwrap();
    w.place(second, maker, limit(Side::Bid, MARK - 10, 2))
        .unwrap();
    let key = w.key(maker);
    let before = w.bytes();
    let mut forged = w.markets[first].clone();
    forged.book.market_id = 1;
    let refused = {
        let mut ledger = ledger(&mut w.header, &mut w.seats);
        let mut books = [PerpBook {
            book: &mut forged.book,
            bids: &mut forged.bids,
            asks: &mut forged.asks,
        }];
        set_seat_access(&mut ledger, &mut books, &key, access(0b01, 0, false))
    };
    assert_eq!(refused, Err(E::InvariantBroken));
    assert!(w.bytes() == before);
    assert_eq!(
        forged.bids, w.markets[first].bids,
        "the forged book is untouched"
    );
    assert_eq!(orders_of(&w, second, maker).len(), 1);
}

/// RULES 3a: only clearing a maker bit removes a seat's quotes. A block, or a maker
/// list switched on over a live book, leaves an order on the book that cannot fill
/// while its owner may not make there; nothing removes it until matching reaches it.
/// If its owner may make again first, it fills. These are the three ways back.
#[derive(Clone, Copy, Debug)]
enum Revival {
    /// The seat is blocked, then unblocked with its bits unchanged.
    Unblocked,
    /// The maker list is switched on over the seat's order, then off again.
    ListSwitchedOff,
    /// The maker list is switched on over the order of a seat that was never
    /// listed, and the seat is then listed.
    SeatListed,
}

#[test]
fn an_order_its_owner_could_not_make_with_fills_once_the_owner_may_make_again() {
    for revival in [
        Revival::Unblocked,
        Revival::ListSwitchedOff,
        Revival::SeatListed,
    ] {
        let (mut w, m) = perp_world(perp_params(0));
        let maker = funded(&mut w, COLLATERAL);
        let retail = funded(&mut w, COLLATERAL);
        if let Revival::Unblocked = revival {
            w.set_seat_access(maker, access(1, 1, false)).unwrap();
            w.set_market_access(m, true, false).unwrap();
        }
        let rested = w.place(m, maker, limit(Side::Ask, MARK, 3)).unwrap();
        assert_eq!(rested.status, PlaceStatus::Rested, "{revival:?}");

        match revival {
            Revival::Unblocked => {
                w.set_seat_access(maker, access(1, 1, true)).unwrap();
            }
            Revival::ListSwitchedOff | Revival::SeatListed => {
                w.set_market_access(m, true, false).unwrap();
            }
        }
        assert!(
            !w.seat(maker).may_make(&w.markets[m].params),
            "{revival:?}: the order is dormant"
        );
        assert_eq!(
            orders_of(&w, m, maker).len(),
            1,
            "{revival:?}: still resting"
        );

        match revival {
            Revival::Unblocked => {
                w.set_seat_access(maker, access(1, 1, false)).unwrap();
            }
            Revival::ListSwitchedOff => w.set_market_access(m, false, false).unwrap(),
            Revival::SeatListed => {
                w.set_seat_access(maker, access(1, 0, false)).unwrap();
            }
        }
        let outcome = w.place(m, retail, ioc(Side::Bid, MARK, 3)).unwrap();
        assert_eq!(outcome.filled, 3, "{revival:?}: the old quote filled");
        assert!(
            w.fills
                .as_slice()
                .iter()
                .all(|fill| fill.maker_seat == maker),
            "{revival:?}"
        );
        assert_eq!(w.slot(maker, m).base, -3, "{revival:?}");
    }
}

/// RULES 3a: a blocked seat can still cancel, reduce, move funds, deposit, sync and
/// close. Deposits into it from anyone work.
#[test]
fn a_blocked_seat_keeps_every_exit() {
    let mut w = World::new(10, 8);
    let s = w.add_market(spot_params(0));
    let m = w.add_market(perp_params(1));
    let maker = funded(&mut w, COLLATERAL);
    let seat = funded(&mut w, COLLATERAL);
    w.deposit(seat, Asset::Spot(BASE), 1_000).unwrap();
    w.deposit(seat, Asset::Spot(QUOTE), 1_000).unwrap();
    buy_from(&mut w, m, seat, maker, MARK, 5);
    let perp_bid = seq(&w.place(m, seat, limit(Side::Bid, MARK - 20, 1)).unwrap());
    w.place(m, seat, limit(Side::Bid, MARK - 30, 1)).unwrap();
    w.place(s, seat, limit(Side::Ask, MARK, 2)).unwrap();
    w.set_seat_access(seat, access(0b10, 0b10, true)).unwrap();
    w.set_market_access(m, true, true).unwrap();

    assert_eq!(
        w.place(s, seat, ioc(Side::Bid, MARK, 1)),
        Err(E::SeatBlocked)
    );
    assert_eq!(
        w.place(s, seat, reduce_only(ioc(Side::Ask, MARK, 1))),
        Err(E::InvalidOrderFlags),
        "spot has no reduce-only order"
    );
    assert_eq!(
        w.place(m, maker, limit(Side::Bid, MARK, 5)),
        Err(E::MakerNotListed)
    );
    w.set_seat_access(maker, access(0b10, 0b10, false)).unwrap();
    w.place(m, maker, limit(Side::Bid, MARK, 5)).unwrap();
    let reduced = w
        .place(m, seat, reduce_only(ioc(Side::Ask, MARK, 2)))
        .unwrap();
    assert_eq!(reduced.filled, 2);
    assert_eq!(w.slot(seat, m).base, 3);

    w.cancel(m, seat, perp_bid).unwrap();
    assert_eq!(w.cancel_all(m, seat, 4).unwrap(), 1);
    assert_eq!(w.cancel_all(s, seat, 4).unwrap(), 1);
    w.withdraw(seat, Asset::Collateral, 1_000).unwrap();
    w.withdraw(seat, Asset::Spot(BASE), 1_000).unwrap();
    w.withdraw(seat, Asset::Collateral, 500).unwrap();
    w.deposit(seat, Asset::Spot(QUOTE), 500).unwrap();
    let snapshot = w.snapshot_as(m, seat, w.key(seat)).unwrap();
    assert_eq!(snapshot.seat.blocked, 1, "the owner sees its own flag");
    assert_eq!(snapshot.seat.maker_markets, 0b10);
    w.deposit(seat, Asset::Collateral, 77).unwrap();

    let empty = w.open();
    w.deposit(empty, Asset::Collateral, 100).unwrap();
    w.set_seat_access(empty, access(0, 0, true)).unwrap();
    w.withdraw(empty, Asset::Collateral, 100).unwrap();
    w.close(empty).unwrap();
}

/// A seat long 10 lots from 1,000 with 1,070 of collateral left, below maintenance
/// once the mark is 930.
fn liquidatable(w: &mut World, m: usize, maker: u32) -> u32 {
    let target = funded(w, 1_100);
    buy_from(w, m, target, maker, MARK, 10);
    target
}

/// RULES 8: a blocked liquidator is refused before the target is looked at, so the
/// error is the same whatever the target is, and nothing changes.
#[test]
fn a_blocked_liquidator_gets_the_same_error_whatever_the_target() {
    let (mut w, m) = perp_world(perp_params(0));
    let maker = funded(&mut w, COLLATERAL);
    let healthy = funded(&mut w, COLLATERAL);
    buy_from(&mut w, m, healthy, maker, MARK, 1);
    let target = liquidatable(&mut w, m, maker);
    let liquidator = funded(&mut w, COLLATERAL);
    w.set_seat_access(liquidator, access(1, 1, true)).unwrap();
    w.set_price(m, 930);
    assert!(w.is_liquidatable(target, m));
    let never_opened = 9;
    for victim in [never_opened, healthy, target, maker] {
        let before = w.bytes();
        assert_eq!(
            w.liquidate(m, liquidator, victim, 10),
            Err(E::SeatBlocked),
            "target {victim}"
        );
        assert!(w.bytes() == before);
    }
}

/// RULES 8: the lists play no other part in a liquidation. An unlisted seat
/// liquidates with both lists on, and the target's own lists change nothing about
/// the outcome.
#[test]
fn an_unlisted_seat_liquidates_and_the_targets_lists_change_nothing() {
    let (mut w, m) = perp_world(perp_params(0));
    let maker = funded(&mut w, COLLATERAL);
    let target = liquidatable(&mut w, m, maker);
    let liquidator = funded(&mut w, COLLATERAL);
    w.set_market_access(m, true, true).unwrap();
    w.set_price(m, 930);

    let mut outcomes = Vec::new();
    let mut states = Vec::new();
    for setting in [
        access(0, 0, false),
        access(1, 0, false),
        access(0, 1, false),
        access(1, 1, false),
        access(0, 0, true),
        access(1, 1, true),
    ] {
        let mut copy = w.clone();
        if setting != SeatAccess::default() {
            copy.set_seat_access(target, setting).unwrap();
        }
        let outcome = copy.liquidate(m, liquidator, target, 10).unwrap();
        assert_eq!(outcome.status, LiquidationStatus::Liquidated);
        outcomes.push(outcome);
        states.push(without_access(&copy));
    }
    assert!(outcomes.windows(2).all(|pair| pair[0] == pair[1]));
    assert!(states.windows(2).all(|pair| pair[0] == pair[1]));
}

#[test]
fn set_seat_access_finds_only_open_trader_seats_and_bumps_the_version_once() {
    let (mut w, m) = perp_world(perp_params(0));
    let seat = funded(&mut w, COLLATERAL);
    assert_eq!(
        w.set_seat_access_of([0xAB; 32], access(1, 1, false)),
        Err(E::SeatNotOpen)
    );
    for reserved in [FEE_SEAT, INSURANCE_SEAT] {
        assert_eq!(
            w.set_seat_access_of(w.key(reserved), access(1, 1, true)),
            Err(E::SeatNotOpen),
            "reserved seat {reserved}"
        );
    }

    let version = w.seat(seat).version;
    w.set_seat_access(seat, access(1, 1, true)).unwrap();
    assert_eq!(w.seat(seat).version, version + 1);
    w.set_seat_access(seat, access(1, 1, true)).unwrap();
    assert_eq!(w.seat(seat).version, version + 1, "an identical re-send");
    w.set_seat_access(seat, access(1, 1, false)).unwrap();
    assert_eq!(w.seat(seat).version, version + 2);
    assert_eq!(
        w.place(m, seat, limit(Side::Bid, MARK, 1))
            .map(|o| o.status),
        Ok(PlaceStatus::Rested)
    );

    let closing = w.open();
    let key = w.key(closing);
    w.set_seat_access(closing, access(0xFF, 0xFF, true))
        .unwrap();
    w.close(closing).unwrap();
    assert_eq!(
        w.set_seat_access_of(key, access(0, 0, false)),
        Err(E::SeatNotOpen),
        "a closed seat"
    );
    let reopened = w.open_with_key(key).unwrap();
    let fresh = w.seat(reopened);
    assert_eq!(
        (fresh.maker_markets, fresh.taker_markets, fresh.blocked),
        (0, 0, 0)
    );
}

#[test]
fn set_market_access_is_perps_only_and_check_refuses_stray_bits() {
    let mut w = World::new(10, 8);
    let s = w.add_market(spot_params(0));
    let m = w.add_market(perp_params(1));
    for (makers, takers) in [(true, false), (false, true), (true, true)] {
        assert_eq!(
            w.set_market_access(s, makers, takers),
            Err(E::InvalidMarketParams)
        );
    }
    w.set_market_access(s, false, false).unwrap();
    assert_eq!(w.markets[s].params.access, 0);

    w.markets[m].params.status = STATUS_PAUSED;
    w.markets[m].params.oracle_health = ORACLE_DISLOCATED;
    w.set_market_access(m, true, true).unwrap();
    assert_eq!(
        w.markets[m].params.access, 3,
        "at any status and source health"
    );
    w.set_market_access(m, false, true).unwrap();
    assert_eq!(w.markets[m].params.access, ACCESS_TAKERS_LISTED);

    let mut params = perp_params(0);
    for stray in [4u8, 8, 0x80, 0xFF] {
        params.access = stray;
        assert_eq!(params.check(), Err(E::InvalidMarketParams));
    }
    params.access = ACCESS_MAKERS_LISTED | ACCESS_TAKERS_LISTED;
    assert_eq!(params.check(), Ok(MarketKind::Perp));
    let mut spot = spot_params(0);
    spot.access = ACCESS_MAKERS_LISTED;
    assert_eq!(spot.check(), Err(E::InvalidMarketParams));
}

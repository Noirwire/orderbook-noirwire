#![allow(dead_code)]

use bytemuck::Zeroable;
use noirwire_orderbook_engine::*;
use sha2::{Digest, Sha256 as Sha2};

pub const QUOTE: u8 = 0;
pub const BASE: u8 = 1;
pub const START: i64 = 1_000_000;
pub const MARK: u64 = 1_000;

pub fn sha(data: &[u8]) -> [u8; 32] {
    Sha2::digest(data).into()
}

pub fn spot_params(market_id: u8) -> MarketParams {
    MarketParams {
        tick: 10,
        base_lot: 100,
        min_size: 1,
        funding_interval: 3_600,
        max_price_age: 60,
        max_age_liquidation: 300,
        open_interest_cap: 1_000_000,
        band_bps: 2_000,
        im_bps: 3_000,
        mm_bps: 500,
        liq_penalty_bps: 100,
        taker_fee_bps: 30,
        max_move_bps: 300,
        min_publish_gap: 1,
        max_open_orders: 4,
        kind: KIND_SPOT,
        market_id,
        base_token: BASE,
        quote_token: QUOTE,
        ..MarketParams::zeroed()
    }
}

pub fn perp_params(market_id: u8) -> MarketParams {
    MarketParams {
        tick: 10,
        base_lot: 1,
        min_size: 1,
        funding_interval: 3_600,
        max_price_age: 60,
        max_age_liquidation: 300,
        open_interest_cap: 1_000_000,
        band_bps: 500,
        im_bps: 1_000,
        mm_bps: 500,
        taker_fee_bps: 30,
        liq_penalty_bps: 100,
        funding_cap_bps: 50,
        max_move_bps: 300,
        min_publish_gap: 1,
        max_open_orders: 4,
        kind: KIND_PERP,
        market_id,
        ..MarketParams::zeroed()
    }
}

pub fn order(side: Side, order_type: OrderType, price: u64, size: u64) -> NewOrder {
    NewOrder {
        side,
        order_type,
        price,
        size,
        secret: [7; 16],
        reduce_only: false,
        expiry: 0,
    }
}

pub fn expiring(mut new_order: NewOrder, expiry: i64) -> NewOrder {
    new_order.expiry = expiry;
    new_order
}

const BPS: i128 = 10_000;

/// The margin arithmetic of RULES 6 written a second time, for the harness only:
/// (equity, initial margin, maintenance margin), the two margins multiplied by 10,000.
/// `None` when the numbers are too large to compare, which only the fuzz tests reach.
pub fn try_margins(seat: &Seat, risks: &[MarketRisk]) -> Option<(i128, i128, i128)> {
    let mut equity = i128::from(seat.collateral);
    let (mut initial, mut maintenance) = (0i128, 0i128);
    for (slot, risk) in seat.perp.iter().zip(risks) {
        let base = i128::from(slot.base);
        let mark = i128::from(risk.mark);
        let moved = i128::from(risk.funding_index) - i128::from(slot.funding_checkpoint);
        let quote = i128::from(slot.quote);
        let value = base.checked_mul(mark)?.checked_add(quote)?;
        equity = equity.checked_add(value.checked_sub(base.checked_mul(moved)?)?)?;
        let long = (base + i128::from(slot.open_bid_lots)).max(0);
        let short = (i128::from(slot.open_ask_lots) - base).max(0);
        let worst = long.max(short).checked_mul(mark)?;
        initial = initial.checked_add(worst.checked_mul(i128::from(risk.im_bps))?)?;
        let held = base.abs().checked_mul(mark)?;
        maintenance = maintenance.checked_add(held.checked_mul(i128::from(risk.mm_bps))?)?;
    }
    Some((equity, initial, maintenance))
}

pub fn margins(seat: &Seat, risks: &[MarketRisk]) -> (i128, i128, i128) {
    try_margins(seat, risks).unwrap()
}

fn grows(base_before: i64, base_after: i64) -> bool {
    let reduced = base_before.signum() == base_after.signum()
        && base_after.unsigned_abs() < base_before.unsigned_abs();
    base_after != 0 && !reduced
}

pub fn limit(side: Side, price: u64, size: u64) -> NewOrder {
    order(side, OrderType::Limit, price, size)
}

pub fn ioc(side: Side, price: u64, size: u64) -> NewOrder {
    order(side, OrderType::ImmediateOrCancel, price, size)
}

pub fn market(side: Side, worst_price: u64, size: u64) -> NewOrder {
    order(side, OrderType::Market, worst_price, size)
}

pub fn post_only(side: Side, price: u64, size: u64) -> NewOrder {
    order(side, OrderType::PostOnly, price, size)
}

pub fn reduce_only(mut new_order: NewOrder) -> NewOrder {
    new_order.reduce_only = true;
    new_order
}

/// (filled, rested, cancelled) of one order.
pub fn sizes(outcome: &PlaceOutcome) -> (u64, u64, u64) {
    (outcome.filled, outcome.rested, outcome.cancelled)
}

fn refused_sizes(outcome: &PlaceOutcome) -> (u64, u64, u64, u64, u64) {
    (
        outcome.filled,
        outcome.rested,
        outcome.cancelled,
        outcome.filled_notional,
        outcome.fee_paid,
    )
}

/// The sequence number of the remainder that rests.
pub fn seq(outcome: &PlaceOutcome) -> u64 {
    outcome.resting_order_seq.unwrap()
}

pub fn bid_lock(price: u64, size: u64, fee_bps: u16) -> u128 {
    let notional = u128::from(price) * u128::from(size);
    notional + (notional * u128::from(fee_bps)).div_ceil(10_000)
}

#[derive(Clone)]
pub struct MarketState {
    pub params: MarketParams,
    pub book: BookHeader,
    pub bids: Vec<Order>,
    pub asks: Vec<Order>,
    pub price: Price,
}

impl MarketState {
    pub fn live(&self, side: Side) -> &[Order] {
        match side {
            Side::Bid => &self.bids[..self.book.bid_count as usize],
            Side::Ask => &self.asks[..self.book.ask_count as usize],
        }
    }

    /// Resting orders of one side, best first.
    pub fn resting(&self, side: Side) -> Vec<Order> {
        self.live(side).iter().rev().copied().collect()
    }
}

/// A whole exchange in memory, with custody modelled as counters that only deposits
/// and withdrawals move. Every call made through it is checked: a refused call must
/// leave every byte as it was, and every invariant must hold afterwards.
#[derive(Clone)]
pub struct World {
    pub header: LedgerHeader,
    pub seats: Vec<Seat>,
    pub keys: Vec<[u8; 32]>,
    pub markets: Vec<MarketState>,
    pub journal: Vec<JournalEntry>,
    pub fills: Fills,
    pub now: i64,
    pub paused: bool,
    pub max_steps: u32,
    pub book_capacity: usize,
    pub custody_collateral: i128,
    pub custody_spot: [u128; SPOT_TOKENS],
    /// False only in the fuzz tests, where amounts are too large for the harness to
    /// redo the engine's arithmetic exactly.
    pub sane_numbers: bool,
    next_key: u8,
}

impl World {
    pub fn new(seat_capacity: usize, book_capacity: usize) -> World {
        let mut world = World {
            header: LedgerHeader::zeroed(),
            seats: vec![Seat::zeroed(); seat_capacity],
            keys: vec![[0; 32]; seat_capacity],
            markets: Vec::new(),
            journal: vec![JournalEntry::zeroed(); MAX_FILLS + PLACE_JOURNAL_EXTRA_ENTRIES],
            fills: Fills::new(),
            now: START,
            paused: false,
            max_steps: 8,
            book_capacity,
            custody_collateral: 0,
            custody_spot: [0; SPOT_TOKENS],
            sane_numbers: true,
            next_key: 1,
        };
        for reserved in [FEE_SEAT, INSURANCE_SEAT] {
            let key = world.fresh_key();
            world.keys[reserved as usize] = key;
            let mut ledger = LedgerMut {
                header: &mut world.header,
                seats: &mut world.seats,
            };
            open_reserved_seat(&mut ledger, reserved, &key).unwrap();
        }
        world
    }

    fn fresh_key(&mut self) -> [u8; 32] {
        let key = [self.next_key; 32];
        self.next_key += 1;
        key
    }

    pub fn add_market(&mut self, params: MarketParams) -> usize {
        assert_eq!(usize::from(params.market_id), self.markets.len());
        self.markets.push(MarketState {
            params,
            book: BookHeader {
                market_id: params.market_id,
                last_funding_time: self.now,
                ..BookHeader::zeroed()
            },
            bids: vec![Order::zeroed(); self.book_capacity],
            asks: vec![Order::zeroed(); self.book_capacity],
            price: Price {
                price: MARK,
                publish_time: self.now,
            },
        });
        self.markets.len() - 1
    }

    pub fn risks(&self) -> Vec<MarketRisk> {
        let mut risks = vec![MarketRisk::NONE; MARKETS];
        for market in &self.markets {
            risks[usize::from(market.params.market_id)] =
                MarketRisk::new(&market.params, &market.price, &market.book);
        }
        risks
    }

    pub fn bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(bytemuck::bytes_of(&self.header));
        bytes.extend_from_slice(bytemuck::cast_slice(&self.seats));
        for market in &self.markets {
            bytes.extend_from_slice(bytemuck::bytes_of(&market.params));
            bytes.extend_from_slice(bytemuck::bytes_of(&market.book));
            bytes.extend_from_slice(bytemuck::cast_slice(&market.bids));
            bytes.extend_from_slice(bytemuck::cast_slice(&market.asks));
            bytes.extend_from_slice(bytemuck::bytes_of(&market.price));
        }
        bytes
    }

    /// RULES 13.2 and the seat version rule, then every other invariant.
    fn guarded<T>(&mut self, call: impl FnOnce(&mut World) -> EngineResult<T>) -> EngineResult<T> {
        let bytes_before = self.bytes();
        let seats_before = self.seats.clone();
        let result = call(self);
        if result.is_err() {
            assert!(bytes_before == self.bytes(), "a refused call changed state");
        }
        for (before, after) in seats_before.iter().zip(&self.seats) {
            let mut ignoring_version = *before;
            ignoring_version.version = after.version;
            let expected = if ignoring_version == *after {
                before.version
            } else {
                before.version + 1
            };
            assert_eq!(after.version, expected, "seat version rule");
        }
        self.check_invariants();
        result
    }

    pub fn open_with_key(&mut self, key: [u8; 32]) -> EngineResult<u32> {
        let seat = self.guarded(|w| {
            let mut ledger = LedgerMut {
                header: &mut w.header,
                seats: &mut w.seats,
            };
            open_seat(&mut ledger, &key)
        })?;
        self.keys[seat as usize] = key;
        Ok(seat)
    }

    pub fn try_open(&mut self) -> EngineResult<u32> {
        let key = self.fresh_key();
        self.open_with_key(key)
    }

    pub fn open(&mut self) -> u32 {
        self.try_open().unwrap()
    }

    pub fn close_as(&mut self, seat: u32, key: [u8; 32]) -> EngineResult<()> {
        self.guarded(|w| {
            let mut ledger = LedgerMut {
                header: &mut w.header,
                seats: &mut w.seats,
            };
            close_seat(&mut ledger, Trader { seat, owner: &key })
        })
    }

    pub fn close(&mut self, seat: u32) -> EngineResult<()> {
        self.close_as(seat, self.key(seat))
    }

    pub fn key(&self, seat: u32) -> [u8; 32] {
        self.keys.get(seat as usize).copied().unwrap_or([0xEE; 32])
    }

    pub fn deposit(&mut self, seat: u32, asset: Asset, amount: u64) -> EngineResult<()> {
        self.guarded(|w| {
            let mut ledger = LedgerMut {
                header: &mut w.header,
                seats: &mut w.seats,
            };
            deposit(&mut ledger, seat, asset, amount)?;
            match asset {
                Asset::Collateral => w.custody_collateral += i128::from(amount),
                Asset::Spot(token) => w.custody_spot[usize::from(token)] += u128::from(amount),
            }
            Ok(())
        })
    }

    pub fn withdraw_as(
        &mut self,
        seat: u32,
        key: [u8; 32],
        asset: Asset,
        amount: u64,
    ) -> EngineResult<()> {
        self.guarded(|w| {
            let risks = w.risks();
            let env = w.env(&risks);
            let mut ledger = LedgerMut {
                header: &mut w.header,
                seats: &mut w.seats,
            };
            withdraw(
                &mut ledger,
                &env,
                Trader { seat, owner: &key },
                asset,
                amount,
            )?;
            match asset {
                Asset::Collateral => w.custody_collateral -= i128::from(amount),
                Asset::Spot(token) => w.custody_spot[usize::from(token)] -= u128::from(amount),
            }
            Ok(())
        })
    }

    pub fn withdraw(&mut self, seat: u32, asset: Asset, amount: u64) -> EngineResult<()> {
        self.withdraw_as(seat, self.key(seat), asset, amount)
    }

    fn env<'a>(&self, risks: &'a [MarketRisk]) -> Env<'a> {
        Env {
            now: self.now,
            exchange_paused: self.paused,
            max_steps: self.max_steps,
            markets: risks,
            hash: sha,
        }
    }

    pub fn place_as(
        &mut self,
        market: usize,
        seat: u32,
        key: [u8; 32],
        new_order: NewOrder,
    ) -> EngineResult<PlaceOutcome> {
        let next_fill_seq = self.markets[market].book.next_fill_seq;
        let next_order_seq = self.markets[market].book.next_order_seq;
        let bytes_before = self.bytes();
        let seats_before = self.seats.clone();
        let result = self.guarded(|w| {
            let risks = w.risks();
            let env = w.env(&risks);
            let state = &mut w.markets[market];
            let mut view = MarketMut {
                params: &mut state.params,
                book: &mut state.book,
                bids: &mut state.bids,
                asks: &mut state.asks,
                price: &state.price,
            };
            let mut ledger = LedgerMut {
                header: &mut w.header,
                seats: &mut w.seats,
            };
            let mut journal = Journal::new(&mut w.journal);
            place_order(
                &mut ledger,
                &mut view,
                &mut journal,
                &env,
                Trader { seat, owner: &key },
                &new_order,
                &mut w.fills,
            )
        });
        match &result {
            Ok(outcome) if outcome.status == PlaceStatus::RefusedPostOnlyWouldMatch => {
                let unchanged = bytes_before == self.bytes();
                assert!(unchanged, "a refused outcome changed state");
                assert!(self.fills.as_slice().is_empty());
                assert_eq!(new_order.order_type, OrderType::PostOnly);
                assert_eq!(refused_sizes(outcome), (0, 0, new_order.size, 0, 0));
                assert_eq!(outcome.resting_order_seq, None);
            }
            Ok(outcome) => {
                self.check_fills(market, seat, &new_order, outcome, next_fill_seq);
                self.check_fill_margins(market, seat, &new_order, outcome, &seats_before);
                self.check_fee_split(market, outcome, &seats_before);
                let book = &self.markets[market].book;
                assert_eq!(book.next_order_seq, next_order_seq + 1);
                let expected = (outcome.rested > 0).then_some(next_order_seq);
                assert_eq!(outcome.resting_order_seq, expected);
            }
            Err(_) => assert!(self.fills.as_slice().is_empty()),
        }
        result
    }

    pub fn place(
        &mut self,
        market: usize,
        seat: u32,
        new_order: NewOrder,
    ) -> EngineResult<PlaceOutcome> {
        self.place_as(market, seat, self.key(seat), new_order)
    }

    /// RULES 13.9a: no fill makes a seat's equity negative, and a fill that grows a
    /// position leaves the taker at or above initial margin and the maker at or above
    /// maintenance margin, at the current mark.
    fn check_fill_margins(
        &self,
        market: usize,
        taker: u32,
        new_order: &NewOrder,
        outcome: &PlaceOutcome,
        seats_before: &[Seat],
    ) {
        if self.markets[market].params.kind != KIND_PERP {
            return;
        }
        let risks = self.risks();
        let fills = self.fills.as_slice();
        let mut involved = vec![taker];
        involved.extend(fills.iter().map(|fill| fill.maker_seat));
        involved.dedup();
        if fills.is_empty() {
            return;
        }
        for seat in involved {
            let before = &seats_before[seat as usize];
            let mut after = self.seats[seat as usize];
            let is_taker = seat == taker;
            if is_taker {
                let slot = &mut after.perp[market];
                match new_order.side {
                    Side::Bid => slot.open_bid_lots -= outcome.rested,
                    Side::Ask => slot.open_ask_lots -= outcome.rested,
                }
            }
            let (Some(valued_before), Some(valued_after)) =
                (try_margins(before, &risks), try_margins(&after, &risks))
            else {
                continue;
            };
            let (equity_before, _, maintenance_before) = valued_before;
            let (equity_after, initial, maintenance) = valued_after;
            if equity_after.checked_mul(2 * BPS).is_none() {
                continue;
            }
            assert!(equity_after >= 0, "RULES 13.9a negative equity after fill");
            let base_before = before.perp[market].base;
            let base_after = after.perp[market].base;
            if grows(base_before, base_after) {
                let (held, needed) = if is_taker {
                    (equity_after * BPS, initial)
                } else {
                    (2 * equity_after * BPS, initial + maintenance)
                };
                assert!(held >= needed, "RULES 13.9a margin after a growing fill");
                continue;
            }
            let fills_of_seat = fills.iter().filter(|f| f.maker_seat == seat).count();
            let judged_once = !is_taker && fills_of_seat == 1 || is_taker && fills.len() == 1;
            let orders_after = i32::from(self.seats[seat as usize].open_orders[market]);
            let orders_before = i32::from(before.open_orders[market]);
            let orders_only_moved_by_the_fill = if is_taker {
                orders_after == orders_before + i32::from(outcome.rested > 0)
            } else {
                orders_before - orders_after <= 1
            };
            if !(judged_once && orders_only_moved_by_the_fill) {
                continue;
            }
            let not_riskier = if maintenance == 0 {
                equity_after >= 0
            } else {
                maintenance <= maintenance_before
                    && equity_after * maintenance_before >= equity_before * maintenance
            };
            let holds = equity_after * BPS >= initial || not_riskier;
            assert!(holds, "RULES 13.9a a reducing fill left it riskier");
        }
    }

    /// RULES 5: each fee is split between the insurance seat, rounded down, and the fee
    /// seat, and the two parts add up to what the taker paid.
    fn check_fee_split(&self, market: usize, outcome: &PlaceOutcome, seats_before: &[Seat]) {
        let params = &self.markets[market].params;
        let share = u128::from(params.fee_insurance_share_bps);
        let fee_bps = u128::from(params.taker_fee_bps);
        let mut to_insurance = 0u128;
        for fill in self.fills.as_slice() {
            let notional = u128::from(fill.price) * u128::from(fill.size);
            to_insurance += (notional * fee_bps).div_ceil(10_000) * share / 10_000;
        }
        let received = |seat: u32| -> i128 {
            let holding = |seat: &Seat| match params.kind {
                KIND_SPOT => {
                    let balance = seat.spot[usize::from(params.quote_token)];
                    i128::from(balance.available) + i128::from(balance.locked)
                }
                _ => i128::from(seat.collateral),
            };
            holding(&self.seats[seat as usize]) - holding(&seats_before[seat as usize])
        };
        let to_insurance = to_insurance as i128;
        assert_eq!(received(INSURANCE_SEAT), to_insurance, "insurance share");
        let to_fee_seat = i128::from(outcome.fee_paid) - to_insurance;
        assert_eq!(received(FEE_SEAT), to_fee_seat, "fee seat share");
    }

    /// RULES 13.4: every fill respects tick, limit price and the step limit, carries
    /// consecutive sequence numbers and the receipts of RULES 10.
    fn check_fills(
        &self,
        market: usize,
        seat: u32,
        new_order: &NewOrder,
        outcome: &PlaceOutcome,
        first_fill_seq: u64,
    ) {
        let state = &self.markets[market];
        let fills = self.fills.as_slice();
        assert!(fills.len() <= self.max_steps as usize);
        assert_eq!(
            outcome.filled + outcome.rested + outcome.cancelled,
            new_order.size
        );
        assert_eq!(fills.iter().map(|f| f.size).sum::<u64>(), outcome.filled);
        let mut fee = 0u128;
        let mut filled_notional = 0u128;
        for (offset, fill) in fills.iter().enumerate() {
            assert_eq!(fill.fill_seq, first_fill_seq + offset as u64);
            assert!(fill.size > 0);
            assert_eq!(fill.price % state.params.tick, 0);
            assert_eq!(fill.taker_side, new_order.side);
            assert_eq!(fill.taker_seat, seat);
            assert_ne!(fill.maker_seat, seat);
            match new_order.side {
                Side::Bid => assert!(fill.price <= new_order.price),
                Side::Ask => assert!(fill.price >= new_order.price),
            }
            let taker = receipt(sha, &new_order.secret, fill.fill_seq, ROLE_TAKER);
            assert_eq!(fill.taker_receipt, taker);
            let notional = u128::from(fill.price) * u128::from(fill.size);
            fee += (notional * u128::from(state.params.taker_fee_bps)).div_ceil(10_000);
            filled_notional += notional;
        }
        assert_eq!(u128::from(outcome.filled_notional), filled_notional);
        for pair in fills.windows(2) {
            match new_order.side {
                Side::Bid => assert!(pair[0].price <= pair[1].price),
                Side::Ask => assert!(pair[0].price >= pair[1].price),
            }
        }
        assert_eq!(u128::from(outcome.fee_paid), fee);
        assert_eq!(
            state.book.next_fill_seq,
            first_fill_seq + fills.len() as u64
        );
        let expected_status = if outcome.truncated {
            PlaceStatus::RemainderCancelledStepLimit
        } else if outcome.status == PlaceStatus::RemainderCancelledFillCheck {
            assert!(outcome.cancelled > 0 && outcome.rested == 0);
            PlaceStatus::RemainderCancelledFillCheck
        } else if outcome.rested > 0 {
            PlaceStatus::Rested
        } else if outcome.cancelled == 0 {
            PlaceStatus::Filled
        } else if outcome.status == PlaceStatus::RemainderCancelledBookFull {
            let own = state.live(new_order.side).len();
            assert_eq!(own, self.book_capacity, "a remainder needs a full side");
            assert!(!new_order.reduce_only);
            let rests = [OrderType::Limit, OrderType::PostOnly];
            assert!(rests.contains(&new_order.order_type));
            PlaceStatus::RemainderCancelledBookFull
        } else {
            PlaceStatus::RemainderCancelled
        };
        assert_eq!(outcome.status, expected_status);
        if outcome.status != PlaceStatus::Rested {
            assert_eq!(outcome.rested, 0);
        }
    }

    pub fn cancel_as(
        &mut self,
        market: usize,
        seat: u32,
        key: [u8; 32],
        order_seq: u64,
    ) -> EngineResult<()> {
        self.guarded(|w| {
            let state = &mut w.markets[market];
            let mut view = MarketMut {
                params: &mut state.params,
                book: &mut state.book,
                bids: &mut state.bids,
                asks: &mut state.asks,
                price: &state.price,
            };
            let mut ledger = LedgerMut {
                header: &mut w.header,
                seats: &mut w.seats,
            };
            cancel_order(
                &mut ledger,
                &mut view,
                Trader { seat, owner: &key },
                order_seq,
            )
        })
    }

    pub fn cancel(&mut self, market: usize, seat: u32, order_seq: u64) -> EngineResult<()> {
        self.cancel_as(market, seat, self.key(seat), order_seq)
    }

    pub fn cancel_all_as(
        &mut self,
        market: usize,
        seat: u32,
        key: [u8; 32],
        max_cancels: u32,
    ) -> EngineResult<u32> {
        self.guarded(|w| {
            let state = &mut w.markets[market];
            let mut view = MarketMut {
                params: &mut state.params,
                book: &mut state.book,
                bids: &mut state.bids,
                asks: &mut state.asks,
                price: &state.price,
            };
            let mut ledger = LedgerMut {
                header: &mut w.header,
                seats: &mut w.seats,
            };
            cancel_all(
                &mut ledger,
                &mut view,
                Trader { seat, owner: &key },
                max_cancels,
            )
        })
    }

    pub fn cancel_all(&mut self, market: usize, seat: u32, max_cancels: u32) -> EngineResult<u32> {
        self.cancel_all_as(market, seat, self.key(seat), max_cancels)
    }

    pub fn fund(&mut self, market: usize) -> EngineResult<bool> {
        self.guarded(|w| {
            let risks = w.risks();
            let env = w.env(&risks);
            let state = &mut w.markets[market];
            let mut view = MarketMut {
                params: &mut state.params,
                book: &mut state.book,
                bids: &mut state.bids,
                asks: &mut state.asks,
                price: &state.price,
            };
            update_funding(&mut view, &env)
        })
    }

    /// Liquidates with a worst price that accepts whatever the liquidation price is.
    pub fn liquidate_as(
        &mut self,
        market: usize,
        liquidator: u32,
        key: [u8; 32],
        target: u32,
        size: u64,
    ) -> EngineResult<LiquidationOutcome> {
        let target_is_short = self
            .seats
            .get(target as usize)
            .is_some_and(|seat| seat.perp[market].base < 0);
        let request = LiquidationRequest {
            target,
            size,
            worst_price: if target_is_short { 0 } else { u64::MAX },
        };
        self.liquidate_with(market, liquidator, key, request)
    }

    /// RULES 8.3 written a second time: the most lots a liquidation may take.
    fn liquidation_cap(&self, market: usize, target: u32, requested: u64) -> Option<u64> {
        let seat = self.seats.get(target as usize)?;
        let params = &self.markets[market].params;
        let (equity, _, maintenance) = try_margins(seat, &self.risks())?;
        let position = seat.perp[market].base.unsigned_abs();
        let mark = i128::from(self.markets[market].price.price);
        let buffer = i128::from(params.liq_buffer_bps);
        let buffered = i128::from(position).checked_mul(mark * buffer)?;
        let shortage = maintenance.checked_add(buffered)? - equity.checked_mul(BPS)?;
        let freed = i128::from(params.mm_bps) + buffer - i128::from(params.liq_penalty_bps);
        let per_lot = mark * freed;
        if shortage <= 0 || per_lot <= 0 {
            return None;
        }
        let restores = u64::try_from((shortage + per_lot - 1) / per_lot).unwrap_or(u64::MAX);
        let size = requested.min(position).min(restores);
        let left = position - size;
        let dust = left > 0 && left < params.min_size;
        Some(if dust { position } else { size })
    }

    pub fn liquidate_with(
        &mut self,
        market: usize,
        liquidator: u32,
        key: [u8; 32],
        request: LiquidationRequest,
    ) -> EngineResult<LiquidationOutcome> {
        let target = request.target;
        let was_liquidatable = self
            .seats
            .get(target as usize)
            .map(|seat| is_liquidatable(seat, &self.risks(), market, self.now));
        let cap = self.liquidation_cap(market, target, request.size);
        let seats_before = self.seats.clone();
        let bytes_before = self.bytes();
        let result = self.guarded(|w| {
            let risks = w.risks();
            let env = w.env(&risks);
            let state = &mut w.markets[market];
            let mut view = MarketMut {
                params: &mut state.params,
                book: &mut state.book,
                bids: &mut state.bids,
                asks: &mut state.asks,
                price: &state.price,
            };
            let mut ledger = LedgerMut {
                header: &mut w.header,
                seats: &mut w.seats,
            };
            let mut journal = Journal::new(&mut w.journal);
            liquidate(
                &mut ledger,
                &mut view,
                &mut journal,
                &env,
                Trader {
                    seat: liquidator,
                    owner: &key,
                },
                &request,
            )
        });
        match &result {
            Ok(outcome) if outcome.status == LiquidationStatus::Liquidated => {
                assert_eq!(was_liquidatable, Some(Ok(true)), "RULES 13.9");
                assert!(outcome.liquidated > 0);
                if self.sane_numbers {
                    assert_eq!(Some(outcome.liquidated), cap, "RULES 8.3 liquidation size");
                    let parties = (liquidator, target);
                    self.check_penalty_split(market, parties, outcome, &seats_before);
                }
            }
            Ok(outcome) => {
                let unchanged = bytes_before == self.bytes();
                assert!(unchanged, "a liquidation that did nothing changed state");
                let nothing = (outcome.liquidated, outcome.price, outcome.orders_cancelled);
                assert_eq!(nothing, (0, 0, 0));
                assert_eq!((outcome.insurance_paid, outcome.uncovered), (0, 0));
            }
            Err(_) => {}
        }
        result
    }

    /// RULES 8.3a: the penalty is split between the liquidator and the insurance seat
    /// and nothing of it is lost: the target pays exactly what the two receive.
    fn check_penalty_split(
        &self,
        market: usize,
        parties: (u32, u32),
        outcome: &LiquidationOutcome,
        seats_before: &[Seat],
    ) {
        let (liquidator, target) = parties;
        let params = &self.markets[market].params;
        let mark = self.markets[market].price.price;
        let penalty = u128::from(mark.abs_diff(outcome.price)) * u128::from(outcome.liquidated);
        let share = penalty * u128::from(params.liq_insurance_share_bps) / 10_000;
        assert_eq!(u128::from(outcome.penalty_to_insurance), share);
        let risks = self.risks();
        let gain = |seat: u32| {
            let before = margins(&seats_before[seat as usize], &risks).0;
            margins(&self.seats[seat as usize], &risks).0 - before
        };
        let to_insurance = i128::from(outcome.penalty_to_insurance);
        assert_eq!(gain(liquidator), penalty as i128 - to_insurance);
        let covered = i128::from(outcome.insurance_paid);
        assert_eq!(gain(INSURANCE_SEAT), to_insurance - covered);
        assert_eq!(gain(target), covered - penalty as i128);
    }

    pub fn cover_shortfall(&mut self, market: usize, seat: u32) -> EngineResult<u64> {
        self.guarded(|w| {
            let mut ledger = LedgerMut {
                header: &mut w.header,
                seats: &mut w.seats,
            };
            cover_shortfall(&mut ledger, &mut w.markets[market].params, seat)
        })
    }

    /// Returns what was removed from the recorded shortfalls. The records only fall,
    /// and afterwards never exceed what seats with no position still owe unless they
    /// were already at or below it.
    pub fn reconcile(&mut self) -> u64 {
        let before: Vec<u64> = self.recorded_shortfalls();
        let mut params: Vec<MarketParams> = self.markets.iter().map(|m| m.params).collect();
        let ledger = LedgerMut {
            header: &mut self.header,
            seats: &mut self.seats,
        };
        let removed = reconcile_shortfall(&ledger, &mut params);
        for (state, reconciled) in self.markets.iter_mut().zip(params) {
            state.params = reconciled;
        }
        let after = self.recorded_shortfalls();
        assert!(before.iter().zip(&after).all(|(old, new)| new <= old));
        let fell_by: u64 = before.iter().sum::<u64>() - after.iter().sum::<u64>();
        assert_eq!(fell_by, removed);
        self.check_invariants();
        removed
    }

    fn recorded_shortfalls(&self) -> Vec<u64> {
        let recorded = |state: &MarketState| state.params.uncovered_shortfall;
        self.markets.iter().map(recorded).collect()
    }

    pub fn resume(&mut self, market: usize) -> EngineResult<()> {
        self.guarded(|w| resume_market(&mut w.markets[market].params))
    }

    pub fn move_fees_to_insurance(&mut self, amount: u64) -> EngineResult<()> {
        self.guarded(|w| {
            let mut ledger = LedgerMut {
                header: &mut w.header,
                seats: &mut w.seats,
            };
            move_fees_to_insurance(&mut ledger, amount)
        })
    }

    pub fn collect_fees(&mut self, asset: Asset, amount: u64) -> EngineResult<()> {
        self.guarded(|w| {
            let mut ledger = LedgerMut {
                header: &mut w.header,
                seats: &mut w.seats,
            };
            collect_fees(&mut ledger, asset, amount)?;
            match asset {
                Asset::Collateral => w.custody_collateral -= i128::from(amount),
                Asset::Spot(token) => w.custody_spot[usize::from(token)] -= u128::from(amount),
            }
            Ok(())
        })
    }

    pub fn liquidate(
        &mut self,
        market: usize,
        liquidator: u32,
        target: u32,
        size: u64,
    ) -> EngineResult<LiquidationOutcome> {
        self.liquidate_as(market, liquidator, self.key(liquidator), target, size)
    }

    pub fn publish(&mut self, market: usize, price: u64, publish_time: i64) -> EngineResult<()> {
        self.guarded(|w| {
            let now = w.now;
            let state = &mut w.markets[market];
            publish_price(&mut state.price, &state.params, price, publish_time, now)
        })
    }

    pub fn reset(&mut self, market: usize, price: u64, publish_time: i64) -> EngineResult<()> {
        self.guarded(|w| {
            let state = &mut w.markets[market];
            reset_price(&mut state.price, &mut state.params, price, publish_time)
        })
    }

    /// Jumps the funding index to a value that `update_funding` would need many
    /// intervals to reach. Total long equals total short, so no invariant moves.
    pub fn set_funding_index(&mut self, market: usize, index: i64) -> bool {
        self.markets[market].book.funding_index = index;
        self.check_invariants();
        true
    }

    /// Writes the mark directly, stamped with the current time, so a test can stage any
    /// move of the market without the feed's own limits or the reset's status change.
    pub fn set_price(&mut self, market: usize, price: u64) {
        self.markets[market].price = Price {
            price,
            publish_time: self.now,
        };
        self.check_invariants();
    }

    pub fn snapshot_as(
        &mut self,
        market: usize,
        seat: u32,
        key: [u8; 32],
    ) -> EngineResult<SeatSnapshot> {
        let state = &mut self.markets[market];
        let view = MarketMut {
            params: &mut state.params,
            book: &mut state.book,
            bids: &mut state.bids,
            asks: &mut state.asks,
            price: &state.price,
        };
        let mut out = SeatSnapshot::zeroed();
        snapshot_seat(&self.seats, &view, Trader { seat, owner: &key }, &mut out)?;
        Ok(out)
    }

    pub fn seat(&self, seat: u32) -> &Seat {
        &self.seats[seat as usize]
    }

    pub fn spot(&self, seat: u32, token: u8) -> TokenBalance {
        self.seat(seat).spot[usize::from(token)]
    }

    pub fn slot(&self, seat: u32, market: usize) -> PerpSlot {
        self.seat(seat).perp[market]
    }

    pub fn collateral(&self, seat: u32) -> i64 {
        self.seat(seat).collateral
    }

    pub fn equity(&self, seat: u32) -> i128 {
        equity(self.seat(seat), &self.risks()).unwrap()
    }

    pub fn initial_margin(&self, seat: u32) -> i128 {
        initial_margin(self.seat(seat), &self.risks()).unwrap()
    }

    pub fn maintenance_margin(&self, seat: u32) -> i128 {
        maintenance_margin(self.seat(seat), &self.risks()).unwrap()
    }

    pub fn is_liquidatable(&self, seat: u32, market: usize) -> bool {
        is_liquidatable(self.seat(seat), &self.risks(), market, self.now).unwrap()
    }

    /// RULES 13, everything the engine can see.
    pub fn check_invariants(&self) {
        let seat_count = self.seats.len();
        let mut open_orders = vec![[0u8; MARKETS]; seat_count];
        let mut locked = vec![[0u128; SPOT_TOKENS]; seat_count];
        let mut bid_lots = vec![[0u64; MARKETS]; seat_count];
        let mut ask_lots = vec![[0u64; MARKETS]; seat_count];

        for state in &self.markets {
            let params = &state.params;
            let id = usize::from(params.market_id);
            assert_eq!(state.book.market_id, params.market_id);
            let mut sequences = Vec::new();
            for side in [Side::Bid, Side::Ask] {
                let live = state.live(side);
                let all = match side {
                    Side::Bid => &state.bids,
                    Side::Ask => &state.asks,
                };
                assert!(all[live.len()..].iter().all(|o| *o == Order::zeroed()));
                for pair in live.windows(2) {
                    let (worse, better) = (&pair[0], &pair[1]);
                    match side {
                        Side::Bid => assert!(worse.price <= better.price, "bids sorted"),
                        Side::Ask => assert!(worse.price >= better.price, "asks sorted"),
                    }
                    if worse.price == better.price {
                        assert!(worse.sequence > better.sequence, "time priority");
                    }
                }
                for resting in live {
                    let owner = resting.seat as usize;
                    assert!(self.seats[owner].is_open());
                    assert!(resting.remaining > 0);
                    assert!(resting.price > 0);
                    assert_eq!(resting.price % params.tick, 0);
                    assert!(resting.sequence < state.book.next_order_seq);
                    let is_ask = resting.flags & ORDER_FLAG_ASK != 0;
                    assert_eq!(is_ask, side == Side::Ask);
                    sequences.push(resting.sequence);
                    open_orders[owner][id] += 1;
                    match (params.kind, side) {
                        (KIND_SPOT, Side::Bid) => {
                            let lock =
                                bid_lock(resting.price, resting.remaining, params.taker_fee_bps);
                            assert_eq!(u128::from(resting.locked), lock);
                            locked[owner][usize::from(params.quote_token)] += lock;
                        }
                        (KIND_SPOT, Side::Ask) => {
                            assert_eq!(resting.locked, 0);
                            locked[owner][usize::from(params.base_token)] +=
                                u128::from(resting.remaining) * u128::from(params.base_lot);
                        }
                        (_, Side::Bid) => {
                            assert_eq!(resting.locked, 0);
                            bid_lots[owner][id] += resting.remaining;
                        }
                        (_, Side::Ask) => {
                            assert_eq!(resting.locked, 0);
                            ask_lots[owner][id] += resting.remaining;
                        }
                    }
                }
            }
            let unique = sequences.len();
            sequences.sort_unstable();
            sequences.dedup();
            assert_eq!(sequences.len(), unique, "order sequences are unique");
            let best_bid = state.live(Side::Bid).last().map(|o| o.price);
            let best_ask = state.live(Side::Ask).last().map(|o| o.price);
            if let (Some(bid), Some(ask)) = (best_bid, best_ask) {
                assert!(bid < ask, "the book never rests a crossing order");
            }
            let net: i128 = self
                .seats
                .iter()
                .map(|seat| i128::from(seat.perp[id].base))
                .sum();
            assert_eq!(net, 0, "RULES 13.6 total long equals total short");
            let long: i128 = self
                .seats
                .iter()
                .map(|seat| i128::from(seat.perp[id].base.max(0)))
                .sum();
            assert_eq!(i128::from(state.book.open_interest), long, "open interest");
        }

        let mut spot_total = [0u128; SPOT_TOKENS];
        let mut collateral_total = 0i128;
        let mut open = 0u32;
        let mut debt_of_flat_seats = 0u128;
        for (position, seat) in self.seats.iter().enumerate() {
            let flat = seat.perp.iter().all(|slot| slot.base == 0);
            if flat && seat.collateral < 0 {
                debt_of_flat_seats += u128::from(seat.collateral.unsigned_abs());
            }
            let collateral_size = seat.collateral.unsigned_abs();
            assert!(collateral_size <= BALANCE_CAP, "RULES 12 collateral cap");
            for balance in &seat.spot {
                let held = u128::from(balance.available) + u128::from(balance.locked);
                assert!(held <= u128::from(BALANCE_CAP), "RULES 12 balance cap");
            }
            if !seat.is_open() {
                let mut blank = Seat::zeroed();
                blank.version = seat.version;
                assert_eq!(*seat, blank, "a free seat holds nothing");
                continue;
            }
            open += 1;
            assert_eq!(seat.open_orders, open_orders[position], "open order counts");
            collateral_total += i128::from(seat.collateral);
            for (token, balance) in seat.spot.iter().enumerate() {
                assert_eq!(u128::from(balance.locked), locked[position][token], "locks");
                spot_total[token] += u128::from(balance.available) + u128::from(balance.locked);
            }
            for (id, slot) in seat.perp.iter().enumerate() {
                assert_eq!(slot.open_bid_lots, bid_lots[position][id], "open bid lots");
                assert_eq!(slot.open_ask_lots, ask_lots[position][id], "open ask lots");
                if slot.base == 0 {
                    assert_eq!(slot.quote, 0, "a flat position holds no quote");
                }
                let funding_index = self
                    .markets
                    .get(id)
                    .map(|state| state.book.funding_index)
                    .unwrap_or(0);
                let moved = i128::from(funding_index) - i128::from(slot.funding_checkpoint);
                let unpaid = i128::from(slot.base).wrapping_mul(moved);
                let settled_quote = i128::from(slot.quote).wrapping_sub(unpaid);
                collateral_total = collateral_total.wrapping_add(settled_quote);
            }
        }
        assert_eq!(open, self.header.open_seats);
        let recorded: u128 = self
            .markets
            .iter()
            .map(|state| u128::from(state.params.uncovered_shortfall))
            .sum();
        assert!(
            debt_of_flat_seats <= recorded,
            "RULES 13.9b: a seat with no position owes {debt_of_flat_seats}, recorded {recorded}"
        );
        assert_eq!(spot_total, self.custody_spot, "RULES 13.1 spot custody");
        assert_eq!(
            collateral_total, self.custody_collateral,
            "RULES 13.1 and 13.7 collateral custody"
        );
    }
}

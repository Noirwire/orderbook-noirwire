//! RULES 12: moving the seats of the ledger the exchange was first built with, 448 bytes
//! each, into the ledger of 304-byte seats at the same indices. The old ledger is only
//! ever read. Every seat is converted, converted back and compared with the original
//! before it is written, and `finish_relayout` proves the two ledgers hold the same
//! totals before the new one is stamped ready.

use anchor_lang::prelude::*;
use bytemuck::{Pod, Zeroable};
use core::mem::{offset_of, size_of};
use noirwire_orderbook_engine::{
    push_new_seats, LedgerMut, PerpSlot, Seat, TokenBalance, MARKETS, MIN_SEATS, RESERVED_SEATS,
    SEAT_FREE, SEAT_OPEN, SEAT_SLOTS, SPOT_TOKENS,
};

use crate::errors::{engine, OrderbookError};

/// The seats the old ledger holds, and every ledger had at creation.
pub const LEGACY_SEATS: usize = MIN_SEATS;
pub const LEGACY_SEAT_LEN: usize = 448;
/// The old ledger's account header and engine header.
pub const LEGACY_LEDGER_PREFIX: usize = 24;
pub const LEGACY_LEDGER_LEN: usize = LEGACY_LEDGER_PREFIX + LEGACY_SEATS * LEGACY_SEAT_LEN;

/// The markets the old seat held a position slot for.
const LEGACY_MARKETS: usize = 8;

/// A seat as the first ledger stored it: a position slot for each of 8 markets.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Pod, Zeroable)]
pub struct LegacySeat {
    pub owner: [u8; 32],
    pub version: u64,
    pub collateral: i64,
    pub spot: [TokenBalance; SPOT_TOKENS],
    pub perp: [PerpSlot; LEGACY_MARKETS],
    pub open_orders: [u8; LEGACY_MARKETS],
    pub status: u8,
    pub maker_markets: u8,
    pub taker_markets: u8,
    pub blocked: u8,
    pub _padding: [u8; 4],
}

const _: () = assert!(size_of::<LegacySeat>() == LEGACY_SEAT_LEN);
const _: () = assert!(offset_of!(LegacySeat, version) == 32);
const _: () = assert!(offset_of!(LegacySeat, collateral) == 40);
const _: () = assert!(offset_of!(LegacySeat, spot) == 48);
const _: () = assert!(offset_of!(LegacySeat, perp) == 112);
const _: () = assert!(offset_of!(LegacySeat, open_orders) == 432);
const _: () = assert!(offset_of!(LegacySeat, status) == 440);
const _: () = assert!(offset_of!(LegacySeat, maker_markets) == 441);
const _: () = assert!(offset_of!(LegacySeat, taker_markets) == 442);
const _: () = assert!(offset_of!(LegacySeat, blocked) == 443);
const _: () = assert!(LEGACY_LEDGER_LEN == 917_528);
const _: () = assert!(LEGACY_SEATS == 2_048);
const _: () = assert!(MARKETS == LEGACY_MARKETS);

fn mismatch() -> Error {
    OrderbookError::RelayoutMismatch.into()
}

/// A market the old seat is in: a position, open lots or resting orders. A flat slot
/// may still carry an old funding checkpoint, which nothing reads.
fn in_use(old: &LegacySeat, market: usize) -> bool {
    let slot = &old.perp[market];
    slot.base != 0
        || slot.quote != 0
        || slot.open_bid_lots != 0
        || slot.open_ask_lots != 0
        || old.open_orders[market] != 0
}

/// The seat in the new layout: the same owner, balances and lists, and the markets it is
/// in packed into slots in market order. A seat in more than `SEAT_SLOTS` markets has no
/// such form.
pub fn convert(old: &LegacySeat) -> Result<Seat> {
    let mut seat = Seat::zeroed();
    seat.owner = old.owner;
    seat.version = old.version;
    seat.collateral = old.collateral;
    seat.spot = old.spot;
    seat.status = old.status;
    seat.blocked = old.blocked;
    seat.maker_markets = u64::from(old.maker_markets);
    seat.taker_markets = u64::from(old.taker_markets);
    let markets_in = (0..LEGACY_MARKETS).filter(|market| in_use(old, *market));
    for (next, market) in markets_in.enumerate() {
        require!(next < SEAT_SLOTS, OrderbookError::RelayoutMismatch);
        seat.perp[next] = old.perp[market];
        seat.slot_markets[next] =
            u8::try_from(market + 1).map_err(|_| OrderbookError::RelayoutMismatch)?;
        seat.slot_orders[next] = old.open_orders[market];
    }
    Ok(seat)
}

/// The old form of a converted seat, rebuilt from its slot tags.
pub fn expand(new: &Seat) -> Result<LegacySeat> {
    let mut old = LegacySeat::zeroed();
    old.owner = new.owner;
    old.version = new.version;
    old.collateral = new.collateral;
    old.spot = new.spot;
    old.status = new.status;
    old.blocked = new.blocked;
    old.maker_markets = u8::try_from(new.maker_markets).map_err(|_| mismatch())?;
    old.taker_markets = u8::try_from(new.taker_markets).map_err(|_| mismatch())?;
    for ((tag, slot), orders) in new.slot_markets.iter().zip(&new.perp).zip(&new.slot_orders) {
        let Some(market) = tag.checked_sub(1) else {
            continue;
        };
        let market = usize::from(market);
        require!(market < LEGACY_MARKETS, OrderbookError::RelayoutMismatch);
        require!(
            old.perp[market] == PerpSlot::zeroed() && old.open_orders[market] == 0,
            OrderbookError::RelayoutMismatch
        );
        old.perp[market] = *slot;
        old.open_orders[market] = *orders;
    }
    Ok(old)
}

/// The old seat with every market it is not in zeroed, which is all `expand` can give
/// back.
pub fn normalized(old: &LegacySeat) -> LegacySeat {
    let mut kept = *old;
    for (market, slot) in kept.perp.iter_mut().enumerate() {
        if !in_use(old, market) {
            *slot = PerpSlot::zeroed();
        }
    }
    kept
}

/// What a closed seat holds: its version, and its place on the free list.
fn closed(version: u64, next_free: u32) -> Seat {
    Seat {
        version,
        next_free,
        ..Seat::zeroed()
    }
}

/// The new seat for the old seat at `index`, proven by converting it back. A seat that is
/// neither open nor closed, or a closed seat that holds anything, has no new form.
#[inline(never)]
fn converted(index: usize, old: &LegacySeat) -> Result<Seat> {
    require!(
        old.status == SEAT_FREE || old.status == SEAT_OPEN,
        OrderbookError::RelayoutMismatch
    );
    let new = match convert(old) {
        Ok(new) => new,
        Err(error) => {
            msg!("seat {} is in more than {} markets", index, SEAT_SLOTS);
            return Err(error);
        }
    };
    require!(
        expand(&new)? == normalized(old),
        OrderbookError::RelayoutMismatch
    );
    if old.status == SEAT_FREE {
        require!(
            new == closed(old.version, 0),
            OrderbookError::RelayoutMismatch
        );
    }
    Ok(new)
}

/// Copies the old seats `start..end` into the same indices of the new ledger. The first
/// call zeroes the new header. An open seat is counted, and the first two must be open; a
/// closed seat from the third on goes onto the free list.
pub fn copy_seats(
    legacy: &[LegacySeat],
    ledger: &mut LedgerMut<'_>,
    start: usize,
    end: usize,
) -> Result<()> {
    require!(
        end <= legacy.len() && end <= ledger.seats.len() && start <= end,
        OrderbookError::RelayoutMismatch
    );
    if start == 0 {
        *ledger.header = bytemuck::Zeroable::zeroed();
    }
    for (index, old) in legacy.iter().enumerate().take(end).skip(start) {
        let new = converted(index, old)?;
        let opened = new.is_open();
        require!(
            opened || index >= RESERVED_SEATS,
            OrderbookError::RelayoutMismatch
        );
        ledger.seats[index] = new;
        if opened {
            ledger.header.open_seats = ledger
                .header
                .open_seats
                .checked_add(1)
                .ok_or(OrderbookError::MathOverflow)?;
        } else if index >= RESERVED_SEATS {
            let from = u32::try_from(index).map_err(|_| OrderbookError::MathOverflow)?;
            push_new_seats(ledger, from, from + 1).map_err(engine)?;
        }
    }
    Ok(())
}

/// What a ledger holds in total, by pool: the sums `finish_relayout` compares.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Totals {
    open_seats: u64,
    collateral: i128,
    available: [u128; SPOT_TOKENS],
    locked: [u128; SPOT_TOKENS],
    base: [i128; MARKETS],
    quote: [i128; MARKETS],
    bid_lots: [u128; MARKETS],
    ask_lots: [u128; MARKETS],
    orders: [u64; MARKETS],
}

impl Totals {
    fn new() -> Totals {
        Totals {
            open_seats: 0,
            collateral: 0,
            available: [0; SPOT_TOKENS],
            locked: [0; SPOT_TOKENS],
            base: [0; MARKETS],
            quote: [0; MARKETS],
            bid_lots: [0; MARKETS],
            ask_lots: [0; MARKETS],
            orders: [0; MARKETS],
        }
    }

    /// Sums of at most `MIN_SEATS` seats of at most 2^63 in each field cannot overflow
    /// 128 bits.
    fn add_balances(&mut self, collateral: i64, spot: &[TokenBalance; SPOT_TOKENS]) {
        self.open_seats += 1;
        self.collateral += i128::from(collateral);
        for (token, balance) in spot.iter().enumerate() {
            self.available[token] += u128::from(balance.available);
            self.locked[token] += u128::from(balance.locked);
        }
    }

    fn add_slot(&mut self, market: usize, slot: &PerpSlot, orders: u8) {
        self.base[market] += i128::from(slot.base);
        self.quote[market] += i128::from(slot.quote);
        self.bid_lots[market] += u128::from(slot.open_bid_lots);
        self.ask_lots[market] += u128::from(slot.open_ask_lots);
        self.orders[market] += u64::from(orders);
    }

    fn add_legacy(&mut self, seat: &LegacySeat) {
        self.add_balances(seat.collateral, &seat.spot);
        for (market, (slot, orders)) in seat.perp.iter().zip(&seat.open_orders).enumerate() {
            self.add_slot(market, slot, *orders);
        }
    }

    /// A tag past the markets there are adds nothing, and so shows as a difference.
    fn add_new(&mut self, seat: &Seat) {
        self.add_balances(seat.collateral, &seat.spot);
        for ((tag, slot), orders) in seat
            .slot_markets
            .iter()
            .zip(&seat.perp)
            .zip(&seat.slot_orders)
        {
            let market = usize::from(tag.saturating_sub(1));
            if *tag != 0 && market < MARKETS {
                self.add_slot(market, slot, *orders);
            }
        }
    }
}

/// Zeroes to compare a closed seat's bytes with: one comparison of whole slices is a
/// single memory-compare call, where comparing the seat field by field costs a few
/// hundred instructions for each of the 2,048 seats.
static ZEROES: [u8; LEGACY_SEAT_LEN] = [0; LEGACY_SEAT_LEN];

const VERSION_AT: usize = 32;
const VERSION_END: usize = 40;
const _: () = assert!(offset_of!(Seat, version) == VERSION_AT);
const _: () = assert!(offset_of!(LegacySeat, version) == VERSION_AT);
const _: () = assert!(offset_of!(Seat, next_free) + size_of::<u32>() == size_of::<Seat>());

/// Whether `bytes` are zero but for the eight bytes of the version.
fn zero_but_version(bytes: &[u8]) -> bool {
    bytes[..VERSION_AT] == ZEROES[..VERSION_AT]
        && bytes[VERSION_END..] == ZEROES[..bytes.len() - VERSION_END]
}

fn legacy_totals(legacy: &[LegacySeat]) -> Result<Totals> {
    let mut totals = Totals::new();
    for seat in legacy {
        if seat.status == SEAT_OPEN {
            totals.add_legacy(seat);
        } else {
            require!(
                seat.status == SEAT_FREE && zero_but_version(bytemuck::bytes_of(seat)),
                OrderbookError::RelayoutMismatch
            );
        }
    }
    Ok(totals)
}

fn new_totals(seats: &[Seat]) -> Result<Totals> {
    let mut totals = Totals::new();
    for seat in seats {
        if seat.is_open() {
            totals.add_new(seat);
        } else {
            let bytes = bytemuck::bytes_of(seat);
            let link_at = offset_of!(Seat, next_free);
            require!(
                zero_but_version(&bytes[..link_at])
                    && bytes[link_at + size_of::<u32>()..].is_empty(),
                OrderbookError::RelayoutMismatch
            );
        }
    }
    Ok(totals)
}

/// Walks the free list from its head: every node a closed trader seat, none twice, and as
/// many nodes as there are closed trader seats.
fn check_free_list(ledger: &LedgerMut<'_>) -> Result<()> {
    let seats = &*ledger.seats;
    let mut seen = [0u64; LEGACY_SEATS / 64];
    let mut length = 0usize;
    let mut link = ledger.header.free_head;
    while let Some(node) = link.checked_sub(1) {
        let index = usize::try_from(node).map_err(|_| mismatch())?;
        require!(
            length < LEGACY_SEATS && index >= RESERVED_SEATS && index < seats.len(),
            OrderbookError::RelayoutMismatch
        );
        let word = seen.get_mut(index / 64).ok_or_else(mismatch)?;
        let bit = 1u64 << (index % 64);
        require!(*word & bit == 0, OrderbookError::RelayoutMismatch);
        *word |= bit;
        let seat = &seats[index];
        require!(!seat.is_open(), OrderbookError::RelayoutMismatch);
        length += 1;
        link = seat.next_free;
    }
    let open = usize::try_from(ledger.header.open_seats).map_err(|_| mismatch())?;
    require!(
        open <= seats.len() && length == seats.len() - open,
        OrderbookError::RelayoutMismatch
    );
    Ok(())
}

/// The totals check `finish_relayout` makes before the new ledger is stamped ready: the
/// same open seats and the same sums in both ledgers, no residue in a closed seat, and a
/// free list that names every closed trader seat once.
pub fn verify_copy(
    legacy: &[LegacySeat],
    legacy_open_seats: u32,
    ledger: &LedgerMut<'_>,
) -> Result<()> {
    require!(
        legacy.len() == LEGACY_SEATS && ledger.seats.len() == LEGACY_SEATS,
        OrderbookError::RelayoutMismatch
    );
    require!(
        ledger.header.open_seats == legacy_open_seats && ledger.header._reserved == [0; 24],
        OrderbookError::RelayoutMismatch
    );
    let old = legacy_totals(legacy)?;
    let new = new_totals(ledger.seats)?;
    require!(
        old.open_seats == u64::from(legacy_open_seats) && old == new,
        OrderbookError::RelayoutMismatch
    );
    check_free_list(ledger)
}

#[cfg(test)]
mod tests {
    use super::*;
    use noirwire_orderbook_engine::{take_seat, LedgerHeader};

    fn open(owner: u8) -> LegacySeat {
        LegacySeat {
            owner: [owner; 32],
            version: 3,
            status: SEAT_OPEN,
            ..LegacySeat::zeroed()
        }
    }

    fn in_market(mut seat: LegacySeat, market: usize, base: i64) -> LegacySeat {
        seat.perp[market].base = base;
        seat.perp[market].quote = -base * 10;
        seat.perp[market].funding_checkpoint = 77;
        seat
    }

    #[test]
    fn a_seat_in_up_to_four_markets_converts_to_tagged_slots_and_back() {
        let mut old = in_market(open(1), 5, 4);
        old.collateral = -9;
        old.spot[2].available = 11;
        old.spot[2].locked = 12;
        old.maker_markets = 0b100010;
        old.taker_markets = 0b1;
        old.blocked = 1;
        old.open_orders[2] = 3;
        old.perp[2].open_bid_lots = 5;
        old.open_orders[7] = 1;
        old.perp[3].funding_checkpoint = 91;

        let new = convert(&old).unwrap();

        assert_eq!(new.slot_markets, [3, 6, 8, 0]);
        assert_eq!(new.slot_orders, [3, 0, 1, 0]);
        assert_eq!(new.perp[0].open_bid_lots, 5);
        assert_eq!(new.perp[1].base, 4);
        assert_eq!(new.perp[1].funding_checkpoint, 77);
        assert_eq!(new.perp[3], PerpSlot::zeroed());
        assert_eq!((new.maker_markets, new.taker_markets), (0b100010, 1));
        assert_eq!((new.owner, new.version, new.blocked), ([1; 32], 3, 1));
        let expanded = expand(&new).unwrap();
        assert_eq!(expanded, normalized(&old));
        assert_eq!(
            expanded.perp[3],
            PerpSlot::zeroed(),
            "a flat slot's old checkpoint is dropped"
        );
        assert_eq!(new.next_free, 0);
    }

    #[test]
    fn a_seat_in_five_markets_has_no_new_form() {
        let mut old = open(1);
        for market in 0..5 {
            old = in_market(old, market, 1);
        }
        assert_eq!(
            convert(&old).unwrap_err(),
            error!(OrderbookError::RelayoutMismatch)
        );
        old.perp[4] = PerpSlot::zeroed();
        assert!(convert(&old).is_ok(), "four markets fit");
        old.perp[3] = PerpSlot::zeroed();
        old.open_orders[6] = 1;
        assert!(
            convert(&old).is_ok(),
            "a market with only resting orders is in use too: four again"
        );
        old.open_orders[7] = 1;
        assert!(convert(&old).is_err());
    }

    #[test]
    fn a_seat_whose_form_does_not_survive_the_round_trip_is_refused() {
        let mut old = in_market(open(1), 0, 1);
        old._padding = [0, 0, 1, 0];
        assert_eq!(
            converted(0, &old).unwrap_err(),
            error!(OrderbookError::RelayoutMismatch)
        );
        old._padding = [0; 4];
        assert!(converted(0, &old).is_ok());
        old.status = 2;
        assert!(converted(0, &old).is_err());
        let mut residue = LegacySeat::zeroed();
        residue.version = 9;
        assert!(converted(5, &residue).is_ok());
        residue.collateral = 1;
        assert!(
            converted(5, &residue).is_err(),
            "a closed seat holds nothing but its version"
        );
    }

    fn legacy_table(opened: &[(usize, LegacySeat)]) -> Vec<LegacySeat> {
        let mut table = vec![LegacySeat::zeroed(); LEGACY_SEATS];
        table[0] = LegacySeat {
            owner: [0xF0; 32],
            status: SEAT_OPEN,
            ..LegacySeat::zeroed()
        };
        table[1] = LegacySeat {
            owner: [0xF1; 32],
            status: SEAT_OPEN,
            ..LegacySeat::zeroed()
        };
        for (index, seat) in opened {
            table[*index] = *seat;
        }
        table
    }

    struct Fresh {
        header: LedgerHeader,
        seats: Vec<Seat>,
    }

    impl Fresh {
        fn new() -> Fresh {
            Fresh {
                header: LedgerHeader {
                    open_seats: 99,
                    free_head: 99,
                    _reserved: [9; 24],
                },
                seats: vec![Seat::zeroed(); LEGACY_SEATS],
            }
        }

        fn ledger(&mut self) -> LedgerMut<'_> {
            LedgerMut {
                header: &mut self.header,
                seats: &mut self.seats,
            }
        }
    }

    #[test]
    fn copying_in_ranges_gives_the_same_ledger_as_copying_at_once() {
        let table = legacy_table(&[
            (2, in_market(open(2), 1, 3)),
            (7, open(3)),
            (900, in_market(open(4), 6, -2)),
            (2047, open(5)),
        ]);
        let mut whole = Fresh::new();
        copy_seats(&table, &mut whole.ledger(), 0, LEGACY_SEATS).unwrap();

        let mut split = Fresh::new();
        for (start, end) in [(0, 1), (1, 256), (256, 1000), (1000, 2047), (2047, 2048)] {
            copy_seats(&table, &mut split.ledger(), start, end).unwrap();
        }

        assert_eq!(whole.header, split.header);
        assert_eq!(whole.seats, split.seats);
        assert_eq!(whole.header.open_seats, 6);
        assert_eq!(whole.header._reserved, [0; 24]);
        assert_eq!(whole.seats[900].slot_markets, [7, 0, 0, 0]);
        let open_count = whole.seats.iter().filter(|seat| seat.is_open()).count();
        assert_eq!(open_count, 6);
        verify_copy(&table, 6, &whole.ledger()).unwrap();
    }

    #[test]
    fn the_free_list_holds_every_closed_trader_seat_once_and_the_next_take_gets_the_last() {
        let table = legacy_table(&[(2, open(2)), (9, open(3))]);
        let mut copied = Fresh::new();
        copy_seats(&table, &mut copied.ledger(), 0, LEGACY_SEATS).unwrap();

        let mut ledger = copied.ledger();
        let mut taken = Vec::new();
        while let Ok(seat) = take_seat(&mut ledger, &[0xAB; 32]) {
            taken.push(seat);
        }
        assert_eq!(taken.len(), LEGACY_SEATS - 4);
        taken.sort_unstable();
        taken.dedup();
        assert_eq!(taken.len(), LEGACY_SEATS - 4);
        assert!(taken.iter().all(|seat| ![0, 1, 2, 9].contains(seat)));
        assert_eq!(taken[0], 3);
    }

    #[test]
    fn a_table_with_the_reserved_seats_not_open_is_refused() {
        let mut table = legacy_table(&[]);
        table[1] = LegacySeat::zeroed();
        let mut copied = Fresh::new();
        assert_eq!(
            copy_seats(&table, &mut copied.ledger(), 0, 2).unwrap_err(),
            error!(OrderbookError::RelayoutMismatch)
        );
    }

    #[test]
    fn a_seat_changed_after_the_copy_fails_the_totals_check() {
        let table = legacy_table(&[(2, in_market(open(2), 1, 3)), (3, open(3))]);
        let mut copied = Fresh::new();
        copy_seats(&table, &mut copied.ledger(), 0, LEGACY_SEATS).unwrap();
        let reject = |fresh: &mut Fresh, open_seats: u32| {
            assert_eq!(
                verify_copy(&table, open_seats, &fresh.ledger()).unwrap_err(),
                error!(OrderbookError::RelayoutMismatch)
            );
        };
        verify_copy(&table, 4, &copied.ledger()).unwrap();
        reject(&mut copied, 5);

        type Tamper = fn(&mut Fresh);
        let tampers: [Tamper; 8] = [
            |fresh| fresh.seats[3].collateral += 1,
            |fresh| fresh.seats[3].spot[1].locked += 1,
            |fresh| fresh.seats[2].perp[0].base += 1,
            |fresh| fresh.seats[2].perp[0].open_ask_lots += 1,
            |fresh| fresh.seats[2].slot_orders[0] += 1,
            |fresh| fresh.seats[10].collateral = 1,
            |fresh| fresh.seats[10].status = SEAT_OPEN,
            |fresh| fresh.header.free_head = 0,
        ];
        for tamper in tampers {
            let mut changed = Fresh {
                header: copied.header,
                seats: copied.seats.clone(),
            };
            tamper(&mut changed);
            reject(&mut changed, 4);
        }

        let mut looped = Fresh {
            header: copied.header,
            seats: copied.seats.clone(),
        };
        let head = usize::try_from(looped.header.free_head - 1).unwrap();
        looped.seats[head].next_free = looped.header.free_head;
        reject(&mut looped, 4);

        let mut short = Fresh {
            header: copied.header,
            seats: copied.seats.clone(),
        };
        let head = usize::try_from(short.header.free_head - 1).unwrap();
        short.seats[head].next_free = 0;
        reject(&mut short, 4);
    }
}

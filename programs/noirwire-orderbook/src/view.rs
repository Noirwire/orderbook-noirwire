use anchor_lang::prelude::*;
use bytemuck::Zeroable;
use noirwire_orderbook_engine::{
    PlaceOutcome, Seat, SeatSnapshot, Trader, RESERVED_SEATS, SNAPSHOT_LAYOUT_SLOTS,
};

use crate::errors::OrderbookError;
use crate::state::{OrderResult, ViewData, NO_SEAT, ORDER_KEYS, RESULTS, RESULT_PLACE};

/// The bytes after the seat in a snapshot, zero since the seat shrank.
const SNAPSHOT_SEAT_RESERVE: usize = 144;

/// A usable order key is a real key that is not the owner and not already one
/// of the four, so no two live keys are equal and the owner never signs a trade.
pub fn check_order_keys(owner: &Pubkey, keys: &[Pubkey; ORDER_KEYS]) -> Result<()> {
    for (position, key) in keys.iter().enumerate() {
        require!(*key != Pubkey::default(), OrderbookError::InvalidOrderKey);
        require!(key != owner, OrderbookError::InvalidOrderKey);
        require!(
            !keys[..position].contains(key),
            OrderbookError::InvalidOrderKey
        );
    }
    Ok(())
}

fn check_replacement(view: &ViewData, replacement: &Pubkey) -> Result<()> {
    let bytes = replacement.to_bytes();
    require!(
        *replacement != Pubkey::default(),
        OrderbookError::InvalidOrderKey
    );
    require!(bytes != view.owner, OrderbookError::InvalidOrderKey);
    require!(
        !view.order_keys.contains(&bytes),
        OrderbookError::InvalidOrderKey
    );
    Ok(())
}

/// Consumes the order key that signed and puts the replacement in its place.
/// It runs before anything else an order-key instruction does, so a key that
/// was used once is gone whatever happens next.
pub fn use_order_key(view: &mut ViewData, signer: &Pubkey, replacement: &Pubkey) -> Result<()> {
    let position = view
        .order_keys
        .iter()
        .position(|key| *key == signer.to_bytes())
        .ok_or(OrderbookError::NotOrderKey)?;
    check_replacement(view, replacement)?;
    view.order_keys[position] = replacement.to_bytes();
    Ok(())
}

pub fn set_order_keys(view: &mut ViewData, keys: &[Pubkey; ORDER_KEYS]) -> Result<()> {
    check_order_keys(&Pubkey::new_from_array(view.owner), keys)?;
    for (slot, key) in view.order_keys.iter_mut().zip(keys) {
        *slot = key.to_bytes();
    }
    Ok(())
}

/// An owner's replacement of all four keys. It moves the owner counter, so a
/// reset that reinstalls an earlier key is told apart from no reset at all, and
/// a signed action prepared before it is refused as stale.
pub fn reset_order_keys(view: &mut ViewData, keys: &[Pubkey; ORDER_KEYS]) -> Result<()> {
    let next = view
        .owner_nonce
        .checked_add(1)
        .ok_or(OrderbookError::MathOverflow)?;
    set_order_keys(view, keys)?;
    view.owner_nonce = next;
    Ok(())
}

pub fn trader(view: &ViewData) -> Trader<'_> {
    Trader {
        seat: view.seat,
        owner: &view.owner,
    }
}

/// RULES 12: whether the view's owner holds the seat the view records: an index that is
/// not `NO_SEAT`, names an open trader seat, and whose owner is the view's. A seat the
/// sweep released, and maybe another owner took, is not the view's any more.
pub fn is_seated(view: &ViewData, seats: &[Seat]) -> bool {
    usize::try_from(view.seat)
        .ok()
        .filter(|index| *index >= RESERVED_SEATS)
        .and_then(|index| seats.get(index))
        .is_some_and(|seat| seat.is_open() && seat.owner == view.owner)
}

/// The view's seat, or `NotSeated`: what every call that acts on the seat starts with.
/// Security: nothing acts on a seat whose owner differs from the view's.
pub fn seated_index(view: &ViewData, seats: &[Seat]) -> Result<u32> {
    require!(is_seated(view, seats), OrderbookError::NotSeated);
    Ok(view.seat)
}

/// Copies the seat into the view's snapshot, in the layout the snapshot is now written
/// in: the reserve after the seat zeroed and the layout marker set. The orders in the
/// snapshot are the last sync's.
pub fn refresh_seat(view: &mut ViewData, index: u32, seat: &Seat) {
    view.snapshot.seat = *seat;
    view.snapshot._seat_reserved = [0; SNAPSHOT_SEAT_RESERVE];
    view.snapshot.seat_index = index;
    view.snapshot.layout = SNAPSHOT_LAYOUT_SLOTS;
}

/// The view of an owner who holds no seat: no index, and a snapshot of nothing, which is
/// the truth, since money never lives in a view.
pub fn unseat(view: &mut ViewData) {
    view.seat = NO_SEAT;
    view.snapshot = SeatSnapshot::zeroed();
    view.snapshot.layout = SNAPSHOT_LAYOUT_SLOTS;
}

/// RULES 12: the view's owner has taken the seat at `index`.
pub fn record_seat(view: &mut ViewData, index: u32, seat: &Seat) {
    view.seat = index;
    view.used = 1;
    refresh_seat(view, index, seat);
}

pub fn push_result(view: &mut ViewData, result: OrderResult) -> Result<()> {
    let at = usize::try_from(view.results_written % RESULTS as u64)
        .map_err(|_| OrderbookError::MathOverflow)?;
    view.results[at] = result;
    view.results_written = view
        .results_written
        .checked_add(1)
        .ok_or(OrderbookError::MathOverflow)?;
    Ok(())
}

pub fn placed(client_order_id: u64, outcome: &PlaceOutcome) -> OrderResult {
    OrderResult {
        client_order_id,
        order_seq: outcome.resting_order_seq.unwrap_or(0),
        filled: outcome.filled,
        filled_notional: outcome.filled_notional,
        rested: outcome.rested,
        cancelled: outcome.cancelled,
        fee: outcome.fee_paid,
        kind: RESULT_PLACE,
        status: outcome.status.code(),
        code: 0,
        _padding: [0; 4],
    }
}

pub fn refused(client_order_id: u64, kind: u8, status: u8, code: u16, size: u64) -> OrderResult {
    OrderResult {
        client_order_id,
        cancelled: size,
        kind,
        status,
        code,
        ..OrderResult::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytemuck::Zeroable;

    fn keys(first: u8) -> [Pubkey; ORDER_KEYS] {
        std::array::from_fn(|i| Pubkey::new_from_array([first + i as u8; 32]))
    }

    #[test]
    fn an_owner_reset_moves_the_counter_even_for_the_same_keys() {
        let mut view = ViewData::zeroed();
        view.owner = [200; 32];
        let same = keys(1);

        assert!(reset_order_keys(&mut view, &same).is_ok());
        assert_eq!(view.owner_nonce, 1);
        assert!(reset_order_keys(&mut view, &same).is_ok());
        assert_eq!(view.owner_nonce, 2);
    }

    #[test]
    fn a_refused_or_overflowing_reset_leaves_keys_and_counter_alone() {
        let mut view = ViewData::zeroed();
        view.owner = [200; 32];
        let mut bad = keys(1);
        bad[1] = bad[0];
        assert!(reset_order_keys(&mut view, &bad).is_err());
        assert_eq!(view.owner_nonce, 0);

        view.owner_nonce = u32::MAX;
        assert!(reset_order_keys(&mut view, &keys(1)).is_err());
        assert_eq!(view.owner_nonce, u32::MAX);
        assert_eq!(view.order_keys[0], [0; 32]);
    }

    #[test]
    fn the_ring_keeps_its_order_past_four_billion_results() {
        let mut view = ViewData::zeroed();
        view.results_written = u64::from(u32::MAX);
        let numbered = |client_order_id| OrderResult {
            client_order_id,
            ..OrderResult::default()
        };

        assert!(push_result(&mut view, numbered(1)).is_ok());
        assert!(push_result(&mut view, numbered(2)).is_ok());

        assert_eq!(view.results_written, u64::from(u32::MAX) + 2);
        assert_eq!(view.results[RESULTS - 1].client_order_id, 1);
        assert_eq!(view.results[0].client_order_id, 2);
    }
}

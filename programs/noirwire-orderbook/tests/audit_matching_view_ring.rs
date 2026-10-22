//! Audit, matching: the view's result ring. Every order-key instruction (place,
//! cancel, cancel all, sync, liquidate, transfer) ends in `push_result`, which
//! counts results in a `u32` with a checked add. Once the counter is full every
//! one of those instructions fails, and nothing resets it.

use bytemuck::Zeroable;
use noirwire_orderbook::state::{OrderResult, ViewData};
use noirwire_orderbook::view::push_result;

#[test]
fn audit_matching_the_result_counter_running_out_bricks_every_order_key_instruction() {
    let mut view = ViewData::zeroed();
    view.results_written = u64::from(u32::MAX);

    let pushed = push_result(&mut view, OrderResult::default());

    assert!(
        pushed.is_ok(),
        "a ring buffer must keep accepting results: after {} order-key instructions the \
         counter overflows and push_result fails ({:?}), so this seat can never again \
         place, cancel, cancel_all or sync; funds locked in its resting orders stay \
         locked and the seat cannot be closed",
        u32::MAX,
        pushed.err(),
    );
}

//! Matching and risk engine for the NoirWire order book: spot and perpetual markets.
//!
//! The rules it enforces are in `docs/RULES.md`; section numbers in the doc comments
//! refer to that file. The engine has no I/O, no heap, no clock, no floating point and
//! no recursion. Every arithmetic step is checked, and a refused call changes nothing.

#![no_std]
#![forbid(unsafe_code)]
#![deny(
    clippy::arithmetic_side_effects,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod book;
mod error;
mod funding;
mod journal;
mod liquidation;
mod margin;
mod math;
mod orders;
mod price;
mod seats;
mod snapshot;
mod state;

pub use error::{EngineError, EngineResult};
pub use funding::update_funding;
pub use journal::{
    Journal, JournalEntry, LIQUIDATION_JOURNAL_ENTRIES, PLACE_JOURNAL_EXTRA_ENTRIES,
};
pub use liquidation::{
    liquidate, liquidate_range, LiquidationOutcome, LiquidationRequest, LiquidationStatus,
    RangeOutcome, RangeRequest,
};
pub use margin::{equity, initial_margin, is_liquidatable, maintenance_margin, MarketRisk};
pub use orders::{
    cancel_all, cancel_order, place_order, receipt, Fill, Fills, NewOrder, OrderType, PlaceOutcome,
    PlaceStatus, ROLE_MAKER, ROLE_TAKER,
};
pub use price::{
    check_quote, observed_mark, price_scale, publish_price, reset_price, sync_source, Observation,
    QuoteRules, QuoteVerdict, MAX_PRICE_SCALE,
};
pub use seats::{
    close_seat, collect_fees, cover_shortfall, cover_shortfall_range, deposit,
    move_fees_to_insurance, open_reserved_seat, push_new_seats, reconcile_shortfall,
    release_empty_seats, release_if_empty, resume_market, set_market_access, set_seat_access,
    take_seat, withdraw, Asset, Env, SeatAccess, Sha256,
};
pub use snapshot::{snapshot_seat, OrderView, SeatSnapshot, SNAPSHOT_LAYOUT_SLOTS};
pub use state::*;

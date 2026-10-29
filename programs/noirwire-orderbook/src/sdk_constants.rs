//! The TypeScript client keeps its own copy of the program's sizes, seeds,
//! tags and result codes in `sdk/src/constants.ts`. These tests read that file
//! and fail on any value that differs, and on any name they cannot find.

use core::mem::size_of;
use noirwire_orderbook_engine::{
    LiquidationStatus, Seat, SeatSnapshot, MAX_FILLS, MAX_OPEN_ORDERS, ORDERS_PER_SIDE, SEAT_SLOTS,
};

use crate::relayout::{LegacySeat, LEGACY_LEDGER_LEN, LEGACY_LEDGER_PREFIX, LEGACY_SEATS};
use crate::state::*;

const SOURCE: &str = include_str!("../../../sdk/src/constants.ts");

/// The text after `export const <name> =`, up to its closing semicolon, with
/// comments removed.
fn declaration(name: &str) -> String {
    let marker = format!("export const {name} =");
    let mut found = SOURCE.match_indices(&marker);
    let (start, _) = found
        .next()
        .unwrap_or_else(|| panic!("sdk/src/constants.ts declares no {name}"));
    assert!(found.next().is_none(), "{name} is declared twice");
    let rest = &SOURCE[start + marker.len()..];
    let end = rest
        .find(';')
        .unwrap_or_else(|| panic!("{name} has no closing semicolon"));
    without_comments(&rest[..end]).trim().to_string()
}

fn without_comments(text: &str) -> String {
    let mut kept = String::new();
    let mut rest = text;
    while let Some(open) = rest.find("/*") {
        kept.push_str(&rest[..open]);
        let close = rest[open..]
            .find("*/")
            .unwrap_or_else(|| panic!("unclosed comment in {text}"));
        rest = &rest[open + close + 2..];
    }
    kept.push_str(rest);
    assert!(!kept.contains("//"), "line comment in {text}");
    kept
}

/// A sum of products of decimal literals and names of other numeric constants.
fn number(expression: &str) -> u64 {
    expression
        .split('+')
        .map(|term| {
            term.split('*')
                .map(|factor| operand(factor.trim()))
                .product::<u64>()
        })
        .sum()
}

fn operand(text: &str) -> u64 {
    if text.starts_with(|c: char| c.is_ascii_digit()) {
        text.replace('_', "")
            .parse()
            .unwrap_or_else(|_| panic!("{text:?} is not a decimal number"))
    } else if !text.is_empty() && text.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        number(&declaration(text))
    } else {
        panic!("{text:?} is neither a number nor a constant's name")
    }
}

/// The entries of an object literal, in source order.
fn object(name: &str) -> Vec<(String, String)> {
    let text = declaration(name);
    let body = text
        .strip_suffix("as const")
        .unwrap_or(&text)
        .trim()
        .strip_prefix('{')
        .and_then(|body| body.strip_suffix('}'))
        .unwrap_or_else(|| panic!("{name} is not an object literal"));
    body.split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(|entry| {
            let (key, value) = entry
                .split_once(':')
                .unwrap_or_else(|| panic!("{name} has an entry with no key: {entry:?}"));
            (key.trim().to_string(), value.trim().to_string())
        })
        .collect()
}

fn numbers(name: &str) -> Vec<(String, u64)> {
    object(name)
        .into_iter()
        .map(|(key, value)| (key, number(&value)))
        .collect()
}

fn strings(name: &str) -> Vec<(String, Vec<u8>)> {
    object(name)
        .into_iter()
        .map(|(key, value)| {
            let quoted = value
                .strip_prefix('"')
                .and_then(|value| value.strip_suffix('"'))
                .unwrap_or_else(|| panic!("{name}.{key} is not a string literal"));
            (key, string_bytes(quoted))
        })
        .collect()
}

fn string_bytes(quoted: &str) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut chars = quoted.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            assert_eq!(chars.next(), Some('0'), "unexpected escape in {quoted:?}");
            bytes.push(0);
        } else {
            assert!(c.is_ascii(), "non-ASCII character in {quoted:?}");
            bytes.push(c as u8);
        }
    }
    bytes
}

fn expected<T: Clone>(entries: &[(&str, T)]) -> Vec<(String, T)> {
    entries
        .iter()
        .map(|(key, value)| (key.to_string(), value.clone()))
        .collect()
}

fn wide(value: usize) -> u64 {
    u64::try_from(value).unwrap()
}

#[test]
fn the_sdk_capacities_and_sizes_are_the_programs() {
    let pinned = [
        ("MIN_SEATS", wide(MIN_SEATS)),
        ("ORDERS_PER_SIDE", wide(ORDERS_PER_SIDE)),
        ("MAX_MARKETS", wide(MAX_MARKETS)),
        ("TOKENS", wide(TOKENS)),
        ("MAX_OPEN_ORDERS", wide(MAX_OPEN_ORDERS)),
        ("MAX_FILLS", wide(MAX_FILLS)),
        ("TAPE_FILLS", wide(TAPE_FILLS)),
        ("RESULTS", wide(RESULTS)),
        ("ORDER_KEYS", wide(ORDER_KEYS)),
        ("GROWTH_STEP", u64::from(GROWTH_STEP)),
        ("MAX_EXPIRY_AHEAD", u64::try_from(MAX_EXPIRY_AHEAD).unwrap()),
        ("SEAT_LEN", wide(size_of::<Seat>())),
        ("SEAT_SLOTS", wide(SEAT_SLOTS)),
        ("HEADER_LEN", wide(HEADER_LEN)),
        ("LEDGER_PREFIX", wide(LEDGER_PREFIX)),
        ("MAX_SEATS", wide(MAX_SEATS)),
        (
            "RECONCILE_SEATS_PER_CALL",
            u64::from(RECONCILE_SEATS_PER_CALL),
        ),
        ("EXTEND_SEATS_PER_CALL", u64::from(EXTEND_SEATS_PER_CALL)),
        ("RELEASE_SEATS_PER_CALL", u64::from(RELEASE_SEATS_PER_CALL)),
        (
            "RELAYOUT_SEATS_PER_CALL",
            u64::from(RELAYOUT_SEATS_PER_CALL),
        ),
        ("NO_SEAT", u64::from(NO_SEAT)),
        (
            "SNAPSHOT_SEAT_RESERVE",
            wide(size_of::<SeatSnapshot>() - SEAT_LEN - 16 - MAX_OPEN_ORDERS * 64),
        ),
        (
            "SNAPSHOT_LAYOUT_SLOTS",
            u64::from(noirwire_orderbook_engine::SNAPSHOT_LAYOUT_SLOTS),
        ),
        ("SEAT_SNAPSHOT_LEN", wide(size_of::<SeatSnapshot>())),
        ("LEGACY_SEAT_LEN", wide(size_of::<LegacySeat>())),
        ("LEGACY_LEDGER_PREFIX", wide(LEGACY_LEDGER_PREFIX)),
        ("LEGACY_SEATS", wide(LEGACY_SEATS)),
        ("LEGACY_LEDGER_LEN", wide(LEGACY_LEDGER_LEN)),
    ];
    for (name, value) in pinned {
        assert_eq!(number(&declaration(name)), value, "{name}");
    }
    assert_eq!(
        string_bytes(declaration("LEGACY_LEDGER_SEED").trim_matches('"')),
        LEGACY_LEDGER_SEED
    );
}

#[test]
fn the_sdk_account_sizes_tags_and_seeds_are_the_programs() {
    assert_eq!(
        numbers("ACCOUNT_LEN"),
        expected(&[
            ("ledger", wide(LedgerData::LEN)),
            ("book", wide(BookData::LEN)),
            ("market", wide(MarketData::LEN)),
            ("tape", wide(TapeData::LEN)),
            ("priceFeed", wide(PriceData::LEN)),
            ("stats", wide(StatsData::LEN)),
            ("view", wide(ViewData::LEN)),
        ])
    );
    assert_eq!(
        strings("ACCOUNT_TAG"),
        expected(&[
            ("ledger", LedgerData::TAG.to_vec()),
            ("book", BookData::TAG.to_vec()),
            ("market", MarketData::TAG.to_vec()),
            ("tape", TapeData::TAG.to_vec()),
            ("priceFeed", PriceData::TAG.to_vec()),
            ("stats", StatsData::TAG.to_vec()),
            ("view", ViewData::TAG.to_vec()),
        ])
    );
    assert_eq!(
        strings("SEEDS"),
        expected(&[
            ("exchange", EXCHANGE_SEED.to_vec()),
            ("custody", CUSTODY_SEED.to_vec()),
            ("ledger", LedgerData::SEED.to_vec()),
            ("stats", StatsData::SEED.to_vec()),
            ("book", BookData::SEED.to_vec()),
            ("market", MarketData::SEED.to_vec()),
            ("tape", TapeData::SEED.to_vec()),
            ("price", PriceData::SEED.to_vec()),
            ("view", ViewData::SEED.to_vec()),
        ])
    );
}

#[test]
fn the_sdk_result_codes_are_the_programs() {
    assert_eq!(
        numbers("RESULT_KIND"),
        expected(&[
            ("place", u64::from(RESULT_PLACE)),
            ("cancel", u64::from(RESULT_CANCEL)),
            ("cancelAll", u64::from(RESULT_CANCEL_ALL)),
            ("sync", u64::from(RESULT_SYNC)),
            ("liquidate", u64::from(RESULT_LIQUIDATE)),
            ("transfer", u64::from(RESULT_TRANSFER)),
            ("liquidateRange", u64::from(RESULT_LIQUIDATE_RANGE)),
        ])
    );
    assert_eq!(
        numbers("RESULT_STATUS"),
        expected(&[
            ("done", u64::from(STATUS_DONE)),
            ("filled", u64::from(STATUS_FILLED)),
            ("rested", u64::from(STATUS_RESTED)),
            ("remainderCancelled", u64::from(STATUS_REMAINDER_CANCELLED)),
            (
                "remainderCancelledStepLimit",
                u64::from(STATUS_REMAINDER_CANCELLED_STEP_LIMIT),
            ),
            (
                "remainderCancelledBookFull",
                u64::from(STATUS_REMAINDER_CANCELLED_BOOK_FULL),
            ),
            (
                "refusedPostOnlyWouldMatch",
                u64::from(STATUS_REFUSED_POST_ONLY_WOULD_MATCH),
            ),
            (
                "remainderCancelledFillCheck",
                u64::from(STATUS_REMAINDER_CANCELLED_FILL_CHECK),
            ),
            ("refused", u64::from(STATUS_REFUSED)),
        ])
    );
    assert_eq!(
        numbers("LIQUIDATION_STATUS"),
        expected(&[
            ("liquidated", u64::from(STATUS_LIQUIDATED)),
            (
                "stalePrice",
                u64::from(LiquidationStatus::StalePrice.code())
            ),
            (
                "liquidatorMarginInsufficient",
                u64::from(LiquidationStatus::LiquidatorMarginInsufficient.code()),
            ),
            ("nothingToLiquidate", u64::from(STATUS_NOTHING_TO_LIQUIDATE)),
            (
                "liquidatorSlotsFull",
                u64::from(STATUS_LIQUIDATOR_SLOTS_FULL),
            ),
        ])
    );
}

#[test]
fn the_sdk_seat_error_codes_are_the_programs() {
    use crate::errors::OrderbookError;

    let wire = |error: OrderbookError| u64::from(u32::from(error));
    assert_eq!(
        numbers("SEAT_ERROR"),
        expected(&[
            ("seatTableFull", wire(OrderbookError::SeatTableFull)),
            ("slotsFull", wire(OrderbookError::SlotsFull)),
            ("notSeated", wire(OrderbookError::NotSeated)),
            (
                "seatDepositTooSmall",
                wire(OrderbookError::SeatDepositTooSmall)
            ),
            ("layoutNotMigrated", wire(OrderbookError::LayoutNotMigrated)),
            ("alreadyMigrated", wire(OrderbookError::AlreadyMigrated)),
            ("ledgerTooLarge", wire(OrderbookError::LedgerTooLarge)),
            (
                "relayoutOutOfOrder",
                wire(OrderbookError::RelayoutOutOfOrder)
            ),
            ("relayoutMismatch", wire(OrderbookError::RelayoutMismatch)),
            (
                "relayoutIncomplete",
                wire(OrderbookError::RelayoutIncomplete)
            ),
        ])
    );
}

/// The address inside `new PublicKey("...")`.
fn address(name: &str) -> String {
    let text = declaration(name);
    let quoted = text
        .strip_prefix("new PublicKey(")
        .and_then(|rest| rest.trim().strip_suffix(')'))
        .map(|rest| rest.trim().trim_end_matches(',').trim())
        .unwrap_or_else(|| panic!("{name} is not a new PublicKey(...)"));
    quoted
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
        .unwrap_or_else(|| panic!("{name} does not name a string literal"))
        .to_string()
}

#[test]
fn the_sdk_price_source_constants_are_the_programs() {
    use crate::pyth::{PUSH_ORACLE_ID, RECEIVER_ID};
    use noirwire_orderbook_engine::{
        INCIDENT_MOVE_BEYOND_LIMIT, INCIDENT_SETTLED_GAP, ORACLE_DISLOCATED, ORACLE_HEALTHY,
        ORACLE_SETTLING,
    };

    assert_eq!(address("PYTH_RECEIVER_ID"), RECEIVER_ID.to_string());
    assert_eq!(address("PYTH_PUSH_ORACLE_ID"), PUSH_ORACLE_ID.to_string());
    assert_eq!(
        numbers("ORACLE_HEALTH"),
        expected(&[
            ("healthy", u64::from(ORACLE_HEALTHY)),
            ("dislocated", u64::from(ORACLE_DISLOCATED)),
            ("settling", u64::from(ORACLE_SETTLING)),
        ])
    );
    assert_eq!(
        numbers("INCIDENT_REASON"),
        expected(&[
            ("moveBeyondLimit", u64::from(INCIDENT_MOVE_BEYOND_LIMIT)),
            ("settledGap", u64::from(INCIDENT_SETTLED_GAP)),
        ])
    );
    assert_eq!(
        numbers("QUOTE_STATE"),
        expected(&[
            ("healthy", u64::from(QUOTE_HEALTHY)),
            ("depegged", u64::from(QUOTE_DEPEGGED)),
            ("unbound", u64::from(QUOTE_UNBOUND)),
        ])
    );
}

#[test]
fn the_sdk_access_constants_are_the_programs() {
    use crate::errors::OrderbookError;
    use noirwire_orderbook_engine::{ACCESS_MAKERS_LISTED, ACCESS_TAKERS_LISTED};

    assert_eq!(
        numbers("MARKET_ACCESS"),
        expected(&[
            ("makersListed", u64::from(ACCESS_MAKERS_LISTED)),
            ("takersListed", u64::from(ACCESS_TAKERS_LISTED)),
        ])
    );
    let wire = |error: OrderbookError| u64::from(u32::from(error));
    assert_eq!(
        numbers("ACCESS_ERROR"),
        expected(&[
            ("seatBlocked", wire(OrderbookError::SeatBlocked)),
            ("makerNotListed", wire(OrderbookError::MakerNotListed)),
            ("takerNotListed", wire(OrderbookError::TakerNotListed)),
        ])
    );
}

#[test]
#[should_panic(expected = "declares no NO_SUCH_CONSTANT")]
fn a_name_the_sdk_does_not_declare_fails_the_test() {
    number("MIN_SEATS * NO_SUCH_CONSTANT");
}

//! Which phase of the live data's layout each instruction runs in.
//!
//! `Exchange::layout` names the layout of the data the program keeps. An exchange the
//! earlier build made is `LAYOUT_V2`: its seats hold the bytes that build wrote, and some
//! of those bytes mean something else now. It becomes `LAYOUT_V3` only through
//! `activate_layout`, which is the one point of no return: until then this build writes
//! nothing the earlier build would misread, so redeploying that build is a safe abort.
//!
//! The rule for a `Gate::Both` instruction: before activation it writes only accounts that
//! did not exist then, or flags whose meaning did not change. Everything else is
//! `Gate::ActiveOnly`. `INSTRUCTION_GATES` is the one table, and every handler reads its own
//! row with `require_gate!`.

use anchor_lang::prelude::*;

use crate::errors::OrderbookError;
use crate::state::{Exchange, LAYOUT_V2, LAYOUT_V3};

/// The layouts an instruction may run under.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Gate {
    /// Before and after activation.
    Both,
    /// After activation only.
    ActiveOnly,
    /// Before activation only: the migration instructions.
    PreActivationOnly,
    /// After activation, except that an instruction acting on a trigger book also runs
    /// before it. The handler says which case it is: `require_gate!` takes a third
    /// argument for it, and every other call site counts as not a trigger book.
    ActiveOrTriggerBook,
}

/// Every instruction of the program and the layouts it runs under.
pub const INSTRUCTION_GATES: &[(&str, Gate)] = &[
    ("initialize_exchange", Gate::Both),
    ("update_exchange", Gate::ActiveOnly),
    ("set_paused", Gate::Both),
    ("propose_admin", Gate::Both),
    ("accept_admin", Gate::Both),
    ("register_token", Gate::ActiveOnly),
    ("delegate_exchange", Gate::Both),
    ("undelegate_exchange", Gate::Both),
    ("withdraw_exchange", Gate::ActiveOnly),
    ("create_ledger", Gate::ActiveOnly),
    ("finalize_ledger", Gate::ActiveOnly),
    ("release_empty_seats", Gate::ActiveOnly),
    ("create_market_v2", Gate::ActiveOnly),
    ("grow_account", Gate::ActiveOrTriggerBook),
    ("extend_ledger", Gate::ActiveOnly),
    ("create_trigger_book", Gate::Both),
    ("finalize_trigger_book", Gate::Both),
    ("finalize_market", Gate::ActiveOnly),
    ("update_market_v2", Gate::ActiveOnly),
    ("open_trader", Gate::ActiveOnly),
    ("open_trader_signed", Gate::ActiveOnly),
    ("set_order_keys", Gate::ActiveOnly),
    ("set_order_keys_signed", Gate::ActiveOnly),
    ("close_trader", Gate::ActiveOnly),
    ("deposit", Gate::ActiveOnly),
    ("withdraw", Gate::ActiveOnly),
    ("withdraw_by_key", Gate::ActiveOnly),
    ("place_order", Gate::ActiveOnly),
    ("cancel_order", Gate::ActiveOnly),
    ("cancel_all", Gate::ActiveOnly),
    ("sync_view", Gate::ActiveOnly),
    ("liquidate", Gate::ActiveOnly),
    ("liquidate_range", Gate::ActiveOnly),
    ("set_trigger", Gate::ActiveOnly),
    ("cancel_trigger", Gate::ActiveOnly),
    ("fire_triggers", Gate::ActiveOnly),
    ("sweep_triggers", Gate::ActiveOnly),
    ("sync_price", Gate::ActiveOnly),
    ("sync_quote", Gate::ActiveOnly),
    ("set_price_source_v2", Gate::ActiveOnly),
    ("set_quote_source_v2", Gate::ActiveOnly),
    ("publish_price", Gate::ActiveOnly),
    ("reset_price", Gate::ActiveOnly),
    ("cover_shortfall", Gate::ActiveOnly),
    ("cover_shortfall_range", Gate::ActiveOnly),
    ("reconcile_shortfall", Gate::ActiveOnly),
    ("transfer_between_balances", Gate::ActiveOnly),
    ("extend_compute", Gate::Both),
    ("resume_market", Gate::Both),
    ("move_fees_to_insurance", Gate::ActiveOnly),
    ("collect_fees", Gate::ActiveOnly),
    ("update_funding", Gate::ActiveOnly),
    ("schedule_funding", Gate::ActiveOnly),
    ("restrict_market", Gate::Both),
    ("fund_insurance", Gate::ActiveOnly),
    ("close_unused_trader", Gate::ActiveOnly),
    ("set_market_access", Gate::ActiveOnly),
    ("set_seat_access", Gate::ActiveOnly),
    ("scan_seat_layout", Gate::PreActivationOnly),
    ("activate_layout", Gate::PreActivationOnly),
];

const fn same(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut at = 0;
    while at < a.len() {
        if a[at] != b[at] {
            return false;
        }
        at += 1;
    }
    true
}

/// The row of `INSTRUCTION_GATES` for `name`. Evaluated at compile time by `require_gate!`,
/// so a handler naming an instruction the table lacks does not build.
pub const fn gate_of(name: &str) -> Gate {
    let mut at = 0;
    while at < INSTRUCTION_GATES.len() {
        if same(INSTRUCTION_GATES[at].0, name) {
            return INSTRUCTION_GATES[at].1;
        }
        at += 1;
    }
    panic!("the instruction is missing from INSTRUCTION_GATES")
}

/// Refuses unless the exchange's layout is one the named instruction runs under.
macro_rules! require_gate {
    ($exchange:expr, $name:literal) => {{
        const GATE: $crate::layout::Gate = $crate::layout::gate_of($name);
        $exchange.require_layout(GATE, false)
    }};
    ($exchange:expr, $name:literal, $trigger_book:expr) => {{
        const GATE: $crate::layout::Gate = $crate::layout::gate_of($name);
        $exchange.require_layout(GATE, $trigger_book)
    }};
}
pub(crate) use require_gate;

impl Exchange {
    /// Whether the layout is the one before activation.
    pub fn is_pre_activation(&self) -> bool {
        self.layout == LAYOUT_V2
    }

    /// Whether the layout is the active one.
    pub fn is_active(&self) -> bool {
        self.layout == LAYOUT_V3
    }

    /// Refuses with `LayoutNotActive` when `gate` needs the active layout and the exchange
    /// has not activated it, and with `LayoutAlreadyActive` when `gate` is a migration
    /// instruction and it has. A layout that is neither refuses everything.
    /// `trigger_book` is whether the call acts on a trigger book, which only
    /// `Gate::ActiveOrTriggerBook` reads.
    pub fn require_layout(&self, gate: Gate, trigger_book: bool) -> Result<()> {
        let allowed = match gate {
            Gate::Both => self.is_pre_activation() || self.is_active(),
            Gate::ActiveOnly => self.is_active(),
            Gate::ActiveOrTriggerBook => {
                self.is_active() || (trigger_book && self.is_pre_activation())
            }
            Gate::PreActivationOnly => {
                require!(!self.is_active(), OrderbookError::LayoutAlreadyActive);
                self.is_pre_activation()
            }
        };
        require!(allowed, OrderbookError::LayoutNotActive);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    const SOURCES: &[&str] = &[
        include_str!("instructions/access.rs"),
        include_str!("instructions/exchange.rs"),
        include_str!("instructions/funding.rs"),
        include_str!("instructions/oracle.rs"),
        include_str!("instructions/price_source.rs"),
        include_str!("instructions/setup.rs"),
        include_str!("instructions/trader.rs"),
        include_str!("instructions/trading.rs"),
        include_str!("instructions/treasury.rs"),
        include_str!("instructions/triggers.rs"),
        include_str!("instructions/migration.rs"),
    ];

    /// `text` after the first `{ ... }` block it opens, nested braces included. An item
    /// that ends in `;` before any `{` is skipped to its end. Empty when a block never closes.
    fn after_block(text: &str) -> &str {
        let open = match (text.find('{'), text.find(';')) {
            (Some(open), Some(end)) if end > open => open,
            (Some(open), None) => open,
            (_, Some(end)) => return &text[end + 1..],
            (None, None) => return "",
        };
        let mut depth = 0usize;
        for (at, ch) in text.char_indices().skip_while(|(at, _)| *at < open) {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return &text[at + 1..];
                    }
                }
                _ => {}
            }
        }
        ""
    }

    /// `source` as the compiler sees it outside tests: without `//` comments (doc comments
    /// included) and without items marked `#[cfg(test)]`.
    fn production(source: &str) -> String {
        let text = source
            .lines()
            .map(|line| line.split("//").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n");
        let mut kept = String::new();
        let mut rest = text.as_str();
        while let Some(at) = rest.find("#[cfg(test)]") {
            kept.push_str(&rest[..at]);
            rest = after_block(&rest[at + "#[cfg(test)]".len()..]);
        }
        kept.push_str(rest);
        kept
    }

    /// Every instruction `lib.rs` declares in its `#[program]` module, with the handler
    /// function it calls.
    fn declared() -> Vec<(String, String)> {
        let program = production(include_str!("lib.rs"));
        let module = program
            .split("pub mod noirwire_orderbook")
            .nth(1)
            .unwrap_or_default();
        module
            .split("pub fn ")
            .skip(1)
            .filter_map(|declaration| {
                let name = declaration.split('(').next()?;
                let handler = declaration.split("instructions::").nth(1)?;
                Some((name.to_owned(), handler.split('(').next()?.to_owned()))
            })
            .collect()
    }

    /// The body of the free function `handler`, braces excluded, in the production code of
    /// the instruction modules.
    fn handler_body(handler: &str) -> Option<String> {
        let marker = format!("pub fn {handler}(");
        SOURCES.iter().find_map(|source| {
            let code = production(source);
            let rest = &code[code.find(&marker)?..];
            let open = rest.find('{')?;
            let tail = after_block(&rest[open..]);
            let end = rest.len() - tail.len() - 1;
            Some(rest.get(open + 1..end)?.to_owned())
        })
    }

    /// The statements a handler may run before its gate: they bind the accounts, take its
    /// arguments apart, or read the exchange's own bytes to learn the layout. None of
    /// them writes anything or calls out.
    fn only_bindings(preamble: &str) -> bool {
        const BINDINGS: [&str; 4] = [
            "letaccounts=&ctx.accounts",
            "letaccounts=&mutctx.accounts",
            "letaccounts=ctx.accounts",
            "letstored=stored_exchange(&accounts.exchange)?",
        ];
        preamble
            .split(';')
            .map(|statement| statement.split_whitespace().collect::<String>())
            .filter(|statement| !statement.is_empty())
            .all(|statement| {
                BINDINGS.contains(&statement.as_str())
                    || (statement.starts_with("letLiquidationInput{")
                        && statement.ends_with("}=request"))
                    || (statement.starts_with("letTransferInput{")
                        && statement.ends_with("}=transfer"))
            })
    }

    /// Whether the body of `instruction`'s handler opens with a `require_gate!` for its own
    /// row, whose result is propagated, before anything but `only_bindings`.
    fn gated_first(instruction: &str, body: &str) -> core::result::Result<(), String> {
        let call = "require_gate!(";
        let at = body.find(call).ok_or("it has no require_gate!")?;
        if !only_bindings(&body[..at]) {
            return Err(format!("something runs before the gate: {}", &body[..at]));
        }
        let args = &body[at + call.len()..];
        let mut depth = 1usize;
        let close = args
            .char_indices()
            .find(|(_, ch)| {
                match ch {
                    '(' => depth += 1,
                    ')' => depth -= 1,
                    _ => {}
                }
                depth == 0
            })
            .map(|(close, _)| close)
            .ok_or("the call never closes")?;
        let named = args[..close].split(',').nth(1).map(str::trim);
        if named != Some(format!("\"{instruction}\"").as_str()) {
            return Err(format!("the gate names {named:?}, not its own row"));
        }
        if !args[close + 1..].trim_start().starts_with("?;") {
            return Err("the gate's result is not propagated with `?;`".to_owned());
        }
        Ok(())
    }

    #[test]
    fn every_instruction_of_the_program_has_exactly_one_row_in_the_table() {
        let declared: BTreeSet<String> = declared().into_iter().map(|(name, _)| name).collect();
        assert!(declared.len() > 50, "the lib.rs parse found {declared:?}");
        let rows: Vec<&str> = INSTRUCTION_GATES.iter().map(|(name, _)| *name).collect();
        let unique: BTreeSet<&str> = rows.iter().copied().collect();
        assert_eq!(rows.len(), unique.len(), "a row is listed twice");
        for name in &declared {
            assert!(
                unique.contains(name.as_str()),
                "{name} has no row in INSTRUCTION_GATES"
            );
        }
        for name in &unique {
            assert!(
                declared.contains(*name),
                "{name} is in INSTRUCTION_GATES but not in lib.rs"
            );
        }
    }

    /// The two instructions with no exchange account to read the layout from: one creates
    /// the exchange, and the other takes no account at all and writes nothing.
    const WITHOUT_AN_EXCHANGE: [&str; 2] = ["initialize_exchange", "extend_compute"];

    #[test]
    fn every_handler_with_an_exchange_opens_with_the_gate_of_its_own_row() {
        let mut checked = 0;
        for (name, handler) in declared() {
            if WITHOUT_AN_EXCHANGE.contains(&name.as_str()) {
                continue;
            }
            let body = handler_body(&handler)
                .unwrap_or_else(|| panic!("no handler `{handler}` for {name}"));
            if let Err(why) = gated_first(&name, &body) {
                panic!("{name} ({handler}): {why}");
            }
            checked += 1;
        }
        assert_eq!(checked, INSTRUCTION_GATES.len() - WITHOUT_AN_EXCHANGE.len());
    }

    #[test]
    fn the_gate_check_rejects_a_comment_a_late_gate_another_row_and_a_dropped_result() {
        let good = "let accounts = &ctx.accounts; require_gate!(accounts.exchange, \"deposit\")?; work()?;";
        assert_eq!(gated_first("deposit", good), Ok(()));
        let commented = production("// require_gate!(x, \"deposit\")?;\nwork()?;");
        assert!(gated_first("deposit", &commented).is_err(), "a comment");
        let late = "work()?; require_gate!(x, \"deposit\")?;";
        assert!(gated_first("deposit", late).is_err(), "after other work");
        let copied = "require_gate!(x, \"withdraw\")?;";
        assert!(gated_first("deposit", copied).is_err(), "another row");
        let dropped = "require_gate!(x, \"deposit\"); work()?;";
        assert!(gated_first("deposit", dropped).is_err(), "no `?`");
        let in_a_test = production("#[cfg(test)]\nmod tests {\n    fn t() { require_gate!(x, \"deposit\")?; }\n}\nfn real() { work()?; }");
        assert!(gated_first("deposit", &in_a_test).is_err(), "a test module");
        let third = "require_gate!(x, \"grow_account\", kind == 3)?;";
        assert_eq!(gated_first("grow_account", third), Ok(()));
    }

    /// The calls into the rollup's account program that go through the magic program.
    const MAGIC_CALLS: [&str; 6] = [
        "ephemeral::create",
        "ephemeral::grow",
        "ephemeral::seal",
        "ephemeral::reserve_for_owner",
        "ephemeral::close",
        "ephemeral::close_permission",
    ];

    /// The free functions of `code` with their text, which runs to the next one.
    fn functions(code: &str) -> Vec<(String, String)> {
        let mut starts: Vec<(usize, usize)> = ["\npub fn ", "\npub(crate) fn ", "\nfn "]
            .iter()
            .flat_map(|prefix| code.match_indices(prefix).map(|(at, _)| (at, prefix.len())))
            .collect();
        starts.sort_unstable();
        starts
            .iter()
            .enumerate()
            .map(|(index, (at, prefix))| {
                let end = starts.get(index + 1).map_or(code.len(), |(next, _)| *next);
                let text = &code[at + prefix..end];
                let name = text
                    .chars()
                    .take_while(|ch| ch.is_alphanumeric() || *ch == '_')
                    .collect();
                (name, text.to_owned())
            })
            .collect()
    }

    /// Every handler that creates, grows, seals or closes an account through the rollup,
    /// directly or through a function of its module, with the accounts struct it takes.
    fn magic_handlers(code: &str) -> Vec<(String, String)> {
        let functions = functions(code);
        let mut using: BTreeSet<&str> = functions
            .iter()
            .filter(|(_, text)| MAGIC_CALLS.iter().any(|call| text.contains(call)))
            .map(|(name, _)| name.as_str())
            .collect();
        loop {
            let calling: Vec<&str> = functions
                .iter()
                .filter(|(name, text)| {
                    !using.contains(name.as_str())
                        && using
                            .iter()
                            .any(|callee| text.contains(&format!("{callee}(")))
                })
                .map(|(name, _)| name.as_str())
                .collect();
            if calling.is_empty() {
                break;
            }
            using.extend(calling);
        }
        functions
            .iter()
            .filter(|(name, _)| using.contains(name.as_str()))
            .filter_map(|(name, text)| {
                let context = text.split("Context<").nth(1)?.split('>').next()?;
                Some((name.clone(), context.to_owned()))
            })
            .collect()
    }

    #[test]
    fn every_accounts_struct_whose_handler_calls_into_the_rollup_names_the_magic_program() {
        let mut checked = 0;
        for source in SOURCES {
            let code = production(source);
            for (handler, context) in magic_handlers(&code) {
                let header = format!("pub struct {context}<'info>");
                let at = code
                    .find(&header)
                    .unwrap_or_else(|| panic!("{handler}: no struct {context}"));
                let rest = &code[at..];
                let block = &rest[..rest.len() - after_block(rest).len()];
                assert!(
                    block.contains("pub magic_program:") && block.contains("MAGIC_PROGRAM_ID"),
                    "{handler} calls into the rollup but {context} does not name the magic \
                     program at its fixed address"
                );
                checked += 1;
            }
        }
        assert!(checked >= 10, "only {checked} handlers were found");
    }

    #[test]
    fn the_phase_before_activation_runs_only_what_writes_no_seat_or_price_data() {
        let before: Vec<&str> = INSTRUCTION_GATES
            .iter()
            .filter(|(_, gate)| *gate != Gate::ActiveOnly)
            .map(|(name, _)| *name)
            .collect();
        assert_eq!(
            before,
            [
                "initialize_exchange",
                "set_paused",
                "propose_admin",
                "accept_admin",
                "delegate_exchange",
                "undelegate_exchange",
                "grow_account",
                "create_trigger_book",
                "finalize_trigger_book",
                "extend_compute",
                "resume_market",
                "restrict_market",
                "scan_seat_layout",
                "activate_layout",
            ]
        );
    }

    fn exchange(layout: u32) -> Exchange {
        crate::state::test_exchange(layout)
    }

    #[test]
    fn a_gate_admits_the_layouts_it_names_and_refuses_the_rest_with_the_matching_error() {
        let before = exchange(LAYOUT_V2);
        let active = exchange(LAYOUT_V3);
        let unknown = exchange(0);
        let not_active = error!(OrderbookError::LayoutNotActive);
        let already = error!(OrderbookError::LayoutAlreadyActive);

        for trigger_book in [false, true] {
            assert!(before.require_layout(Gate::Both, trigger_book).is_ok());
            assert!(active.require_layout(Gate::Both, trigger_book).is_ok());
            assert_eq!(
                unknown
                    .require_layout(Gate::Both, trigger_book)
                    .unwrap_err(),
                not_active
            );

            assert_eq!(
                before
                    .require_layout(Gate::ActiveOnly, trigger_book)
                    .unwrap_err(),
                not_active
            );
            assert!(active
                .require_layout(Gate::ActiveOnly, trigger_book)
                .is_ok());
            assert_eq!(
                unknown
                    .require_layout(Gate::ActiveOnly, trigger_book)
                    .unwrap_err(),
                not_active
            );

            assert!(before
                .require_layout(Gate::PreActivationOnly, trigger_book)
                .is_ok());
            assert_eq!(
                active
                    .require_layout(Gate::PreActivationOnly, trigger_book)
                    .unwrap_err(),
                already
            );
            assert_eq!(
                unknown
                    .require_layout(Gate::PreActivationOnly, trigger_book)
                    .unwrap_err(),
                not_active
            );
        }
    }

    #[test]
    fn a_trigger_book_call_runs_before_activation_and_every_other_call_of_its_row_does_not() {
        let (before, active, unknown) = (exchange(LAYOUT_V2), exchange(LAYOUT_V3), exchange(0));
        let gate = Gate::ActiveOrTriggerBook;
        assert!(before.require_layout(gate, true).is_ok());
        assert!(active.require_layout(gate, true).is_ok());
        assert!(active.require_layout(gate, false).is_ok());
        assert_eq!(
            before.require_layout(gate, false).unwrap_err(),
            error!(OrderbookError::LayoutNotActive)
        );
        assert_eq!(
            unknown.require_layout(gate, true).unwrap_err(),
            error!(OrderbookError::LayoutNotActive)
        );
    }
}

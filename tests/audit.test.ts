/**
 * The order book's story, then the audit's proofs that need the local network.
 * Each audit part builds on the state the story left. The ledger's growth
 * comes last: it leaves the ledger at its limit.
 */
import "./orderbook.test";
import "./audit/custody-collect-into-custody";
import "./audit/custody-foreign-validator";
import "./audit/oracle-burst-and-reset";
import "./audit/program-auth-seat-probe";
import "./audit/availability-privacy-network";
import "./audit/census-valuation-accounts";
import "./audit/census-custody-substitution";
import "./audit/pre-deposit-limits";
import "./audit/r4-limits";
import "./audit/access-lists";
import "./audit/seat-lifecycle";
import "./audit/seat-capacity";

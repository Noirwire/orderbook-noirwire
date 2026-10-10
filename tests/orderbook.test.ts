/**
 * The order book's behaviour, as sentences, against the local network. It is
 * one story: every part builds on the state the parts before it left, so the
 * order below is the order they run in, and no part runs alone.
 */
import "./orderbook/instruction-builders";
import "./orderbook/exchange-on-solana";
import "./orderbook/set-up";
import "./orderbook/trader";
import "./orderbook/orders";
import "./orderbook/spot";
import "./orderbook/perp";
import "./orderbook/reserved-seats";
import "./orderbook/margin";
import "./orderbook/authority";
import "./orderbook/latency";

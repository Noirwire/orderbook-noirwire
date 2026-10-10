# How it compares

Measured numbers for this order book beside what other venues publish about themselves.
Every figure says where it was measured. A number from one laptop is not a network
number, and a number from a client beside the servers is not what a trader far away sees.

Last updated 2026-10-09. Nothing here is from a real-money network.

## Speed

| Venue | What was measured | Result | Where it was measured |
| --- | --- | --- | --- |
| Hyperliquid | Order, end to end | median 0.2 s, 99th percentile 0.9 s | Their own docs: "from a geographically co-located client" |
| Hyperliquid | Throughput | about 200,000 orders a second | Their own docs, mainnet |
| This order book | Order, send to result in the trader's own account | median 5 ms, 99th percentile 8 ms, 300 orders one after another | One laptop, everything local |
| This order book | 20 traders for 60 s through the service | 13,049 orders sent, 13,049 confirmed, none late; 217 a second; median 39 ms, 99th percentile 61 ms | One laptop, everything local |
| This order book | Browser click to result, 30 market orders | median 33 ms, 95th percentile 50 ms | One laptop, everything local |
| This order book | A market order on the hosted test network, send to result, result pushed to the client | median 341 ms, 95th percentile 407 ms, 30 orders, 29 filled | A laptop in Europe to MagicBlock's devnet server; a plain round trip in the same run was 220 ms |
| This order book | 10 traders for 2 minutes on the hosted test network, one order at a time each, older client that polled for results | 932 sent, 932 confirmed, 7.7 a second, median 535 ms, 95th percentile 814 ms | The same laptop; the shared test server slowed later that morning and larger steps degraded (the simulation service's `docs/LOADTEST-devnet.md`) |
| The hosted test network alone | Plain round trip | median 209 ms | The same laptop |

Sources: Hyperliquid's figures are quoted from
`hyperliquid.gitbook.io/hyperliquid-docs/hypercore/overview`, read 2026-10-09. Ours come
from `tests/orderbook.test.ts`, the simulation service's load test, the terminal's browser
tests, and `make devnet-smoke`.

How to read it:

- On one machine the order book answers in a few milliseconds. That shows the matching
  itself is not the limit.
- From Europe a round trip to the hosted test server is about 220 ms. Hyperliquid's 0.2 seconds is measured beside its
  servers; ours beside MagicBlock's server has not been measured yet. Until it has, the two
  are not comparable and this document does not say they are.
- On the hosted test network an order now costs one request and its result is pushed back, so it lands about 120 ms above a plain round trip.
- Throughput on the hosted test network was measured only from one laptop against a shared test server: about 8 to 10 confirmed orders a second, with latency rising as traders were added. That is not a ceiling of the venue and is not presented as one.

## What others can see

| | Hyperliquid | Phoenix, OpenBook, Manifest | Drift (now Velocity), Mango | This order book |
| --- | --- | --- | --- | --- |
| Resting orders and depth | Public | Public | Public | Hidden |
| Balances and positions | Public | Public | Public | Hidden |
| Each trade's price, size and time | Public | Public | Public | Public |
| Who placed an order | Public (the account) | Public | Public | A key used once per order |
| Refusals that reveal the book (for example "post only would cross") | Public errors | Public errors | Public errors | Recorded privately, never an error |

Checked on the hosted test network on 2026-10-09: an anonymous caller and a signed-in
stranger read nothing from the ledger, a book, or another trader's account. The secrecy
is enforced by MagicBlock's access-controlled endpoint and sealed hardware, not by
cryptography this program can verify. `DESIGN.md` section 1 lists what still leaks:
trades, timing, and anything the operator of the rollup could see.

## Rules, against the code of established venues

Read in their source on 2026-10-09 (Drift v2 and its successor Velocity, Mango v4,
Phoenix v1, OpenBook v2, Manifest, dYdX v4; Hyperliquid from its docs only).

| Rule | Others | This order book |
| --- | --- | --- |
| Margin check on every fill, both sides | dYdX: both sides, skip the maker or stop the taker. Drift: the whole fill reverts. Mango: taker only | Both sides; a failing maker is cancelled and matching continues, a failing taker stops |
| A fill can never leave an account owing more than it has | Not stated as a standalone rule in any of them | Stated, and asserted after every operation in the tests |
| Resting orders far from the mark | Drift cancels them when matching reaches them; Mango checks only at posting | Cancelled when matching reaches them |
| Full book | Phoenix, Mango and OpenBook evict another trader's order | Refuses; never evicts |
| Order expiry | Optional on most; Drift's limit orders default to none | Mandatory on every instruction, at most 60 s; optional on resting orders |
| Liquidation size | Drift: sized to restore margin; dYdX: per-block limits | Sized to restore margin plus a buffer |
| Insurance | Drift and dYdX route liquidation fees to it | A share of every fee and penalty |
| Bad debt beyond insurance | Spread over positions (Drift, Mango) or opposite positions closed (dYdX) | Not built: recorded, market reduce-only, withdrawals frozen |
| Price feed | Signed feeds with confidence and staleness guards | One key, bounded step and age: a test-network arrangement |

Where this order book is weaker than all of them is written in `RULES.md` section 12b
and `SECURITY.md`. It has not been audited.

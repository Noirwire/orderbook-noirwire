# NoirWire order book: design

A private order book for spot and perpetual markets. Orders rest and match inside a
MagicBlock Private Ephemeral Rollup. Nobody but the program can read the book.

This document is the contract between the program, its TypeScript client, the
simulation services and the trading terminal. Change it first, then the code.

Status: draft. Items marked **SPIKE** are decided by a measurement, not by this text.

## 1. What is hidden and what is public

| Hidden (private accounts) | Public |
| --- | --- |
| Every resting order: price, size, side, owner | Each market's settings |
| Book depth | The tape: price, size, time and two opaque tags per fill |
| Every trader's balances, positions and open orders | The price feed (mark price) |
| Who traded with whom | Counters: orders, fills, volume, open interest |

A fill carries the maker's and the taker's order tag. A tag is a random 64-bit number
the trader's client chose when placing the order. Only that client recognises it, so a
trader learns of a fill from the public tape without the tape naming anyone.

## 2. Accounts

| Account | Where | Readable by | Holds |
| --- | --- | --- | --- |
| `Exchange` | Solana, never delegated | everyone | admin, pending admin, gate key, oracle authority, pause flag, fee settings, collateral mint, limits |
| `Sponsor` | delegated | everyone | lamports that pay rent for accounts created inside the rollup |
| `Ledger` | rollup, private, no members | the program only | one seat per trader: collateral, spot balances, perp positions, funding checkpoints, locked amounts, open order count |
| `Book` (one per market) | rollup, private, no members | the program only | bids and asks in price-time order, next order sequence, funding index, open interest |
| `Market` (one per market) | rollup, public | everyone | kind (spot or perp), names, tick size, lot size, margin ratios, fee overrides, status |
| `Tape` (one per market) | rollup, public | everyone | ring of the latest fills, last price, 24h rolling volume buckets |
| `PriceFeed` (one per market) | rollup, public | everyone | price, publish time, written by the oracle authority |
| `Stats` | rollup, public | everyone | lifetime counters across markets |
| `TraderView` (one per trader) | rollup, private, member = the trader | that trader only | a copy of the trader's seat and their open orders |

"Private, no members" relies on MagicBlock's rule that a permission with an empty member
list makes the account fully restricted while the owning program still reads and writes
it. **SPIKE 1** proves it.

The `Ledger` holds every trader's state so that a taker's transaction can settle both
sides of a fill without naming the maker's account, which the taker cannot know.
`TraderView` exists because a trader cannot read the `Ledger`. It is refreshed by the
trader's own instructions and by `sync_view`, which costs nothing in the rollup.

Capacities for the first version: 4,096 seats, 1,024 resting orders per side per market,
32 open orders per trader per market, 8 markets, 512 fills on a tape.

## 3. Instructions

Administration (Solana): `initialize_exchange`, `update_exchange`, `propose_admin`,
`accept_admin`, `set_paused`, `create_market`, `update_market`, sponsor fund / delegate /
undelegate / withdraw.

Rollup:

| Instruction | Signers | Does |
| --- | --- | --- |
| `open_trader` | trader, gate | creates the seat and the `TraderView` with its owner-only permission, in one instruction |
| `deposit` | depositor | moves collateral or a spot token into custody and credits a seat (the depositor need not be the seat's owner) |
| `withdraw` | trader | checks margin, debits the seat, pays out |
| `place_order` | trader | validates, locks funds or checks margin, matches against the book up to a fill limit, rests the remainder if the order type allows |
| `cancel_order`, `cancel_all` | trader | removes resting orders, unlocks funds |
| `sync_view` | trader | copies the seat and open orders into the `TraderView` |
| `publish_price` | oracle authority | writes a `PriceFeed` |
| `update_funding` | anyone | advances a perp market's funding index, at most once per interval |
| `liquidate` | liquidator | takes over an unhealthy trader's position at the mark price less a penalty |
| `close_trader` | trader | closes an empty seat and returns rent to the sponsor |

Order types: limit (good till cancelled, post only, immediate or cancel) and market
(immediate or cancel with a worst price). Perp orders may be reduce-only. An order that
would trade against its owner's own resting order cancels the resting one.

Matching is price-time priority and happens inside `place_order`. There is no separate
matching tick.

## 4. Money rules

- All amounts are integers. Prices are in quote units per base lot. No floating point.
- Every arithmetic step is checked. An overflow fails the instruction.
- **Spot:** placing an order locks what it could spend. A fill moves base and quote
  between two seats. Unlocking on cancel returns exactly what remains locked.
- **Perps:** one cross-margin account per trader, collateral in the quote token.
  Equity = collateral + unrealised profit - unpaid funding. An order is accepted only
  if equity covers initial margin for the resulting position plus open orders. A
  position is liquidatable when equity falls below maintenance margin.
- **Funding:** each perp market keeps a cumulative funding index. A seat pays or
  receives the difference since its checkpoint whenever its position is touched.
- **Liquidation:** the liquidator receives the position at the mark price and a penalty
  from the liquidated trader's collateral. Negative equity is taken from the insurance
  seat. If that is empty the market is paused.
- **Fees:** a taker fee in basis points goes to the fee seat. Makers pay nothing.
- **Invariant, tested after every instruction in the test suite:** for each token, the
  sum of all seats' balances plus locked amounts equals custody. For each perp market,
  long size equals short size and the sum of realised profit and funding is zero less fees.
- A stale `PriceFeed` (older than the market's limit) blocks orders that increase
  exposure, withdrawals and liquidations on that market.

## 5. Custody

Tokens are held as Ephemeral SPL Token balances inside the rollup, in token accounts
owned by a program address. The program signs every payout. **SPIKE 4** proves the token
program works on the local network and on the devnet private validator.

For a real-money deployment the open question is whether custody stays there or moves
to a vault on Solana with a recomputed fill commitment. That is deliberately not built.

## 6. Trust

- The rollup validator can stall or censor. It cannot move tokens except through this
  program's instructions.
- There is no way today to pull delegated accounts back to Solana without the validator.
- The price feed is written by one key. Its only power is to set the mark price; margin
  ratios bound what a wrong price can take in one step, and a pause stops the market.
- The admin can pause, change fees within fixed bounds and add markets. The admin cannot
  move a trader's funds. The program's upgrade authority can do anything and belongs on
  a multisig before real money.

## 7. Spikes (answered before the program is written)

1. A private account with no members: the program reads and writes it; a read over the
   network by any key returns nothing.
2. A transaction that touches private accounts: can a stranger fetch it, its
   instruction data or its logs?
3. A zero-copy account of 1 MB created inside the rollup, or delegated: is it allowed,
   what does it cost, how many compute units does a 10-fill match use?
4. The Ephemeral SPL Token program: present on the local network? A program-signed
   transfer between two token accounts in the rollup works?
5. Websocket account subscriptions on the rollup endpoint for a public account.
6. Throughput and latency: transactions per second from one sender and from many,
   median and 99th percentile time to confirmation, on the local network.
7. The built-in scheduler (`ScheduleTask`): runs locally? at what smallest interval?

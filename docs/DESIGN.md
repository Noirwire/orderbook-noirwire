# NoirWire order book: design

A private order book for spot and perpetual markets. Orders rest and match inside a
MagicBlock Private Ephemeral Rollup. Nobody but the program can read the book.

This document is the contract between the program, its TypeScript client, the
simulation service and the trading terminal. The money rules are in `RULES.md`. The
measurements this design rests on are in `SPIKE.md`. Change the documents first, then
the code.

## 1. What is hidden, what is public, what leaks

| Hidden                                                         | Public                                                                 |
| -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Every resting order: price, size, side, owner                  | Each market's settings                                                 |
| Book depth                                                     | The tape: price, size, time and two one-off receipts per fill          |
| Every trader's balances, positions and open orders             | The price feed (mark price)                                            |
| The content of every trading transaction: accounts, data, logs | Counters: orders, fills, volume (liquidations excluded), open interest                         |
| Which trader sent which order                                  | That some transaction touched the program, when, and whether it failed |

Three limits, stated plainly:

1. **The secrecy is enforced by the rollup's query filter.** The validator's own
   network port serves everything. On a hosted private validator that port is not
   reachable; that is the operator's promise and its sealed hardware, not something
   this program can check.
2. **Trades are visible.** The tape shows each fill's price, size and time. What is
   private is what has not traded yet, and who holds what.
3. **Timing is visible.** Anyone can list the signatures that touched the program,
   with their time. So an observer sees that an order arrived when a fill printed.
   One-time order keys (section 4) stop that from identifying the trader.

## 2. Accounts

All state accounts are created inside the rollup and paid for by the `Exchange`
account. An account above 10,240 bytes is created small and grown in steps; the
program refuses to use it until it has its full size and is marked ready.

| Account                      | Readable by      | Holds                                                                           |
| ---------------------------- | ---------------- | ------------------------------------------------------------------------------- |
| `Exchange`                   | everyone         | admin, pending admin, gate key, oracle authority, pause flag, limits; pays rent |
| `Ledger`                     | the program only | one seat per trader (engine state)                                              |
| `Book`, one per market       | the program only | bids and asks, sequences, funding index                                         |
| `Market`, one per market     | everyone         | kind, names, tick, lot, margins, fees, limits, status                           |
| `Tape`, one per market       | everyone         | ring of the latest fills, last price                                            |
| `PriceFeed`, one per market  | everyone         | price and publish time                                                          |
| `Stats`                      | everyone         | lifetime counters                                                               |
| `TraderView`, one per trader | that trader only | their seat copy, open orders, order results, order keys                         |
| custody token accounts | the program only when sealed, anyone when the token is registered public | the tokens backing every seat |

"The program only" is a permission that is private with no members. A trader cannot
read the `Ledger`, so `TraderView` carries everything a trader needs. The program
never reads a `TraderView` to make a money decision, except to check an order key.

## 3. What a trader can learn about their own order

A transaction that touches the sealed book shows nothing to anyone, its sender
included: no logs, no data, no result. So every instruction a trader sends writes its
outcome into their `TraderView`:

- the latest order results (client order id, status, filled size and notional, rested
  size, fee, order sequence if it rests), newest first, a ring of 16;
- the seat copy and the open order list, with the seat's version number.

A resting order that is filled later changes the seat but not the view. The client
recognises its own fills on the public tape by their receipts (`RULES.md` section 10)
and calls `sync_view`.

## 4. Keys

- **Owner key.** Opens the account, withdraws, closes, replaces order keys. It also
  signs in to the rollup to read the `TraderView`.
- **Order keys.** A `TraderView` holds four order keys. Every trading instruction
  (place, cancel, cancel all, sync) is signed by one of them, with no other signer,
  and replaces that key with a new one given in the instruction. A key is therefore used once. That is about linkability, not about limiting a thief: whoever holds a leaked order key names the next key, so the exposure lasts until the owner replaces all four with `set_order_keys`. An observer who lists signatures sees a different, never-seen key on
  every order and cannot link two orders to each other or to an owner.
- An order key that was already used is gone, so a transaction cannot be replayed. A
  client that does not see its order result resends the same signed transaction.
- Every trading instruction carries an expiry time. The program refuses it once that time has passed (the expiry bounds when an instruction may execute, not when it was signed), because the rollup can execute a transaction long after it was
  sent (`SPIKE.md`, follow-up on question 6). A refused instruction changes nothing,
  so its order key is still live for the next attempt.
- Fees in the rollup are zero and a key with no lamports can sign.

## 5. Instructions

Setup, on Solana, by the program's upgrade authority: `initialize_exchange`, fund,
delegate, undelegate, withdraw.

Administration, in the rollup, by the admin: `update_exchange`, `propose_admin`,
`accept_admin`, `set_paused`, `create_ledger`, `create_market`, `grow_account`,
`finalize_market`, `update_market`, `restrict_market`, `resume_market`, `reset_price`, `fund_insurance`, `close_unused_trader`, custody set-up and custody visibility per token. The collateral token is fixed when the exchange is created and can never be changed.

| Instruction                  | Signers                            | Does                                                                              |
| ---------------------------- | ---------------------------------- | --------------------------------------------------------------------------------- |
| `open_trader`                | owner, gate                        | creates the seat and the `TraderView` with its permission and four order keys     |
| `deposit`                    | depositor                          | moves tokens into custody and credits the seat of the named owner; the depositor need not be that owner; the fee and insurance seats cannot be deposited into |
| `withdraw`                   | owner                              | checks margin, debits the seat, pays out to the owner's token account             |
| `place_order`                | an order key                       | checks, matches, rests the remainder, writes the result to the view               |
| `cancel_order`, `cancel_all` | an order key                       | removes resting orders, releases funds                                            |
| `sync_view`                  | an order key                       | copies the seat and open orders into the view                                     |
| `set_order_keys`             | owner                              | replaces all four order keys                                                      |
| `publish_price`              | oracle authority                   | writes a `PriceFeed`                                                              |
| `update_funding`             | anyone, and the built-in scheduler | advances a perp market's funding index, at most once per interval                 |
| `liquidate`                  | an order key of the liquidator     | takes over an unhealthy position; every "nothing to liquidate" case is recorded as one code, in the liquidator's view only                                                  |
| `close_trader`               | owner                              | closes an empty seat and its view                                                 |

Refusals that depend on the book are outcomes written to the view, never errors
(`RULES.md` section 3). Every instruction that needs no signer is cheap and does
nothing when called again inside its interval.

## 6. Custody

Tokens are Ephemeral SPL Token balances inside the rollup. There they are ordinary SPL
token accounts at ordinary associated addresses, moved with ordinary SPL transfers.
Custody is a token account per token owned by a program address. Each token is registered with sealed or public custody, a choice the exchange records and never changes: sealed needs a private permission nobody reads through, public needs no permission at all, and the program verifies either when the token is registered. Public custody shows the token's total in custody, and so the size and time of every deposit and withdrawal. The test network uses public custody, because MagicBlock's hosted endpoint refuses a program other than the token program that names a private token balance (`spike/devnet/README.md`). The program signs every payout. `deposit` and `withdraw` move tokens and
change the seat in the same instruction.

Not proven yet: withdrawing from the rollup back to Solana. Not built on purpose: a
vault on Solana with recomputed fill commitments, which is the question to settle
before real money.

## 7. Trust

- The rollup operator orders transactions, can delay or drop them, and guards the
  filter. It cannot move tokens except through this program.
- There is no way today to pull rollup state back to Solana without the operator.
- The price feed is written by one key, bounded by a maximum move per update and a
  maximum age. That is a test-network arrangement.
- The admin can pause, add markets and change market settings within fixed bounds. The
  admin cannot move a trader's funds.
- The upgrade authority can change the program and so can do anything. It is part of the custody trust model, and it is a different key from the exchange admin: changing one does not change the other. It belongs on a
  multisig before real money.
- Fees are zero, so nothing in the rollup limits spam. The limits are a daily cap on new seats, the gate key on
  `open_trader`, the open-order limit per trader, the price band and the minimum order
  size.

## 8. Capacities

2,048 seats, 1,024 resting orders per side per market, 8 markets, 32 open orders per
trader per market, at most 32 fills per order, 512 fills on a tape. The hosted
validator's storage limit for large accounts is unknown; these sizes keep the total
under 3 MB.

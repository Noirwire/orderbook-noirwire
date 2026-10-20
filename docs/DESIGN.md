# NoirWire order book: design

A private order book for spot and perpetual markets. Orders rest and match inside a
MagicBlock Private Ephemeral Rollup. Through the rollup's access-controlled endpoint, nobody but the program can read the book; section 1 says what that rests on.

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

Five limits, stated plainly:

1. **The secrecy is enforced by the rollup's query filter.** The validator's own
   network port serves everything. On a hosted private validator that port is not
   reachable; that is the operator's promise and its sealed hardware, not something
   this program can check.
2. **Trades are visible.** The tape shows each fill's price, size and time. What is
   private is what has not traded yet, and who holds what.
3. **Timing is visible.** Anyone can list the signatures that touched the program,
   with their time. So an observer sees that an order arrived when a fill printed.
   One-time order keys (section 4) remove the reusable key that would otherwise tie a trader's orders together. They do not make a trader unlinkable: fills, timing, deposits and withdrawals, and whatever the rollup's operator can see, can still link activity.
4. **A trader can find the best price of each side.** A post-only order that would
   match is refused as an outcome only its sender reads (`RULES.md` section 3), so a
   seat that sends real orders can halve the crossing band with each one: about
   log2(2 x `band_bps` x mark / (10,000 x tick)) orders find the best ask or the best
   bid to the tick, 7 at the deployment's settings, with no fill, no fee and no tape
   entry. It learns that one price per side and nothing else: not its size, not the
   depth behind it, not its owner, and nothing beyond the band, where a best price
   reads only as "further than the band". The public order counter and the signature
   list show that someone is sending orders, not what they learned.
5. **Signature lists show the market, not the instruction.** Anyone can list the
   signatures of a public account: the list holds every transaction that names it,
   writable or read-only. Every instruction an order key signs (`place_order`,
   `cancel_order`, `cancel_all`, `sync_view`, `liquidate`,
   `transfer_between_balances`) names the same accounts with the same flags: the
   exchange, the ledger, the signer's view, one market with its book, price feed and
   tape, the `Stats` account, and the market, book and price feed of every other perp
   market. None names the compute budget program (section 8). So from the lists a
   stranger can tell that an order-key transaction named a market, when, and whether
   it failed, and not which of these instructions it was. The client's
   `transfer_between_balances` names the lowest perp market. What the public accounts
   hold can still tell: every `place_order` moves the order counter in `Stats`, a fill
   prints on the tape, and a liquidation can move open interest (`SECURITY.md`), so a
   stranger who watches them at a quiet moment can tell an order from a cancel by its
   effects.

## 2. Accounts

The `Exchange` is created on Solana by the upgrade authority, which pays for it, and
then moved into the rollup. Every other state account, and the permission of each,
is created inside the rollup and paid for by the `Exchange`, which also gets the rent
back when a trader's view is closed. Custody token accounts are ordinary token
accounts that the set-up creates (section 6). An account above 10,240 bytes is
created small and grown in steps; the program refuses to use it until it has its full
size and is marked ready.

| Account                      | Readable by      | Holds                                                                           |
| ---------------------------- | ---------------- | ------------------------------------------------------------------------------- |
| `Exchange`                   | everyone         | admin, pending admin, gate key, oracle authority, pause flag, limits, each token's custody cap; pays rent |
| `Ledger`                     | the program only | one seat per trader (engine state)                                              |
| `Book`, one per market       | the program only | bids and asks, sequences, funding index                                         |
| `Market`, one per market     | everyone         | kind, names, tick, lot, margins, fees, limits (open interest and position caps among them), status |
| `Tape`, one per market       | everyone         | ring of the latest fills, last price                                            |
| `PriceFeed`, one per market  | everyone         | price, publish time and the rollup time it was accepted                         |
| `Stats`                      | everyone         | lifetime counters; orders, fills and volume stop at their largest value rather than fail a trade (`RULES.md`) |
| `TraderView`, one per trader | that trader only | their seat copy, open orders, order results, order keys                         |
| custody token accounts | the program only when sealed, anyone when the token is registered public | the tokens backing every seat |

"The program only" is a permission that is private with no members. A trader cannot
read the `Ledger`, so `TraderView` carries everything a trader needs. The program
reads a `TraderView` for two things only: its order keys, and the owner and seat
number it routes an instruction to (trading, deposit, withdraw, close). A view sits at
an address derived from its owner and only the program writes it, so that routing
cannot be forged. Every balance, position and order a money decision rests on comes
from the `Ledger` and the books, never from the view's copy. For every instruction
but a deposit, which anyone may make for anyone, the engine checks there that the seat
belongs to that owner.

## 3. What a trader can learn about their own order

Through the private endpoint, a transaction that touches the sealed book shows nothing
to anyone, its sender included: no logs, no data, no result. So every order-key
instruction (place, cancel, cancel all, sync, liquidate, transfer between balances)
that succeeds writes its outcome into the sender's `TraderView`:

- the latest order results (client order id, status, filled size and notional, rested
  size, fee, order sequence if it rests), in a ring of 16 with a 64-bit count of every
  result written, which no seat can run out. The newest sits at `(count - 1) % 16`;
  the ring is not sorted;
- the seat copy, with the seat's version number, and, for all but the transfer, the
  open order list on the instruction's market.

An instruction that fails changes nothing, the view included; what the program refuses
as an outcome (`RULES.md` section 3) succeeds and is written. Of the owner's own
instructions, `withdraw` refreshes the seat copy, `set_order_keys` writes the keys and
`close_trader` removes the view. A deposit leaves the view as it is, since its
depositor need not be the owner.

A resting order that is filled later changes the seat but not the view. The client
recognises its own fills on the public tape by their receipts (`RULES.md` section 10)
and calls `sync_view`.

## 4. Keys

- **Owner key.** Opens the account, withdraws, closes, replaces order keys. It also
  signs in to the rollup to read the `TraderView`.
- **Order keys.** A `TraderView` holds four order keys. Every order-key instruction
  (place, cancel, cancel all, sync, liquidate, transfer between balances) must be
  signed by one of them, and replaces that key with a new one given in the
  instruction. The program refuses a replacement that is the default key, the owner,
  or one of the four live keys. It keeps no history, so it does not stop a key used
  before from being named again, by a replacement or by `set_order_keys`. Nor does it
  look at other signers: the client sends each of these with the order key as its only
  signer and fee payer, and that is the client's choice, not something the program
  enforces. A client that derives each key from its seed at a new index, as ours
  does, never names one twice, so an observer who lists signatures sees a different,
  never-seen key on every order and cannot link two orders to each other or to an owner. That
  is about linkability, not about limiting a thief: whoever holds a leaked order key
  names the next key, so the exposure lasts until the owner replaces all four with
  `set_order_keys`.
- An order key that was used is replaced in the same instruction, so the same signed
  transaction cannot run twice while that key stays out of the four. A client that
  does not see its order result resends the same signed transaction: if the first
  ran, the resend is refused, and if not, it runs.
- Every order-key instruction carries an expiry time. The program refuses it once that
  time has passed, or while it is more than 60 seconds ahead of the rollup's clock
  (`RULES.md` section 3, check 0). The expiry bounds when an instruction may execute,
  not when it was signed, because the rollup can execute a transaction long after it
  was sent (`SPIKE.md`, follow-up on question 6). A refused instruction changes nothing,
  so its order key is still live for the next attempt.
- Fees in the rollup are zero and a key with no lamports can sign.

## 5. Instructions

Setup. On Solana, only the program's upgrade authority can sign `initialize_exchange`,
and it becomes the first admin. The exchange is funded with a plain lamport transfer.
From then on the exchange's admin, not the upgrade authority, signs
`delegate_exchange` and `withdraw_exchange` on Solana and `undelegate_exchange` in the
rollup.

Administration, in the rollup, by the admin: `update_exchange`, `propose_admin`,
`set_paused`, `register_token` (custody set-up and custody visibility per token),
`set_custody_cap` (the most a token's custody may hold after a trader's deposit),
`create_ledger`, `finalize_ledger`, `create_market`, `grow_account`,
`finalize_market`, `update_market`, `restrict_market`, `resume_market`,
`reset_price`, `schedule_funding`, `fund_insurance`, `move_fees_to_insurance`,
`collect_fees` and `close_unused_trader`. `accept_admin` is signed by the nominee that
`propose_admin` named, not by the admin. The collateral token is fixed when the
exchange is created and can never be changed.

Anyone may call `update_funding`, `cover_shortfall` and `reconcile_shortfall`
(`RULES.md` sections 7 and 8).

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
| `transfer_between_balances`  | an order key                       | moves collateral-token value between collateral and a spot balance kept in the same custody account, no token moving; the market it names does not change |
| `extend_compute`             | none                               | does nothing and names no account; sent after `cancel_all` and `liquidate` for more compute (section 8) |
| `close_trader`               | owner                              | closes an empty seat and its view                                                 |

Every instruction an order key signs names the same accounts (section 1). Refusals
that depend on the book are outcomes written to the view, never errors
(`RULES.md` section 3). Every instruction that needs no signer is cheap and does
nothing when called again inside its interval.

## 6. Custody

Tokens are Ephemeral SPL Token balances inside the rollup. There they are ordinary SPL
token accounts at ordinary associated addresses, moved with ordinary SPL transfers.
Custody is a token account per token owned by a program address, the token's custody authority, derived from a nonce the admin chooses when registering the token. The exchange records the nonce with the token and never changes it, and every payout of that token signs with it. A custody address is therefore not known before the admin uses it, and one a stranger claimed first (`SECURITY.md`) is skipped by choosing another nonce. A public custody balance is still public from its delegation until registration lands, so a permission a stranger attaches in that window makes registration refuse it and the admin retries under another nonce; the nonce does not prevent that (`SECURITY.md`). One mint keeps one custody account at every index it is registered at, and `transfer_between_balances`, which moves value with no token moving, refuses a spot token whose custody account is not the collateral's. `collect_fees` refuses a custody account as its destination, since paying custody into custody moves no token while the fee seat is debited. Each token is registered with sealed or public custody, a choice the exchange records and never changes: sealed needs a private permission nobody reads through, public needs no permission at all, and the program verifies either when the token is registered. Public custody shows the token's total in custody, and so the size and time of every deposit and withdrawal. The test network uses public custody, because MagicBlock's hosted endpoint refuses a program other than the token program that names a private token balance (`spike/devnet/README.md`). The program signs every payout. `deposit` and `withdraw` move tokens and
change the seat in the same instruction.

Each token has a custody cap, zero when it is registered, which the admin sets with
`set_custody_cap`. A trader's `deposit` is refused when the custody account would hold
more than the cap once the tokens have moved; `fund_insurance` is not held to it. The
cap is on the token's total and never on a seat, because anyone may deposit for anyone
and a per-seat refusal would show a stranger that seat's balance (`SECURITY.md`).

Not proven yet: withdrawing from the rollup back to Solana. Not built on purpose: a
vault on Solana with recomputed fill commitments, which is the question to settle
before real money.

## 7. Trust

- The rollup operator can see, order, delay or drop transactions inside the rollup,
  and guards the filter. It cannot move tokens except through this program.
- There is no way today to pull rollup state back to Solana without the operator.
- The price feed is written by one key, bounded by a maximum move per update and a
  maximum age. That is a test-network arrangement.
- The admin can pause, add markets and change market settings within fixed bounds. The
  admin cannot move a trader's funds.
- The upgrade authority can change the program and so can do anything. It is part of the custody trust model, and it is a different key from the exchange admin: changing one does not change the other. It belongs on a
  multisig before real money.
- Fees are zero, so nothing in the rollup limits spam. The limits are a daily cap on new seats, the gate key on
  `open_trader`, the open-order limit per trader, the price band and the minimum order
  size. None of them stops a few seats from filling a side with far-away orders that
  no taker can reach, or with orders that have expired, so a full side gives way:
  an order that would rest evicts an expired order, and with none expired, an order
  priced strictly better than the worst resting order evicts that one (RULES 3.8).

## 8. Capacities

2,048 seats, 1,024 resting orders per side per market, 8 markets, 32 open orders per
trader per market, at most 32 fills per order, 512 fills on a tape. The shared
state accounts come to 2,198,200 bytes at these sizes, under 3 MB: the ledger
917,528, eight books 1,049,280, eight tapes 229,696, and the markets, feeds and stats
1,696. Each trader adds a view of 3,736 bytes, so the 2,046 trader seats add 7,643,856
bytes more when all are open, about 9.8 MB in all. These figures leave out the
`Exchange` and every account's permission. The hosted validator's storage limit is unknown, for one large account
and for the total.

**Compute.** A transaction that asks for nothing gets 200,000 compute units per
instruction; one may ask for up to 1.4 million. The rollup honours the request: it
runs Agave's compute budget processing, `SPIKE.md` question 3 found the 1.4 million
ceiling there, and the set-up and the test suite rely on it. Matching is bounded: a
fill costs about 160 units and an order makes at most 32. What grows with the book
is three scans over both of its sides, up to 2,048 orders:

- every order-key instruction copies the trader's open orders into the view;
- `cancel_all` and a liquidation that happens release the seat's orders;
- the same two then remove them from the book.

The removal used to move every order it kept. It now leaves everything below the
seat's lowest removed order in place and moves each run of orders between two removed
ones in one copy, at most 33 copies a side, so it costs a scan like the other two.
Counted from the compiled program before that change, `cancel_all` against two full
sides came to roughly 230,000 to 245,000 units; that count has not been redone, and
no figure here was measured on a network. So the client sends `cancel_all` and
`liquidate` with `extend_compute`, an instruction of this program that does nothing
and names no account, and asks the compute budget program for nothing. Two
instructions get 400,000 units between them. A compute budget request would name
that program, and its signature list would then set these two apart from every other
order-key transaction (section 1); it would also not fit a `liquidate` at 8 perp
markets, below. The order key stays the only signer.

**Transaction size.** A transaction is at most 1,232 bytes. Every order-key
instruction and every `withdraw` name three accounts for each perp market the
exchange has (`RULES.md` section 6 values every position, and section 1 needs the
order-key instructions to look alike), so they grow with the number of perp markets.
With all 8 markets perp, an order key or the owner as the only signer, the client's
transactions measure:

| Instruction                 | Accounts | Bytes                        |
| --------------------------- | -------- | ---------------------------- |
| `place_order`               | 30       | 1,227                        |
| `liquidate`                 | 30       | 1,215, with `extend_compute` |
| `withdraw`                  | 32       | 1,210                        |
| `cancel_all`                | 30       | 1,199, with `extend_compute` |
| `transfer_between_balances` | 30       | 1,194                        |
| `cancel_order`              | 30       | 1,192                        |
| `sync_view`                 | 30       | 1,184                        |

`extend_compute` adds 11 bytes; a compute budget request adds 40, which would take
`liquidate` to 1,244. So at 8 perp markets, `place_order` and `withdraw` have no room
for another instruction, another signer or another account: a client that adds a
compute or priority request, or a fee payer other than the signing key, cannot send
them. The client's unit tests build each of these with every market a perp market
and fail if one passes 1,232 bytes. Address lookup tables would lift the limit;
whether the rollup accepts them has not been tested.

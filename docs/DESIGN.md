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
| `Exchange`                   | everyone         | admin, pending admin, gate key, the test networks' oracle key, pause flag, limits, the ledger's seat capacity and layout, the minimum seat-taking deposit, the USDC guard (`RULES.md` section 9a); pays rent |
| `Ledger`                     | the program only | a table of 304-byte seats (engine state) and a free list, with each seat's maker and taker lists (one byte each, a bit per market) and block flag (`RULES.md` section 3a), and the seat's trigger identity (section 9); at `["ledger-v2"]` |
| `Book`, one per market       | the program only | bids and asks, sequences, funding index                                         |
| `TriggerBook`, one per market | the program only | take-profit and stop-loss triggers, one slot per seat of the largest ledger for a perp (208 bytes a seat after a 56 byte prefix: 7,174,392 bytes), a header only for a spot market; at `["trigger", market_id]` (`RULES.md` section 12c) |
| `LayoutScan`, one | the program only | how far `scan_seat_layout` has read the ledger (32 bytes); exists only while an exchange moves to the active layout; at `["layout-scan"]` (`RULES.md` section 12d) |
| `Market`, one per market     | everyone         | kind, names, tick, lot, margins, fees, limits (open interest and position caps among them), status, a perp's maker and taker list switches (`RULES.md` section 3a) |
| `Tape`, one per market       | everyone         | ring of the latest fills, last price                                            |
| `PriceFeed`, one per market  | everyone         | the mark, its publish time and the rollup time it was accepted; the bound oracle account and its scaling; the source's last observation; the last incident (`RULES.md` section 9). 176 bytes |
| `Stats`                      | everyone         | lifetime counters; orders, fills and volume stop at their largest value rather than fail a trade (`RULES.md`) |
| `TraderView`, one per trader | that trader only | their seat copy (zeroed while they hold no seat), open orders, order results, order keys |
| custody token accounts | the program only when sealed, anyone when the token is registered public | the tokens backing every seat |

"The program only" is a permission that is private with no members. A trader cannot
read the `Ledger`, so `TraderView` carries everything a trader needs. The program
reads a `TraderView` for two things only: its order keys, and the owner and seat
number it routes an instruction to (trading, deposit, withdraw, close), the seat number
being `NO_SEAT` while the owner holds none. A view sits at
an address derived from its owner and only the program writes it, so that routing
cannot be forged. Every balance, position and order a money decision rests on comes
from the `Ledger` and the books, never from the view's copy. For every instruction
but a deposit, which anyone may make for anyone, the engine checks there that the seat
belongs to that owner.

**The ledger.** The `Ledger` is a 48-byte prefix (the account header, a tag and the
table header) followed by seats of 304 bytes each. Seat 0 is the fee seat and seat 1
the insurance seat; the rest are traders'. A seat holds the owner, a version that rises
at every take and release, collateral, four spot balances, the maker and taker lists as
one byte each, four position slots (each tagged with the market it belongs to, with its
count of resting orders beside it), the status and block flag, a link for the free
list, and the seat's trigger identity: a 32-bit epoch and a 24-bit generation for each
of the four slots (section 9). Four slots are what let a seat be 304 bytes where eight fixed markets needed 448:
a seat holds positions and orders on any four markets at once, and `SlotsFull` is the
refusal for a fifth (`RULES.md` section 6). The 448-byte table at `["ledger"]` that
the seats were copied out of is no longer read by the program and has no close
instruction, so its rent stays where it is. The table header holds the number of open
seats and the head of the free list. The free list threads through the released
seats themselves: a free seat's link names the next, so taking a seat pops the head and
releasing one pushes it, both in constant time and with no search of the table. No
instruction looks a seat up by owner. The owner's view records its index, and a
view that records an index whose seat was released (and perhaps taken by someone
else) is recognised by the seat's owner not matching and treated as holding none.

The table grows in place. `create_ledger` makes it 2,048 seats and `extend_ledger`
appends up to 33 seats per call, zeroed and pushed onto the free list, until the
exchange's recorded capacity is the one wanted. A grown account keeps its address and
every index. The account limit of 10 MiB holds 34,492 seats (10,485,616 bytes), and
`extend_ledger` grows it to all of them with no further upgrade: `reconcile_shortfall` reads the
table `RECONCILE_SEATS_PER_CALL` seats at a time, from a cursor kept in the ledger
header, so a table of any size is swept over several transactions. Rent for the growth
is paid by the exchange: about 59.8 million lamports from 2,048 to 8,192 seats.

**Snapshots from before tagged slots.** A view written when seats held eight fixed
market slots keeps that snapshot until its next `sync_view`, which clients call when the
snapshot's layout byte is not the current one.

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
instructions, `withdraw` refreshes the seat copy (or, when it empties and releases
the seat, records no seat and zeroes the copy), `set_order_keys` writes the keys and
`close_trader` removes the view. A deposit leaves the view as it is, except that the
deposit which takes the owner's seat writes the new index into it, so a depositor
who is not the owner can cause that one write and no other.

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
`create_ledger`, `finalize_ledger`, `extend_ledger`, `create_trigger_book`,
`finalize_trigger_book`, `create_market_v2`, `grow_account`,
`finalize_market`, `update_market_v2`, `restrict_market`, `resume_market`,
`set_price_source_v2`, `set_quote_source_v2`, `schedule_funding`, `fund_insurance`,
`move_fees_to_insurance`, `collect_fees`, `close_unused_trader`, `set_market_access`,
`set_seat_access` (`RULES.md` section 3a), and the two migration instructions
`scan_seat_layout` and `activate_layout` (section 9). The four `_v2` names replaced
names whose argument bytes changed (`RULES.md` section 12d). `accept_admin` is signed by the nominee
that `propose_admin` named, not by the admin. The collateral token is fixed when the
exchange is created and can never be changed.

`set_market_access` names the admin, the exchange and the market, as
`restrict_market` does, and its switches are public. `set_seat_access` carries the
owner of the seat in its data only and names the admin, the exchange, the ledger, that
owner's view and the book of every perp market by rising id, the same accounts whoever the seat is and
whatever it sets; the books are there because clearing a maker bit cancels the seat's
resting orders on that market. A block or a switch reads no book and removes nothing:
an order its owner may no longer make with is cancelled when matching reaches it, and
fills again if its owner may make again first (`RULES.md` section 3a).
Its public accounts are those of
`move_fees_to_insurance`. Nobody can read the lists back, the operator included, so
the admin's tooling keeps its own signed record, and since the setter is absolute it
can apply that record again at any time.

Anyone may call `sync_price`, `sync_quote`, `update_funding`, `cover_shortfall` and
`reconcile_shortfall` (`RULES.md` sections 7 to 9a). The two price cranks are sent on
their own, never in an order-key transaction: they name an oracle account, which would
set those transactions apart (section 1) and cost bytes they do not have (section 8).
An operator keeper and an independent keeper send `sync_price` on every change of a
market's oracle account and `sync_quote` on every change of USDC's.

The program built with its `test-oracle` feature, which the local network and devnet
load, also has `publish_price`, signed by the oracle key, and `reset_price`, signed by
the admin, for markets bound to no price source. The default build, which mainnet
deploys, has neither; `make check-mainnet` builds it under `target/mainnet` and
checks both its binary and its interface file.

| Instruction                  | Signers                            | Does                                                                              |
| ---------------------------- | ---------------------------------- | --------------------------------------------------------------------------------- |
| `open_trader`                | owner, gate                        | creates the `TraderView` with its permission and four order keys, and no seat; refused while the exchange is paused |
| `deposit`                    | depositor                          | moves tokens into custody and credits the seat of the named owner, taking a seat first when the owner's view holds none (collateral only, at least the exchange's minimum); the depositor need not be that owner; the fee and insurance seats cannot be deposited into |
| `withdraw`                   | owner                              | checks margin, debits the seat, pays out to the owner's token account, and releases the seat if it is then empty   |
| `release_empty_seats`        | anyone                             | gives back every empty, unpinned seat in a range of the table; says which, to no one |
| `place_order`                | an order key                       | checks, matches, rests the remainder, writes the result to the view               |
| `cancel_order`, `cancel_all` | an order key                       | removes resting orders, releases funds                                            |
| `sync_view`                  | an order key                       | copies the seat and open orders into the view; for a view whose seat is gone, records no seat and zeroes the copy |
| `set_trigger`, `cancel_trigger` | an order key                    | sets or removes a take-profit or stop-loss; refusals that depend on the seat are outcomes in the view |
| `fire_triggers`              | anyone, and the built-in scheduler | places the reduce-only market order of each trigger the mark has reached, at most `max_fires` (1 to 4); idle passes succeed |
| `sweep_triggers`             | anyone                             | reads a range of seats, within a seat budget and a heap-change budget, and drops the records that no longer belong to their seat; says nothing |
| `set_order_keys`, `set_order_keys_signed` | owner                 | replaces all four order keys and moves the seat to its next epoch, which kills the seat's triggers in every market with no trigger book named |
| `scan_seat_layout`           | admin                              | while the exchange is paused and before activation: checks that the seat bytes the new build reuses are zero, a range of seats a call |
| `activate_layout`            | admin                              | while paused, once the scan has read every seat: stamps the new layout; the point of no return |
| `sync_price`                 | anyone                             | sets a market's mark from its bound oracle account, or records an incident        |
| `sync_quote`                 | anyone                             | reads USDC's oracle account into the USDC guard                                   |
| `publish_price`              | oracle key, test networks only     | writes the mark of a market bound to no source                                    |
| `update_funding`             | anyone, and the built-in scheduler | advances a perp market's funding index, at most once per interval                 |
| `liquidate`                  | an order key of the liquidator     | takes over an unhealthy position; every "nothing to liquidate" case is recorded as one code, in the liquidator's view only                                                  |
| `transfer_between_balances`  | an order key                       | moves collateral-token value between collateral and a spot balance kept in the same custody account, no token moving; the market it names does not change |
| `extend_compute`             | none                               | does nothing and names no account; sent after `cancel_all` and `liquidate` for more compute (section 8) |
| `close_trader`               | owner                              | releases the seat, which must be empty, and closes the view                       |

Every instruction an order key signs names the same accounts (section 1), the
market's trigger book among them, writable in all of them. Only `set_trigger` and
`cancel_trigger` read it. A market needs its trigger book before any order-key
instruction names it, so the admin creates the books, a spot market's included, before
clients that name them are released. Refusals
that depend on the book are outcomes written to the view, never errors
(`RULES.md` section 3). Every instruction that needs no signer is cheap and does
nothing when called again inside its interval.

## 6. Custody

Tokens are Ephemeral SPL Token balances inside the rollup. There they are ordinary SPL
token accounts at ordinary associated addresses, moved with ordinary SPL transfers.
Custody is a token account per token owned by a program address, the token's custody authority, derived from a nonce the admin chooses when registering the token. The exchange records the nonce with the token and never changes it, and every payout of that token signs with it. A custody address is therefore not known before the admin uses it, and one a stranger claimed first (`SECURITY.md`) is skipped by choosing another nonce. A public custody balance is still public from its delegation until registration lands, so a permission a stranger attaches in that window makes registration refuse it and the admin retries under another nonce; the nonce does not prevent that (`SECURITY.md`). One mint keeps one custody account at every index it is registered at, and `transfer_between_balances`, which moves value with no token moving, refuses a spot token whose custody account is not the collateral's. `collect_fees` refuses a custody account as its destination, since paying custody into custody moves no token while the fee seat is debited. Each token is registered with sealed or public custody, a choice the exchange records and never changes: sealed needs a private permission nobody reads through, public needs no permission at all, and the program verifies either when the token is registered. Public custody shows the token's total in custody, and so the size and time of every deposit and withdrawal. The test network uses public custody, because MagicBlock's hosted endpoint refuses a program other than the token program that names a private token balance (`spike/devnet/README.md`). The program signs every payout. `deposit` and `withdraw` move tokens and
change the seat in the same instruction.

Deposits have no configurable cap, and a registered token takes them at once. The
only ceiling is a fixed technical maximum, the engine's per-balance limit
`BALANCE_CAP`: a `deposit` that would take the custody account past it is refused, and
`register_token` accepts only a token whose total supply in atoms is below it. The
ceiling is on the token's total and never on a seat, because anyone may deposit for
anyone and a per-seat refusal would show a stranger that seat's balance
(`SECURITY.md`). For the same reason `deposit` reads the seat last: it moves the
tokens, checks custody against the ceiling, and only then credits the seat, so a
depositor who does not hold the amount learns nothing about it. The open interest cap
and the position cap stay; they bound exposure, not deposits.

Not proven yet: withdrawing from the rollup back to Solana. Not built on purpose: a
vault on Solana with recomputed fill commitments, which is the question to settle
before real money.

## 7. Trust

- The rollup operator can see, order, delay or drop transactions inside the rollup,
  and guards the filter. It moves tokens only through this program as long as what its
  validator commits is what the program's instructions produced; that integrity, and
  what a rollback would undo, are trusted, not checked (`SECURITY.md`).
- There is no way today to pull rollup state back to Solana without the operator.
- On mainnet the mark comes from MagicBlock's oracle alone, through `sync_price`: the
  bound account in the rollup, owned by the oracle program and fully verified, bounded
  by a maximum move per update and a maximum age. Nothing stands beside it to confirm
  a mark, so a liquidation is held to the market's health instead: it runs only on a
  healthy market with a mark no older than `max_price_age` (`docs/RULES.md` sections 8
  and 9). The program trusts the oracle's key and the rollup's copy of its accounts,
  and that a crank sends a newer observation within `max_age`; it cannot prove any of
  them (`SECURITY.md`). On the test networks one key writes the mark instead, and what
  it publishes is the operator's choice.
- A market's first mark, which nothing bounds, leaves it reduce-only, or paused, until
  the admin resumes it: its first `sync_price` on mainnet, the admin's reset on a test
  network's unbound market, whose oracle key cannot write a first price.
- The admin can pause, add markets and change market settings within fixed bounds. The
  admin cannot move a trader's funds or rebind a market that is not paused. It writes a
  price, a source record, an incident or a health only by rebinding a paused market:
  that clears the source record, and chooses no price: a market with no position and no
  order loses its mark and its incident and is healthy, and the next `sync_price` sets
  the mark; one with either keeps its mark and is left settling, with any window kept,
  until a `sync_price` held to the move limit has been accepted (`SECURITY.md`). On a test network a price reset and its own seat can take
  collateral by liquidation (`SECURITY.md`).
- The upgrade authority can change the program and so can do anything. It is part of the custody trust model, and it is a different key from the exchange admin: changing one does not change the other. It belongs on a
  multisig before real money.
- Nothing in the program delays an admin action or an upgrade: there is no time lock.
  `SECURITY.md` says how both keys must be held.
- Fees are zero, so nothing in the rollup limits spam. The limits are a daily cap on new views (every seat needs a view, and every view the gate's signature), the gate key on
  `open_trader`, the open-order limit per trader, the price band and the minimum order
  size. None of them stops a few seats from filling a side with far-away orders that
  no taker can reach, or with orders that have expired, so a full side gives way:
  an order that would rest evicts an expired order, and with none expired, an order
  priced strictly better than the worst resting order evicts that one (RULES 3.8).

## 8. Capacities

2,048 seats at the start (growing in place to 34,492), 1,024 resting orders per side per market, 8 markets of which at most 6 are perps, 4 of them at a time per
trader, 32 open orders per
trader per market, at most 32 fills per order, 512 fills on a tape. The shared
state accounts come to 1,904,464 bytes at the starting sizes, under 2 MB, and to
11,767,440 once the ledger has grown to its 34,492 seats: the ledger
622,640 at the start (2,490,416 at 8,192 seats, 3,735,600 at 12,288, 10,485,616 at 34,492), eight books 1,049,280, eight tapes 229,696, and 2,848 for the eight markets
at 160 bytes, the eight price feeds at 176 and the stats at 160. Each trader adds a view of 3,736 bytes, so the 2,046 trader seats add 7,643,856
bytes more when all are open, about 9.5 MB in all at the starting sizes. A fully grown ledger has 34,492 seats, and a view for each of its 34,490 trader seats would add 128,854,640 bytes more. These figures leave out the
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

`fire_triggers` is bounded by the fills it can make: 4 triggers a pass, and at most 16
fills for each. Measured on the local rollup with 32 triggers a pass, each crossing 8
resting orders, a pass used 1,399,850 of 1,400,000 units and rolled back, so every due
stop stayed unfired. With 4 due stops each crossing 16 resting orders (the exchange's
`max_steps` is 16 on mainnet), one pass took 3 of them (the fairness cursor holds a
quarter of a pass), placed 3 and cost 519,674 units, about 173,000 for each fire at 16
fills. 4 at 16 fills is the bound.

**Trigger books.** A perp's trigger book is 56 bytes plus 208 for each seat it is sized
for (a 192 byte slot of the owner and two 80 byte records, and 16 bytes of heap
entries): `56 + 208 * 34,492 = 7,174,392` bytes, rent about 0.23 SOL at the rollup's
rate, paid by the exchange. Every perp book is created at that size, whatever
the ledger holds, so the ledger can grow to its 34,492 seats without a book being touched
and the two steps may run in either order. Six perp books and a full ledger
(10,485,616 bytes) are about 53.5 MB of loaded data the validator keeps
(`6 * 7,174,392 + 10,485,616 = 53,531,968`). One order-key transaction names the ledger
and one trigger book, the market's own, and both count against the transaction's
loaded account data. The rollup's value for that limit is unknown, and a 7.17 MB book
beside the 10 MiB ledger has not been loaded on the hosted rollup: it is a gate of the
rehearsal network (section 9). The rollup's accounts database must also hold six
maximum-size books plus the ledger, with room to grow while they are created. The local
test network's default database (100 MiB) ran out at the first book's growth, so the
Makefile raises it, and the hosted size is checked on the rehearsal network.

**Transaction size.** A transaction is at most 1,232 bytes. Every order-key
instruction names the market's trigger book (33 bytes: 32 for the address, 1 for its
index) and three accounts for each perp market the exchange has, and every `withdraw`
names three for each perp market (`RULES.md` section 6 values every position, and
section 1 needs the order-key instructions to look alike), so they grow with the
number of perp markets. With the earlier maximum of eight perp markets, `place_order`
came to 1,260 bytes and no longer fit once it named the trigger book, so the program
now refuses a seventh perp market (`MAX_PERP_MARKETS` = 6, `RULES.md` section 12) and
no transaction names more than six. With six perp markets, an order key or the owner
as the only signer, built by the client's instruction builders and serialized
(a size check run against the working tree, not on a network), they measure:

| Instruction                 | Accounts | Bytes                        |
| --------------------------- | -------- | ---------------------------- |
| `place_order`               | 26       | 1,062                        |
| `liquidate`                 | 26       | 1,050, with `extend_compute` |
| `cancel_all`                | 26       | 1,034, with `extend_compute` |
| `transfer_between_balances` | 26       | 1,029                        |
| `cancel_order`              | 26       | 1,027                        |
| `sync_view`                 | 26       | 1,019                        |
| `withdraw`                  | 27       | 1,012                        |

The accounts are the transaction's distinct keys, the program's included. At seven
perp markets the same builders give 1,161 for `place_order`, which fits only by 71
bytes, and at eight it is 1,260; six leaves 170 bytes under the limit for the
largest. `extend_compute` adds 11 bytes; a compute budget request adds 40, which
`liquidate` at six perp markets has room for (1,090). A client that adds another
signer or a fee payer other than the signing key still has to be measured; this has
not been measured on the rollup, so the packet sizes at six perp markets are a gate of
the rehearsal network (section 9). The client's unit tests build each of these with
every perp market the exchange can hold and fail if one passes 1,232 bytes. Address
lookup tables would lift the limit; whether the rollup accepts them has not been
tested.

The oracle price source changed none of these lists: each perp market still adds its
market, book and price feed, and only the price feed grew, which costs no
transaction byte. Reading the oracle inside the order-key instructions would have added
an oracle account per market, about 33 bytes each, which `place_order` and `withdraw` do
not have. So the source is read by `sync_price` and `sync_quote`, sent on their own:
they name three and two accounts, and the same unit tests check that they fit.

## 9. Upgrading live data

A release that changes what the bytes of live accounts mean must not let two builds
read the same bytes differently, and must not make a mistake unrecoverable. These are
the rules the migration to the trigger identity follows, and the ones the next one
starts from (`RULES.md` section 12d has the phases).

1. **Live data has a version, and every instruction checks it.** `Exchange.layout` is
   the schema id of the data. A build accepts the old id only in its migration
   instructions and the new id everywhere else. The ledger loader takes the exchange
   and refuses unless the layout is current, so no seat read or write can skip the
   gate: it is enforced by the types, not remembered.
2. **One-way activation, named.** Migration writes nothing the old binary would
   misread until one admin instruction, under a pause, flips the id. Before it,
   redeploying the old binary is a safe abort. After it, recovery is a forward fix
   only (`LAUNCH.md`).
3. **Reinterpreted bytes are proven, not assumed.** When a release gives old bytes a
   new meaning, the program scans the live data for the values the old build always
   wrote and fails closed on a surprise. It never normalises unknown bytes by zeroing
   them.
4. **A changed instruction gets a new name.** The framework decodes arguments by
   position and accepts trailing bytes, so a changed shape under an old name can be
   misread. The old handler is removed, and an old client fails loudly.
5. **Account lists do not grow with features.** Invalidation is lazy (a counter in the
   seat, compared on read), never "clear the record in every other account".
6. **Every new account has a format version and an exact length**, and an unknown
   version fails closed.
7. **Rehearse from the deployed binary**, in runbook order, on the network that
   serves the same rollup.

**The seat's bytes.** A seat is 304 bytes before and after. The release reuses bytes
that the deployed build kept at zero, so each reused byte is checked to be zero by the
scan before activation:

| Offset | Now | Deployed build |
| --- | --- | --- |
| 112 | `maker_markets`, one byte, a bit per market | low byte of the maker mask (`u64`) |
| 113..=119 | generation bytes 8..15 and 16..23 of slots 0 to 2, and 8..15 of slot 3 | high 7 bytes of the maker mask, always zero |
| 120 | `taker_markets`, one byte | low byte of the taker mask (`u64`) |
| 121 | generation bits 16..23 of slot 3 | taker mask byte 1, always zero |
| 122..=123 | reserved, zero | taker mask bytes 2 and 3, always zero |
| 124..=127 | `seat_epoch`, `u32` little endian | taker mask bytes 4 to 7, always zero |
| 298..=299 | low byte of the generation of slots 0 and 1 | padding, zero |
| 300..=301 | `next_free`, `u16` (the free list link, at most 34,493) | low half of the free link (`u32`) |
| 302..=303 | low byte of the generation of slots 2 and 3 | high half of the free link, zero |

A slot's generation is 24 bits: the low byte at 298, 299, 302 or 303, and the two
higher bytes in the extension bytes, slot 0 at 113 and 114, slot 1 at 115 and 116, slot
2 at 117 and 118, slot 3 at 119 and 121, least significant first. Helpers assemble and
split them, and no code takes a reference to an unaligned integer. Compile-time
`size_of`, `align_of` and `offset_of` checks pin the seat, every reused offset, the
trigger record and the book header, and the client's decoders are tested against the
same bytes. `set_seat_access` writes only offsets 112 and 120 and never the identity
bytes. A seat's occupy and release keep the epoch and all twelve generation bytes, as
they keep `version`.

**The layout scan** (`scan_seat_layout`) reads every seat, free and reserved ones
included, and requires offsets 113 to 119, 121 to 127, 298, 299, 302 and 303 to be
zero. The argument that any starting value would be safe proves only that a new trigger
cannot match an old record; it does not prove the reused bytes are zero, and a garbage
epoch near `u32::MAX` would block key resets, a generation near its limit would wipe
stops early, and a nonzero high mask bit would change which seats are pinned. The
ledger is sealed, so only the program can check. The scan keeps a cursor in its own
account (`["layout-scan"]`, 32 bytes) and a call that finds a surprise does not
advance it.

**Rollback after activation.** The deployed build would read the epoch and the
generation bytes as high bits of the access masks, its `set_seat_access` and its seat
writers would zero them, and its trades would not advance generations. If it ever runs
after activation, the trigger books cannot be trusted again, and recovery is a forward
build that moves to new book accounts, or proves a full clear, before any trigger is
set or fired (`SECURITY.md`).

**What stays for the rehearsal network.** Things the local suite cannot show: the
hosted rollup's loaded-data limit with a 7.17 MB book beside the 10 MiB ledger; packet
sizes at six perp markets; how soon the rollup serves an upgraded binary; the scan
completing on the real sealed ledger; the 165-byte token account rule with one real
deposit and withdrawal; and oracle cadence and clock skew. Address lookup tables stay
untested and unused.

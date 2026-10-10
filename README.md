<h1 align="center">orderbook-noirwire</h1>
<p align="center">A private order book for spot and perpetual markets, running inside MagicBlock's Private Ephemeral Rollup, with its TypeScript client.</p>

<p align="center">
  <a href="https://github.com/Noirwire/orderbook-noirwire/actions/workflows/ci.yml"><img src="https://github.com/Noirwire/orderbook-noirwire/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <img src="https://img.shields.io/badge/license-proprietary-black" alt="License">
</p>

Orders rest and match inside a private rollup. Nobody but the program can read the book, the ledger of seats, or another trader's view; the tape of fills, the mark prices, the market settings and the lifetime counters are public. Every trading instruction is signed by a one-time key, so an observer who lists signatures cannot link two orders to each other or to a wallet.

The repository has four parts:

- `docs/` is the contract: [DESIGN.md](docs/DESIGN.md) (accounts, keys, instructions, custody, trust), [RULES.md](docs/RULES.md) (the money rules) and [SPIKE.md](docs/SPIKE.md) (what was measured on the rollup). Change the documents first, then the code.
- `crates/engine` is the matching and risk engine: pure Rust, no I/O, no heap, no clock. It owns every money rule in `RULES.md`.
- `programs/noirwire-orderbook` is the Anchor program: accounts, authority, permissions, custody, the per-trader view, and the calls into the engine. It reimplements no rule.
- `sdk/` is the client, `@noirwire/orderbook`: addresses, instruction builders, account decoders, the one-time order key manager, receipts, sign-in, and a `placeOrder` that confirms from the trader's own view.

`tests/` proves the program through the built client on a local three-part network. `ops/` sets up a deployment and shares its helpers with the tests. `spike/` is the measurement code behind `SPIKE.md`, kept as it ran.

We publish this source so that anyone can read what runs. See [LICENSE](LICENSE) for what you may do with it.

## What it guarantees, and what it does not

Checked by the program and the engine, and proven by the tests on a local network:

- Tokens leave custody only through `withdraw`, signed by the seat's owner, to a token account that owner controls, and only within margin. A deposit credits a seat in the same instruction that moves the tokens. After every step of the suite, custody equals the sum of the seats (RULES 13.1).
- Only one of a view's four order keys can place, cancel, sync, liquidate or move value between the seat's own balances; each key is replaced by the one the instruction names, so no two instructions share a signer and a transaction cannot be replayed. That is about linkability, not about theft: whoever holds a live key names the next one, so a leaked key stays usable until the owner replaces all four (`SECURITY.md`). The owner key cannot trade, and an order key cannot withdraw, close or replace keys.
- Every trading instruction carries an expiry. The program refuses it, before anything else, once the rollup's clock is past it or when it is more than 60 seconds ahead; the key stays live either way. The expiry bounds when an instruction may execute, not when it was signed.
- A refusal that depends on the contents of a book is an outcome in the trader's view, never an error: a post-only order that would match, a full side, a fill the fill check or the open interest cap stops, an immediate-or-cancel with nothing to match, a cancel of an order that is gone, and a liquidation that did nothing. Errors say only what the caller could know from public settings and their own seat. A liquidator is not told why there was nothing to liquidate: no such seat, no position, not below maintenance and a price beyond its worst price are one recorded value.
- The collateral token, a registered token's mint and custody account, and a market's tokens never change, so no setting can redirect which custody account a balance is paid from. A market returns to active status only through `resume_market`.
- A deposit names its beneficiary by owner key and cannot reach the fee seat or the insurance seat; only the admin funds insurance. The exchange opens no more seats in a UTC day than its `max_seats_per_day`.
- The ledger and every book carry a permission with no members; a view carries one whose only member is its owner. A stranger, an anonymous caller and the owner of another seat read nothing from them through the private endpoint, and a transaction that touches them is an empty shell to anyone but the program.
- An account created inside the rollup is refused until it has its full size and is finalised. Every load checks owner, derivation, tag, size, readiness and, for a market's accounts, the market id.
- Only the program's upgrade authority can set up the exchange. Only the admin can change settings, register tokens, create and finalise markets, change limits, pause, reset a price, schedule funding, and move the exchange; the admin role moves in two steps and the old admin keeps nothing.

Not this program's to guarantee:

- **Confidentiality of reads** is the rollup's query filter. The program attaches the permissions; the rollup enforces them. The rollup's own port serves everything to anyone who can reach it (the tests read the ledger there to check invariants). On a hosted validator that port is the operator's promise.
- **Custody visibility, and deposits through a private endpoint.** A token is registered with sealed or public custody, an explicit choice that never changes afterwards. Sealed: `register_token` refuses a token whose custody balance lacks a private permission nobody reads through. Public: it refuses one whose custody balance has any permission. The local filter (0.1.3) and MagicBlock's hosted devnet endpoint (measured 2026-10-09, the table in `spike/devnet/README.md`) both refuse every transaction of a program other than the token programs that names a private token balance. With sealed custody, `register_token`, deposits and withdrawals are therefore sent to the rollup's own port, which only the local network has; that address is `depositUrl` in the deployment description (`DEPOSIT_URL` in the Makefile). Devnet has only the hosted endpoint, so devnet uses public custody (`DEVNET_CUSTODY` in the Makefile; `custodyVisibility` per token in the description), and a depositor's or withdrawer's own token balance must be public too.
- **What public custody shows.** Anyone reads each token's total in custody, and so the size and time of every deposit and withdrawal as that total changes, and the depositor's or withdrawer's own token balance when that account is public. It does not show resting orders, book depth, seat balances or positions, and, since the endpoint serves no transaction contents, not which seat was credited or debited. `SECURITY.md` has the detail and one open risk.
- **The upgrade authority** can replace the program and is part of the custody trust model. It is not the exchange's admin, and changing one does not change the other.
- **Ordering and timeliness.** The operator orders transactions and can delay or drop them, and under load the rollup executes accepted transactions late (`SPIKE.md`, follow-up on question 6). The expiry bounds how late an order can fill.
- **The mark price** is one oracle key within a move limit. A test-network arrangement.
- **Withdrawal to Solana** is not part of this program. Tokens live inside the rollup as Ephemeral SPL Token balances.

This program has not had a third-party audit.

## How it is laid out

```
programs/noirwire-orderbook/src/
  lib.rs                   the instruction list and the embedded security contact
  state.rs                 every account layout, seeds, sizes and bounds
  errors.rs                one error enum; engine codes map one to one
  loader.rs                the one zero-copy loader every instruction uses
  ephemeral.rs             create, grow, seal and close accounts inside the rollup
  custody.rs               SPL token account checks and the program-signed payout
  risk.rs                  the cross-margin risk table built from the other markets
  view.rs                  order key swap, result ring
  instructions/exchange.rs set up, settings, hand-over, pause, tokens, delegation
  instructions/setup.rs    ledger and market creation, growth, finalisation, limits
  instructions/trader.rs   open, keys, close, deposit, withdraw
  instructions/trading.rs  place, cancel, cancel all, sync, liquidate, transfer between balances
  instructions/oracle.rs   publish and reset a price
  instructions/funding.rs  update funding and schedule it
  instructions/treasury.rs shortfalls, resuming a market, fees
sdk/src/                   the client (see "The client")
  client.ts                TraderClient: one call from lending a key to its confirmation
  outcomes.ts              what a call can come to, and the errors it throws
  resultRing.ts            telling a call's result from older ones in the view
  viewFeed.ts              the trader's view, kept current over a websocket
  orderKeys.ts             the one-time order keys and their derivation
  instructions.ts          every instruction, with the accounts in the program's order
  accounts.ts              account layouts and their decoders
  addresses.ts, constants.ts, bytes.ts
  marketReader.ts          public reads and subscriptions
  transactions.ts          signing, sending and confirming anything but an order
  setup.ts                 the multi-transaction creation of the ledger and a market
  auth.ts, receipts.ts     sign-in to the private endpoint; RULES 10
  internal/                helpers of the above that index.ts does not export
tests/orderbook.test.ts    the behaviour, as sentences: the parts, in the order they run
tests/orderbook/           one file per part, and world.ts, the cast and helpers they share
tests/client.test.ts       the client against a fake rollup; no network
tests/ops.test.ts          what the ops scripts decide and report; no network
tests/support.ts           the local network: connections, the admin, how a test reads and sends
ops/network.ts             `setup` and `status` of a deployment
ops/smoke.ts               trades on a deployment as two traders and times its orders
ops/deployment.ts          a deployment's tokens and markets, the network the Makefile names, the description
ops/exchange.ts, tokens.ts, keys.ts, sending.ts
                           the steps of a set-up, which the tests share
ops/requests.ts, stats.ts  request counts and timing summaries for the smoke
Makefile                   the only entry point
```

### Accounts

All sizes are the program's. An account inside the rollup costs `(size + 60) * 32` lamports of rent, paid by the exchange and returned when it is closed. The figures below follow that formula; the test suite asserts the view's and the permission's, and a local set-up was measured charging the exchange exactly the sum for one ledger, stats and three markets.

| Account      | Address                                             | Readable by      | Size              | Rent, lamports | Holds                                                                                              |
| ------------ | --------------------------------------------------- | ---------------- | ----------------- | -------------- | -------------------------------------------------------------------------------------------------- |
| `Exchange`   | `["exchange"]`, on Solana, delegated                | everyone         | 293 (Anchor)      | Solana rent    | admin, pending admin, gate, oracle, pause, max steps, collateral token, tokens, the daily seat cap |
| `Ledger`     | `["ledger"]`                                        | the program only | 917,528           | 29,362,816     | 2,048 seats (engine state); the fee seat is 0 and the insurance seat is 1                          |
| `Stats`      | `["stats"]`                                         | everyone         | 160               | 7,040          | orders, fills, volume and open interest per market                                                 |
| `Market`     | `["market", id]`                                    | everyone         | 120               | 5,760          | engine `MarketParams`, symbols, book capacity per side                                             |
| `Book`       | `["book", id]`                                      | the program only | 114,768           | 3,674,496      | 1,024 resting orders per side, sequences, funding index, what traded since the last funding update |
| `Tape`       | `["tape", id]`                                      | everyone         | 28,712            | 920,704        | ring of the last 512 fills, last price                                                             |
| `PriceFeed`  | `["price", id]`                                     | everyone         | 32                | 2,944          | mark price and publish time                                                                        |
| `TraderView` | `["view", owner]`                                   | that owner only  | 3,472             | 113,024        | owner, four order keys, seat index, ring of 16 results, seat copy with open orders on one market   |
| permission   | permission program, per account                     |                  | 68 or 101         | 4,096 or 5,152 | the member list: none for a sealed account, the owner for a view                                   |
| custody      | associated token account of `["custody"]`, per mint | the program only | SPL token account | paid on Solana | every token the seats hold; sealed by a private permission, or public, as registration records     |

Every rollup account starts with a 16-byte header: an 8-byte tag, a ready flag, the market id, the bump, and padding. The body is the engine's `#[repr(C)]` struct, mapped zero-copy. An account above 10,240 bytes is created at that size and grown by `grow_account` in 10,240-byte steps, up to 30 per transaction; it is refused until `finalize_ledger` or `finalize_market` has checked its size and set the flag. The ledger needs 90 steps and 4 transactions; a book 11 steps; a tape 2.

### Instructions

| Instruction                                                         | Signers            | Does                                                                                                                                  |
| ------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `initialize_exchange`                                               | upgrade authority  | Creates the exchange on Solana. The signer becomes its admin                                                                          |
| `update_exchange`, `set_paused`                                     | admin              | Gate, oracle, max steps, seats per day (never the collateral token); the pause                                                        |
| `propose_admin`, `accept_admin`                                     | admin; the nominee | The two-step hand-over                                                                                                                |
| `register_token`                                                    | admin              | Records a mint, its custody account and the custody's visibility: sealed needs a private permission nobody reads through, public none |
| `delegate_exchange`, `undelegate_exchange`, `withdraw_exchange`     | admin              | Move the exchange to the rollup and back, pay it out on Solana down to its rent                                                       |
| `create_ledger`, `finalize_ledger`                                  | admin              | The sealed ledger and the public stats; finalising opens the fee and insurance seats, owned by the program id                         |
| `create_market`, `grow_account`, `finalize_market`, `update_market` | admin              | A market's four accounts, growth, readiness, and limits within RULES 12                                                               |
| `open_trader`                                                       | gate and owner     | A seat, the view, its owner-only permission and four order keys, in one instruction                                                   |
| `set_order_keys`, `close_trader`                                    | owner              | Replace all four keys; close an empty seat and its view, rent back to the exchange                                                    |
| `deposit`                                                           | the depositor      | Credits the seat of the owner whose view it names and moves the tokens into custody; never a reserved seat                            |
| `fund_insurance`                                                    | admin              | Credits the insurance seat and moves the collateral token from the admin's own account into custody                                   |
| `close_unused_trader`                                               | admin              | Closes a seat that was never used since it was opened, with its view; rent back to the exchange                                       |
| `restrict_market`                                                   | admin              | Pauses a market or makes it reduce-only, at any time; never back to active                                                            |
| `withdraw`                                                          | owner              | Debits the seat within margin and pays the owner's own token account out of custody                                                   |
| `place_order`, `cancel_order`, `cancel_all`, `sync_view`            | one order key      | Trading; each writes its outcome and the seat copy into the view                                                                      |
| `liquidate`                                                         | one order key      | Takes over an unhealthy position; every refusal is an outcome, and "nothing to liquidate" is one value                                |
| `publish_price`, `reset_price`                                      | oracle; admin      | The mark within the move limit and publish gap; the admin's reset, which puts the market in reduce-only status, or leaves it paused   |
| `resume_market`                                                     | admin              | Back to normal status, only while the market has no recorded shortfall                                                                |
| `update_funding`, `schedule_funding`                                | anyone; admin      | Advance a perp's funding index once per interval; ask the rollup's scheduler to call it every so often                                |
| `transfer_between_balances`                                         | one order key      | Moves collateral-token value between the seat's spot balance and its perp collateral; no token leaves custody                         |
| `cover_shortfall`                                                   | anyone             | The insurance seat covers a flat seat's negative collateral, down to what the market recorded                                         |
| `reconcile_shortfall`                                               | anyone             | Lowers the recorded shortfalls to what flat seats still owe after a debtor repaid by deposit; never raises one                        |
| `move_fees_to_insurance`, `collect_fees`                            | admin              | Perp fees from the fee seat to the insurance seat; any fees out of the fee seat and custody to a chosen account                       |

Every order-key instruction takes `expires_at` (unix seconds), the replacement key, a client order id the result is filed under, and, except for `transfer_between_balances`, the market id. `place_order`, `liquidate`, `withdraw` and `transfer_between_balances` take the other perp markets as remaining accounts, three per market (market, book, price feed), each checked like the market being traded, so a cross-margin account is valued over every market it holds a position on. `reconcile_shortfall` takes the market account of every perp market, by rising id, and refuses a partial list.

Errors are one enum with stable codes: 6001 to 6099 are the engine's own, one to one; this program's begin at 6100. The interface file is `target/idl/noirwire_orderbook.json` after a build.

### Outcomes

A transaction that touches a sealed account shows nothing to anyone, its sender included, so every order-key instruction writes an `OrderResult` into the view's ring of 16 (newest first in the decoder). For a placed order the status is the engine's `PlaceStatus` code: filled (1), rested (2), remainder cancelled (3), step limit (4), book full (5), post-only would match (6), fill check (7); `order_seq` is the resting remainder's sequence number, to cancel by, and means nothing when `rested` is zero. For a liquidation it is liquidated (1), stale price (5), liquidator margin insufficient (7) or nothing to liquidate (8). The last stands for the engine's target seat not open, no position, not liquidatable and worst price exceeded, written with every number zero, so an attempt does not tell a liquidator whether a seat exists or holds a position; nothing about the target ever becomes an error. A liquidation adds nothing to the public volume or fill counters; it moves public open interest when the liquidator's own position offsets what it takes over. A transfer between balances reports done (0) with the amount in `filled`. A cancel or sync reports done (0); a cancel of a gone order reports refused (100) with the engine code in `code`. Fills are appended to the public tape with the two receipts of RULES 10, and the client recognises its own by recomputing them from its order secrets.

## The client

`sdk/` builds to `sdk/dist` as ES modules and packs to `sdk/noirwire-orderbook-<version>.tgz` (`make sdk`, which keeps only the current version's file), the file an app's `package.json` points at by URL. It runs in Node 24 and in a browser; it imports nothing from Node. Dependencies, pinned exactly: `@solana/web3.js` 1.99.0, `@solana/spl-token` 0.4.15, `@magicblock-labs/ephemeral-rollups-sdk` 0.17.3, `@noble/hashes` 1.8.0.

- `Addresses` derives every address. `Instructions` builds every instruction with the accounts in the program's order; the suite checks each one against the interface file.
- `decodeMarket`, `decodeTape`, `decodePriceFeed`, `decodeStats`, `decodeView`, `decodeLedger`, `decodeExchange` read account data with integers as `bigint`.
- `OrderKeyManager` derives order key `i` from a 32-byte seed as `Keypair.fromSeed(sha256("noirwire-orderbook/order-key/v1" || seed || i as u64 LE))`, keeps the four live keys, lends one out with its replacement, and recovers its position from a view: `restore` from a `checkpoint` the app saved (a few derivations), or `fromView`, which searches from index 0 and is for a device with no checkpoint. A slot stays lent to its call until that call settles it against the key the view shows, so concurrent calls never share a key.
- `randomSecret`, `receipt` and `ownFills` are RULES 10.
- `privateConnection(url, owner, signMessage)` signs in to the private endpoint and returns a connection that reads as the owner.
- `TraderClient.placeOrder` signs with a one-time key and an expiry (5 seconds by default, at most 60), sends, and confirms from the view's result ring, resending the same signed bytes every second until the expiry. The device's clock only decides when to stop waiting: with no result by then the outcome is `unknown`, because the order may still run under the rollup's clock, and its order key and client order id stay out of use. `settled` on that outcome resolves to `placed` or, once the rollup's own clock is two seconds past the expiry and the view shows no result, to `expired`; only then is the key lent again. A result counts only if it was written after the call began, with the call's client order id and kind. The id is always the client's own 64 random bits, held by no other call in flight and by no result in the ring, and is returned as `clientOrderId`. An order off the tick or below the market's minimums is refused before signing (`OrderInvalid`). Execution is never read from `getSignatureStatuses`; it is asked once, after 400 ms without a result, only to learn that the transaction failed, which is thrown as `TransactionFailed` instead of being waited out. Results carry `sentAt` and `resultAt` in monotonic milliseconds. Everything is sent with preflight skipped. `cancelOrder`, `cancelAll`, `syncView`, `liquidate` and `transferBetweenBalances` work the same way, except that they throw `OutcomeUnknown`, which carries the same `settled` promise, where `placeOrder` returns `unknown`. A call whose reads fail after it was sent throws `OutcomeUnknown` too, with the failure as its `cause`.
- A call costs one request, its send. From its first call (or from `ready()`, which waits for all three) the client keeps in the background: a blockhash, fetched every 15 seconds and never for a call; the rollup's clock as an offset from the device's, measured every five minutes and whenever the clock is read anyway, which the expiry is counted from unless `now` is given, at most 58 seconds ahead; and the trader's own view, pushed over a websocket account subscription to the reader's endpoint with the reader's sign-in token. The result is taken from that subscription, also when it arrives before the send has answered. The view is read instead while the subscription is not established or is down, and once it has delivered nothing for `pushWaitMs` (500 ms). A dropped socket is opened again after a wait that doubles from 250 ms to five seconds, subscribed again and the view read once more, so no write is missed; `renewReader(connection)` does the same with a newly signed-in reader. A send refused with "blockhash not found" is signed and sent once more with a new blockhash, and an instruction refused as `Expired` or `ExpiryTooFar` under the estimated clock is tried once more after reading the clock. `new TraderClient(..., { push: false })` subscribes to nothing and reads the view for every result. A client that has made a call holds a websocket and a timer: `close()` ends both, and a Node process that never calls it does not end by itself.
- `MarketReader` reads and subscribes to the tape, a price feed and the stats; `TraderClient.subscribeView` to the own view.
- `setupLedger` and `setupMarket` run the multi-transaction creation and are safe to repeat.

## Build and test

You need Rust (the version in `rust-toolchain.toml` is picked up by itself), the Solana CLI 2.3.11, Anchor 1.2.1 and Node 24 or later. The Anchor CLI and the `anchor-lang` crate are both 1.2.1. With `avm`, `make` uses `anchor-1.2.1` directly whatever version is active, and refuses to build with any other version: run `avm install 1.2.1`. Anchor 1.2.1 builds for SBPF v3 by default, which the local validators do not load, so `make build` asks for `--arch v0`.

```sh
make install        # npm ci, for the tests and the client
make build          # the program and its interface file
make test           # build, build the client, run make unit, start a fresh local network, run the suite, stop it
make unit           # the client against a fake connection, and what the ops scripts decide; no network
make check          # cargo fmt, clippy with warnings as errors, prettier, tsc for the client, the tests and ops
make format         # cargo fmt and prettier, writing
make audit          # cargo audit over Cargo.lock
make sdk            # build the client and pack the release .tgz, removing older ones
make up / down      # the local network in the background, for the local-* targets
make local-setup    # exchange, ledger, three markets, two mints, custody, faucet; prints JSON; safe to repeat
make local-status   # what is deployed there
make local-smoke    # two kept traders deposit, fill and cancel there; counts and times orders
make clean          # remove .localnet with its throwaway keys, the build leftovers and the packed client
```

`make devnet-setup`, `make devnet-status` and `make devnet-smoke` are the same three against devnet (see "Deploying").

`make test` starts a Solana validator, a private rollup and its query filter on ports 8899, 7799 and 6699 (websockets one port up), runs every test against them and stops them. Nothing reaches a public network. The program is loaded at its declared address with a throwaway key under `.localnet` as its upgrade authority.

### The local deployment

`make local-setup` against a running `make up` network sets up what the other services expect and prints a description they read, also written to `.localnet/deployment.json`: the program id, the exchange, custody authority, ledger and stats addresses, the gate, oracle and faucet public keys, the two test mints (nUSD, 6 decimals, and nSOL, 9 decimals) with their decimals and their custody accounts, the address deposits and withdrawals are sent to (`depositUrl`), and three markets with their four addresses, base and quote decimals, lot size and tick each. The faucet key under `.localnet/localnet-faucet.json` holds 10,000,000 nUSD and 100,000 nSOL inside the rollup, so test money comes from an ordinary deposit by that key, sent to `depositUrl`. The exchange is created with the client's default of 100 new seats a day; the admin raises it with `update_exchange`.

| Market       | Kind | Lot        | Price unit         | Initial mark       | Max leverage | Maintenance | Penalty | Taker fee | Crossing band | Max move | Funding    |
| ------------ | ---- | ---------- | ------------------ | ------------------ | ------------ | ----------- | ------- | --------- | ------------- | -------- | ---------- |
| `NSOL-PERP`  | perp | 0.001 SOL  | nUSD atoms per lot | 150,000 ($150/SOL) | 10x          | 5%          | 2%      | 5 bps     | 4%            | 2.5%     | every 60 s |
| `NNVDA-PERP` | perp | 0.01 share | nUSD atoms per lot | 1,800,000 ($180)   | 10x          | 5%          | 2%      | 5 bps     | 4%            | 2.5%     | every 60 s |
| `NSOL-NUSD`  | spot | 0.001 SOL  | nUSD atoms per lot | 150,000            |              |             |         | 5 bps     | 4%            | 2.5%     |            |

These satisfy RULES 12 (penalty plus fee below maintenance, band and funding cap within the margin gap, max move below maintenance less penalty). Half of each penalty and half of each taker fee go to the insurance seat; the open interest cap is 10,000,000 lots. Funding on the perps is scheduled with the rollup's built-in scheduler, which calls `update_funding` every 60 seconds signed by the validator at no cost. The oracle must publish at least every 10 seconds (`max_price_age`; liquidations tolerate 60), at most once a second, or orders that increase exposure and withdrawals by position holders are refused as stale.

## Deploying

Nothing here deploys by itself, and nothing in this repository reaches mainnet. The `devnet-setup`, `devnet-status` and `devnet-smoke` targets run the same scripts against devnet with keys under `.keys` (git-ignored; `devnet-admin.json`, the upgrade authority, is put there by hand). On devnet the exchange is delegated, the ledger is sealed, the two test tokens are registered with public custody and the three markets are ready; `make devnet-smoke` deposits, fills, cancels and then counts the requests and times thirty resting and thirty crossing orders there, with the result pushed and with it polled for, and `make local-smoke` does the same against a local deployment with sealed custody. Funding on devnet does not advance by itself: the hosted rollup stops running a scheduled funding task after one run that found the price stale, so until the program or the oracle service answers that, someone has to call `update_funding`. Before real money: the upgrade authority on a multisig, a price feed whose signature the program verifies, and a settled answer to withdrawal back to Solana (`DESIGN.md` section 6 and 7).

## Security

Every instruction checks who signed, which program owns each account, that each address is the one its seeds derive, and that each writable account was passed writable. Arithmetic is checked and the release build keeps overflow checks on. The contact for reports is embedded in the program with `solana-security-txt`. What a leaked order key can and cannot do, and the rest of the threat model, is in [SECURITY.md](SECURITY.md).

## Licence

Copyright (c) 2026 NoirWire. All rights reserved. Published for transparency; no licence is granted. See [LICENSE](LICENSE).

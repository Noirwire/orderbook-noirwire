# @noirwire/orderbook

The TypeScript client for NoirWire's private order book, which runs inside MagicBlock's Private Ephemeral Rollup: addresses, instruction builders, account decoders, one-time order keys, receipts, sign-in to the private endpoint, and a `TraderClient` whose `placeOrder` confirms from the trader's own view.

Orders rest and match inside a private rollup. Other traders and the public cannot read the book, the ledger of seats or another trader's view, except that a trader can find each side's best price inside the crossing band with a few post-only orders ([DESIGN.md](../docs/DESIGN.md) section 1, limit 4); the rollup operator can see, order, delay or drop transactions inside the rollup. The tape of fills, the mark prices, the market settings and the lifetime counters are public. Every trading instruction is signed by a one-time key, so an observer who lists signatures cannot link two orders to each other or to a wallet by their signer; fills, timing, deposits and withdrawals can still link activity ([DESIGN.md](../docs/DESIGN.md) section 1).

## Install

The package is not published to npm. `make sdk` in this repository builds it and packs `sdk/noirwire-orderbook-<version>.tgz`; install that file by path or by URL:

```
npm install /path/to/noirwire-orderbook-<version>.tgz @solana/web3.js tweetnacl
```

Node 24 or newer, or a browser. The package is ESM only.

## A trader

A trader signs in to the private endpoint as the owner, which gives a connection that may read the trader's own view. The same connection sends. The order keys come from a seed only the trader keeps.

```ts
import nacl from "tweetnacl";
import {
  OrderKeyManager,
  ORDER_TYPE,
  PROGRAM_ID,
  SIDE,
  TraderClient,
  privateConnection,
} from "@noirwire/orderbook";

const rollupUrl = "https://devnet-tee.magicblock.app";
const marketId = 0;

// `owner` is the trader's Keypair, `seed` a 32-byte secret the owner keeps.
const connection = await privateConnection(
  rollupUrl,
  owner.publicKey,
  async (message) => nacl.sign.detached(message, owner.secretKey),
);

// The four keys the trader's account was opened with; see `OrderKeyManager.restore`
// and `OrderKeyManager.fromView` to pick them up again on another device.
const keys = OrderKeyManager.fresh(seed);

const client = new TraderClient(
  connection,
  connection,
  owner.publicKey,
  keys,
  PROGRAM_ID,
);
await client.ready();

const placed = await client.placeOrder(
  marketId,
  {
    side: SIDE.bid,
    orderType: ORDER_TYPE.postOnly,
    price: 100_000n, // quote atoms per lot, a multiple of the market's tick
    size: 10n, // lots
    reduceOnly: false,
  },
  { expirySeconds: 5 },
);

if (placed.outcome === "placed") {
  console.log(placed.result.status, placed.result.orderSeq);
} else if (placed.outcome === "unknown") {
  console.log((await placed.settled).outcome); // it could still have run: wait for what became of it
}

client.close();
```

`placeOrder` returns `placed` once the result shows in the trader's view, `expired` when the order can no longer run, or `unknown` while it could still run; `settled` then resolves to one of the first two. A call the program refuses throws `TransactionFailed`; an order the client can see is invalid from the market's public settings throws `OrderInvalid`, before anything is signed. `cancelOrder`, `cancelAll` and `syncView` return the result, or throw `OutcomeUnknown`, whose `settled` resolves to it.

Every call reads the exchange's perp markets, at most every 30 seconds, and names all of them whatever market it is for, so that the public accounts a call names do not tell what kind of call it is. No call asks the compute budget program for compute: `cancelAll` and `liquidate` are sent with the program's `extend_compute` instead, for 400,000 units.

Save `keys.checkpoint` after every call and pass it to `OrderKeyManager.restore` to start a later session without searching the derivation from the start.

## Unreleased

For the program that holds take-profit and stop-loss triggers. Every market has a sealed trigger book, and every order-key instruction names it, so apps built on 0.10 must move to this version before the program changes.

- `Addresses.triggers(marketId)` is the book, at `["trigger", market_id]` (`TRIGGER_SEED`). Every builder of an order-key instruction (`placeOrder`, `cancelOrder`, `cancelAll`, `syncView`, `liquidate`, `liquidateRange`, `transferBetweenBalances`) now names it, writable, after the stats account and before the risk accounts.
- `setTrigger(call, { kind, triggerPrice, worstPrice, size, expiry?, secret })` and `cancelTrigger(call, kind)` are order-key instructions; `TraderClient.setTrigger(marketId, trigger)` and `TraderClient.cancelTrigger(marketId, kind)` send them. `kind` is `TRIGGER_KIND.takeProfit` or `stopLoss`; a `size` of 0 closes whatever position stands when the trigger fires. A refusal that depends on the seat's position, side or other trigger is a result with status `RESULT_STATUS.refused` and its `code` (`TRIGGER_ERROR` for the new ones), never a thrown error; `TRIGGER_RESULT_KIND` names the two result kinds. The result's `clientOrderId` is the trigger's own id.
- `fireTriggers(marketId, maxFires, riskMarkets?)` and `sweepTriggers(marketId, count)` are for anyone and carry no key. Firing places the reduce-only market order of each due trigger, at most `MAX_FIRES_PER_PASS`; a sweep reads up to `SWEEP_TRIGGER_SLOTS_PER_CALL` slots and returns nothing.
- `createTriggerBook(admin, marketId)` and `finalizeTriggerBook(admin, marketId)` set up a market's book, with `growAccount` and `GROW_KIND.triggers` between them; `setupTriggerBook(connection, admin, marketId, kind)` runs the three. The book is sized once, from the ledger's seats as they stand (`triggerAccountLen(seats)`; a spot market's holds none), so extend the ledger first. A market needs its book before anyone trades on it.
- `setOrderKeys` and `setOrderKeysSigned` take the exchange and the ledger, and `perpMarketIds`: the reset clears the seat's triggers in every perp market's book, and the program refuses unless it is handed all of them. `OwnerReplacement.perpMarkets` carries them for `replaceKeysSignedTransaction`.
- The trigger book is sealed, so no client can read it and the SDK does not decode it. The trader's own view shows the status of their triggers instead: `view.snapshot.triggerStatus` is `{ marketId, takeProfit, stopLoss }`, each `{ state: "armed" | "unfillable" | "gone", nextAttempt? }`, as of the last `syncView` on that market, or `null` when unknown (any other call rewrites the snapshot, so sync again).
- The orders a trigger places carry the trader's own `secret` (16 bytes, drawn with `randomSecret` as for `placeOrder`), so the receipts of a fired order are `receipt(secret, fillSeq, role)`; pass the secret to `ownFills`. `TraderClient.setTrigger` draws one when the trigger carries none and returns it.
- `MAX_PERP_MARKETS` is 7: with the book named, `place_order` on 8 perp markets is 1,260 bytes and does not fit one packet.
- `resetSlotGeneration(call, slot)` is an order-key instruction and `TraderClient.resetSlotGeneration(slot)` sends it: it sets the generation of one physical slot (0 to 3) of the trader's own seat back to zero when the slot is empty and no perp market's trigger book holds a record of the seat, and otherwise succeeds and changes nothing, so a call reveals nothing about the seat. Sync the view and read `Seat.slotGenerations` to see whether it took. `call.riskMarkets` must be every perp market the exchange has.
- `Seat.slotGenerations` lists the generation of every physical slot, untagged ones included; `Position.generation` is the same number for a tagged slot. A slot stops at 255 and takes no trigger until it is reset.
- `TRIGGER_ERROR` (163 to 173) and `TRIGGER_TRANSACTION_ERROR` (6163 to 6173) name the new refusals.

## 0.10.0

For the program that reads MagicBlock's price oracle alone. The program has no second price, so the client has no breaker, no mark source and no price update to post.

- A market's price source is a MagicBlock feed number: `PriceSourceSettings` is `{ feed, baseDecimals, quoteDecimals }` (SOL/USD is feed 6, USDC/USD is feed 7), and `QuoteSettings` is `{ feed, depegBps, maxAge }`. The exponent is fixed at -8. `magicblockPriceAccount(feed)` is the account the market reads; the receiver and push-oracle ids and the account helper built on them are gone.
- `syncPrice(marketId, oraclePrice)` takes the market, the price feed and the one MagicBlock account, with no fourth account. `syncQuote(oraclePrice)` takes the exchange and the USDC account.
- `setPriceSource(admin, marketId, feed)` rebinds a market to a feed number while the market is paused; a market with positions keeps its mark. `setQuoteSource` binds the USDC guard to a feed number. `setMarkSource` is gone.
- `SourceBinding` and `QuoteGuard` carry `feed` where they carried `feedId`, and no `maxConfBps`. `Market` loses `breakerBps`, `markFeed`, `breakerAge` and `liquidationBand`.
- The operator entry point drops the breaker, the liquidation gate and the paid reference price: `firstSyncFailure(observation, clock, limits)` checks one MagicBlock observation, `checkedObservation(address, account, bound)` reads one as the program does, `referenceSources(lot, fetch)` and `launchReferenceSources(fetch)` take only the public exchanges, and `MAINNET_MARK_SOURCE` is gone. `maxAgeLiquidation` is gone from `MarketLimits` and `MarketParams`: liquidation uses `maxPriceAge` and is refused unless every market it values is healthy. `SourceRecord.conf` and `QuoteGuard.conf`, and `QuoteGuard.expo`, are gone (reserved bytes). The mainnet profile launches with `maxPriceAge` 10, since MagicBlock publishes about ten times a second with whole-second publish times.

## 0.9.0

For the program that grows its trader ledger and holds four markets per seat. A trader no longer gets a seat when its view opens: the first collateral deposit takes one, and an empty seat goes back to the exchange. Apps built on 0.8 must move to this version before the program changes, because the seat layout and several instructions' accounts changed.

- A seat is 304 bytes (`SEAT_LEN`) and holds up to `SEAT_SLOTS` (4) markets. `Seat.perp` is gone: read positions with `positionOn(seat, marketId)`, or `seat.positions`, each tagged with its `marketId`. `decodeSeat` reads the new layout and `decodeLegacySeat` the 448-byte one.
- The ledger lives at `["ledger-v2"]` (`SEEDS.ledger`), sized from its length (`ledgerSeats`, `ledgerLen`); `freeSeats` walks its free list. `LEGACY_LEDGER_SEED` names the old one.
- A view records `NO_SEAT` until a deposit seats it. An order-key call on an unseated view throws `NotSeated`; `TraderClient.confirmSeat` runs `sync_view` and says whether the seat is held. `seatDepositRefusal` says why a first deposit would be refused before anything is signed.
- `openTrader` and `openTraderSigned` take no ledger; `deposit` takes the view writable; `setSeatAccess` takes the view and `bigint` market lists.
- `decodeExchange` adds `layoutState`, `minSeatDeposit`, `relayoutNext` and `seatCapacity`. The custody cap and `setCustodyCap` are gone.
- New builders: `extendLedger`, `migrateExchange`, `liquidateRange`, `coverShortfallRange`, `releaseEmptySeats`, `createRelayoutLedger`, `relayoutSeats`, `finishRelayout`; `TraderClient.liquidateRange`. A liquidation whose liquidator has no free slot reports `liquidatorSlotsFull`, and a full seat refuses an order with `SlotsFull` (93).

## 0.8.2

A wait that was computed from a clock reading and came out slightly negative no longer makes Node print `TimeoutNegativeWarning`; it is treated as no wait.

## 0.8.1

`verifyOwnerSignature` and the proof builders also take the off-chain message specification's header (`"spec"`), which the program accepts; pass `programId` to `verifyOwnerSignature` for it to be checked. 0.8.0 as first packed knew only `"raw"` and `"envelope"`.

## 0.8.0

The owner can consent to opening a trader and to replacing its order keys by signing a message instead of a transaction, and an order key can withdraw to the owner's own token account. Nothing existing changed, except that `View.ownerNonce` now reads the counter of owner key replacements, signed or not (`set_order_keys` moves it too), and that the package depends on `@noble/curves` 1.9.7.

- `ownerActionMessage` is the text to sign. `ownerExpiry(rollupClockSeconds, lifetime = 100)` is the expiry to put in it (never more than `MAX_OWNER_EXPIRY_AHEAD`, 120 seconds, past the rollup's clock), and `verifyOwnerSignature(message, signature, owner, programId?)` checks a signature before anything is paid for, returning `"raw"`, `"envelope"`, `"spec"` (the Anza off-chain message specification's header, `ownerActionSpecEnvelope`, checked when `programId` is given) or null.
- A hardware wallet signs the Solana off-chain message format, not the raw bytes. `ownerActionEnvelope(message)` is that wrapping (version 0, limited UTF-8), and the program takes either form of exactly the action's text. `Instructions.openTraderProof` and `setOrderKeysProof` take the form (`"raw"` by default) the signature covers.
- `openSignedTransaction(connection, instructions, gate, open)` and `replaceKeysSignedTransaction(connection, instructions, feePayer, replacement)` build and sign the whole transaction, the proof first. The gate pays for the open; any key can pay for the replacement, since the owner does not sign it.
- `OWNER_ERROR` (151 to 154) and `OWNER_TRANSACTION_ERROR` (6151 to 6154, as `TransactionFailed.code` reports them) name the refusals.
- `TraderClient.withdrawByKey(token, asset, amount, expirySeconds?)` pays the owner's associated token account for the token's mint. The program writes no result for it, so the client reads the key swap in the view instead; a refusal throws `TransactionFailed` with the key still live, and a withdrawal sent but not seen throws `WithdrawalUnknown`, whose `settled` resolves to the withdrawal, to null once it can no longer run, or to a `WithdrawalUndetermined` (`undetermined: true`) when the owner replaced the order keys since the send (`View.ownerNonce` moved), because the replacement key in the slot is then no proof the withdrawal ran: read the owner's token account to tell. It is never reported as withdrawn in that case. It names every perp market the exchange has, which fits one packet for at most seven; an exchange with eight perp markets cannot use it.

## 0.7.0

A second entry point, `@noirwire/orderbook/operator`, holds what an operator decides without a network, a file or a key: the test and mainnet profiles' settings, reading a MagicBlock price account, the reference price a first mark is checked against, the launch steps and the check before `resume_market`, the access lists' values, and whether a deployed program is the mainnet build. Nothing in it reads the environment, and every function that asks a server takes a `fetch` to ask with. The main entry point is unchanged.

```ts
import {
  MAINNET_MARKET,
  gatherQuotes,
  launchReferenceSources,
  referenceOf,
} from "@noirwire/orderbook/operator";

const { quotes } = await gatherQuotes(launchReferenceSources());
const reference = referenceOf(quotes); // quote atoms per lot of MAINNET_MARKET
```

## 0.6.0

This version removes what earlier versions kept only so old callers would still compile. TypeScript names every caller it breaks.

- `TraderClient.transferBetweenBalances(toCollateral, spotToken, amount, expirySeconds?)` and `TraderClient.liquidate(marketId, target, size, worstPrice, expirySeconds?)` no longer take a `riskMarkets` array before `expirySeconds`. Plain JavaScript that still passes the array followed by `expirySeconds` now hands the array over as the expiry: drop the array.
- `PlaceOrderOptions.riskMarkets` is gone. Every call already names every perp market the exchange has, read from the exchange. `OrderKeyCall.riskMarkets` and the `riskMarkets` of `Instructions.withdraw` stay: they are what the builders name.
- `LIQUIDATION_STATUS` loses `targetSeatNotOpen`, `noPosition`, `notLiquidatable` and `worstPriceExceeded`, which the program never writes: it records each of them as `nothingToLiquidate`.
- `headerLen` is gone; `HEADER_LEN` is the same number.
- `ExchangeUpdate` no longer has a `collateralToken` field. The collateral token is fixed when the exchange is created, and `updateExchange` never sent it.

## More

The whole repository, its design documents and what the program does and does not guarantee are in the [root README](../README.md). This package is the client only; the program is in `programs/` and the rules it enforces are in `docs/RULES.md`.

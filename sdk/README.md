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

## 0.8.0

The owner can consent to opening a trader and to replacing its order keys by signing a message instead of a transaction, and an order key can withdraw to the owner's own token account. Nothing existing changed, except that `View.ownerNonce` now reads the counter of owner key replacements, signed or not (`set_order_keys` moves it too), and that the package depends on `@noble/curves` 1.9.7.

- `ownerActionMessage` is the text to sign, `ownerExpiry(rollupClockSeconds, lifetime = 100)` the expiry to put in it (never more than `MAX_OWNER_EXPIRY_AHEAD`, 120 seconds, past the rollup's clock), and `verifyOwnerSignature(message, signature, owner)` checks a signature before anything is paid for, returning `"raw"`, `"envelope"` or null.
- A hardware wallet signs the Solana off-chain message format, not the raw bytes. `ownerActionEnvelope(message)` is that wrapping (version 0, limited UTF-8), and the program takes either form of exactly the action's text. `Instructions.openTraderProof` and `setOrderKeysProof` take the form (`"raw"` by default) the signature covers.
- `openSignedTransaction(connection, instructions, gate, open)` and `replaceKeysSignedTransaction(connection, instructions, feePayer, replacement)` build and sign the whole transaction, the proof first. The gate pays for the open; any key can pay for the replacement, since the owner does not sign it.
- `OWNER_ERROR` (151 to 154) and `OWNER_TRANSACTION_ERROR` (6151 to 6154, as `TransactionFailed.code` reports them) name the refusals.
- `TraderClient.withdrawByKey(token, asset, amount, expirySeconds?)` pays the owner's associated token account for the token's mint. The program writes no result for it, so the client reads the key swap in the view instead; a refusal throws `TransactionFailed` with the key still live, and a withdrawal sent but not seen throws `WithdrawalUnknown`, whose `settled` resolves to the withdrawal, to null once it can no longer run, or to a `WithdrawalUndetermined` (`undetermined: true`) when the owner replaced the order keys since the send (`View.ownerNonce` moved), because the replacement key in the slot is then no proof the withdrawal ran: read the owner's token account to tell. It is never reported as withdrawn in that case. It names every perp market the exchange has, which fits one packet for at most seven; an exchange with eight perp markets cannot use it.

## 0.7.0

A second entry point, `@noirwire/orderbook/operator`, holds what an operator decides without a network, a file or a key: the test and mainnet profiles' settings, reading a Pyth price account, the reference price a first mark is checked against, the launch steps and the check before `resume_market`, the access lists' values, and whether a deployed program is the mainnet build. Nothing in it reads the environment: `proLatest`, `referenceUrl` and `launchReferenceSources` take the Pyth Pro token and URL as arguments, and every function that asks a server takes a `fetch` to ask with. The main entry point is unchanged.

```ts
import {
  MAINNET_MARKET,
  gatherQuotes,
  launchReferenceSources,
  referenceOf,
} from "@noirwire/orderbook/operator";

const { quotes } = await gatherQuotes(
  launchReferenceSources(true, pythProToken),
);
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

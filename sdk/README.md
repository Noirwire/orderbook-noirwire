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

## 0.6.0

This version removes what earlier versions kept only so old callers would still compile. TypeScript names every caller it breaks.

- `TraderClient.transferBetweenBalances(toCollateral, spotToken, amount, expirySeconds?)` and `TraderClient.liquidate(marketId, target, size, worstPrice, expirySeconds?)` no longer take a `riskMarkets` array before `expirySeconds`. Plain JavaScript that still passes the array followed by `expirySeconds` now hands the array over as the expiry: drop the array.
- `PlaceOrderOptions.riskMarkets` is gone. Every call already names every perp market the exchange has, read from the exchange. `OrderKeyCall.riskMarkets` and the `riskMarkets` of `Instructions.withdraw` stay: they are what the builders name.
- `LIQUIDATION_STATUS` loses `targetSeatNotOpen`, `noPosition`, `notLiquidatable` and `worstPriceExceeded`, which the program never writes: it records each of them as `nothingToLiquidate`.
- `headerLen` is gone; `HEADER_LEN` is the same number.
- `ExchangeUpdate` no longer has a `collateralToken` field. The collateral token is fixed when the exchange is created, and `updateExchange` never sent it.

## More

The whole repository, its design documents and what the program does and does not guarantee are in the [root README](../README.md). This package is the client only; the program is in `programs/` and the rules it enforces are in `docs/RULES.md`.

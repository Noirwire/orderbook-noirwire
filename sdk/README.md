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

Save `keys.checkpoint` after every call and pass it to `OrderKeyManager.restore` to start a later session without searching the derivation from the start.

## More

The whole repository, its design documents and what the program does and does not guarantee are in the [root README](../README.md). This package is the client only; the program is in `programs/` and the rules it enforces are in `docs/RULES.md`.

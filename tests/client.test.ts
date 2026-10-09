import { expect } from "chai";
import {
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  Transaction,
  type Connection,
} from "@solana/web3.js";
import {
  ACCOUNT_LEN,
  ACCOUNT_TAG,
  Addresses,
  ORDER_TYPE,
  OrderInvalid,
  OrderKeyManager,
  RESULTS,
  RESULT_KIND,
  SIDE,
  TraderClient,
  TransactionFailed,
  Writer,
  bytesEqual,
  instructionData,
  writtenSince,
  type OrderResult,
} from "../sdk/dist/index.js";

type Written = { clientOrderId: bigint; kind: number };

const KIND_OF: [string, number][] = [
  ["place_order", RESULT_KIND.place],
  ["cancel_all", RESULT_KIND.cancelAll],
  ["sync_view", RESULT_KIND.sync],
];

const NOT_ORDER_KEY = { InstructionError: [0, { Custom: 6123 }] };

/**
 * The rollup as far as the client can tell: a view with four order keys and
 * a ring of results, a market's public settings, and transactions that land
 * when the test says so. Nothing here touches a network.
 */
class FakeRollup {
  readonly owner = Keypair.generate().publicKey;
  readonly addresses = new Addresses();
  orderKeys: PublicKey[];
  written: Written[] = [];
  held: Transaction[] = [];
  holding = false;
  failing = false;
  sends = 0;
  /** The rollup's own clock, which the device's clock need not agree with. */
  clock = () => Math.floor(Date.now() / 1000);
  private statuses = new Map<string, unknown>();

  constructor(keys: OrderKeyManager) {
    this.orderKeys = keys.publicKeys;
  }

  private static id(transaction: Transaction): string {
    return Buffer.from(transaction.signature!).toString("hex");
  }

  /**
   * What the program does with an order-key instruction: refuse it past its
   * expiry by the rollup's clock, else swap the key and write a result.
   */
  land(transaction: Transaction): void {
    const data = transaction.instructions[0].data;
    const slot = this.orderKeys.findIndex((key) =>
      key.equals(transaction.feePayer!),
    );
    const expired = BigInt(this.clock()) > data.readBigInt64LE(8);
    if (slot < 0 || this.failing || expired) {
      this.statuses.set(FakeRollup.id(transaction), NOT_ORDER_KEY);
      return;
    }
    this.orderKeys[slot] = new PublicKey(data.subarray(16, 48));
    const kind = KIND_OF.find(([name]) =>
      bytesEqual(data.subarray(0, 8), instructionData(name).build()),
    )![1];
    this.written.push({ clientOrderId: data.readBigUInt64LE(48), kind });
    this.statuses.set(FakeRollup.id(transaction), null);
  }

  release(index: number): void {
    this.land(this.held.splice(index, 1)[0]);
  }

  private view(): Buffer {
    const writer = new Writer()
      .bytes(new TextEncoder().encode(ACCOUNT_TAG.view))
      .bool(true)
      .bytes(new Uint8Array(7))
      .pubkey(this.owner);
    for (const key of this.orderKeys) writer.pubkey(key);
    writer.u32(2).u32(this.written.length);
    const ring = new Uint8Array(RESULTS * 64);
    this.written.forEach((result, nth) => {
      if (nth < this.written.length - RESULTS) return;
      const at = new DataView(ring.buffer, (nth % RESULTS) * 64, 64);
      at.setBigUint64(0, result.clientOrderId, true);
      at.setUint8(56, result.kind);
    });
    const head = writer.bytes(ring).build();
    return Buffer.concat([head, Buffer.alloc(ACCOUNT_LEN.view - head.length)]);
  }

  private market(): Buffer {
    const head = new Writer()
      .bytes(new TextEncoder().encode(ACCOUNT_TAG.market))
      .bool(true)
      .bytes(new Uint8Array(7))
      .u64(100n)
      .u64(1_000n)
      .u64(2n)
      .u64(1_000n)
      .build();
    return Buffer.concat([
      head,
      Buffer.alloc(ACCOUNT_LEN.market - head.length),
    ]);
  }

  get connection(): Connection {
    const fake = {
      getLatestBlockhash: async () => ({
        blockhash: PublicKey.default.toBase58(),
        lastValidBlockHeight: 1,
      }),
      sendRawTransaction: async (raw: Buffer) => {
        this.sends += 1;
        const transaction = Transaction.from(raw);
        if (this.holding) this.held.push(transaction);
        else if (!this.statuses.has(FakeRollup.id(transaction))) {
          this.land(transaction);
        }
        return FakeRollup.id(transaction);
      },
      getSignatureStatus: async (signature: string) => ({
        value: this.statuses.has(signature)
          ? { err: this.statuses.get(signature) }
          : null,
      }),
      getAccountInfo: async (address: PublicKey) => {
        if (address.equals(SYSVAR_CLOCK_PUBKEY)) {
          const data = Buffer.alloc(40);
          data.writeBigInt64LE(BigInt(this.clock()), 32);
          return { data };
        }
        return {
          data: address.equals(this.addresses.view(this.owner))
            ? this.view()
            : this.market(),
        };
      },
    };
    return fake as unknown as Connection;
  }
}

const seed = () => globalThis.crypto.getRandomValues(new Uint8Array(32));

function trader() {
  const keys = OrderKeyManager.fresh(seed());
  const rollup = new FakeRollup(keys);
  const client = new TraderClient(
    rollup.connection,
    rollup.connection,
    rollup.owner,
    keys,
  );
  return { keys, rollup, client };
}

const bid = {
  side: SIDE.bid,
  orderType: ORDER_TYPE.limit,
  price: 1_000n,
  size: 2n,
  reduceOnly: false,
};

const sameKeys = (keys: OrderKeyManager, rollup: FakeRollup) =>
  expect(keys.publicKeys.map(String)).to.deep.equal(
    rollup.orderKeys.map(String),
  );

const until = async (condition: () => boolean) => {
  while (!condition()) await new Promise((resolve) => setTimeout(resolve, 5));
};

const SENT_AT = 1_000;
const EXPIRES_AT = SENT_AT + 1;

/**
 * An order the rollup holds back while the device's clock runs ten seconds
 * ahead of the rollup's: the client stops waiting with the order still able
 * to run.
 */
async function givenUpOn(rollup: FakeRollup, client: TraderClient) {
  rollup.holding = true;
  rollup.clock = () => SENT_AT;
  let device = SENT_AT;
  const call = client.placeOrder(0, bid, {
    now: () => device,
    expirySeconds: EXPIRES_AT - SENT_AT,
    pollMs: 1,
  });
  await until(() => rollup.held.length === 1);
  rollup.holding = false;
  device += 10;
  return { call, lent: rollup.held[0].feePayer! };
}

describe("the client, against a fake rollup", () => {
  it("takes for a call's result only one written after the call began, of the call's own kind", async () => {
    const entry = (clientOrderId: bigint, kind: number) =>
      ({ clientOrderId, kind }) as OrderResult;
    const before = { resultsWritten: 3 };
    const old = [entry(7n, RESULT_KIND.place), entry(8n, RESULT_KIND.place)];
    const place = (resultsWritten: number, results: OrderResult[]) =>
      writtenSince(before, { resultsWritten, results }, 7n, RESULT_KIND.place);
    expect(place(3, old), "an old result with the same id").to.equal(undefined);
    expect(
      place(4, [entry(7n, RESULT_KIND.cancel), ...old]),
      "a new result of another kind",
    ).to.equal(undefined);
    expect(place(4, [entry(9n, RESULT_KIND.place), ...old])).to.equal(
      undefined,
    );
    const fresh = entry(7n, RESULT_KIND.place);
    expect(place(4, [fresh, ...old])).to.equal(fresh);
  });

  it("reports an order that lands after the client gave up as placed once settled, and lends its key to nothing in between", async () => {
    const { keys, rollup, client } = trader();
    const { call, lent } = await givenUpOn(rollup, client);
    const gaveUp = await call;
    if (gaveUp.outcome !== "unknown") throw new Error("the outcome was known");

    const others = [1, 2, 3].map(() => keys.take());
    expect(
      others.some((use) => use.keypair.publicKey.equals(lent)),
      "the key of the call in doubt",
    ).to.equal(false);
    expect(() => keys.take()).to.throw("every order key is in use");
    others.forEach((use) => keys.release(use));

    rollup.release(0);
    const settled = await gaveUp.settled;
    if (settled.outcome !== "placed") throw new Error("the order was lost");
    expect(settled.clientOrderId).to.equal(gaveUp.clientOrderId);
    expect(settled.result.clientOrderId).to.equal(gaveUp.clientOrderId);
    sameKeys(keys, rollup);
    expect((await client.placeOrder(0, bid)).outcome).to.equal("placed");
    sameKeys(keys, rollup);
  });

  it("settles an order that never lands as expired only once the rollup's clock is past its expiry, whatever the device's clock says", async () => {
    const { keys, rollup, client } = trader();
    const { call, lent } = await givenUpOn(rollup, client);
    const gaveUp = await call;
    if (gaveUp.outcome !== "unknown") throw new Error("the outcome was known");
    rollup.written.push({
      clientOrderId: gaveUp.clientOrderId,
      kind: RESULT_KIND.cancel,
    });
    let settled = false;
    void gaveUp.settled.then(() => (settled = true));

    rollup.clock = () => EXPIRES_AT + 2;
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(settled, "inside the margin after the expiry").to.equal(false);
    const others = [1, 2, 3].map(() => keys.take());
    expect(() => keys.take()).to.throw("every order key is in use");
    others.forEach((use) => keys.release(use));

    rollup.clock = () => EXPIRES_AT + 3;
    expect((await gaveUp.settled).outcome).to.equal("expired");
    const free = [1, 2, 3, 4].map(() => keys.take());
    expect(
      free.some((use) => use.keypair.publicKey.equals(lent)),
      "the unused key is live again",
    ).to.equal(true);
    free.forEach((use) => keys.release(use));
    rollup.release(0);
    sameKeys(keys, rollup);
  });

  it("gives two concurrent orders different client order ids, and neither takes the other's result", async () => {
    const { rollup, client } = trader();
    rollup.holding = true;
    const random = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    let ids = 0;
    globalThis.crypto.getRandomValues = ((bytes: Uint8Array) => {
      if (bytes.length !== 8) return random(bytes);
      ids += 1;
      return bytes.fill(ids <= 2 ? 7 : ids);
    }) as typeof globalThis.crypto.getRandomValues;
    const landed: string[] = [];
    const place = (name: string) =>
      client.placeOrder(0, bid, { pollMs: 1 }).then((placed) => {
        landed.push(name);
        return placed;
      });
    try {
      const calls = [place("first"), place("second")];
      await until(() => rollup.held.length === 2);
      const sent = rollup.held.map((transaction) =>
        transaction.instructions[0].data.readBigUInt64LE(48),
      );
      expect(ids, "the repeated id was drawn again").to.equal(3);
      expect(sent[0]).to.not.equal(sent[1]);

      rollup.release(1);
      await until(() => landed.length === 1);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(landed, "only the call whose order landed").to.have.length(1);
      rollup.release(0);
      const placed = await Promise.all(calls);
      const confirmed = placed.map((order) =>
        order.outcome === "placed" ? order.result.clientOrderId : null,
      );
      const earlier = landed[0] === "first" ? 0 : 1;
      expect(confirmed[earlier]).to.equal(sent[1]);
      expect(confirmed[1 - earlier]).to.equal(sent[0]);
    } finally {
      globalThis.crypto.getRandomValues = random;
    }
  });

  it("generates client order ids that do not repeat", async () => {
    const { rollup, client } = trader();
    for (let nth = 0; nth < 40; nth += 1) await client.syncView(0);
    const ids = rollup.written.map((result) => result.clientOrderId);
    expect(new Set(ids).size).to.equal(40);
    expect(ids.every((id) => id >= 0n && id < 1n << 64n)).to.equal(true);
  });

  it("keeps every slot lent to its own call while one of four in flight times out, and lends no key twice", async () => {
    const { keys, rollup, client } = trader();
    rollup.holding = true;
    rollup.clock = () => 1_004;
    let clock = 1_000;
    const steady = () => 1_000;
    const inFlight = [0, 1, 2].map(() =>
      client.placeOrder(0, bid, { now: steady, pollMs: 1 }),
    );
    await until(() => rollup.held.length === 3);
    const timingOut = client.placeOrder(0, bid, {
      now: () => clock,
      expirySeconds: 1,
      pollMs: 1,
    });
    await until(() => rollup.held.length === 4);
    const lentToTheFourth = rollup.held[3].feePayer!;
    expect(() => keys.take()).to.throw("every order key is in use");

    clock += 10;
    const gaveUp = await timingOut;
    if (gaveUp.outcome !== "unknown") throw new Error("the outcome was known");
    expect((await gaveUp.settled).outcome).to.equal("expired");
    const again = keys.take();
    expect(
      again.keypair.publicKey.equals(lentToTheFourth),
      "only the timed-out call's own key is free again",
    ).to.equal(true);
    expect(() => keys.take()).to.throw("every order key is in use");
    keys.release(again);

    rollup.release(2);
    rollup.release(0);
    rollup.release(0);
    const landed = await Promise.all(inFlight);
    expect(landed.map((placed) => placed.outcome)).to.deep.equal([
      "placed",
      "placed",
      "placed",
    ]);
    sameKeys(keys, rollup);

    rollup.held = [];
    rollup.holding = false;
    for (let nth = 0; nth < 8; nth += 1) {
      expect((await client.placeOrder(0, bid)).outcome).to.equal("placed");
    }
    sameKeys(keys, rollup);
  });

  it("changes a slot only for the use it is lent to, and by the key the view shows", () => {
    const keys = OrderKeyManager.fresh(seed());
    const stale = keys.take();
    keys.release(stale);
    const current = keys.take();
    expect(current.slot).to.equal(stale.slot);
    keys.confirm(stale);
    expect(
      keys.publicKeys[stale.slot].equals(stale.keypair.publicKey),
      "a stale confirm changes nothing",
    ).to.equal(true);
    keys.confirm(current);
    expect(
      keys.publicKeys[current.slot].equals(current.replacement.publicKey),
    ).to.equal(true);
    keys.confirm(stale);
    keys.release(stale);
    expect(
      keys.publicKeys[current.slot].equals(current.replacement.publicKey),
      "a late confirm does not overwrite newer state",
    ).to.equal(true);

    const landedUnseen = keys.take();
    const view = { orderKeys: keys.publicKeys };
    view.orderKeys[landedUnseen.slot] = landedUnseen.replacement.publicKey;
    keys.release(landedUnseen, view);
    expect(
      keys.publicKeys[landedUnseen.slot].equals(
        landedUnseen.replacement.publicKey,
      ),
      "a release that sees the swap in the view takes the new key",
    ).to.equal(true);

    const lent = keys.take();
    keys.resync({ orderKeys: keys.publicKeys });
    expect(keys.take().slot, "a resync leaves a lent slot lent").to.not.equal(
      lent.slot,
    );
  });

  it("reports when a call was sent and when its result was read, and a failed transaction at once", async () => {
    const { keys, rollup, client } = trader();
    const placed = await client.placeOrder(0, bid);
    if (placed.outcome !== "placed") throw new Error("the order did not land");
    expect(placed.sentAt <= placed.resultAt).to.equal(true);
    const synced = await client.syncView(0);
    expect(synced!.sentAt <= synced!.resultAt).to.equal(true);

    rollup.failing = true;
    const started = Date.now();
    const failure = await client
      .placeOrder(0, bid, { expirySeconds: 60, statusCheckMs: 20, pollMs: 1 })
      .catch((error: unknown) => error);
    expect(failure).to.be.instanceOf(TransactionFailed);
    expect((failure as TransactionFailed).code).to.equal(6123);
    expect(Date.now() - started < 5_000, "well before the expiry").to.equal(
      true,
    );
    rollup.failing = false;
    sameKeys(keys, rollup);
    expect((await client.placeOrder(0, bid)).outcome).to.equal("placed");
  });

  it("refuses an order off the tick, below the minimum size or below the minimum notional before signing anything", async () => {
    const { keys, rollup, client } = trader();
    for (const [over, reason] of [
      [{ price: 1_050n }, "PriceOffTick"],
      [{ size: 1n }, "SizeTooSmall"],
      [{ price: 100n, size: 2n }, "NotionalTooSmall"],
    ] as const) {
      const refused = await client
        .placeOrder(0, { ...bid, ...over })
        .catch((error: unknown) => error);
      expect(refused).to.be.instanceOf(OrderInvalid);
      expect((refused as OrderInvalid).reason).to.equal(reason);
    }
    expect(rollup.sends).to.equal(0);
    expect(() => [1, 2, 3, 4].map(() => keys.take())).to.not.throw();
  });

  it("picks its keys up from a saved checkpoint without searching the derivation from the start", () => {
    const secret = seed();
    const keys = OrderKeyManager.fresh(secret);
    const use = () => keys.confirm(keys.take());
    for (let nth = 0; nth < 300; nth += 1) use();
    const checkpoint = JSON.parse(JSON.stringify(keys.checkpoint));
    for (let nth = 0; nth < 5; nth += 1) use();
    const view = { orderKeys: keys.publicKeys };

    const restored = OrderKeyManager.restore(secret, view, checkpoint, 16);
    expect(restored.publicKeys.map(String)).to.deep.equal(
      keys.publicKeys.map(String),
    );
    expect(
      restored
        .take()
        .replacement.publicKey.equals(keys.take().replacement.publicKey),
      "and continues the derivation where it stopped",
    ).to.equal(true);
    expect(() =>
      OrderKeyManager.restore(
        secret,
        view,
        { indices: [0, 1, 2, 3], nextIndex: 4 },
        16,
      ),
    ).to.throw("fromView");
  });
});

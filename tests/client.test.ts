import { expect } from "chai";
import { createHash } from "node:crypto";
import nacl from "tweetnacl";
import {
  ComputeBudgetProgram,
  Ed25519Program,
  Keypair,
  PACKET_DATA_SIZE,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  Transaction,
  type Connection,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  ACCOUNT_LEN,
  ACCOUNT_TAG,
  Addresses,
  Instructions,
  MAX_MARKETS,
  MAX_OWNER_EXPIRY_AHEAD,
  ORDER_TYPE,
  OWNER_ERROR,
  OWNER_TRANSACTION_ERROR,
  OrderInvalid,
  OrderKeyManager,
  RESULTS,
  RESULT_KIND,
  SIDE,
  TOKENS,
  TraderClient,
  TransactionFailed,
  WithdrawalUnknown,
  Writer,
  associatedTokenAddress,
  openSignedTransaction,
  ownerActionEnvelope,
  ownerActionMessage,
  ownerExpiry,
  replaceKeysSignedTransaction,
  verifyOwnerSignature,
  bytesEqual,
  instructionData,
  writtenSince,
  type OrderResult,
  type Socket,
} from "../sdk/dist/index.js";
import { sleep } from "../ops/sending";
import { errorCode } from "./idl";

type Written = { clientOrderId: bigint; kind: number };

const KIND_OF: [string, number][] = [
  ["place_order", RESULT_KIND.place],
  ["cancel_order", RESULT_KIND.cancel],
  ["cancel_all", RESULT_KIND.cancelAll],
  ["sync_view", RESULT_KIND.sync],
  ["liquidate", RESULT_KIND.liquidate],
  ["transfer_between_balances", RESULT_KIND.transfer],
];

const EVERY_MARKET = Array.from({ length: MAX_MARKETS }, (_, id) => id);
const EVERY_MARKET_PERP = 2 ** MAX_MARKETS - 1;

const NOT_ORDER_KEY = {
  InstructionError: [0, { Custom: errorCode("NotOrderKey") }],
};
const EXPIRED = { InstructionError: [0, { Custom: errorCode("Expired") }] };

/**
 * The rollup as far as the client can tell: a view with four order keys and
 * a ring of results, a market's public settings, the exchange's perp
 * markets, and transactions that land when the test says so. Nothing here
 * touches a network.
 */
class FakeRollup {
  readonly owner = Keypair.generate().publicKey;
  readonly addresses = new Addresses();
  /** One bit per perp market, by market id, as the exchange records them. */
  perpMarkets = 0;
  orderKeys: PublicKey[];
  /** The counter of the owner's key replacements, signed or not. */
  ownerNonce = 0;
  written: Written[] = [];

  /** What `set_order_keys` does to the view: new keys, and the counter moves. */
  ownerResetsKeys(keys: PublicKey[]) {
    this.orderKeys = keys;
    this.ownerNonce += 1;
  }
  held: Transaction[] = [];
  /** Every transaction sent, as the bytes that went out. */
  sent: Buffer[] = [];
  holding = false;
  failing = false;
  sends = 0;
  /** The rollup's own clock, which the device's clock need not agree with. */
  clock = () => Math.floor(Date.now() / 1000);
  private statuses = new Map<string, unknown>();
  viewReads = 0;
  clockReads = 0;
  blockhashes = 0;
  /** How long a send takes to answer, after the transaction has landed. */
  sendAnswersAfterMs = 0;
  forgetsBlockhashOnce = false;
  /** A subscription that stays open and delivers nothing. */
  silent = false;
  sockets: FakeSocket[] = [];
  private slot = 1;

  constructor(keys: OrderKeyManager) {
    this.orderKeys = keys.publicKeys;
  }

  socket = (url: string): Socket => {
    const socket = new FakeSocket(url);
    this.sockets.push(socket);
    return socket;
  };

  cutSockets(): void {
    for (const socket of this.sockets) socket.cut();
  }

  private notify(): void {
    this.slot += 1;
    if (this.silent) return;
    for (const socket of this.sockets) {
      socket.deliver({
        jsonrpc: "2.0",
        method: "accountNotification",
        params: {
          subscription: FakeSocket.SUBSCRIPTION,
          result: {
            context: { slot: this.slot },
            value: { data: [this.view().toString("base64"), "base64"] },
          },
        },
      });
    }
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
      this.statuses.set(
        FakeRollup.id(transaction),
        expired ? EXPIRED : NOT_ORDER_KEY,
      );
      return;
    }
    this.orderKeys[slot] = new PublicKey(data.subarray(16, 48));
    const withdrawal = bytesEqual(
      data.subarray(0, 8),
      instructionData("withdraw_by_key").build(),
    );
    if (!withdrawal) {
      const kind = KIND_OF.find(([name]) =>
        bytesEqual(data.subarray(0, 8), instructionData(name).build()),
      )![1];
      this.written.push({ clientOrderId: data.readBigUInt64LE(48), kind });
    }
    this.statuses.set(FakeRollup.id(transaction), null);
    this.notify();
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
    writer.u32(2).u32(this.ownerNonce).u64(BigInt(this.written.length));
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

  private exchange(): Buffer {
    const writer = new Writer()
      .bytes(new Uint8Array(8))
      .u8(0)
      .pubkey(PublicKey.default)
      .bool(false)
      .pubkey(PublicKey.default)
      .pubkey(PublicKey.default)
      .bool(false)
      .u8(16)
      .u8(0);
    for (let token = 0; token < TOKENS; token += 1) {
      writer.pubkey(PublicKey.default).pubkey(PublicKey.default).u64(0n).u8(0);
    }
    writer.u8(this.perpMarkets).u32(0).i64(0n).u32(0).u8(0);
    // The USDC guard, never bound.
    writer.bytes(new Uint8Array(32 + 32 + 4 + 2 + 2 + 8 * 5)).u8(2);
    for (let token = 0; token < TOKENS; token += 1) writer.u64(0n);
    return Buffer.from(writer.build());
  }

  get connection(): Connection {
    return this.connectionAt(undefined);
  }

  /** A connection with an address, which is what a subscription is opened from. */
  signedIn(token: string): Connection {
    return this.connectionAt(`http://rollup.test?token=${token}`);
  }

  private connectionAt(rpcEndpoint: string | undefined): Connection {
    const fake = {
      rpcEndpoint,
      getLatestBlockhash: async () => {
        this.blockhashes += 1;
        return {
          blockhash: PublicKey.default.toBase58(),
          lastValidBlockHeight: 1,
        };
      },
      sendRawTransaction: async (raw: Buffer) => {
        this.sends += 1;
        if (this.forgetsBlockhashOnce) {
          this.forgetsBlockhashOnce = false;
          throw new Error("Transaction simulation failed: Blockhash not found");
        }
        this.sent.push(raw);
        const transaction = Transaction.from(raw);
        if (this.holding) this.held.push(transaction);
        else if (!this.statuses.has(FakeRollup.id(transaction))) {
          this.land(transaction);
        }
        if (this.sendAnswersAfterMs) await sleep(this.sendAnswersAfterMs);
        return FakeRollup.id(transaction);
      },
      getAccountInfoAndContext: async () => {
        this.viewReads += 1;
        return { context: { slot: this.slot }, value: { data: this.view() } };
      },
      getSignatureStatus: async (signature: string) => ({
        value: this.statuses.has(signature)
          ? { err: this.statuses.get(signature) }
          : null,
      }),
      getAccountInfo: async (address: PublicKey) => {
        if (address.equals(SYSVAR_CLOCK_PUBKEY)) {
          this.clockReads += 1;
          const data = Buffer.alloc(40);
          data.writeBigInt64LE(BigInt(this.clock()), 32);
          return { data };
        }
        if (address.equals(this.addresses.exchange)) {
          return { data: this.exchange() };
        }
        if (!address.equals(this.addresses.view(this.owner))) {
          return { data: this.market() };
        }
        this.viewReads += 1;
        return { data: this.view() };
      },
    };
    return fake as unknown as Connection;
  }
}

/** A websocket that confirms an account subscription and is told what to deliver. */
class FakeSocket implements Socket {
  static readonly SUBSCRIPTION = 7;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private subscribed = false;
  private open = true;

  constructor(readonly url: string) {
    setTimeout(() => this.open && this.onopen?.(), 0);
  }

  send(data: string): void {
    const { id, method } = JSON.parse(data);
    if (method !== "accountSubscribe") return;
    this.subscribed = true;
    setTimeout(() => this.deliver({ id, result: FakeSocket.SUBSCRIPTION }), 0);
  }

  deliver(message: unknown): void {
    if (this.open && this.subscribed) {
      this.onmessage?.({ data: JSON.stringify(message) });
    }
  }

  close(): void {
    this.open = false;
  }

  /** The connection drops, as the far end or the network would drop it. */
  cut(): void {
    if (!this.open) return;
    this.open = false;
    this.onclose?.();
  }
}

const seed = () => globalThis.crypto.getRandomValues(new Uint8Array(32));

/** A trader whose client subscribes to its view over the rollup's fake sockets, once it starts. */
function subscribing() {
  const keys = OrderKeyManager.fresh(seed());
  const rollup = new FakeRollup(keys);
  const client = new TraderClient(
    rollup.signedIn("first"),
    rollup.signedIn("first"),
    rollup.owner,
    keys,
    undefined,
    { socket: rollup.socket },
  );
  return { keys, rollup, client };
}

async function subscribed() {
  const trader = subscribing();
  await trader.client.ready();
  expect(trader.client.pushing, "the subscription is live").to.equal(true);
  return trader;
}

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
  while (!condition()) await sleep(5);
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
    await sleep(600);
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
      await sleep(50);
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
    expect(synced.sentAt <= synced.resultAt).to.equal(true);

    rollup.failing = true;
    const started = Date.now();
    const failure = await client
      .placeOrder(0, bid, { expirySeconds: 60, statusCheckMs: 20, pollMs: 1 })
      .catch((error: unknown) => error);
    expect(failure).to.be.instanceOf(TransactionFailed);
    expect((failure as TransactionFailed).code).to.equal(
      errorCode("NotOrderKey"),
    );
    expect(Date.now() - started < 5_000, "well before the expiry").to.equal(
      true,
    );
    rollup.failing = false;
    sameKeys(keys, rollup);
    expect((await client.placeOrder(0, bid)).outcome).to.equal("placed");
  });

  describe("a withdrawal by order key", () => {
    const token = { mint: Keypair.generate().publicKey, custodyNonce: 1n };
    const collateral = { collateral: true } as const;
    const lend = async (rollup: FakeRollup, client: TraderClient) => {
      rollup.holding = true;
      rollup.clock = () => SENT_AT;
      const call = client
        .withdrawByKey(token, collateral, 5n, EXPIRES_AT - SENT_AT)
        .catch((error: unknown) => error);
      await until(() => rollup.held.length === 1);
      rollup.holding = false;
      return { call, lent: rollup.held[0].feePayer! };
    };

    it("lands on the owner's token account, swaps the key and writes no result", async () => {
      const { keys, rollup, client } = trader();
      rollup.perpMarkets = 2 ** 7 - 1;
      const withdrawn = await client.withdrawByKey(token, collateral, 5n);
      expect(withdrawn.sentAt <= withdrawn.resultAt).to.equal(true);
      expect(rollup.written).to.deep.equal([]);
      sameKeys(keys, rollup);
      const sent = Transaction.from(rollup.sent[0]);
      expect(sent.instructions).to.have.length(1);
      const named = sent.instructions[0].keys.map((meta) => meta.pubkey);
      expect(
        named.some((key) =>
          key.equals(associatedTokenAddress(rollup.owner, token.mint)),
        ),
        "the owner's associated token account",
      ).to.equal(true);
      expect(sent.serialize().length).to.be.at.most(PACKET_DATA_SIZE);
      client.close();
    });

    it("sends nothing and keeps the key when the risk set does not fit one packet", async () => {
      const { keys, rollup, client } = trader();
      rollup.perpMarkets = EVERY_MARKET_PERP;
      const failure = await client
        .withdrawByKey(token, collateral, 5n)
        .catch((error: unknown) => error);
      expect(String(failure)).to.match(/too large/);
      expect(rollup.sends).to.equal(0);
      const free = [1, 2, 3, 4].map(() => keys.take());
      expect(free).to.have.length(4);
      free.forEach((use) => keys.release(use));
      sameKeys(keys, rollup);
    });

    it("throws a refusal with the key still live", async () => {
      const { keys, rollup, client } = trader();
      rollup.failing = true;
      const failure = await client
        .withdrawByKey(token, collateral, 5n, 60)
        .catch((error: unknown) => error);
      expect(failure).to.be.instanceOf(TransactionFailed);
      rollup.failing = false;
      sameKeys(keys, rollup);
      const free = [1, 2, 3, 4].map(() => keys.take());
      expect(free).to.have.length(4);
      free.forEach((use) => keys.release(use));
      expect(
        (await client.withdrawByKey(token, collateral, 5n)).view,
      ).to.not.equal(undefined);
      sameKeys(keys, rollup);
    });

    it("reports a withdrawal that lands after the client gave up as withdrawn once settled, and lends its key to nothing in between", async () => {
      const { keys, rollup, client } = trader();
      const { call, lent } = await lend(rollup, client);
      const gaveUp = await call;
      if (!(gaveUp instanceof WithdrawalUnknown)) {
        throw new Error("the outcome was known");
      }
      const others = [1, 2, 3].map(() => keys.take());
      expect(
        others.some((use) => use.keypair.publicKey.equals(lent)),
        "the key of the call in doubt",
      ).to.equal(false);
      expect(() => keys.take()).to.throw("every order key is in use");
      others.forEach((use) => keys.release(use));

      rollup.release(0);
      const settled = await gaveUp.settled;
      expect(settled).to.not.equal(null);
      expect(settled).to.not.have.property("undetermined");
      sameKeys(keys, rollup);
    });

    it("settles as undetermined, never withdrawn, when an owner key reset installs the same key while the answer is lost", async () => {
      const { rollup, client } = trader();
      const { call, lent } = await lend(rollup, client);
      const gaveUp = await call;
      if (!(gaveUp instanceof WithdrawalUnknown)) {
        throw new Error("the outcome was known");
      }
      const held = rollup.held[0];
      const slot = rollup.orderKeys.findIndex((key) => key.equals(lent));
      rollup.orderKeys = rollup.orderKeys.map(
        () => Keypair.generate().publicKey,
      );
      rollup.orderKeys[slot] = new PublicKey(
        held.instructions[0].data.subarray(16, 48),
      );
      rollup.ownerNonce += 1;

      const settled = await gaveUp.settled;
      expect(settled).to.not.equal(null);
      expect(settled).to.have.property("undetermined", true);
      expect(rollup.written).to.deep.equal([]);
      client.close();
    });

    it("settles as undetermined, never withdrawn, when an unsigned owner reset reinstalls the same key while the answer is lost", async () => {
      const { rollup, client } = trader();
      const { call, lent } = await lend(rollup, client);
      const gaveUp = await call;
      if (!(gaveUp instanceof WithdrawalUnknown)) {
        throw new Error("the outcome was known");
      }
      const slot = rollup.orderKeys.findIndex((key) => key.equals(lent));
      const reinstalled = new PublicKey(
        rollup.held[0].instructions[0].data.subarray(16, 48),
      );
      const reset = rollup.orderKeys.map(() => Keypair.generate().publicKey);
      reset[slot] = reinstalled;
      rollup.ownerResetsKeys(reset);

      const settled = await gaveUp.settled;
      expect(settled).to.have.property("undetermined", true);
      expect(rollup.written).to.deep.equal([]);
      client.close();
    });

    it("settles a withdrawal that never lands as not run only once the rollup's clock is past its expiry", async () => {
      const { keys, rollup, client } = trader();
      const { call, lent } = await lend(rollup, client);
      const gaveUp = await call;
      if (!(gaveUp instanceof WithdrawalUnknown)) {
        throw new Error("the outcome was known");
      }
      let settled = false;
      void gaveUp.settled.then(() => (settled = true));
      rollup.clock = () => EXPIRES_AT + 2;
      await sleep(600);
      expect(settled, "inside the margin after the expiry").to.equal(false);

      rollup.clock = () => EXPIRES_AT + 3;
      expect(await gaveUp.settled).to.equal(null);
      const free = [1, 2, 3, 4].map(() => keys.take());
      expect(
        free.some((use) => use.keypair.publicKey.equals(lent)),
        "the unused key is live again",
      ).to.equal(true);
      free.forEach((use) => keys.release(use));
      sameKeys(keys, rollup);
    });
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

  it("takes a result pushed before the send returned, and asks for nothing but the send", async () => {
    const { keys, rollup, client } = await subscribed();
    const asked = () => [
      rollup.viewReads,
      rollup.clockReads,
      rollup.blockhashes,
      rollup.sends,
    ];
    await client.placeOrder(0, bid);
    const [views, clocks, blockhashes, sends] = asked();
    rollup.sendAnswersAfterMs = 30;
    for (let nth = 0; nth < 3; nth += 1) {
      const placed = await client.placeOrder(0, bid);
      if (placed.outcome !== "placed") throw new Error("the order was lost");
      expect(placed.sentAt <= placed.resultAt).to.equal(true);
    }
    expect(asked()).to.deep.equal([views, clocks, blockhashes, sends + 3]);
    sameKeys(keys, rollup);
    client.close();
  });

  it("reads the view when the subscription is not up yet, and when it is up and delivers nothing, and then sets it up again", async () => {
    const { keys, rollup, client } = subscribing();
    expect((await client.placeOrder(0, bid)).outcome).to.equal("placed");
    expect(rollup.viewReads > 0, "read before the subscription").to.equal(true);

    await client.ready();
    rollup.silent = true;
    const reads = rollup.viewReads;
    const started = performance.now();
    const placed = await client.placeOrder(0, bid, {
      pushWaitMs: 40,
      pollMs: 1,
    });
    expect(placed.outcome).to.equal("placed");
    expect(
      performance.now() - started >= 40,
      "the push was waited for",
    ).to.equal(true);
    expect(rollup.viewReads).to.equal(reads + 1);
    await until(() => rollup.sockets.length === 2 && client.pushing);
    sameKeys(keys, rollup);
    client.close();
  });

  it("loses no result to a subscription that drops mid-order, and subscribes again with the reader's new token", async () => {
    const { keys, rollup, client } = await subscribed();
    rollup.holding = true;
    const call = client.placeOrder(0, bid, { pollMs: 60_000 });
    await until(() => rollup.held.length === 1);
    const reads = rollup.viewReads;
    rollup.cutSockets();
    await until(() => rollup.viewReads === reads + 1);
    await sleep(10);
    rollup.release(0);
    const placed = await call;
    expect(placed.outcome).to.equal("placed");
    expect(
      rollup.viewReads,
      "read once more, after subscribing again",
    ).to.equal(reads + 2);
    expect(rollup.sockets.map(({ url }) => url)).to.deep.equal([
      "ws://rollup.test/?token=first",
      "ws://rollup.test/?token=first",
    ]);
    sameKeys(keys, rollup);

    rollup.holding = false;
    client.renewReader(rollup.signedIn("second"));
    await until(() => client.pushing);
    expect(rollup.sockets[2].url).to.equal("ws://rollup.test/?token=second");
    const readsOnceRenewed = rollup.viewReads;
    expect((await client.placeOrder(0, bid)).outcome).to.equal("placed");
    expect(rollup.viewReads, "pushed again").to.equal(readsOnceRenewed);
    client.close();
  });

  it("gives each of two pushed orders in flight its own result, in whichever order they land", async () => {
    const { keys, rollup, client } = await subscribed();
    rollup.holding = true;
    const reads = rollup.viewReads;
    const landed: number[] = [];
    const calls = [0, 1].map((nth) =>
      client.placeOrder(0, bid, { pushWaitMs: 60_000 }).then((placed) => {
        landed.push(nth);
        return placed;
      }),
    );
    await until(() => rollup.held.length === 2);
    const sent = rollup.held.map((transaction) =>
      transaction.instructions[0].data.readBigUInt64LE(48),
    );
    rollup.release(1);
    await until(() => landed.length === 1);
    await sleep(30);
    expect(landed, "only the call whose order landed").to.deep.equal([1]);
    rollup.release(0);
    const placed = await Promise.all(calls);
    expect(
      placed.map((order) =>
        order.outcome === "placed" ? order.result.clientOrderId : null,
      ),
    ).to.deep.equal(sent);
    expect(rollup.viewReads, "no read of the view").to.equal(reads);
    sameKeys(keys, rollup);
    client.close();
  });

  it("settles a pushed order the client gave up on once it lands", async () => {
    const { keys, rollup, client } = await subscribed();
    const { call } = await givenUpOn(rollup, client);
    const gaveUp = await call;
    if (gaveUp.outcome !== "unknown") throw new Error("the outcome was known");
    rollup.release(0);
    const settled = await gaveUp.settled;
    expect(settled.outcome).to.equal("placed");
    sameKeys(keys, rollup);
    client.close();
  });

  it("signs again when the rollup has forgotten the blockhash, and reads the clock again when it refuses the expiry", async () => {
    const { keys, rollup, client } = await subscribed();
    const blockhashes = rollup.blockhashes;
    rollup.forgetsBlockhashOnce = true;
    expect((await client.placeOrder(0, bid)).outcome).to.equal("placed");
    expect(rollup.blockhashes).to.equal(blockhashes + 1);

    const clockReads = rollup.clockReads;
    rollup.clock = () => Math.floor(Date.now() / 1000) + 30;
    const placed = await client.placeOrder(0, bid, { statusCheckMs: 5 });
    expect(placed.outcome).to.equal("placed");
    expect(rollup.clockReads).to.equal(clockReads + 1);
    expect(rollup.blockhashes, "no blockhash for it").to.equal(blockhashes + 1);
    sameKeys(keys, rollup);
    client.close();
  });

  it("sends cancel_all and liquidate with extend_compute, and no call with a compute budget request, with the order key still the one signer", async () => {
    const { keys, rollup, client } = trader();
    const instructions = new Instructions();
    const sentBy = async (call: () => Promise<unknown>) => {
      await call();
      return Transaction.from(rollup.sent[rollup.sent.length - 1]);
    };
    const extendCompute = instructions.extendCompute();
    const extensions = (transaction: Transaction) =>
      transaction.instructions.filter(
        (instruction) =>
          instruction.programId.equals(extendCompute.programId) &&
          instruction.data.equals(extendCompute.data),
      );

    for (const transaction of [
      await sentBy(() => client.cancelAll(0)),
      await sentBy(() => client.liquidate(0, 5, 1n, 1_000n)),
    ]) {
      expect(transaction.instructions).to.have.length(2);
      expect(extensions(transaction)).to.have.length(1);
      expect(extensions(transaction)[0].keys).to.have.length(0);
      expect(transaction.signatures).to.have.length(1);
      const signers = transaction.instructions.flatMap((instruction) =>
        instruction.keys.filter((meta) => meta.isSigner),
      );
      expect(signers).to.have.length(1);
      expect(signers[0].pubkey.equals(transaction.feePayer!)).to.equal(true);
    }
    for (const transaction of [
      await sentBy(() => client.placeOrder(0, bid)),
      await sentBy(() => client.cancelOrder(0, 1n)),
      await sentBy(() => client.syncView(0)),
      await sentBy(() => client.transferBetweenBalances(true, 0, 1n)),
    ]) {
      expect(transaction.instructions).to.have.length(1);
    }
    for (const raw of rollup.sent) {
      expect(
        Transaction.from(raw).instructions.some((instruction) =>
          instruction.programId.equals(ComputeBudgetProgram.programId),
        ),
      ).to.equal(false);
    }
    sameKeys(keys, rollup);
    client.close();
  });

  it("names the same accounts, with the same flags, in every kind of order-key call on a market", async () => {
    const { rollup, client } = trader();
    rollup.perpMarkets = 0b1010_0110;
    const lowestPerp = 1;
    const named = async (call: () => Promise<unknown>) => {
      await call();
      const message = Transaction.from(
        rollup.sent[rollup.sent.length - 1],
      ).compileMessage();
      return message.accountKeys
        .map((key, index) =>
          message.isAccountSigner(index)
            ? "order key"
            : `${key.toBase58()} ${message.isAccountWritable(index) ? "w" : "-"}`,
        )
        .sort();
    };
    const calls = {
      placeOrder: () => client.placeOrder(lowestPerp, bid),
      cancelOrder: () => client.cancelOrder(lowestPerp, 1n),
      cancelAll: () => client.cancelAll(lowestPerp),
      syncView: () => client.syncView(lowestPerp),
      liquidate: () => client.liquidate(lowestPerp, 5, 1n, 1_000n),
      transferBetweenBalances: () =>
        client.transferBetweenBalances(true, 0, 1n),
    };
    const shapes = new Map<string, string[]>();
    for (const [name, call] of Object.entries(calls)) {
      shapes.set(name, await named(call));
    }
    const expected = shapes.get("placeOrder")!;
    const addresses = new Addresses();
    for (const id of [1, 2, 5, 7]) {
      for (const account of addresses.riskAccounts(id)) {
        expect(
          expected.some((entry) => entry.startsWith(account.toBase58())),
          `perp market ${id}`,
        ).to.equal(true);
      }
    }
    for (const [name, shape] of shapes) {
      expect(shape, name).to.deep.equal(expected);
    }
    client.close();
  });

  it("fits every transaction that names all eight markets as perp markets, and each price crank, in one packet", async () => {
    const { rollup, client } = trader();
    rollup.perpMarkets = EVERY_MARKET_PERP;
    const instructions = new Instructions();
    const sentSize = async (call: () => Promise<unknown>) => {
      await call();
      return rollup.sent[rollup.sent.length - 1].length;
    };
    const owner = Keypair.generate();
    const signed = (instruction: TransactionInstruction) => {
      const transaction = new Transaction({
        feePayer: owner.publicKey,
        blockhash: PublicKey.default.toBase58(),
        lastValidBlockHeight: 1,
      }).add(instruction);
      transaction.sign(owner);
      return transaction.serialize().length;
    };

    const sizes = {
      placeOrder: await sentSize(() => client.placeOrder(0, bid)),
      cancelOrder: await sentSize(() => client.cancelOrder(0, 1n)),
      cancelAll: await sentSize(() => client.cancelAll(0)),
      syncView: await sentSize(() => client.syncView(0)),
      liquidate: await sentSize(() => client.liquidate(0, 5, 1n, 1_000n)),
      transferBetweenBalances: await sentSize(() =>
        client.transferBetweenBalances(true, 0, 1n),
      ),
      withdraw: signed(
        instructions.withdraw(
          owner.publicKey,
          Keypair.generate().publicKey,
          { mint: Keypair.generate().publicKey, custodyNonce: 1n },
          { collateral: true },
          1n,
          EVERY_MARKET,
        ),
      ),
      syncPrice: signed(
        instructions.syncPrice(7, Keypair.generate().publicKey),
      ),
      syncQuote: signed(instructions.syncQuote(Keypair.generate().publicKey)),
    };
    for (const [name, size] of Object.entries(sizes)) {
      expect(size, name).to.be.at.most(PACKET_DATA_SIZE);
    }
    client.close();
  });

  it("serializes the owner action transactions and measures their packet sizes", () => {
    const instructions = new Instructions();
    const signerWithLongAddress = () => {
      let signer = Keypair.generate();
      while (signer.publicKey.toBase58().length < 44)
        signer = Keypair.generate();
      return signer;
    };
    const gate = signerWithLongAddress();
    const owner = new PublicKey(new Uint8Array(32).fill(250));
    const payer = signerWithLongAddress();
    const keys = [240, 241, 242, 243].map(
      (byte) => new PublicKey(new Uint8Array(32).fill(byte)),
    );
    const next = [230, 231, 232, 233].map(
      (byte) => new PublicKey(new Uint8Array(32).fill(byte)),
    );
    for (const key of [owner, ...keys, ...next])
      expect(key.toBase58().length).to.equal(44);
    const expiry = 1_800_000_000n;
    const signature = new Uint8Array(64).fill(7);
    const token = {
      mint: new PublicKey(new Uint8Array(32).fill(220)),
      custodyNonce: 1n,
    };
    const to = PublicKey.findProgramAddressSync(
      [
        owner.toBuffer(),
        new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").toBuffer(),
        token.mint.toBuffer(),
      ],
      new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
    )[0];
    const size = (feePayer: Keypair, ...built: TransactionInstruction[]) => {
      const transaction = new Transaction({
        feePayer: feePayer.publicKey,
        blockhash: PublicKey.default.toBase58(),
        lastValidBlockHeight: 1,
      }).add(...built);
      transaction.sign(feePayer);
      const bytes =
        1 +
        transaction.signatures.length * 64 +
        transaction.serializeMessage().length;
      if (bytes <= PACKET_DATA_SIZE)
        expect(transaction.serialize().length).to.equal(bytes);
      return bytes;
    };
    const sizes = {
      open: size(
        gate,
        instructions.openTraderProof(owner, keys, expiry, signature),
        instructions.openTraderSigned(gate.publicKey, owner, keys, expiry),
      ),
      setKeys: size(
        payer,
        instructions.setOrderKeysProof(
          owner,
          next,
          0xffffffff,
          expiry,
          signature,
        ),
        instructions.setOrderKeysSigned(owner, next, 0xffffffff, expiry),
      ),
      withdrawOne: size(
        payer,
        instructions.withdrawByKey(
          payer.publicKey,
          owner,
          next[0],
          expiry,
          to,
          token,
          { collateral: true },
          1n,
          [0],
        ),
      ),
      openEnvelope: size(
        gate,
        instructions.openTraderProof(
          owner,
          keys,
          expiry,
          signature,
          "envelope",
        ),
        instructions.openTraderSigned(gate.publicKey, owner, keys, expiry),
      ),
      setKeysEnvelope: size(
        payer,
        instructions.setOrderKeysProof(
          owner,
          next,
          0xffffffff,
          expiry,
          signature,
          "envelope",
        ),
        instructions.setOrderKeysSigned(owner, next, 0xffffffff, expiry),
      ),
    };
    const withdrawNaming = (markets: number) =>
      size(
        payer,
        instructions.withdrawByKey(
          payer.publicKey,
          owner,
          next[0],
          expiry,
          to,
          token,
          { spot: 3 },
          0xffff_ffff_ffff_ffffn,
          EVERY_MARKET.slice(0, markets),
        ),
      );
    const withdrawSizes = EVERY_MARKET.map((_, at) => withdrawNaming(at + 1));
    console.log("withdraw_by_key bytes by perp markets named", withdrawSizes);
    const mostMarkets = withdrawSizes.filter(
      (bytes) => bytes <= PACKET_DATA_SIZE,
    ).length;
    expect(
      mostMarkets,
      "perp markets withdraw_by_key can name in one packet",
    ).to.equal(7);
    expect(sizes.openEnvelope - sizes.open).to.equal(20);
    expect(sizes.setKeysEnvelope - sizes.setKeys).to.equal(20);
    expect(
      new TextDecoder().decode(
        ownerActionMessage("open", instructions.programId, owner, keys, expiry),
      ),
    ).to.equal(
      `NoirWire: open trading account\nprogram ${instructions.programId}\nowner ${owner}\nkeys ${keys.join(" ")}\nexpires ${expiry}`,
    );
    console.log("owner action packet bytes", sizes);
    for (const [name, bytes] of Object.entries(sizes)) {
      expect(bytes, name).to.be.at.most(PACKET_DATA_SIZE);
    }
  });

  it("builds the whole signed open and key replacement transactions, proof first, within one packet", async () => {
    const instructions = new Instructions();
    const connection = new FakeRollup(OrderKeyManager.fresh(seed())).connection;
    const blockhash = {
      blockhash: PublicKey.default.toBase58(),
      lastValidBlockHeight: 1,
    };
    const gate = Keypair.generate();
    const payer = Keypair.generate();
    const owner = Keypair.generate();
    const keys = OrderKeyManager.fresh(seed()).publicKeys;
    const expiresAt = ownerExpiry(1_800_000_000);
    const sign = (message: Uint8Array) =>
      nacl.sign.detached(message, owner.secretKey);
    const open = ownerActionMessage(
      "open",
      instructions.programId,
      owner.publicKey,
      keys,
      expiresAt,
    );
    const replace = ownerActionMessage(
      "replace",
      instructions.programId,
      owner.publicKey,
      keys,
      expiresAt,
      3,
    );
    const sizes: Record<string, number> = {};
    for (const form of ["raw", "envelope"] as const) {
      const signedBytes = (message: Uint8Array) =>
        sign(form === "raw" ? message : ownerActionEnvelope(message));
      const opened = await openSignedTransaction(
        connection,
        instructions,
        gate,
        {
          owner: owner.publicKey,
          orderKeys: keys,
          expiresAt,
          signature: signedBytes(open),
          form,
        },
        blockhash,
      );
      const replaced = await replaceKeysSignedTransaction(
        connection,
        instructions,
        payer,
        {
          owner: owner.publicKey,
          orderKeys: keys,
          nonce: 3,
          expiresAt,
          signature: signedBytes(replace),
          form,
        },
        blockhash,
      );
      for (const [name, raw, feePayer] of [
        ["open", opened.raw, gate],
        ["replace", replaced.raw, payer],
      ] as const) {
        const transaction = Transaction.from(raw);
        expect(transaction.feePayer!.equals(feePayer.publicKey)).to.equal(true);
        expect(transaction.signatures).to.have.length(1);
        expect(transaction.verifySignatures()).to.equal(true);
        expect(
          transaction.instructions.map((step) => step.programId.toBase58()),
        ).to.deep.equal([
          Ed25519Program.programId.toBase58(),
          instructions.programId.toBase58(),
        ]);
        sizes[`${name} ${form}`] = raw.length;
      }
    }
    console.log("signed owner action transaction bytes", sizes);
    for (const [name, bytes] of Object.entries(sizes)) {
      expect(bytes, name).to.be.at.most(PACKET_DATA_SIZE);
    }
  });

  it("wraps an owner action in the Solana off-chain message format, and tells which form was signed", () => {
    const owner = Keypair.generate();
    const keys = OrderKeyManager.fresh(seed()).publicKeys;
    const text = ownerActionMessage(
      "open",
      new Instructions().programId,
      owner.publicKey,
      keys,
      1_800_000_000n,
    );
    const wrapped = ownerActionEnvelope(text);
    expect(Buffer.from(wrapped.subarray(0, 16))).to.deep.equal(
      Buffer.from("ff736f6c616e61206f6666636861696e", "hex"),
    );
    expect(Array.from(wrapped.subarray(16, 20))).to.deep.equal([
      0,
      1,
      text.length & 0xff,
      text.length >> 8,
    ]);
    expect(Buffer.from(wrapped.subarray(20))).to.deep.equal(Buffer.from(text));
    expect(wrapped.length).to.equal(text.length + 20);

    const raw = nacl.sign.detached(text, owner.secretKey);
    const enveloped = nacl.sign.detached(wrapped, owner.secretKey);
    expect(verifyOwnerSignature(text, raw, owner.publicKey)).to.equal("raw");
    expect(verifyOwnerSignature(text, enveloped, owner.publicKey)).to.equal(
      "envelope",
    );
    const other = Keypair.generate();
    expect(verifyOwnerSignature(text, raw, other.publicKey)).to.equal(null);
    expect(verifyOwnerSignature(text, enveloped, other.publicKey)).to.equal(
      null,
    );
    const changed = new Uint8Array(text);
    changed[changed.length - 1] ^= 1;
    expect(verifyOwnerSignature(changed, raw, owner.publicKey)).to.equal(null);
    expect(
      verifyOwnerSignature(text, raw.subarray(1), owner.publicKey),
    ).to.equal(null);
    expect(
      verifyOwnerSignature(new Uint8Array(0), raw, owner.publicKey),
    ).to.equal(null);
    expect(() => ownerActionEnvelope(new Uint8Array(0))).to.throw();
    expect(() => ownerActionEnvelope(new Uint8Array(1213))).to.throw();
  });

  it("picks an owner expiry the program cannot refuse as too far ahead", () => {
    expect(ownerExpiry(1_000)).to.equal(1_100n);
    expect(ownerExpiry(1_000, 30)).to.equal(1_030n);
    expect(ownerExpiry(1_000, 120)).to.equal(
      1_000n + BigInt(MAX_OWNER_EXPIRY_AHEAD),
    );
    expect(ownerExpiry(1_000, 3_600)).to.equal(1_120n);
    expect(MAX_OWNER_EXPIRY_AHEAD).to.equal(120);
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => ownerExpiry(1_000, bad), `lifetime ${bad}`).to.throw();
    }
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(() => ownerExpiry(bad), `clock ${bad}`).to.throw();
    }
  });

  it("names the owner errors with the program's own numbers", () => {
    expect(OWNER_ERROR).to.deep.equal({
      invalidProof: 151,
      wrongNonce: 152,
      expiryTooFar: 153,
      wrongWithdrawDestination: 154,
    });
    const names = {
      invalidProof: "InvalidOwnerProof",
      wrongNonce: "WrongOwnerNonce",
      expiryTooFar: "OwnerExpiryTooFar",
      wrongWithdrawDestination: "WrongWithdrawDestination",
    } as const;
    for (const [key, name] of Object.entries(names) as [
      keyof typeof names,
      string,
    ][]) {
      expect(OWNER_TRANSACTION_ERROR[key], name).to.equal(errorCode(name));
      expect(OWNER_TRANSACTION_ERROR[key] - OWNER_ERROR[key]).to.equal(6000);
    }
  });

  it("matches the program's owner action message vectors", () => {
    const owner = new PublicKey(new Uint8Array(32).fill(1));
    const keys = [2, 3, 4, 5].map(
      (byte) => new PublicKey(new Uint8Array(32).fill(byte)),
    );
    const digest = (action: "open" | "replace", nonce?: number) =>
      createHash("sha256")
        .update(
          ownerActionMessage(
            action,
            new Instructions().programId,
            owner,
            keys,
            1_800_000_000n,
            nonce,
          ),
        )
        .digest("hex");
    expect(digest("open")).to.equal(
      "78b22efd8b43797377c045292134f6706b22b76dd99ef92a09b6b6dfb5a6aaf6",
    );
    expect(digest("replace", 0xffffffff)).to.equal(
      "4a73fa6da661e1f231533a4431b87bdef8f0dbbef84658b5fe2013ad8b652511",
    );
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

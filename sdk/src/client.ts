import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  decodeMarket,
  decodePriceFeed,
  decodeStats,
  decodeTape,
  decodeView,
  type MarketParams,
  type OrderResult,
  type PriceFeed,
  type Stats,
  type Tape,
  type View,
} from "./accounts.js";
import { Addresses } from "./addresses.js";
import { MAX_EXPIRY_AHEAD, PROGRAM_ID, RESULT_KIND } from "./constants.js";
import {
  Instructions,
  type OrderInput,
  type OrderKeyCall,
} from "./instructions.js";
import { OrderKeyManager, type OrderKeyUse } from "./orderKeys.js";
import { randomSecret } from "./receipts.js";

export type Unsubscribe = () => Promise<void>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A signed transaction, ready to send as many times as needed. */
export type Signed = { raw: Buffer; signature: string };

export async function signed(
  connection: Connection,
  instructions: TransactionInstruction[],
  feePayer: Keypair,
  signers: Keypair[] = [],
): Promise<Signed> {
  const latest = await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({
    feePayer: feePayer.publicKey,
    ...latest,
  }).add(...instructions);
  transaction.sign(feePayer, ...signers);
  const signature = transaction.signature;
  if (!signature) throw new Error("the transaction was not signed");
  return {
    raw: transaction.serialize(),
    signature: Buffer.from(signature).toString("base64"),
  };
}

/** Sends a transaction and waits for its status, for everything but orders. */
export async function sendAndConfirm(
  connection: Connection,
  instructions: TransactionInstruction[],
  feePayer: Keypair,
  signers: Keypair[] = [],
  timeoutMs = 60_000,
): Promise<string> {
  const { raw } = await signed(connection, instructions, feePayer, signers);
  const signature = await connection.sendRawTransaction(raw, {
    skipPreflight: true,
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value } = await connection.getSignatureStatus(signature);
    if (value && value.confirmationStatus !== "processed") {
      if (value.err) {
        // The private endpoint may refuse to show a transaction; the error
        // still has to reach the caller, without its logs.
        const landed = await connection
          .getTransaction(signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          })
          .catch(() => null);
        throw new Error(
          `${JSON.stringify(value.err)}\n${(landed?.meta?.logMessages ?? []).join("\n")}`,
        );
      }
      return signature;
    }
    await sleep(100);
  }
  throw new Error(
    `transaction ${signature} was not confirmed in ${timeoutMs} ms`,
  );
}

export type PlaceOrderOptions = {
  /** Seconds the order stays sendable for. The program refuses more than 60. */
  expirySeconds?: number;
  /** How often the view is read while waiting for the result. */
  pollMs?: number;
  /** How long to wait for the result before sending the same transaction again. */
  resendMs?: number;
  clientOrderId?: bigint;
  secret?: Uint8Array;
  /** Other perp markets the trader holds positions on, for the margin check. */
  riskMarkets?: number[];
  /** The clock the expiry is measured against, in unix seconds. */
  now?: () => number;
  /**
   * How long to wait for the result before asking once whether the
   * transaction failed. Defaults to 400 ms.
   */
  statusCheckMs?: number;
};

/**
 * When a call was first sent and when its result was read from the view, in
 * milliseconds of the monotonic clock (`performance.now()`).
 */
export type Timing = { sentAt: number; resultAt: number };

export type Placed =
  | ({
      outcome: "placed";
      result: OrderResult;
      secret: Uint8Array;
      view: View;
    } & Timing)
  | {
      outcome: "expired";
      clientOrderId: bigint;
      secret: Uint8Array;
      view: View;
      sentAt: number;
    };

/**
 * The transaction landed and the program refused it. Nothing changed and the
 * order key that signed it is still live. `err` is the status the network
 * reports; `code` is the program's error number when there is one, 6000 plus
 * the number in the program's error list.
 */
export class TransactionFailed extends Error {
  readonly code: number | null;

  constructor(
    readonly signature: string,
    readonly err: unknown,
  ) {
    super(`transaction ${signature} failed: ${JSON.stringify(err)}`);
    this.name = "TransactionFailed";
    const detail = (err as { InstructionError?: [number, unknown] })
      ?.InstructionError?.[1] as { Custom?: number } | undefined;
    this.code = typeof detail?.Custom === "number" ? detail.Custom : null;
  }
}

/** An order the client refused before signing, by the program's own rule. */
export class OrderInvalid extends Error {
  constructor(
    readonly reason: "SizeTooSmall" | "PriceOffTick" | "NotionalTooSmall",
  ) {
    super(`the order is not valid on this market: ${reason}`);
    this.name = "OrderInvalid";
  }
}

/**
 * A trader's client: builds, signs and confirms from the view. `connection`
 * sends to the rollup; `reader` is a connection that may read this trader's
 * view, that is a private connection signed in as the owner.
 */
export class TraderClient {
  readonly instructions: Instructions;
  readonly addresses: Addresses;

  constructor(
    readonly connection: Connection,
    readonly reader: Connection,
    readonly owner: PublicKey,
    readonly keys: OrderKeyManager,
    programId: PublicKey = PROGRAM_ID,
  ) {
    this.instructions = new Instructions(programId);
    this.addresses = this.instructions.addresses;
  }

  async view(): Promise<View> {
    const account = await this.reader.getAccountInfo(
      this.addresses.view(this.owner),
    );
    if (!account)
      throw new Error("the view is not readable by this connection");
    return decodeView(account.data);
  }

  private call(
    use: OrderKeyUse,
    marketId: number,
    clientOrderId: bigint,
    expiresAt: bigint,
    riskMarkets?: number[],
  ): OrderKeyCall {
    return {
      orderKey: use.keypair.publicKey,
      owner: this.owner,
      expiresAt,
      replacement: use.replacement.publicKey,
      clientOrderId,
      marketId,
      riskMarkets,
    };
  }

  /**
   * Places an order and confirms it from the view's result ring. While no
   * result for the client order id shows, the same signed transaction is sent
   * again every `resendMs`, until the expiry; after that, with still no result,
   * the order is reported expired and its key is still live.
   */
  async placeOrder(
    marketId: number,
    order: Omit<OrderInput, "secret" | "expiry"> & {
      secret?: Uint8Array;
      /** When a resting remainder stops being valid, unix seconds; none by default. */
      expiry?: bigint;
    },
    options: PlaceOrderOptions = {},
  ): Promise<Placed> {
    const expirySeconds = Math.min(
      options.expirySeconds ?? 5,
      MAX_EXPIRY_AHEAD,
    );
    const now = options.now ?? (() => Math.floor(Date.now() / 1000));
    const secret = options.secret ?? order.secret ?? randomSecret();
    await this.checkAgainstMarket(marketId, order);
    const before = await this.view();
    const clientOrderId = unusedClientOrderId(before, options.clientOrderId);
    const expiresAt = BigInt(now() + expirySeconds);
    const use = this.keys.take();
    try {
      const instruction = this.instructions.placeOrder(
        this.call(use, marketId, clientOrderId, expiresAt, options.riskMarkets),
        { ...order, secret, expiry: order.expiry ?? 0n },
      );
      const { result, view, sentAt, resultAt } = await this.confirmed({
        use,
        instruction,
        before,
        clientOrderId,
        kind: RESULT_KIND.place,
        expiresAt,
        now,
        pollMs: options.pollMs ?? 50,
        resendMs: options.resendMs ?? 1_000,
        statusCheckMs: options.statusCheckMs ?? 400,
      });
      return result
        ? { outcome: "placed", result, secret, view, sentAt, resultAt }
        : { outcome: "expired", clientOrderId, secret, view, sentAt };
    } catch (error) {
      await this.settleAfterFailure(use);
      throw error;
    }
  }

  private markets = new Map<number, { readAt: number; params: MarketParams }>();

  /**
   * Refuses, before anything is signed, an order the program would refuse on
   * the market's public settings alone: off the tick, below the minimum size
   * or below the minimum notional. The settings are read at most every 30
   * seconds; tick never changes, and a stale minimum only delays by that long.
   */
  private async checkAgainstMarket(
    marketId: number,
    order: Pick<OrderInput, "price" | "size">,
  ): Promise<void> {
    const known = this.markets.get(marketId);
    let params = known?.params;
    if (!known || Date.now() - known.readAt > 30_000) {
      const account = await this.connection.getAccountInfo(
        this.addresses.market(marketId),
      );
      if (!account) throw new Error(`market ${marketId} does not exist`);
      params = decodeMarket(account.data).params;
      this.markets.set(marketId, { readAt: Date.now(), params });
    }
    const { tick, minSize, minNotional } = params!;
    if (order.size === 0n || order.size < minSize) {
      throw new OrderInvalid("SizeTooSmall");
    }
    if (order.price <= 0n || order.price % tick !== 0n) {
      throw new OrderInvalid("PriceOffTick");
    }
    if (order.price * order.size < minNotional) {
      throw new OrderInvalid("NotionalTooSmall");
    }
  }

  /**
   * Sends one order-key transaction and waits for its result in the view.
   * The first send's own failure is the caller's at once. A transaction that
   * landed and failed writes no result, so its status is asked for once
   * after `statusCheckMs` without a result, and once more at the expiry;
   * a failure found there is thrown as `TransactionFailed` instead of being
   * waited out. Transactions go out with preflight skipped: the private
   * endpoint refuses simulation of what it would refuse to send.
   */
  private async confirmed(call: {
    use: OrderKeyUse;
    instruction: TransactionInstruction;
    before: View;
    clientOrderId: bigint;
    kind: number;
    expiresAt: bigint;
    now: () => number;
    pollMs: number;
    resendMs: number;
    statusCheckMs: number;
  }): Promise<{
    result?: OrderResult;
    view: View;
    sentAt: number;
    resultAt: number;
  }> {
    const { use, before, clientOrderId, kind, now } = call;
    const expiresAt = Number(call.expiresAt);
    const { raw } = await signed(
      this.connection,
      [call.instruction],
      use.keypair,
    );
    const send = () =>
      this.connection.sendRawTransaction(raw, { skipPreflight: true });
    const sentAt = performance.now();
    const signature = await send();
    let lastSent = Date.now();
    let statusChecked = false;
    for (;;) {
      if (now() <= expiresAt && Date.now() - lastSent >= call.resendMs) {
        await send().catch(() => {});
        lastSent = Date.now();
      }
      const expired = now() > expiresAt + 1;
      const view = await this.view();
      const result = writtenSince(before, view, clientOrderId, kind);
      if (result) {
        this.keys.confirm(use, view);
        return { result, view, sentAt, resultAt: performance.now() };
      }
      const statusDue =
        !statusChecked && performance.now() - sentAt >= call.statusCheckMs;
      if (expired || statusDue) {
        statusChecked = true;
        const status = await this.connection.getSignatureStatus(signature);
        if (status.value?.err) {
          throw new TransactionFailed(signature, status.value.err);
        }
      }
      if (expired) {
        this.keys.release(use, view);
        return { view, sentAt, resultAt: performance.now() };
      }
      await sleep(call.pollMs);
    }
  }

  /**
   * A call that threw may or may not have swapped its key. The slot takes
   * whichever key the view shows; when the view cannot be read either, the
   * slot stays lent out, which is the safe side: nothing is signed with a key
   * whose state is unknown.
   */
  private async settleAfterFailure(use: OrderKeyUse): Promise<void> {
    const view = await this.view().catch(() => null);
    if (view) this.keys.release(use, view);
  }

  private async sendKeyed(
    kind: number,
    build: (
      use: OrderKeyUse,
      clientOrderId: bigint,
      expiresAt: bigint,
    ) => TransactionInstruction,
    expirySeconds?: number,
  ): Promise<(OrderResult & Timing) | null> {
    const before = await this.view();
    const clientOrderId = unusedClientOrderId(before);
    const expiresAt = this.expiry(expirySeconds);
    const use = this.keys.take();
    try {
      const { result, sentAt, resultAt } = await this.confirmed({
        use,
        instruction: build(use, clientOrderId, expiresAt),
        before,
        clientOrderId,
        kind,
        expiresAt,
        now: () => Math.floor(Date.now() / 1000),
        pollMs: 50,
        resendMs: Infinity,
        statusCheckMs: 400,
      });
      return result ? { ...result, sentAt, resultAt } : null;
    } catch (error) {
      await this.settleAfterFailure(use);
      throw error;
    }
  }

  private expiry(seconds = 5): bigint {
    return BigInt(
      Math.floor(Date.now() / 1000) + Math.min(seconds, MAX_EXPIRY_AHEAD),
    );
  }

  async cancelOrder(
    marketId: number,
    orderSeq: bigint,
    expirySeconds?: number,
  ) {
    return this.sendKeyed(
      RESULT_KIND.cancel,
      (use, clientOrderId, expiresAt) =>
        this.instructions.cancelOrder(
          this.call(use, marketId, clientOrderId, expiresAt),
          orderSeq,
        ),
      expirySeconds,
    );
  }

  async cancelAll(marketId: number, maxCancels = 32, expirySeconds?: number) {
    return this.sendKeyed(
      RESULT_KIND.cancelAll,
      (use, clientOrderId, expiresAt) =>
        this.instructions.cancelAll(
          this.call(use, marketId, clientOrderId, expiresAt),
          maxCancels,
        ),
      expirySeconds,
    );
  }

  /**
   * Moves collateral-token value between the perpetuals collateral and the
   * spot balance of the same mint, no tokens moving. `riskMarkets` must name
   * every perp market the exchange has.
   */
  async transferBetweenBalances(
    toCollateral: boolean,
    spotToken: number,
    amount: bigint,
    riskMarkets: number[] = [],
    expirySeconds?: number,
  ) {
    return this.sendKeyed(
      RESULT_KIND.transfer,
      (use, clientOrderId, expiresAt) =>
        this.instructions.transferBetweenBalances(
          this.call(use, 0, clientOrderId, expiresAt, riskMarkets),
          toCollateral,
          spotToken,
          amount,
        ),
      expirySeconds,
    );
  }

  async syncView(marketId: number, expirySeconds?: number) {
    return this.sendKeyed(
      RESULT_KIND.sync,
      (use, clientOrderId, expiresAt) =>
        this.instructions.syncView(
          this.call(use, marketId, clientOrderId, expiresAt),
        ),
      expirySeconds,
    );
  }

  /**
   * RULES 8: tried blind against seat `target`. `worstPrice` is the worst
   * liquidation price accepted: the highest when buying a long target's
   * position, the lowest when selling into a short one's.
   */
  async liquidate(
    marketId: number,
    target: number,
    size: bigint,
    worstPrice: bigint,
    riskMarkets: number[] = [],
    expirySeconds?: number,
  ) {
    return this.sendKeyed(
      RESULT_KIND.liquidate,
      (use, clientOrderId, expiresAt) =>
        this.instructions.liquidate(
          this.call(use, marketId, clientOrderId, expiresAt, riskMarkets),
          target,
          size,
          worstPrice,
        ),
      expirySeconds,
    );
  }

  subscribeView(onChange: (view: View) => void): Unsubscribe {
    return subscribe(
      this.reader,
      this.addresses.view(this.owner),
      decodeView,
      onChange,
    );
  }
}

/** A client order id of 64 random bits, so two calls never share one by accident. */
export function randomClientOrderId(): bigint {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return new DataView(bytes.buffer).getBigUint64(0, true);
}

type ResultRing = Pick<View, "results" | "resultsWritten">;

/**
 * The client order id a call may use, given the view as it was before the
 * call: the caller's own, refused while a result with that id is still in the
 * ring, or a random one that is not in the ring.
 */
function unusedClientOrderId(before: ResultRing, wanted?: bigint): bigint {
  const inRing = (id: bigint) =>
    before.results.some((entry) => entry.clientOrderId === id);
  if (wanted !== undefined) {
    if (inRing(wanted)) {
      throw new Error(
        `client order id ${wanted} still has a result in the view; use another`,
      );
    }
    return wanted;
  }
  for (;;) {
    const id = randomClientOrderId();
    if (!inRing(id)) return id;
  }
}

/**
 * The result of one call: written after the view was read as `before`, of the
 * call's own kind and with its client order id. An older result that happens
 * to carry the same id is never taken for it.
 */
export function writtenSince(
  before: Pick<View, "resultsWritten">,
  view: ResultRing,
  clientOrderId: bigint,
  kind: number,
): OrderResult | undefined {
  const written = Math.max(0, view.resultsWritten - before.resultsWritten);
  return view.results
    .slice(0, written)
    .find(
      (entry) => entry.clientOrderId === clientOrderId && entry.kind === kind,
    );
}

function subscribe<T>(
  connection: Connection,
  address: PublicKey,
  decode: (data: Uint8Array) => T,
  onChange: (value: T) => void,
): Unsubscribe {
  const id = connection.onAccountChange(
    address,
    (account) => onChange(decode(account.data)),
    { commitment: "confirmed" },
  );
  return () => connection.removeAccountChangeListener(id);
}

/** Public reads and subscriptions, for any connection to the rollup or the filter. */
export class MarketReader {
  readonly addresses: Addresses;

  constructor(
    readonly connection: Connection,
    programId: PublicKey = PROGRAM_ID,
  ) {
    this.addresses = new Addresses(programId);
  }

  private async read<T>(
    address: PublicKey,
    decode: (data: Uint8Array) => T,
  ): Promise<T> {
    const account = await this.connection.getAccountInfo(address);
    if (!account) throw new Error(`${address.toBase58()} is not readable here`);
    return decode(account.data);
  }

  tape(marketId: number): Promise<Tape> {
    return this.read(this.addresses.tape(marketId), decodeTape);
  }

  priceFeed(marketId: number): Promise<PriceFeed> {
    return this.read(this.addresses.priceFeed(marketId), decodePriceFeed);
  }

  stats(): Promise<Stats> {
    return this.read(this.addresses.stats, decodeStats);
  }

  subscribeTape(marketId: number, onChange: (tape: Tape) => void): Unsubscribe {
    return subscribe(
      this.connection,
      this.addresses.tape(marketId),
      decodeTape,
      onChange,
    );
  }

  subscribePriceFeed(
    marketId: number,
    onChange: (feed: PriceFeed) => void,
  ): Unsubscribe {
    return subscribe(
      this.connection,
      this.addresses.priceFeed(marketId),
      decodePriceFeed,
      onChange,
    );
  }

  subscribeStats(onChange: (stats: Stats) => void): Unsubscribe {
    return subscribe(
      this.connection,
      this.addresses.stats,
      decodeStats,
      onChange,
    );
  }
}

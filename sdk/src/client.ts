import {
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
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
import {
  ViewFeed,
  globalSocket,
  inBackground,
  type SocketFactory,
} from "./viewFeed.js";

export type Unsubscribe = () => Promise<void>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A signed transaction, ready to send as many times as needed. */
export type Signed = { raw: Buffer; signature: string };

type Blockhash = Awaited<ReturnType<Connection["getLatestBlockhash"]>>;

/** Signs with `blockhash` when given one, and asks the network for one otherwise. */
export async function signed(
  connection: Connection,
  instructions: TransactionInstruction[],
  feePayer: Keypair,
  signers: Keypair[] = [],
  blockhash?: Blockhash,
): Promise<Signed> {
  const latest =
    blockhash ?? (await connection.getLatestBlockhash("confirmed"));
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

const STATUS_POLL_MS = { first: 100, growth: 1.5, slowest: 1_000 };

/**
 * Sends a transaction and waits for its status, for everything but orders.
 * The status is asked for less and less often, down to once a second: a
 * rollup answers on the first ask, and a public Solana endpoint that takes
 * seconds to confirm limits how often it may be asked.
 */
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
  let pollMs = STATUS_POLL_MS.first;
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
    await sleep(pollMs);
    pollMs = Math.min(STATUS_POLL_MS.slowest, pollMs * STATUS_POLL_MS.growth);
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
  secret?: Uint8Array;
  /** Other perp markets the trader holds positions on, for the margin check. */
  riskMarkets?: number[];
  /**
   * The clock the expiry is measured against, in unix seconds. By default the
   * client's own estimate of the rollup's clock.
   */
  now?: () => number;
  /**
   * How long a live subscription is given to deliver the result before the
   * view is read as well. Defaults to 500 ms.
   */
  pushWaitMs?: number;
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

/**
 * What became of an order, for certain. `expired` is said only once the
 * rollup's own clock is past the order's expiry and the view shows no result:
 * the order did not run and no longer can.
 */
export type Settled =
  | ({
      outcome: "placed";
      clientOrderId: bigint;
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
 * `unknown` is a call the client stopped waiting for while the order could
 * still run: the device's clock is not the rollup's, and a sent transaction
 * may be queued. `settled` resolves to what became of it. Until then its
 * order key is lent to nothing else.
 */
export type Placed =
  | Settled
  | {
      outcome: "unknown";
      clientOrderId: bigint;
      secret: Uint8Array;
      sentAt: number;
      settled: Promise<Settled>;
    };

/**
 * A call other than `placeOrder` whose outcome is not known: the client
 * stopped waiting, or lost the connection, while the instruction could still
 * run. `settled` resolves to its result, or to null once it can no longer run.
 */
export class OutcomeUnknown extends Error {
  constructor(
    readonly clientOrderId: bigint,
    readonly settled: Promise<(OrderResult & Timing) | null>,
    cause?: unknown,
  ) {
    super(`the outcome of call ${clientOrderId} is not known yet`, { cause });
    this.name = "OutcomeUnknown";
  }
}

/** Seconds the rollup's clock must be past an expiry before it is relied on. */
const EXPIRY_MARGIN_SECONDS = 2;
const QUARANTINE_POLL_MS = 250;
const CLOCK_UNIX_TIMESTAMP_OFFSET = 32;

/** The clock the program reads, in unix seconds, as `connection` serves it. */
export async function clockOf(connection: Connection): Promise<number> {
  const clock = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY);
  if (!clock) throw new Error("the network serves no clock");
  return Number(
    new DataView(clock.data.buffer, clock.data.byteOffset).getBigInt64(
      CLOCK_UNIX_TIMESTAMP_OFFSET,
      true,
    ),
  );
}

type Watched = {
  use: OrderKeyUse;
  before: View;
  clientOrderId: bigint;
  kind: number;
  expiresAt: number;
};

type Late = { result?: OrderResult; view: View; resultAt: number };

type Confirmation = { sentAt: number } & (
  | { result: OrderResult; view: View; resultAt: number }
  | { late: Promise<Late> }
);

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

/** `Expired` and `ExpiryTooFar` in the program's error list. */
const EXPIRY_REFUSALS = [6133, 6134];

const refusedForItsExpiry = (error: unknown) =>
  error instanceof TransactionFailed &&
  error.code !== null &&
  EXPIRY_REFUSALS.includes(error.code);

const refusedForItsBlockhash = (error: unknown) =>
  /blockhash not found/i.test(error instanceof Error ? error.message : "");

/**
 * A rollup blockhash stays valid for about a minute. One is fetched every
 * `refreshMs` in the background and signed with until it is `usableMs` old,
 * so placing an order asks for none.
 */
const BLOCKHASH = { refreshMs: 15_000, usableMs: 30_000 };
const CLOCK_MEASURED_EVERY_MS = 300_000;
/** Seconds an expiry stays short of the furthest the program accepts, for an estimated clock. */
const CLOCK_MARGIN_SECONDS = 2;
const PUSH_WAIT_MS = 500;
const READY_WAIT_MS = 5_000;

class BlockhashCache {
  private latest?: { value: Blockhash; at: number };
  private fetching?: Promise<Blockhash>;

  constructor(private readonly connection: Connection) {}

  refresh(): Promise<Blockhash> {
    this.fetching ??= this.connection
      .getLatestBlockhash("confirmed")
      .then((value) => {
        this.latest = { value, at: Date.now() };
        return value;
      })
      .finally(() => {
        this.fetching = undefined;
      });
    return this.fetching;
  }

  async current(): Promise<Blockhash> {
    return this.latest && Date.now() - this.latest.at < BLOCKHASH.usableMs
      ? this.latest.value
      : this.refresh();
  }
}

export type TraderClientOptions = {
  /**
   * Learn results from a websocket subscription to the trader's own view,
   * reading the view only when the subscription is down or silent. On by
   * default; `false` reads the view for every result, as before 0.5.0.
   */
  push?: boolean;
  /** Opens the websocket. The runtime's own `WebSocket` by default. */
  socket?: SocketFactory;
};

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
 *
 * From its first call the client keeps three things current in the
 * background, so that a call costs one request, the send: a blockhash, the
 * rollup's clock as an offset from this device's, and the view itself, over
 * a websocket to the reader's endpoint. `ready` waits for all three; `close`
 * ends them.
 */
export class TraderClient {
  readonly instructions: Instructions;
  readonly addresses: Addresses;
  reader: Connection;
  private readonly feed?: ViewFeed;
  private readonly blockhashes: BlockhashCache;
  private upkeep?: ReturnType<typeof setInterval>;
  private clockMeasuredAt = 0;
  /** Seconds the rollup's clock is ahead of this device's, once measured. */
  private rollupAhead?: number;

  constructor(
    readonly connection: Connection,
    reader: Connection,
    readonly owner: PublicKey,
    readonly keys: OrderKeyManager,
    programId: PublicKey = PROGRAM_ID,
    options: TraderClientOptions = {},
  ) {
    this.reader = reader;
    this.instructions = new Instructions(programId);
    this.addresses = this.instructions.addresses;
    this.blockhashes = new BlockhashCache(connection);
    const socket = options.socket ?? globalSocket();
    if (options.push !== false && socket) {
      this.feed = new ViewFeed(
        () => this.reader,
        this.addresses.view(owner),
        socket,
      );
    }
  }

  /** Whether results are arriving by subscription right now. */
  get pushing(): boolean {
    return this.feed?.live ?? false;
  }

  private start(): void {
    if (this.upkeep) return;
    this.feed?.start();
    this.upkeep = inBackground(
      setInterval(() => {
        void this.blockhashes.refresh().catch(() => {});
        if (Date.now() - this.clockMeasuredAt > CLOCK_MEASURED_EVERY_MS) {
          void this.rollupClock().catch(() => {});
        }
      }, BLOCKHASH.refreshMs),
    );
  }

  /**
   * Resolves once the first call needs nothing but its send: a blockhash and
   * the clock are in hand and the subscription is live. A subscription that
   * does not come up in five seconds is not waited for; calls read the view
   * until it does.
   */
  async ready(): Promise<void> {
    this.start();
    await Promise.all([
      this.blockhashes.refresh(),
      this.rollupClock(),
      this.feed?.established(READY_WAIT_MS),
    ]);
  }

  /** Ends the subscription and the background refreshes. A later call starts them again. */
  close(): void {
    clearInterval(this.upkeep);
    this.upkeep = undefined;
    this.feed?.stop();
  }

  /**
   * Reads through `reader` from now on, and subscribes through it: for a
   * connection signed in again after its token ran out.
   */
  renewReader(reader: Connection): void {
    this.reader = reader;
    this.feed?.restart();
  }

  /** Reads the rollup's clock and keeps how far it is from this device's. */
  private async rollupClock(): Promise<number> {
    const clock = await clockOf(this.connection);
    this.rollupAhead = clock - Math.floor(Date.now() / 1000);
    this.clockMeasuredAt = Date.now();
    return clock;
  }

  private estimatedClock = () =>
    Math.floor(Date.now() / 1000) + (this.rollupAhead ?? 0);

  /**
   * Runs `attempt` against `now`, or against the client's estimate of the
   * rollup's clock. An instruction refused for its expiry under the estimate
   * is tried once more after reading the clock; the refusal changed nothing.
   */
  private async onRollupTime<T>(
    now: (() => number) | undefined,
    expirySeconds: number,
    attempt: (now: () => number, expirySeconds: number) => Promise<T>,
  ): Promise<T> {
    if (now) return attempt(now, Math.min(expirySeconds, MAX_EXPIRY_AHEAD));
    const within = Math.min(
      expirySeconds,
      MAX_EXPIRY_AHEAD - CLOCK_MARGIN_SECONDS,
    );
    if (this.rollupAhead === undefined) await this.rollupClock();
    try {
      return await attempt(this.estimatedClock, within);
    } catch (error) {
      if (!refusedForItsExpiry(error)) throw error;
      await this.rollupClock();
      return attempt(this.estimatedClock, within);
    }
  }

  /**
   * The view as it was at some moment before now, to tell a call's result
   * from older ones: the subscription's while it is live, read otherwise.
   */
  private async watermark(): Promise<View> {
    this.start();
    return (this.feed?.live && this.feed.latest) || this.view();
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
   * the outcome is `unknown` and `settled` tells what became of the order.
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
    const secret = options.secret ?? order.secret ?? randomSecret();
    await this.checkAgainstMarket(marketId, order);
    const { watched, confirmation } = await this.onRollupTime(
      options.now,
      options.expirySeconds ?? 5,
      async (now, expirySeconds) => {
        const before = await this.watermark();
        const expiresAt = now() + expirySeconds;
        const watched = this.begin(before, RESULT_KIND.place, expiresAt);
        const { use, clientOrderId } = watched;
        const confirmation = await this.confirmed(watched, {
          instruction: () =>
            this.instructions.placeOrder(
              this.call(
                use,
                marketId,
                clientOrderId,
                BigInt(expiresAt),
                options.riskMarkets,
              ),
              { ...order, secret, expiry: order.expiry ?? 0n },
            ),
          now,
          pollMs: options.pollMs ?? 50,
          resendMs: options.resendMs ?? 1_000,
          statusCheckMs: options.statusCheckMs ?? 400,
          pushWaitMs: options.pushWaitMs ?? PUSH_WAIT_MS,
        });
        return { watched, confirmation };
      },
    );
    const { clientOrderId } = watched;
    const { sentAt } = confirmation;
    const settled = ({ result, view, resultAt }: Late): Settled =>
      result
        ? {
            outcome: "placed",
            clientOrderId,
            result,
            secret,
            view,
            sentAt,
            resultAt,
          }
        : { outcome: "expired", clientOrderId, secret, view, sentAt };
    if ("late" in confirmation) {
      return {
        outcome: "unknown",
        clientOrderId,
        secret,
        sentAt,
        settled: unobserved(confirmation.late.then(settled)),
      };
    }
    return settled(confirmation);
  }

  private inFlight = new Set<bigint>();

  /**
   * Lends an order key and reserves a client order id for one call. Both stay
   * the call's own until `end`.
   */
  private begin(before: View, kind: number, expiresAt: number): Watched {
    const use = this.keys.take();
    const clientOrderId = unusedClientOrderId(before, this.inFlight);
    this.inFlight.add(clientOrderId);
    return { use, before, clientOrderId, kind, expiresAt };
  }

  /**
   * Ends a call whose outcome is certain. With `view`, the slot takes the key
   * the view shows; without, the instruction is known not to have run.
   */
  private end({ use, clientOrderId }: Watched, view?: View): boolean {
    this.inFlight.delete(clientOrderId);
    if (view) return this.keys.settle(use, view);
    this.keys.release(use);
    return false;
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
   * Sends one order-key transaction and waits for its result in the view:
   * pushed by the subscription while that is live, and read every `pollMs`
   * when it is not, or once it has delivered nothing for `pushWaitMs`. The
   * transaction is signed with the kept blockhash, and signed and sent once
   * more with a new one if the network no longer knows it. With a live
   * subscription the send's own answer is not waited for: the result can be
   * pushed before it, and a send that fails still ends the wait. A transaction that
   * landed and failed writes no result, so its status is asked for once
   * after `statusCheckMs` without a result, and once more at the expiry;
   * a failure found there is thrown as `TransactionFailed` instead of being
   * waited out. Transactions go out with preflight skipped: the private
   * endpoint refuses simulation of what it would refuse to send.
   *
   * The device's clock only decides when to stop waiting. A call given up on,
   * or one whose reads failed after it was sent, may still run: it comes back
   * as `late`, or is thrown as `OutcomeUnknown`, and stays in quarantine.
   */
  private async confirmed(
    watched: Watched,
    how: {
      instruction: () => TransactionInstruction;
      now: () => number;
      pollMs: number;
      resendMs: number;
      statusCheckMs: number;
      pushWaitMs: number;
    },
  ): Promise<Confirmation> {
    const { use, before, clientOrderId, kind, expiresAt } = watched;
    let instruction: TransactionInstruction;
    let raw: Buffer;
    const sign = async (blockhash: Promise<Blockhash>) =>
      signed(this.connection, [instruction], use.keypair, [], await blockhash);
    try {
      instruction = how.instruction();
      ({ raw } = await sign(this.blockhashes.current()));
    } catch (error) {
      this.end(watched);
      throw error;
    }
    const send = () =>
      this.connection.sendRawTransaction(raw, { skipPreflight: true });
    const sentAt = performance.now();
    const observed = this.observer(sentAt, how);
    const sent = unobserved(
      send().catch(async (error) => {
        if (!refusedForItsBlockhash(error)) throw error;
        ({ raw } = await sign(this.blockhashes.refresh()));
        return send();
      }),
    );
    const sendFailed = unobserved(
      sent.then(() => new Promise<never>(() => {})),
    );
    const refusedIfFailed = async () => {
      const signature = await sent;
      const status = await this.connection.getSignatureStatus(signature);
      if (status.value?.err) {
        throw new TransactionFailed(signature, status.value.err);
      }
    };
    try {
      if (!this.feed?.live) await sent;
      let lastSent = Date.now();
      let statusChecked = false;
      let statusFailed = new Promise<never>(() => {});
      for (;;) {
        if (how.now() <= expiresAt && Date.now() - lastSent >= how.resendMs) {
          void send().catch(() => {});
          lastSent = Date.now();
        }
        const gaveUp = how.now() > expiresAt + 1;
        const view = await Promise.race([
          observed(statusChecked ? Infinity : sentAt + how.statusCheckMs),
          sendFailed,
          statusFailed,
        ]);
        const result = view && writtenSince(before, view, clientOrderId, kind);
        if (view && result) {
          this.end(watched, view);
          return { result, view, sentAt, resultAt: performance.now() };
        }
        if (gaveUp) {
          await refusedIfFailed();
          return { sentAt, late: this.quarantined(watched) };
        }
        if (!statusChecked && performance.now() - sentAt >= how.statusCheckMs) {
          statusChecked = true;
          statusFailed = unobserved(
            refusedIfFailed().then(() => new Promise<never>(() => {})),
          );
        }
      }
    } catch (error) {
      if (error instanceof TransactionFailed) {
        this.end(watched);
        throw error;
      }
      const settled = this.quarantined(watched).then(({ result, resultAt }) =>
        result ? { ...result, sentAt, resultAt } : null,
      );
      throw new OutcomeUnknown(clientOrderId, unobserved(settled), error);
    }
  }

  /**
   * Hands a waiting call the states of the view one after another, each to
   * be searched for its result. A state the subscription already holds is
   * handed over at once, which covers a result pushed before the send
   * returned. While the subscription is live and `pushWaitMs` from the send
   * has not passed, the next state is waited for until `wakeAt` at the
   * latest, and nothing is handed over if none came. Otherwise the view is
   * read, at once the first time and `pollMs` apart after that, unless a
   * push comes first. Each read is shown to the subscription, which sets
   * itself up again if it turns out to have lost a write.
   */
  private observer(
    sentAt: number,
    how: { pollMs: number; pushWaitMs: number },
  ): (wakeAt: number) => Promise<View | undefined> {
    const feed = this.feed;
    const pushUntil = sentAt + how.pushWaitMs;
    let seen = -1;
    let hasRead = false;
    const pushed = () => {
      if (!feed || feed.version === seen) return undefined;
      seen = feed.version;
      return feed.latest;
    };
    return async (wakeAt) => {
      const held = pushed();
      if (held) return held;
      if (feed?.live && performance.now() < pushUntil) {
        const wait = Math.min(pushUntil, wakeAt) - performance.now();
        await feed.changed(seen, wait);
        return pushed();
      }
      if (hasRead) {
        await (feed ? feed.changed(seen, how.pollMs) : sleep(how.pollMs));
        const arrived = pushed();
        if (arrived) return arrived;
      }
      hasRead = true;
      const view = await this.view();
      feed?.overtakenBy(view);
      return view;
    };
  }

  /**
   * Keeps a call's order key and client order id out of use until its outcome
   * is certain: its result shows in the view, or the rollup's own clock is
   * past its expiry by a margin, after which the program refuses it. The clock
   * is read before the view, so a view read once the clock is past the expiry
   * already holds whatever the instruction did. While either cannot be read
   * the key stays out, which is the safe side.
   */
  private async quarantined(watched: Watched): Promise<Late> {
    const { before, clientOrderId, kind, expiresAt } = watched;
    for (;;) {
      const read = await (async () => {
        const closed =
          (await this.rollupClock()) > expiresAt + EXPIRY_MARGIN_SECONDS;
        const view = await this.view();
        return { closed, view };
      })().catch(() => null);
      const result =
        read && writtenSince(before, read.view, clientOrderId, kind);
      if (read && (result || read.closed)) {
        const ran = this.end(watched, read.view);
        if (ran && !result) {
          throw new Error(
            `call ${clientOrderId} ran, but its result has left the view`,
          );
        }
        return {
          result: result || undefined,
          view: read.view,
          resultAt: performance.now(),
        };
      }
      await sleep(QUARANTINE_POLL_MS);
    }
  }

  /** Throws `OutcomeUnknown` when the client stops waiting before the outcome is certain. */
  private async sendKeyed(
    kind: number,
    build: (
      use: OrderKeyUse,
      clientOrderId: bigint,
      expiresAt: bigint,
    ) => TransactionInstruction,
    expirySeconds = 5,
  ): Promise<OrderResult & Timing> {
    const { watched, confirmation } = await this.onRollupTime(
      undefined,
      expirySeconds,
      async (now, within) => {
        const before = await this.watermark();
        const expiresAt = now() + within;
        const watched = this.begin(before, kind, expiresAt);
        const confirmation = await this.confirmed(watched, {
          instruction: () =>
            build(watched.use, watched.clientOrderId, BigInt(expiresAt)),
          now,
          pollMs: 50,
          resendMs: Infinity,
          statusCheckMs: 400,
          pushWaitMs: PUSH_WAIT_MS,
        });
        return { watched, confirmation };
      },
    );
    const { sentAt } = confirmation;
    if ("late" in confirmation) {
      const settled = confirmation.late.then(({ result, resultAt }) =>
        result ? { ...result, sentAt, resultAt } : null,
      );
      throw new OutcomeUnknown(watched.clientOrderId, unobserved(settled));
    }
    return { ...confirmation.result, sentAt, resultAt: confirmation.resultAt };
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
 * A random client order id that no call in flight carries and that has no
 * result in the ring of the view as it was before the call, so a result with
 * this id can only be this call's.
 */
function unusedClientOrderId(
  before: ResultRing,
  inFlight: Set<bigint>,
): bigint {
  for (;;) {
    const id = randomClientOrderId();
    const inRing = before.results.some((entry) => entry.clientOrderId === id);
    if (!inRing && !inFlight.has(id)) return id;
  }
}

/**
 * The same promise, with its rejection marked as handled so that a caller who
 * never awaits it does not bring the process down.
 */
function unobserved<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {});
  return promise;
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

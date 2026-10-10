import {
  Connection,
  PublicKey,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  decodeMarket,
  decodeView,
  type MarketParams,
  type OrderResult,
  type View,
} from "./accounts.js";
import { Addresses } from "./addresses.js";
import {
  MAX_EXPIRY_AHEAD,
  MAX_OPEN_ORDERS,
  PROGRAM_ID,
  RESULT_KIND,
} from "./constants.js";
import {
  Instructions,
  type OrderInput,
  type OrderKeyCall,
} from "./instructions.js";
import { subscribe } from "./internal/accountSubscription.js";
import { failureOf, never, sleep, unobserved } from "./internal/async.js";
import {
  BLOCKHASH_REFRESH_MS,
  BlockhashCache,
} from "./internal/blockhashes.js";
import { KeyedTransaction } from "./internal/keyedTransaction.js";
import { refusalOnPublicSettings } from "./internal/marketRules.js";
import { PROGRAM_ERROR } from "./internal/programErrors.js";
import { RollupClock } from "./internal/rollupClock.js";
import type { Unsubscribe } from "./marketReader.js";
import { OrderKeyManager, type OrderKeyUse } from "./orderKeys.js";
import {
  OrderInvalid,
  OutcomeUnknown,
  TransactionFailed,
  type Placed,
  type Settled,
  type Timing,
} from "./outcomes.js";
import { randomSecret } from "./receipts.js";
import { randomClientOrderId, writtenSince } from "./resultRing.js";
import {
  ViewFeed,
  globalSocket,
  inBackground,
  type SocketFactory,
} from "./viewFeed.js";

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

export type TraderClientOptions = {
  /**
   * Learn results from a websocket subscription to the trader's own view,
   * reading the view only when the subscription is down or silent. On by
   * default; `false` reads the view for every result.
   */
  push?: boolean;
  /** Opens the websocket. The runtime's own `WebSocket` by default. */
  socket?: SocketFactory;
};

const DEFAULT_EXPIRY_SECONDS = 5;

type Waits = {
  pollMs: number;
  resendMs: number;
  statusCheckMs: number;
  pushWaitMs: number;
};

const ORDER_WAITS: Waits = {
  pollMs: 50,
  resendMs: 1_000,
  statusCheckMs: 400,
  pushWaitMs: 500,
};

const UNREPEATED_CALL_WAITS: Waits = { ...ORDER_WAITS, resendMs: Infinity };

/** Seconds the rollup's clock must be past an expiry before it is relied on. */
const EXPIRY_MARGIN_SECONDS = 2;
/** Seconds past its expiry, by the caller's clock, after which a call is no longer waited for. */
const GIVE_UP_AFTER_EXPIRY_SECONDS = 1;
/** Seconds an expiry stays short of the furthest the program accepts, for an estimated clock. */
const CLOCK_MARGIN_SECONDS = 2;
const CLOCK_MEASURED_EVERY_MS = 300_000;
const QUARANTINE_POLL_MS = 250;
const READY_WAIT_MS = 5_000;
/** Tick never changes, and a stale minimum only delays its refusal by this long. */
const MARKET_SETTINGS_FRESH_FOR_MS = 30_000;

const EXPIRY_REFUSALS: number[] = [
  PROGRAM_ERROR.expired,
  PROGRAM_ERROR.expiryTooFar,
];

const refusedForItsExpiry = (error: unknown) =>
  error instanceof TransactionFailed &&
  error.code !== null &&
  EXPIRY_REFUSALS.includes(error.code);

type BuildInstruction = (
  use: OrderKeyUse,
  clientOrderId: bigint,
  expiresAt: bigint,
) => TransactionInstruction;

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

type Sending = {
  sentAt: number;
  sent: Promise<string>;
  resend: () => Promise<string>;
  nextView: (wakeAt: number) => Promise<View | undefined>;
};

/**
 * A random client order id that no call in flight carries and that has no
 * result in the ring of the view as it was before the call, so a result with
 * this id can only be this call's.
 */
function unusedClientOrderId(
  before: Pick<View, "results">,
  inFlight: Set<bigint>,
): bigint {
  for (;;) {
    const id = randomClientOrderId();
    const inRing = before.results.some((entry) => entry.clientOrderId === id);
    if (!inRing && !inFlight.has(id)) return id;
  }
}

/** The result of a call that was given up on, or null once it can no longer run. */
function settledLate(
  late: Promise<Late>,
  sentAt: number,
): Promise<(OrderResult & Timing) | null> {
  return unobserved(
    late.then(({ result, resultAt }) =>
      result ? { ...result, sentAt, resultAt } : null,
    ),
  );
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
  private readonly clock: RollupClock;
  private readonly inFlight = new Set<bigint>();
  private readonly markets = new Map<
    number,
    { readAt: number; params: MarketParams }
  >();
  private upkeep?: ReturnType<typeof setInterval>;

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
    this.clock = new RollupClock(connection);
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
        if (this.clock.olderThan(CLOCK_MEASURED_EVERY_MS)) {
          void this.clock.read().catch(() => {});
        }
      }, BLOCKHASH_REFRESH_MS),
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
      this.clock.read(),
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

  async view(): Promise<View> {
    const account = await this.reader.getAccountInfo(
      this.addresses.view(this.owner),
    );
    if (!account) {
      throw new Error(
        "the view is not readable by this connection: read through a private connection signed in as the owner",
      );
    }
    return decodeView(account.data);
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
    const { watched, confirmation } = await this.keyedCall(
      RESULT_KIND.place,
      options.expirySeconds ?? DEFAULT_EXPIRY_SECONDS,
      {
        pollMs: options.pollMs ?? ORDER_WAITS.pollMs,
        resendMs: options.resendMs ?? ORDER_WAITS.resendMs,
        statusCheckMs: options.statusCheckMs ?? ORDER_WAITS.statusCheckMs,
        pushWaitMs: options.pushWaitMs ?? ORDER_WAITS.pushWaitMs,
      },
      (use, clientOrderId, expiresAt) =>
        this.instructions.placeOrder(
          this.keyCall(
            use,
            marketId,
            clientOrderId,
            expiresAt,
            options.riskMarkets,
          ),
          { ...order, secret, expiry: order.expiry ?? 0n },
        ),
      options.now,
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

  async cancelOrder(
    marketId: number,
    orderSeq: bigint,
    expirySeconds?: number,
  ): Promise<OrderResult & Timing> {
    return this.sendKeyed(
      RESULT_KIND.cancel,
      (use, clientOrderId, expiresAt) =>
        this.instructions.cancelOrder(
          this.keyCall(use, marketId, clientOrderId, expiresAt),
          orderSeq,
        ),
      expirySeconds,
    );
  }

  async cancelAll(
    marketId: number,
    maxCancels: number = MAX_OPEN_ORDERS,
    expirySeconds?: number,
  ): Promise<OrderResult & Timing> {
    return this.sendKeyed(
      RESULT_KIND.cancelAll,
      (use, clientOrderId, expiresAt) =>
        this.instructions.cancelAll(
          this.keyCall(use, marketId, clientOrderId, expiresAt),
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
  ): Promise<OrderResult & Timing> {
    return this.sendKeyed(
      RESULT_KIND.transfer,
      (use, clientOrderId, expiresAt) =>
        this.instructions.transferBetweenBalances(
          this.keyCall(use, 0, clientOrderId, expiresAt, riskMarkets),
          toCollateral,
          spotToken,
          amount,
        ),
      expirySeconds,
    );
  }

  async syncView(
    marketId: number,
    expirySeconds?: number,
  ): Promise<OrderResult & Timing> {
    return this.sendKeyed(
      RESULT_KIND.sync,
      (use, clientOrderId, expiresAt) =>
        this.instructions.syncView(
          this.keyCall(use, marketId, clientOrderId, expiresAt),
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
  ): Promise<OrderResult & Timing> {
    return this.sendKeyed(
      RESULT_KIND.liquidate,
      (use, clientOrderId, expiresAt) =>
        this.instructions.liquidate(
          this.keyCall(use, marketId, clientOrderId, expiresAt, riskMarkets),
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

  private keyCall(
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

  /** Throws `OutcomeUnknown` when the client stops waiting before the outcome is certain. */
  private async sendKeyed(
    kind: number,
    build: BuildInstruction,
    expirySeconds = DEFAULT_EXPIRY_SECONDS,
  ): Promise<OrderResult & Timing> {
    const { watched, confirmation } = await this.keyedCall(
      kind,
      expirySeconds,
      UNREPEATED_CALL_WAITS,
      build,
    );
    const { sentAt } = confirmation;
    if ("late" in confirmation) {
      throw new OutcomeUnknown(
        watched.clientOrderId,
        settledLate(confirmation.late, sentAt),
      );
    }
    return { ...confirmation.result, sentAt, resultAt: confirmation.resultAt };
  }

  /** One order-key instruction, from lending its key to its confirmation. */
  private keyedCall(
    kind: number,
    expirySeconds: number,
    waits: Waits,
    build: BuildInstruction,
    now?: () => number,
  ): Promise<{ watched: Watched; confirmation: Confirmation }> {
    return this.onRollupTime(now, expirySeconds, async (clock, within) => {
      const before = await this.watermark();
      const expiresAt = clock() + within;
      const watched = this.begin(before, kind, expiresAt);
      const confirmation = await this.confirmed(watched, clock, waits, () =>
        build(watched.use, watched.clientOrderId, BigInt(expiresAt)),
      );
      return { watched, confirmation };
    });
  }

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
    if (!this.clock.measured) await this.clock.read();
    try {
      return await attempt(this.clock.estimate, within);
    } catch (error) {
      if (!refusedForItsExpiry(error)) throw error;
      await this.clock.read();
      return attempt(this.clock.estimate, within);
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

  /**
   * Refuses, before anything is signed, an order the program would refuse on
   * the market's public settings alone: off the tick, below the minimum size
   * or below the minimum notional.
   */
  private async checkAgainstMarket(
    marketId: number,
    order: Pick<OrderInput, "price" | "size">,
  ): Promise<void> {
    const reason = refusalOnPublicSettings(
      await this.marketParams(marketId),
      order,
    );
    if (reason) throw new OrderInvalid(reason);
  }

  private async marketParams(marketId: number): Promise<MarketParams> {
    const known = this.markets.get(marketId);
    if (known && Date.now() - known.readAt <= MARKET_SETTINGS_FRESH_FOR_MS) {
      return known.params;
    }
    const account = await this.connection.getAccountInfo(
      this.addresses.market(marketId),
    );
    if (!account) throw new Error(`market ${marketId} does not exist`);
    const params = decodeMarket(account.data).params;
    this.markets.set(marketId, { readAt: Date.now(), params });
    return params;
  }

  /**
   * Signs and sends one order-key transaction and waits for its result in
   * the view. With a live subscription the send's own answer is not waited
   * for: the result can be pushed before it, and a send that fails still ends
   * the wait.
   *
   * The device's clock only decides when to stop waiting. A call given up on,
   * or one whose reads failed after it was sent, may still run: it comes back
   * as `late`, or is thrown as `OutcomeUnknown`, and stays in quarantine.
   */
  private async confirmed(
    watched: Watched,
    now: () => number,
    waits: Waits,
    instruction: () => TransactionInstruction,
  ): Promise<Confirmation> {
    let transaction: KeyedTransaction;
    try {
      transaction = await KeyedTransaction.signedWith(
        this.connection,
        this.blockhashes,
        instruction(),
        watched.use.keypair,
      );
    } catch (error) {
      this.end(watched);
      throw error;
    }
    const sentAt = performance.now();
    const nextView = this.observer(sentAt, waits);
    const sent = unobserved(transaction.send());
    try {
      if (!this.feed?.live) await sent;
      return await this.resultOrGivenUp(watched, now, waits, {
        sentAt,
        sent,
        resend: () => transaction.resend(),
        nextView,
      });
    } catch (error) {
      if (error instanceof TransactionFailed) {
        this.end(watched);
        throw error;
      }
      throw new OutcomeUnknown(
        watched.clientOrderId,
        settledLate(this.quarantined(watched), sentAt),
        error,
      );
    }
  }

  /**
   * Searches each state of the view for the call's result, sending the same
   * bytes again every `resendMs` until the expiry. A transaction that landed
   * and failed writes no result, so its status is asked for once after
   * `statusCheckMs` without a result, and once more when the call is given
   * up on; a failure found there is thrown as `TransactionFailed` instead of
   * being waited out.
   */
  private async resultOrGivenUp(
    watched: Watched,
    now: () => number,
    waits: Waits,
    { sentAt, sent, resend, nextView }: Sending,
  ): Promise<Confirmation> {
    const { before, clientOrderId, kind, expiresAt } = watched;
    const sendFailed = failureOf(sent);
    let lastSent = Date.now();
    let statusChecked = false;
    let statusFailed = never();
    for (;;) {
      if (now() <= expiresAt && Date.now() - lastSent >= waits.resendMs) {
        void resend().catch(() => {});
        lastSent = Date.now();
      }
      const gaveUp = now() > expiresAt + GIVE_UP_AFTER_EXPIRY_SECONDS;
      const view = await Promise.race([
        nextView(statusChecked ? Infinity : sentAt + waits.statusCheckMs),
        sendFailed,
        statusFailed,
      ]);
      const result = view && writtenSince(before, view, clientOrderId, kind);
      if (view && result) {
        this.end(watched, view);
        return { result, view, sentAt, resultAt: performance.now() };
      }
      if (gaveUp) {
        await this.refusedIfFailed(sent);
        return { sentAt, late: this.quarantined(watched) };
      }
      if (!statusChecked && performance.now() - sentAt >= waits.statusCheckMs) {
        statusChecked = true;
        statusFailed = failureOf(this.refusedIfFailed(sent));
      }
    }
  }

  private async refusedIfFailed(sent: Promise<string>): Promise<void> {
    const signature = await sent;
    const status = await this.connection.getSignatureStatus(signature);
    if (status.value?.err) {
      throw new TransactionFailed(signature, status.value.err);
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
    waits: Pick<Waits, "pollMs" | "pushWaitMs">,
  ): Sending["nextView"] {
    const feed = this.feed;
    const pushUntil = sentAt + waits.pushWaitMs;
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
        await (feed ? feed.changed(seen, waits.pollMs) : sleep(waits.pollMs));
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
   * past its expiry by a margin, after which the program refuses it. While
   * either cannot be read the key stays out, which is the safe side.
   */
  private async quarantined(watched: Watched): Promise<Late> {
    const { before, clientOrderId, kind, expiresAt } = watched;
    for (;;) {
      const read = await this.viewOnceClockIsRead(expiresAt).catch(() => null);
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

  /**
   * The clock is read before the view, so a view read once the clock is past
   * the expiry already holds whatever the instruction did.
   */
  private async viewOnceClockIsRead(
    expiresAt: number,
  ): Promise<{ closed: boolean; view: View }> {
    const closed =
      (await this.clock.read()) > expiresAt + EXPIRY_MARGIN_SECONDS;
    return { closed, view: await this.view() };
  }
}

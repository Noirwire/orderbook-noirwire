import {
  Connection,
  PublicKey,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  decodeExchange,
  decodeMarket,
  decodeView,
  type MarketParams,
  type OrderResult,
  type View,
} from "./accounts.js";
import {
  Addresses,
  associatedTokenAddress,
  type CustodyToken,
} from "./addresses.js";
import {
  MAX_EXPIRY_AHEAD,
  MAX_MARKETS,
  MAX_OPEN_ORDERS,
  PROGRAM_ID,
  RESULT_KIND,
} from "./constants.js";
import {
  Instructions,
  type AssetKind,
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
  WithdrawalUnknown,
  type Placed,
  type Settled,
  type Timing,
  type Withdrawn,
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
/** A perp market created after the exchange was read is missing from calls for at most this long. */
const PERP_MARKETS_FRESH_FOR_MS = 30_000;

const EXPIRY_REFUSALS: number[] = [
  PROGRAM_ERROR.expired,
  PROGRAM_ERROR.expiryTooFar,
];

const refusedForItsExpiry = (error: unknown) =>
  error instanceof TransactionFailed &&
  error.code !== null &&
  EXPIRY_REFUSALS.includes(error.code);

type BuildInstructions = (
  use: OrderKeyUse,
  clientOrderId: bigint,
  expiresAt: bigint,
) => TransactionInstruction[];

/** `kind` is null for a call the program writes no result for: its key swap is the evidence. */
type Watched = {
  use: OrderKeyUse;
  before: View;
  clientOrderId: bigint;
  kind: number | null;
  expiresAt: number;
};

/** `ran` is true when the instruction ran, whether or not it wrote a result. */
type Late = {
  result?: OrderResult;
  ran: boolean;
  view: View;
  resultAt: number;
};

type Confirmation = { sentAt: number } & (
  | { result?: OrderResult; view: View; resultAt: number }
  | { late: Promise<Late> }
);

/** What a view shows of a call that ran: its result, or only its key swap. */
function ranAccordingTo(
  { use, before, clientOrderId, kind }: Watched,
  view: View,
): { result?: OrderResult } | undefined {
  if (kind === null) {
    return view.orderKeys[use.slot].equals(use.replacement.publicKey)
      ? {}
      : undefined;
  }
  const result = writtenSince(before, view, clientOrderId, kind);
  return result && { result };
}

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

/** The withdrawal by order key that was given up on, or null once it can no longer run. */
function settledWithdrawal(
  late: Promise<Late>,
  sentAt: number,
): Promise<Withdrawn | null> {
  return unobserved(
    late.then(({ ran, view, resultAt }) =>
      ran ? { view, sentAt, resultAt } : null,
    ),
  );
}

/** The error for a call the client stopped waiting for while it could still run. */
function unsettled(
  { kind, clientOrderId }: Watched,
  late: Promise<Late>,
  sentAt: number,
  cause?: unknown,
): OutcomeUnknown | WithdrawalUnknown {
  return kind === null
    ? new WithdrawalUnknown(settledWithdrawal(late, sentAt), cause)
    : new OutcomeUnknown(clientOrderId, settledLate(late, sentAt), cause);
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
  private perpMarketsRead?: { readAt: number; ids: number[] };
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
    const riskMarkets = await this.perpMarkets();
    const { watched, confirmation } = await this.keyedCall(
      RESULT_KIND.place,
      options.expirySeconds ?? DEFAULT_EXPIRY_SECONDS,
      {
        pollMs: options.pollMs ?? ORDER_WAITS.pollMs,
        resendMs: options.resendMs ?? ORDER_WAITS.resendMs,
        statusCheckMs: options.statusCheckMs ?? ORDER_WAITS.statusCheckMs,
        pushWaitMs: options.pushWaitMs ?? ORDER_WAITS.pushWaitMs,
      },
      (use, clientOrderId, expiresAt) => [
        this.instructions.placeOrder(
          this.keyCall(use, marketId, clientOrderId, expiresAt, riskMarkets),
          { ...order, secret, expiry: order.expiry ?? 0n },
        ),
      ],
      options.now,
    );
    const { clientOrderId } = watched;
    const { sentAt } = confirmation;
    const settled = ({
      result,
      view,
      resultAt,
    }: Pick<Late, "result" | "view" | "resultAt">): Settled =>
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
    return this.keyed(
      RESULT_KIND.cancel,
      marketId,
      (call) => this.instructions.cancelOrder(call, orderSeq),
      false,
      expirySeconds,
    );
  }

  /**
   * Sent with `extend_compute`, for 400,000 units: the program scans both
   * sides of the book, whose cost grows with how full it is.
   */
  async cancelAll(
    marketId: number,
    maxCancels: number = MAX_OPEN_ORDERS,
    expirySeconds?: number,
  ): Promise<OrderResult & Timing> {
    return this.keyed(
      RESULT_KIND.cancelAll,
      marketId,
      (call) => this.instructions.cancelAll(call, maxCancels),
      true,
      expirySeconds,
    );
  }

  /**
   * Moves collateral-token value between the perpetuals collateral and the
   * spot balance of the same mint, no tokens moving. It names the lowest perp
   * market, or market 0 on an exchange with none, as every order-key call
   * names a market.
   */
  async transferBetweenBalances(
    toCollateral: boolean,
    spotToken: number,
    amount: bigint,
    expirySeconds?: number,
  ): Promise<OrderResult & Timing> {
    return this.keyed(
      RESULT_KIND.transfer,
      ([first = 0]) => first,
      (call) =>
        this.instructions.transferBetweenBalances(
          call,
          toCollateral,
          spotToken,
          amount,
        ),
      false,
      expirySeconds,
    );
  }

  /**
   * RULES 3.0: withdraws `amount` of the seat's collateral, or of the spot
   * balance `asset` names, to the owner's associated token account for
   * `token`'s mint, signed by a live order key and replacing it. The program
   * writes no result in the view for it, so the evidence a withdrawal ran is
   * its key swap: the slot the key was lent from holds its replacement, and
   * the seat's balances in that view are the ones after the withdrawal.
   *
   * A refusal throws `TransactionFailed`, with nothing changed and the key
   * still live. A withdrawal sent but not seen throws `WithdrawalUnknown`,
   * whose `settled` resolves to it once the view shows the swap, or to null
   * once the rollup's clock is past its expiry and the key is still in its
   * slot. A key swap that the owner's own `set_order_keys` replaced before
   * the client read it cannot be told from a withdrawal that never ran: read
   * the owner's token account in the rollup to tell them apart.
   */
  async withdrawByKey(
    token: CustodyToken,
    asset: AssetKind,
    amount: bigint,
    expirySeconds?: number,
  ): Promise<Withdrawn> {
    const to = associatedTokenAddress(this.owner, token.mint);
    const perp = await this.perpMarkets();
    const { watched, confirmation } = await this.keyedCall(
      null,
      expirySeconds ?? DEFAULT_EXPIRY_SECONDS,
      UNREPEATED_CALL_WAITS,
      (use, _clientOrderId, expiresAt) => [
        this.instructions.withdrawByKey(
          use.keypair.publicKey,
          this.owner,
          use.replacement.publicKey,
          expiresAt,
          to,
          token,
          asset,
          amount,
          perp,
        ),
      ],
    );
    const { sentAt } = confirmation;
    if ("late" in confirmation) {
      throw unsettled(watched, confirmation.late, sentAt);
    }
    return { view: confirmation.view, sentAt, resultAt: confirmation.resultAt };
  }

  async syncView(
    marketId: number,
    expirySeconds?: number,
  ): Promise<OrderResult & Timing> {
    return this.keyed(
      RESULT_KIND.sync,
      marketId,
      (call) => this.instructions.syncView(call),
      false,
      expirySeconds,
    );
  }

  /**
   * RULES 8: tried blind against seat `target`. `worstPrice` is the worst
   * liquidation price accepted: the highest when buying a long target's
   * position, the lowest when selling into a short one's. Sent with
   * `extend_compute`, for 400,000 units, since a liquidation that happens
   * scans both sides of the book.
   */
  async liquidate(
    marketId: number,
    target: number,
    size: bigint,
    worstPrice: bigint,
    expirySeconds?: number,
  ): Promise<OrderResult & Timing> {
    return this.keyed(
      RESULT_KIND.liquidate,
      marketId,
      (call) => this.instructions.liquidate(call, target, size, worstPrice),
      true,
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

  /**
   * One order-key instruction other than an order, naming every perp market
   * the exchange has and the market `marketId` gives, or picks from them; with
   * `extend`, followed by `extend_compute`.
   */
  private async keyed(
    kind: number,
    marketId: number | ((perp: number[]) => number),
    build: (call: OrderKeyCall) => TransactionInstruction,
    extend: boolean,
    expirySeconds?: number,
  ): Promise<OrderResult & Timing> {
    const perp = await this.perpMarkets();
    const market = typeof marketId === "function" ? marketId(perp) : marketId;
    return this.sendKeyed(
      kind,
      (use, clientOrderId, expiresAt) => [
        build(this.keyCall(use, market, clientOrderId, expiresAt, perp)),
        ...(extend ? [this.instructions.extendCompute()] : []),
      ],
      expirySeconds,
    );
  }

  /** Throws `OutcomeUnknown` when the client stops waiting before the outcome is certain. */
  private async sendKeyed(
    kind: number,
    build: BuildInstructions,
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
      throw unsettled(watched, confirmation.late, sentAt);
    }
    if (!confirmation.result) {
      throw new Error(`call ${watched.clientOrderId} ran without a result`);
    }
    return { ...confirmation.result, sentAt, resultAt: confirmation.resultAt };
  }

  /** One order-key instruction, from lending its key to its confirmation. */
  private keyedCall(
    kind: number | null,
    expirySeconds: number,
    waits: Waits,
    build: BuildInstructions,
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
  private begin(before: View, kind: number | null, expiresAt: number): Watched {
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
   * Every perp market the exchange has, which every order-key call names,
   * so that the public accounts a call names do not tell what kind it is.
   */
  private async perpMarkets(): Promise<number[]> {
    const known = this.perpMarketsRead;
    if (known && Date.now() - known.readAt <= PERP_MARKETS_FRESH_FOR_MS) {
      return known.ids;
    }
    const account = await this.connection.getAccountInfo(
      this.addresses.exchange,
    );
    if (!account) throw new Error("the exchange does not exist");
    const { perpMarkets } = decodeExchange(account.data);
    const ids = Array.from({ length: MAX_MARKETS }, (_, id) => id).filter(
      (id) => (perpMarkets >> id) & 1,
    );
    this.perpMarketsRead = { readAt: Date.now(), ids };
    return ids;
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
    instructions: () => TransactionInstruction[],
  ): Promise<Confirmation> {
    let transaction: KeyedTransaction;
    try {
      transaction = await KeyedTransaction.signedWith(
        this.connection,
        this.blockhashes,
        instructions(),
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
      throw unsettled(watched, this.quarantined(watched), sentAt, error);
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
    const { expiresAt } = watched;
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
      const ran = view && ranAccordingTo(watched, view);
      if (view && ran) {
        this.end(watched, view);
        return { ...ran, view, sentAt, resultAt: performance.now() };
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
    const { clientOrderId, kind, expiresAt } = watched;
    for (;;) {
      const read = await this.viewOnceClockIsRead(expiresAt).catch(() => null);
      const found = read && ranAccordingTo(watched, read.view);
      if (read && (found || read.closed)) {
        const ran = this.end(watched, read.view);
        if (ran && !found) {
          throw new Error(
            `call ${clientOrderId} ran, but its ${kind === null ? "key swap" : "result"} has left the view`,
          );
        }
        return {
          result: found?.result,
          ran,
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

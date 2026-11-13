/**
 * What the crank holds in memory instead of reading every round: the
 * accounts it decides from, kept current by websocket notifications, the
 * rollup's clock, and the wake-up that starts a round. Every account is
 * subscribed the first time it is asked for, and read by hand only at the
 * start, once in a while to check the socket, and, while the socket is silent
 * or has missed a change, once a second.
 */
import type { AccountInfo, Connection, PublicKey } from "@solana/web3.js";
import { at } from "./heartbeat";

/** The reads the watch makes by hand. */
export type Reads = Pick<Connection, "getMultipleAccountsInfoAndContext">;
/** The subscriptions it holds. */
export type Socket = Pick<
  Connection,
  "onAccountChange" | "removeAccountChangeListener"
>;

/**
 * A busy account (MagicBlock's price account publishes about ten times a
 * second) that says nothing for this long means the socket is down, or the
 * oracle is: a read tells which.
 */
export const SILENT_AFTER_MS = 2_000;
/** While the socket is silent or has missed a change, every account is read this often. */
export const FALLBACK_EVERY_MS = 1_000;
/** With a healthy socket, every account is read once this often and compared with what the socket said. */
export const AUDIT_EVERY_MS = 10_000;
/** A change a read shows that the socket has not delivered within this long is a socket that missed it. */
export const FAULT_AFTER_MS = 1_500;
/** A socket that misses changes is subscribed again after this, then at doubling intervals up to the longest. */
const RESUBSCRIBE_AFTER_MS = 3_000;
const RESUBSCRIBE_LONGEST_MS = 30_000;

/** What the rollup said an account held, and at which slot. `data` is null for an account that does not exist. */
type Copy = { data: Buffer | null; slot: number };

type Entry = {
  address: PublicKey;
  subscription: number | null;
  socket?: Copy;
  socketAtMs: number;
  rpc?: Copy;
  /** When a read last showed this account holding something newer than the held copy, until the socket speaks for it. */
  changedAtMs: number | null;
  busy: boolean;
  loading?: Promise<void>;
};

const same = (a: Buffer | null, b: Buffer | null) =>
  a === b || (a !== null && b !== null && a.equals(b));

/** How the socket is doing, as the watch can tell. */
export type SocketState = {
  /** A busy account has been silent for too long. */
  silent: boolean;
  /** What a read showed that the socket never delivered, or null. */
  fault: string | null;
};

export class AccountWatch {
  private readonly entries = new Map<string, Entry>();
  private lastBusyAtMs = 0;
  private lastReadAtMs: number;
  private failure: Error | null = null;
  private announced: "socket" | "silent" | "fault" = "socket";
  private faultSinceMs: number | null = null;
  private resubscribeAtMs = 0;
  private resubscribeEveryMs = RESUBSCRIBE_AFTER_MS;
  /** Called whenever an account may have changed: the crank starts a round. */
  onChange: () => void = () => {};

  constructor(
    private readonly socket: Socket,
    private readonly reads: Reads,
    private readonly now: () => number,
    private readonly say: (line: string) => void = console.log,
  ) {
    this.lastReadAtMs = now();
  }

  /** The account as last heard or read, subscribing to it and reading it once the first time it is asked for. */
  async get(
    address: PublicKey,
  ): Promise<Pick<AccountInfo<Buffer>, "data"> | null> {
    const entry = this.entryFor(address);
    await entry.loading;
    const held = this.held(entry);
    return held?.data ? { data: held.data } : null;
  }

  /** Reads `addresses` by hand now and holds what comes back: after a send, which changed them, ahead of the notification. */
  async fresh(addresses: PublicKey[]): Promise<void> {
    const entries = addresses.map((address) => this.entryFor(address));
    await Promise.all(entries.map(({ loading }) => loading));
    await this.read(entries);
  }

  /** Says that `address` is published often, so its silence is the socket's. */
  markBusy(address: PublicKey): void {
    const entry = this.entryFor(address);
    if (!entry.busy && ![...this.entries.values()].some(({ busy }) => busy)) {
      this.lastBusyAtMs = this.now();
    }
    entry.busy = true;
  }

  /** Whether the socket is silent or has missed a change. */
  state(): SocketState {
    const now = this.now();
    const busy = [...this.entries.values()].some((entry) => entry.busy);
    const missed = [...this.entries.values()].find(
      (entry) =>
        entry.changedAtMs !== null &&
        entry.socketAtMs < entry.changedAtMs &&
        now - entry.changedAtMs >= FAULT_AFTER_MS,
    );
    return {
      silent: busy && now - this.lastBusyAtMs > SILENT_AFTER_MS,
      fault: missed
        ? `the websocket delivered nothing for ${missed.address.toBase58()} for ${Math.round((now - (missed.changedAtMs ?? now)) / 1_000)} s while reads show it changing`
        : null,
    };
  }

  /**
   * Called each round: says when the socket goes quiet or comes back, reads
   * every account by hand when that is due (once a second while the socket
   * is not to be trusted, every `AUDIT_EVERY_MS` otherwise), and subscribes
   * again, with a longer wait each time, to a socket that has missed a change.
   * A read that fails is thrown on every call until one works.
   */
  async maintain(): Promise<SocketState> {
    const now = this.now();
    const state = this.state();
    this.announce(state);
    const trusting = !state.silent && state.fault === null;
    const every = trusting ? AUDIT_EVERY_MS : FALLBACK_EVERY_MS;
    if (this.entries.size > 0 && now - this.lastReadAtMs >= every) {
      await this.read([...this.entries.values()]).catch((error: Error) => {
        this.failure = error;
      });
    }
    this.resubscribeWhenMissing(state.fault !== null, now);
    if (this.failure) throw this.failure;
    return state;
  }

  close(): void {
    for (const entry of this.entries.values()) this.unsubscribe(entry);
  }

  private entryFor(address: PublicKey): Entry {
    const key = address.toBase58();
    const held = this.entries.get(key);
    if (held) return held;
    const entry: Entry = {
      address,
      subscription: null,
      socketAtMs: -Infinity,
      changedAtMs: null,
      busy: false,
    };
    this.entries.set(key, entry);
    this.subscribe(entry);
    entry.loading = this.read([entry]).then(
      () => {
        entry.loading = undefined;
      },
      (error: Error) => {
        this.entries.delete(key);
        this.unsubscribe(entry);
        throw error;
      },
    );
    return entry;
  }

  private subscribe(entry: Entry): void {
    entry.subscription = this.socket.onAccountChange(
      entry.address,
      (info, context) => this.heard(entry, info.data, context.slot),
      "confirmed",
    );
  }

  private unsubscribe(entry: Entry): void {
    if (entry.subscription === null) return;
    void Promise.resolve(
      this.socket.removeAccountChangeListener(entry.subscription),
    ).catch(() => {});
    entry.subscription = null;
  }

  /** The newer of what the socket and the last read said. */
  private held(entry: Entry): Copy | undefined {
    const { socket, rpc } = entry;
    if (socket && rpc) return rpc.slot > socket.slot ? rpc : socket;
    return socket ?? rpc;
  }

  private heard(entry: Entry, data: Buffer, slot: number): void {
    const now = this.now();
    entry.socketAtMs = now;
    if (entry.busy) this.lastBusyAtMs = now;
    if (!entry.socket || slot >= entry.socket.slot) {
      entry.socket = { data, slot };
    }
    this.onChange();
  }

  private async read(entries: Entry[]): Promise<void> {
    this.lastReadAtMs = this.now();
    const { context, value } =
      await this.reads.getMultipleAccountsInfoAndContext(
        entries.map(({ address }) => address),
      );
    const now = this.now();
    this.failure = null;
    entries.forEach((entry, nth) => {
      const data = value[nth]?.data ?? null;
      const held = this.held(entry);
      entry.rpc = { data, slot: context.slot };
      if (held && context.slot > held.slot && !same(held.data, data)) {
        entry.changedAtMs = now;
        this.onChange();
      }
    });
  }

  private announce(state: SocketState): void {
    const mode = state.fault ? "fault" : state.silent ? "silent" : "socket";
    if (mode === this.announced) return;
    this.announced = mode;
    if (mode === "socket") {
      this.say(
        `${at()} rollup websocket speaks again: reading by hand stops, except a check every ${AUDIT_EVERY_MS / 1_000} s`,
      );
    } else if (mode === "silent") {
      this.say(
        `${at()} rollup websocket silent for over ${SILENT_AFTER_MS / 1_000} s: reading the accounts every ${FALLBACK_EVERY_MS / 1_000} s until it speaks`,
      );
    } else {
      this.say(
        `${at()} rollup websocket fault: ${state.fault}. Reading the accounts every ${FALLBACK_EVERY_MS / 1_000} s and subscribing again`,
      );
    }
  }

  private resubscribeWhenMissing(faulty: boolean, now: number): void {
    if (!faulty) {
      this.faultSinceMs = null;
      this.resubscribeEveryMs = RESUBSCRIBE_AFTER_MS;
      this.resubscribeAtMs = 0;
      return;
    }
    this.faultSinceMs ??= now;
    if (this.resubscribeAtMs === 0) {
      this.resubscribeAtMs = this.faultSinceMs + RESUBSCRIBE_AFTER_MS;
    }
    if (now < this.resubscribeAtMs) return;
    this.say(`${at()} subscribing to the rollup's accounts again`);
    for (const entry of this.entries.values()) {
      this.unsubscribe(entry);
      this.subscribe(entry);
    }
    this.resubscribeEveryMs = Math.min(
      this.resubscribeEveryMs * 2,
      RESUBSCRIBE_LONGEST_MS,
    );
    this.resubscribeAtMs = now + this.resubscribeEveryMs;
  }
}

/** How often the rollup's clock is read by hand; between reads it is counted forward. */
export const CLOCK_RESYNC_MS = 30_000;

/**
 * The rollup's unix time, read once and counted forward on the local
 * monotonic clock, read again every `CLOCK_RESYNC_MS`. The Clock sysvar
 * changes every slot, which a subscription would deliver about twenty times a
 * second, and a slot subscription carries no time; a count forward drifts
 * by milliseconds in half a minute against ages measured in tens of seconds.
 */
export class RollupClock {
  private anchor: { unix: number; atMs: number } | null = null;

  constructor(
    private readonly readUnix: () => Promise<number>,
    private readonly now: () => number,
  ) {}

  /** Reads the clock when it has never been read, or last was `CLOCK_RESYNC_MS` ago. */
  async ready(): Promise<void> {
    if (this.anchor && this.now() - this.anchor.atMs < CLOCK_RESYNC_MS) return;
    this.anchor = { unix: await this.readUnix(), atMs: this.now() };
  }

  /** The rollup's unix time in whole seconds, as of now. */
  seconds(): number {
    if (!this.anchor) throw new Error("the rollup's clock has not been read");
    return (
      this.anchor.unix + Math.floor((this.now() - this.anchor.atMs) / 1_000)
    );
  }
}

/** What starts a round: a change in an account, or the tick running out. */
export class Wakeup {
  private wake: (() => void) | null = null;
  private pending = false;

  /** Starts the next round; one that comes while a round runs starts the next at once. */
  signal(): void {
    if (this.wake) this.wake();
    else this.pending = true;
  }

  wait(tickMs: number): Promise<"change" | "tick"> {
    if (this.pending) {
      this.pending = false;
      return Promise.resolve("change");
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve("tick");
      }, tickMs);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve("change");
      };
    });
  }
}

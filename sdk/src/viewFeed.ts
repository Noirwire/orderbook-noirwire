import type { Connection, PublicKey } from "@solana/web3.js";
import { decodeView, type View } from "./accounts.js";
import { websocketUrl } from "./auth.js";

/** The part of the standard `WebSocket` the feed uses, so a test can stand in for it. */
export type Socket = {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
};

export type SocketFactory = (url: string) => Socket;

/** The runtime's own `WebSocket`, in a browser and in Node alike, if it has one. */
export function globalSocket(): SocketFactory | undefined {
  const Global = (globalThis as { WebSocket?: new (url: string) => unknown })
    .WebSocket;
  return Global && ((url) => new Global(url) as Socket);
}

const RECONNECT_MS = { first: 250, growth: 2, slowest: 5_000 };
const SUBSCRIBE_ID = 1;
const CAUGHT_UP_WITHIN_MS = 1_000;

type Timer = ReturnType<typeof setTimeout>;

/** Lets a Node process end while the timer is pending; a browser has nothing to do. */
export function inBackground<T extends Timer | ReturnType<typeof setInterval>>(
  timer: T,
): T {
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

type Incoming = {
  id?: number;
  error?: unknown;
  method?: string;
  params?: {
    result?: { context?: { slot?: number }; value?: { data?: [string] } };
  };
};

/**
 * A trader's own view, kept current by an account subscription over a
 * websocket to the endpoint the reader is signed in to. The address of the
 * websocket is taken from the reader at every connection, so it carries the
 * reader's sign-in token, and a renewed reader is picked up by `restart`.
 *
 * `live` says the subscription is established and the view was read once
 * after it was: from then on `latest` misses no write. A socket that closes
 * is opened again, after a wait that doubles up to five seconds, subscribed
 * again and the view read again. While it is not live a caller reads the view
 * itself.
 */
export class ViewFeed {
  latest?: View;
  /** Counts the states `latest` has held. */
  version = 0;
  live = false;
  private slot = -1;
  private socket?: Socket;
  private stopped = true;
  private retryMs = RECONNECT_MS.first;
  private retry?: Timer;
  private waiting = new Set<() => void>();

  constructor(
    private readonly reader: () => Connection,
    private readonly address: PublicKey,
    private readonly open: SocketFactory,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.drop();
  }

  /** Connects afresh: after the reader's token was renewed, or a write was missed. */
  restart(): void {
    if (this.stopped) return;
    this.drop();
    this.connect();
  }

  /**
   * A read showed `view`. A live feed that has still not caught up with it a
   * second later lost a write, and connects afresh; one that is merely slow
   * is left alone.
   */
  overtakenBy(view: View): void {
    const behind = () =>
      this.live && (this.latest?.resultsWritten ?? -1) < view.resultsWritten;
    if (!behind()) return;
    inBackground(
      setTimeout(() => {
        if (behind()) this.restart();
      }, CAUGHT_UP_WITHIN_MS),
    );
  }

  /**
   * Resolves once `latest` is no longer state number `seen`, the feed went
   * live or down, or `withinMs` passed, whichever is first.
   */
  changed(seen: number, withinMs: number): Promise<void> {
    if (this.version !== seen) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiting.delete(done);
        resolve();
      };
      const timer = setTimeout(done, withinMs);
      this.waiting.add(done);
    });
  }

  /** Whether the feed went live within `withinMs`. */
  async established(withinMs: number): Promise<boolean> {
    const deadline = performance.now() + withinMs;
    while (!this.live && performance.now() < deadline) {
      await this.changed(this.version, deadline - performance.now());
    }
    return this.live;
  }

  private wake(): void {
    for (const done of [...this.waiting]) done();
  }

  private drop(): void {
    clearTimeout(this.retry);
    const socket = this.socket;
    this.socket = undefined;
    this.live = false;
    try {
      socket?.close();
    } catch {
      // A socket that never opened may refuse to close; it is abandoned either way.
    }
    this.wake();
  }

  private lost(socket: Socket): void {
    if (this.socket !== socket) return;
    this.drop();
    this.retry = inBackground(setTimeout(() => this.connect(), this.retryMs));
    this.retryMs = Math.min(
      RECONNECT_MS.slowest,
      this.retryMs * RECONNECT_MS.growth,
    );
  }

  private connect(): void {
    if (this.stopped) return;
    const reader = this.reader();
    let socket: Socket;
    try {
      socket = this.open(websocketUrl(reader.rpcEndpoint));
    } catch {
      // No address to derive or no socket to open: the client keeps polling.
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: SUBSCRIBE_ID,
          method: "accountSubscribe",
          params: [
            this.address.toBase58(),
            {
              encoding: "base64",
              commitment: reader.commitment ?? "confirmed",
            },
          ],
        }),
      );
    };
    socket.onmessage = ({ data }) => {
      if (this.socket === socket && typeof data === "string") {
        this.received(socket, data);
      }
    };
    socket.onclose = () => this.lost(socket);
    socket.onerror = () => this.lost(socket);
  }

  private received(socket: Socket, data: string): void {
    let message: Incoming;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (message.id === SUBSCRIBE_ID) {
      if (message.error) this.lost(socket);
      else void this.caughtUp(socket);
      return;
    }
    const result = message.params?.result;
    const encoded = result?.value?.data?.[0];
    if (message.method !== "accountNotification" || !encoded) return;
    this.accept(
      decodeView(Buffer.from(encoded, "base64")),
      result.context?.slot ?? this.slot,
    );
  }

  /**
   * Reads the view once the subscription is confirmed, so a write made while
   * no subscription was in place is not missed.
   */
  private async caughtUp(socket: Socket): Promise<void> {
    try {
      const { context, value } = await this.reader().getAccountInfoAndContext(
        this.address,
      );
      if (this.socket !== socket) return;
      if (!value) throw new Error("the view is not readable");
      this.accept(decodeView(value.data), context.slot);
      this.live = true;
      this.retryMs = RECONNECT_MS.first;
      this.wake();
    } catch {
      this.lost(socket);
    }
  }

  /**
   * A read and a notification can arrive in either order. The later state is
   * the one with more results written, and between two with the same count
   * the one from the later slot.
   */
  private accept(view: View, slot: number): void {
    const held = this.latest;
    const later =
      !held ||
      view.resultsWritten > held.resultsWritten ||
      (view.resultsWritten === held.resultsWritten && slot >= this.slot);
    if (!later) return;
    this.latest = view;
    this.slot = slot;
    this.version += 1;
    this.wake();
  }
}

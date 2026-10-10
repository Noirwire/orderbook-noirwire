import type { OrderResult, View } from "./accounts.js";
import { programErrorCode } from "./internal/programErrors.js";

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
    this.code = programErrorCode(err);
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

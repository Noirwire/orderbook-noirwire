import type { OrderResult, View } from "./accounts.js";
import { SEAT_ERROR } from "./constants.js";
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
 * A withdrawal by order key that went through. The program writes no result for
 * it, so this is the view that first showed the order key swapped, with the
 * seat's balances after the withdrawal in its snapshot.
 */
export type Withdrawn = { view: View } & Timing;

/**
 * A withdrawal by order key whose replacement key is in the view's slot after
 * the owner replaced keys (`View.ownerNonce` moved
 * since the send), so the key may be the owner's and not the withdrawal's. It
 * is neither withdrawn nor not run: read the owner's token account in the
 * rollup to tell. `view` is the view that showed the key.
 */
export type WithdrawalUndetermined = {
  undetermined: true;
  view: View;
} & Timing;

/**
 * A withdrawal by order key the client stopped waiting for while it could
 * still run. `settled` resolves to the withdrawal, to a
 * `WithdrawalUndetermined` when an owner key reset leaves it unprovable, or
 * to null once it can no longer run. Until then its order key is lent to
 * nothing else.
 */
export class WithdrawalUnknown extends Error {
  constructor(
    readonly settled: Promise<Withdrawn | WithdrawalUndetermined | null>,
    cause?: unknown,
  ) {
    super("the outcome of the withdrawal is not known yet", { cause });
    this.name = "WithdrawalUnknown";
  }
}

/**
 * The transaction landed and the program refused it. Nothing changed and the
 * order key that signed it is still live. `err` is the status the network
 * reports; `code` is the program's error number when there is one, 6000 plus
 * the number in the program's error list. A refusal by the market's access
 * lists is one of `ACCESS_ERROR`: the seat is blocked, or not listed as a
 * maker or a taker on that market. Cancels, reduce-only orders, transfers,
 * deposits, withdrawals and closing are never refused that way.
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

/**
 * The program refused a call because the view holds no seat: deposit to take
 * one. `confirmSeat` says whether a view that records a seat still holds it.
 */
export class NotSeated extends TransactionFailed {
  constructor(signature: string, err: unknown) {
    super(signature, err);
    this.name = "NotSeated";
  }
}

/** The error for a transaction that landed and failed: `NotSeated` when that is the program's reason. */
export function transactionFailure(
  signature: string,
  err: unknown,
): TransactionFailed {
  const failed = new TransactionFailed(signature, err);
  return failed.code === SEAT_ERROR.notSeated
    ? new NotSeated(signature, err)
    : failed;
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

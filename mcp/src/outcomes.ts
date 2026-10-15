import {
  OrderInvalid,
  OutcomeUnknown,
  RESULT_STATUS,
  TransactionFailed,
  type OrderResult,
  type Settled,
} from "@noirwire/orderbook";
import { UnsafeDeployment } from "./network.js";
import {
  InvalidInput,
  averagePrice,
  lotsToSize,
  quoteToDecimal,
  type MarketUnits,
} from "./units.js";

/** The message of `OrderKeyManager.take()` when every one of the four keys is lent out. */
const ALL_KEYS_BUSY = "every order key is in use";

/** How the client's message for a trader whose account is not open begins. */
const NO_VIEW = "the view is not readable by this connection";

/** The program's error number for a mark price older than it accepts. */
const STALE_PRICE_CODE = 38;

export type PlacedReport = {
  status:
    | "filled"
    | "rested"
    | "partially_filled_and_rested"
    | "partially_filled_remainder_cancelled"
    | "remainder_cancelled"
    | "refused_post_only_would_match"
    | "refused"
    | "expired";
  /** The number to pass to cancel_order; present only while part of the order rests. */
  orderId: string | null;
  filledSize: string;
  restedSize: string;
  cancelledSize: string;
  averagePrice: string | null;
  fee: string;
  message: string;
};

function remainderReason(status: number): string {
  switch (status) {
    case RESULT_STATUS.remainderCancelledStepLimit:
      return "The remainder was cancelled: the order crossed the per-order fill limit.";
    case RESULT_STATUS.remainderCancelledBookFull:
      return "The remainder was cancelled: that side of the book is full.";
    case RESULT_STATUS.remainderCancelledFillCheck:
      return "The remainder was cancelled: it failed the margin check at that price.";
    default:
      return "The remainder did not match and was cancelled instead of resting.";
  }
}

function refusedReason(code: number): string {
  return code === STALE_PRICE_CODE
    ? "Refused: the market's mark price is too old to accept new orders right now. Wait for a fresh price and try again."
    : `Refused by the program (code ${code}). Nothing filled.`;
}

/** What the program recorded for a placed order, in plain words. */
export function describePlaced(
  result: OrderResult,
  units: MarketUnits,
): PlacedReport {
  const filledAny = result.filled > 0n;
  const base = {
    orderId: result.rested > 0n ? result.orderSeq.toString() : null,
    filledSize: lotsToSize(units, result.filled),
    restedSize: lotsToSize(units, result.rested),
    cancelledSize: lotsToSize(units, result.cancelled),
    averagePrice: averagePrice(units, result.filledNotional, result.filled),
    fee: quoteToDecimal(result.fee),
  };
  switch (result.status) {
    case RESULT_STATUS.filled:
      return {
        ...base,
        status: "filled",
        message: "The order filled completely.",
      };
    case RESULT_STATUS.rested:
      return filledAny
        ? {
            ...base,
            status: "partially_filled_and_rested",
            message:
              "Part of the order filled and the rest rests on the book. Cancel it with the orderId.",
          }
        : {
            ...base,
            status: "rested",
            message:
              "Nothing matched, so the order rests on the book. Cancel it with the orderId.",
          };
    case RESULT_STATUS.remainderCancelled:
    case RESULT_STATUS.remainderCancelledStepLimit:
    case RESULT_STATUS.remainderCancelledBookFull:
    case RESULT_STATUS.remainderCancelledFillCheck:
      return {
        ...base,
        status: filledAny
          ? "partially_filled_remainder_cancelled"
          : "remainder_cancelled",
        message: remainderReason(result.status),
      };
    case RESULT_STATUS.refusedPostOnlyWouldMatch:
      return {
        ...base,
        status: "refused_post_only_would_match",
        message:
          "Refused: a post-only order would have matched, so it was not placed. Use a lower buy price or a higher sell price.",
      };
    default:
      return {
        ...base,
        status: "refused",
        message: refusedReason(result.code),
      };
  }
}

/** A placed order that settled: it ran, or it expired without running. */
export function describeSettled(
  settled: Settled,
  units: MarketUnits,
  landedLate = false,
): PlacedReport {
  if (settled.outcome === "expired") {
    return {
      status: "expired",
      orderId: null,
      filledSize: "0",
      restedSize: "0",
      cancelledSize: "0",
      averagePrice: null,
      fee: "0",
      message:
        "The order expired before it ran and can no longer run. Nothing changed; it is safe to place again.",
    };
  }
  const report = describePlaced(settled.result, units);
  return landedLate
    ? {
        ...report,
        message: `${report.message} It landed late, after the first wait ran out.`,
      }
    : report;
}

/** What a cancel or cancel-all recorded; `null` is a call that expired without running. */
export function describeCancel(result: OrderResult | null) {
  if (result === null) {
    return {
      cancelledOrders: 0,
      message:
        "The cancel expired before it ran and can no longer run. Nothing changed; try again.",
    };
  }
  if (result.cancelled === 0n) {
    return {
      cancelledOrders: 0,
      message:
        "Nothing was cancelled: the order is already gone (filled or cancelled), or no order rests there.",
    };
  }
  return {
    cancelledOrders: Number(result.cancelled),
    message: "Cancelled.",
  };
}

/** What a transfer between the collateral and the spot balance recorded; `null` is a call that expired without running. */
export function describeTransfer(result: OrderResult | null) {
  if (result === null) {
    return {
      status: "expired",
      message:
        "The transfer expired before it ran and can no longer run. Nothing moved; try again.",
    };
  }
  if (result.status === RESULT_STATUS.refused) {
    return {
      status: "refused",
      message: `The program refused the transfer (code ${result.code}). Nothing moved. The amount may exceed the balance being moved from, or leave too little margin for open positions.`,
    };
  }
  return {
    status: "moved",
    message: "Moved. Call get_account to see the balances.",
  };
}

/** Whether a failed call may be tried again once on a rebuilt session. */
export function worthRetrying(error: unknown): boolean {
  return !(
    error instanceof OrderInvalid ||
    error instanceof TransactionFailed ||
    error instanceof InvalidInput ||
    error instanceof UnsafeDeployment ||
    isAllKeysBusy(error) ||
    isNoView(error) ||
    error instanceof OutcomeUnknown
  );
}

function isAllKeysBusy(error: unknown): boolean {
  return error instanceof Error && error.message === ALL_KEYS_BUSY;
}

function isNoView(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith(NO_VIEW);
}

/** The text of any thrown value. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalidReason(reason: OrderInvalid["reason"]): string {
  switch (reason) {
    case "SizeTooSmall":
      return "The order is smaller than the market's minimum size.";
    case "PriceOffTick":
      return "The price is not a multiple of the market's tick.";
    case "NotionalTooSmall":
      return "The order's value (price times size) is below the market's minimum.";
  }
}

/** A failure as one plain message that says what happened and what to do. */
export function explainError(error: unknown): string {
  if (error instanceof UnsafeDeployment) {
    return `${error.message}. This server only works with the NoirWire devnet test network.`;
  }
  if (error instanceof InvalidInput) {
    return `${error.message}. Nothing was sent. Fix the input and try again.`;
  }
  if (error instanceof OrderInvalid) {
    return `${invalidReason(error.reason)} Nothing was sent. Change the size or price and try again.`;
  }
  if (error instanceof TransactionFailed) {
    const code = error.code === null ? "" : ` (program error ${error.code})`;
    return `The program refused the transaction${code}. Nothing changed. Check the market, size and price, then try again.`;
  }
  if (isAllKeysBusy(error)) {
    return "All four of this trader's one-time order keys are busy with calls in flight. Wait a few seconds and try again.";
  }
  if (isNoView(error)) {
    return "This trader has no account on the book yet. Call fund_account to open one and receive the test grant, then try again.";
  }
  const detail = messageOf(error).replace(/[.\s]+$/, "");
  return `${detail}. If this keeps happening, check the network connection and that the simulation service is up, then try again.`;
}

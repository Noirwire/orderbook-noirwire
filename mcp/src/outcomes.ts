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

/** A failed transaction reports the program's error number plus this. */
const PROGRAM_ERROR_BASE = 6000;

/**
 * The program's refusals a trader can cause or fix, in its own words, with
 * what to do next. Keyed by the program's error number less 6000, which for
 * an engine refusal is the engine's number, as an order result in the view
 * records it.
 */
export const TRADER_REFUSALS: Record<number, string> = {
  21: "The amount is zero. Send a positive amount.",
  22: "The available balance does not cover it. Spot orders spend the spot balance: move nUSD there with transfer_balance, or trade less.",
  23: "The collateral does not cover it. Trade less, or move nUSD to collateral with transfer_balance.",
  24: "Equity would fall below initial margin. Trade a smaller size.",
  25: "The balance would exceed the cap. Use a smaller amount.",
  30: "The exchange is paused. Try again later.",
  31: "The market is paused. Try again later.",
  32: "The market accepts only orders that shrink a position. Use reduce_only, or another market.",
  33: "Those order flags cannot be combined. Change the order type or drop reduce_only.",
  34: "The size is below the market's minimum. Use a larger size.",
  35: "The price is not on the tick. Round it to the market's tick size (get_markets).",
  36: "The notional is below the market's minimum. Use a larger size.",
  37: "The price is outside the band around the mark. Place it closer to the mark price (get_markets).",
  38: "The market's mark price is too old to accept new orders right now. Wait for a fresh price and try again.",
  39: "No price has been published for this market yet. Try again shortly.",
  40: "The open order limit on this market is reached. Cancel some orders first.",
  43: "A reduce-only order would increase the position. Flip the side or drop reduce_only.",
  46: "The order's own expiry has already passed. Send it again.",
  48: "The order, with your position and open orders on that side, could take the position past the market's position cap. Trade a smaller size, cancel orders on that side, or use reduce_only to shrink the position.",
  50: "No such order. It may have filled or been cancelled; check get_account.",
  90: "This account is blocked from opening new trades. It can still cancel orders, send reduce_only orders, move funds between balances, withdraw and close.",
  91: "This market takes resting orders only from listed market makers. Send an ioc or market order instead, or use reduce_only to shrink a position.",
  92: "This market takes orders that trade only from listed accounts. Use reduce_only to shrink a position, or cancel your orders.",
  150: "The exchange already holds as much of this token as it accepts for now. Deposit less, or try again later.",
};

function refusalText(engineCode: number): string | null {
  return TRADER_REFUSALS[engineCode] ?? null;
}

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
      return "The remainder was cancelled: that side of the book is full and your price is no better than its worst resting order.";
    case RESULT_STATUS.remainderCancelledFillCheck:
      return "The remainder was cancelled: it failed the margin check at that price, or the market is at its open interest cap.";
    default:
      return "The remainder did not match and was cancelled instead of resting.";
  }
}

function refusedReason(code: number): string {
  const known = refusalText(code);
  return known
    ? `Refused: ${known} Nothing filled.`
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
    const known =
      error.code === null ? null : refusalText(error.code - PROGRAM_ERROR_BASE);
    if (known)
      return `The program refused the order: ${known} Nothing changed.`;
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

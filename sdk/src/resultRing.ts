import type { OrderResult, View } from "./accounts.js";

type ResultRing = Pick<View, "results" | "resultsWritten">;

/** A client order id of 64 random bits, so two calls never share one by accident. */
export function randomClientOrderId(): bigint {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return new DataView(bytes.buffer).getBigUint64(0, true);
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

/**
 * Counts the JSON-RPC requests this process makes over HTTP, by method.
 *
 * Import it before anything that loads web3.js: that library keeps the
 * `fetch` it finds when it loads, so a later wrapper would count nothing.
 * A websocket notification is not a request and is not counted.
 */
export type Requests = Map<string, number>;

const counts: Requests = new Map();
const plainFetch = globalThis.fetch;

function methodsOf(body: unknown): string[] {
  if (typeof body !== "string") return [];
  try {
    const calls: { method?: unknown }[] = [JSON.parse(body)].flat();
    return calls
      .map((call) => call.method)
      .filter((method): method is string => typeof method === "string");
  } catch {
    return [];
  }
}

globalThis.fetch = (input, init) => {
  for (const method of methodsOf(init?.body)) {
    counts.set(method, (counts.get(method) ?? 0) + 1);
  }
  return plainFetch(input, init);
};

export const requestsSoFar = (): Requests => new Map(counts);

export function requestsSince(earlier: Requests): Requests {
  const made: Requests = new Map();
  for (const [method, count] of counts) {
    const more = count - (earlier.get(method) ?? 0);
    if (more > 0) made.set(method, more);
  }
  return made;
}

export function added(totals: Requests, more: Requests): void {
  for (const [method, count] of more) {
    totals.set(method, (totals.get(method) ?? 0) + count);
  }
}

/** "1.03 a call (sendTransaction 1.00, getLatestBlockhash 0.03)". */
export function perCall(totals: Requests, calls: number): string {
  const each = [...totals]
    .sort(([, a], [, b]) => b - a)
    .map(([method, count]) => `${method} ${(count / calls).toFixed(2)}`);
  const all = [...totals.values()].reduce((sum, count) => sum + count, 0);
  return `${(all / calls).toFixed(2)} a call${each.length ? ` (${each.join(", ")})` : ""}`;
}

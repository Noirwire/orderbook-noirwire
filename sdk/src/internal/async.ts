export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The same promise, with its rejection marked as handled so that a caller who
 * never awaits it does not bring the process down.
 */
export function unobserved<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {});
  return promise;
}

export const never = () => new Promise<never>(() => {});

/** Rejects when `promise` does and never resolves, for a race only a failure may end. */
export function failureOf(promise: Promise<unknown>): Promise<never> {
  return unobserved(promise.then(never));
}

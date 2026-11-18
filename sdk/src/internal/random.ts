/** 64 random bits, drawn from the platform's secure source. */
export function randomU64(): bigint {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return new DataView(bytes.buffer).getBigUint64(0, true);
}

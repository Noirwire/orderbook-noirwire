import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Keypair } from "@solana/web3.js";
import type { OrderKeyCheckpoint } from "@noirwire/orderbook";

/** A Solana CLI keypair file: a JSON array of the 64 secret key bytes. */
export function parseKeypair(text: string): Keypair {
  const bytes: unknown = JSON.parse(text);
  if (
    !Array.isArray(bytes) ||
    bytes.length !== 64 ||
    !bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte < 256)
  ) {
    throw new Error("the keypair file is not a JSON array of 64 bytes");
  }
  return Keypair.fromSecretKey(Uint8Array.from(bytes as number[]));
}

/** A saved checkpoint, or null when the text is not one. */
export function parseCheckpoint(text: string): OrderKeyCheckpoint | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return null;
    const { indices, nextIndex } = value as Record<string, unknown>;
    const isIndex = (n: unknown): n is number =>
      Number.isSafeInteger(n) && (n as number) >= 0;
    if (
      !Array.isArray(indices) ||
      !indices.every(isIndex) ||
      !isIndex(nextIndex)
    ) {
      return null;
    }
    return { indices, nextIndex };
  } catch {
    return null;
  }
}

function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * The trader's owner key. A missing file gets a new keypair, written with
 * mode 0600; an existing file is never overwritten.
 */
export function loadOrCreateKeypair(path: string): {
  keypair: Keypair;
  created: boolean;
} {
  const text = readIfPresent(path);
  if (text !== null) return { keypair: parseKeypair(text), created: false };
  const keypair = Keypair.generate();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(Array.from(keypair.secretKey)), {
    mode: 0o600,
    flag: "wx",
  });
  return { keypair, created: true };
}

export function loadCheckpoint(path: string): OrderKeyCheckpoint | null {
  const text = readIfPresent(path);
  return text === null ? null : parseCheckpoint(text);
}

/** Written beside the final path and renamed, so a crash never leaves half a file. */
export function saveCheckpoint(
  path: string,
  checkpoint: OrderKeyCheckpoint,
): void {
  const partial = `${path}.partial`;
  writeFileSync(partial, JSON.stringify(checkpoint), { mode: 0o600 });
  renameSync(partial, path);
}

/**
 * Keys on disk and the sign-in they give. No secret key is ever printed:
 * keys are read from, and written to, files.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import { dirname } from "path";
import { Connection, Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import {
  OrderKeyManager,
  privateConnection,
  type OrderKeyCheckpoint,
  type View,
} from "../sdk/dist/index.js";

/**
 * The key kept at `path`. A file that is not a JSON array of 64 bytes is
 * refused by its path alone: the parser's own message quotes the text around
 * where it stopped, which for a pasted secret is part of the secret.
 */
export function heldKey(path: string): Keypair {
  const refused = () =>
    new Error(`${path} is not a JSON array of 64 bytes, as a key file is.`);
  const text = readFileSync(path, "utf8");
  let bytes: unknown;
  try {
    bytes = JSON.parse(text);
  } catch {
    throw refused();
  }
  const isByte = (each: unknown) =>
    Number.isInteger(each) && (each as number) >= 0 && (each as number) <= 255;
  if (!Array.isArray(bytes) || bytes.length !== 64 || !bytes.every(isByte)) {
    throw refused();
  }
  try {
    return Keypair.fromSecretKey(Uint8Array.from(bytes as number[]));
  } catch {
    throw refused();
  }
}

/** Keeps a new key in a file only its owner can read, and never overwrites one. */
function keptKey(path: string): Keypair {
  const key = Keypair.generate();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(Array.from(key.secretKey)), {
    mode: 0o600,
    flag: "wx",
  });
  return key;
}

export function keyAt(path: string): Keypair {
  return existsSync(path) ? heldKey(path) : keptKey(path);
}

/** A connection to the private endpoint that reads as `reader`. */
export function readingAs(
  privateUrl: string,
  reader: Keypair,
): Promise<Connection> {
  return privateConnection(privateUrl, reader.publicKey, async (message) =>
    nacl.sign.detached(message, reader.secretKey),
  );
}

/** The checkpoint kept at `path`, or null when there is none or the file is not one. */
export function loadOrderKeyCheckpoint(
  path: string,
): OrderKeyCheckpoint | null {
  if (!existsSync(path)) return null;
  try {
    const { indices, nextIndex } = JSON.parse(readFileSync(path, "utf8"));
    const isIndex = (each: unknown) =>
      Number.isSafeInteger(each) && (each as number) >= 0;
    if (!Array.isArray(indices) || !indices.every(isIndex)) return null;
    return isIndex(nextIndex) ? { indices, nextIndex } : null;
  } catch {
    return null;
  }
}

/**
 * Keeps `checkpoint` at `path`, readable by its owner only. It holds the
 * places of the order keys in the derivation and no secret. It is written
 * beside the path and renamed, so a crash never leaves half a file.
 */
export function saveOrderKeyCheckpoint(
  path: string,
  checkpoint: OrderKeyCheckpoint,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.partial`;
  writeFileSync(partial, JSON.stringify(checkpoint), { mode: 0o600 });
  renameSync(partial, path);
}

/** The keeper's sweep bound as kept on disk: the seats it covers and the exchange's count it was brought up to. */
export type KeptSeatBound = { seats: number; day: bigint; opened: number };

/** Keeps the bound beside `path` and renames it in, so a crash mid-write never leaves a partial file. */
export function saveSeatBound(path: string, bound: KeptSeatBound): void {
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.partial`;
  writeFileSync(
    partial,
    `${JSON.stringify({ seats: bound.seats, day: bound.day.toString(), opened: bound.opened })}\n`,
    { mode: 0o600 },
  );
  renameSync(partial, path);
}

/**
 * The bound kept at `path`, or null when there is none or it cannot be read
 * (cut short, not JSON, wrong shape). An unreadable file is said loudly and
 * treated as missing: the caller then starts from `KEEPER_SEATS`, which must
 * then be re-derived from the gate's records, since seats opened on earlier
 * days above it are not swept.
 */
export function readSeatBound(path: string): KeptSeatBound | null {
  if (!existsSync(path)) return null;
  try {
    const kept = JSON.parse(readFileSync(path, "utf8")) as {
      seats: unknown;
      day: unknown;
      opened: unknown;
    };
    if (
      !Number.isSafeInteger(kept.seats) ||
      (kept.seats as number) < 0 ||
      !Number.isSafeInteger(kept.opened) ||
      (kept.opened as number) < 0 ||
      typeof kept.day !== "string"
    ) {
      throw new Error("a field is missing or is not a number");
    }
    return {
      seats: kept.seats as number,
      day: BigInt(kept.day),
      opened: kept.opened as number,
    };
  } catch (error) {
    console.log(
      `ALERT: the seat bound kept in ${path} cannot be read (${error instanceof Error ? error.message : String(error)}), so it is treated as missing. ` +
        "The sweep starts from KEEPER_SEATS plus one day's openings and the file is written again: seats the gate opened on earlier days above that are NOT swept. " +
        "Set KEEPER_SEATS to the highest seat index the gate has opened plus one, from the gate's own records, and restart.",
    );
    return null;
  }
}

/** How far from index 0 a start searches for the keys a view holds before it gives up (`OrderKeyManager.fromView`). */
export const ORDER_KEY_SEARCH_BOUND = 100_000;

/**
 * The alert line for an order key checkpoint that could not be saved: the
 * keys still work in this process, but a restart then searches from index 0
 * and finds nothing once the keys' index is past the search bound, and
 * liquidation stops. Said as soon as a save fails, long before that.
 */
export const checkpointAlert = (path: string, nextIndex: number, why: string) =>
  `ALERT: could not save the order key checkpoint to ${path} (${why}). The keys' next index is ${nextIndex}, ${Math.max(0, ORDER_KEY_SEARCH_BOUND - nextIndex)} short of the ${ORDER_KEY_SEARCH_BOUND} a restart's search from index 0 gives up at; ` +
  "past it, a restart cannot find the keeper's live order keys and nothing liquidates. Make the folder writable now: this sweep counts as failed and sends no healthy ping until a save succeeds.";

/**
 * Saves the places of `keys` at `path`, and says whether it did. A save that
 * fails is reported (`checkpointAlert`) and does not stop the caller, which
 * must treat it as a failure of its round: the keys still work, but the next
 * start can only search for them.
 */
export function keepOrderKeys(path: string, keys: OrderKeyManager): boolean {
  try {
    saveOrderKeyCheckpoint(path, keys.checkpoint);
    return true;
  } catch (error) {
    console.log(
      checkpointAlert(
        path,
        keys.checkpoint.nextIndex,
        error instanceof Error ? error.message : String(error),
      ),
    );
    return false;
  }
}

/**
 * The order keys the view holds. `current`, a manager kept from an earlier
 * call, is brought in line with the view (`resync`) and kept, since a manager
 * that lives as long as the process never searches again. Otherwise, or when
 * the view holds a key `current` cannot find, they are picked up from the
 * checkpoint at `path` (`restore`), and only when that is missing or too old
 * by searching from index 0 (`fromView`), which gives up past 100,000.
 */
export function orderKeysFor(
  seed: Uint8Array,
  view: Pick<View, "orderKeys">,
  path: string,
  current: OrderKeyManager | null = null,
): OrderKeyManager {
  if (current) {
    try {
      current.resync(view);
      return current;
    } catch {
      console.log(
        "The keeper's order keys moved further than it tracked: picking them up again.",
      );
    }
  }
  const checkpoint = loadOrderKeyCheckpoint(path);
  if (checkpoint) {
    try {
      return OrderKeyManager.restore(seed, view, checkpoint);
    } catch {
      console.log(
        `The order key checkpoint at ${path} does not match the seat: searching from index 0.`,
      );
    }
  }
  return OrderKeyManager.fromView(seed, view);
}

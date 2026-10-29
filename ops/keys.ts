/**
 * Keys on disk and the sign-in they give. No secret key is ever printed:
 * keys are read from, and written to, files.
 */
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
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
 * The text of the key file at `path`, read from the one descriptor that was
 * checked: opened without following a symlink, then a regular file owned by
 * the current user that nobody else can read.
 */
function checkedText(path: string): string {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error(`${path} is a symbolic link, not a regular key file.`);
    }
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    const uid = process.getuid?.();
    if (!stat.isFile()) {
      throw new Error(`${path} is not a regular file, as a key file is.`);
    }
    if (uid !== undefined && stat.uid !== uid) {
      throw new Error(
        `${path} is not owned by the user running this (uid ${uid}). Use a key file that user owns.`,
      );
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new Error(
        `${path} can be read by other users (mode ${(stat.mode & 0o777).toString(8)}). Run chmod 600 on it, then run again.`,
      );
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * The key kept at `path`. A file that is not a JSON array of 64 bytes is
 * refused by its path alone: the parser's own message quotes the text around
 * where it stopped, which for a pasted secret is part of the secret. A file
 * that is not a regular file, is not owned by the current user, or can be read
 * by anyone else is refused before it is read.
 */
export function heldKey(path: string): Keypair {
  const refused = () =>
    new Error(`${path} is not a JSON array of 64 bytes, as a key file is.`);
  const text = checkedText(path);
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

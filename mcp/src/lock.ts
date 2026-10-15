import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PublicKey } from "@solana/web3.js";

/** Another server process is using this keypair. */
export class KeypairInUse extends Error {
  constructor(lockPath: string, pid: number) {
    super(
      `another noirwire-orderbook-mcp process (pid ${pid}) is already using this keypair (${lockPath}). Two processes would fight over the trader's one-time order keys. Set NOIRWIRE_KEYPAIR to a different file for this one.`,
    );
    this.name = "KeypairInUse";
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function pidIn(path: string): number | null {
  try {
    const pid = Number(readFileSync(path, "utf8").trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function create(path: string, pid: number): boolean {
  try {
    writeFileSync(path, String(pid), { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

function remove(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
}

/**
 * The lock file for a trader, kept in one fixed place per user and named by
 * the owner's public key. The key is the identity, so a copy, a hard link,
 * a symlink or any other path to the same keypair shares one lock.
 */
export function ownerLockPath(home: string, owner: PublicKey): string {
  return join(home, ".config", "noirwire", "locks", `${owner.toBase58()}.lock`);
}

/**
 * Takes over a lock that looks abandoned. Only one process does this at a
 * time, holding the exclusive `<lock>.takeover` file, and it judges the
 * holder only once it has that file: a process that judged the same lock
 * stale a moment earlier waits behind the file, then finds a live holder
 * and refuses, instead of deleting the new lock. A takeover file left by a
 * process that died inside this short step must be deleted by hand.
 */
function takeOver(
  path: string,
  pid: number,
  isAlive: (pid: number) => boolean,
): void {
  const guard = `${path}.takeover`;
  if (!create(guard, pid)) throw new KeypairInUse(path, pidIn(guard) ?? 0);
  try {
    const holder = pidIn(path);
    if (holder !== null && holder !== pid && isAlive(holder)) {
      throw new KeypairInUse(path, holder);
    }
    remove(path);
    if (!create(path, pid) || pidIn(path) !== pid) {
      throw new KeypairInUse(path, pidIn(path) ?? 0);
    }
  } finally {
    remove(guard);
  }
}

/**
 * Takes the exclusive lock file for a keypair, holding this process's pid.
 * A lock whose process is gone is taken over. Returns the function that
 * releases it; it removes the file only if the file is still this process's.
 */
export function acquireLock(
  path: string,
  pid: number = process.pid,
  isAlive: (pid: number) => boolean = processIsAlive,
): () => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!create(path, pid)) takeOver(path, pid, isAlive);
  return () => {
    if (pidIn(path) === pid) {
      try {
        unlinkSync(path);
      } catch {
        // Already gone.
      }
    }
  };
}

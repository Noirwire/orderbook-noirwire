import { Keypair, PublicKey } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha256";
import { ORDER_KEYS } from "./constants.js";
import type { View } from "./accounts.js";

const DOMAIN = new TextEncoder().encode("noirwire-orderbook/order-key/v1");

/**
 * Order key `index` from a 32-byte seed: the Ed25519 seed is
 * `sha256("noirwire-orderbook/order-key/v1" || seed || index as u64 little endian)`.
 * The seed is the only secret; every key the trader ever uses follows from it,
 * so a wallet that keeps the seed can rebuild its keys on another device.
 */
export function deriveOrderKey(seed: Uint8Array, index: number): Keypair {
  if (seed.length !== 32) throw new Error("the order key seed is 32 bytes");
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error("the order key index is a non-negative integer");
  }
  const counter = new Uint8Array(8);
  new DataView(counter.buffer).setBigUint64(0, BigInt(index), true);
  const input = new Uint8Array(DOMAIN.length + 32 + 8);
  input.set(DOMAIN);
  input.set(seed, DOMAIN.length);
  input.set(counter, DOMAIN.length + 32);
  return Keypair.fromSeed(sha256(input));
}

/** One live slot of the view: which derived key sits there. */
export type LiveKey = { slot: number; index: number; keypair: Keypair };

/**
 * The derivation index of each slot's live key and the next index to derive.
 * It holds no secret: without the seed it names nothing.
 */
export type OrderKeyCheckpoint = { indices: number[]; nextIndex: number };

/** A key handed out for one instruction, with the key that replaces it. */
export type OrderKeyUse = {
  slot: number;
  keypair: Keypair;
  replacement: Keypair;
  replacementIndex: number;
};

/**
 * Keeps the four live order keys and the index of the next one to derive.
 * `take` hands out a live key and its replacement; `confirm` records that the
 * swap landed, `release` that it did not, so a refused instruction keeps its
 * key and a successful one never reuses it. A key whose instruction may still
 * run is neither: its slot stays lent, to nobody else, until `settle`.
 */
export class OrderKeyManager {
  private live: LiveKey[];
  private nextIndex: number;
  private pending = new Map<number, OrderKeyUse>();

  private constructor(
    readonly seed: Uint8Array,
    live: LiveKey[],
    nextIndex: number,
  ) {
    this.live = live;
    this.nextIndex = nextIndex;
  }

  /** The first four keys, for `open_trader`. */
  static fresh(seed: Uint8Array): OrderKeyManager {
    const live = Array.from({ length: ORDER_KEYS }, (_, slot) => ({
      slot,
      index: slot,
      keypair: deriveOrderKey(seed, slot),
    }));
    return new OrderKeyManager(seed, live, ORDER_KEYS);
  }

  /**
   * Finds where the four keys a view holds sit in the derivation, searching
   * up to `searchLimit` indices, and continues from the highest found.
   */
  static fromView(
    seed: Uint8Array,
    view: Pick<View, "orderKeys">,
    searchLimit = 100_000,
  ): OrderKeyManager {
    const wanted = view.orderKeys.map((key) => key.toBase58());
    const live: LiveKey[] = [];
    for (
      let index = 0;
      index < searchLimit && live.length < wanted.length;
      index += 1
    ) {
      const keypair = deriveOrderKey(seed, index);
      const slot = wanted.indexOf(keypair.publicKey.toBase58());
      if (slot >= 0) live.push({ slot, index, keypair });
    }
    if (live.length !== wanted.length) {
      throw new Error("the view's order keys do not all derive from this seed");
    }
    live.sort((a, b) => a.slot - b.slot);
    const nextIndex = Math.max(...live.map((key) => key.index)) + 1;
    return new OrderKeyManager(seed, live, nextIndex);
  }

  /**
   * Picks up from a checkpoint the client saved earlier, deriving a handful
   * of keys instead of searching from index 0. A slot whose key moved on
   * since the checkpoint is looked for among the indices handed out around
   * and after it, `window` of them. Save `checkpoint` after every confirmed
   * call to keep that distance small.
   */
  static restore(
    seed: Uint8Array,
    view: Pick<View, "orderKeys">,
    checkpoint: OrderKeyCheckpoint,
    window = 256,
  ): OrderKeyManager {
    const first = Math.max(0, checkpoint.nextIndex - 2 * ORDER_KEYS);
    const derived: Keypair[] = [];
    const searched = (slot: number, wanted: PublicKey): LiveKey => {
      for (let index = first; index < checkpoint.nextIndex + window; index++) {
        derived[index - first] ??= deriveOrderKey(seed, index);
        const keypair = derived[index - first];
        if (keypair.publicKey.equals(wanted)) return { slot, index, keypair };
      }
      throw new Error(
        "an order key moved further than the checkpoint reaches; use fromView",
      );
    };
    const live = view.orderKeys.map((wanted, slot) => {
      const keypair = deriveOrderKey(seed, checkpoint.indices[slot]);
      return keypair.publicKey.equals(wanted)
        ? { slot, index: checkpoint.indices[slot], keypair }
        : searched(slot, wanted);
    });
    const highest = Math.max(...live.map((key) => key.index));
    return new OrderKeyManager(
      seed,
      live,
      Math.max(checkpoint.nextIndex, highest + 1),
    );
  }

  /** Where the four live keys sit in the derivation, to save and `restore` from. */
  get checkpoint(): OrderKeyCheckpoint {
    return {
      indices: this.live.map((key) => key.index),
      nextIndex: this.nextIndex,
    };
  }

  get publicKeys(): PublicKey[] {
    return this.live.map((key) => key.keypair.publicKey);
  }

  /** A live key not currently lent out, with a fresh replacement. */
  take(): OrderKeyUse {
    const free = this.live.find((key) => !this.pending.has(key.slot));
    if (!free) throw new Error("every order key is in use");
    const use = {
      slot: free.slot,
      keypair: free.keypair,
      replacement: deriveOrderKey(this.seed, this.nextIndex),
      replacementIndex: this.nextIndex,
    };
    this.nextIndex += 1;
    this.pending.set(free.slot, use);
    return use;
  }

  /**
   * The swap landed: the replacement is the live key of that slot now.
   * Only the use the slot is lent to right now changes anything, so a call
   * that reports late cannot overwrite what a newer call established. With
   * `view`, the slot takes whichever key the view shows there.
   */
  confirm(use: OrderKeyUse, view?: Pick<View, "orderKeys">): void {
    if (this.pending.get(use.slot) !== use) return;
    if (view) return void this.settle(use, view);
    this.pending.delete(use.slot);
    this.live[use.slot] = {
      slot: use.slot,
      index: use.replacementIndex,
      keypair: use.replacement,
    };
  }

  /**
   * The instruction did not run: the key is still live and may be reused.
   * Like `confirm`, it acts only for the use the slot is lent to, and with
   * `view` the slot takes whichever key the view shows there, so a swap that
   * landed without its result being seen is not mistaken for a refusal.
   */
  release(use: OrderKeyUse, view?: Pick<View, "orderKeys">): void {
    if (this.pending.get(use.slot) !== use) return;
    if (view) return void this.settle(use, view);
    this.pending.delete(use.slot);
  }

  /**
   * Ends the loan of a slot by what the view shows there, and says whether
   * the lent key was used: true when the view holds another key in its place.
   * Call it only once the instruction can no longer run, or its result has
   * been read; until then the slot stays lent and `take` passes it over.
   */
  settle(use: OrderKeyUse, view: Pick<View, "orderKeys">): boolean {
    if (this.pending.get(use.slot) !== use) return false;
    const observed = view.orderKeys[use.slot];
    const landed = observed.equals(use.replacement.publicKey);
    const located = landed
      ? {
          slot: use.slot,
          index: use.replacementIndex,
          keypair: use.replacement,
        }
      : this.located(use.slot, observed);
    this.pending.delete(use.slot);
    this.live[use.slot] = located;
    return !observed.equals(use.keypair.publicKey);
  }

  /** The derived key that `observed` is, as the live key of `slot`. */
  private located(slot: number, observed: PublicKey): LiveKey {
    const current = this.live[slot];
    if (current.keypair.publicKey.equals(observed)) return current;
    for (let index = this.nextIndex + ORDER_KEYS - 1; index >= 0; index -= 1) {
      const keypair = deriveOrderKey(this.seed, index);
      if (keypair.publicKey.equals(observed)) {
        this.nextIndex = Math.max(this.nextIndex, index + 1);
        return { slot, index, keypair };
      }
    }
    throw new Error("the view's order keys do not all derive from this seed");
  }

  /**
   * Brings the slots that are not lent out in line with what the view holds.
   * A slot that is lent out is left to its own call, which settles it with
   * `confirm` or `release`: clearing it here would lend the same key twice
   * while that call is still in flight.
   */
  resync(view: Pick<View, "orderKeys">): void {
    view.orderKeys.forEach((observed, slot) => {
      if (!this.pending.has(slot)) {
        this.live[slot] = this.located(slot, observed);
      }
    });
  }
}

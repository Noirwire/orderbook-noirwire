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
 * key and a successful one never reuses it.
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

  /** The swap landed: the replacement is the live key of that slot now. */
  confirm(use: OrderKeyUse): void {
    this.pending.delete(use.slot);
    this.live[use.slot] = {
      slot: use.slot,
      index: use.replacementIndex,
      keypair: use.replacement,
    };
  }

  /** The instruction was refused: the key is still live and may be reused. */
  release(use: OrderKeyUse): void {
    this.pending.delete(use.slot);
  }

  /** Rebuilds the live set from what the view holds, after an unknown outcome. */
  resync(view: Pick<View, "orderKeys">): void {
    const fresh = OrderKeyManager.fromView(
      this.seed,
      view,
      this.nextIndex + ORDER_KEYS,
    );
    this.live = fresh.live;
    this.nextIndex = Math.max(this.nextIndex, fresh.nextIndex);
    this.pending.clear();
  }
}

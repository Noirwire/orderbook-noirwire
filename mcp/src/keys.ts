import type { Keypair } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha256";
import nacl from "tweetnacl";

/**
 * The same domain string the trading terminal uses, so one owner key is the
 * same trader in the terminal and in this server, with the same order keys.
 */
const ORDER_SEED_DOMAIN = new TextEncoder().encode(
  "noirwire-terminal/order-key-seed/v1",
);

/**
 * The 32-byte seed every order key is derived from: the owner key signs a
 * fixed message (Ed25519 signing is deterministic) and the signature is
 * hashed. Only the owner secret has to be kept.
 */
export function deriveOrderSeed(owner: Keypair): Uint8Array {
  return sha256(nacl.sign.detached(ORDER_SEED_DOMAIN, owner.secretKey));
}

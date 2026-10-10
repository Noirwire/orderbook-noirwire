import { sha256 } from "@noble/hashes/sha256";
import { bytesEqual } from "./bytes.js";
import { ROLE } from "./constants.js";
import { RECEIPT_LEN, SECRET_LEN } from "./internal/sizes.js";
import type { TapeFill } from "./accounts.js";

const FILL_SEQ_LEN = 8;

/** RULES 2: the 16-byte secret every order carries, drawn here. */
export function randomSecret(): Uint8Array {
  const secret = new Uint8Array(SECRET_LEN);
  globalThis.crypto.getRandomValues(secret);
  return secret;
}

/** RULES 10: the first 8 bytes of `sha256(secret || fill sequence LE || role byte)`. */
export function receipt(
  secret: Uint8Array,
  fillSeq: bigint,
  role: number,
): Uint8Array {
  const input = new Uint8Array(SECRET_LEN + FILL_SEQ_LEN + 1);
  input.set(secret);
  new DataView(input.buffer).setBigUint64(SECRET_LEN, fillSeq, true);
  input[SECRET_LEN + FILL_SEQ_LEN] = role;
  return sha256(input).slice(0, RECEIPT_LEN);
}

export type OwnFill = {
  fill: TapeFill;
  role: "maker" | "taker";
  secret: Uint8Array;
};

/** The fills on a tape that belong to any of `secrets`, by their receipts. */
export function ownFills(fills: TapeFill[], secrets: Uint8Array[]): OwnFill[] {
  const own: OwnFill[] = [];
  for (const fill of fills) {
    for (const secret of secrets) {
      if (
        bytesEqual(fill.makerReceipt, receipt(secret, fill.fillSeq, ROLE.maker))
      ) {
        own.push({ fill, role: "maker", secret });
      } else if (
        bytesEqual(fill.takerReceipt, receipt(secret, fill.fillSeq, ROLE.taker))
      ) {
        own.push({ fill, role: "taker", secret });
      }
    }
  }
  return own;
}

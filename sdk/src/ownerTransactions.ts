import type { Connection, Keypair, PublicKey } from "@solana/web3.js";
import type { Instructions } from "./instructions.js";
import type { Blockhash } from "./internal/blockhashes.js";
import type { OwnerMessageForm } from "./ownerAuth.js";
import { signed, type Signed } from "./transactions.js";

export type OwnerOpen = {
  owner: PublicKey;
  orderKeys: PublicKey[];
  expiresAt: bigint;
  /** The owner's signature over the open message, or over its envelope. */
  signature: Uint8Array;
  form?: OwnerMessageForm;
};

export type OwnerReplacement = OwnerOpen & {
  /** The view's `ownerNonce` the message was signed with. */
  nonce: number;
};

/**
 * RULES 3.0: the whole `open_trader_signed` transaction, the owner's proof
 * first and then the open, with the gate as fee payer and only signer.
 */
export function openSignedTransaction(
  connection: Connection,
  instructions: Instructions,
  gate: Keypair,
  { owner, orderKeys, expiresAt, signature, form }: OwnerOpen,
  blockhash?: Blockhash,
): Promise<Signed> {
  return signed(
    connection,
    [
      instructions.openTraderProof(
        owner,
        orderKeys,
        expiresAt,
        signature,
        form,
      ),
      instructions.openTraderSigned(
        gate.publicKey,
        owner,
        orderKeys,
        expiresAt,
      ),
    ],
    gate,
    [],
    blockhash,
  );
}

/**
 * RULES 3.0: the whole `set_order_keys_signed` transaction, the owner's proof
 * first and then the replacement. The owner does not sign, so any key can pay:
 * `feePayer` is the only signer.
 */
export function replaceKeysSignedTransaction(
  connection: Connection,
  instructions: Instructions,
  feePayer: Keypair,
  { owner, orderKeys, nonce, expiresAt, signature, form }: OwnerReplacement,
  blockhash?: Blockhash,
): Promise<Signed> {
  return signed(
    connection,
    [
      instructions.setOrderKeysProof(
        owner,
        orderKeys,
        nonce,
        expiresAt,
        signature,
        form,
      ),
      instructions.setOrderKeysSigned(owner, orderKeys, nonce, expiresAt),
    ],
    feePayer,
    [],
    blockhash,
  );
}

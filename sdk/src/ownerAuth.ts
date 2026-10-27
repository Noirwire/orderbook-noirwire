import { ed25519 } from "@noble/curves/ed25519";
import {
  Ed25519Program,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";

/** RULES 3.0: the furthest ahead an owner action may expire, in seconds. */
export const MAX_OWNER_EXPIRY_AHEAD = 120;

/** The program's owner-action errors by number, as `OrderbookError` lists them. */
export const OWNER_ERROR = {
  invalidProof: 151,
  wrongNonce: 152,
  expiryTooFar: 153,
  wrongWithdrawDestination: 154,
} as const;

/** The same errors as a failed transaction reports them, which is 6000 plus the number. */
export const OWNER_TRANSACTION_ERROR = {
  invalidProof: 6151,
  wrongNonce: 6152,
  expiryTooFar: 6153,
  wrongWithdrawDestination: 6154,
} as const;

/**
 * Which bytes the owner's wallet signed: the owner action text itself, that
 * text wrapped in the Solana off-chain message format as Ledger and the
 * Solana SDK write it (`envelope`), or wrapped in the Anza off-chain message
 * specification's version 0 header, which also carries an application domain
 * and the signers (`spec`).
 */
export type OwnerMessageForm = "raw" | "envelope" | "spec";

/** What the specification's header names besides the text: the program, which is its application domain, and the one signer. */
export type OwnerSigner = { programId: PublicKey; owner: PublicKey };

const OFFCHAIN_DOMAIN = Uint8Array.of(
  0xff,
  ...new TextEncoder().encode("solana offchain"),
);
const OFFCHAIN_VERSION = 0;
const OFFCHAIN_LIMITED_UTF8 = 1;
const OFFCHAIN_MAX_LEDGER_LEN = 1212;

/**
 * RULES 3.0: the unix time an owner action expires at, `lifetime` seconds
 * after the rollup's clock reads `rollupClockSeconds`. The lifetime is held to
 * the program's limit, so the result is never refused for being too far ahead
 * of that clock.
 */
export function ownerExpiry(
  rollupClockSeconds: number,
  lifetime = 100,
): bigint {
  if (!Number.isSafeInteger(rollupClockSeconds) || rollupClockSeconds < 0) {
    throw new Error("The rollup clock must be a unix time in whole seconds");
  }
  if (!Number.isInteger(lifetime) || lifetime < 1) {
    throw new Error(
      "The lifetime must be a whole number of seconds, at least 1",
    );
  }
  return BigInt(
    rollupClockSeconds + Math.min(lifetime, MAX_OWNER_EXPIRY_AHEAD),
  );
}

/**
 * RULES 3.0: exact UTF-8 owner consent text, with no trailing newline.
 */
export function ownerActionMessage(
  action: "open" | "replace",
  programId: PublicKey,
  owner: PublicKey,
  keys: PublicKey[],
  expiresAt: bigint,
  nonce?: number,
): Uint8Array {
  if (keys.length !== 4 || (action === "replace") !== (nonce !== undefined)) {
    throw new Error(
      "Owner action requires four keys and the action's nonce shape",
    );
  }
  if (
    nonce !== undefined &&
    (!Number.isInteger(nonce) || nonce < 0 || nonce > 0xffffffff)
  ) {
    throw new Error("Owner nonce must be a u32");
  }
  const title =
    action === "open" ? "open trading account" : "replace order keys";
  const lines = [
    `NoirWire: ${title}`,
    `program ${programId.toBase58()}`,
    `owner ${owner.toBase58()}`,
    `keys ${keys.map((key) => key.toBase58()).join(" ")}`,
  ];
  if (nonce !== undefined) lines.push(`nonce ${nonce}`);
  lines.push(`expires ${expiresAt}`);
  return new TextEncoder().encode(lines.join("\n"));
}

/**
 * RULES 3.0: `message` in the Solana off-chain message format, version 0: the
 * domain `\xffsolana offchain`, the version, the format and the length as two
 * little-endian bytes, then the text. An owner action's text has line breaks,
 * so its format is limited UTF-8 (1). The program takes this wrapping of
 * exactly the owner action's text and nothing else.
 */
export function ownerActionEnvelope(message: Uint8Array): Uint8Array {
  if (message.length === 0 || message.length > OFFCHAIN_MAX_LEDGER_LEN) {
    throw new Error(
      `An off-chain message holds 1 to ${OFFCHAIN_MAX_LEDGER_LEN} bytes`,
    );
  }
  const bytes = new Uint8Array(OFFCHAIN_DOMAIN.length + 4 + message.length);
  bytes.set(OFFCHAIN_DOMAIN);
  bytes[OFFCHAIN_DOMAIN.length] = OFFCHAIN_VERSION;
  bytes[OFFCHAIN_DOMAIN.length + 1] = OFFCHAIN_LIMITED_UTF8;
  new DataView(bytes.buffer).setUint16(
    OFFCHAIN_DOMAIN.length + 2,
    message.length,
    true,
  );
  bytes.set(message, OFFCHAIN_DOMAIN.length + 4);
  return bytes;
}

/**
 * RULES 3.0: `message` in the Anza off-chain message specification's version
 * 0 header: the domain `\xffsolana offchain`, the version, the 32-byte
 * application domain (the program's id), the format (limited UTF-8), the
 * signer count (one), the signer (the owner), the length as two
 * little-endian bytes, then the text.
 */
export function ownerActionSpecEnvelope(
  message: Uint8Array,
  { programId, owner }: OwnerSigner,
): Uint8Array {
  if (message.length === 0 || message.length > OFFCHAIN_MAX_LEDGER_LEN) {
    throw new Error(
      `An off-chain message holds 1 to ${OFFCHAIN_MAX_LEDGER_LEN} bytes`,
    );
  }
  const header = OFFCHAIN_DOMAIN.length + 1 + 32 + 1 + 1 + 32 + 2;
  const bytes = new Uint8Array(header + message.length);
  let at = 0;
  bytes.set(OFFCHAIN_DOMAIN, at);
  at += OFFCHAIN_DOMAIN.length;
  bytes[at++] = OFFCHAIN_VERSION;
  bytes.set(programId.toBytes(), at);
  at += 32;
  bytes[at++] = OFFCHAIN_LIMITED_UTF8;
  bytes[at++] = 1;
  bytes.set(owner.toBytes(), at);
  at += 32;
  new DataView(bytes.buffer).setUint16(at, message.length, true);
  at += 2;
  bytes.set(message, at);
  return bytes;
}

/**
 * The bytes a signature of the given form covers. The `spec` form names the
 * program and the signer in its header, so it needs `signer`.
 */
export function ownerSignedBytes(
  message: Uint8Array,
  form: OwnerMessageForm,
  signer?: OwnerSigner,
): Uint8Array {
  if (form === "envelope") return ownerActionEnvelope(message);
  if (form === "spec") {
    if (!signer) throw new Error("The specification header names the signer");
    return ownerActionSpecEnvelope(message, signer);
  }
  return message;
}

/**
 * Which form of `message` the owner signed, or null when `signature` is
 * not the owner's signature over the text, over its off-chain envelope or,
 * when `programId` is given, over its specification header. Never throws on a
 * malformed signature.
 */
export function verifyOwnerSignature(
  message: Uint8Array,
  signature: Uint8Array,
  owner: PublicKey,
  programId?: PublicKey,
): OwnerMessageForm | null {
  for (const form of ["raw", "envelope", "spec"] as const) {
    try {
      const bytes = ownerSignedBytes(
        message,
        form,
        programId && { programId, owner },
      );
      if (ed25519.verify(signature, bytes, owner.toBytes(), { zip215: false }))
        return form;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * The program accepts only this one-signature, same-instruction layout.
 * `message` is the bytes that were signed: the owner action text, or its
 * envelope.
 */
export function ownerProofInstruction(
  owner: PublicKey,
  message: Uint8Array,
  signature: Uint8Array,
): TransactionInstruction {
  if (signature.length !== 64)
    throw new Error("Ed25519 signature must be 64 bytes");
  return Ed25519Program.createInstructionWithPublicKey({
    publicKey: owner.toBytes(),
    message,
    signature,
  });
}

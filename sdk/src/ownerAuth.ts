import {
  Ed25519Program,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";

/** RULES 3.0: exact UTF-8 owner consent text, with no trailing newline. */
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

/** The program accepts only this one-signature, same-instruction layout. */
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

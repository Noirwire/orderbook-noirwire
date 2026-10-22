/**
 * Keys on disk and the sign-in they give. No secret key is ever printed:
 * keys are read from, and written to, files.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import { Connection, Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { privateConnection } from "../sdk/dist/index.js";

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

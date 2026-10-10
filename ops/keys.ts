/**
 * Keys on disk and the sign-in they give. No secret key is ever printed:
 * keys are read from, and written to, files.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import { Connection, Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { privateConnection } from "../sdk/dist/index.js";

export function heldKey(path: string): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))),
  );
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

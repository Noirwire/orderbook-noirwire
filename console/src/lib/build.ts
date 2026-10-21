import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { Addresses, UPGRADEABLE_LOADER_ID } from "@noirwire/orderbook";
import type { Network } from "./networks";

const PROGRAM_DATA_KIND = 3;
const BYTES_AT = 45;
const PRICE_WRITERS = ["publish_price", "reset_price"];

/** Where `make check-mainnet DECLARED_ID=<id>` leaves the build, from the repository root. */
export const builtProgramPath = (programId: string) =>
  join(
    process.cwd(),
    "..",
    "target",
    "mainnet",
    programId,
    "noirwire_orderbook.so",
  );

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

const discriminator = (name: string) =>
  createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);

/**
 * Why the deployed bytes are not `built`, or null: they must hold no price
 * writer, and be the build's bytes followed by nothing but the zeros
 * reserved for upgrades. The same test as the ops scripts' before they send.
 */
export function deployedDiffers(
  deployed: Uint8Array,
  built: Uint8Array,
): string | null {
  const writers = PRICE_WRITERS.filter((name) =>
    Buffer.from(deployed).includes(discriminator(name)),
  );
  if (writers.length > 0) {
    return `the deployed program has ${writers.join(" and ")}, so it is a test network's build`;
  }
  const head = deployed.subarray(0, built.length);
  const same =
    deployed.length >= built.length &&
    Buffer.from(head).equals(Buffer.from(built)) &&
    deployed.subarray(built.length).every((byte) => byte === 0);
  return same
    ? null
    : `the deployed program (sha256 ${sha256(head)} over the build's length) is not the build (sha256 ${sha256(built)}, ${built.length} bytes)`;
}

/** Why the program at the network's id is not the checked mainnet build, or null when it is, byte for byte. */
export async function buildRefusal(network: Network): Promise<string | null> {
  const path = builtProgramPath(network.programId);
  if (!existsSync(path)) {
    return `the checked build is missing at target/mainnet/${network.programId}: build it with make check-mainnet DECLARED_ID=${network.programId}`;
  }
  const addresses = new Addresses(new PublicKey(network.programId));
  const account = await new Connection(
    network.solanaUrl,
    "confirmed",
  ).getAccountInfo(addresses.programData);
  if (!account?.owner.equals(UPGRADEABLE_LOADER_ID)) {
    return `no upgradeable program is deployed at ${network.programId}`;
  }
  const kind =
    account.data.length >= BYTES_AT ? account.data.readUInt32LE(0) : null;
  if (kind !== PROGRAM_DATA_KIND) {
    return "the program's data account is not an upgradeable program's data";
  }
  return deployedDiffers(account.data.subarray(BYTES_AT), readFileSync(path));
}

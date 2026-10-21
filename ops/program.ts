/**
 * The program deployed at a deployment's id, as Solana keeps it: who may
 * upgrade it, and whether its bytes are the mainnet build the operator
 * checked. The upgradeable loader keeps a program's bytes in its program data
 * account after a 45-byte header (the account kind, the slot it was last
 * deployed in and the upgrade authority, if any), padded with zeros to the
 * size reserved for upgrades.
 */
import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { PublicKey } from "@solana/web3.js";
import { UPGRADEABLE_LOADER_ID } from "../sdk/dist/index.js";
import type { Target } from "./deployment";

const PROGRAM_DATA_KIND = 3;
const HAS_AUTHORITY_AT = 12;
const AUTHORITY_AT = 13;
const BYTES_AT = 45;

/** The instructions only a test network's build has. Each writes a price. */
export const PRICE_WRITERS = ["publish_price", "reset_price"];

export type Deployed = {
  upgradeAuthority: PublicKey | null;
  bytes: Uint8Array;
};

/** A program data account's upgrade authority and program bytes. */
export function programDataOf(data: Uint8Array): Deployed {
  const kind =
    data.length >= BYTES_AT
      ? new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(
          0,
          true,
        )
      : null;
  if (kind !== PROGRAM_DATA_KIND) {
    throw new Error("the account is not an upgradeable program's data");
  }
  return {
    upgradeAuthority:
      data[HAS_AUTHORITY_AT] === 1
        ? new PublicKey(data.subarray(AUTHORITY_AT, BYTES_AT))
        : null,
    bytes: data.subarray(BYTES_AT),
  };
}

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** What Anchor dispatches an instruction on: the first 8 bytes of sha256("global:" || name). */
const discriminator = (name: string) =>
  createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);

/** The price-writing instructions whose discriminator `binary` holds. */
export const priceWritersIn = (binary: Uint8Array) =>
  PRICE_WRITERS.filter((name) =>
    Buffer.from(binary).includes(discriminator(name)),
  );

/**
 * Why the deployed bytes are not `built`, or null: they must hold no price
 * writer, and be the build's bytes followed by nothing but the zeros
 * reserved for upgrades.
 */
export function deployedDiffers(
  deployed: Uint8Array,
  built: Uint8Array,
): string | null {
  const writers = priceWritersIn(deployed);
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

/**
 * The program at the deployment's id, refused unless it is the local mainnet
 * build at `BUILT_PROGRAM` byte for byte. That build declares this id, and
 * `make check-mainnet DECLARED_ID=<id>` makes it.
 */
export async function deployedAsBuilt(on: Target): Promise<Deployed> {
  const id = on.instructions.programId.toBase58();
  const path = on.builtProgramPath;
  if (!path || !existsSync(path)) {
    throw new Error(
      `${path ?? "BUILT_PROGRAM"} is missing: build it with make check-mainnet DECLARED_ID=${id}. Nothing was sent.`,
    );
  }
  const account = await on.solana.getAccountInfo(
    on.instructions.addresses.programData,
  );
  if (!account?.owner.equals(UPGRADEABLE_LOADER_ID)) {
    throw new Error(
      `No upgradeable program is deployed at ${id}. Nothing was sent.`,
    );
  }
  const deployed = programDataOf(account.data);
  const differs = deployedDiffers(deployed.bytes, readFileSync(path));
  if (differs) throw new Error(`${differs}. Nothing was sent.`);
  return deployed;
}

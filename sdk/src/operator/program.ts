/**
 * The program deployed at a deployment's id, as Solana keeps it: who may
 * upgrade it, and whether its bytes are the mainnet build the operator
 * checked. The upgradeable loader keeps a program's bytes in its program data
 * account after a 45-byte header (the account kind, the slot it was last
 * deployed in and the upgrade authority, if any), padded with zeros to the
 * size reserved for upgrades.
 */
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { PublicKey } from "@solana/web3.js";
import { discriminator } from "../bytes.js";

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

const sha256Hex = (bytes: Uint8Array) => bytesToHex(sha256(bytes));

/** The price-writing instructions whose discriminator `binary` holds. */
export const priceWritersIn = (binary: Uint8Array) =>
  PRICE_WRITERS.filter((name) =>
    Buffer.from(binary).includes(Buffer.from(discriminator(name))),
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
    : `the deployed program (sha256 ${sha256Hex(head)} over the build's length) is not the build (sha256 ${sha256Hex(built)}, ${built.length} bytes)`;
}

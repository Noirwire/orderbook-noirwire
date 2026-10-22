/**
 * Refuses a mainnet build that could write a price or does not declare the
 * program id it was built for: `make check-mainnet` runs it on the build's
 * interface file and binary. The build must have `sync_price` and
 * `sync_quote`, in both, and neither `publish_price` nor `reset_price`, in
 * either: an instruction that is in the binary but left out of the interface
 * file would still run.
 */
import { createHash } from "crypto";
import { readFileSync } from "fs";

type Idl = { address: string; instructions: { name: string }[] };

const PRICE_WRITERS = ["publish_price", "reset_price"];
const PRICE_SYNCS = ["sync_price", "sync_quote"];

const discriminator = (name: string): Buffer =>
  createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);

/** What is wrong with the build, empty when nothing is. */
export function mainnetBuildFaults(
  idl: Idl,
  binary: Buffer,
  declaredId: string,
): string[] {
  const names = idl.instructions.map((instruction) => instruction.name);
  const has = (name: string) => [
    names.includes(name),
    binary.includes(discriminator(name)),
  ];
  return [
    ...PRICE_WRITERS.filter((name) => has(name).some(Boolean)).map(
      (name) => `has ${name}`,
    ),
    ...PRICE_SYNCS.filter((name) => !has(name).every(Boolean)).map(
      (name) => `lacks ${name}`,
    ),
    ...(idl.address === declaredId ? [] : [`declares ${idl.address}`]),
  ];
}

function main(): void {
  const [idlPath, binaryPath, declaredId] = process.argv.slice(2);
  if (!idlPath || !binaryPath || !declaredId) {
    console.error(
      "Usage: mainnet-build.ts <interface file> <program binary> <declared id>",
    );
    process.exit(2);
  }
  const idl = JSON.parse(readFileSync(idlPath, "utf8")) as Idl;
  const binary = readFileSync(binaryPath);
  const faults = mainnetBuildFaults(idl, binary, declaredId);
  if (faults.length > 0) {
    console.error(`The mainnet build ${faults.join(", ")}.`);
    process.exit(1);
  }
  console.log(
    `The mainnet build for ${declaredId} (${binary.length} bytes) has sync_price and sync_quote and no instruction that writes a price.`,
  );
}

if (require.main === module) main();

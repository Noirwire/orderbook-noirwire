import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { Addresses, UPGRADEABLE_LOADER_ID } from "@noirwire/orderbook";
import { deployedDiffers, programDataOf } from "@ops/program";
import { MAINNET_GENESIS, type Network } from "./networks";

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

/**
 * Why the program at the network's id is not the checked mainnet build, or
 * null when it is, byte for byte: the ops scripts' own test before they send
 * (`programDataOf` and `deployedDiffers` in `ops/program.ts`).
 */
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
  let bytes: Uint8Array;
  try {
    bytes = programDataOf(account.data).bytes;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return deployedDiffers(bytes, readFileSync(path));
}

/**
 * On the launch profile or mainnet, why the program there is not the checked
 * build, as the ops scripts refuse to send otherwise; null when it is, and
 * on a test network.
 */
export const launchBuildRefusal = (network: Network, genesis: string) =>
  network.profile === "mainnet" || genesis === MAINNET_GENESIS
    ? buildRefusal(network)
    : Promise.resolve(null);

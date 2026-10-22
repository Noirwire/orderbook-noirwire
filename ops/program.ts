/**
 * The program deployed at a deployment's id, refused unless it is the mainnet
 * build on this machine. Reading the program data account and comparing its
 * bytes are the client's operator functions; this reads the build's file.
 */
import { existsSync, readFileSync } from "fs";
import { UPGRADEABLE_LOADER_ID } from "../sdk/dist/index.js";
import {
  deployedDiffers,
  programDataOf,
  type Deployed,
} from "../sdk/dist/operator/index.js";
import type { Target } from "./deployment";

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

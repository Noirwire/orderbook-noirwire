/**
 * Putting a program file at the program's address the way the upgrade
 * procedure does it: the program account extended when the file is larger than
 * it, then the file written over the old with the upgrade authority. The
 * upgrade story deploys this build over the earlier one, redeploys the earlier
 * build to prove the abort, and deploys this build again.
 */
import { execFileSync } from "child_process";
import { statSync } from "fs";
import { join } from "path";
import { PROGRAM_ID, addresses, solana, until } from "../support";
import { NO_SUCH_INSTRUCTION, refusalOfSetPriceSource } from "./earlier-build";

const UPGRADE_AUTHORITY = join(process.cwd(), ".localnet/admin.json");
/** The earlier build, dumped from the network before anything is deployed over it. */
export const EARLIER_BUILD_FILE = join(
  process.cwd(),
  ".localnet/earlier-build.so",
);
/** The loader's header in front of a program's bytes in its program data account. */
const PROGRAM_DATA_HEADER_LEN = 45;
const EXTEND_HEADROOM_BYTES = 10_000;
const RUNS_THE_PROGRAM_WITHIN_MS = 180_000;

const solanaCli = (...args: string[]) =>
  execFileSync("solana", ["--url", solana.rpcEndpoint, ...args], {
    stdio: "inherit",
  });

/** Writes the program the network runs now to `EARLIER_BUILD_FILE`, the way back an operator keeps. */
export function earlierBuildKept(): void {
  solanaCli("program", "dump", PROGRAM_ID.toBase58(), EARLIER_BUILD_FILE);
}

/** Deploys `file` over the program at its address, extending the account first when the file needs it. */
export async function deployed(file: string): Promise<void> {
  const programData = await solana.getAccountInfo(addresses.programData);
  if (!programData) throw new Error("the program has no program data");
  const missing =
    statSync(file).size - (programData.data.length - PROGRAM_DATA_HEADER_LEN);
  if (missing > 0) {
    solanaCli(
      "program",
      "extend",
      PROGRAM_ID.toBase58(),
      String(missing + EXTEND_HEADROOM_BYTES),
      "--keypair",
      UPGRADE_AUTHORITY,
    );
  }
  solanaCli(
    "program",
    "deploy",
    "--keypair",
    UPGRADE_AUTHORITY,
    "--upgrade-authority",
    UPGRADE_AUTHORITY,
    "--program-id",
    PROGRAM_ID.toBase58(),
    "--use-rpc",
    file,
  );
}

/** Waits until the rollup answers `set_price_source_v2` as the build that has it (this one) or as the build that has not (the earlier one). */
export async function rollupRuns(build: "this" | "earlier"): Promise<void> {
  const answers = build === "this" ? "NotAdmin" : NO_SUCH_INSTRUCTION;
  await until(
    async () => (await refusalOfSetPriceSource()).includes(answers),
    `the rollup to run ${build === "this" ? "this" : "the earlier"} build`,
    RUNS_THE_PROGRAM_WITHIN_MS,
    2_000,
  );
}

/**
 * This build deployed over the earlier one at the program's address, the way
 * the upgrade procedure does it: the program account extended to hold the new
 * build, then the build written over the old with the upgrade authority. Then
 * every account is read again, and none may have changed.
 */
import { execFileSync } from "child_process";
import { statSync } from "fs";
import { join } from "path";
import { expect } from "chai";
import {
  PROGRAM_ID,
  addresses,
  instructions,
  rollup,
  send,
  solana,
  until,
} from "../support";
import { refuses, stranger } from "../orderbook/world";
import {
  BOUND_PERP,
  PERP_MARKETS,
  refusalOfSetPriceSource,
  upgrade,
} from "./earlier-build";
import { PYTH_SOL_FEED_ID, pythPriceAccount } from "./price-fixtures";
import { snapshotOf } from "./snapshot";
import { expectTheStory } from "./story-facts";

const UPGRADE_AUTHORITY = join(process.cwd(), ".localnet/admin.json");
/** The loader's header in front of a program's bytes in its program data account. */
const PROGRAM_DATA_HEADER_LEN = 45;
const EXTEND_HEADROOM_BYTES = 10_000;
const RUNS_THE_NEW_BUILD_WITHIN_MS = 180_000;

const solanaCli = (...args: string[]) =>
  execFileSync("solana", ["--url", solana.rpcEndpoint, ...args], {
    stdio: "inherit",
  });

describe("upgrade: this build deployed over the earlier one", () => {
  it("extends the program account to hold this build, deploys it with the upgrade authority, and the rollup runs it", async () => {
    const built = process.env.UPGRADE_SO;
    if (!built) throw new Error("UPGRADE_SO must name the program to deploy");
    expect(
      await refusalOfSetPriceSource(),
      "the rollup runs the earlier build",
    ).to.include("InstructionDidNotDeserialize");

    const programData = await solana.getAccountInfo(addresses.programData);
    if (!programData) throw new Error("the program has no program data");
    const missing =
      statSync(built).size -
      (programData.data.length - PROGRAM_DATA_HEADER_LEN);
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
      built,
    );

    await until(
      async () => (await refusalOfSetPriceSource()).includes("NotAdmin"),
      "the rollup to run the upgraded program",
      RUNS_THE_NEW_BUILD_WITHIN_MS,
      2_000,
    );
  });

  it("serves every account the story made byte for byte as the earlier build left it", async () => {
    const after = await snapshotOf(
      [upgrade.alice.owner.publicKey, upgrade.bob.owner.publicKey],
      PERP_MARKETS,
    );
    expect([...after.bytes.keys()]).to.deep.equal([
      ...upgrade.before.bytes.keys(),
    ]);
    for (const [name, bytes] of upgrade.before.bytes) {
      expect(after.bytes.get(name)?.equals(bytes), `${name} changed`).to.equal(
        true,
      );
    }
  });

  it("reads what the earlier build wrote as the story left it", async () => {
    const after = await snapshotOf(
      [upgrade.alice.owner.publicKey, upgrade.bob.owner.publicKey],
      PERP_MARKETS,
    );
    expectTheStory(after);
  });

  it("refuses the Pyth account for the market that is bound to it, since the program reads MagicBlock's oracle only", async () => {
    const address = pythPriceAccount(PYTH_SOL_FEED_ID);
    await refuses(
      send(rollup, instructions.syncPrice(BOUND_PERP, address), stranger),
      "WrongPriceAccountOwner",
    );
  });
});

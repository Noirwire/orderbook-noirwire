/**
 * An in-place upgrade on the local network, for `make test-upgrade`. The
 * story has run on an earlier build of the program, loaded at the program's
 * address with the local admin key as its upgrade authority. This deploys
 * the build named by `UPGRADE_SO` over it, at the same address, and waits
 * until the rollup runs the new build. The parts imported after it then run
 * on the state the earlier build made.
 *
 * The new build is told apart by an admin call that writes nothing:
 * `relayout_seats` on an exchange that has not been migrated. The earlier
 * build has no such instruction and refuses it as unknown; the new one
 * refuses it with `RelayoutOutOfOrder`.
 */
import { execFileSync } from "child_process";
import { join } from "path";
import { expect } from "chai";
import {
  PROGRAM_ID,
  admin,
  instructions,
  refusal,
  rollup,
  send,
  solana,
  until,
} from "../support";
import { upgraded } from "../legacy";

const SOLANA_URL = "http://127.0.0.1:8899";
const UPGRADE_AUTHORITY = join(process.cwd(), ".localnet/admin.json");

/**
 * Why the rollup refuses a `relayout_seats` before the exchange is migrated,
 * sent with the new build's addresses: the earlier build has no such
 * instruction.
 */
async function refusedFor(): Promise<string> {
  return refusal(
    send(rollup, instructions.relayoutSeats(admin.publicKey, 1), admin),
  );
}

describe("upgrade in place", () => {
  it("deploys this build over the one the story ran on, and the rollup runs it", async () => {
    const built = process.env.UPGRADE_SO;
    if (!built) throw new Error("UPGRADE_SO must name the program to deploy");
    expect((await solana.getAccountInfo(PROGRAM_ID))?.executable).to.equal(
      true,
    );
    upgraded();
    expect(
      await refusedFor(),
      "the story ran on a build without the relayout",
    ).not.to.include("RelayoutOutOfOrder");

    execFileSync(
      "solana",
      [
        "program",
        "deploy",
        "--url",
        SOLANA_URL,
        "--keypair",
        UPGRADE_AUTHORITY,
        "--upgrade-authority",
        UPGRADE_AUTHORITY,
        "--program-id",
        PROGRAM_ID.toBase58(),
        "--use-rpc",
        built,
      ],
      { stdio: "inherit" },
    );

    await until(
      async () => (await refusedFor()).includes("RelayoutOutOfOrder"),
      "the rollup to run the upgraded program",
      180_000,
      2_000,
    );
  });
});

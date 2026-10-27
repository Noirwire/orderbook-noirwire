import { expect } from "chai";
import { readFileSync } from "fs";
import { join } from "path";
import { PublicKey } from "@solana/web3.js";
import { Instructions, PROGRAM_ID } from "../sdk/dist/index.js";
import { builtInstructions, snapshot } from "./builders";
import { idl } from "./idl";

const flags = (account: { isSigner?: boolean; isWritable?: boolean }) =>
  `${account.isSigner ? "s" : "-"}${account.isWritable ? "w" : "-"}`;

const built = builtInstructions(new Instructions(new PublicKey(idl.address)));

describe("the client's instruction builders", () => {
  it("address the program the interface file names", () => {
    expect(PROGRAM_ID.toBase58()).to.equal(idl.address);
  });

  it("name every account, in the program's order and with its flags, and carry the program's discriminator", () => {
    // The rollup's delegation program calls `process_undelegation`; no client builds it.
    const declared = idl.instructions.filter(
      (instruction) => instruction.name !== "process_undelegation",
    );
    expect(Object.keys(built).sort()).to.deep.equal(
      declared.map((instruction) => instruction.name).sort(),
    );
    for (const instruction of declared) {
      const ours = built[instruction.name];
      expect(
        Array.from(ours.data.subarray(0, 8)),
        instruction.name,
      ).to.deep.equal(instruction.discriminator);
      expect(ours.keys.map(flags), instruction.name).to.deep.equal(
        instruction.accounts.map((account) =>
          flags({ isSigner: account.signer, isWritable: account.writable }),
        ),
      );
    }
  });

  it("build the same accounts and bytes as the recorded snapshot", () => {
    const recorded = JSON.parse(
      readFileSync(
        join(process.cwd(), "tests/fixtures/instructions.golden.json"),
        "utf8",
      ),
    );
    const current = snapshot(built);
    expect(
      Object.fromEntries(
        Object.keys(recorded).map((name) => [name, current[name]]),
      ),
    ).to.deep.equal(recorded);
  });
});

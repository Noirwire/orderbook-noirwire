import { expect } from "chai";
import { readFileSync } from "fs";
import { join } from "path";
import { PublicKey } from "@solana/web3.js";
import { Instructions, PROGRAM_ID } from "../sdk/dist/index.js";
import { builtInstructions, limits, snapshot } from "./builders";
import { decodeArgs, idl } from "./idl";

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

  it("encode every argument as the interface file declares it, field by field and to the last byte", () => {
    const declared = idl.instructions.filter(
      (instruction) => instruction.name !== "process_undelegation",
    );
    for (const instruction of declared) {
      const { exact } = decodeArgs(
        instruction.name,
        built[instruction.name].data,
      );
      expect(exact, instruction.name).to.equal(true);
    }
  });

  it("put the market limits, the price source and the quote source where the program reads them", () => {
    const camel = (name: string) =>
      name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
    const inCamel = (value: unknown) =>
      Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, each]) => [
          camel(key),
          each,
        ]),
      );
    const update = decodeArgs("update_market", built.update_market.data).args;
    expect(update.market_id).to.equal(1);
    expect(inCamel(update.limits)).to.deep.equal(limits);
    const create = decodeArgs("create_market", built.create_market.data).args;
    const settings = create.settings as Record<string, unknown>;
    expect(inCamel(settings.limits)).to.deep.equal(limits);
    expect(inCamel(settings.price_source)).to.deep.equal({
      feed: 6,
      baseDecimals: 9,
      quoteDecimals: 6,
    });
    expect(
      decodeArgs("set_price_source", built.set_price_source.data).args,
    ).to.deep.equal({
      market_id: 1,
      feed: 6,
    });
    expect(
      inCamel(
        decodeArgs("set_quote_source", built.set_quote_source.data).args
          .settings,
      ),
    ).to.deep.equal({ feed: 7, depegBps: 100, maxAge: 180n });
  });

  it("pass the market's MagicBlock price account to sync_price after the market and the price feed, read-only", () => {
    const instructions = new Instructions(new PublicKey(idl.address));
    const oracle = PublicKey.unique();
    const sync = instructions.syncPrice(1, oracle);
    expect(sync.keys).to.have.length(3);
    expect(sync.keys[0]).to.deep.include({ isSigner: false, isWritable: true });
    expect(sync.keys[1]).to.deep.include({ isSigner: false, isWritable: true });
    expect(sync.keys[2]).to.deep.equal({
      pubkey: oracle,
      isSigner: false,
      isWritable: false,
    });
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

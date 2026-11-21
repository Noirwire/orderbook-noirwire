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
      instruction.accounts.forEach((account, index) => {
        if (account.address === undefined) return;
        expect(
          ours.keys[index].pubkey.toBase58(),
          `${instruction.name} ${account.name}`,
        ).to.equal(account.address);
      });
    }
  });

  it("send the scan's first call with the magic program the account is created through, at the address the program fixes", () => {
    const scan = idl.instructions.find(
      (instruction) => instruction.name === "scan_seat_layout",
    )!;
    const magic = scan.accounts.find(
      (account) => account.name === "magic_program",
    );
    expect(magic?.address).to.be.a("string");
    expect(scan.accounts.map((account) => account.name)).to.deep.equal([
      "admin",
      "exchange",
      "ledger",
      "scan",
      "vault",
      "magic_program",
    ]);
    expect(
      built.scan_seat_layout.keys[5].pubkey.toBase58(),
      "the builder's last key",
    ).to.equal(magic?.address);
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
    const update = decodeArgs(
      "update_market_v2",
      built.update_market_v2.data,
    ).args;
    expect(update.market_id).to.equal(1);
    expect(inCamel(update.limits)).to.deep.equal(limits);
    const create = decodeArgs(
      "create_market_v2",
      built.create_market_v2.data,
    ).args;
    const settings = create.settings as Record<string, unknown>;
    expect(inCamel(settings.limits)).to.deep.equal(limits);
    expect(inCamel(settings.price_source)).to.deep.equal({
      feed: 6,
      baseDecimals: 9,
      quoteDecimals: 6,
    });
    expect(
      decodeArgs("set_price_source_v2", built.set_price_source_v2.data).args,
    ).to.deep.equal({
      market_id: 1,
      feed: 6,
    });
    expect(
      inCamel(
        decodeArgs("set_quote_source_v2", built.set_quote_source_v2.data).args
          .settings,
      ),
    ).to.deep.equal({ feed: 7, depegBps: 100, maxAge: 180n });
  });

  it("name the renamed instructions by their new names only, so a call built for an earlier name has no discriminator to match", () => {
    const names = idl.instructions.map(({ name }) => name);
    for (const gone of [
      "set_price_source",
      "set_quote_source",
      "update_market",
      "create_market",
      "reset_slot_generation",
    ]) {
      expect(names, gone).to.not.include(gone);
      expect(Object.keys(built), gone).to.not.include(gone);
    }
    for (const now of [
      "set_price_source_v2",
      "set_quote_source_v2",
      "update_market_v2",
      "create_market_v2",
      "scan_seat_layout",
      "activate_layout",
    ]) {
      expect(names, now).to.include(now);
    }
  });

  it("pass the exchange, read-only, then the market, the price feed and the MagicBlock price account, read-only, to sync_price", () => {
    const instructions = new Instructions(new PublicKey(idl.address));
    const oracle = PublicKey.unique();
    const sync = instructions.syncPrice(1, oracle);
    expect(sync.keys).to.have.length(4);
    expect(sync.keys[0]).to.deep.equal({
      pubkey: instructions.addresses.exchange,
      isSigner: false,
      isWritable: false,
    });
    expect(sync.keys[1]).to.deep.include({ isSigner: false, isWritable: true });
    expect(sync.keys[2]).to.deep.include({ isSigner: false, isWritable: true });
    expect(sync.keys[3]).to.deep.equal({
      pubkey: oracle,
      isSigner: false,
      isWritable: false,
    });
  });

  it("send both key resets to the owner, the view, the exchange and the ledger, with no trigger book and the ledger writable", () => {
    const instructions = new Instructions(new PublicKey(idl.address));
    const owner = PublicKey.unique();
    const keys = [1, 2, 3, 4].map(() => PublicKey.unique());
    for (const reset of [
      instructions.setOrderKeys(owner, keys),
      instructions.setOrderKeysSigned(owner, keys, 0, 1n),
    ]) {
      const last = reset.keys[reset.keys.length - 1];
      expect(last.pubkey.equals(instructions.addresses.ledger)).to.equal(true);
      expect(last.isWritable).to.equal(true);
      expect(
        reset.keys.some((key) =>
          [0, 1, 2, 3].some((id) =>
            key.pubkey.equals(instructions.addresses.triggers(id)),
          ),
        ),
      ).to.equal(false);
    }
    expect(instructions.setOrderKeys(owner, keys).keys).to.have.length(4);
    expect(
      instructions.setOrderKeysSigned(owner, keys, 0, 1n).keys,
    ).to.have.length(5);
  });

  it("derive the layout scan address from its seed, and send the scan with the admin, the exchange, the ledger, the scan and the vault", () => {
    const instructions = new Instructions(new PublicKey(idl.address));
    expect(instructions.addresses.layoutScan.toBase58()).to.equal(
      PublicKey.findProgramAddressSync(
        [Buffer.from("layout-scan")],
        new PublicKey(idl.address),
      )[0].toBase58(),
    );
    const scan = instructions.scanSeatLayout(PublicKey.unique(), 300);
    expect(
      scan.keys[3].pubkey.equals(instructions.addresses.layoutScan),
    ).to.equal(true);
    expect(decodeArgs("scan_seat_layout", scan.data).args).to.deep.equal({
      count: 300,
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

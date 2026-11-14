import { expect } from "chai";
import {
  keepStamping,
  oracleEveryMs,
  oracleRefusal,
  restampRound,
  type OracleRig,
} from "../ops/local-oracle";

type Published = { id: number; price: bigint; time: bigint };

function rigWith(
  marks: Record<number, bigint | null>,
  options: { clock?: () => number; failOn?: number } = {},
): { rig: OracleRig; published: Published[] } {
  const published: Published[] = [];
  const rig: OracleRig = {
    marketIds: async () => Object.keys(marks).map(Number),
    feedOf: async (id) => (marks[id] === null ? null : { price: marks[id]! }),
    clock: async () => (options.clock ?? (() => 1_000))(),
    publish: async (id, price, time) => {
      if (id === options.failOn) throw new Error("endpoint answered 503");
      published.push({ id, price, time });
    },
  };
  return { rig, published };
}

describe("the local oracle", () => {
  it("refuses mainnet, by the network or by the profile", () => {
    expect(oracleRefusal({ profile: "test", mainnet: true })).to.contain(
      "Nothing was sent.",
    );
    expect(oracleRefusal({ profile: "mainnet", mainnet: false })).to.contain(
      "Nothing was sent.",
    );
    expect(oracleRefusal({ profile: "test", mainnet: false })).to.equal(null);
  });

  it("reads its pause as a positive whole number of milliseconds, two seconds by default", () => {
    expect(oracleEveryMs(undefined)).to.equal(2_000);
    expect(oracleEveryMs("500")).to.equal(500);
    for (const value of ["0", "-1", "1.5", "soon", "60001"]) {
      expect(() => oracleEveryMs(value), value).to.throw(
        "LOCAL_ORACLE_EVERY_MS",
      );
    }
  });

  it("refuses a market whose mark is unset, and sends nothing for any market", async () => {
    for (const unset of [null, 0n]) {
      const { rig, published } = rigWith({ 0: 150n, 1: unset });
      let error: Error | null = null;
      await restampRound(rig).catch((caught) => (error = caught));
      expect(error!.message).to.contain("Market 1 has no mark");
      expect(error!.message).to.contain("Nothing was sent.");
      expect(published).to.deep.equal([]);
    }
  });

  it("publishes the mark it finds again, at the newer time", async () => {
    let now = 1_000;
    const { rig, published } = rigWith(
      { 0: 150n, 1: 180n },
      { clock: () => now },
    );
    await restampRound(rig);
    now = 1_002;
    await restampRound(rig);
    expect(published).to.deep.equal([
      { id: 0, price: 150n, time: 1_000n },
      { id: 1, price: 180n, time: 1_000n },
      { id: 0, price: 150n, time: 1_002n },
      { id: 1, price: 180n, time: 1_002n },
    ]);
  });

  it("tries every market when one fails, and names the one that failed", async () => {
    const { rig, published } = rigWith({ 0: 150n, 1: 180n }, { failOn: 0 });
    let error: Error | null = null;
    await restampRound(rig).catch((caught) => (error = caught));
    expect(error!.message).to.equal("market 0: endpoint answered 503");
    expect(published.map(({ id }) => id)).to.deep.equal([1]);
  });

  it("goes on after a failed round, logging each failure once", async () => {
    let rounds = 0;
    const failures: string[] = [];
    const pauses: number[] = [];
    await keepStamping(
      async () => {
        rounds += 1;
        if (rounds === 2) throw new Error("endpoint answered 503");
      },
      2_000,
      (error) => failures.push((error as Error).message),
      async (ms) => {
        pauses.push(ms);
      },
      3,
    );
    expect(rounds).to.equal(3);
    expect(failures).to.deep.equal(["endpoint answered 503"]);
    expect(pauses).to.deep.equal([2_000, 2_000, 2_000]);
  });

  it("stops when a round says the setup is wrong", async () => {
    let error: Error | null = null;
    await keepStamping(
      async () => {
        throw new Error(
          "Market 1 has no mark to publish again. Nothing was sent.",
        );
      },
      2_000,
      () => {},
      async () => {},
      3,
    ).catch((caught) => (error = caught));
    expect(error!.message).to.contain("Nothing was sent.");
  });
});

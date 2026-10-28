import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import { ViewFeed, type Socket } from "../sdk/dist/index.js";
import { sleep } from "../ops/sending";

describe("the view feed", () => {
  const feed = () =>
    new ViewFeed(
      () => {
        throw new Error("no connection is needed");
      },
      Keypair.generate().publicKey,
      () => ({}) as Socket,
    );

  it("waits a negative time without a process warning", async () => {
    const warnings: string[] = [];
    const onWarning = (warning: Error) => warnings.push(warning.name);
    process.on("warning", onWarning);
    try {
      await feed().changed(0, -0.0235);
      await sleep(50);
    } finally {
      process.off("warning", onWarning);
    }
    expect(warnings).to.not.include("TimeoutNegativeWarning");
  });

  it("resolves at once when the state moved on", async () => {
    await feed().changed(-1, 60_000);
  });
});

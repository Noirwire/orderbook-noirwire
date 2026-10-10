import { expect } from "chai";
import { describesTheseMints } from "../ops/deployment";
import { added, perCall, requestsSince, type Requests } from "../ops/requests";
import { median, percentile, spread } from "../ops/stats";

describe("what the ops scripts decide and report, without a network", () => {
  it("takes a description for the exchange's own only when every token's mint is the one it names", () => {
    const previous = {
      tokens: [
        { index: 0, mint: "usd" },
        { index: 1, mint: "sol" },
      ],
    } as Parameters<typeof describesTheseMints>[0];
    const mints = (usd: string, sol: string) => [
      { index: 0, mint: usd },
      { index: 1, mint: sol },
    ];
    expect(describesTheseMints(previous, mints("usd", "sol"))).to.equal(true);
    expect(describesTheseMints(previous, mints("usd", "other"))).to.equal(
      false,
    );
    expect(
      describesTheseMints(previous, [
        ...mints("usd", "sol"),
        { index: 2, mint: "new" },
      ]),
      "a token the description never had",
    ).to.equal(false);
  });

  it("reports the median of an even count as the mean of the middle two, and a percentile as a sample that was measured", () => {
    expect(median([1, 2, 3])).to.equal(2);
    expect(median([1, 2, 3, 10])).to.equal(2.5);
    const hundred = Array.from({ length: 100 }, (_, nth) => nth + 1);
    expect(percentile(hundred, 95)).to.equal(95);
    expect(percentile([7], 95)).to.equal(7);
    expect(percentile([1, 2, 3], 100)).to.equal(3);
    expect(spread([30, 10, 20])).to.equal(
      "median 20 ms, p95 30 ms, worst 30 ms",
    );
  });

  it("counts the requests made since a moment by method, and averages them over the calls", () => {
    const totals: Requests = new Map();
    added(totals, new Map([["sendTransaction", 2]]));
    added(
      totals,
      new Map([
        ["sendTransaction", 2],
        ["getLatestBlockhash", 1],
      ]),
    );
    expect(perCall(totals, 4)).to.equal(
      "1.25 a call (sendTransaction 1.00, getLatestBlockhash 0.25)",
    );
    expect(perCall(new Map(), 4)).to.equal("0.00 a call");
    expect(
      requestsSince(new Map([["neverMade", 3]])).has("neverMade"),
    ).to.equal(false);
  });
});

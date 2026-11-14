import { expect } from "chai";
import {
  firstSyncFailure,
  liquidationGateFailure,
  resumeVerdict,
  type GateReading,
  type PrimaryLimits,
  type ResumeCheck,
} from "../sdk/dist/operator/index.js";
import { removalRefusal } from "../ops/marksource";

describe("a primary price's operator checks", () => {
  describe("the bind preflight", () => {
    const limits: PrimaryLimits = {
      maxPriceAge: 90,
      maxConfBps: 100,
      breakerBps: 400,
      breakerAge: 75,
      liquidationBand: 150,
    };
    const clock = 1_000;
    const obs = (price: bigint, publishTime: number, conf = 0n) => ({
      feedId: "",
      price,
      conf,
      expo: -8,
      publishTime,
    });
    const pyth = obs(8_000_000_000n, clock - 3, 2_000_000n);

    it("refuses a primary that is not stamped after the market's current mark, as the first sync would", () => {
      const primary = obs(8_010_000_000n, clock - 5);
      expect(
        firstSyncFailure(primary, pyth, clock, {
          ...limits,
          markPublishTime: clock - 5,
        }),
      ).to.match(/not after the market's current mark.*PriceTimeWentBackwards/);
      expect(
        firstSyncFailure(primary, pyth, clock, {
          ...limits,
          markPublishTime: clock - 4,
        }),
      ).to.match(/not after the market's current mark/);
      expect(
        firstSyncFailure(primary, pyth, clock, {
          ...limits,
          markPublishTime: clock - 6,
        }),
      ).to.equal(null);
    });

    it("takes a market with no mark yet, and a caller that gives no mark time", () => {
      const primary = obs(8_010_000_000n, clock - 5);
      expect(
        firstSyncFailure(primary, pyth, clock, {
          ...limits,
          markPublishTime: 0,
        }),
      ).to.equal(null);
      expect(firstSyncFailure(primary, pyth, clock, limits)).to.equal(null);
    });
  });

  describe("the liquidation gate the resume check reads", () => {
    const reading: GateReading = {
      markFeed: 6,
      breakerAge: 90,
      liquidationBand: 150,
      mark: 80_000n,
      markPublishTime: 996,
      pyth: { target: 80_050n, publishTime: 990 },
      clock: 1_000,
    };

    it("confirms a fresh Pyth observation within the band", () => {
      expect(liquidationGateFailure(reading)).to.equal(null);
      expect(
        liquidationGateFailure({
          ...reading,
          pyth: { target: 81_200n, publishTime: 910 },
        }),
        "90 s old and 150 bps away is the edge",
      ).to.equal(null);
    });

    it("names each reason it would not confirm", () => {
      const why = (change: Partial<GateReading>) =>
        liquidationGateFailure({ ...reading, ...change });
      expect(why({ pyth: { target: 81_201n, publishTime: 990 } })).to.match(
        /150 bps from the mark, past the liquidation band 150/,
      );
      expect(why({ pyth: { target: 78_000n, publishTime: 990 } })).to.match(
        /250 bps from the mark/,
      );
      expect(why({ pyth: { target: 80_050n, publishTime: 909 } })).to.match(
        /91 s old.*breaker age 90/,
      );
      expect(why({ pyth: { target: 80_050n, publishTime: 1_001 } })).to.match(
        /from the future/,
      );
      expect(why({ pyth: { target: 0n, publishTime: 0 } })).to.match(
        /never read Pyth/,
      );
    });

    it("confirms nothing on a market whose primary was removed until Pyth stamps the mark", () => {
      const removed: GateReading = {
        ...reading,
        markFeed: 0,
        breakerAge: 0,
        liquidationBand: 0,
      };
      expect(liquidationGateFailure(removed)).to.match(
        /taken away.*no sync has replaced it/,
      );
      expect(
        liquidationGateFailure({ ...removed, markPublishTime: 990 }),
      ).to.equal(null);
      expect(
        liquidationGateFailure({
          ...removed,
          pyth: { target: 0n, publishTime: 0 },
        }),
        "a market that never read Pyth is as it was before primary prices",
      ).to.equal(null);
    });
  });

  describe("the resume verdict", () => {
    const check: ResumeCheck = {
      mark: 100_000n,
      reference: 100_000n,
      confirmed: true,
      covered: 1_000n,
      openInterestCap: 1_000n,
      markAge: 3n,
      maxPriceAge: 90n,
      guardPasses: true,
      marketHealthy: true,
      adminUpgrades: false,
      keeperWhy: null,
    };

    it("refuses a resume while the liquidation gate would not confirm the mark", () => {
      expect(resumeVerdict({ ...check, gateWhy: null })).to.deep.equal({
        resume: true,
      });
      expect(
        resumeVerdict(check),
        "a caller that does not read it",
      ).to.deep.equal({ resume: true });
      const refused = resumeVerdict({
        ...check,
        gateWhy:
          "Pyth's latest observation is 120 s old, past the breaker age 90",
      });
      expect(refused.resume).to.equal(false);
      expect(refused)
        .to.have.property("why")
        .that.matches(
          /liquidation gate would not confirm the mark: Pyth's latest observation is 120 s old/,
        );
    });
  });

  describe("taking the primary away", () => {
    it("needs the exchange paused, and only when there is a primary to take", () => {
      const away = { markFeed: 0 };
      expect(removalRefusal(away, { markFeed: 6 }, false)).to.match(
        /needs the exchange paused first/,
      );
      expect(removalRefusal(away, { markFeed: 6 }, true)).to.equal(null);
      expect(removalRefusal(away, { markFeed: 0 }, false)).to.equal(null);
      expect(removalRefusal({ markFeed: 6 }, { markFeed: 6 }, false)).to.equal(
        null,
      );
    });
  });
});

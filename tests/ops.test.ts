import { createHash } from "crypto";
import { readFileSync } from "fs";
import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import {
  FEE_SEAT,
  INSURANCE_SEAT,
  LIQUIDATION_STATUS,
  MARKET_STATUS,
  ORACLE_HEALTH,
  PROGRAM_ID,
  QUOTE_STATE,
  pythPriceAccount,
  type MarketLimits,
  type MarketParams,
  type SourceBinding,
} from "../sdk/dist/index.js";
import {
  MAINNET_INSURANCE,
  MAINNET_LIMITS,
  MAINNET_MARKET,
  MAINNET_PRICE_FEEDS,
  MAINNET_QUOTE_SOURCE,
  MAINNET_SIZING,
  describesTheseMints,
  networkRefusal,
  openInterestCapFor,
  programIdSetting,
} from "../ops/deployment";
import {
  LAUNCH_STEPS,
  RESUME_GAP_BPS,
  atomsOf,
  gapBps,
  launchSteps,
  pendingVerdict,
  refusedOnChain,
  resumeVerdict,
  settingsDiffer,
  smokeRaisesCap,
  smokeRefusal,
  type LaunchObserved,
  type ResumeCheck,
} from "../ops/launch";
import { deployedDiffers, priceWritersIn, programDataOf } from "../ops/program";
import {
  PYTH_HERMES,
  PYTH_PRO,
  SOURCE_TIMEOUT_MS,
  atomsPerLot,
  bitstampPrice,
  coinbasePrice,
  decimalPrice,
  gatherQuotes,
  hermesUrl,
  krakenPrice,
  observationIn,
  proLatest,
  pushDue,
  pushedAccount,
  referenceOf,
  referencePrices,
  referenceSources,
  referenceUrl,
} from "../ops/pyth";
import { added, perCall, requestsSince, type Requests } from "../ops/requests";
import { median, percentile, spread } from "../ops/stats";
import {
  afterOutcome,
  attemptOf,
  endsSweep,
  errorCode,
  givenUp,
  guardIncident,
  marketIncident,
  marketsOwed,
  nameIn,
  positiveInteger,
  refusalOutcome,
  sweepFailed,
  sweepTargets,
  syncDecision,
  withIncident,
  worstPriceFor,
} from "../ops/upkeep";

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const FUNDING_PERIOD = 28_800n;
const MAX_OPEN_INTEREST_CAP = 1n << 24n;
const DAY = 86_400n;

/** RULES 12: every rule `create_market` holds a perp market's limits to, as broken-rule names. */
function rules12Breaches(limits: MarketLimits): string[] {
  const bps = (value: number) => BigInt(value);
  const im = bps(limits.imBps);
  const mm = bps(limits.mmBps);
  const p = bps(limits.liqPenaltyBps);
  const fee = bps(limits.takerFeeBps);
  const band = bps(limits.bandBps);
  const m = bps(limits.maxMoveBps);
  const cap = bps(limits.fundingCapBps);
  const interval = limits.fundingInterval;
  const liquidationAge = limits.maxAgeLiquidation ?? limits.maxPriceAge;
  const openInterestCap = limits.openInterestCap ?? MAX_OPEN_INTEREST_CAP;
  const settle = limits.settleWindow ?? 900n;
  const f = cap * interval;
  const rules: [string, boolean][] = [
    ["0 < mm < im <= 10000", 0n < mm && mm < im && im <= 10_000n],
    ["penalty + fee < mm", p + fee < mm],
    ["0 < band <= im - mm", 0n < band && band <= im - mm],
    ["0 < max move < mm - penalty", 0n < m && m < mm - p],
    ["funding cap <= im - mm", cap <= im - mm],
    ["taker fee <= 100", fee <= 100n],
    [
      "insurance shares <= 10000",
      (limits.liqInsuranceShareBps ?? 0) <= 10_000 &&
        (limits.feeInsuranceShareBps ?? 0) <= 10_000,
    ],
    [
      "0 < max age <= max age liquidation <= a day",
      0n < limits.maxPriceAge &&
        limits.maxPriceAge <= liquidationAge &&
        liquidationAge <= DAY,
    ],
    [
      "0 < open interest cap <= 2^24",
      0n < openInterestCap && openInterestCap <= MAX_OPEN_INTEREST_CAP,
    ],
    [
      "0 < position cap <= 2^24",
      0n < limits.positionCap && limits.positionCap <= MAX_OPEN_INTEREST_CAP,
    ],
    [
      "minimum size, publish gap and open orders above 0",
      limits.minSize > 0n &&
        (limits.minPublishGap ?? 1) > 0 &&
        limits.maxOpenOrders > 0,
    ],
    ["fee >= 1 while funding is on", cap === 0n || fee >= 1n],
    [
      "0 < funding interval <= a funding period",
      0n < interval && interval <= FUNDING_PERIOD,
    ],
    ["funding cap <= 100", cap <= 100n],
    ["band <= 5000", band <= 5_000n],
    ["0 < settle window <= a day", 0n < settle && settle <= DAY],
    [
      "one update and one interval of funding leave a seat at maintenance its penalty",
      f * (10_000n + m) + m * FUNDING_PERIOD * (10_000n + p) <
        (mm - p) * FUNDING_PERIOD * 10_000n,
    ],
  ];
  return rules.filter(([, holds]) => !holds).map(([rule]) => rule);
}

const thousands = (value: number | bigint) =>
  BigInt(value).toLocaleString("en-US");

const nothingDone: LaunchObserved = {
  seatsPerDay: false,
  quoteToken: false,
  ledger: false,
  market: false,
  quoteSource: false,
  quoteRead: false,
  marked: false,
  active: false,
  resumeConfirmed: false,
  funding: false,
  insurance: false,
  custodyCap: false,
  keeper: false,
};

/** A fully verified `PriceUpdateV2` as the receiver lays it out (`programs/noirwire-orderbook/src/pyth.rs`). */
function priceUpdate(
  feedId: Uint8Array,
  price: bigint,
  publishTime: number,
  level = 1,
): Uint8Array {
  const data = new Uint8Array(134);
  const view = new DataView(data.buffer);
  data[40] = level;
  data.set(feedId, 41);
  view.setBigInt64(73, price, true);
  view.setBigUint64(81, 1_000_000n, true);
  view.setInt32(89, -8, true);
  view.setBigInt64(93, BigInt(publishTime), true);
  return data;
}

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

  it("names each mainnet Pyth account at the push oracle's address for its feed id", () => {
    for (const [name, feed] of Object.entries(MAINNET_PRICE_FEEDS)) {
      expect(pythPriceAccount(feed.feedId).toBase58(), name).to.equal(
        feed.account.toBase58(),
      );
    }
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

  it("takes the program id from PROGRAM_ID, and the client's own when it is not set", () => {
    const fresh = Keypair.generate().publicKey;
    expect(programIdSetting(undefined).equals(PROGRAM_ID)).to.equal(true);
    expect(programIdSetting("").equals(PROGRAM_ID)).to.equal(true);
    expect(programIdSetting(fresh.toBase58()).equals(fresh)).to.equal(true);
    expect(() => programIdSetting("not a key")).to.throw();
  });

  it("sends to mainnet only under the mainnet profile and with the program named, and never to a network that is not the one named", () => {
    const programId = Keypair.generate().publicKey.toBase58();
    const on = (
      genesis: string,
      profile: "test" | "mainnet",
      confirmedProgramId: string | undefined,
    ) =>
      networkRefusal({
        network: "rehearsal",
        genesis,
        expectedGenesis:
          genesis === MAINNET_GENESIS ? undefined : DEVNET_GENESIS,
        profile,
        programId,
        confirmedProgramId,
      });
    expect(on(DEVNET_GENESIS, "mainnet", undefined)).to.equal(null);
    expect(on(DEVNET_GENESIS, "test", undefined)).to.equal(null);
    expect(on("another", "mainnet", programId)).to.match(/not rehearsal/);
    expect(on(MAINNET_GENESIS, "test", programId)).to.match(
      /mainnet profile only/,
    );
    expect(on(MAINNET_GENESIS, "mainnet", undefined)).to.include(
      `MAINNET_PROGRAM_ID=${programId}`,
    );
    expect(on(MAINNET_GENESIS, "mainnet", "yes"), "a yes names no program").to
      .not.be.null;
    expect(
      on(MAINNET_GENESIS, "mainnet", Keypair.generate().publicKey.toBase58()),
      "another program",
    ).to.not.be.null;
    expect(on(MAINNET_GENESIS, "mainnet", programId)).to.equal(null);
  });

  it("launches with the settings SECURITY.md states, and they pass every rule of RULES 12", () => {
    const security = readFileSync("SECURITY.md", "utf8").replace(/\s+/g, " ");
    const limits = MAINNET_LIMITS;
    const { settings } = MAINNET_MARKET;
    const stated = [
      `\`im_bps\` ${thousands(limits.imBps)}, with \`mm_bps\` ${limits.mmBps}, \`liq_penalty_bps\` ${limits.liqPenaltyBps}, \`band_bps\` ${limits.bandBps} and \`max_move_bps\` ${limits.maxMoveBps}`,
      `A perp taker fee of ${limits.takerFeeBps} bps`,
      `funding cap kept at ${limits.fundingCapBps} bps per 8 hours`,
      `(\`base_lot\` ${thousands(settings.baseLot)} at ${MAINNET_MARKET.baseDecimals} decimals) and a tick of ${settings.tick} quote atoms per lot`,
      `With ${thousands(MAINNET_INSURANCE / 1_000_000n)} USDC of insurance, a ${MAINNET_SIZING.gapBps / 100n}% gap and a ${limits.liqPenaltyBps / 100}% penalty that is ${thousands(limits.openInterestCap!)} lots`,
      `(\`fee_insurance_share_bps\` = ${thousands(limits.feeInsuranceShareBps!)})`,
      `\`ops/deployment.ts\` holds ${limits.maxPriceAge} and ${limits.maxAgeLiquidation} seconds`,
    ];
    for (const phrase of stated) expect(security, phrase).to.include(phrase);
    expect(limits.openInterestCap).to.equal(111_111n);
    expect(
      limits.positionCap * 5n <= limits.openInterestCap!,
      "a fifth",
    ).to.equal(true);
    expect(limits.imBps).to.equal(2_000, "at most 5x");
    expect(rules12Breaches(limits)).to.deep.equal([]);
    expect(settings.priceSource.feedId).to.deep.equal(
      MAINNET_PRICE_FEEDS.solUsd.feedId,
    );
    expect(MAINNET_QUOTE_SOURCE.feedId).to.deep.equal(
      MAINNET_PRICE_FEEDS.usdcUsd.feedId,
    );
  });

  it("sizes the open interest cap so a planned gap across all of it is covered by insurance", () => {
    const cap = openInterestCapFor(3_000_000_000n, 150_000n, 2_000n, 200n);
    const uncovered = (lots: bigint) => (lots * 150_000n * 1_800n) / 10_000n;
    expect(cap).to.equal(111_111n);
    expect(uncovered(cap) <= 3_000_000_000n, "covered").to.equal(true);
    expect(
      uncovered(cap + 1n) > 3_000_000_000n,
      "one lot more is not",
    ).to.equal(true);
  });

  it("orders the launch: the guard bound before it is synced, insurance before deposits, the keeper before the market opens, and the mark checked just before it does", () => {
    const at = (step: (typeof LAUNCH_STEPS)[number]) =>
      LAUNCH_STEPS.indexOf(step);
    expect(at("quoteSource")).to.be.below(at("syncQuote"));
    expect(at("market")).to.be.below(at("syncPrice"));
    expect(at("syncPrice")).to.be.below(at("checkMark"));
    expect(at("adminFunds")).to.be.below(at("insurance"));
    expect(at("insurance")).to.be.below(at("custodyCap"));
    expect(at("custodyCap")).to.be.below(at("keeper"));
    expect(at("keeper")).to.be.below(at("checkMark"));
    expect(at("checkMark")).to.equal(LAUNCH_STEPS.length - 2);
    expect(at("resume")).to.equal(LAUNCH_STEPS.length - 1);

    expect(launchSteps(nothingDone)).to.deep.equal(
      LAUNCH_STEPS.filter((step) => step !== "resume"),
      "a first run without confirmation leaves the market reduce-only",
    );
    expect(
      launchSteps({ ...nothingDone, resumeConfirmed: true }),
    ).to.deep.equal([...LAUNCH_STEPS]);
  });

  it("skips what a run finds done, and checks the mark on every run until the market is active", () => {
    const launched: LaunchObserved = {
      seatsPerDay: true,
      quoteToken: true,
      ledger: true,
      market: true,
      quoteSource: true,
      quoteRead: true,
      marked: true,
      active: true,
      resumeConfirmed: false,
      funding: true,
      insurance: true,
      custodyCap: true,
      keeper: true,
    };
    expect(launchSteps(launched)).to.deep.equal([]);
    expect(launchSteps({ ...launched, quoteRead: false })).to.deep.equal([
      "syncQuote",
    ]);
    expect(launchSteps({ ...launched, quoteSource: false })).to.deep.equal([
      "quoteSource",
      "syncQuote",
    ]);
    expect(launchSteps({ ...launched, active: false })).to.deep.equal([
      "checkMark",
    ]);
    expect(
      launchSteps({ ...launched, active: false, resumeConfirmed: true }),
    ).to.deep.equal(["checkMark", "resume"]);
    expect(launchSteps({ ...launched, keeper: false })).to.deep.equal([
      "adminFunds",
      "keeper",
    ]);
    expect(launchSteps({ ...launched, custodyCap: false })).to.deep.equal([
      "custodyCap",
    ]);
  });

  it("resumes on a first mark only when confirmed and within 1% of the reference price", () => {
    const check = (
      mark: bigint,
      reference: bigint,
      confirmed = true,
    ): ResumeCheck => ({
      mark,
      reference,
      confirmed,
      covered: 111_111n,
      openInterestCap: 111_111n,
      adminUpgrades: false,
    });
    expect(gapBps(100_000n, 100_000n)).to.equal(0n);
    expect(gapBps(100_001n, 100_000n), "rounded up").to.equal(1n);
    expect(gapBps(99_000n, 100_000n)).to.equal(100n);
    expect(resumeVerdict(check(100_900n, 100_000n))).to.deep.equal({
      resume: true,
    });
    expect(resumeVerdict(check(99_000n, 100_000n))).to.deep.equal({
      resume: true,
    });
    const far = resumeVerdict(check(100_000n * 1_000n, 100_000n));
    expect(far.resume).to.equal(false);
    expect(
      resumeVerdict(check(98_999n, 100_000n)).resume,
      `beyond ${RESUME_GAP_BPS} bps`,
    ).to.equal(false);
    const unconfirmed = resumeVerdict(check(100_000n, 100_000n, false));
    expect(unconfirmed.resume).to.equal(false);
    expect(unconfirmed.resume === false && unconfirmed.why).to.match(
      /RESUME_MARKET=yes/,
    );
    expect(resumeVerdict(check(0n, 100_000n)).resume).to.equal(false);
  });

  it("keeps the market reduce-only at a mark the open interest cap was not sized for, or while the admin can upgrade the program", () => {
    const { gapBps: gap } = MAINNET_SIZING;
    const penalty = BigInt(MAINNET_LIMITS.liqPenaltyBps);
    const cap = MAINNET_LIMITS.openInterestCap!;
    const at = (mark: bigint, adminUpgrades = false) =>
      resumeVerdict({
        mark,
        reference: mark,
        confirmed: true,
        covered: openInterestCapFor(MAINNET_INSURANCE, mark, gap, penalty),
        openInterestCap: cap,
        adminUpgrades,
      });
    expect(at(MAINNET_SIZING.mark)).to.deep.equal({ resume: true });
    expect(at(MAINNET_SIZING.mark - 10_000n)).to.deep.equal({ resume: true });
    const dear = at(250_000n);
    expect(dear.resume).to.equal(false);
    expect(dear.resume === false && dear.why).to.include(
      "insurance covers 66666 lots",
    );
    expect(at(MAINNET_SIZING.mark + 10n).resume, "any mark above").to.equal(
      false,
    );
    const upgradable = at(MAINNET_SIZING.mark, true);
    expect(upgradable.resume).to.equal(false);
    expect(upgradable.resume === false && upgradable.why).to.match(
      /upgrade authority/,
    );
  });

  it("refuses a market found on the network unless every setting, limit and the price source are the launch's", () => {
    const { settings } = MAINNET_MARKET;
    const params = {
      ...settings.limits,
      kind: settings.kind,
      baseToken: settings.baseToken,
      quoteToken: settings.quoteToken,
      tick: settings.tick,
      baseLot: settings.baseLot,
      status: MARKET_STATUS.reduceOnly,
      oracleHealth: ORACLE_HEALTH.healthy,
      uncoveredShortfall: 0n,
      marketId: MAINNET_MARKET.id,
    } as MarketParams;
    const binding: SourceBinding = {
      ...settings.priceSource,
      account: MAINNET_PRICE_FEEDS.solUsd.account,
    };
    expect(settingsDiffer({ params, binding }, settings)).to.deep.equal([]);
    const earlier = {
      ...params,
      imBps: 1_000,
      openInterestCap: 10_000_000n,
      feeInsuranceShareBps: 5_000,
    };
    expect(
      settingsDiffer({ params: earlier, binding }, settings),
    ).to.deep.equal([
      "imBps is 1000, not 2000",
      "openInterestCap is 10000000, not 111111",
      "feeInsuranceShareBps is 5000, not 10000",
    ]);
    const usdcBound = {
      ...binding,
      feedId: MAINNET_PRICE_FEEDS.usdcUsd.feedId,
      baseDecimals: 6,
    };
    const wrongFeed = settingsDiffer({ params, binding: usdcBound }, settings);
    expect(wrongFeed).to.have.length(2);
    expect(wrongFeed[0]).to.match(/^the feed is eaa020/);
    expect(wrongFeed[1]).to.equal("the feed's baseDecimals is 6, not 9");
  });

  it("sends a one-shot step again only when the operator says the pending one was lost, and forgets one the network refused", () => {
    const pending = { state: "pending" as const, at: "then" };
    expect(pendingVerdict(undefined, undefined)).to.equal("send");
    expect(pendingVerdict({ state: "landed", at: "then" }, "lost")).to.equal(
      "done",
    );
    expect(pendingVerdict(pending, undefined)).to.equal("ask");
    expect(pendingVerdict(pending, "yes")).to.equal("ask");
    expect(pendingVerdict(pending, "landed")).to.equal("done");
    expect(pendingVerdict(pending, "lost")).to.equal("send");
    expect(
      refusedOnChain('{"InstructionError":[0,{"Custom":6150}]}\nlogs'),
    ).to.equal(true);
    expect(refusedOnChain('"AccountInUse"\n')).to.equal(true);
    expect(
      refusedOnChain("transaction abc was not confirmed in 60000 ms"),
      "it may still land",
    ).to.equal(false);
    expect(refusedOnChain("fetch failed")).to.equal(false);
  });

  it("smokes mainnet only on its own yes, and never raises a cap there", () => {
    expect(smokeRefusal(false, false)).to.equal(null);
    expect(smokeRefusal(true, false)).to.match(/MAINNET_SMOKE=yes/);
    expect(smokeRefusal(true, true)).to.equal(null);
    expect(smokeRaisesCap({ profile: "mainnet", mainnet: false })).to.equal(
      true,
    );
    expect(smokeRaisesCap({ profile: "mainnet", mainnet: true })).to.equal(
      false,
    );
    expect(smokeRaisesCap({ profile: "test", mainnet: false })).to.equal(false);
  });

  it("refuses a deployed program that is not the checked mainnet build, and reads who may upgrade it", () => {
    const authority = Keypair.generate().publicKey;
    const built = Uint8Array.from({ length: 64 }, (_, nth) => nth + 1);
    const programData = (bytes: Uint8Array, upgradable = true) => {
      const data = new Uint8Array(45 + bytes.length + 16);
      new DataView(data.buffer).setUint32(0, 3, true);
      data[12] = upgradable ? 1 : 0;
      if (upgradable) data.set(authority.toBytes(), 13);
      data.set(bytes, 45);
      return data;
    };
    const deployed = programDataOf(programData(built));
    expect(deployed.upgradeAuthority?.equals(authority)).to.equal(true);
    expect(programDataOf(programData(built, false)).upgradeAuthority).to.equal(
      null,
    );
    expect(() => programDataOf(new Uint8Array(45))).to.throw(/upgradeable/);
    expect(deployedDiffers(deployed.bytes, built)).to.equal(null);
    const other = Uint8Array.from(built, (byte, nth) =>
      nth === 10 ? byte ^ 1 : byte,
    );
    expect(deployedDiffers(deployed.bytes, other)).to.match(/is not the build/);
    const trailing = Uint8Array.from([...deployed.bytes]);
    trailing[trailing.length - 1] = 7;
    expect(deployedDiffers(trailing, built)).to.match(/is not the build/);
    const discriminator = createHash("sha256")
      .update("global:reset_price")
      .digest()
      .subarray(0, 8);
    const testBuild = Uint8Array.from([...built, ...discriminator]);
    expect(priceWritersIn(testBuild)).to.deep.equal(["reset_price"]);
    expect(
      deployedDiffers(programDataOf(programData(testBuild)).bytes, testBuild),
    ).to.match(/test network's build/);
  });

  it("checks the mark against Pyth's own Pro on mainnet, and takes PYTH_PRO_URL only elsewhere", () => {
    expect(referenceUrl(true, undefined)).to.equal(PYTH_PRO);
    expect(referenceUrl(false, "")).to.equal(PYTH_PRO);
    expect(PYTH_PRO).to.equal("https://pyth.dourolabs.app");
    expect(referenceUrl(false, "http://127.0.0.1:9")).to.equal(
      "http://127.0.0.1:9",
    );
    expect(() => referenceUrl(true, "http://127.0.0.1:9")).to.throw(
      /mainnet uses/,
    );
  });

  it("pushes from Pyth's own Hermes on mainnet, and takes HERMES_URL only elsewhere", () => {
    expect(hermesUrl(true, undefined)).to.equal(PYTH_HERMES);
    expect(hermesUrl(false, "")).to.equal(PYTH_HERMES);
    expect(hermesUrl(false, "http://127.0.0.1:9")).to.equal(
      "http://127.0.0.1:9",
    );
    expect(() => hermesUrl(true, "http://127.0.0.1:9")).to.throw(
      /mainnet uses/,
    );
  });

  it("names the Pyth Pro id of each launch feed next to its Pyth Core feed id", () => {
    expect(MAINNET_PRICE_FEEDS.solUsd.proId).to.equal(6);
    expect(MAINNET_PRICE_FEEDS.usdcUsd.proId).to.equal(7);
  });

  it("reads a Pyth Pro answer into the mark's unit, and says where a request was refused without the token", async () => {
    const answer = {
      timestampUs: "1760000000123456",
      priceFeeds: [
        {
          priceFeedId: 6,
          price: "10652292773",
          exponent: -8,
          publisherCount: 20,
        },
        {
          priceFeedId: 7,
          price: "99990000",
          exponent: -8,
          publisherCount: 18,
        },
      ],
    };
    const [sol] = referencePrices(answer, [6]);
    expect(sol).to.deep.equal({
      proId: 6,
      price: 10_652_292_773n,
      expo: -8,
      publisherCount: 20,
      publishTime: 1_760_000_000,
    });
    const lot = {
      baseLot: MAINNET_MARKET.settings.baseLot,
      baseDecimals: MAINNET_MARKET.baseDecimals,
      quoteDecimals: MAINNET_MARKET.settings.priceSource.quoteDecimals,
    };
    expect(atomsPerLot(sol, lot), "$106.52 a SOL, 0.001 SOL a lot").to.equal(
      106_522n,
    );
    expect(
      referencePrices(answer, [7, 6]).map(({ proId }) => proId),
    ).to.deep.equal([7, 6]);
    expect(() => referencePrices(answer, [8])).to.throw(/feed 8/);
    expect(() =>
      referencePrices(
        {
          ...answer,
          priceFeeds: [
            { priceFeedId: 6, price: "0", exponent: -8, publisherCount: 1 },
          ],
        },
        [6],
      ),
    ).to.throw(/is 0/);
    expect(() =>
      referencePrices({ ...answer, priceFeeds: [{ priceFeedId: 6 }] }, [6]),
    ).to.throw(/no price/);

    const asked: { url: string; authorization?: string }[] = [];
    const serving =
      (status: number): typeof fetch =>
      async (url, init) => {
        asked.push({
          url: String(url),
          authorization: (init?.headers as Record<string, string>)
            ?.authorization,
        });
        return new Response(JSON.stringify(answer), { status });
      };
    const got = await proLatest(
      "http://127.0.0.1:9",
      [6, 7],
      "secret-token",
      serving(200),
    );
    expect(got.map(({ publisherCount }) => publisherCount)).to.deep.equal([
      20, 18,
    ]);
    expect(asked[0].url).to.equal(
      "http://127.0.0.1:9/v1/latest_price?price_feed_ids=6&price_feed_ids=7&properties=price&properties=exponent&properties=publisherCount&channel=fixed_rate@200ms",
    );
    expect(asked[0].authorization).to.equal("Bearer secret-token");

    const refusal = (asking: Promise<unknown>) =>
      asking.then(
        () => "",
        (error: Error) => error.message,
      );
    const unauthorized = await refusal(
      proLatest("http://127.0.0.1:9", [6], undefined, serving(401)),
    );
    expect(asked[1].authorization, "no token, no header").to.equal(undefined);
    expect(unauthorized).to.match(/answered 401/);
    expect(unauthorized).to.include("PYTH_PRO_TOKEN");

    const broken = await refusal(
      proLatest("http://127.0.0.1:9", [6], "secret-token", serving(500)),
    );
    expect(broken).to.match(/answered 500/);
    expect(broken).to.not.include("PYTH_PRO_TOKEN");
    expect(broken).to.not.include("secret-token");
  });

  describe("the reference price from public exchanges", () => {
    const lot = {
      baseLot: MAINNET_MARKET.settings.baseLot,
      baseDecimals: MAINNET_MARKET.baseDecimals,
      quoteDecimals: MAINNET_MARKET.settings.priceSource.quoteDecimals,
    };
    const coinbase = {
      ask: "106.5",
      bid: "106.49",
      trade_id: 358401017,
      price: "106.5",
    };
    const kraken = {
      error: [],
      result: { SOLUSD: { c: ["106.50000", "2.22301417"], o: "106.43000" } },
    };
    const bitstamp = { timestamp: "1792571155", last: "106.492", side: "1" };

    it("reads each exchange's last trade as a decimal, and refuses anything else", () => {
      expect(coinbasePrice(coinbase)).to.deep.equal({
        price: 1065n,
        expo: -1,
      });
      expect(krakenPrice(kraken)).to.deep.equal({
        price: 10_650_000n,
        expo: -5,
      });
      expect(bitstampPrice(bitstamp)).to.deep.equal({
        price: 106_492n,
        expo: -3,
      });
      expect(
        atomsPerLot(coinbasePrice(coinbase), lot),
        "$106.50 a SOL, 0.001 SOL a lot",
      ).to.equal(106_500n);
      expect(atomsPerLot(bitstampPrice(bitstamp), lot)).to.equal(106_492n);

      for (const bad of [
        undefined,
        null,
        "106.5",
        {},
        { price: 106.5 },
        { price: "" },
        { price: "0" },
        { price: "0.00" },
        { price: "-1.5" },
        { price: "1e2" },
        { price: "NaN" },
        { price: "106.5 " },
      ]) {
        expect(() => coinbasePrice(bad), JSON.stringify(bad)).to.throw();
      }
      expect(() => bitstampPrice({ price: "106.5" })).to.throw(/decimal/);
      expect(() => decimalPrice("1".repeat(19))).to.throw(/decimal/);

      expect(() =>
        krakenPrice({ error: ["EQuery:Unknown asset pair"], result: {} }),
      ).to.throw(/Unknown asset pair/);
      expect(() => krakenPrice({ error: [], result: {} })).to.throw(/0 pairs/);
      expect(() =>
        krakenPrice({ error: [], result: { A: kraken.result.SOLUSD, B: {} } }),
      ).to.throw(/2 pairs/);
      expect(() =>
        krakenPrice({ error: [], result: { SOLUSD: { c: [] } } }),
      ).to.throw(/decimal/);
      expect(() =>
        krakenPrice({ error: [], result: { SOLUSD: { c: [106.5] } } }),
      ).to.throw(/decimal/);
      expect(() => krakenPrice("down")).to.throw();
    });

    const agreed = (...atoms: number[]) =>
      referenceOf(atoms.map((value) => ({ atoms: BigInt(value) })));

    it("takes the median of the answering sources, the mean rounded down for two, and needs two", () => {
      expect(agreed(106_500, 106_492, 106_520)).to.equal(106_500n);
      expect(
        agreed(106_520, 106_500, 106_492),
        "order does not matter",
      ).to.equal(106_500n);
      expect(
        agreed(106_500, 106_492, 5_000),
        "one wild source is outvoted",
      ).to.equal(106_492n);
      expect(agreed(106_500, 106_493)).to.equal(106_496n);
      expect(agreed(106_500, 106_500)).to.equal(106_500n);
      expect(
        agreed(106_500, 106_492, 106_520, 106_480),
        "four: the middle two",
      ).to.equal(106_496n);
      expect(() => agreed()).to.throw(/0 reference sources answered/);
      expect(() => agreed(106_500)).to.throw(/1 reference source answered/);
    });

    it("refuses two sources more than 1% apart, and accepts exactly 1%", () => {
      expect(() => agreed(100_000, 101_001)).to.throw(/more than 100 bps/);
      expect(agreed(100_000, 101_000)).to.equal(100_500n);
      expect(() => agreed(106_500, 10_650), "a decimal slip").to.throw(
        /more than 100 bps/,
      );
      expect(
        () => agreed(100_000, 100_100, 110_000, 111_000),
        "four split in two: the middle two disagree",
      ).to.throw(/more than 100 bps/);
      expect(() => agreed(0, 106_500, 106_500)).to.throw(/not positive/);
    });

    const serving =
      (
        answers: Record<string, unknown>,
        asked: { url: string; signal?: AbortSignal | null }[] = [],
      ): typeof fetch =>
      async (url, init) => {
        asked.push({ url: String(url), signal: init?.signal });
        const key = Object.keys(answers).find((host) =>
          String(url).includes(host),
        );
        if (key === undefined) throw new Error("connection refused");
        const answer = answers[key];
        if (typeof answer === "number") {
          return new Response("{}", { status: answer });
        }
        return new Response(
          typeof answer === "string" ? answer : JSON.stringify(answer),
          { status: 200 },
        );
      };
    const pro = {
      url: "http://127.0.0.1:9",
      proId: 6,
      token: "secret-token",
    };
    const proAnswer = {
      timestampUs: "1760000000123456",
      priceFeeds: [
        {
          priceFeedId: 6,
          price: "10650000000",
          exponent: -8,
          publisherCount: 20,
        },
      ],
    };
    const all = {
      "api.exchange.coinbase.com": coinbase,
      "api.kraken.com": kraken,
      "www.bitstamp.net": bitstamp,
    };

    it("asks the three exchanges with a 10 s limit each, and Pyth Pro too only with a token", async () => {
      expect(SOURCE_TIMEOUT_MS).to.equal(10_000);
      const asked: { url: string; signal?: AbortSignal | null }[] = [];
      const absent = await gatherQuotes(
        referenceSources(lot, undefined, serving(all, asked)),
      );
      expect(
        absent.quotes.map(({ name, atoms }) => [name, atoms]),
      ).to.deep.equal([
        ["Coinbase", 106_500n],
        ["Kraken", 106_500n],
        ["Bitstamp", 106_492n],
      ]);
      expect(absent.skipped).to.deep.equal([]);
      expect(asked.map(({ url }) => url)).to.deep.equal([
        "https://api.exchange.coinbase.com/products/SOL-USD/ticker",
        "https://api.kraken.com/0/public/Ticker?pair=SOLUSD",
        "https://www.bitstamp.net/api/v2/ticker/solusd/",
      ]);
      for (const { signal } of asked)
        expect(signal).to.be.instanceOf(AbortSignal);
      expect(referenceOf(absent.quotes)).to.equal(106_500n);

      const noToken = referenceSources(
        lot,
        { ...pro, token: "" },
        serving(all),
      );
      expect(noToken.map(({ name }) => name)).to.deep.equal([
        "Coinbase",
        "Kraken",
        "Bitstamp",
      ]);

      const present = await gatherQuotes(
        referenceSources(
          lot,
          pro,
          serving({ ...all, "127.0.0.1": proAnswer }, asked),
        ),
      );
      expect(present.quotes.map(({ name }) => name)).to.deep.equal([
        "Coinbase",
        "Kraken",
        "Bitstamp",
        "Pyth Pro",
      ]);
      const proQuote = present.quotes[3];
      expect(proQuote.atoms).to.equal(106_500n);
      expect(proQuote.note).to.match(/^20 publishers, published \d+ s ago$/);
      expect(referenceOf(present.quotes), "four: the middle two").to.equal(
        106_500n,
      );
      expect(proQuote.note).to.not.include("secret-token");
    });

    it("skips a source that is down, malformed or slow, and still stands on two", async () => {
      const one = await gatherQuotes(
        referenceSources(
          lot,
          undefined,
          serving({ ...all, "api.kraken.com": 503 }),
        ),
      );
      expect(one.quotes.map(({ name }) => name)).to.deep.equal([
        "Coinbase",
        "Bitstamp",
      ]);
      expect(one.skipped).to.deep.equal([
        { name: "Kraken", why: "Kraken answered 503" },
      ]);
      expect(referenceOf(one.quotes)).to.equal(106_496n);

      const refused = await gatherQuotes(
        referenceSources(
          lot,
          undefined,
          serving({
            "api.exchange.coinbase.com": coinbase,
            "api.kraken.com": kraken,
          }),
        ),
      );
      expect(refused.skipped).to.deep.equal([
        { name: "Bitstamp", why: "connection refused" },
      ]);

      const malformed = await gatherQuotes(
        referenceSources(
          lot,
          undefined,
          serving({
            "api.exchange.coinbase.com": "<html>blocked</html>",
            "api.kraken.com": { error: ["EGeneral:Too many requests"] },
            "www.bitstamp.net": bitstamp,
          }),
        ),
      );
      expect(malformed.quotes.map(({ name }) => name)).to.deep.equal([
        "Bitstamp",
      ]);
      expect(malformed.skipped.map(({ name }) => name)).to.deep.equal([
        "Coinbase",
        "Kraken",
      ]);
      expect(() => referenceOf(malformed.quotes)).to.throw(
        /1 reference source answered, 2 needed/,
      );

      const timedOut: typeof fetch = async (url, init) => {
        if (String(url).includes("kraken")) {
          throw new DOMException("The operation timed out", "TimeoutError");
        }
        return serving(all)(url, init);
      };
      const slow = await gatherQuotes(
        referenceSources(lot, undefined, timedOut),
      );
      expect(slow.skipped).to.deep.equal([
        { name: "Kraken", why: "The operation timed out" },
      ]);
    });

    it("stands on the exchanges alone when Pyth Pro's trial is over, and outvotes a wrong source", async () => {
      const lapsed = await gatherQuotes(
        referenceSources(lot, pro, serving({ ...all, "127.0.0.1": 401 })),
      );
      expect(lapsed.quotes).to.have.length(3);
      expect(lapsed.skipped).to.have.length(1);
      expect(lapsed.skipped[0].name).to.equal("Pyth Pro");
      expect(lapsed.skipped[0].why).to.match(/answered 401/);
      expect(lapsed.skipped[0].why).to.not.include("secret-token");
      expect(referenceOf(lapsed.quotes)).to.equal(106_500n);

      const wrongKraken = await gatherQuotes(
        referenceSources(
          lot,
          undefined,
          serving({
            ...all,
            "api.kraken.com": {
              error: [],
              result: { SOLUSD: { c: ["10.65", "1"] } },
            },
          }),
        ),
      );
      expect(referenceOf(wrongKraken.quotes)).to.equal(106_492n);
    });
  });

  it("takes counts and pauses as positive whole numbers only", () => {
    expect(positiveInteger("N", undefined, 6)).to.equal(6);
    expect(positiveInteger("N", "", 6)).to.equal(6);
    expect(positiveInteger("N", "12", 6)).to.equal(12);
    for (const wrong of ["abc", "0", "-1", "1.5", "1e3", " 3"]) {
      expect(() => positiveInteger("N", wrong, 6), wrong).to.throw(
        /not a positive whole number/,
      );
    }
    expect(() => positiveInteger("KEEPER_SEATS", undefined, null)).to.throw(
      /Set KEEPER_SEATS/,
    );
  });

  it("reads whole tokens from a variable as atoms, and refuses anything else", () => {
    expect(atomsOf(undefined, 6)).to.equal(null);
    expect(atomsOf("", 6)).to.equal(null);
    expect(atomsOf("5000", 6)).to.equal(5_000_000_000n);
    expect(() => atomsOf("1.5", 6)).to.throw(/whole number/);
    expect(() => atomsOf("-1", 6)).to.throw(/whole number/);
  });

  it("reads a fully verified Pyth price account as the program does and scales it to quote atoms per lot", () => {
    const feedId = MAINNET_PRICE_FEEDS.solUsd.feedId;
    const observation = observationIn(
      priceUpdate(feedId, 10_385_000_000n, 1_700_000_000),
    );
    expect(observation).to.deep.include({
      feedId: Buffer.from(feedId).toString("hex"),
      price: 10_385_000_000n,
      expo: -8,
      publishTime: 1_700_000_000,
    });
    expect(
      observationIn(priceUpdate(feedId, 1n, 1, 0)),
      "partially verified",
    ).to.equal(null);
    expect(observationIn(new Uint8Array(133)), "the wrong size").to.equal(null);
    const lot = {
      baseLot: MAINNET_MARKET.settings.baseLot,
      baseDecimals: 9,
      quoteDecimals: 6,
    };
    expect(
      atomsPerLot({ price: 10_385_000_000n, expo: -8 }, lot),
      "RULES 9's example",
    ).to.equal(103_850n);
    expect(atomsPerLot({ price: 15_000_000_000n, expo: -8 }, lot)).to.equal(
      150_000n,
    );
    expect(
      atomsPerLot({ price: 10_385_999_999n, expo: -8 }, lot),
      "rounded down",
    ).to.equal(103_859n);
  });

  it("posts Hermes updates by Pyth's mainnet rules: a 55 s heartbeat or a 0.5% move, never an older observation", () => {
    const held = { price: 100_000n, publishTime: 1_000 };
    expect(pushDue(null, held)).to.equal(true);
    expect(pushDue(held, { price: 100_000n, publishTime: 1_054 })).to.equal(
      false,
    );
    expect(pushDue(held, { price: 100_000n, publishTime: 1_055 })).to.equal(
      true,
    );
    expect(pushDue(held, { price: 100_500n, publishTime: 1_001 })).to.equal(
      true,
    );
    expect(pushDue(held, { price: 99_501n, publishTime: 1_001 })).to.equal(
      false,
    );
    expect(
      pushDue(held, { price: 200_000n, publishTime: 1_000 }),
      "not newer",
    ).to.equal(false);
  });

  it("pushes to the very account the program reads: the push oracle's shard 0 for each feed id", async () => {
    for (const [name, feed] of Object.entries(MAINNET_PRICE_FEEDS)) {
      const feedId = Buffer.from(feed.feedId).toString("hex");
      expect((await pushedAccount(feedId)).toBase58(), name).to.equal(
        pythPriceAccount(feed.feedId).toBase58(),
      );
    }
  });

  it("syncs a source only for a newer observation, and calls an observation older than its max age stale", () => {
    expect(syncDecision(null, 0, 1_000, 90)).to.equal("unreadable");
    expect(syncDecision(990, 980, 1_000, 90)).to.equal("send");
    expect(syncDecision(980, 980, 1_000, 90)).to.equal("unchanged");
    expect(
      syncDecision(909, 900, 1_000, 90),
      "newer, but too old for the program",
    ).to.equal("stale");
    expect(syncDecision(910, 910, 1_000, 90)).to.equal("unchanged");
  });

  it("tells a sync another crank beat from one the program refused", () => {
    const failed = (code: number) =>
      `{"InstructionError":[0,{"Custom":${code}}]}\nProgram log: ...`;
    expect(errorCode(failed(6070))).to.equal(6070);
    expect(errorCode("timed out")).to.equal(null);
    expect(refusalOutcome(failed(6070)), "not newer").to.equal("raced");
    expect(refusalOutcome(failed(6073)), "too soon after the mark").to.equal(
      "raced",
    );
    expect(refusalOutcome(failed(6079))).to.equal("stale");
    expect(refusalOutcome(failed(6080)), "confidence too wide").to.equal(
      "refused",
    );
    expect(refusalOutcome("transaction was not confirmed")).to.equal("refused");
  });

  it("counts failures in a row per source, so a healthy feed does not hide one that keeps failing", () => {
    let streaks = new Map<string, number>();
    const step = (
      source: string,
      outcome: Parameters<typeof afterOutcome>[2],
    ) => {
      streaks = afterOutcome(streaks, source, outcome);
    };
    step("guard", "stale");
    step("market 0", "synced");
    step("guard", "refused");
    step("market 0", "synced");
    expect(givenUp(streaks, 3)).to.equal(null);
    step("guard", "unreadable");
    expect(givenUp(streaks, 3)).to.equal("guard");
    step("guard", "raced");
    expect(
      streaks.get("guard"),
      "a crank that was beaten did not fail",
    ).to.equal(0);
    step("market 0", "unchanged");
    expect(streaks.get("market 0")).to.equal(0);
  });

  it("counts a sync that leaves a price incident open as a failure, however it was sent", () => {
    expect(marketIncident(ORACLE_HEALTH.healthy)).to.equal(null);
    expect(marketIncident(ORACLE_HEALTH.dislocated)).to.equal("dislocated");
    expect(marketIncident(ORACLE_HEALTH.settling)).to.equal("settling");
    expect(guardIncident(QUOTE_STATE.healthy)).to.equal(null);
    expect(guardIncident(QUOTE_STATE.depegged)).to.equal("depegged");
    expect(withIncident("synced", null)).to.equal("synced");
    expect(withIncident("synced", "dislocated")).to.equal("dislocated");
    expect(withIncident("raced", "settling")).to.equal("settling");
    expect(withIncident("stale", "dislocated"), "a failure stays").to.equal(
      "stale",
    );
    let streaks = new Map<string, number>();
    for (let round = 0; round < 3; round += 1) {
      streaks = afterOutcome(
        streaks,
        "market 0",
        withIncident("synced", "settling"),
      );
    }
    expect(givenUp(streaks, 3)).to.equal("market 0");
    expect(nameIn(MARKET_STATUS, MARKET_STATUS.reduceOnly)).to.equal(
      "reduceOnly",
    );
    expect(nameIn(ORACLE_HEALTH, 9)).to.equal("9");
  });

  it("fails a sweep on a failed send or a liquidatable seat its margin could not take", () => {
    expect(sweepFailed(new Map([["nothing to liquidate", 40]]))).to.equal(
      false,
    );
    expect(sweepFailed(new Map([["liquidated", 1]]))).to.equal(false);
    expect(sweepFailed(new Map([["failed", 1]]))).to.equal(true);
    expect(sweepFailed(new Map([["margin insufficient", 1]]))).to.equal(true);
  });

  it("sweeps every trader seat but its own, at the mark, which takes a long or a short target alike", () => {
    const targets = sweepTargets(8, 4);
    expect(targets).to.deep.equal([2, 3, 5, 6, 7]);
    expect(targets).to.not.include(FEE_SEAT);
    expect(targets).to.not.include(INSURANCE_SEAT);
    expect(sweepTargets(2, 9)).to.deep.equal([]);
    const mark = 150_000n;
    const penalty = (mark * 200n + 9_999n) / 10_000n;
    const worst = worstPriceFor(mark);
    expect(
      mark - penalty <= worst,
      "a long target's price is not above it",
    ).to.equal(true);
    expect(
      mark + penalty >= worst,
      "a short target's price is not below it",
    ).to.equal(true);
    expect(
      mark <= worst && mark >= worst,
      "a bankrupt target is taken at the mark",
    ).to.equal(true);
  });

  it("ends a market's sweep on a stale price, which every seat would read, and covers only markets that record a shortfall", () => {
    expect(attemptOf(LIQUIDATION_STATUS.liquidated)).to.equal("liquidated");
    expect(attemptOf(LIQUIDATION_STATUS.nothingToLiquidate)).to.equal(
      "nothing to liquidate",
    );
    expect(attemptOf(LIQUIDATION_STATUS.liquidatorMarginInsufficient)).to.equal(
      "margin insufficient",
    );
    expect(endsSweep(attemptOf(LIQUIDATION_STATUS.stalePrice))).to.equal(true);
    expect(endsSweep("liquidated")).to.equal(false);
    expect(endsSweep("nothing to liquidate")).to.equal(false);
    expect(
      marketsOwed([
        { id: 0, uncoveredShortfall: 0n },
        { id: 1, uncoveredShortfall: 5n },
      ]),
    ).to.deep.equal([1]);
  });
});

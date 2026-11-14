import { createHash } from "crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { expect } from "chai";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  ACCOUNT_LEN,
  ACCOUNT_TAG,
  FEE_SEAT,
  INSURANCE_SEAT,
  Instructions,
  LIQUIDATION_STATUS,
  MARKET_ACCESS,
  MARKET_STATUS,
  MAGICBLOCK_ORACLE_ID,
  MAX_FIRES_PER_PASS,
  MAX_OWNER_EXPIRY_AHEAD,
  ORACLE_HEALTH,
  OrderKeyManager,
  PROGRAM_ID,
  QUOTE_STATE,
  RECONCILE_SEATS_PER_CALL,
  RESULT_STATUS,
  SIDE,
  SWEEP_TRIGGER_SLOTS_PER_CALL,
  deriveOrderKey,
  ownerProofInstruction,
  magicblockPriceAccount,
  verifyOwnerSignature,
  type MarketLimits,
  type MarketParams,
  type SourceBinding,
} from "../sdk/dist/index.js";
import {
  LAUNCH_STEPS,
  RESUME_GAP_BPS,
  accessCommand,
  accessRequest,
  deployedDiffers,
  gapBps,
  launchSteps,
  marketsIn,
  priceWritersIn,
  programDataOf,
  resumeVerdict,
  seatAccessInstructions,
  settingsDiffer,
  switchesOf,
  switchesText,
  type LaunchObserved,
  type ResumeCheck,
} from "../sdk/dist/operator/index.js";
import {
  CUSTODY_CAP_REACHED,
  NO_SEAT,
  depositFailure,
  faucetDescriptionRefusal,
  faucetRefusal,
  fundRefusal,
  fundRequest,
  fundingAtoms,
  mintRefusal,
  wholeTokens,
  withFaucet,
} from "../ops/funding";
import {
  acceptSteps,
  adminRefusal,
  nominationRefusal,
  upgradeAuthorityCheck,
  upgradeAuthorityCommand,
  upgradeAuthorityNotes,
  upgradeAuthorityRefusal,
} from "../ops/handover";
import {
  exitRequest,
  handBackStep,
  heldRefusal,
  isStaleMark,
  returnShortfall,
  rollupBalanceStep,
  roundTripDepositFailure,
  roundTripLoss,
  roundTripRefusal,
  roundTripRequest,
  sealedBalanceRefusal,
  SOLANA_EXIT_LAMPORTS,
  solanaFeePayer,
  tokenAtoms,
} from "../ops/exiting";
import {
  pauseRefusal,
  pauseRequest,
  statusCode,
  statusRefusal,
  statusRequest,
} from "../ops/administering";
import { limitsChange, limitsRequest } from "../ops/limits";
import { lotsCovered } from "../ops/market";
import { rebindRefusal, rebindRequest } from "../ops/pricesource";
import {
  runTriggerBooks,
  triggerBookRequest,
  triggerBookStateOf,
  type TriggerBookState,
} from "../ops/triggerbooks";
import {
  gateRefusal,
  makerRefusal,
  quoteRefusal,
  seatDepositFailure,
  seatRequest,
  withdrawRefusal,
} from "../ops/seating";
import {
  DEFAULT_INSURANCE_USDC,
  MAINNET_MARKET,
  MAINNET_USDC_MINT,
  MAINNET_PRICE_FEEDS,
  MAINNET_QUOTE_SOURCE,
  MAINNET_SIZING,
  MIN_INSURANCE_USDC,
  type DeploymentDescription,
  describesTheseMints,
  launchInsurance,
  launchMarket,
  mainnetLimits,
  networkRefusal,
  errorLine,
  openInterestCapFor,
  programIdSetting,
  withoutUrls,
} from "../ops/deployment";
import {
  FLOAT_TOP_UP_MAX_SOL,
  atomsOf,
  floatDelegationRefusal,
  floatTopUpRequest,
  insuranceAtMost,
  insuranceHeldRefusal,
  insuranceSizing,
  keeperDepositFailure,
  keeperDepositRefusal,
  keeperDepositedAs,
  keeperDepositFor,
  keeperSeatOwner,
  keeperShortfall,
  keeperTopUpRequest,
  leftAsFound,
  markcheckSays,
  pendingVerdict,
  recordId,
  refusedOnChain,
  requiredKeeperDeposit,
  restorableStep,
  smokeRefusal,
  withKeeperTopUp,
  type SentRecord,
} from "../ops/launch";
import {
  SOURCE_TIMEOUT_MS,
  atomsPerLot,
  bitstampPrice,
  checkedObservation,
  coinbasePrice,
  decimalPrice,
  firstSyncFailure,
  gatherQuotes,
  krakenPrice,
  observationIn,
  referenceOf,
  referenceSources,
} from "../sdk/dist/operator/index.js";
import { CustodyUnreadable, custodyHeld, keeperWatched } from "../ops/keeping";
import {
  heldKey,
  keepOrderKeys,
  loadOrderKeyCheckpoint,
  orderKeysFor,
  saveOrderKeyCheckpoint,
} from "../ops/keys";
import { added, perCall, requestsSince, type Requests } from "../ops/requests";
import { median, percentile, spread } from "../ops/stats";
import {
  HEARTBEAT_TIMEOUT_MS,
  heartbeatFile,
  heartbeatTo,
  heartbeatUrl,
} from "../ops/heartbeat";
import {
  MAX_BACKOFF_MS,
  SetupError,
  afterOutcome,
  afterFire,
  attemptOf,
  backoffMs,
  emptySeatRefusal,
  endsSweep,
  errorCode,
  givenUp,
  guardIncident,
  keeperLiveWindowMs,
  keeperNotReady,
  keeperWrote,
  marginAlert,
  marketIncident,
  marketsOwed,
  FIRE_EVERY_MS,
  marketsToFire,
  mayPing,
  nameIn,
  passDeadlineSeconds,
  passIsSlow,
  passSteps,
  positiveInteger,
  stillOwed,
  reconcileCalls,
  U32_MAX,
  refusalOutcome,
  releaseDue,
  restOfRange,
  roundErrorKind,
  roundWasGood,
  seatRanges,
  slotsFullAlert,
  staleSince,
  staleTooLong,
  startUntilSettled,
  sweepFailed,
  syncDecision,
  unwindAlert,
  unwindOrder,
  unwindPrice,
  withDeadline,
  withIncident,
  worstPriceFor,
} from "../ops/upkeep";
import {
  DRILLS,
  DRILL_ERRORS,
  bookFunding,
  closingTrade,
  drillRefusal,
  drillsSelected,
  exitCodeFor,
  fundingReset,
  guardTrips,
  lineText,
  orderAttempt,
  quoteMoved,
  refusedWith,
  staleWait,
  syncWaitsOn,
  taken,
  unlessSyncedMeanwhile,
  unproven,
  type Attempt,
} from "../ops/drilling";
import { mainnetBuildFaults } from "../ops/mainnet-build";
import { markchecked } from "../ops/markchecking";
import { upgradeAuthorityCheckLine } from "../ops/handover";
import { ROUND_TRIP_LAMPORTS, seatWithdrawalUnconfirmed } from "../ops/exiting";
import { insuranceRecorded, sentBookPath } from "../ops/deployment";
import {
  UnreadableInsurance,
  custodyText,
  insuranceFirstSendRefusal,
  keeperCollateralFloor,
  keeperFloorRefusal,
} from "../ops/launch";
import { ORDER_KEY_SEARCH_BOUND, checkpointAlert } from "../ops/keys";
import { dustAlert, sweepHealthy } from "../ops/upkeep";
import { ORDER_KEYS } from "../sdk/dist/index.js";
import {
  markOf,
  perpMarketCount,
  perpMarkets,
  seatCapacity,
} from "../ops/keeper-reads";
import {
  AccountWatch,
  RollupClock,
  Wakeup,
  type Reads,
  type Socket,
} from "../ops/watching";
import {
  KEEPER_SIGNATURE_HEADER,
  afterSweep,
  keeperStatusSettings,
  serveKeeperStatus,
  signStatus,
  statusReply,
  type SweepRecord,
} from "../ops/keeper-status";
import {
  afterSilence,
  configuredEveryMs,
  CRANK_DELAY_SPAN_MS,
  crankEveryMs,
  crankPhaseMs,
  failingSince,
  resendDue,
  roundLineDue,
  type Silent,
  type Standing,
} from "../ops/upkeep";
import { base58Of, sendOnSolana, SettledOnSolana } from "../ops/sending";
import {
  exitOperation,
  readExit,
  seatPendingRefusal,
  seatVerdict,
  solanaPendingRefusal,
  solanaVerdict,
  writeExit,
  type ExitOperation,
  type SolanaSend,
} from "../ops/exitbook";
import { reconciledSolana } from "../ops/leaving";
import { GATE_LOW_SOL, gateBalanceLine } from "../ops/exchange";
import { errorCode as idlErrorCode } from "./idl";
import {
  OWNER_ERRORS,
  INVALID_OWNER_PROOF,
  OWNER_EXPIRY_TOO_FAR,
  PROOF_LIFETIME_SECONDS,
  TOO_FAR_SECONDS,
  WRONG_OWNER_NONCE,
  WRONG_WITHDRAW_DESTINATION,
  fundingAmount,
  refusalName,
  refusalVerdict,
  sameKeys,
  stepLine,
  tamperedSignatureVerdict,
  withFlippedSignatureByte,
} from "../ops/owner-acting";
import nacl from "tweetnacl";

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
      "0 < max age <= a day",
      0n < limits.maxPriceAge && limits.maxPriceAge <= DAY,
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

const USDC = 1_000_000n;
const DEFAULT_INSURANCE = DEFAULT_INSURANCE_USDC * USDC;

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
  keeper: false,
  launched: false,
  restore: null,
};

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

  it("names each mainnet price account at MagicBlock's address for its feed number", () => {
    expect(MAINNET_PRICE_FEEDS.solUsd.feed).to.equal(6);
    expect(MAINNET_PRICE_FEEDS.usdcUsd.feed).to.equal(7);
    expect(MAINNET_PRICE_FEEDS.solUsd.account.toBase58()).to.equal(
      "ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu",
    );
    for (const [name, feed] of Object.entries(MAINNET_PRICE_FEEDS)) {
      expect(magicblockPriceAccount(feed.feed).toBase58(), name).to.equal(
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

  it("needs the genesis named, and runs each network and profile only on the chain it belongs to", () => {
    const programId = Keypair.generate().publicKey.toBase58();
    const refused = (
      network: string,
      genesis: string,
      expectedGenesis: string | undefined,
      profile: "test" | "mainnet",
      confirmedProgramId: string | undefined = programId,
    ) =>
      networkRefusal({
        network,
        genesis,
        expectedGenesis,
        profile,
        programId,
        confirmedProgramId,
      });
    expect(
      refused("mainnet", DEVNET_GENESIS, undefined, "mainnet"),
      "the mainnet profile on devnet with no GENESIS",
    ).to.match(/GENESIS is not set/);
    expect(refused("rehearsal", DEVNET_GENESIS, undefined, "mainnet")).to.match(
      /GENESIS is not set/,
    );
    expect(
      refused("mainnet", DEVNET_GENESIS, DEVNET_GENESIS, "mainnet"),
      "NETWORK=mainnet on devnet",
    ).to.match(/only NETWORK=mainnet runs on mainnet/);
    expect(
      refused("rehearsal", MAINNET_GENESIS, MAINNET_GENESIS, "mainnet"),
      "a rehearsal on mainnet",
    ).to.match(/only NETWORK=mainnet runs on mainnet/);
    expect(
      refused("devnet", DEVNET_GENESIS, DEVNET_GENESIS, "mainnet"),
    ).to.match(/mainnet profile runs on mainnet and its rehearsal only/);
    expect(refused("localnet", "a-local-genesis", "local", "mainnet")).to.match(
      /mainnet profile runs on mainnet and its rehearsal only/,
    );
    expect(refused("localnet", "a-local-genesis", "local", "test")).to.equal(
      null,
    );
    for (const publicGenesis of [MAINNET_GENESIS, DEVNET_GENESIS]) {
      expect(
        refused("localnet", publicGenesis, "local", "test"),
        "GENESIS=local on a public cluster",
      ).to.match(/public cluster/);
    }
    expect(refused("devnet", DEVNET_GENESIS, DEVNET_GENESIS, "test")).to.equal(
      null,
    );
    expect(
      refused("mainnet", MAINNET_GENESIS, MAINNET_GENESIS, "mainnet"),
    ).to.equal(null);
  });

  it("sends to mainnet only under the mainnet profile and with the program named, and never to a network that is not the one named", () => {
    const programId = Keypair.generate().publicKey.toBase58();
    const on = (
      genesis: string,
      profile: "test" | "mainnet",
      confirmedProgramId: string | undefined,
    ) =>
      networkRefusal({
        network: genesis === MAINNET_GENESIS ? "mainnet" : "rehearsal",
        genesis,
        expectedGenesis:
          genesis === MAINNET_GENESIS ? MAINNET_GENESIS : DEVNET_GENESIS,
        profile,
        programId,
        confirmedProgramId,
      });
    expect(on(DEVNET_GENESIS, "mainnet", undefined)).to.equal(null);
    expect(
      networkRefusal({
        network: "devnet",
        genesis: DEVNET_GENESIS,
        expectedGenesis: DEVNET_GENESIS,
        profile: "test",
        programId,
      }),
    ).to.equal(null);
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
    const limits = mainnetLimits(DEFAULT_INSURANCE);
    const { settings } = MAINNET_MARKET;
    const stated = [
      `\`im_bps\` ${thousands(limits.imBps)}, with \`mm_bps\` ${limits.mmBps}, \`liq_penalty_bps\` ${limits.liqPenaltyBps}, \`band_bps\` ${limits.bandBps} and \`max_move_bps\` ${limits.maxMoveBps}`,
      `A perp taker fee of ${limits.takerFeeBps} bps`,
      `funding cap kept at ${limits.fundingCapBps} bps per 8 hours`,
      `(\`base_lot\` ${thousands(settings.baseLot)} at ${MAINNET_MARKET.baseDecimals} decimals) and a tick of ${settings.tick} quote atoms per lot`,
      `With ${thousands(DEFAULT_INSURANCE_USDC)} USDC of insurance, a ${MAINNET_SIZING.gapBps / 100n}% gap and a ${limits.liqPenaltyBps / 100}% penalty that is ${thousands(limits.openInterestCap!)} lots`,
      `(\`fee_insurance_share_bps\` = ${thousands(limits.feeInsuranceShareBps!)})`,
      `\`ops/deployment.ts\` holds ${limits.maxPriceAge} seconds`,
    ];
    for (const phrase of stated) expect(security, phrase).to.include(phrase);
    expect(limits.openInterestCap).to.equal(111_111n);
    expect(
      limits.positionCap * 5n <= limits.openInterestCap!,
      "a fifth",
    ).to.equal(true);
    expect(limits.imBps).to.equal(2_000, "at most 5x");
    expect(rules12Breaches(limits)).to.deep.equal([]);
    expect(settings.priceSource.feed).to.equal(MAINNET_PRICE_FEEDS.solUsd.feed);
    expect(MAINNET_QUOTE_SOURCE.feed).to.equal(
      MAINNET_PRICE_FEEDS.usdcUsd.feed,
    );
    expect(limits.maxPriceAge).to.equal(10n);
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

  it("takes the insurance a launch funds from INSURANCE_USDC: 3,000 by default, never under 300, and the amount the deployment recorded once it funded", () => {
    expect(launchInsurance(undefined, undefined)).to.equal(3_000n * USDC);
    expect(launchInsurance("", undefined), "empty is unset").to.equal(
      3_000n * USDC,
    );
    expect(launchInsurance("500", undefined)).to.equal(500n * USDC);
    expect(launchInsurance("300", undefined), "the floor itself").to.equal(
      MIN_INSURANCE_USDC * USDC,
    );
    expect(() => launchInsurance("299", undefined)).to.throw(
      "INSURANCE_USDC is 299, under the launch's floor of 300 USDC: give 300 or more. Nothing was sent.",
    );
    expect(() => launchInsurance("0", undefined)).to.throw(/floor of 300/);
    for (const bad of ["500.5", "-500", "5e2", "$500", "500 "]) {
      expect(() => launchInsurance(bad, undefined), bad).to.throw(
        /give a whole number of USDC, 300 or more\. Nothing was sent\./,
      );
    }
    const funded = (500n * USDC).toString();
    expect(launchInsurance(undefined, funded), "the record alone").to.equal(
      500n * USDC,
    );
    expect(launchInsurance("500", funded), "the same figure").to.equal(
      500n * USDC,
    );
    expect(() => launchInsurance("3000", funded)).to.throw(
      "This deployment funded 500 USDC of insurance, and its caps were sized from that, not from INSURANCE_USDC=3000. Run with INSURANCE_USDC=500, or leave it out. Nothing was sent.",
    );
    expect(
      launchInsurance(undefined, (3_000n * USDC).toString()),
      "a deployment funded at the default keeps it",
    ).to.equal(3_000n * USDC);
  });

  it("sizes a smaller launch's caps by the same formula, and holds a market to the caps of the launch it was made for", () => {
    const small = 500n * USDC;
    const { gapBps: gap, mark } = MAINNET_SIZING;
    const limits = mainnetLimits(small);
    const cap = openInterestCapFor(
      small,
      mark,
      gap,
      BigInt(limits.liqPenaltyBps),
    );
    expect(limits.openInterestCap).to.equal(cap);
    expect(cap).to.equal(18_518n);
    expect(limits.positionCap).to.equal(cap / 5n);
    expect(rules12Breaches(limits)).to.deep.equal([]);
    expect(
      rules12Breaches(mainnetLimits(MIN_INSURANCE_USDC * USDC)),
      "the floor",
    ).to.deep.equal([]);
    expect(mainnetLimits(MIN_INSURANCE_USDC * USDC).openInterestCap).to.equal(
      11_111n,
    );
    expect({ ...limits, openInterestCap: 0n, positionCap: 0n }).to.deep.equal({
      ...mainnetLimits(DEFAULT_INSURANCE),
      openInterestCap: 0n,
      positionCap: 0n,
    });
    expect(launchMarket(small).settings.limits).to.deep.equal(limits);

    const wanted = launchMarket(small).settings;
    const binding: SourceBinding = {
      ...wanted.priceSource,
      expo: -8,
      account: MAINNET_PRICE_FEEDS.solUsd.account,
    };
    const found = (insurance: bigint) =>
      ({
        ...mainnetLimits(insurance),
        kind: wanted.kind,
        baseToken: wanted.baseToken,
        quoteToken: wanted.quoteToken,
        tick: wanted.tick,
        baseLot: wanted.baseLot,
        status: MARKET_STATUS.reduceOnly,
        oracleHealth: ORACLE_HEALTH.healthy,
        uncoveredShortfall: 0n,
        marketId: MAINNET_MARKET.id,
      }) as MarketParams;
    expect(
      settingsDiffer({ params: found(small), binding }, wanted),
    ).to.deep.equal([]);
    expect(
      settingsDiffer({ params: found(DEFAULT_INSURANCE), binding }, wanted),
      "a market sized for the default insurance is too large for a 500 USDC launch",
    ).to.deep.equal(["openInterestCap is 111111, above the launch's 18518"]);
  });

  it("orders the launch: the guard bound before it is synced, insurance before deposits, the keeper before the market opens, and the mark checked just before it does", () => {
    const at = (step: (typeof LAUNCH_STEPS)[number]) =>
      LAUNCH_STEPS.indexOf(step);
    expect(at("quoteSource")).to.be.below(at("syncQuote"));
    expect(at("market")).to.be.below(at("syncPrice"));
    expect(at("syncPrice")).to.be.below(at("checkMark"));
    expect(at("adminFunds")).to.be.below(at("insurance"));
    expect(at("insurance")).to.be.below(at("keeper"));
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
      keeper: true,
      launched: false,
      restore: null,
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
  });

  it("once the market has opened, leaves the seats a day, the USDC guard and the market's status as the admin set them, unless one is named", () => {
    const afterLaunch: LaunchObserved = {
      seatsPerDay: false,
      quoteToken: true,
      ledger: true,
      market: true,
      quoteSource: false,
      quoteRead: false,
      marked: true,
      active: false,
      resumeConfirmed: true,
      funding: true,
      insurance: true,
      keeper: true,
      launched: true,
      restore: null,
    };
    expect(
      launchSteps(afterLaunch),
      "a paused market, a seat cap of 0 and a rebound guard stay; a leftover RESUME_MARKET=yes resumes nothing",
    ).to.deep.equal([]);
    expect(leftAsFound(afterLaunch)).to.deep.equal([
      "seatsPerDay",
      "quoteSource",
      "resume",
    ]);
    expect(
      launchSteps({ ...afterLaunch, restore: "seatsPerDay" }),
    ).to.deep.equal(["seatsPerDay"]);
    expect(
      launchSteps({ ...afterLaunch, restore: "quoteSource" }),
    ).to.deep.equal(["quoteSource", "syncQuote"]);
    expect(launchSteps({ ...afterLaunch, restore: "resume" })).to.deep.equal([
      "checkMark",
      "resume",
    ]);
    expect(leftAsFound({ ...afterLaunch, restore: "resume" })).to.deep.equal([
      "seatsPerDay",
      "quoteSource",
    ]);
    expect(
      leftAsFound({ ...afterLaunch, launched: false }),
      "before launch the steps write them",
    ).to.deep.equal([]);
    expect(launchSteps({ ...afterLaunch, launched: false })).to.include.members(
      ["seatsPerDay", "quoteSource", "checkMark", "resume"],
    );
    expect(restorableStep(undefined)).to.equal(null);
    expect(restorableStep("resume")).to.equal("resume");
    expect(() => restorableStep("seatsPerDay,resume")).to.throw(/one step/);
    expect(() => restorableStep("yes")).to.throw(/RESTORE/);
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
      keeperWhy: null,
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
    const limits = mainnetLimits(DEFAULT_INSURANCE);
    const penalty = BigInt(limits.liqPenaltyBps);
    const cap = limits.openInterestCap!;
    const at = (mark: bigint, adminUpgrades = false) =>
      resumeVerdict({
        mark,
        reference: mark,
        confirmed: true,
        covered: openInterestCapFor(DEFAULT_INSURANCE, mark, gap, penalty),
        openInterestCap: cap,
        adminUpgrades,
        keeperWhy: null,
      });
    expect(at(MAINNET_SIZING.mark)).to.deep.equal({ resume: true });
    expect(at(MAINNET_SIZING.mark - 10_000n)).to.deep.equal({ resume: true });
    const dear = at(250_000n);
    expect(dear.resume).to.equal(false);
    expect(dear.resume === false && dear.why).to.include(
      "insurance covers 66666 lots",
    );
    expect(dear.resume === false && dear.why).to.include(
      "lower open_interest_cap to at most 66666 with update_market",
    );
    expect(
      resumeVerdict({
        mark: 250_000n,
        reference: 250_000n,
        confirmed: true,
        covered: openInterestCapFor(DEFAULT_INSURANCE, 250_000n, gap, penalty),
        openInterestCap: 66_666n,
        adminUpgrades: false,
        keeperWhy: null,
      }),
      "the cap lowered as the refusal says",
    ).to.deep.equal({ resume: true });
    expect(at(MAINNET_SIZING.mark + 10n).resume, "any mark above").to.equal(
      false,
    );
    const upgradable = at(MAINNET_SIZING.mark, true);
    expect(upgradable.resume).to.equal(false);
    expect(upgradable.resume === false && upgradable.why).to.match(
      /upgrade authority/,
    );
  });

  it("refuses a market found on the network unless every setting, limit and the price source are the launch's, the caps at most the launch's", () => {
    const { settings } = launchMarket(DEFAULT_INSURANCE);
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
      expo: -8,
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
      "feeInsuranceShareBps is 5000, not 10000",
      "openInterestCap is 10000000, above the launch's 111111",
    ]);
    const resized = {
      ...params,
      openInterestCap: 66_666n,
      positionCap: 66_666n,
    };
    expect(
      settingsDiffer({ params: resized, binding }, settings),
      "a cap lowered for a dearer mark, and the lone maker's cap raised to it",
    ).to.deep.equal([]);
    expect(
      settingsDiffer(
        { params: { ...resized, positionCap: 66_667n }, binding },
        settings,
      ),
    ).to.deep.equal([
      "positionCap is 66667, above the open interest cap of 66666",
    ]);
    const usdcBound = {
      ...binding,
      feed: MAINNET_PRICE_FEEDS.usdcUsd.feed,
      account: MAINNET_PRICE_FEEDS.usdcUsd.account,
      baseDecimals: 6,
    };
    expect(
      settingsDiffer({ params, binding: usdcBound }, settings),
    ).to.deep.equal([
      `the price account is ${MAINNET_PRICE_FEEDS.usdcUsd.account.toBase58()}, not ${MAINNET_PRICE_FEEDS.solUsd.account.toBase58()}`,
      "the feed's feed is 7, not 6",
      "the feed's baseDecimals is 6, not 9",
    ]);
  });

  it("sends a one-shot step again only when the operator says that very pending record was lost, and forgets one the network refused", () => {
    const pending = { state: "pending" as const, at: "then", id: "a1b2c3d4" };
    expect(pendingVerdict(undefined, undefined)).to.equal("send");
    expect(
      pendingVerdict({ state: "landed", at: "then" }, "lost:then"),
    ).to.equal("done");
    expect(pendingVerdict(pending, undefined)).to.equal("ask");
    expect(pendingVerdict(pending, "yes")).to.equal("ask");
    expect(pendingVerdict(pending, "landed"), "names no record").to.equal(
      "ask",
    );
    expect(pendingVerdict(pending, "lost"), "names no record").to.equal("ask");
    expect(pendingVerdict(pending, "landed:a1b2c3d4")).to.equal("done");
    expect(pendingVerdict(pending, "lost:a1b2c3d4")).to.equal("send");
    const resent = { state: "pending" as const, at: "later", id: "e5f6a7b8" };
    expect(
      pendingVerdict(resent, "lost:a1b2c3d4"),
      "the answer about the earlier record does not send again",
    ).to.equal("ask");
    expect(
      pendingVerdict(
        { state: "pending", at: "2026-10-21T10:00:00.000Z" },
        "lost:2026-10-21T10:00:00.000Z",
      ),
      "a record written before records had an id is named by its time",
    ).to.equal("send");
    expect(recordId(pending)).to.equal("a1b2c3d4");

    const insurance = 3_000_000_000n;
    const heldRefusal = (held: bigint | null, answer?: string) =>
      insuranceHeldRefusal(held, insurance, answer, "INSURANCE_SENT");
    expect(heldRefusal(null), "sealed").to.equal(null);
    expect(heldRefusal(0n)).to.equal(null);
    expect(heldRefusal(insurance - 1n)).to.equal(null);
    const refused = heldRefusal(insurance, "lost:a1b2c3d4");
    expect(refused).to.include("INSURANCE_SENT=held:3000000000");
    expect(refused).to.include("Nothing was sent.");
    expect(heldRefusal(insurance, "held:3000000000")).to.equal(null);
    expect(
      heldRefusal(insurance + 1n, "held:3000000000"),
      "the answer stops counting once the balance moves",
    ).to.not.equal(null);
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

  it("requires the keeper's deposit, takes a higher one as a top-up and refuses only a lower one", () => {
    expect(() => requiredKeeperDeposit(null)).to.throw(
      /KEEPER_DEPOSIT is not set.*Nothing was sent\./,
    );
    expect(() => requiredKeeperDeposit(0n)).to.throw(
      /KEEPER_DEPOSIT is not set/,
    );
    expect(requiredKeeperDeposit(200_000_000n)).to.equal(200_000_000n);
    expect(keeperDepositRefusal(undefined, 200_000_000n)).to.equal(null);
    expect(keeperDepositRefusal("200000000", 200_000_000n)).to.equal(null);
    expect(
      keeperDepositRefusal("200000000", 300_000_000n),
      "a higher figure is a top-up",
    ).to.equal(null);
    const refused = keeperDepositRefusal("300000000", 200_000_000n);
    expect(refused).to.include("deposited 300 USDC");
    expect(refused).to.include("KEEPER_DEPOSIT=200");
    expect(refused).to.include("run with KEEPER_DEPOSIT=300");
    expect(refused).to.include("Nothing was sent.");
  });

  it("tops the keeper's seat up by the difference, once, and finds a top-up that landed before its record was written", () => {
    const wanted = 300_000_000n;
    expect(keeperShortfall(undefined, wanted, 0n), "first deposit").to.equal(
      wanted,
    );
    expect(
      keeperShortfall(undefined, wanted, 120_000_000n),
      "no record yet: what the view shows",
    ).to.equal(180_000_000n);
    expect(
      keeperShortfall("200000000", wanted, 0n),
      "recorded: the difference, whatever the stale view shows",
    ).to.equal(100_000_000n);
    expect(keeperShortfall("300000000", wanted, 0n)).to.equal(0n);
    expect(keeperShortfall("400000000", wanted, 0n)).to.equal(0n);

    const landed = (total?: string): SentRecord => ({
      state: "landed",
      at: "t",
      ...(total === undefined ? {} : { total }),
    });
    expect(keeperDepositedAs(undefined, undefined, wanted)).to.equal(undefined);
    expect(keeperDepositedAs("200000000", undefined, wanted)).to.equal(
      "200000000",
    );
    expect(
      keeperDepositedAs("200000000", landed("300000000"), wanted),
      "the top-up landed and the description was not written: the record's total",
    ).to.equal("300000000");
    expect(
      keeperDepositedAs("400000000", landed("300000000"), wanted),
      "never lowers a recorded figure",
    ).to.equal("400000000");
    expect(
      keeperDepositedAs(undefined, landed(), wanted),
      "a record from before totals, with nothing recorded",
    ).to.equal("300000000");
    expect(
      keeperDepositedAs("200000000", landed(), wanted),
      "a record without a total says nothing about a top-up",
    ).to.equal("200000000");
    expect(
      keeperDepositedAs(
        "200000000",
        { state: "pending", at: "t", id: "ab", total: "300000000" },
        wanted,
      ),
      "a pending send is not a deposit",
    ).to.equal("200000000");
  });

  it("takes a top-up from a funded wallet for the keeper's own seat, and names what went wrong", () => {
    const keeper = Keypair.generate().publicKey;
    const other = Keypair.generate().publicKey;
    expect(() => keeperTopUpRequest({ AMOUNT: "50" })).to.throw(
      /Set KEYFILE.*not the admin's.*Nothing was sent\./,
    );
    expect(() => keeperTopUpRequest({ KEYFILE: "w.json" })).to.throw(
      /Set AMOUNT/,
    );
    expect(() =>
      keeperTopUpRequest({ KEYFILE: "w.json", AMOUNT: "0" }),
    ).to.throw(/whole number of tokens above zero/);
    expect(() =>
      keeperTopUpRequest({ KEYFILE: "w.json", AMOUNT: "5", KEEPER: "nope" }),
    ).to.throw(/not a public key/);
    expect(
      keeperTopUpRequest({ KEYFILE: "w.json", AMOUNT: "50" }),
    ).to.deep.equal({ keyFile: "w.json", tokens: 50n, keeper: null });
    expect(
      keeperTopUpRequest({
        KEYFILE: "w.json",
        AMOUNT: "50",
        KEEPER: keeper.toBase58(),
      }).keeper?.equals(keeper),
    ).to.equal(true);

    expect(keeperSeatOwner(keeper, null, "k.json").equals(keeper)).to.equal(
      true,
    );
    expect(keeperSeatOwner(null, keeper, "k.json").equals(keeper)).to.equal(
      true,
    );
    expect(keeperSeatOwner(keeper, keeper, "k.json").equals(keeper)).to.equal(
      true,
    );
    expect(() => keeperSeatOwner(null, null, "k.json")).to.throw(
      /not on this machine \(k\.json\).*give KEEPER.*Nothing was sent\./,
    );
    expect(() => keeperSeatOwner(keeper, other, "k.json")).to.throw(
      /one of them is not the keeper's.*Nothing was sent\./,
    );

    const failed = (code: number) =>
      `{"InstructionError":[0,{"Custom":${code}}]}\nProgram log`;
    expect(
      keeperDepositFailure(failed(CUSTODY_CAP_REACHED), keeper).message,
    ).to.match(
      /cannot hold more of this token.*stays in the wallet's balance/s,
    );
    expect(keeperDepositFailure(failed(NO_SEAT), keeper).message).to.include(
      keeper.toBase58(),
    );
    expect(keeperDepositFailure(failed(6038), keeper).message).to.equal(
      `The deposit was refused: ${failed(6038)}`,
    );

    const description = {
      programId: "P1",
      keeperDeposited: "200000000",
    } as DeploymentDescription;
    expect(
      withKeeperTopUp(description, "P1", 50_000_000n)?.keeperDeposited,
    ).to.equal("250000000");
    expect(description.keeperDeposited, "the original is not changed").to.equal(
      "200000000",
    );
    expect(withKeeperTopUp(description, "P2", 1n), "another program").to.equal(
      null,
    );
    expect(withKeeperTopUp(null, "P1", 1n)).to.equal(null);
    expect(
      withKeeperTopUp({ programId: "P1" } as DeploymentDescription, "P1", 1n),
      "no keeper deposit recorded",
    ).to.equal(null);
  });

  it("takes a float top-up in SOL from a funded wallet, up to the most one sends", () => {
    expect(() => floatTopUpRequest({ AMOUNT: "1" })).to.throw(
      /Set KEYFILE.*Nothing was sent\./,
    );
    expect(() => floatTopUpRequest({ KEYFILE: "w.json" })).to.throw(
      /Set AMOUNT to the SOL/,
    );
    expect(() =>
      floatTopUpRequest({ KEYFILE: "w.json", AMOUNT: "0" }),
    ).to.throw(/not an amount above zero/);
    expect(() =>
      floatTopUpRequest({ KEYFILE: "w.json", AMOUNT: "0.0000000001" }),
    ).to.throw(/more decimal places/);
    expect(() =>
      floatTopUpRequest({ KEYFILE: "w.json", AMOUNT: "5.000000001" }),
    ).to.throw(/more than the 5 one top-up sends/);
    expect(
      floatTopUpRequest({ KEYFILE: "w.json", AMOUNT: "1.1" }),
    ).to.deep.equal({
      keyFile: "w.json",
      lamports: 1_100_000_000n,
    });
    expect(
      floatTopUpRequest({
        KEYFILE: "w.json",
        AMOUNT: `${FLOAT_TOP_UP_MAX_SOL}`,
      }).lamports,
    ).to.equal(5_000_000_000n);
  });

  it("sends a float top-up only while the exchange is delegated to this rollup", () => {
    const rollup = Keypair.generate().publicKey;
    const other = Keypair.generate().publicKey;
    expect(floatDelegationRefusal(rollup, rollup)).to.equal(null);
    expect(floatDelegationRefusal(other, rollup)).to.match(
      /delegated to .*, not to this rollup .*Nothing was sent\./,
    );
    expect(floatDelegationRefusal(null, rollup)).to.match(
      /not delegated to a rollup.*Nothing was sent\./,
    );
  });

  it("sizes the cover from no more than public custody can show beyond the keeper's seat", () => {
    const funded = 3_000_000_000n;
    const keeper = 200_000_000n;
    expect(insuranceAtMost(funded, null, keeper), "sealed custody").to.equal(
      funded,
    );
    expect(insuranceAtMost(funded, funded + keeper, keeper)).to.equal(funded);
    expect(
      insuranceAtMost(funded, funded + keeper + 1_000_000_000n, keeper),
      "other seats' deposits never raise it above what was funded",
    ).to.equal(funded);
    expect(insuranceAtMost(funded, funded + keeper - 1n, keeper)).to.equal(
      funded - 1n,
    );
    expect(insuranceAtMost(funded, 1_000_000_000n, keeper)).to.equal(
      800_000_000n,
    );
    expect(
      insuranceAtMost(funded, 100_000_000n, keeper),
      "below the keeper's",
    ).to.equal(0n);
    expect(insuranceAtMost(funded, 0n, 0n)).to.equal(0n);
  });

  it("lets the operator's figure from the console lower the insurance the cover is sized from, never raise it", () => {
    const funded = 3_000_000_000n;
    const keeper = 200_000_000n;
    expect(insuranceAtMost(funded, null, keeper, null)).to.equal(funded);
    expect(
      insuranceAtMost(funded, null, keeper, 1_200_000_000n),
      "a deficit insurance paid, read from the console",
    ).to.equal(1_200_000_000n);
    expect(
      insuranceAtMost(funded, null, keeper, 9_000_000_000n),
      "more than funded changes nothing",
    ).to.equal(funded);
    expect(
      insuranceAtMost(funded, 1_000_000_000n, keeper, 2_000_000_000n),
      "more than custody shows changes nothing",
    ).to.equal(800_000_000n);
    expect(
      insuranceAtMost(funded, 1_000_000_000n, keeper, 500_000_000n),
    ).to.equal(500_000_000n);
    expect(insuranceAtMost(funded, null, keeper, 0n)).to.equal(0n);
  });

  describe("custody the hosted rollup does not serve", () => {
    const funded = 3_000_000_000n;
    const keeper = 200_000_000n;
    const tokenAccount = (amount: bigint, size = 165) => {
      const data = Buffer.alloc(size);
      if (size >= 72) data.writeBigUInt64LE(amount, 64);
      return data;
    };
    const serving = (data: Buffer | null) =>
      ({ getAccountInfo: async () => (data ? { data } : null) }) as never;
    const account = Keypair.generate().publicKey;

    it("reads custody strictly: not served and too short are errors, never 0", async () => {
      let thrown: unknown;
      try {
        await custodyHeld(serving(null), account);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).to.be.instanceOf(CustodyUnreadable);
      expect((thrown as Error).message).to.include("does not serve");
      thrown = undefined;
      try {
        await custodyHeld(serving(tokenAccount(5n, 71)), account);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).to.be.instanceOf(CustodyUnreadable);
      expect((thrown as Error).message).to.include("too short");
    });

    it("reads the amount of a served token account, 0 included", async () => {
      expect(
        await custodyHeld(serving(tokenAccount(3_200_000_000n)), account),
      ).to.equal(3_200_000_000n);
      expect(await custodyHeld(serving(tokenAccount(0n)), account)).to.equal(
        0n,
      );
    });

    it("refuses to size the cover from unreadable custody without the console's figure", () => {
      let thrown: Error | undefined;
      try {
        insuranceSizing(funded, "unreadable", keeper, null);
      } catch (error) {
        thrown = error as Error;
      }
      expect(thrown?.message).to.include(
        "does not serve the custody token account",
      );
      expect(thrown?.message).to.include("no resume is safe");
      expect(thrown?.message).to.include("INSURANCE_HELD=<whole USDC>");
      expect(thrown?.message).to.include("admin console");
    });

    it("sizes from the lesser of the insurance funded and the console's figure, with a caveat", () => {
      const lower = insuranceSizing(
        funded,
        "unreadable",
        keeper,
        1_200_000_000n,
      );
      expect(lower.atMost).to.equal(1_200_000_000n);
      expect(lower.notes).to.have.length(1);
      expect(lower.notes[0]).to.include("CAVEAT");
      expect(lower.notes[0]).to.include("could not be read");
      expect(
        insuranceSizing(funded, "unreadable", keeper, 9_000_000_000n).atMost,
        "the figure can only lower it",
      ).to.equal(funded);
      expect(insuranceSizing(funded, "unreadable", keeper, 0n).atMost).to.equal(
        0n,
      );
    });

    it("leaves readable and sealed custody as before", () => {
      expect(insuranceSizing(funded, null, keeper, null)).to.deep.equal({
        atMost: funded,
        notes: [],
      });
      expect(
        insuranceSizing(funded, 1_000_000_000n, keeper, null).atMost,
      ).to.equal(800_000_000n);
      expect(
        insuranceSizing(funded, 1_000_000_000n, keeper, null).notes[0],
      ).to.include("Public custody holds");
      expect(
        insuranceSizing(funded, 1_000_000_000n, keeper, 500_000_000n).atMost,
      ).to.equal(500_000_000n);
      expect(
        insuranceSizing(funded, funded + keeper, keeper, 9_000_000_000n)
          .notes[0],
      ).to.include("changes nothing");
    });

    it("makes the mark check say a resume is not safe, with the instruction, rather than crash", () => {
      let reason = "";
      try {
        insuranceSizing(funded, "unreadable", keeper, null);
      } catch (error) {
        reason = (error as Error).message;
      }
      const verdict = markcheckSays({ unreadable: reason });
      expect(verdict).to.match(/^A resume is NOT safe to give/);
      expect(verdict).to.include("INSURANCE_HELD=<whole USDC>");
    });

    it("counts the keeper's deposit as the record, or the view's collateral when nothing is recorded", () => {
      expect(keeperDepositFor("200000000", 50n)).to.equal(200_000_000n);
      expect(keeperDepositFor(undefined, 150_000_000n)).to.equal(150_000_000n);
      expect(keeperDepositFor(undefined, null)).to.equal(0n);
    });
  });

  describe("the mark check that needs no admin key", () => {
    const ok: ResumeCheck = {
      mark: 150_000n,
      reference: 150_000n,
      confirmed: false,
      covered: 20_000n,
      openInterestCap: 18_518n,
      adminUpgrades: false,
      keeperWhy: null,
    };

    it("says a resume is safe when every check passes, whatever the run's own yes", () => {
      expect(markcheckSays({ check: ok })).to.match(/^A resume is safe/);
      expect(markcheckSays({ check: { ...ok, confirmed: true } })).to.match(
        /^A resume is safe/,
      );
    });

    it("says plainly why it is not, for each check, and when it could not read the mark", () => {
      const not = (change: Partial<ResumeCheck>) =>
        markcheckSays({ check: { ...ok, ...change } });
      expect(not({ reference: 160_000n })).to.match(
        /NOT safe.*bps from the reference/,
      );
      expect(not({ covered: 10_000n })).to.match(
        /NOT safe.*insurance covers 10000 lots.*open interest cap of 18518/,
      );
      expect(not({ adminUpgrades: true })).to.match(
        /NOT safe.*upgrade authority/,
      );
      expect(not({ keeperWhy: "no keeper is running" })).to.match(
        /NOT safe.*no keeper is running/,
      );
      expect(not({ mark: 0n })).to.match(/NOT safe.*no mark/);
      expect(markcheckSays({ unreadable: "the feed is old" })).to.match(
        /NOT safe.*could not be checked \(the feed is old\)/,
      );
    });

    it("runs the mark check against connections that throw on every signing or sending call, and none is called", async () => {
      const forbidden: string[] = [];
      const guarded = () =>
        new Proxy(
          {},
          {
            get: (_, method) => {
              const name = String(method);
              if (name === "then") return undefined;
              if (/send|sign|simulate|airdrop|confirm/i.test(name)) {
                return () => {
                  forbidden.push(name);
                  throw new Error(`${name} must not be called`);
                };
              }
              return async () => null;
            },
          },
        ) as never;
      const originalFetch = globalThis.fetch;
      const asked: string[] = [];
      const identity = Keypair.generate().publicKey;
      globalThis.fetch = (async (url: unknown) => {
        asked.push(String(url));
        return new Response(
          JSON.stringify({ result: { identity: identity.toBase58() } }),
        );
      }) as typeof fetch;
      const printed: string[] = [];
      const originalLog = console.log;
      console.log = (line: string) => printed.push(String(line));
      try {
        await markchecked({
          network: "rehearsal",
          mainnet: false,
          profile: "mainnet",
          solana: guarded(),
          rollup: guarded(),
          solanaUrl: "http://solana.invalid",
          publicSolanaUrl: "http://solana.invalid",
          rollupUrl: "http://rollup.invalid",
          privateUrl: "http://rollup.invalid",
          depositUrl: "http://rollup.invalid",
          custody: "public",
          validator: identity,
          floatLamports: 0,
          keysDir: mkdtempSync(join(tmpdir(), "markcheck-keys-")),
          deploymentPath: join(tmpdir(), "markcheck-none.json"),
          builtProgramPath: null,
          insurance: 500n * USDC,
          instructions: new Instructions(PROGRAM_ID),
        });
      } finally {
        console.log = originalLog;
        globalThis.fetch = originalFetch;
      }
      expect(forbidden, "no signing or sending call was made").to.deep.equal(
        [],
      );
      expect(
        asked,
        "it asked the rollup who runs it, and nothing else",
      ).to.deep.equal(["http://rollup.invalid"]);
      expect(printed.join("\n")).to.match(/verdict\s+A resume is NOT safe/);
    });

    it("is a target that signs with no admin key, and the doc names it after the handover", () => {
      const markcheck = readFileSync("ops/markchecking.ts", "utf8");
      expect(markcheck).to.not.include("adminKeyPath");
      expect(markcheck).to.not.include("heldKey");
      const keeperDeposit = readFileSync("ops/keeper-deposit.ts", "utf8");
      expect(keeperDeposit).to.not.include("adminKeyPath");
      const doc = readFileSync("docs/LAUNCH.md", "utf8");
      for (const target of ["mainnet-markcheck", "mainnet-keeper-deposit"]) {
        expect(doc, target).to.include(target);
      }
      expect(doc).to.include("INSURANCE_HELD");
      expect(doc).to.not.match(
        /resume only after the mark check, from the console/,
      );
    });
  });

  describe("proving the keeper before the market opens", () => {
    const ready = {
      collateral: 200_000_000n,
      deposited: true,
      wrote: true,
      watchedSeconds: 91,
    };

    it("watches for as long as a running keeper can go between two writes", () => {
      expect(keeperLiveWindowMs(1)).to.equal(
        180_000 + 1_000 + MAX_BACKOFF_MS + 30_000,
      );
      expect(
        keeperLiveWindowMs(5) - keeperLiveWindowMs(1),
        "a slower keeper is watched for longer",
      ).to.equal(4_000);
      expect(
        keeperLiveWindowMs(5, 300) - keeperLiveWindowMs(5, 180),
        "a longer sweep deadline is watched for longer",
      ).to.equal(120_000);
      expect(keeperLiveWindowMs(5)).to.be.above(
        180_000 + backoffMs(5_000, 30),
        "a sweep that runs to its deadline, then the longest pause, still fits",
      );
      expect(keeperLiveWindowMs(1)).to.be.above(
        backoffMs(1_000, 30),
        "past its longest pause",
      );
      expect(
        keeperWrote({ resultsWritten: 4 }, { resultsWritten: 5 }),
      ).to.equal(true);
      expect(
        keeperWrote({ resultsWritten: 4 }, { resultsWritten: 4 }),
      ).to.equal(false);
    });

    it("passes a funded keeper whose view was written", () => {
      expect(keeperNotReady(ready)).to.equal(null);
    });

    it("says what to do for a keeper with no seat, no deposit, no writes or no collateral", () => {
      expect(keeperNotReady({ ...ready, collateral: null })).to.match(
        /has no seat.*KEEPER_DEPOSIT.*start the keeper/,
      );
      expect(
        keeperNotReady({ ...ready, deposited: false, collateral: 0n }),
      ).to.match(/not funded.*KEEPER_DEPOSIT/);
      const silent = keeperNotReady({ ...ready, wrote: false });
      expect(silent).to.include("not written in the 91 s");
      expect(silent).to.include("make mainnet-keeper");
      expect(silent).to.not.include("KEEPER_SEATS");
      expect(silent).to.include("KEEPER_EVERY");
      expect(keeperNotReady({ ...ready, collateral: 0n })).to.match(
        /holds no collateral/,
      );
    });

    it("checks the seat and deposit alone when it has not watched", () => {
      expect(keeperNotReady({ ...ready, wrote: null })).to.equal(null);
      expect(
        keeperNotReady({
          ...ready,
          wrote: null,
          deposited: false,
          collateral: 0n,
        }),
      ).to.match(/not funded/);
    });

    it("counts a seat as funded when its view shows collateral, even with no deposit on record", () => {
      expect(keeperNotReady({ ...ready, deposited: false })).to.equal(null);
      expect(
        keeperNotReady({ ...ready, deposited: false, wrote: false }),
        "still needs a keeper that writes",
      ).to.match(/no keeper is running/);
    });

    describe("watching a seat funded before deposits were recorded", () => {
      const viewOf = (collateral: bigint, resultsWritten: number) =>
        ({ snapshot: { seat: { collateral } }, resultsWritten }) as never;
      const target = {} as never;

      it("runs the watch and confirms a keeper that writes", async () => {
        let reads = 0;
        let waited = 0;
        const seen = await keeperWatched(
          target,
          Keypair.generate(),
          false,
          true,
          {
            view: async () => viewOf(200_000_000n, reads++ === 0 ? 4 : 5),
            wait: async () => {
              waited++;
            },
          },
        );
        expect(waited, "it watched").to.equal(1);
        expect(seen.why).to.equal(null);
        expect(seen.collateral).to.equal(200_000_000n);
      });

      it("says no keeper is running, not that the seat is unfunded, when nothing writes", async () => {
        const originalNow = Date.now;
        let clock = 0;
        Date.now = () => (clock += 60_000);
        try {
          const seen = await keeperWatched(
            target,
            Keypair.generate(),
            false,
            true,
            { view: async () => viewOf(200_000_000n, 4), wait: async () => {} },
          );
          expect(seen.why).to.match(/no keeper is running/);
        } finally {
          Date.now = originalNow;
        }
      });

      it("still says not funded for a seat with no record and no collateral", async () => {
        const seen = await keeperWatched(
          target,
          Keypair.generate(),
          false,
          false,
          { view: async () => viewOf(0n, 4), wait: async () => {} },
        );
        expect(seen.why).to.match(/not funded/);
      });
    });

    it("keeps the market reduce-only unless the keeper is ready, ahead of the confirmation", () => {
      const check: ResumeCheck = {
        mark: 100_000n,
        reference: 100_000n,
        confirmed: true,
        covered: 111_111n,
        openInterestCap: 111_111n,
        adminUpgrades: false,
        keeperWhy: null,
      };
      expect(resumeVerdict(check)).to.deep.equal({ resume: true });
      const why = "no keeper is running on the keeper's seat";
      const refused = resumeVerdict({ ...check, keeperWhy: why });
      expect(refused.resume).to.equal(false);
      expect(refused.resume === false && refused.why).to.include(why);
      const unconfirmed = resumeVerdict({
        ...check,
        confirmed: false,
        keeperWhy: why,
      });
      expect(unconfirmed.resume === false && unconfirmed.why).to.include(why);
      const uncovered = resumeVerdict({
        ...check,
        keeperWhy: why,
        covered: 0n,
      });
      expect(
        uncovered.resume === false && uncovered.why,
        "the cover is reported first",
      ).to.match(/insurance covers/);
    });

    it("leaves the keeper's seat to the keeper: setup holds no order keys", () => {
      const network = readFileSync("ops/network.ts", "utf8");
      expect(network).to.not.include("KEEPER_QUIET_MS");
      expect(network).to.not.include("keeperCollateral");
      expect(network).to.not.include("TraderClient");
      expect(network).to.not.include("orderKeysFor");
    });

    it("moves nothing for the keeper while its deposit is pending, and sends a top-up only under a record of its own", () => {
      const network = readFileSync("ops/network.ts", "utf8");
      const owed = /async function keeperOwed[\s\S]*?\n}\n/.exec(network)?.[0];
      expect(owed).to.include("if (keeperDepositPending(on)) return 0n");
      expect(network).to.match(
        /owed > 0n && landed\(record\)[\s\S]*?sentNoted\(on, "keeperDeposit", null\)/,
      );
      expect(network).to.not.match(
        /else if \(!landed\(sentBook\(on\)\.keeperDeposit\)\)/,
      );
    });
  });

  it("takes every configured endpoint out of an error before it is printed", () => {
    const urls = {
      SOLANA_URL: "https://mainnet.rpc.example/?api-key=SECRET1",
      ROLLUP_URL: "https://rollup.example/v1/SECRET2",
      PRIVATE_URL: "https://rollup.example/v1/SECRET2",
      DEPOSIT_URL: undefined,
    };
    const clean = withoutUrls(
      "403 from https://mainnet.rpc.example/?api-key=SECRET1: " +
        "proxy said rollup.example/v1/SECRET2 and https://rollup.example/v1/SECRET2/ and " +
        "mainnet.rpc.example/?api-key=SECRET1",
      urls,
    );
    expect(clean).to.not.include("SECRET");
    expect(clean).to.include("<SOLANA_URL>");
    expect(clean).to.include("<ROLLUP_URL>");
    expect(withoutUrls("nothing to hide", urls)).to.equal("nothing to hide");
    expect(
      withoutUrls("nothing to hide", { SOLANA_URL: "" }),
      "an empty setting replaces nothing",
    ).to.equal("nothing to hide");
    expect(
      withoutUrls("refused at http://127.0.0.1:8899", {
        SOLANA_URL: "http://127.0.0.1:8899",
      }),
    ).to.equal("refused at <SOLANA_URL>");
  });

  describe("the error line the long-running processes print", () => {
    const env = {
      SOLANA_URL:
        "https://mainnet.rpc.example/v2/PATHKEY12345?api-key=QUERYKEY6789",
      ROLLUP_URL: "https://hostkey1234.rpc.example/",
      PRIVATE_URL: "https://hostkey1234.rpc.example/",
      DEPOSIT_URL: undefined,
    };
    const secrets = ["PATHKEY12345", "QUERYKEY6789", "hostkey1234"];

    it("takes the whole URL out of a FetchError-style message, and keeps the first line only", () => {
      const error = new Error(
        `request to ${env.SOLANA_URL} failed, reason: connect ECONNREFUSED 10.0.0.1:443\n    at fetch (node-fetch)`,
      );
      const line = errorLine(error, env);
      expect(line).to.equal(
        "request to <SOLANA_URL> failed, reason: connect ECONNREFUSED 10.0.0.1:443",
      );
      const rollup = errorLine(
        new Error(
          `request to ${env.ROLLUP_URL}v1/x failed, reason: socket hang up`,
        ),
        env,
      );
      for (const secret of secrets) expect(rollup).to.not.include(secret);
    });

    it("takes out the host, a path segment and a query value quoted on their own, as a failed lookup quotes the host", () => {
      for (const message of [
        "getaddrinfo ENOTFOUND hostkey1234.rpc.example",
        "getaddrinfo ENOTFOUND mainnet.rpc.example, then GET /v2/PATHKEY12345 refused",
        "proxy refused api-key=QUERYKEY6789",
        "request to hostkey1234.rpc.example failed",
      ]) {
        const line = errorLine(new Error(message), env);
        for (const secret of secrets) {
          expect(line, message).to.not.include(secret);
        }
      }
      expect(
        errorLine(
          new Error("getaddrinfo ENOTFOUND hostkey1234.rpc.example"),
          env,
        ),
      ).to.equal("getaddrinfo ENOTFOUND <ROLLUP_URL>");
      expect(errorLine("plain text\nsecond", env)).to.equal("plain text");
      expect(errorLine(new Error("nothing to hide"), {})).to.equal(
        "nothing to hide",
      );
    });

    it("is the only way the crank, the keeper, the drills and the ping print an error", () => {
      for (const file of ["crank", "keeper", "drills"]) {
        const source = readFileSync(`ops/${file}.ts`, "utf8");
        expect(source, file).to.include("errorLine");
        expect(source, file).to.not.match(
          /\(error instanceof Error \? error\.message : String\(error\)\)\.split/,
        );
      }
      expect(readFileSync("ops/heartbeat.ts", "utf8")).to.include(
        "withoutUrls",
      );
    });

    it("hides the ping address from a ping that failed with the whole address in its message", async () => {
      const address = "https://hc-ping.example/secret-uuid-123";
      const said: string[] = [];
      await heartbeatTo(address, (line) => said.push(line), (async () => {
        throw new Error(`request to ${address} failed, reason: socket hang up`);
      }) as unknown as typeof fetch)();
      expect(said[0]).to.include("socket hang up");
      expect(said[0]).to.not.include("secret-uuid");
    });
  });

  it("holds the heartbeat back while an alert stands, so the switch means healthy and not only alive", () => {
    const keeper = readFileSync("ops/keeper.ts", "utf8");
    expect(keeper).to.match(
      /sweepHealthy\(failed, stale\.size, alert\);[\s\S]*if \(healthy\) \{\s*void alive\(\);\s*stamp\(\);\s*\}/,
    );
    expect(keeper).to.include(
      'attempt === "margin insufficient" || attempt === "slots full"',
    );
    expect(keeper).to.match(/\) \{\s*alert = true;\s*\}\s*return \{ range/);
    expect(keeper).to.include(
      "await unwound(on, client, market, signal, true)",
    );
    const crank = readFileSync("ops/crank.ts", "utf8");
    expect(crank).to.match(
      /mayPing\(roundWasGood\(streaks, errored\), fires\.failing\) &&\s*now - pingedAtMs >= PING_EVERY_MS\s*\) \{[\s\S]*void alive/,
    );
    for (const doc of ["docs/LAUNCH.md", "Makefile"]) {
      expect(readFileSync(doc, "utf8"), doc).to.match(
        /healthy,? (and )?not only alive/,
      );
    }
  });

  it("smokes mainnet only on its own yes", () => {
    expect(smokeRefusal(false, false)).to.equal(null);
    expect(smokeRefusal(true, false)).to.match(/MAINNET_SMOKE=yes/);
    expect(smokeRefusal(true, true)).to.equal(null);
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

  it("scales a MagicBlock price into quote atoms per lot", () => {
    const lot = {
      baseLot: MAINNET_MARKET.settings.baseLot,
      baseDecimals: MAINNET_MARKET.baseDecimals,
      quoteDecimals: MAINNET_MARKET.settings.priceSource.quoteDecimals,
    };
    expect(
      atomsPerLot({ price: 10_652_292_773n, expo: -8 }, lot),
      "$106.52 a SOL, 0.001 SOL a lot",
    ).to.equal(106_522n);
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
    const all = {
      "api.exchange.coinbase.com": coinbase,
      "api.kraken.com": kraken,
      "www.bitstamp.net": bitstamp,
    };

    it("asks the three exchanges with a 10 s limit each", async () => {
      expect(SOURCE_TIMEOUT_MS).to.equal(10_000);
      const asked: { url: string; signal?: AbortSignal | null }[] = [];
      const absent = await gatherQuotes(
        referenceSources(lot, serving(all, asked)),
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
    });

    it("skips a source that is down, malformed or slow, and still stands on two", async () => {
      const one = await gatherQuotes(
        referenceSources(lot, serving({ ...all, "api.kraken.com": 503 })),
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
      const slow = await gatherQuotes(referenceSources(lot, timedOut));
      expect(slow.skipped).to.deep.equal([
        { name: "Kraken", why: "The operation timed out" },
      ]);
    });

    it("outvotes a wrong source", async () => {
      const wrongKraken = await gatherQuotes(
        referenceSources(
          lot,
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

  it("refuses a key file that is not 64 JSON bytes by its path alone, never quoting what it holds", () => {
    const folder = mkdtempSync(join(tmpdir(), "keys-"));
    const pasted = "Kd3NBUAdUnhyzenEwVLy9pBKxSRDvvh8Vx5Kd3NBUAdUnhyzen";
    const contents = [
      pasted,
      `[12,34,56,x,${Array.from({ length: 60 }, () => 7).join(",")}]`,
      JSON.stringify(Array.from({ length: 63 }, () => 7)),
      JSON.stringify(Array.from({ length: 64 }, () => 300)),
      JSON.stringify({ secret: pasted }),
    ];
    for (const [nth, content] of contents.entries()) {
      const path = join(folder, `key-${nth}.json`);
      writeFileSync(path, content, { mode: 0o600 });
      expect(() => heldKey(path), content).to.throw(
        `${path} is not a JSON array of 64 bytes, as a key file is.`,
      );
      try {
        heldKey(path);
      } catch (error) {
        expect((error as Error).message).to.not.include("Kd3NBUAdUn");
        expect((error as Error).message).to.not.include("34,56");
      }
    }
    const kept = Keypair.generate();
    const good = join(folder, "good.json");
    writeFileSync(good, JSON.stringify(Array.from(kept.secretKey)), {
      mode: 0o600,
    });
    expect(heldKey(good).publicKey.equals(kept.publicKey)).to.equal(true);
    rmSync(folder, { recursive: true });
  });

  it("refuses a key file others can read, and one that is not a regular file, by its path alone", () => {
    const folder = mkdtempSync(join(tmpdir(), "keys-"));
    const secret = JSON.stringify(Array.from(Keypair.generate().secretKey));
    for (const mode of [0o640, 0o604, 0o644, 0o660]) {
      const path = join(folder, `key-${mode.toString(8)}.json`);
      writeFileSync(path, secret);
      chmodSync(path, mode);
      expect(() => heldKey(path), mode.toString(8)).to.throw(
        `${path} can be read by other users (mode ${mode.toString(8)})`,
      );
      try {
        heldKey(path);
      } catch (error) {
        expect((error as Error).message).to.not.include(secret.slice(1, 20));
      }
    }
    const owned = join(folder, "owned.json");
    writeFileSync(owned, secret);
    chmodSync(owned, 0o400);
    expect(heldKey(owned).publicKey.toBase58()).to.be.a("string");
    expect(() => heldKey(folder)).to.throw(
      `${folder} is not a regular file, as a key file is.`,
    );
    const link = join(folder, "link.json");
    symlinkSync(owned, link);
    expect(
      () => heldKey(link),
      "a symlink to a good key is not followed",
    ).to.throw(`${link} is a symbolic link, not a regular key file.`);
    rmSync(folder, { recursive: true });
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
    expect(() => positiveInteger("KEEPER_RANGE", undefined, null)).to.throw(
      /Set KEEPER_RANGE/,
    );
    expect(positiveInteger("SEATS_PER_DAY", "4294967295", 5, U32_MAX)).to.equal(
      U32_MAX,
    );
    for (const wraps of [
      "4294967296",
      "4294967301",
      "9007199254740993",
      "100000000000000000000000",
    ]) {
      expect(
        () => positiveInteger("SEATS_PER_DAY", wraps, 5, U32_MAX),
        wraps,
      ).to.throw(/more than 4294967295/);
    }
  });

  it("reads whole tokens from a variable as atoms, and refuses anything else", () => {
    expect(atomsOf(undefined, 6)).to.equal(null);
    expect(atomsOf("", 6)).to.equal(null);
    expect(atomsOf("5000", 6)).to.equal(5_000_000_000n);
    expect(() => atomsOf("1.5", 6)).to.throw(/whole number/);
    expect(() => atomsOf("-1", 6)).to.throw(/whole number/);
  });

  it("scales a price to quote atoms per lot", () => {
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

  it("syncs a source only for a newer observation, and calls an observation older than its max age stale", () => {
    expect(syncDecision(null, 0, 1_000, 90)).to.equal("unreadable");
    expect(syncDecision(990, 980, 1_000, 90)).to.equal("send");
    expect(syncDecision(980, 980, 1_000, 90)).to.equal("unchanged");
    expect(
      syncDecision(909, 900, 1_000, 90),
      "newer, but too old for the program",
    ).to.equal("silent");
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
    expect(refusalOutcome(failed(6079))).to.equal("silent");
    expect(refusalOutcome(failed(6081)), "any other refusal").to.equal(
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
    const failing = new Map<string, number>();
    const given = (now: number) => {
      for (const [source, rounds] of streaks) {
        if (rounds > 0 && !failing.has(source)) failing.set(source, now);
        if (rounds === 0) failing.delete(source);
      }
      return givenUp(streaks, failing, now, 6_000);
    };
    step("guard", "refused");
    step("market 0", "synced");
    step("guard", "refused");
    step("market 0", "synced");
    expect(given(0), "two rounds are too few").to.equal(null);
    step("guard", "unreadable");
    expect(given(100), "three rounds, but not for the budget").to.equal(null);
    expect(given(6_000)).to.equal("guard");
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
    expect(withIncident("refused", "dislocated"), "a failure stays").to.equal(
      "refused",
    );
    expect(withIncident("silent", "dislocated"), "silence stays").to.equal(
      "silent",
    );
    let streaks = new Map<string, number>();
    for (let round = 0; round < 3; round += 1) {
      streaks = afterOutcome(
        streaks,
        "market 0",
        withIncident("synced", "settling"),
      );
    }
    expect(givenUp(streaks, new Map([["market 0", 0]]), 6_000, 6_000)).to.equal(
      "market 0",
    );
    expect(nameIn(MARKET_STATUS, MARKET_STATUS.reduceOnly)).to.equal(
      "reduceOnly",
    );
    expect(nameIn(ORACLE_HEALTH, 9)).to.equal("9");
  });

  it("fails a sweep on a failed send, and not on a liquidatable seat its margin could not take, which would end the keeper", () => {
    expect(sweepFailed(new Map([["nothing to liquidate", 40]]))).to.equal(
      false,
    );
    expect(sweepFailed(new Map([["liquidated", 1]]))).to.equal(false);
    expect(sweepFailed(new Map([["failed", 1]]))).to.equal(true);
    expect(sweepFailed(new Map([["margin insufficient", 1]]))).to.equal(false);
    expect(
      sweepFailed(
        new Map([
          ["margin insufficient", 3],
          ["failed", 1],
        ]),
      ),
      "a failed send still fails it",
    ).to.equal(true);
    const alert = marginAlert(7);
    expect(alert).to.match(/^seat 7: ALERT/);
    expect(alert).to.match(/Deposit more collateral into the keeper's seat/);
    expect(alert).to.match(/insurance pays/);
  });

  describe("the keeper's unwind of a takeover", () => {
    const params = {
      tick: 100n,
      bandBps: 400,
      minSize: 10n,
      minNotional: 1_000_000n,
    };

    it("closes a long with a reduce-only ask and a short with a bid, for the whole position", () => {
      expect(unwindOrder(40n, 150_000n, params)).to.deep.equal({
        kind: "order",
        side: SIDE.ask,
        size: 40n,
        price: 147_000n,
      });
      expect(unwindOrder(-25n, 150_000n, params)).to.deep.equal({
        kind: "order",
        side: SIDE.bid,
        size: 25n,
        price: 153_000n,
      });
      expect(unwindOrder(0n, 150_000n, params)).to.deep.equal({
        kind: "flat",
      });
    });

    it("prices it half the band from the mark, on the tick, and always inside the band", () => {
      for (const mark of [150_000n, 150_049n, 149_951n, 87_321n, 400_007n]) {
        const band = (mark * 400n) / 10_000n;
        const ask = unwindPrice(SIDE.ask, mark, params);
        const bid = unwindPrice(SIDE.bid, mark, params);
        expect(ask % 100n, `ask at ${mark} is on the tick`).to.equal(0n);
        expect(bid % 100n, `bid at ${mark} is on the tick`).to.equal(0n);
        expect(
          ask >= mark - band,
          `ask at ${mark} is inside the band`,
        ).to.equal(true);
        expect(ask < mark, `ask at ${mark} is below the mark`).to.equal(true);
        expect(
          bid <= mark + band,
          `bid at ${mark} is inside the band`,
        ).to.equal(true);
        expect(bid > mark, `bid at ${mark} is above the mark`).to.equal(true);
      }
      expect(
        unwindPrice(SIDE.ask, 150_049n, params),
        "rounded towards the mark",
      ).to.equal(147_100n);
      expect(unwindPrice(SIDE.bid, 150_049n, params)).to.equal(153_000n);
    });

    it("reaches at least one tick from the mark in a band narrower than two", () => {
      const narrow = { ...params, bandBps: 1 };
      expect(unwindPrice(SIDE.ask, 150_000n, narrow)).to.equal(149_900n);
      expect(unwindPrice(SIDE.bid, 150_000n, narrow)).to.equal(150_100n);
    });

    it("leaves a position under the minimum size or notional, which no order can close", () => {
      expect(unwindOrder(9n, 150_000n, params)).to.deep.equal({ kind: "dust" });
      expect(unwindOrder(-9n, 150_000n, params)).to.deep.equal({
        kind: "dust",
      });
      expect(
        unwindOrder(10n, 150_000n, { ...params, minNotional: 1_470_001n }),
        "notional at the order's price, not the mark",
      ).to.deep.equal({ kind: "dust" });
      expect(unwindOrder(10n, 150_000n, params).kind).to.equal("order");
    });

    it("alerts with what is left and what to do, as a long or a short", () => {
      const long = unwindAlert(0, 12n, "the order expired without running");
      expect(long).to.match(/^market 0: ALERT, the keeper holds 12 lots long/);
      expect(long).to.include("the order expired without running");
      expect(long).to.match(/tries again on every sweep/);
      expect(long).to.match(/close the position .* by hand/);
      expect(unwindAlert(1, -7n, "x")).to.match(
        /market 1: ALERT, the keeper holds 7 lots short/,
      );
    });
  });

  it("calls a round good only when nothing errored and no source is failing, for the dead-man's switch", () => {
    expect(roundWasGood(new Map(), false)).to.equal(true);
    expect(
      roundWasGood(
        new Map([
          ["market 0", 0],
          ["USDC guard", 0],
        ]),
        false,
      ),
    ).to.equal(true);
    expect(roundWasGood(new Map([["market 0", 0]]), true)).to.equal(false);
    expect(
      roundWasGood(
        new Map([
          ["market 0", 0],
          ["USDC guard", 1],
        ]),
        false,
      ),
      "one failing source is enough",
    ).to.equal(false);
  });

  describe("the heartbeat", () => {
    const address = "https://hc-ping.example/6f1c0d3e-secret-uuid";
    const answer = (status = 200) => new Response("OK", { status });
    const fake = (
      answers: (() => Promise<Response>)[],
      calls: { url: string; method?: string; signal?: AbortSignal | null }[],
    ) =>
      (async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method, signal: init?.signal });
        const next = answers.shift();
        if (!next) throw new Error("unexpected extra ping");
        return next();
      }) as unknown as typeof fetch;

    it("is off unless HEALTHCHECK_URL names an http or https address, and never repeats a bad one", () => {
      expect(heartbeatUrl(undefined)).to.equal(null);
      expect(heartbeatUrl("")).to.equal(null);
      expect(heartbeatUrl(address)).to.equal(address);
      expect(heartbeatUrl("http://127.0.0.1:8080/ping")).to.equal(
        "http://127.0.0.1:8080/ping",
      );
      for (const bad of [
        "ftp://hc.example/secret-uuid",
        "hc.example/secret-uuid",
      ]) {
        let error: Error | undefined;
        try {
          heartbeatUrl(bad);
        } catch (caught) {
          error = caught as Error;
        }
        expect(error?.message, bad).to.match(/not an http or https address/);
        expect(error?.message, "the address is a secret").to.not.include(
          "secret-uuid",
        );
        expect(error?.message).to.include("Nothing was sent.");
        expect(roundErrorKind(error)).to.equal("fatal");
      }
    });

    it("does nothing without an address", async () => {
      const calls: { url: string }[] = [];
      await heartbeatTo(
        null,
        () => calls.push({ url: "said" }),
        fake([], calls),
      )();
      expect(calls).to.deep.equal([]);
    });

    it("sends one plain GET that gives up after the timeout", async () => {
      const calls: {
        url: string;
        method?: string;
        signal?: AbortSignal | null;
      }[] = [];
      const said: string[] = [];
      await heartbeatTo(
        address,
        (line) => said.push(line),
        fake([async () => answer()], calls),
      )();
      expect(calls).to.have.length(1);
      expect(calls[0].url).to.equal(address);
      expect(calls[0].method).to.equal("GET");
      expect(calls[0].signal).to.be.instanceOf(AbortSignal);
      expect(HEARTBEAT_TIMEOUT_MS).to.equal(10_000);
      expect(said, "a good ping is silent").to.deep.equal([]);
    });

    it("logs a ping that fails or is refused, without the address, and neither throws nor sends it again", async () => {
      const calls: { url: string }[] = [];
      const said: string[] = [];
      const ping = heartbeatTo(
        address,
        (line) => said.push(line),
        fake(
          [
            async () => {
              throw new Error("connect ECONNREFUSED 10.0.0.1:443\n    at x");
            },
            async () => answer(502),
          ],
          calls,
        ),
      );
      await ping();
      expect(calls, "one try, no retry").to.have.length(1);
      expect(said).to.have.length(1);
      expect(said[0]).to.include("heartbeat to HEALTHCHECK_URL failed");
      expect(
        said[0],
        "not even the host of a credential-bearing address",
      ).to.not.include("hc-ping");
      expect(said[0]).to.include("connect ECONNREFUSED 10.0.0.1:443");
      expect(said[0]).to.not.include("at x");
      expect(said[0]).to.include("The service goes on");
      await ping();
      expect(calls).to.have.length(2);
      expect(said[1]).to.include("refused with status 502");
      for (const line of said) {
        expect(line, "the address is a secret").to.not.include("secret-uuid");
      }
    });

    it("does not send another while one is still out", async () => {
      const calls: { url: string }[] = [];
      let finish: () => void = () => {};
      const slow = () =>
        new Promise<Response>((resolve) => {
          finish = () => resolve(answer());
        });
      const ping = heartbeatTo(
        address,
        () => {},
        fake([slow, async () => answer()], calls),
      );
      const first = ping();
      const second = ping();
      expect(calls, "the second waits for the first").to.have.length(1);
      finish();
      await Promise.all([first, second]);
      await ping();
      expect(calls).to.have.length(2);
    });
  });

  describe("the heartbeat file", () => {
    const folder = () => mkdtempSync(join(tmpdir(), "heartbeat-file-"));

    it("stamps the time in milliseconds, readable by every user, and leaves no partial file behind", () => {
      const dir = folder();
      try {
        const path = join(dir, "keeper-alive");
        const stamp = heartbeatFile(
          path,
          () => {},
          () => 1_760_000_000_123,
        );
        stamp();
        expect(readFileSync(path, "utf8")).to.equal("1760000000123");
        expect(statSync(path).mode & 0o777).to.equal(0o644);
        expect(existsSync(`${path}.tmp`)).to.equal(false);
        const later = 1_760_000_001_000;
        heartbeatFile(
          path,
          () => {},
          () => later,
        )();
        expect(readFileSync(path, "utf8")).to.equal(String(later));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("does nothing when unset or empty", () => {
      const said: string[] = [];
      heartbeatFile(undefined, (line) => said.push(line))();
      heartbeatFile("", (line) => said.push(line))();
      expect(said).to.deep.equal([]);
    });

    it("says a failed write once, never throws, and says when it works again", () => {
      const dir = folder();
      try {
        const path = join(dir, "missing", "keeper-alive");
        const said: string[] = [];
        const stamp = heartbeatFile(path, (line) => said.push(line));
        stamp();
        stamp();
        expect(said).to.have.length(1);
        expect(said[0]).to.include("heartbeat to KEEPER_HEARTBEAT_FILE failed");
        expect(said[0]).to.include("The keeper goes on");
        mkdirSync(join(dir, "missing"));
        stamp();
        expect(said).to.have.length(2);
        expect(said[1]).to.include("works again");
        stamp();
        expect(said).to.have.length(2);
        expect(existsSync(path)).to.equal(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("is stamped only by a healthy sweep, next to the ping", () => {
      expect(readFileSync("ops/keeper.ts", "utf8")).to.match(
        /const healthy = sweepHealthy\(failed, stale\.size, alert\);[\s\S]*if \(healthy\) \{\s*void alive\(\);\s*stamp\(\);/,
      );
      expect(readFileSync("ops/keeper.ts", "utf8")).to.include(
        "heartbeatFile(heartbeatPath)",
      );
    });
  });

  it("stops the keeper once one market has read stale for longer than the limit, and forgets a market that recovers", () => {
    let since = staleSince(new Map(), [0], 1_000);
    since = staleSince(since, [0, 1], 5_000);
    expect([...since]).to.deep.equal([
      [0, 1_000],
      [1, 5_000],
    ]);
    expect(staleTooLong(since, 1_000 + 60_000, 60)).to.equal(null);
    expect(staleTooLong(since, 1_000 + 60_001, 60)).to.equal(0);
    since = staleSince(since, [1], 70_000);
    expect([...since]).to.deep.equal([[1, 5_000]]);
    since = staleSince(since, [0, 1], 80_000);
    expect(since.get(0), "a market that recovered starts again").to.equal(
      80_000,
    );
  });

  it("covers the whole seat capacity in ranges that start after the reserved seats and never pass the end", () => {
    const ranges = seatRanges(1_000, 256);
    expect(ranges).to.deep.equal([
      { start: 2, count: 256 },
      { start: 258, count: 256 },
      { start: 514, count: 256 },
      { start: 770, count: 230 },
    ]);
    expect(ranges.flatMap(({ start }) => [start])).to.not.include(FEE_SEAT);
    expect(ranges[0].start).to.be.greaterThan(INSURANCE_SEAT);
    expect(seatRanges(2, 256)).to.deep.equal([]);
    expect(seatRanges(3, 256)).to.deep.equal([{ start: 2, count: 1 }]);
    const full = seatRanges(34_492, 2_048);
    const covered = full.reduce((sum, { count }) => sum + count, 0);
    expect(covered, "every seat above the reserved two").to.equal(34_490);
    for (const [at, { start, count }] of full.entries()) {
      if (at > 0) {
        expect(start).to.equal(full[at - 1].start + full[at - 1].count);
      }
      expect(count).to.be.at.most(2_048);
    }
  });

  it("sends again only what a ranged call left unvisited, and always moves on", () => {
    const range = { start: 258, count: 256 };
    const stopped = (orderSeq: bigint, status: number, code = 0) => ({
      orderSeq,
      status,
      code,
    });
    expect(restOfRange(range, stopped(514n, 0, 2))).to.equal(null);
    expect(restOfRange(range, stopped(300n, 0, 4))).to.deep.equal({
      start: 300,
      count: 214,
    });
    expect(
      restOfRange(
        range,
        stopped(300n, LIQUIDATION_STATUS.liquidatorMarginInsufficient),
      ),
      "the seat the margin could not carry is passed over",
    ).to.deep.equal({ start: 301, count: 213 });
    expect(
      restOfRange(
        { start: 513, count: 1 },
        stopped(513n, LIQUIDATION_STATUS.liquidatorMarginInsufficient),
      ),
    ).to.equal(null);
    expect(
      restOfRange(range, stopped(258n, 0, 0)),
      "a call that made no progress still advances by a seat",
    ).to.deep.equal({ start: 259, count: 255 });
  });

  it("ends a market's sweep at a stale price or a keeper seat with no slot for it, and says why", () => {
    expect(attemptOf(LIQUIDATION_STATUS.liquidatorSlotsFull)).to.equal(
      "slots full",
    );
    expect(endsSweep("slots full")).to.equal(true);
    expect(endsSweep("stale price")).to.equal(true);
    expect(endsSweep("margin insufficient")).to.equal(false);
    expect(slotsFullAlert(3)).to.match(
      /^market 3: ALERT.*four other markets.*second keeper key/,
    );
  });

  it("runs the release sweep when none has run or its period has passed", () => {
    expect(releaseDue(null, 5, 600_000)).to.equal(true);
    expect(releaseDue(1_000, 1_000 + 599_999, 600_000)).to.equal(false);
    expect(releaseDue(1_000, 1_000 + 600_000, 600_000)).to.equal(true);
  });

  it("sweeps at the mark, which takes a long or a short target alike", () => {
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

  it("sends enough reconcile calls to read the whole table, and sends them first in a pass that has a shortfall to lower", () => {
    expect(reconcileCalls(2_048)).to.equal(1);
    expect(reconcileCalls(RECONCILE_SEATS_PER_CALL)).to.equal(1);
    expect(reconcileCalls(RECONCILE_SEATS_PER_CALL + 1)).to.equal(2);
    expect(reconcileCalls(34_492)).to.equal(5);
    expect(passSteps([])).to.deep.equal(["liquidate"]);
    expect(passSteps([1])).to.deep.equal(["reconcile", "liquidate", "cover"]);
  });

  it("fires triggers on a perp market whose sync landed or whose last pass is a second old, never for the guard", () => {
    const now = 10_000;
    const recent = new Map([
      [1, now - 10],
      [2, now - 10],
      [3, now - 10],
    ]);
    expect(
      marketsToFire(
        [
          { marketId: 1, moved: true },
          { marketId: 2, moved: false },
          { marketId: null, moved: true },
          { marketId: 3, moved: true },
        ],
        recent,
        now,
      ),
    ).to.deep.equal([1, 3]);
    expect(marketsToFire([], recent, now)).to.deep.equal([]);
    expect(
      marketsToFire(
        [
          { marketId: 1, moved: false },
          { marketId: null, moved: false },
        ],
        recent,
        now,
      ),
    ).to.deep.equal([]);
  });

  it("fires a market again once FIRE_EVERY_MS has passed since its last pass, with no price move", () => {
    const quiet = [{ marketId: 1, moved: false }];
    const lastAt = 5_000;
    const last = new Map([[1, lastAt]]);
    expect(FIRE_EVERY_MS).to.equal(1_000);
    expect(
      marketsToFire(quiet, last, lastAt + FIRE_EVERY_MS - 1),
    ).to.deep.equal([]);
    expect(marketsToFire(quiet, last, lastAt + FIRE_EVERY_MS)).to.deep.equal([
      1,
    ]);
    expect(marketsToFire(quiet, new Map(), 0)).to.deep.equal([1]);
  });

  it("names each market once however many of its sources the round holds", () => {
    expect(
      marketsToFire(
        [
          { marketId: 4, moved: true },
          { marketId: 4, moved: false },
          { marketId: 5, moved: false },
        ],
        new Map(),
        0,
      ),
    ).to.deep.equal([4, 5]);
  });

  it("holds a failed trigger pass against the ping in every later round until that market's next pass succeeds", () => {
    let failing: ReadonlySet<number> = new Set();
    expect(mayPing(true, failing)).to.equal(true);
    failing = afterFire(failing, 1, true);
    for (let later = 0; later < 3; later += 1) {
      expect(mayPing(true, failing), "held across rounds").to.equal(false);
    }
    failing = afterFire(failing, 1, false);
    expect(mayPing(true, failing)).to.equal(true);
    expect(mayPing(false, failing), "a bad round still holds").to.equal(false);
  });

  it("does not let one market's successful pass clear another market's failure", () => {
    let failing: ReadonlySet<number> = new Set();
    failing = afterFire(failing, 1, true);
    failing = afterFire(failing, 2, true);
    failing = afterFire(failing, 2, false);
    expect([...failing]).to.deep.equal([1]);
    expect(mayPing(true, failing)).to.equal(false);
    failing = afterFire(failing, 3, false);
    expect([...failing]).to.deep.equal([1]);
    const before = new Set([1]);
    afterFire(before, 1, false);
    expect([...before], "the input is not changed").to.deep.equal([1]);
    expect(mayPing(true, afterFire(failing, 1, false))).to.equal(true);
  });

  it("builds the crank's fire pass and the keeper's trigger sweep with only the fee payer signing, and has the keeper hold a failed or overrun trigger sweep as an alert, after the liquidation sweep and outside its deadline", () => {
    const instructions = new Instructions(PROGRAM_ID);
    const fire = instructions.fireTriggers(1, MAX_FIRES_PER_PASS, [1]);
    const sweep = instructions.sweepTriggers(1, SWEEP_TRIGGER_SLOTS_PER_CALL);
    for (const instruction of [fire, sweep]) {
      expect(instruction.keys.some((key) => key.isSigner)).to.equal(false);
      expect(
        instruction.keys.some(({ pubkey }) =>
          pubkey.equals(instructions.addresses.triggers(1)),
        ),
      ).to.equal(true);
    }
    const keeper = readFileSync("ops/keeper.ts", "utf8");
    expect(keeper).to.match(
      /covered\(on, owner, toCover, capacity, signal\)\) failed = true;\s*outcome = \{ failed, stale, alert, markets \};/,
    );
    expect(keeper).to.match(
      /if \(!triggerSweep\.inFlight\) \{\s*triggerSweep\.inFlight = true;\s*startUntilSettled\(\s*"The trigger sweep",\s*passDeadline,/,
    );
    expect(keeper).to.not.match(/await withDeadline\(\s*"The trigger sweep"/);
    expect(keeper).to.match(/alert = sweep\.alert \|\| triggerSweep\.failing;/);
    expect(sweepHealthy(false, 0, true)).to.equal(false);
  });

  describe("startUntilSettled", () => {
    const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

    it("reports an overrun at once, keeps the pass unsettled until the send ends, and lets a late success clear the failure", async () => {
      let failing: ReadonlySet<number> = new Set();
      let inFlight = true;
      let finish: () => void = () => {};
      startUntilSettled(
        "Market 1 trigger pass",
        0.1,
        () => new Promise<void>((done) => (finish = done)),
        () => {
          failing = afterFire(failing, 1, true);
        },
        (failed) => {
          inFlight = false;
          failing = afterFire(failing, 1, failed);
        },
      );
      await pause(150);
      expect([...failing], "the overrun withholds the ping").to.deep.equal([1]);
      expect(mayPing(true, failing)).to.equal(false);
      expect(inFlight, "no second pass may start yet").to.equal(true);

      finish();
      await pause(20);
      expect(inFlight).to.equal(false);
      expect([...failing], "a late success clears it").to.deep.equal([]);
      expect(mayPing(true, failing)).to.equal(true);
    });

    it("frees a pass whose request never answers after a second deadline, as failed", async () => {
      const outcomes: string[] = [];
      startUntilSettled(
        "Market 1 trigger pass",
        0.05,
        () => new Promise<void>(() => {}),
        () => outcomes.push("failed"),
        (failed) => outcomes.push(`settled ${failed}`),
      );
      await pause(75);
      expect(outcomes, "still held after the first deadline").to.deep.equal([
        "failed",
      ]);
      await pause(75);
      expect(outcomes).to.deep.equal(["failed", "settled true"]);
    });

    it("settles work that throws before it returns a promise as failed", async () => {
      const outcomes: string[] = [];
      startUntilSettled(
        "Market 1 trigger pass",
        5,
        () => {
          throw new Error("no connection");
        },
        () => outcomes.push("failed"),
        (failed) => outcomes.push(`settled ${failed}`),
      );
      await pause(20);
      expect(outcomes).to.deep.equal(["failed", "settled true"]);
    });

    it("keeps a late failure failing and settles exactly once", async () => {
      const settles: boolean[] = [];
      let fail: (error: Error) => void = () => {};
      startUntilSettled(
        "Market 1 trigger pass",
        0.1,
        () => new Promise<void>((_, reject) => (fail = reject)),
        () => {},
        (failed) => settles.push(failed),
      );
      await pause(150);
      expect(settles).to.deep.equal([]);
      fail(new Error("refused"));
      await pause(20);
      expect(settles).to.deep.equal([true]);
    });

    it("settles at once as failed when the work fails inside its deadline", async () => {
      const seen: string[] = [];
      startUntilSettled(
        "Market 1 trigger pass",
        5,
        async () => {
          throw new Error("refused");
        },
        () => seen.push("failed"),
        (failed) => seen.push(`settled ${failed}`),
      );
      await pause(20);
      expect(seen).to.deep.equal(["failed", "settled true"]);
    });

    it("never delays the caller: a hung trigger sweep returns control at once", async () => {
      const began = Date.now();
      startUntilSettled(
        "The trigger sweep",
        0.2,
        () => new Promise<void>(() => {}),
        () => {},
        () => {},
      );
      expect(Date.now() - began).to.be.lessThan(50);
    });
  });

  it("gives a pass over a large table more time than the floor, lets a named deadline win, and says when a pass used over half of it", () => {
    const deadline = (
      capacity: number,
      markets: number,
      named: number | null = null,
    ) => passDeadlineSeconds(named, 180, capacity, 64, 4, markets);
    expect(deadline(2_048, 1), "a small table keeps the floor").to.equal(180);
    expect(deadline(8_192, 1)).to.equal(180);
    expect(deadline(34_492, 1), "135 rounds of 256 seats").to.equal(270);
    expect(deadline(34_492, 3)).to.equal(810);
    expect(deadline(34_492, 8)).to.equal(2_160);
    expect(deadline(2_000_000, 8), "capped").to.equal(3_600);
    expect(deadline(34_492, 3, 600)).to.equal(600);
    expect(deadline(2_048, 1, 90), "a named deadline can be lower").to.equal(
      90,
    );
    expect(passIsSlow(90_000, 180)).to.equal(false);
    expect(passIsSlow(90_001, 180)).to.equal(true);
  });

  it("covers only the markets that still record a shortfall after the reconcile", () => {
    expect(
      stillOwed(
        [0, 1, 2],
        [
          { id: 0, uncoveredShortfall: 0n },
          { id: 1, uncoveredShortfall: 7n },
          { id: 2, uncoveredShortfall: 0n },
        ],
      ),
    ).to.deep.equal([1]);
    expect(stillOwed([1], [{ id: 1, uncoveredShortfall: 0n }])).to.deep.equal(
      [],
    );
  });

  it("stops at once only for a wrong setup, and retries every outage", () => {
    expect(
      roundErrorKind(new Error('500 : {"error":"client error (Connect)"}')),
      "the devnet outage that crashed both",
    ).to.equal("retry");
    expect(
      roundErrorKind(
        new Error(
          'failed to get info about account F1TT: Error: 500 : {"error":"client error (Connect)"}',
        ),
      ),
    ).to.equal("retry");
    expect(roundErrorKind(new Error("429 Too Many Requests"))).to.equal(
      "retry",
    );
    expect(roundErrorKind(new Error("503 Service Unavailable"))).to.equal(
      "retry",
    );
    expect(roundErrorKind(new TypeError("fetch failed"))).to.equal("retry");
    expect(roundErrorKind(new Error("Timed out waiting for it"))).to.equal(
      "retry",
    );
    expect(roundErrorKind("a thrown string")).to.equal("retry");
    expect(roundErrorKind(undefined)).to.equal("retry");
    expect(roundErrorKind(new SetupError("The keeper has no seat."))).to.equal(
      "fatal",
    );
    expect(
      roundErrorKind(
        new Error("http://x is run by A, not B. Nothing was sent."),
      ),
      "the deployment checks' refusals",
    ).to.equal("fatal");
  });

  it("doubles the pause after each errored round up to 60 seconds and resets after a good one", () => {
    const schedule = [0, 1, 2, 3, 4, 5, 6, 40].map((errored) =>
      backoffMs(10_000, errored),
    );
    expect(schedule).to.deep.equal([
      10_000, 20_000, 40_000, 60_000, 60_000, 60_000, 60_000, 60_000,
    ]);
    expect(
      [0, 1, 2, 3, 6, 7].map((errored) => backoffMs(1_000, errored)),
    ).to.deep.equal([1_000, 2_000, 4_000, 8_000, 60_000, 60_000]);
    expect(backoffMs(10_000, 0), "a good round").to.equal(10_000);
    expect(
      backoffMs(120_000, 3),
      "never shorter than the configured pause",
    ).to.equal(120_000);
    expect(backoffMs(1_000, 10_000)).to.equal(MAX_BACKOFF_MS);
  });

  it("gives up on a round or sweep that does not finish within its deadline, as a failure the loop survives", async () => {
    const never = () => new Promise<string>(() => {});
    const started = Date.now();
    const error = await withDeadline("The sweep", 1, never).catch(
      (failed: Error) => failed,
    );
    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.equal(
      "The sweep did not finish within 1 s",
    );
    expect(Date.now() - started, "waited for the deadline").to.be.within(
      900,
      3_000,
    );
    expect(roundErrorKind(error), "an outage that can end").to.equal("retry");

    expect(
      await withDeadline("The round", 5, async () => "done"),
      "work that finishes in time",
    ).to.equal("done");
    const refused = await withDeadline("The round", 5, async () => {
      throw new Error("503 Service Unavailable");
    }).catch((failed: Error) => failed);
    expect(
      (refused as Error).message,
      "its own error, not the deadline",
    ).to.equal("503 Service Unavailable");
    const fatal = await withDeadline("The round", 5, async () => {
      throw new SetupError("The keeper has no seat.");
    }).catch((failed: Error) => failed);
    expect(roundErrorKind(fatal), "a wrong setup still stops").to.equal(
      "fatal",
    );
    const late = await withDeadline(
      "The round",
      1,
      () =>
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error("late")), 1_300),
        ),
    ).catch((failed: Error) => failed);
    expect((late as Error).message).to.include("did not finish");
    await new Promise((done) => setTimeout(done, 500));
  });

  it("refuses to start the keeper on a seat that holds no collateral", () => {
    const refusal = emptySeatRefusal(4, 0n);
    expect(refusal).to.be.a("string");
    expect(refusal).to.include("seat 4");
    expect(refusal).to.include("KEEPER_DEPOSIT");
    expect(emptySeatRefusal(4, -1n), "a seat in debt").to.be.a("string");
    expect(emptySeatRefusal(4, 1n)).to.equal(null);
    expect(emptySeatRefusal(4, 5_000_000_000n)).to.equal(null);
  });

  it("tells a sweep given up on after its deadline to stop, so it cannot keep signing while the next one starts", async () => {
    let seen: AbortSignal | undefined;
    const hung = (signal: AbortSignal) => {
      seen = signal;
      return new Promise<string>(() => {});
    };
    const error = await withDeadline("The sweep", 1, hung).catch(
      (failed: Error) => failed,
    );
    expect(seen?.aborted, "aborted at the deadline").to.equal(true);
    expect(seen?.reason, "with the deadline's own error").to.equal(error);
    expect(() => seen?.throwIfAborted()).to.throw(
      "The sweep did not finish within 1 s",
    );

    let finished: AbortSignal | undefined;
    await withDeadline("The sweep", 5, async (signal) => {
      finished = signal;
      return "done";
    });
    expect(finished?.aborted, "work that finishes in time").to.equal(false);

    let signed = 0;
    const batches = async (signal: AbortSignal) => {
      for (;;) {
        signal.throwIfAborted();
        signed += 1;
        await new Promise((done) => setTimeout(done, 100));
      }
    };
    await withDeadline("The sweep", 1, batches).catch(() => {});
    await new Promise((done) => setTimeout(done, 300));
    const atDeadline = signed;
    await new Promise((done) => setTimeout(done, 500));
    expect(atDeadline, "it signed before the deadline").to.be.above(3);
    expect(signed, "and nothing after it").to.equal(atDeadline);
  });

  describe("the keeper's order keys", () => {
    const seed = Uint8Array.from({ length: 32 }, (_, nth) => nth + 1);
    const keysAt = (indices: number[]) => ({
      orderKeys: indices.map((index) => deriveOrderKey(seed, index).publicKey),
    });
    const inFolder = (run: (path: string) => void) => {
      const folder = mkdtempSync(join(tmpdir(), "keeper-keys-"));
      try {
        run(join(folder, "keeper-order-keys.json"));
      } finally {
        rmSync(folder, { recursive: true });
      }
    };

    it("is picked up from the saved checkpoint far past index 100,000, without searching from index 0", () => {
      inFolder((path) => {
        const far = 250_000;
        const indices = [far + 2, far + 1, far + 3, far];
        const checkpoint = { indices, nextIndex: far + 4 };
        saveOrderKeyCheckpoint(path, checkpoint);
        expect(
          () => OrderKeyManager.fromView(seed, keysAt(indices), 1_000),
          "a search from index 0 does not reach them",
        ).to.throw("do not all derive");

        const began = Date.now();
        const restored = orderKeysFor(seed, keysAt(indices), path);
        expect(
          Date.now() - began,
          "250,000 derivations would take tens of seconds",
        ).to.be.below(2_000);
        expect(restored.checkpoint).to.deep.equal(checkpoint);
        expect(restored.take().replacementIndex).to.equal(far + 4);

        const moved = [far + 5, far + 1, far + 4, far];
        const later = orderKeysFor(seed, keysAt(moved), path);
        expect(
          later.publicKeys.map(String),
          "keys that rotated after the last save are found beside it",
        ).to.deep.equal(keysAt(moved).orderKeys.map(String));
        expect(later.checkpoint.nextIndex).to.equal(far + 6);
      });
    });

    it("keeps its checkpoint readable by its owner only, with places in it and no secret", () => {
      inFolder((path) => {
        const keys = OrderKeyManager.fresh(seed);
        keys.confirm(keys.take());
        keepOrderKeys(path, keys);
        expect(statSync(path).mode & 0o777).to.equal(0o600);
        const text = readFileSync(path, "utf8");
        expect(Object.keys(JSON.parse(text)).sort()).to.deep.equal([
          "indices",
          "nextIndex",
        ]);
        expect(loadOrderKeyCheckpoint(path)).to.deep.equal(keys.checkpoint);
        expect(text).to.not.include(Buffer.from(seed).toString("hex"));
      });
    });

    it("keeps one manager across sweeps and brings it in line with the view instead of searching again", () => {
      inFolder((path) => {
        const mine = OrderKeyManager.fresh(seed);
        const theirs = OrderKeyManager.fresh(seed);
        for (let nth = 0; nth < 3; nth += 1) theirs.confirm(theirs.take());
        const kept = orderKeysFor(
          seed,
          { orderKeys: theirs.publicKeys },
          path,
          mine,
        );
        expect(kept, "the same manager").to.equal(mine);
        expect(kept.publicKeys.map(String)).to.deep.equal(
          theirs.publicKeys.map(String),
        );

        const far = 300_000;
        const indices = [far, far + 1, far + 2, far + 3];
        saveOrderKeyCheckpoint(path, { indices, nextIndex: far + 4 });
        const lost = orderKeysFor(seed, keysAt(indices), path, mine);
        expect(lost, "a view it cannot find is picked up again").to.not.equal(
          mine,
        );
        expect(lost.checkpoint.indices).to.deep.equal(indices);
      });
    });

    it("falls back to searching from index 0 when the checkpoint is missing, damaged or another seat's", () => {
      inFolder((path) => {
        const indices = [9, 3, 4, 7];
        const view = keysAt(indices);
        expect(loadOrderKeyCheckpoint(path), "missing").to.equal(null);
        expect(orderKeysFor(seed, view, path).checkpoint.indices).to.deep.equal(
          indices,
        );
        for (const text of [
          "{",
          "[]",
          '{"indices":[1,2,3],"nextIndex":-4}',
          '{"indices":"a","nextIndex":4}',
        ]) {
          writeFileSync(path, text);
          expect(loadOrderKeyCheckpoint(path), text).to.equal(null);
          expect(
            orderKeysFor(seed, view, path).checkpoint.indices,
            text,
          ).to.deep.equal(indices);
        }
        saveOrderKeyCheckpoint(path, {
          indices: [50_000, 50_001, 50_002, 50_003],
          nextIndex: 50_004,
        });
        expect(
          orderKeysFor(seed, view, path).checkpoint.indices,
          "another seat's",
        ).to.deep.equal(indices);
      });
    });

    it("goes on when the checkpoint cannot be saved", () => {
      inFolder((path) => {
        writeFileSync(path, "a file where a folder is needed");
        expect(() =>
          keepOrderKeys(
            join(path, "keeper-order-keys.json"),
            OrderKeyManager.fresh(seed),
          ),
        ).to.not.throw();
      });
    });
  });

  describe("the drills", () => {
    const refusedBy = (code: number | null): Attempt => ({
      accepted: false,
      code,
      message: "transaction failed",
    });
    const acceptedAs: Attempt = { accepted: true, detail: "rested" };

    it("runs every drill in its own order by default, and only the ones DRILLS names otherwise", () => {
      expect(drillsSelected(undefined)).to.deep.equal([...DRILLS]);
      expect(drillsSelected("")).to.deep.equal([...DRILLS]);
      expect(drillsSelected(" , ")).to.deep.equal([...DRILLS]);
      expect(drillsSelected("rebind")).to.deep.equal(["rebind"]);
      expect(
        drillsSelected("rebind, guard-trip,rebind"),
        "in the drills' order, each once",
      ).to.deep.equal(["guard-trip", "rebind"]);
      expect(() => drillsSelected("guard-trip,depeg")).to.throw(
        /depeg, which is not a drill.*Nothing was sent/,
      );
      expect(() => drillsSelected("Rebind")).to.throw(/not a drill/);
    });

    it("never runs on mainnet, under any profile, and drills only the mainnet profile's market", () => {
      expect(drillRefusal({ mainnet: false, profile: "mainnet" })).to.equal(
        null,
      );
      for (const profile of ["mainnet", "test"] as const) {
        expect(drillRefusal({ mainnet: true, profile })).to.match(
          /never run on mainnet.*Nothing was sent/,
        );
      }
      expect(drillRefusal({ mainnet: false, profile: "test" })).to.match(
        /PROFILE=mainnet.*Nothing was sent/,
      );
    });

    it("counts a refusal as ok only with the error RULES names, and a taken order as ok only where RULES takes it", () => {
      const guard = DRILL_ERRORS.QuoteGuardTripped;
      expect(refusedWith("growth", refusedBy(6081), guard)).to.deep.equal({
        verdict: "ok",
        what: "growth",
        detail: "refused with QuoteGuardTripped (6081)",
      });
      const stale = refusedWith(
        "growth",
        refusedBy(DRILL_ERRORS.StalePrice),
        guard,
      );
      expect(stale.verdict, "refused, but for another rule").to.equal("FAIL");
      expect(stale.detail).to.equal(
        "refused with StalePrice (6038), not QuoteGuardTripped (6081)",
      );
      expect(refusedWith("growth", refusedBy(null), guard).verdict).to.equal(
        "FAIL",
      );
      expect(
        refusedWith("growth", acceptedAs, DRILL_ERRORS.StalePrice).detail,
      ).to.equal(
        "taken (rested), where RULES refuses it with StalePrice (6038)",
      );
      expect(taken("reduce", acceptedAs).verdict).to.equal("ok");
      expect(taken("reduce", refusedBy(6081))).to.deep.equal({
        verdict: "FAIL",
        what: "reduce",
        detail: "refused with QuoteGuardTripped (6081), where RULES takes it",
      });
      expect(taken("reduce", refusedBy(6999)).detail).to.include("6999");
    });

    it("reads a placed order's result as taken only when the program did not turn it away", () => {
      const result = (status: number, code = 0) => ({
        status,
        code,
        filled: 0n,
      });
      expect(
        orderAttempt(result(RESULT_STATUS.refused, 81), 10n),
      ).to.deep.equal({ accepted: false, code: 6081, message: "refused" });
      const wouldMatch = orderAttempt(
        result(RESULT_STATUS.refusedPostOnlyWouldMatch),
        10n,
      );
      expect(
        wouldMatch.accepted,
        "a post-only order that would match",
      ).to.equal(false);
      expect(taken("growth once fresh", wouldMatch).verdict).to.equal("FAIL");
      expect(
        orderAttempt({ ...result(RESULT_STATUS.filled), filled: 4n }, 10n),
      ).to.deep.equal({
        accepted: true,
        detail: "filled, 4 of 10 lots filled",
      });
      for (const status of [
        RESULT_STATUS.rested,
        RESULT_STATUS.remainderCancelled,
      ]) {
        expect(orderAttempt(result(status), 10n).accepted).to.equal(true);
      }
    });

    it("calls the guard synced by someone else when it no longer reads as failing, or a newer observation landed", () => {
      const unread = { state: QUOTE_STATE.unbound, publishTime: 0n };
      expect(quoteMoved(unread, unread, QUOTE_STATE.unbound)).to.equal(false);
      const healthy = { state: QUOTE_STATE.healthy, publishTime: 1_000n };
      expect(quoteMoved(unread, healthy, QUOTE_STATE.unbound)).to.equal(true);
      expect(
        quoteMoved(healthy, healthy, QUOTE_STATE.unbound),
        "already synced before the check",
      ).to.equal(true);
      const depegged = { state: QUOTE_STATE.depegged, publishTime: 1_000n };
      expect(quoteMoved(depegged, depegged, QUOTE_STATE.depegged)).to.equal(
        false,
      );
      expect(
        quoteMoved(
          depegged,
          { ...depegged, publishTime: 1_001n },
          QUOTE_STATE.depegged,
        ),
        "a newer depegged observation",
      ).to.equal(true);
    });

    it("turns a check that was not ok into a skip when someone synced meanwhile, and keeps an ok", () => {
      const ok = { verdict: "ok" as const, what: "growth", detail: "" };
      const fail = { verdict: "FAIL" as const, what: "growth", detail: "" };
      const crank = { verdict: "SKIP" as const, what: "growth", detail: "" };
      expect(unlessSyncedMeanwhile(fail, true, crank)).to.equal(crank);
      expect(unlessSyncedMeanwhile(fail, false, crank)).to.equal(fail);
      expect(unlessSyncedMeanwhile(ok, true, crank)).to.equal(ok);
    });

    it("calls a mark stale only once it is older than the max age, and a mark that got newer a crank's doing", () => {
      expect(staleWait(1_000n, 1_000n, 1_090, 90n)).to.equal("waiting");
      expect(staleWait(1_000n, 1_000n, 1_091, 90n)).to.equal("stale");
      expect(staleWait(1_000n, 1_001n, 1_200, 90n)).to.equal(
        "synced meanwhile",
      );
      expect(
        staleWait(1_000n, 999n, 1_200, 90n),
        "older is not synced",
      ).to.equal("stale");
    });

    it("trips the guard by RULES 9a: strictly more than depeg_bps from a dollar", () => {
      expect(guardTrips(99_983_000n, -8, 1), "1.7 bps under").to.equal(true);
      expect(guardTrips(100_010_000n, -8, 1), "exactly 1 bp over").to.equal(
        false,
      );
      expect(guardTrips(100_010_001n, -8, 1)).to.equal(true);
      expect(guardTrips(99_995_000n, -8, 1), "half a bp").to.equal(false);
      expect(guardTrips(99_000_000n, -8, 100), "the launch's 1%").to.equal(
        false,
      );
      expect(guardTrips(98_999_999n, -8, 100)).to.equal(true);
      expect(guardTrips(1_000_000n, -6, 1)).to.equal(false);
    });

    it("closes two positions against each other as far as they offset, the long selling", () => {
      expect(closingTrade([7n, -7n])).to.deep.equal({
        long: 0,
        short: 1,
        size: 7n,
      });
      expect(closingTrade([-3n, 10n])).to.deep.equal({
        long: 1,
        short: 0,
        size: 3n,
      });
      expect(closingTrade([12n, -5n])?.size).to.equal(5n);
      expect(closingTrade([0n, 0n])).to.equal(null);
      expect(closingTrade([4n, 6n]), "both long").to.equal(null);
      expect(closingTrade([0n, -6n])).to.equal(null);
    });

    it("reads a book's funding state at the program's offsets and holds a rebind to clearing it", () => {
      const data = new Uint8Array(ACCOUNT_LEN.book);
      data.set(new TextEncoder().encode(ACCOUNT_TAG.book));
      const body = new DataView(data.buffer, 16);
      body.setBigInt64(16, 77n, true);
      body.setBigInt64(24, 1_700_000_100n, true);
      body.setBigInt64(48, -42n, true);
      body.setBigUint64(56, 9n, true);
      const read = bookFunding(data);
      expect(read).to.deep.equal({
        lastTime: 1_700_000_100n,
        tradedPremium: -42n,
        tradedSize: 9n,
      });
      if (!read) return;
      expect(bookFunding(data.subarray(0, 16 + 72)), "too short").to.equal(
        null,
      );
      const market = data.slice();
      market.set(new TextEncoder().encode(ACCOUNT_TAG.market));
      expect(bookFunding(market), "another account's tag").to.equal(null);
      expect(fundingReset(read, 1_700_000_000), "totals left").to.equal(false);
      const cleared = { ...read, tradedPremium: 0n, tradedSize: 0n };
      expect(fundingReset(cleared, 1_700_000_000)).to.equal(true);
      expect(fundingReset(cleared, 1_700_000_100)).to.equal(true);
      expect(
        fundingReset(cleared, 1_700_000_101),
        "a clock not restarted by the rebind",
      ).to.equal(false);
      expect(fundingReset({ ...cleared, tradedSize: 1n }, 0)).to.equal(false);
    });

    it("waits for the next observation when a sync was beaten or aged out, and stops on any other refusal", () => {
      for (const code of [6070, 6073, 6079]) {
        expect(syncWaitsOn(code)).to.equal(true);
      }
      for (const code of [null, 6141, 6145, 6146, 6080]) {
        expect(syncWaitsOn(code)).to.equal(false);
      }
    });

    it("prints a line per check and fails the run on any FAIL, and on a skip unless it is an aside", () => {
      expect(
        lineText({ verdict: "ok", what: "the guard passes", detail: "" }),
      ).to.equal("ok   the guard passes");
      expect(
        lineText({ verdict: "SKIP", what: "funding", detail: "private" }),
      ).to.equal("SKIP funding: private");
      const ok = { verdict: "ok" as const, what: "a", detail: "" };
      const skip = { verdict: "SKIP" as const, what: "b", detail: "" };
      const fail = { verdict: "FAIL" as const, what: "c", detail: "" };
      const aside = { ...skip, aside: true };
      expect(exitCodeFor([])).to.equal(0);
      expect(exitCodeFor([ok, aside])).to.equal(0);
      expect(unproven([ok, aside])).to.deep.equal([]);
      expect(exitCodeFor([ok, skip]), "a claim left unproven").to.equal(1);
      expect(unproven([ok, skip, aside])).to.deep.equal([skip]);
      expect(exitCodeFor([ok, aside, fail])).to.equal(1);
    });
  });
});

describe("what the access command decides, without a network", () => {
  const PERPS = [0, 1];
  const OWNER = Keypair.generate().publicKey;
  const asked = (settings: Record<string, string>) =>
    accessRequest(settings, PERPS);

  it("takes the three commands and refuses any other, or none", () => {
    for (const command of ["show", "market", "seat"]) {
      expect(accessCommand(command)).to.equal(command);
    }
    expect(() => accessCommand(undefined)).to.throw("Set ACCESS");
    expect(() => accessCommand("")).to.throw("Set ACCESS");
    expect(() => accessCommand("list")).to.throw(
      "use one of: show, market, seat",
    );
  });

  it("reads show, with or without a seat owner, and refuses a key that is not one", () => {
    expect(asked({ ACCESS: "show" })).to.deep.equal({
      command: "show",
      owner: null,
    });
    expect(
      asked({ ACCESS: "show", SEAT_OWNER: OWNER.toBase58() }),
    ).to.deep.equal({ command: "show", owner: OWNER });
    expect(() => asked({ ACCESS: "show", SEAT_OWNER: "nobody" })).to.throw(
      "not a public key",
    );
  });

  it("reads market for a perp market and on or off only", () => {
    expect(
      asked({ ACCESS: "market", MARKET: "1", MAKERS: "on", TAKERS: "off" }),
    ).to.deep.equal({
      command: "market",
      marketId: 1,
      access: { makersListed: true, takersListed: false },
    });
    const base = { ACCESS: "market", MARKET: "0", MAKERS: "on", TAKERS: "on" };
    expect(() => asked({ ...base, MARKET: undefined as never })).to.throw(
      "Set MARKET",
    );
    for (const market of ["2", "-1", "01", "1.5", "x", "0,1"]) {
      expect(() => asked({ ...base, MARKET: market }), market).to.throw(
        "MARKET names",
      );
    }
    for (const value of ["yes", "ON", "true", "1", ""]) {
      expect(() => asked({ ...base, MAKERS: value }), value).to.throw(/MAKERS/);
      expect(() => asked({ ...base, TAKERS: value }), value).to.throw(/TAKERS/);
    }
  });

  it("reads seat into bits per market, none as zero, and refuses an unknown market, a repeat or a mix", () => {
    const base = {
      ACCESS: "seat",
      SEAT_OWNER: OWNER.toBase58(),
      MAKER_MARKETS: "none",
      TAKER_MARKETS: "none",
      BLOCKED: "no",
    };
    expect(asked(base)).to.deep.equal({
      command: "seat",
      owner: OWNER,
      access: { makerMarkets: 0n, takerMarkets: 0n, blocked: false },
    });
    expect(
      asked({
        ...base,
        MAKER_MARKETS: "1",
        TAKER_MARKETS: "0, 1",
        BLOCKED: "yes",
      }),
    ).to.deep.equal({
      command: "seat",
      owner: OWNER,
      access: { makerMarkets: 0b10n, takerMarkets: 0b11n, blocked: true },
    });
    for (const markets of ["2", "0,0", "none,1", "0,", ",", "all", "-1"]) {
      expect(
        () => asked({ ...base, MAKER_MARKETS: markets }),
        markets,
      ).to.throw("MAKER_MARKETS");
    }
    expect(() => asked({ ...base, TAKER_MARKETS: "7" })).to.throw(
      "TAKER_MARKETS names market 7",
    );
    for (const blocked of ["on", "true", "YES", ""]) {
      expect(() => asked({ ...base, BLOCKED: blocked }), blocked).to.throw(
        /BLOCKED/,
      );
    }
    expect(() => asked({ ...base, SEAT_OWNER: "" })).to.throw("Set SEAT_OWNER");
    expect(() => asked({ ...base, SEAT_OWNER: "abc" })).to.throw(
      "not a public key",
    );
  });

  it("lists the markets in a mask and reads a market's two switches", () => {
    expect(marketsIn(0n)).to.deep.equal([]);
    expect(marketsIn(0b101n)).to.deep.equal([0, 2]);
    expect(
      marketsIn((1n << 63n) | 1n),
      "the lists are 64 bits wide",
    ).to.deep.equal([0, 63]);
    expect(switchesOf(0)).to.deep.equal({
      makersListed: false,
      takersListed: false,
    });
    expect(switchesOf(MARKET_ACCESS.takersListed)).to.deep.equal({
      makersListed: false,
      takersListed: true,
    });
    expect(
      switchesText(
        switchesOf(MARKET_ACCESS.makersListed | MARKET_ACCESS.takersListed),
      ),
    ).to.equal("maker list on, taker list on");
  });

  it("sends set_seat_access behind the full compute budget, with the same accounts whatever it sets", () => {
    const instructions = new Instructions(PROGRAM_ID);
    const admin = Keypair.generate().publicKey;
    const built = [
      { makerMarkets: 0n, takerMarkets: 0n, blocked: true },
      { makerMarkets: 0b11n, takerMarkets: 0b11n, blocked: false },
    ].map((access) =>
      seatAccessInstructions(instructions, admin, OWNER, access, PERPS),
    );
    for (const [budget, call] of built) {
      expect(budget.programId.equals(ComputeBudgetProgram.programId)).to.equal(
        true,
      );
      expect(budget.data.readUInt32LE(1)).to.equal(1_400_000);
      expect(call.programId.equals(PROGRAM_ID)).to.equal(true);
    }
    const accounts = (call: { keys: { pubkey: { toBase58(): string } }[] }) =>
      call.keys.map(({ pubkey }) => pubkey.toBase58());
    expect(accounts(built[0][1])).to.deep.equal(accounts(built[1][1]));
    expect(accounts(built[0][1])).to.have.length(4 + PERPS.length);
  });
});

describe("what the fund command decides, without a network", () => {
  const OWNER = Keypair.generate().publicKey;
  const asked = (settings: Record<string, string>) => fundRequest(settings);

  it("reads whom to fund and a whole number of tokens above zero, and refuses anything else", () => {
    const request = asked({ OWNER: OWNER.toBase58(), AMOUNT: "250" });
    expect(request.owner.equals(OWNER)).to.equal(true);
    expect(request.tokens).to.equal(250n);
    expect(() => asked({ AMOUNT: "1" })).to.throw("Set OWNER");
    expect(() => asked({ OWNER: "not a key", AMOUNT: "1" })).to.throw(
      "not a public key",
    );
    expect(() => asked({ OWNER: OWNER.toBase58() })).to.throw("Set AMOUNT");
    for (const amount of ["0", "-5", "1.5", "ten", "1e3", " 7"]) {
      expect(
        () => asked({ OWNER: OWNER.toBase58(), AMOUNT: amount }),
        amount,
      ).to.throw("not a whole number of tokens above zero");
    }
  });

  it("counts atoms by the token's decimals and refuses more than an amount holds", () => {
    expect(fundingAtoms(250n, 6)).to.equal(250_000_000n);
    expect(fundingAtoms(1n, 9)).to.equal(1_000_000_000n);
    expect(fundingAtoms(18_446_744_073_709n, 6)).to.equal(
      18_446_744_073_709_000_000n,
    );
    expect(() => fundingAtoms(18_446_744_073_710n, 6)).to.throw(
      "more atoms than an amount can hold",
    );
  });

  it("never runs on mainnet, whatever the profile", () => {
    expect(fundRefusal({ mainnet: false })).to.equal(null);
    expect(fundRefusal({ mainnet: true })).to.match(
      /never runs on mainnet.*Nothing was sent/,
    );
  });

  it("mints only a token whose mint authority is the admin", () => {
    const admin = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    expect(mintRefusal(mint, admin, admin)).to.equal(null);
    expect(mintRefusal(mint, Keypair.generate().publicKey, admin)).to.match(
      /not the admin.*Nothing was sent/,
    );
    expect(mintRefusal(mint, null, admin)).to.match(/no mint authority/);
  });

  it("tells the program's two refusals of the deposit apart from any other", () => {
    const failed = (code: number) =>
      `{"InstructionError":[0,{"Custom":${code}}]}\nProgram log`;
    expect(depositFailure(failed(CUSTODY_CAP_REACHED), OWNER).message).to.match(
      /cannot hold more of this token.*Nothing was deposited/,
    );
    expect(depositFailure(failed(NO_SEAT), OWNER).message).to.match(
      new RegExp(`${OWNER.toBase58()} has no open seat.*through the gate`),
    );
    expect(depositFailure(failed(6038), OWNER).message).to.equal(
      `The deposit was refused: ${failed(6038)}`,
    );
    expect(depositFailure("timed out", OWNER).message).to.equal(
      "The deposit was refused: timed out",
    );
  });
});

describe("what the faucet command decides, without a network", () => {
  const program = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const faucet = Keypair.generate().publicKey;
  const described = (symbol: string) => ({
    programId: program.toBase58(),
    tokens: [{ mint: mint.toBase58(), symbol }],
  });

  it("reads AMOUNT as a whole number of tokens above zero, and refuses anything else", () => {
    expect(wholeTokens("250000")).to.equal(250_000n);
    expect(() => wholeTokens(undefined)).to.throw("Set AMOUNT");
    expect(() => wholeTokens("")).to.throw("Set AMOUNT");
    for (const amount of ["0", "-5", "1.5", "ten", "1e3", " 7"]) {
      expect(() => wholeTokens(amount), amount).to.throw(
        "not a whole number of tokens above zero",
      );
    }
  });

  it("never runs on mainnet", () => {
    expect(faucetRefusal({ mainnet: false })).to.equal(null);
    expect(faucetRefusal({ mainnet: true })).to.match(
      /never set up on mainnet.*Nothing was sent/,
    );
  });

  it("names a faucet only in the description of this program that lists the quote token under a symbol the fund desk finds", () => {
    expect(faucetDescriptionRefusal(described("USDC"), program, mint)).to.equal(
      null,
    );
    expect(faucetDescriptionRefusal(described("nUSD"), program, mint)).to.equal(
      null,
    );
    expect(faucetDescriptionRefusal(null, program, mint)).to.match(
      /no deployment description.*Nothing was sent/,
    );
    expect(
      faucetDescriptionRefusal(
        described("USDC"),
        Keypair.generate().publicKey,
        mint,
      ),
    ).to.match(/is of program .*Nothing was sent/);
    expect(
      faucetDescriptionRefusal(
        described("USDC"),
        program,
        Keypair.generate().publicKey,
      ),
    ).to.match(/does not list the quote token/);
    expect(faucetDescriptionRefusal(described("DAI"), program, mint)).to.match(
      /listed as DAI; the fund desk looks for nUSD or USDC/,
    );
  });

  it("sets faucet after oracle, changes no other field, and is the same when repeated", () => {
    const before = {
      network: "rehearsal",
      profile: "mainnet",
      gate: "gate",
      oracle: "oracle",
      insuranceFunded: "3000000000",
      tokens: [{ index: 0, symbol: "USDC" }],
      markets: [],
    } as unknown as DeploymentDescription;
    const after = withFaucet(before, faucet);
    expect(Object.keys(after)).to.deep.equal([
      "network",
      "profile",
      "gate",
      "oracle",
      "faucet",
      "insuranceFunded",
      "tokens",
      "markets",
    ]);
    expect(after.faucet).to.equal(faucet.toBase58());
    const { faucet: _named, ...others } = after;
    expect(others).to.deep.equal(before);
    expect(withFaucet(after, faucet)).to.deep.equal(after);
    expect(JSON.stringify(withFaucet(after, faucet))).to.equal(
      JSON.stringify(after),
    );
    const other = Keypair.generate().publicKey;
    expect(withFaucet(after, other).faucet).to.equal(other.toBase58());
    expect(before).to.not.have.property("faucet");
  });
});

describe("what the handover commands decide, without a network", () => {
  const admin = Keypair.generate().publicKey;
  const hardware = Keypair.generate().publicKey;
  const upgrader = Keypair.generate().publicKey;
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault")],
    Keypair.generate().publicKey,
  );

  it("refuses a nominee that is the admin, the upgrade authority or an address no key signs for, and allows a hardware key", () => {
    expect(nominationRefusal(hardware, admin, upgrader)).to.equal(null);
    expect(nominationRefusal(hardware, admin, null)).to.equal(null);
    expect(nominationRefusal(admin, admin, upgrader)).to.match(
      /is the admin already.*Nothing was sent/,
    );
    expect(nominationRefusal(upgrader, admin, upgrader)).to.match(
      /upgrade authority.*never one key.*Nothing was sent/,
    );
    expect(nominationRefusal(vault, admin, upgrader)).to.match(
      /not a key anyone signs with.*could never accept.*Nothing was sent/,
    );
  });

  it("tells the nominee to accept from the console and to check the address another way, and says when nothing was sent", () => {
    const steps = acceptSteps(hardware, "mainnet", false).join("\n");
    expect(steps).to.include(`${hardware.toBase58()} is now the pending admin`);
    expect(steps).to.include("second channel");
    expect(steps).to.include("admin console");
    expect(steps).to.include("accept_admin");
    expect(steps).to.include("make mainnet-status");
    expect(steps).to.include("can no longer send as admin");
    expect(acceptSteps(hardware, "mainnet", true)[0]).to.match(
      /already the pending admin\. Nothing was sent/,
    );
  });

  it("refuses to sign as an admin the exchange no longer has, and says the console is the admin then", () => {
    expect(adminRefusal(admin, admin, ".keys/mainnet-admin.json")).to.equal(
      null,
    );
    expect(adminRefusal(hardware, admin, ".keys/mainnet-admin.json")).to.match(
      /admin is .*not .*mainnet-admin\.json.*console is the admin.*Nothing was sent/,
    );
  });

  it("prints the exact solana command for the upgrade authority, with no signature asked of the vault", () => {
    const command = upgradeAuthorityCommand({
      programId: PROGRAM_ID,
      authority: vault,
      keyFile: ".keys/mainnet-admin.json",
      url: "https://api.mainnet-beta.solana.com",
    });
    expect(command).to.equal(
      `solana program set-upgrade-authority ${PROGRAM_ID.toBase58()} ` +
        `--new-upgrade-authority ${vault.toBase58()} ` +
        "--skip-new-upgrade-authority-signer-check " +
        "--upgrade-authority .keys/mainnet-admin.json " +
        "--keypair .keys/mainnet-admin.json " +
        "--url https://api.mainnet-beta.solana.com",
    );
  });

  it("keeps the signer check and names the new key's file when the new authority is a plain key", () => {
    const command = upgradeAuthorityCommand({
      programId: PROGRAM_ID,
      authority: hardware,
      keyFile: ".keys/mainnet-admin.json",
      url: "https://api.mainnet-beta.solana.com",
      newKeyFile: ".keys/upgrade.json",
    });
    expect(command).to.include("--new-upgrade-authority .keys/upgrade.json");
    expect(command).to.not.include("skip-new-upgrade-authority-signer-check");
  });

  it("warns when the multisig address is an ordinary key, and always points at the threshold check", () => {
    expect(upgradeAuthorityNotes(vault)).to.have.length(2);
    expect(upgradeAuthorityNotes(vault).join(" ")).to.include("threshold");
    const notes = upgradeAuthorityNotes(hardware);
    expect(notes).to.have.length(3);
    expect(notes[0]).to.match(/ordinary key.*not of a program/);
  });

  it("refuses to move a final program's authority or give it to the admin, and reads the move back", () => {
    expect(upgradeAuthorityRefusal(vault, upgrader, admin)).to.equal(null);
    expect(upgradeAuthorityRefusal(vault, null, admin)).to.match(
      /no upgrade authority.*final.*Nothing was sent/,
    );
    expect(upgradeAuthorityRefusal(admin, upgrader, admin)).to.match(
      /is the exchange's admin.*Nothing was sent/,
    );
    expect(upgradeAuthorityCheck(vault, vault)).to.deep.include({
      moved: true,
    });
    const still = upgradeAuthorityCheck(upgrader, vault);
    expect(still.moved).to.equal(false);
    expect(still.line).to.include(`still ${upgrader.toBase58()}`);
    expect(still.line).to.include("Run the command above");
    expect(upgradeAuthorityCheck(null, vault).line).to.match(/final/);
  });
});

describe("what the update-market command decides, without a network", () => {
  const { settings } = launchMarket(DEFAULT_INSURANCE);
  const launch = {
    openInterestCap: settings.limits.openInterestCap as bigint,
    positionCap: settings.limits.positionCap,
    maxPriceAge: settings.limits.maxPriceAge,
  };
  const found = {
    ...settings.limits,
    openInterestCap: launch.openInterestCap,
    positionCap: launch.positionCap,
    kind: settings.kind,
    status: MARKET_STATUS.reduceOnly,
  } as MarketParams;
  const covered = launch.openInterestCap;
  const change = (
    asked: {
      openInterestCap?: bigint;
      positionCap?: bigint;
      maxPriceAge?: bigint;
    },
    cover = covered,
    now: MarketParams = found,
  ) =>
    limitsChange(now, launch, cover, {
      openInterestCap: asked.openInterestCap ?? null,
      positionCap: asked.positionCap ?? null,
      maxPriceAge: asked.maxPriceAge ?? null,
    });

  it("reads the limits as whole numbers, needs one of them, and sends only on APPLY=yes", () => {
    expect(limitsRequest({ OPEN_INTEREST_CAP: "50000" })).to.deep.equal({
      openInterestCap: 50_000n,
      positionCap: null,
      maxPriceAge: null,
      apply: false,
    });
    expect(limitsRequest({ POSITION_CAP: "9000", APPLY: "yes" })).to.deep.equal(
      {
        openInterestCap: null,
        positionCap: 9_000n,
        maxPriceAge: null,
        apply: true,
      },
    );
    expect(limitsRequest({ MAX_PRICE_AGE: "10" })).to.deep.equal({
      openInterestCap: null,
      positionCap: null,
      maxPriceAge: 10n,
      apply: false,
    });
    for (const bad of ["0", "-1", "1.5", "ten", "010"]) {
      expect(() => limitsRequest({ MAX_PRICE_AGE: bad }), bad).to.throw(
        "not a whole number of seconds above zero",
      );
    }
    expect(() => limitsRequest({})).to.throw("Set OPEN_INTEREST_CAP");
    for (const bad of ["0", "-5", "1.5", "ten", "1e3", " 7", "07"]) {
      expect(() => limitsRequest({ POSITION_CAP: bad }), bad).to.throw(
        "not a whole number of lots above zero",
      );
    }
    expect(() =>
      limitsRequest({ POSITION_CAP: "18446744073709551616" }),
    ).to.throw("not a whole number of lots");
    expect(() =>
      limitsRequest({ POSITION_CAP: "9000", APPLY: "true" }),
    ).to.throw("use APPLY=yes");
  });

  it("lowers a cap and writes every other limit back exactly as the market has it", () => {
    const lowered = change({ openInterestCap: 50_000n, positionCap: 10_000n });
    expect(lowered.openInterestCap).to.equal(50_000n);
    expect(lowered.positionCap).to.equal(10_000n);
    const { openInterestCap: _o, positionCap: _p, ...others } = lowered.limits;
    const {
      openInterestCap: _fo,
      positionCap: _fp,
      kind: _k,
      status: _s,
      ...kept
    } = found;
    for (const [field, value] of Object.entries(others)) {
      expect(value, field).to.equal((kept as Record<string, unknown>)[field]);
    }
    expect(Object.keys(others)).to.have.length(17);
  });

  it("keeps a cap that was not asked for", () => {
    const only = change({ positionCap: 10_000n });
    expect(only.openInterestCap).to.equal(launch.openInterestCap);
    expect(only.limits.openInterestCap).to.equal(launch.openInterestCap);
  });

  it("refuses a change that changes nothing", () => {
    expect(() => change({ openInterestCap: launch.openInterestCap })).to.throw(
      /already has.*Nothing was sent/,
    );
  });

  it("sets the max price age to the launch's figure only, keeping the caps and every other limit", () => {
    const older = { ...found, maxPriceAge: 60n } as MarketParams;
    const set = change({ maxPriceAge: launch.maxPriceAge }, covered, older);
    expect(set.limits.maxPriceAge).to.equal(launch.maxPriceAge);
    expect(set.openInterestCap).to.equal(older.openInterestCap);
    expect(set.positionCap).to.equal(older.positionCap);
    expect(set.limits.settleWindow).to.equal(older.settleWindow);
    expect(() => change({ maxPriceAge: 5n }, covered, older)).to.throw(
      /MAX_PRICE_AGE is 5 s\. The launch's is 10 s.*Nothing was sent/,
    );
    expect(() => change({ maxPriceAge: 3_600n }, covered, older)).to.throw(
      /only one the other commands accept/,
    );
    expect(() => change({ maxPriceAge: launch.maxPriceAge })).to.throw(
      /already has.*max price age of 10 s.*Nothing was sent/,
    );
  });

  it("never goes past the launch's caps, even when insurance would cover more", () => {
    expect(() =>
      change({ openInterestCap: launch.openInterestCap + 1n }, covered * 10n),
    ).to.throw(/above the launch's.*never goes past.*Nothing was sent/);
    expect(() =>
      change({ positionCap: launch.positionCap + 1n }, covered * 10n),
    ).to.throw(/position cap.*above the launch's.*never goes past/);
  });

  it("keeps the position cap within the open interest cap", () => {
    expect(() => change({ openInterestCap: 10_000n })).to.throw(
      /position cap of 22222 lots is above the open interest cap of 10000.*lower POSITION_CAP too/,
    );
    expect(
      change({ openInterestCap: 10_000n, positionCap: 10_000n }).positionCap,
    ).to.equal(10_000n);
  });

  it("raises a lowered cap back only while insurance covers it at the live mark", () => {
    const lowered = {
      ...found,
      openInterestCap: 40_000n,
      positionCap: 8_000n,
    } as MarketParams;
    expect(
      change({ openInterestCap: 60_000n }, 60_000n, lowered).openInterestCap,
    ).to.equal(60_000n);
    expect(() =>
      change({ openInterestCap: 60_000n }, 59_999n, lowered),
    ).to.throw(/Insurance covers 59999 lots.*nothing is raised/);
    expect(() => change({ positionCap: 9_000n }, 10_000n, lowered)).to.throw(
      /Insurance covers 10000 lots.*40000/,
    );
    expect(change({ positionCap: 6_000n }, 0n, lowered).positionCap).to.equal(
      6_000n,
    );
  });

  it("counts what insurance covers from the mark, and none while there is no mark", () => {
    const on = { insurance: DEFAULT_INSURANCE };
    expect(lotsCovered(on, 150_000n, { liqPenaltyBps: 200 })).to.equal(
      launch.openInterestCap,
    );
    expect(lotsCovered(on, 250_000n, { liqPenaltyBps: 200 })).to.equal(66_666n);
    expect(lotsCovered(on, 0n, { liqPenaltyBps: 200 })).to.equal(0n);
  });
});

describe("what the pause and market-status commands decide, without a network", () => {
  it("reads PAUSED as yes or no and sends only on APPLY=yes", () => {
    expect(pauseRequest({ PAUSED: "yes" })).to.deep.equal({
      paused: true,
      apply: false,
      runningBuild: null,
    });
    expect(pauseRequest({ PAUSED: "no", APPLY: "yes" })).to.deep.equal({
      paused: false,
      apply: true,
      runningBuild: null,
    });
    expect(() => pauseRequest({})).to.throw(/Set PAUSED=yes.*Nothing was sent/);
    expect(() => pauseRequest({ PAUSED: "true" })).to.throw("not true");
    expect(() => pauseRequest({ PAUSED: "yes", APPLY: "true" })).to.throw(
      "use APPLY=yes",
    );
  });

  it("takes the build mainnet runs for a pause or a restriction, and refuses it for an unpause or a resume", () => {
    const RUNNING_BUILD = "target/mainnet/earlier/noirwire_orderbook.so";
    expect(
      pauseRequest({ PAUSED: "yes", RUNNING_BUILD }).runningBuild,
    ).to.equal(RUNNING_BUILD);
    for (const STATUS of ["paused", "reduce-only"]) {
      expect(
        statusRequest({ STATUS, RUNNING_BUILD }).runningBuild,
        STATUS,
      ).to.equal(RUNNING_BUILD);
    }
    expect(() => pauseRequest({ PAUSED: "no", RUNNING_BUILD })).to.throw(
      /RUNNING_BUILD is for pausing and restricting.*unpausing runs on this checkout's build.*Nothing was sent/,
    );
    expect(() => statusRequest({ STATUS: "active", RUNNING_BUILD })).to.throw(
      /a resume runs on this checkout's build.*Nothing was sent/,
    );
    expect(
      pauseRequest({ PAUSED: "no", RUNNING_BUILD: "" }).runningBuild,
    ).to.equal(null);
  });

  it("runs the one mark check before an unpause and before a resume, so both take its settings", () => {
    for (const command of ["pause", "market-status"]) {
      const source = readFileSync(`ops/${command}.ts`, "utf8");
      expect(source, command).to.include("await resumeRefusal(on)");
      expect(source, command).to.include(
        "deployedAsBuilt(on, request.runningBuild",
      );
    }
    const checking = readFileSync("ops/markchecking.ts", "utf8");
    expect(checking).to.include("export async function resumeRefusal");
    expect(checking).to.include("confirmed: true");
    expect(readFileSync("ops/pause.ts", "utf8")).to.not.include("Unpaused.");
  });

  it("refuses to set the exchange to the state it is in", () => {
    expect(pauseRefusal(false, true)).to.equal(null);
    expect(pauseRefusal(true, false)).to.equal(null);
    expect(pauseRefusal(true, true)).to.match(
      /already paused.*Nothing was sent/,
    );
    expect(pauseRefusal(false, false)).to.match(/already not paused/);
  });

  it("names the status asked for, and refuses anything else", () => {
    expect(statusRequest({ STATUS: "reduce-only" })).to.deep.equal({
      status: "reduce-only",
      apply: false,
      runningBuild: null,
    });
    expect(statusRequest({ STATUS: "active", APPLY: "yes" }).apply).to.equal(
      true,
    );
    expect(() => statusRequest({})).to.throw(
      /Set STATUS to one of paused, reduce-only, active.*Nothing was sent/,
    );
    expect(() => statusRequest({ STATUS: "resume" })).to.throw("not resume");
    expect(statusCode("paused")).to.equal(MARKET_STATUS.paused);
    expect(statusCode("reduce-only")).to.equal(MARKET_STATUS.reduceOnly);
    expect(statusCode("active")).to.equal(MARKET_STATUS.active);
  });

  it("refuses to set the market to the status it has", () => {
    expect(statusRefusal(MARKET_STATUS.active, "reduce-only")).to.equal(null);
    expect(statusRefusal(MARKET_STATUS.reduceOnly, "paused")).to.equal(null);
    expect(statusRefusal(MARKET_STATUS.paused, "active")).to.equal(null);
    expect(statusRefusal(MARKET_STATUS.paused, "paused")).to.match(
      /already has the status paused.*Nothing was sent/,
    );
  });
});

describe("what the seat command decides, without a network", () => {
  const maker = Keypair.generate().publicKey;
  const roles = {
    admin: Keypair.generate().publicKey,
    gate: Keypair.generate().publicKey,
    oracle: Keypair.generate().publicKey,
  };

  it("takes one of four steps, and an amount for the two that move money", () => {
    expect(seatRequest({ SEAT: "show" })).to.deep.equal({ command: "show" });
    expect(seatRequest({ SEAT: "open" })).to.deep.equal({ command: "open" });
    expect(seatRequest({ SEAT: "deposit", AMOUNT: "1000" })).to.deep.equal({
      command: "deposit",
      tokens: 1_000n,
    });
    expect(seatRequest({ SEAT: "withdraw", AMOUNT: "250" })).to.deep.equal({
      command: "withdraw",
      tokens: 250n,
    });
    expect(() => seatRequest({})).to.throw("Set SEAT to one of");
    expect(() => seatRequest({ SEAT: "close" })).to.throw(
      "SEAT is close; use one of: show, open, deposit, withdraw",
    );
    expect(() => seatRequest({ SEAT: "deposit" })).to.throw("Set AMOUNT");
    expect(() => seatRequest({ SEAT: "withdraw", AMOUNT: "0" })).to.throw(
      "not a whole number of tokens above zero",
    );
  });

  it("refuses a maker key that holds another role on the exchange", () => {
    expect(makerRefusal(maker, roles)).to.equal(null);
    for (const role of ["admin", "gate", "oracle"] as const) {
      expect(makerRefusal(roles[role], roles), role).to.match(
        new RegExp(
          `is the exchange's ${role}.*key of its own.*Nothing was sent`,
        ),
      );
    }
  });

  it("funds in USDC only on mainnet, and in whatever the test network's token is elsewhere", () => {
    const other = Keypair.generate().publicKey;
    expect(quoteRefusal({ mainnet: true }, MAINNET_USDC_MINT)).to.equal(null);
    expect(quoteRefusal({ mainnet: true }, other)).to.match(
      /not USDC.*USDC only.*Nothing was sent/,
    );
    expect(quoteRefusal({ mainnet: false }, other)).to.equal(null);
  });

  it("opens a seat only with the key the exchange names as its gate", () => {
    expect(
      gateRefusal(roles.gate, roles.gate, ".keys/mainnet-gate.json"),
    ).to.equal(null);
    expect(gateRefusal(roles.gate, maker, ".keys/mainnet-gate.json")).to.match(
      /gate is .*not the key at \.keys\/mainnet-gate\.json.*Nothing was sent/,
    );
  });

  it("pays out no more than public custody holds, and leaves a sealed custody to the program", () => {
    expect(withdrawRefusal(500n, 500n)).to.equal(null);
    expect(withdrawRefusal(501n, 500n)).to.match(
      /holds 500 atoms, fewer than the 501.*Nothing was sent/,
    );
    expect(withdrawRefusal(501n, null)).to.equal(null);
  });

  it("tells the program's two refusals of the deposit apart from any other", () => {
    const failed = (code: number) =>
      `{"InstructionError":[0,{"Custom":${code}}]}\nProgram log`;
    expect(seatDepositFailure(failed(CUSTODY_CAP_REACHED)).message).to.match(
      /cannot hold more of this token.*stays in the maker's balance/,
    );
    expect(seatDepositFailure(failed(NO_SEAT)).message).to.match(
      /no open seat.*SEAT=open/,
    );
    expect(seatDepositFailure(failed(6038)).message).to.equal(
      `The deposit was refused: ${failed(6038)}`,
    );
  });
});

describe("what the exit commands decide, without a network", () => {
  const owner = Keypair.generate().publicKey;
  const validator = Keypair.generate().publicKey;

  it("takes a key file and an amount, shuttles from the seat unless told otherwise, and refuses what it does not know", () => {
    expect(exitRequest({ KEYFILE: "k.json", AMOUNT: "0.25" })).to.deep.equal({
      keyFile: "k.json",
      amount: "0.25",
      method: "shuttle",
      from: "seat",
    });
    expect(
      exitRequest({
        KEYFILE: "k.json",
        AMOUNT: "5",
        METHOD: "undelegate",
        FROM: "rollup",
      }),
    ).to.include({ method: "undelegate", from: "rollup" });
    expect(() => exitRequest({ AMOUNT: "5" })).to.throw("Set KEYFILE");
    expect(() => exitRequest({ KEYFILE: "k.json" })).to.throw("Set AMOUNT");
    expect(() =>
      exitRequest({ KEYFILE: "k.json", AMOUNT: "5", METHOD: "bridge" }),
    ).to.throw("METHOD is bridge; use one of: shuttle, undelegate");
    expect(() =>
      exitRequest({ KEYFILE: "k.json", AMOUNT: "5", FROM: "vault" }),
    ).to.throw("FROM is vault; use one of: seat, rollup");
  });

  it("makes a round trip of dust unless an amount is given, and always from the seat", () => {
    expect(roundTripRequest({ KEYFILE: "k.json" })).to.deep.equal({
      keyFile: "k.json",
      amount: "0.01",
      method: "shuttle",
    });
    expect(
      roundTripRequest({ KEYFILE: "k.json", AMOUNT: "1" }).amount,
    ).to.equal("1");
    expect(() => roundTripRequest({})).to.throw("Set KEYFILE");
  });

  it("turns tokens into atoms exactly, and refuses what is not an amount the token holds", () => {
    expect(tokenAtoms("5", 6)).to.equal(5_000_000n);
    expect(tokenAtoms("0.01", 6)).to.equal(10_000n);
    expect(tokenAtoms("0.000001", 6)).to.equal(1n);
    expect(tokenAtoms("12.5", 6)).to.equal(12_500_000n);
    expect(() => tokenAtoms("0.0000001", 6)).to.throw(
      "more decimal places than the token has (6)",
    );
    for (const bad of ["0", "0.000000", "", "-1", "1e3", "1,5", "abc", ".5"]) {
      expect(() => tokenAtoms(bad, 6), bad).to.throw(
        /AMOUNT is .*Nothing was sent/,
      );
    }
    expect(() => tokenAtoms("18446744073709551616", 0)).to.throw(
      "a balance can hold",
    );
  });

  it("keeps a round trip to dust", () => {
    expect(roundTripRefusal(2_000_000n, 6)).to.equal(null);
    expect(roundTripRefusal(2_000_001n, 6)).to.match(
      /proof done with dust.*2 tokens at the most.*exit target.*Nothing was sent/,
    );
  });

  it("makes the owner's token account in the rollup only as far as it is missing", () => {
    expect(rollupBalanceStep(false, null, validator)).to.equal("create");
    expect(rollupBalanceStep(true, null, validator)).to.equal("delegate");
    expect(rollupBalanceStep(true, validator, validator)).to.equal("wait");
    const other = Keypair.generate().publicKey;
    expect(() => rollupBalanceStep(true, other, validator)).to.throw(
      /delegated to .*not to this rollup.*Nothing was sent/,
    );
  });

  it("leaves a sealed custody's missing token account to a deposit", () => {
    expect(sealedBalanceRefusal("public", owner)).to.equal(null);
    expect(sealedBalanceRefusal("sealed", owner)).to.match(
      /custody is sealed.*Deposit a little first.*Nothing was sent/,
    );
  });

  it("exits no more than the owner holds in the rollup", () => {
    expect(heldRefusal(500n, 500n)).to.equal(null);
    expect(heldRefusal(499n, 500n)).to.match(
      /holds 499 atoms in the rollup, fewer than the 500.*Nothing was sent/,
    );
  });

  it("fails the exit unless the Solana balance rose by what was sent back, and says where the tokens are", () => {
    expect(returnShortfall(1_000n, 1_500n, 500n)).to.equal(null);
    expect(returnShortfall(1_000n, 1_600n, 500n)).to.equal(null);
    expect(returnShortfall(1_000n, 1_499n, 500n)).to.match(
      /from 1000 to 1499 atoms, 1 short of the 500.*not lost.*FROM=rollup/,
    );
    expect(returnShortfall(1_000n, 900n, 500n)).to.match(
      /600 short of the 500/,
    );
  });

  it("fails a round trip that leaves the owner with less on Solana than it started with", () => {
    expect(roundTripLoss(1_000n, 1_000n)).to.equal(null);
    expect(roundTripLoss(1_000n, 1_010n)).to.equal(null);
    expect(roundTripLoss(1_000n, 990n)).to.match(
      /held 1000 atoms.*holds 990 after, 10 fewer.*Do not raise any cap/,
    );
  });

  it("has the owner pay on Solana when it holds SOL there, the test network's admin when it does not, and refuses on mainnet before sending anything", () => {
    const owner = Keypair.generate().publicKey;
    expect(solanaFeePayer(SOLANA_EXIT_LAMPORTS, false, owner)).to.equal(
      "owner",
    );
    expect(solanaFeePayer(SOLANA_EXIT_LAMPORTS, true, owner)).to.equal("owner");
    expect(solanaFeePayer(0, true, owner)).to.equal("admin");
    expect(solanaFeePayer(SOLANA_EXIT_LAMPORTS - 1, true, owner)).to.equal(
      "admin",
    );
    expect(() => solanaFeePayer(0, false, owner)).to.throw(
      /holds 0 lamports on Solana.*Send it that much SOL.*Nothing was sent/,
    );
  });

  it("carries a half-finished older exit on from where it stopped, and never withdraws a different amount", () => {
    const back = (amount: bigint) => ({ delegated: false, amount });
    expect(handBackStep(null, 500n, 500n)).to.equal("undelegate");
    expect(handBackStep({ delegated: true, amount: 0n }, 500n, 500n)).to.equal(
      "undelegate",
    );
    expect(handBackStep(back(500n), 0n, 500n)).to.equal("withdraw");
    expect(handBackStep(back(900n), 0n, 500n)).to.equal("withdraw");
    expect(() => handBackStep(back(499n), 0n, 500n)).to.throw(
      /back on Solana and holds 499 atoms, fewer than the 500/,
    );
    expect(() => handBackStep(back(0n), 0n, 500n)).to.throw(
      /may already have been withdrawn/,
    );
    expect(() => handBackStep(null, 499n, 500n)).to.throw(
      /holds 499 atoms in the rollup, fewer than the 500/,
    );
  });

  it("tells a stale mark, which the crank mends, from the program's other refusals", () => {
    expect(isStaleMark('{"InstructionError":[0,{"Custom":6038}]}')).to.equal(
      true,
    );
    expect(isStaleMark('{"InstructionError":[0,{"Custom":6079}]}')).to.equal(
      false,
    );
    expect(isStaleMark('"AccountNotFound"')).to.equal(false);
    expect(isStaleMark(null)).to.equal(false);
  });

  it("tells the program's two refusals of the dust deposit apart from any other", () => {
    const failed = (code: number) =>
      `{"InstructionError":[0,{"Custom":${code}}]}\nProgram log`;
    expect(
      roundTripDepositFailure(failed(CUSTODY_CAP_REACHED), owner).message,
    ).to.match(/cannot hold more of this token.*FROM=rollup/);
    expect(roundTripDepositFailure(failed(NO_SEAT), owner).message).to.match(
      /has no open seat.*The gate opens a seat/,
    );
    expect(roundTripDepositFailure(failed(6038), owner).message).to.equal(
      `The deposit was refused: ${failed(6038)}`,
    );
  });
});

describe("the Makefile's launch operator targets", () => {
  const makefile = readFileSync("Makefile", "utf8");
  const targets = [
    "propose-admin",
    "upgrade-authority",
    "update-market",
    "set-price-source",
    "seat",
    "exit",
    "round-trip",
    "markcheck",
    "keeper-deposit",
    "pause",
    "market-status",
  ];

  it("sends each through the mainnet rule that confirms the program, and through the rehearsal rule", () => {
    for (const name of targets) {
      const rule = (network: string) =>
        makefile
          .split("\n\n")
          .find((block) => block.includes(`: ${network}-%: sdk-build`)) ?? "";
      expect(rule("mainnet"), name).to.include(`mainnet-${name}`);
      expect(rule("rehearsal"), name).to.include(`rehearsal-${name}`);
      expect(makefile, name).to.include(
        `TOOL_${name} := $(RUN) ops/${name}.ts`,
      );
    }
    expect(makefile).to.include('[ "$(MAINNET_PROGRAM_ID)" = "$$id" ]');
  });
});

/**
 * The mainnet SOL/USD account of MagicBlock's oracle as the rollup served it,
 * `programs/noirwire-orderbook/src/magicblock_oracle.rs` reads the same bytes.
 */
const MAGICBLOCK_SOL = Uint8Array.from(
  Buffer.from(
    "eaa10e24acef0fe8" +
      "00".repeat(32) +
      "01" +
      "c6ad3e841d9c0f248adff90cf776f839fd59f1cbd8ffbc8f9402883ea16e8420" +
      "df9602dd01000000" +
      "0000000000000000" +
      "08000000" +
      "c84ef76a00000000" +
      "c84ef76a00000000" +
      "00".repeat(25),
    "hex",
  ),
);

describe("MagicBlock's price, without a network", () => {
  const address = magicblockPriceAccount(6);
  const data = () => Uint8Array.from(MAGICBLOCK_SOL);
  const checked = (account: Parameters<typeof checkedObservation>[1]) =>
    checkedObservation(address, account, address);

  it("derives MagicBlock's account for the feed number, and the profile names the same one", () => {
    expect(address.toBase58()).to.equal(
      "ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu",
    );
    expect(magicblockPriceAccount(7).toBase58()).to.equal(
      "Ekug3x6hs37Mf4XKCDptvRVCSCjJCAD7LKmKQXBAa541",
    );
    expect(MAINNET_PRICE_FEEDS.solUsd.account.equals(address)).to.equal(true);
  });

  it("reads the account's price and stamp, with the exponent stored as plus eight read at minus eight", () => {
    expect(MAGICBLOCK_SOL.length).to.equal(134);
    expect(observationIn(MAGICBLOCK_SOL)).to.deep.equal({
      price: 8_002_901_727n,
      expo: -8,
      publishTime: 1_794_592_456,
    });
    expect(
      new PublicKey(MAGICBLOCK_SOL.subarray(41, 73)).toBase58(),
      "its feed id is its own address",
    ).to.equal(address.toBase58());
    const partial = data();
    partial[40] = 0;
    expect(observationIn(partial), "partially verified").to.equal(null);
    expect(observationIn(data().subarray(0, 133)), "the wrong size").to.equal(
      null,
    );
  });

  describe("the operator's checked reading of a price account", () => {
    const ok = () => ({ owner: MAGICBLOCK_ORACLE_ID, data: data() });

    it("reads what the program reads", () => {
      const read = checked(ok());
      expect(read.price).to.equal(8_002_901_727n);
      expect(read.expo, "normalised to the binding's").to.equal(-8);
    });

    it("refuses a missing account, a wrong owner, size, discriminator, verification, feed, exponent and a price that is not positive", () => {
      expect(() => checked(null)).to.throw("missing");
      expect(() =>
        checked({ ...ok(), owner: Keypair.generate().publicKey }),
      ).to.throw("is owned by");
      expect(() =>
        checked({ ...ok(), data: data().subarray(0, 133) }),
      ).to.throw("133 bytes");
      const kind = data();
      kind[0] ^= 1;
      expect(() => checked({ ...ok(), data: kind })).to.throw(
        "not a MagicBlock",
      );
      const partial = data();
      partial[40] = 0;
      expect(() => checked({ ...ok(), data: partial })).to.throw(
        "fully verified",
      );
      const other = data();
      other[41] ^= 1;
      expect(() => checked({ ...ok(), data: other })).to.throw("another feed");
      const minusEight = data();
      new DataView(minusEight.buffer).setInt32(89, -8, true);
      expect(() => checked({ ...ok(), data: minusEight })).to.throw("exponent");
      for (const price of [0n, -5n]) {
        const priced = data();
        new DataView(priced.buffer).setBigInt64(73, price, true);
        expect(() => checked({ ...ok(), data: priced })).to.throw("price of");
      }
      expect(() =>
        checkedObservation(address, ok(), magicblockPriceAccount(7)),
      ).to.throw("not the bound account");
    });

    describe("and the first sync it predicts", () => {
      const obs = (publishTime: number) => ({
        price: 8_000_000_000n,
        expo: -8,
        publishTime,
      });
      it("names each failure", () => {
        const clock = 1_000;
        const limits = { maxPriceAge: 10 };
        expect(firstSyncFailure(obs(clock - 10), clock, limits)).to.equal(null);
        expect(firstSyncFailure(obs(clock - 11), clock, limits)).to.match(
          /11 s old, past max_price_age 10/,
        );
        expect(firstSyncFailure(obs(clock + 1), clock, limits)).to.match(
          /from the future/,
        );
        expect(
          firstSyncFailure(obs(clock - 1), clock, {
            ...limits,
            markPublishTime: clock - 1,
          }),
        ).to.match(/PriceTimeWentBackwards/);
        expect(
          firstSyncFailure(obs(clock - 1), clock, {
            ...limits,
            markPublishTime: clock - 2,
          }),
        ).to.equal(null);
      });
    });
  });

  it("builds sync_price with MagicBlock's account as the third, read-only account", () => {
    const instructions = new Instructions(Keypair.generate().publicKey);
    const sync = instructions.syncPrice(0, address);
    expect(sync.keys.map((key) => key.pubkey.toBase58())).to.deep.equal([
      instructions.addresses.market(0).toBase58(),
      instructions.addresses.priceFeed(0).toBase58(),
      address.toBase58(),
    ]);
    expect(sync.keys.map((key) => key.isWritable)).to.deep.equal([
      true,
      true,
      false,
    ]);
  });

  it("builds set_price_source and set_quote_source with a feed number", () => {
    const instructions = new Instructions(Keypair.generate().publicKey);
    const admin = Keypair.generate().publicKey;
    const set = instructions.setPriceSource(admin, 0, 6);
    expect(Array.from(set.data.subarray(8))).to.deep.equal([0, 6, 0, 0, 0]);
    expect(set.keys.map((key) => [key.isSigner, key.isWritable])).to.deep.equal(
      [
        [true, false],
        [false, false],
        [false, true],
        [false, true],
        [false, true],
      ],
    );
    const quote = instructions.setQuoteSource(admin, {
      feed: 7,
      depegBps: 100,
      maxAge: 180n,
    });
    expect(Array.from(quote.data.subarray(8))).to.deep.equal([
      7, 0, 0, 0, 100, 0, 180, 0, 0, 0, 0, 0, 0, 0,
    ]);
  });

  it("asks only for APPLY=yes, and rebinds only a paused market", () => {
    expect(rebindRequest({})).to.deep.equal({ apply: false });
    expect(rebindRequest({ APPLY: "" })).to.deep.equal({ apply: false });
    expect(rebindRequest({ APPLY: "yes" })).to.deep.equal({ apply: true });
    expect(() => rebindRequest({ APPLY: "true" })).to.throw("APPLY is");
    expect(rebindRefusal(MARKET_STATUS.paused)).to.equal(null);
    expect(rebindRefusal(MARKET_STATUS.active)).to.match(/not paused/);
    expect(rebindRefusal(MARKET_STATUS.reduceOnly)).to.match(/not paused/);
  });
});

describe("the trigger-books command", () => {
  const refusal = (code: number) =>
    JSON.stringify({ InstructionError: [0, { Custom: code }] });

  const world = (initial: Record<number, TriggerBookState>) => {
    const states = { ...initial };
    const said: string[] = [];
    const sent: number[] = [];
    const run = (apply: boolean, stuck: number[] = []) =>
      runTriggerBooks({
        marketIds: Object.keys(states).map(Number),
        apply,
        say: (label, value) => said.push(`${label}: ${value}`),
        stateOf: async (id) => states[id],
        setUp: async (id) => {
          sent.push(id);
          if (!stuck.includes(id)) states[id] = "ready";
        },
      });
    return { said, sent, run };
  };

  it("asks only for APPLY=yes", () => {
    expect(triggerBookRequest({})).to.deep.equal({ apply: false });
    expect(triggerBookRequest({ APPLY: "" })).to.deep.equal({ apply: false });
    expect(triggerBookRequest({ APPLY: "yes" })).to.deep.equal({ apply: true });
    expect(() => triggerBookRequest({ APPLY: "true" })).to.throw("APPLY is");
  });

  it("reads a book's state from the program's refusal of finalize_trigger_book", () => {
    expect(triggerBookStateOf(null, 1)).to.equal("grown");
    expect(triggerBookStateOf(refusal(6120), 1)).to.equal("ready");
    expect(triggerBookStateOf(refusal(6118), 1)).to.equal("partial");
    expect(triggerBookStateOf(refusal(6114), 1)).to.equal("missing");
    expect(() => triggerBookStateOf(refusal(6115), 3)).to.throw(
      "Market 3's trigger book address holds an account owned by another program",
    );
    expect(() => triggerBookStateOf(refusal(6115), 3)).to.throw(
      "Nothing was sent",
    );
    expect(() => triggerBookStateOf(refusal(6001), 1)).to.throw(
      "does not know how to read",
    );
    expect(() => triggerBookStateOf('"AccountNotFound"', 1)).to.throw(
      "Nothing was sent",
    );
  });

  it("sends nothing in a dry run and lists each market's state", async () => {
    const { said, sent, run } = world({
      0: "missing",
      1: "partial",
      2: "grown",
      3: "ready",
    });
    expect(await run(false)).to.deep.equal([]);
    expect(sent).to.deep.equal([]);
    expect(said.join("\n")).to.match(/market 0 trigger book: missing/);
    expect(said.join("\n")).to.match(/market 1 trigger book: partly grown/);
    expect(said.join("\n")).to.match(/market 2 trigger book: full size/);
    expect(said.join("\n")).to.match(/market 3 trigger book: ready/);
    expect(said.join("\n")).to.match(/Dry run: nothing was sent/);
  });

  it("sends only for the markets that are not ready, and sends nothing the second time", async () => {
    const { sent, run } = world({ 0: "missing", 1: "ready", 2: "partial" });
    expect(await run(true)).to.deep.equal([0, 2]);
    expect(sent).to.deep.equal([0, 2]);
    expect(await run(true)).to.deep.equal([]);
    expect(sent).to.deep.equal([0, 2]);
  });

  it("fails when a book is still not ready after it was set up", async () => {
    const { run } = world({ 0: "missing", 1: "partial" });
    let failure: Error | null = null;
    await run(true, [1]).catch((error: Error) => {
      failure = error;
    });
    expect(String(failure)).to.match(
      /still not ready after it was set up: market 1 is partial/,
    );
    expect(String(failure)).to.not.match(/market 0/);
  });
});

describe("the operator image", () => {
  const dockerfile = readFileSync("Dockerfile", "utf8");
  const rules = readFileSync(".dockerignore", "utf8")
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith("#"));
  const allowed = rules.filter((rule) => rule.startsWith("!"));
  const never = /keys|\.env|target|keypair|id\.json|\.key$/;

  it("builds from an allow list that names no key, environment file, build or keypair, and refuses them again", () => {
    expect(rules[0]).to.equal("*");
    expect(allowed.length).to.be.greaterThan(0);
    for (const rule of allowed) expect(rule, rule).not.to.match(never);
    for (const rule of [
      "**/.keys",
      "**/.env",
      "**/.env.*",
      "**/target",
      "**/*keypair*.json",
      "**/id.json",
    ]) {
      expect(rules, rule).to.include(rule);
    }
  });

  it("copies nothing a key or a build could be in", () => {
    const copies = dockerfile
      .split("\n")
      .filter((line) => line.startsWith("COPY"));
    expect(copies.length).to.be.greaterThan(0);
    for (const copy of copies) expect(copy, copy).not.to.match(never);
  });

  it("runs on the Node major CI uses and on mainnet's genesis, as the Makefile names it", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    const makefile = readFileSync("Makefile", "utf8");
    const named = (text: string, pattern: RegExp) => pattern.exec(text)?.[1];
    expect(named(dockerfile, /^ARG NODE_VERSION=(\d+)$/m)).to.equal(
      named(ci, /NODE_VERSION: "(\d+)"/),
    );
    const onMainnet = (setting: string) =>
      named(
        makefile,
        new RegExp(`^ON_MAINNET[\\s\\S]*?${setting}=(\\w+)`, "m"),
      );
    expect(dockerfile, "the base image is named by digest").to.match(
      /^FROM node:\$\{NODE_VERSION\}-bookworm-slim@\$\{NODE_DIGEST\}$/m,
    );
    expect(dockerfile).to.match(/^ARG NODE_DIGEST=sha256:[0-9a-f]{64}$/m);
    expect(makefile).to.include("image-digest:");
    for (const setting of ["GENESIS", "EXCHANGE_FLOAT_LAMPORTS"]) {
      expect(named(dockerfile, new RegExp(`${setting}=(\\w+)`)), setting)
        .to.be.a("string")
        .and.equal(onMainnet(setting));
    }
  });
});

describe("what the mainnet build check refuses", () => {
  const ID = Keypair.generate().publicKey.toBase58();
  const discriminator = (name: string) =>
    createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
  const built = (names: string[], address = ID) => ({
    idl: { address, instructions: names.map((name) => ({ name })) },
    binary: Buffer.concat([Buffer.from("elf"), ...names.map(discriminator)]),
  });
  const faults = (names: string[], address?: string) => {
    const { idl, binary } = built(names, address);
    return mainnetBuildFaults(idl, binary, ID);
  };

  it("passes a build with both syncs and no price writer, declaring its id", () => {
    expect(faults(["sync_price", "sync_quote", "place_order"])).to.deep.equal(
      [],
    );
  });

  it("refuses a price writer in the interface file or the binary alone", () => {
    expect(faults(["sync_price", "sync_quote", "publish_price"])).to.deep.equal(
      ["has publish_price"],
    );
    const { idl } = built(["sync_price", "sync_quote"]);
    const binary = Buffer.concat([
      built(["sync_price", "sync_quote"]).binary,
      discriminator("reset_price"),
    ]);
    expect(mainnetBuildFaults(idl, binary, ID)).to.deep.equal([
      "has reset_price",
    ]);
  });

  it("refuses a build missing a sync or declaring another id", () => {
    expect(faults(["sync_price"])).to.deep.equal(["lacks sync_quote"]);
    const other = Keypair.generate().publicKey.toBase58();
    expect(faults(["sync_price", "sync_quote"], other)).to.deep.equal([
      `declares ${other}`,
    ]);
  });
});

describe("what a mainnet launch refuses to guess, without a network", () => {
  const funded = (500n * USDC).toString();

  it("never defaults the insurance on mainnet, and still does elsewhere", () => {
    expect(() => launchInsurance(undefined, undefined, true)).to.throw(
      /never defaulted.*give INSURANCE_USDC=<whole USDC>.*Nothing was sent/,
    );
    expect(() => launchInsurance("", undefined, true)).to.throw(
      /never defaulted/,
    );
    expect(launchInsurance("500", undefined, true)).to.equal(500n * USDC);
    expect(launchInsurance(undefined, funded, true)).to.equal(500n * USDC);
    expect(launchInsurance(undefined, undefined, false)).to.equal(
      DEFAULT_INSURANCE,
    );
  });

  it("falls back from the description to the send's record, and to nothing", () => {
    const folder = mkdtempSync(join(tmpdir(), "sent-"));
    const program = Keypair.generate().publicKey;
    const path = sentBookPath(folder, "mainnet", program);
    const described = (insuranceFunded?: string, programId = program) =>
      ({ programId: programId.toBase58(), insuranceFunded }) as Pick<
        DeploymentDescription,
        "programId" | "insuranceFunded"
      >;
    expect(insuranceRecorded(null, program, path)).to.equal(undefined);
    writeFileSync(
      path,
      JSON.stringify({
        insurance: { state: "pending", at: "t", id: "ab", total: funded },
      }),
    );
    expect(
      insuranceRecorded(null, program, path),
      "a lost description",
    ).to.equal(funded);
    expect(
      insuranceRecorded(described(undefined), program, path),
      "a description that records none",
    ).to.equal(funded);
    expect(insuranceRecorded(described("700000000"), program, path)).to.equal(
      "700000000",
    );
    expect(
      insuranceRecorded(
        described("700000000", Keypair.generate().publicKey),
        program,
        path,
      ),
      "another program's description",
    ).to.equal(funded);
    writeFileSync(
      path,
      JSON.stringify({ insurance: { state: "landed", at: "t" } }),
    );
    expect(
      insuranceRecorded(null, program, path),
      "a record with no total",
    ).to.equal(undefined);
    rmSync(folder, { recursive: true });
  });

  it("asks for INSURANCE_FIRST_SEND once where custody cannot be read and nothing records a send", () => {
    expect(insuranceFirstSendRefusal("unreadable", false, undefined)).to.match(
      /does not serve the custody token account.*INSURANCE_FIRST_SEND=yes.*Nothing was sent/,
    );
    expect(insuranceFirstSendRefusal("unreadable", false, "yes")).to.equal(
      null,
    );
    expect(
      insuranceFirstSendRefusal("unreadable", true, undefined),
      "an operator who answered for a pending record has looked",
    ).to.equal(null);
    expect(insuranceFirstSendRefusal(0n, false, undefined)).to.equal(null);
    expect(insuranceFirstSendRefusal(null, false, undefined)).to.equal(null);
    expect(
      insuranceHeldRefusal("unreadable", 5n, undefined, "INSURANCE_SENT"),
      "unreadable is not a balance to compare",
    ).to.equal(null);
  });

  it("reads custody in words that never call an unserved account empty", () => {
    expect(custodyText(0n)).to.equal("0 atoms held");
    expect(custodyText("unreadable")).to.equal("not readable here");
    expect(custodyText(null)).to.match(/sealed/);
  });

  it("throws a refusal of its own when the cover cannot be sized, so a run that opens nothing can go on", () => {
    expect(() =>
      insuranceSizing(3_000_000_000n, "unreadable", 0n, null),
    ).to.throw(UnreadableInsurance);
    expect(() => insuranceSizing(3_000_000_000n, 5n, 0n, null)).to.not.throw();
  });

  it("refuses a withdrawal only where custody was read to hold less", () => {
    expect(withdrawRefusal(501n, "unreadable")).to.equal(null);
    expect(withdrawRefusal(501n, 500n)).to.match(/holds 500 atoms/);
  });

  it("refuses to raise a cap when what insurance holds is unknown, and lowers it all the same", () => {
    const { settings } = launchMarket(500n * USDC);
    const launch = {
      openInterestCap: settings.limits.openInterestCap as bigint,
      positionCap: settings.limits.positionCap,
      maxPriceAge: settings.limits.maxPriceAge,
    };
    const lowered = {
      ...settings.limits,
      openInterestCap: 10_000n,
      positionCap: 2_000n,
      kind: settings.kind,
      status: MARKET_STATUS.reduceOnly,
    } as MarketParams;
    const ask = (openInterestCap: bigint, found = lowered) =>
      limitsChange(found, launch, null, {
        openInterestCap,
        positionCap: null,
        maxPriceAge: null,
      });
    expect(() => ask(15_000n)).to.throw(
      /Raising a cap needs what insurance holds.*INSURANCE_HELD=<whole USDC>.*Lowering a cap needs no figure.*Nothing was sent/,
    );
    expect(
      ask(5_000n, { ...lowered, positionCap: 1_000n } as MarketParams),
    ).to.have.property("openInterestCap", 5_000n);
  });

  it("refuses a resume on a mark older than the market accepts, even one that matches the reference", () => {
    const check: ResumeCheck = {
      mark: 100_000n,
      reference: 100_000n,
      confirmed: true,
      covered: 111_111n,
      openInterestCap: 111_111n,
      adminUpgrades: false,
      keeperWhy: null,
      markAge: 10n,
      maxPriceAge: 90n,
      guardPasses: true,
      marketHealthy: true,
      shortfall: 0n,
    };
    expect(resumeVerdict(check)).to.deep.equal({ resume: true });
    expect(
      resumeVerdict({ ...check, markAge: 90n }),
      "at the limit",
    ).to.deep.equal({
      resume: true,
    });
    const stale = resumeVerdict({ ...check, markAge: 91n });
    expect(stale.resume === false && stale.why).to.match(
      /mark is 91 s old, older than the market's max price age of 90 s/,
    );
    expect(markcheckSays({ check: { ...check, markAge: 120n } })).to.match(
      /NOT safe.*120 s old/,
    );
  });

  it("refuses a resume while the USDC guard fails, the market is not healthy or a shortfall is recorded", () => {
    const check: ResumeCheck = {
      mark: 100_000n,
      reference: 100_000n,
      confirmed: true,
      covered: 111_111n,
      openInterestCap: 111_111n,
      adminUpgrades: false,
      keeperWhy: null,
      markAge: 1n,
      maxPriceAge: 90n,
      guardPasses: true,
      marketHealthy: true,
      shortfall: 0n,
    };
    const why = (change: Partial<ResumeCheck>) => {
      const verdict = resumeVerdict({ ...check, ...change });
      return verdict.resume === false ? verdict.why : "";
    };
    expect(why({ guardPasses: false })).to.match(/USDC guard is not passing/);
    expect(why({ marketHealthy: false })).to.match(
      /price health is not healthy/,
    );
    expect(why({ shortfall: 7n })).to.match(/shortfall of 7 quote atoms/);
    expect(markcheckSays({ check: { ...check, guardPasses: false } })).to.match(
      /NOT safe.*USDC guard/,
    );
  });

  it("sizes the keeper's floor from one takeover at the position cap at the live mark and the initial margin", () => {
    expect(keeperCollateralFloor(3_703n, 150_000n, 2_000)).to.equal(
      111_090_000n,
    );
    expect(keeperCollateralFloor(3_703n, 300_000n, 2_000)).to.equal(
      222_180_000n,
    );
    expect(keeperCollateralFloor(1n, 1n, 1)).to.equal(1n, "rounded up");
    const at = (collateral: bigint | null, mark: bigint) =>
      keeperFloorRefusal({
        collateral,
        positionCap: 3_703n,
        mark,
        imBps: 2_000,
      });
    expect(at(200_000_000n, 150_000n)).to.equal(null);
    expect(
      at(null, 300_000n),
      "an unread seat is the keeper checks' to report",
    ).to.equal(null);
    expect(at(200_000_000n, 300_000n)).to.match(
      /holds 200000000 atoms.*under the 222180000 atoms.*3703 lots at a mark of 300000/,
    );
    const refused = resumeVerdict({
      mark: 300_000n,
      reference: 300_000n,
      confirmed: true,
      covered: 1_000_000n,
      openInterestCap: 1n,
      adminUpgrades: false,
      keeperWhy: at(200_000_000n, 300_000n),
    });
    expect(refused.resume).to.equal(false);
  });

  it("refuses an upgrade authority on the curve unless it is said to be a key, and prints the address to compare", () => {
    const admin = Keypair.generate().publicKey;
    const upgrader = Keypair.generate().publicKey;
    const key = Keypair.generate().publicKey;
    const [vault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault")],
      Keypair.generate().publicKey,
    );
    expect(upgradeAuthorityRefusal(vault, upgrader, admin)).to.equal(null);
    expect(upgradeAuthorityRefusal(key, upgrader, admin)).to.match(
      /ordinary key.*vault never is.*MULTISIG_IS_A_KEY=yes.*Nothing was sent/,
    );
    expect(upgradeAuthorityRefusal(key, upgrader, admin, true)).to.equal(null);
    expect(upgradeAuthorityRefusal(admin, upgrader, admin, true)).to.match(
      /is the exchange's admin/,
    );
    expect(upgradeAuthorityCheckLine(vault)).to.include(
      `  ${vault.toBase58()}\n`,
    );
    expect(upgradeAuthorityCheckLine(vault)).to.include("second channel");
  });

  it("asks the round trip's owner for about 0.03 SOL, three times the exit's", () => {
    const owner = Keypair.generate().publicKey;
    expect(ROUND_TRIP_LAMPORTS).to.equal(30_000_000);
    expect(
      solanaFeePayer(ROUND_TRIP_LAMPORTS, false, owner, ROUND_TRIP_LAMPORTS),
    ).to.equal("owner");
    expect(() =>
      solanaFeePayer(SOLANA_EXIT_LAMPORTS, false, owner, ROUND_TRIP_LAMPORTS),
    ).to.throw(/holds 10000000 lamports.*about 30000000.*Nothing was sent/);
    expect(solanaFeePayer(SOLANA_EXIT_LAMPORTS, false, owner)).to.equal(
      "owner",
    );
  });
});

describe("the exit's record of what it sent, without a network", () => {
  const owner = Keypair.generate();
  const asked = {
    id: "op1",
    owner: owner.publicKey.toBase58(),
    atoms: 500n,
    method: "shuttle",
  };
  const sent = (change: Partial<ExitOperation> = {}): ExitOperation => ({
    id: "earlier",
    owner: asked.owner,
    atoms: "500",
    method: "shuttle",
    solana: [],
    ...change,
  });
  const pending = {
    state: "pending" as const,
    at: "t",
    id: "ab12",
    before: "1000",
  };
  const aSolanaSend = (change: Partial<SolanaSend> = {}): SolanaSend => ({
    signature: "sig",
    lastValidBlockHeight: 1_000,
    step: "shuttle",
    at: "t",
    before: "0",
    moved: "500",
    ...change,
  });

  it("writes base58 as Solana does, for any length", () => {
    for (let nth = 0; nth < 20; nth += 1) {
      const key = Keypair.generate().publicKey;
      expect(base58Of(key.toBytes())).to.equal(key.toBase58());
    }
    expect(base58Of(Uint8Array.from([0, 0, 1]))).to.equal("112");
    expect(base58Of(new Uint8Array(0))).to.equal("");
  });

  it("derives a Solana send's signature and writes it down before the broadcast whose answer is lost", async () => {
    const payer = Keypair.generate();
    const recorded: { signature: string; lastValid: number }[] = [];
    let raw: Buffer | null = null;
    const blockhash = Keypair.generate().publicKey.toBase58();
    const connection = {
      getLatestBlockhash: async () => ({
        blockhash,
        lastValidBlockHeight: 1_234,
      }),
      simulateTransaction: async () => ({ value: { err: null, logs: [] } }),
      sendRawTransaction: async (bytes: Buffer) => {
        expect(recorded, "written before it is broadcast").to.have.length(1);
        raw = bytes;
        throw new Error("fetch failed");
      },
    } as never;
    let thrown: Error | undefined;
    try {
      await sendOnSolana(
        connection,
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: Keypair.generate().publicKey,
          lamports: 1,
        }),
        payer,
        [],
        (signature, lastValid) => recorded.push({ signature, lastValid }),
      );
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).to.equal("fetch failed");
    expect(
      thrown,
      "a lost answer is not Solana's verdict",
    ).not.to.be.instanceOf(SettledOnSolana);
    const signed = Transaction.from(raw as unknown as Buffer).signature;
    expect(recorded[0].signature).to.equal(base58Of(signed as Buffer));
    expect(recorded[0].lastValid).to.equal(1_234);
  });

  it("marks a Solana send that failed there or expired unlanded as settled, and nothing else", async () => {
    const payer = Keypair.generate();
    const sentTo = (status: unknown, height: number) =>
      ({
        getLatestBlockhash: async () => ({
          blockhash: Keypair.generate().publicKey.toBase58(),
          lastValidBlockHeight: 1_000,
        }),
        simulateTransaction: async () => ({ value: { err: null, logs: [] } }),
        sendRawTransaction: async () => "sig",
        getSignatureStatus: async () => ({ value: status }),
        getBlockHeight: async () => height,
        getTransaction: async () => null,
      }) as never;
    const outcome = (status: unknown, height = 500) =>
      sendOnSolana(
        sentTo(status, height),
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: Keypair.generate().publicKey,
          lamports: 1,
        }),
        payer,
      ).then(
        () => null,
        (error: Error) => error,
      );
    expect(await outcome(null, 1_001)).to.be.instanceOf(SettledOnSolana);
    expect(
      await outcome({
        err: { InstructionError: [0, "x"] },
        confirmationStatus: "confirmed",
      }),
    ).to.be.instanceOf(SettledOnSolana);
    expect(
      await outcome({ err: null, confirmationStatus: "confirmed" }),
    ).to.equal(null);
  });

  it("judges a recorded Solana send by its status, and by its blockhash while it has none", async () => {
    const at = (
      value: { err: unknown; confirmationStatus: string } | null,
      height = 500,
    ) =>
      ({
        getSignatureStatus: async () => ({ value }),
        getBlockHeight: async () => height,
      }) as never;
    const send = aSolanaSend();
    expect(
      await solanaVerdict(
        at({ err: null, confirmationStatus: "confirmed" }),
        send,
      ),
      "the answer was lost and it landed",
    ).to.equal("landed");
    expect(
      await solanaVerdict(
        at({
          err: { InstructionError: [0, "x"] },
          confirmationStatus: "finalized",
        }),
        send,
      ),
    ).to.equal("failed");
    const processed = (height = 500) =>
      at({ err: null, confirmationStatus: "processed" }, height);
    const seen = aSolanaSend();
    expect(await solanaVerdict(processed(), seen)).to.equal("wait");
    expect(seen.everProcessed, "the observation is marked").to.equal(true);

    const expired = aSolanaSend();
    expect(
      await solanaVerdict(processed(1_001), expired),
      "seen only as processed: a slow fork may still confirm it, so it is never dropped alone",
    ).to.equal("wait");
    expect(
      await solanaVerdict(at(null, 1_001), expired),
      "a lagging node now answers nothing and the blockhash is dead",
    ).to.equal("wait");
    for (const answer of [
      "lost:other",
      `lost:${expired.signature}`,
      undefined,
    ]) {
      expect(
        await solanaVerdict(at(null, 1_001), expired, answer),
        `${answer}: no answer releases a send that was seen processed`,
      ).to.equal("wait");
    }
    expect(
      await solanaVerdict(
        at(null, 1_001),
        expired,
        `landed:${expired.signature}`,
      ),
    ).to.equal("landed");
    expect(
      await solanaVerdict(
        at({ err: null, confirmationStatus: "confirmed" }, 1_001),
        expired,
      ),
      "it confirmed after all",
    ).to.equal("landed");
    expect(
      solanaPendingRefusal(expired, 1_001),
      "an expired processed send asks for the landed answer only",
    ).to.include(`EXIT_SENT=landed:${expired.signature}`);
    expect(solanaPendingRefusal(expired, 1_001)).to.not.include(
      "EXIT_SENT=lost",
    );

    expect(
      await solanaVerdict(at(null, 999), aSolanaSend()),
      "it may still land",
    ).to.equal("wait");
    expect(
      await solanaVerdict(at(null, 1_001), aSolanaSend()),
      "never seen processed, and it never will land",
    ).to.equal("safe");
    expect(
      await solanaVerdict(at(null, 1_001), aSolanaSend(), "lost:sig"),
    ).to.equal("safe");
  });

  it("keeps waiting on a send seen as processed when a later status carries an error that is not final, and releases it once the error is finalized", async () => {
    const failing = (confirmationStatus: string) =>
      ({
        getSignatureStatus: async () => ({
          value: { err: { InstructionError: [0, "x"] }, confirmationStatus },
        }),
        getBlockHeight: async () => 1_001,
      }) as never;
    for (const status of ["processed", "confirmed"]) {
      const seen = aSolanaSend({ everProcessed: true });
      expect(
        await solanaVerdict(failing(status), seen),
        `${status}: an error that is not final may be rolled back`,
      ).to.equal("wait");
      expect(
        await solanaVerdict(failing(status), seen, `landed:${seen.signature}`),
        "the operator's landed answer still counts",
      ).to.equal("landed");
      expect(seen.everProcessed, "the observation is kept").to.equal(true);
    }
    expect(
      await solanaVerdict(
        failing("finalized"),
        aSolanaSend({ everProcessed: true }),
      ),
      "finalized with an error: it moved nothing",
    ).to.equal("failed");
    expect(
      await solanaVerdict(failing("confirmed"), aSolanaSend()),
      "never seen processed: an error that is not final still waits, even past its blockhash",
    ).to.equal("wait");
    expect(
      await solanaVerdict(failing("finalized"), aSolanaSend()),
      "never seen processed, finalized with an error",
    ).to.equal("failed");
  });

  it("syncs the exit record and its folder to disk when it writes it", () => {
    const folder = mkdtempSync(join(tmpdir(), "exit-"));
    const path = join(folder, "exit.json");
    const fs = require("fs") as { fsyncSync: (fd: number) => void };
    const real = fs.fsyncSync;
    const synced: boolean[] = [];
    fs.fsyncSync = (fd: number) => {
      synced.push(existsSync(path));
      real(fd);
    };
    const operation: ExitOperation = {
      id: "ab12",
      owner: "owner",
      atoms: "1",
      method: "m",
      solana: [aSolanaSend({ everProcessed: true })],
    };
    try {
      writeExit(path, operation);
    } finally {
      fs.fsyncSync = real;
    }
    expect(synced, "the file before the rename, the folder after it").to.eql([
      false,
      true,
    ]);
    expect(readExit(path)).to.eql(operation);
    expect(existsSync(`${path}.partial`)).to.equal(false);
  });

  it("carries on from a Solana send that landed without sending another, waits for one that may, and drops one that cannot", async () => {
    const folder = mkdtempSync(join(tmpdir(), "exit-"));
    const book = (operation: ExitOperation) => ({
      path: join(folder, "exit.json"),
      op: operation,
    });
    const on = (
      value: { err: unknown; confirmationStatus: string } | null,
      height = 500,
    ) =>
      ({
        on: {
          solana: {
            getSignatureStatus: async () => ({ value }),
            getBlockHeight: async () => height,
          },
        },
      }) as never;
    const landedBook = book(sent({ solana: [aSolanaSend()] }));
    expect(
      await reconciledSolana(
        on({ err: null, confirmationStatus: "finalized" }),
        landedBook,
      ),
    ).to.deep.include({ signature: "sig", moved: "500" });
    expect(landedBook.op.solana, "kept for the arrival check").to.have.length(
      1,
    );

    let thrown = "";
    try {
      await reconciledSolana(
        on(null, 900),
        book(sent({ solana: [aSolanaSend()] })),
      );
    } catch (error) {
      thrown = (error as Error).message;
    }
    expect(thrown).to.match(
      /transaction sig was broadcast at t.*can still land until block height 1000.*Nothing was sent/,
    );

    const expired = book(sent({ solana: [aSolanaSend()] }));
    expect(await reconciledSolana(on(null, 2_000), expired)).to.equal(null);
    expect(
      expired.op.solana,
      "a send that can never land is forgotten",
    ).to.deep.equal([]);

    const processedOnly = book(sent({ solana: [aSolanaSend()] }));
    let asked = "";
    try {
      await reconciledSolana(
        on({ err: null, confirmationStatus: "processed" }, 2_000),
        processedOnly,
      );
    } catch (error) {
      asked = (error as Error).message;
    }
    expect(asked).to.match(/seen as processed.*EXIT_SENT=landed:sig/);
    expect(processedOnly.op.solana, "kept, not dropped").to.have.length(1);

    const later = book(readExit(processedOnly.path)!);
    expect(later.op.solana[0].everProcessed, "saved with the record").to.equal(
      true,
    );
    let afterRestart = "";
    try {
      await reconciledSolana(on(null, 2_000), later);
    } catch (error) {
      afterRestart = (error as Error).message;
    }
    expect(
      afterRestart,
      "a later run whose node knows nothing of it still waits",
    ).to.match(/seen as processed/);
    expect(later.op.solana).to.have.length(1);
    expect(
      await reconciledSolana(
        on({ err: null, confirmationStatus: "confirmed" }, 2_000),
        later,
      ),
    ).to.deep.include({ signature: "sig" });
    rmSync(folder, { recursive: true });
  });

  it("never withdraws from the seat again for an exit whose first withdrawal may have landed", () => {
    expect(seatVerdict(undefined, 500n, 1_000n, undefined)).to.equal("send");
    expect(
      seatVerdict({ ...pending, state: "landed" }, 500n, 0n, undefined),
    ).to.equal("landed");
    expect(
      seatVerdict(pending, 500n, 1_500n, undefined),
      "the response was lost and the rollup shows the amount",
    ).to.equal("landed");
    expect(
      seatVerdict(pending, 500n, 1_499n, undefined),
      "nothing shows it landed: the operator answers",
    ).to.equal("ask");
    expect(seatVerdict(pending, 500n, 1_000n, "lost:other")).to.equal("ask");
    expect(seatVerdict(pending, 500n, 1_000n, "lost:ab12")).to.equal("send");
    expect(seatVerdict(pending, 500n, 1_000n, "landed:ab12")).to.equal(
      "landed",
    );
    const refusal = seatPendingRefusal(pending, 1_000n);
    expect(refusal).to.include("EXIT_SENT=landed:ab12");
    expect(refusal).to.include("EXIT_SENT=lost:ab12");
    expect(refusal).to.include("Nothing was sent.");
  });

  it("carries on an unfinished exit only with the same amount and method, and starts a fresh one when nothing was sent", () => {
    const unfinished = sent({ solana: [aSolanaSend()] });
    expect(exitOperation(unfinished, asked)).to.equal(unfinished);
    expect(() => exitOperation(unfinished, { ...asked, atoms: 900n })).to.throw(
      /earlier exit.*asked for 500 atoms by shuttle.*may have landed.*Nothing was sent/,
    );
    expect(() =>
      exitOperation(sent({ seat: pending }), {
        ...asked,
        method: "undelegate",
      }),
    ).to.throw(/may have landed/);
    expect(exitOperation(sent(), { ...asked, atoms: 900n }).id).to.equal("op1");
    expect(exitOperation(null, asked).solana).to.deep.equal([]);
  });

  it("tells a seat withdrawal that may have landed from one refused, and says what a re-run does", () => {
    const message = seatWithdrawalUnconfirmed(
      "Timed out waiting for it",
      1_500n,
    );
    expect(message).to.include("may have landed");
    expect(message).to.include("never withdraws from the seat a second time");
    expect(message).to.include("1500 atoms");
    expect(message).to.include("EXIT_SENT=landed:<id>");
  });
});

describe("the keeper's alerts that stand, without a network", () => {
  const params = {
    tick: 100n,
    bandBps: 400,
    minSize: 10n,
    minNotional: 1_000_000n,
  };

  it("alerts on every sweep for a position under the minimum order size, and holds the healthy ping back each time", () => {
    const held = 3n;
    expect(unwindOrder(held, 150_000n, params).kind).to.equal("dust");
    const afterTakeover = dustAlert(0, held, true);
    expect(afterTakeover).to.match(
      /^market 0: ALERT, the keeper holds 3 lots long after a takeover/,
    );
    expect(afterTakeover).to.include("no order closes it");
    for (const sweep of [1, 2, 3]) {
      const line = dustAlert(0, -held, false);
      expect(line, `sweep ${sweep}`).to.match(/ALERT.*3 lots short/);
      expect(line).to.not.include("after a takeover");
      expect(sweepHealthy(false, 0, true), `sweep ${sweep}`).to.equal(false);
    }
    expect(sweepHealthy(false, 0, false)).to.equal(true);
    expect(sweepHealthy(true, 0, false)).to.equal(false);
    expect(sweepHealthy(false, 1, false)).to.equal(false);
    const keeper = readFileSync("ops/keeper.ts", "utf8");
    expect(keeper).to.match(
      /dustAlert\(market\.id, held, afterTakeover\)\}`\);\s*return true;/,
    );
  });

  describe("an order key checkpoint that cannot be written", () => {
    const seed = Uint8Array.from({ length: 32 }, (_, nth) => nth + 1);
    const far = 250_000;
    const indices = [far, far + 1, far + 2, far + 3];

    it("is reported as a failed save, with how far the keys are from the search bound", () => {
      const folder = mkdtempSync(join(tmpdir(), "checkpoint-"));
      const blocker = join(folder, "file");
      writeFileSync(blocker, "a file where a folder is needed");
      const keys = OrderKeyManager.fresh(seed);
      const said: string[] = [];
      const originalLog = console.log;
      console.log = (line: string) => said.push(String(line));
      let saved: boolean;
      try {
        saved = keepOrderKeys(join(blocker, "keeper-order-keys.json"), keys);
      } finally {
        console.log = originalLog;
      }
      expect(saved).to.equal(false);
      expect(said.join("\n")).to.match(
        /^ALERT: could not save the order key checkpoint/,
      );
      expect(said.join("\n")).to.include(
        `${ORDER_KEY_SEARCH_BOUND - keys.checkpoint.nextIndex} short of the ${ORDER_KEY_SEARCH_BOUND}`,
      );
      expect(keepOrderKeys(join(folder, "kept.json"), keys)).to.equal(true);
      expect(checkpointAlert("p", far, "why")).to.include("0 short of the");
      const keeper = readFileSync("ops/keeper.ts", "utf8");
      expect(keeper).to.match(
        /finally \{\s*keptKeys\(on, client\);\s*client\.close\(\);\s*\}\s*if \(checkpointFailed\) outcome\.failed = true;/,
      );
      expect(keeper).to.not.match(/^\s*keepOrderKeys\(keeperKeysPath/m);
      rmSync(folder, { recursive: true });
    });

    it("keeps no seat bound: the keeper reads its sweep bound from the exchange", () => {
      const keeper = readFileSync("ops/keeper.ts", "utf8");
      expect(keeper).to.not.match(/KEEPER_SEATS|SeatBound|keeper-seats/);
      expect(readFileSync("ops/keeper-reads.ts", "utf8")).to.include(
        "liveSeatCapacity",
      );
      expect(keeper).to.include("liquidateRange");
    });

    it("leaves a high index recoverable across a restart after a real batch whose save failed", () => {
      const folder = mkdtempSync(join(tmpdir(), "checkpoint-"));
      const path = join(folder, "keeper-order-keys.json");
      saveOrderKeyCheckpoint(path, { indices, nextIndex: far + 4 });
      const view = {
        orderKeys: indices.map(
          (index) => deriveOrderKey(seed, index).publicKey,
        ),
      };
      const manager = orderKeysFor(seed, view, path);
      for (let nth = 0; nth < 4; nth += 1) manager.confirm(manager.take());
      const blocker = join(folder, "file");
      writeFileSync(blocker, "x");
      const originalLog = console.log;
      console.log = () => {};
      let saved: boolean;
      try {
        saved = keepOrderKeys(join(blocker, "keeper-order-keys.json"), manager);
      } finally {
        console.log = originalLog;
      }
      expect(saved, "the sweep that ran the batch fails").to.equal(false);
      const restarted = orderKeysFor(
        seed,
        { orderKeys: manager.publicKeys },
        path,
      );
      expect(restarted.publicKeys.map(String)).to.deep.equal(
        manager.publicKeys.map(String),
      );
      expect(restarted.checkpoint.nextIndex).to.be.above(far + 4);
      rmSync(folder, { recursive: true });
    });
  });
});

describe("the gate's SOL line in status, without a network", () => {
  const gate = Keypair.generate().publicKey;
  const short = `${gate.toBase58().slice(0, 4)}...${gate.toBase58().slice(-4)}`;
  const sol = (amount: number) => Math.round(amount * 1_000_000_000);

  it("shows the balance and no warning above the threshold", () => {
    const line = gateBalanceLine(gate, sol(0.01));
    expect(line).to.deep.equal({ text: `${short}: 0.0100 SOL`, low: false });
  });

  it("warns, and names the whole key, below the threshold", () => {
    const line = gateBalanceLine(gate, sol(0.004));
    expect(line.low).to.equal(true);
    expect(line.text).to.equal(
      `${short}: 0.0040 SOL. gate low on SOL: account openings will fail; send SOL to ${gate.toBase58()}`,
    );
  });

  it("is not low exactly at the threshold", () => {
    expect(gateBalanceLine(gate, sol(GATE_LOW_SOL)).low).to.equal(false);
    expect(gateBalanceLine(gate, sol(GATE_LOW_SOL) - 1).low).to.equal(true);
  });

  it("rounds down, so a low balance never reads as the threshold", () => {
    expect(gateBalanceLine(gate, sol(GATE_LOW_SOL) - 1).text).to.match(
      /^\S+: 0\.0049 SOL\. gate low on SOL/,
    );
  });
});

describe("the owner-actions check's decisions, without a network", () => {
  const failed = (code: number) =>
    `{"InstructionError":[1,{"Custom":${code}}]}\nProgram log: failed`;

  it("funds a rehearsal with dust by default, and mainnet with nothing unless an amount is named", () => {
    expect(fundingAmount({}, false)).to.equal("0.01");
    expect(fundingAmount({}, true)).to.equal(null);
    expect(fundingAmount({ AMOUNT: "" }, true)).to.equal(null);
    expect(fundingAmount({ AMOUNT: "0.5" }, false)).to.equal("0.5");
    expect(() => fundingAmount({ AMOUNT: "0.5" }, true)).to.throw(
      /refused on mainnet.*Nothing was sent/,
    );
  });

  it("numbers every error it names as the built interface file does", () => {
    for (const [code, name] of Object.entries(OWNER_ERRORS)) {
      expect(idlErrorCode(name), name).to.equal(Number(code));
    }
    expect(Object.keys(OWNER_ERRORS)).to.have.length(4);
  });

  it("signs proofs inside the program's expiry limit, and the too-far proof outside it", () => {
    expect(PROOF_LIFETIME_SECONDS).to.be.at.most(MAX_OWNER_EXPIRY_AHEAD);
    expect(TOO_FAR_SECONDS).to.be.greaterThan(MAX_OWNER_EXPIRY_AHEAD);
    expect(
      refusalVerdict(OWNER_EXPIRY_TOO_FAR, failed(OWNER_EXPIRY_TOO_FAR)).pass,
    ).to.equal(true);
    expect(
      refusalVerdict(
        WRONG_WITHDRAW_DESTINATION,
        failed(WRONG_WITHDRAW_DESTINATION),
      ).detail,
    ).to.equal("refused with WrongWithdrawDestination (6154)");
  });

  it("passes a refusal only for the number the step proves", () => {
    expect(
      refusalVerdict(WRONG_OWNER_NONCE, failed(WRONG_OWNER_NONCE)),
    ).to.deep.equal({
      pass: true,
      detail: "refused with WrongOwnerNonce (6152)",
    });
    expect(
      refusalVerdict(INVALID_OWNER_PROOF, failed(WRONG_OWNER_NONCE)),
    ).to.deep.equal({
      pass: false,
      detail:
        "refused with WrongOwnerNonce (6152), expected InvalidOwnerProof (6151)",
    });
  });

  it("fails a refusal with no program number, and a send that was accepted", () => {
    expect(refusalVerdict(WRONG_OWNER_NONCE, "socket hang up").pass).to.equal(
      false,
    );
    expect(refusalVerdict(WRONG_OWNER_NONCE, "socket hang up").detail).to.equal(
      "refused with no program error, expected WrongOwnerNonce (6152)",
    );
    expect(refusalVerdict(WRONG_OWNER_NONCE, null)).to.deep.equal({
      pass: false,
      detail: "accepted, expected WrongOwnerNonce (6152)",
    });
  });

  it("flips exactly one signature byte of a proof and leaves its key and text", () => {
    const owner = Keypair.generate();
    const text = new TextEncoder().encode("NoirWire: exact owner text");
    const signature = nacl.sign.detached(text, owner.secretKey);
    const proof = ownerProofInstruction(owner.publicKey, text, signature);
    const flipped = withFlippedSignatureByte(proof);
    const differing = [...proof.data].flatMap((byte, at) =>
      byte === flipped.data[at] ? [] : [at],
    );
    expect(differing).to.deep.equal([48]);
    expect(flipped.programId.equals(proof.programId)).to.equal(true);
    expect(flipped.data.length).to.equal(proof.data.length);
    const carried = (data: Buffer) => data.subarray(48, 112);
    expect(
      verifyOwnerSignature(
        text,
        carried(proof.data),
        owner.publicKey,
        PROGRAM_ID,
      ),
    ).to.equal("raw");
    expect(
      verifyOwnerSignature(
        text,
        carried(flipped.data),
        owner.publicKey,
        PROGRAM_ID,
      ),
    ).to.equal(null);
  });

  it("passes a flipped signature only when the Ed25519 check at instruction 0 refused it", () => {
    const precompile = `{"InstructionError":[0,{"Custom":2}]}`;
    expect(tamperedSignatureVerdict(precompile)).to.deep.equal({
      pass: true,
      detail:
        "refused by the signature check before the program ran (instruction 0, code 2)",
    });
    const accepted = tamperedSignatureVerdict(null);
    expect(accepted.pass).to.equal(false);
    expect(accepted.detail).to.match(/does not verify.*Do not upgrade/);
    expect(tamperedSignatureVerdict(failed(INVALID_OWNER_PROOF)).pass).to.equal(
      false,
    );
    expect(tamperedSignatureVerdict("socket hang up").pass).to.equal(false);
    expect(
      tamperedSignatureVerdict(`{"InstructionError":[0,{"Custom":6151}]}`).pass,
    ).to.equal(false);
  });

  it("names a program number it knows, and shows one it does not", () => {
    expect(refusalName(failed(6154))).to.equal(
      "WrongWithdrawDestination (6154)",
    );
    expect(refusalName(failed(6001))).to.equal("6001");
  });

  it("prints a status column, and compares keys by place", () => {
    expect(stepLine("PASS", "deposit", "5 atoms")).to.equal(
      "PASS deposit: 5 atoms",
    );
    expect(sameKeys(["a", "b"], ["a", "b"])).to.equal(true);
    expect(sameKeys(["a", "b"], ["b", "a"])).to.equal(false);
    expect(sameKeys(["a"], ["a", "b"])).to.equal(false);
  });
});

describe("the crank's pace and a silent oracle, without a network", () => {
  it("takes the round interval in milliseconds and still honours whole seconds", () => {
    expect(configuredEveryMs(undefined, undefined)).to.equal(null);
    expect(configuredEveryMs("", "")).to.equal(null);
    expect(configuredEveryMs("250", undefined)).to.equal(250);
    expect(configuredEveryMs(undefined, "2"), "an old CRANK_EVERY").to.equal(
      2_000,
    );
    expect(configuredEveryMs("300", "5"), "milliseconds win").to.equal(300);
    expect(() => configuredEveryMs("49", undefined)).to.throw(/less than 50/);
    expect(() => configuredEveryMs("0", undefined)).to.throw(
      /not a positive whole number/,
    );
    expect(() => configuredEveryMs("1.5", undefined)).to.throw(
      /CRANK_EVERY_MS/,
    );
    expect(() => configuredEveryMs(undefined, "x")).to.throw(/CRANK_EVERY/);
    expect(crankEveryMs(null), "the safety tick").to.equal(200);
    expect(crankEveryMs(250), "set").to.equal(250);
  });

  it("sends nothing for a price that is not newer than the recorded one, and a refused observation only once a second", () => {
    expect(syncDecision(1_000, 1_000, 1_001, 90)).to.equal("unchanged");
    expect(syncDecision(999, 1_000, 1_001, 90)).to.equal("unchanged");
    expect(syncDecision(1_001, 1_000, 1_001, 90)).to.equal("send");
    const crank = readFileSync("ops/crank.ts", "utf8");
    expect(crank).to.match(/if \(decision === "send" && observation\) \{/);
    expect(crank.match(/await send\(connection, source\.sync/g)).to.have.length(
      1,
    );
    expect(resendDue(10_000, 10_999)).to.equal(false);
    expect(resendDue(10_000, 11_000)).to.equal(true);
  });

  it("keeps the same observation's line out of the log until it changes or ten seconds pass", () => {
    const last = { outcome: "unchanged" as const, atMs: 0 };
    expect(roundLineDue(undefined, "unchanged", false, 0)).to.equal(true);
    expect(roundLineDue(last, "unchanged", false, 9_999)).to.equal(false);
    expect(roundLineDue(last, "unchanged", false, 10_000)).to.equal(true);
    expect(roundLineDue(last, "synced", false, 1)).to.equal(true);
    expect(roundLineDue(last, "unchanged", true, 1)).to.equal(true);
  });

  it("delays two cranks' rounds by different, fixed times under 50 ms", () => {
    const key = Uint8Array.from({ length: 32 }, (_, nth) => nth + 1);
    const other = Uint8Array.from({ length: 32 }, (_, nth) => nth + 40);
    const first = crankPhaseMs(key, "", CRANK_DELAY_SPAN_MS);
    expect(
      crankPhaseMs(key, "", CRANK_DELAY_SPAN_MS),
      "the same on every start",
    ).to.equal(first);
    expect(first).to.be.within(0, CRANK_DELAY_SPAN_MS - 1);
    expect(
      crankPhaseMs(other, "", CRANK_DELAY_SPAN_MS),
      "another key",
    ).to.not.equal(first);
    expect(
      crankPhaseMs(key, "crank2", CRANK_DELAY_SPAN_MS),
      "another seed",
    ).to.not.equal(first);
  });

  it("gives up on a time, not on a count of rounds", () => {
    let streaks = new Map<string, number>();
    let since = new Map<string, number>();
    let gaveUpAt: number | null = null;
    for (let now = 0; now <= 10_000 && gaveUpAt === null; now += 200) {
      streaks = afterOutcome(streaks, "market 0", "unreadable");
      since = failingSince(since, streaks, now);
      if (givenUp(streaks, since, now, 6_000)) gaveUpAt = now;
    }
    expect(gaveUpAt, "a real RPC failure still gives up, after 6 s").to.equal(
      6_000,
    );
    streaks = afterOutcome(streaks, "market 0", "synced");
    expect(failingSince(since, streaks, 7_000).size).to.equal(0);
    const slow = new Map([["market 0", 2]]);
    expect(
      givenUp(slow, new Map([["market 0", 0]]), 60_000, 6_000),
      "two rounds are too few",
    ).to.equal(null);
  });

  it("keeps the crank up through 300 s of a silent oracle, with one alert, a repeat and one recovery", () => {
    const lines: string[] = [];
    let silences = new Map<string, Standing<Silent>>();
    let streaks = new Map<string, number>();
    let since = new Map<string, number>();
    let pings = 0;
    let rounds = 0;
    for (let now = 0; now <= 400_000; now += 200) {
      const silent = now <= 300_000;
      const outcome = silent ? "silent" : "synced";
      streaks = afterOutcome(
        streaks,
        "market 0",
        silent ? withIncident(outcome, "dislocated") : outcome,
      );
      since = failingSince(since, streaks, now);
      expect(givenUp(streaks, since, now, 6_000), `at ${now} ms`).to.equal(
        null,
      );
      if (roundWasGood(streaks, false)) pings += 1;
      rounds += 1;
      const heard = afterSilence(
        silences,
        new Map([
          [
            "market 0",
            silent
              ? { oracle: "MagicBlock's oracle", seconds: 100 + now / 1_000 }
              : null,
          ],
          ["USDC guard", null],
        ]),
        now,
      );
      silences = heard.after;
      lines.push(...heard.lines);
    }
    expect(pings, "the dead-man's switch is pinged every round").to.equal(
      rounds,
    );
    expect(lines.filter((line) => line.startsWith("ALERT"))).to.have.length(2);
    expect(lines[0]).to.match(
      /^ALERT market 0: MagicBlock's oracle has published nothing newer for 100 s\. .*restarting the crank does not help/,
    );
    expect(lines[1]).to.match(/for 280 s, still/);
    expect(lines.filter((line) => line.startsWith("RECOVERED"))).to.have.length(
      1,
    );
    expect(lines).to.have.length(3);
    expect(lines[2]).to.match(
      /^RECOVERED market 0: MagicBlock's oracle is accepted again/,
    );
    expect(silences.size).to.equal(0);
  });

  it("holds the alert of a source the round could not read", () => {
    const detail: Silent = { oracle: "MagicBlock's oracle", seconds: 120 };
    const first = afterSilence(new Map(), new Map([["market 0", detail]]), 0);
    expect(first.lines).to.have.length(1);
    const unread = afterSilence(first.after, new Map(), 1_000);
    expect(unread.lines, "a failed read is not a recovery").to.deep.equal([]);
    expect(unread.after.has("market 0")).to.equal(true);
    const streaks = afterOutcome(new Map(), "market 0", "silent");
    expect(streaks.get("market 0"), "silence is not a failure").to.equal(0);
  });

  it("reads a sync's outcome from the program's error alone, and sends nothing but the sync and the fire pass after it", () => {
    const crank = readFileSync("ops/crank.ts", "utf8");
    expect(crank).to.not.match(/logsOf|getTransaction/);
    expect(crank.match(/await send\(/g)).to.have.length(2);
    expect(crank).to.match(
      /fireTriggers\(marketId, MAX_FIRES_PER_PASS, perp\)/,
    );
    expect(readFileSync("ops/sending.ts", "utf8")).to.not.include("logsOf");
  });
});

describe("the keeper's status for the network heartbeat, without a network", () => {
  const secret = "s".repeat(40);
  const config = { id: "keeper-a", network: "mainnet", secret };
  const nonce = "0123456789abcdef0123456789abcdef";
  const sweep: SweepRecord = {
    completedAtMs: 1_000_000,
    seq: 7,
    healthy: true,
    failedSteps: 0,
  };
  const ask = (
    asked: string,
    record: SweepRecord | null = sweep,
    now = 1_004_000,
  ) => statusReply("GET", `/status?nonce=${asked}`, config, record, now);

  /** The checks the asking service makes of an answer, as its contract states them. */
  const accepted = (
    reply: ReturnType<typeof statusReply>,
    key: string,
    asked: string,
  ): string | null => {
    if (reply.status !== 200) return `answered ${reply.status}`;
    const signature = reply.headers[KEEPER_SIGNATURE_HEADER];
    if (signature !== signStatus(key, reply.body)) return "not signed";
    const body = JSON.parse(reply.body);
    if (body.nonce !== asked) return "another challenge";
    if (body.keeper !== "keeper-a" || body.network !== "mainnet") return "who";
    if (!body.healthy || body.failedSteps > 0) return "unhealthy";
    if (body.issuedAtMs - body.sweepCompletedAtMs < 0) return "future sweep";
    return null;
  };

  it("answers a correct request with the signed status", () => {
    const reply = ask(nonce);
    expect(reply.status).to.equal(200);
    expect(JSON.parse(reply.body)).to.deep.equal({
      v: 1,
      keeper: "keeper-a",
      network: "mainnet",
      nonce,
      issuedAtMs: 1_004_000,
      healthy: true,
      sweepSeq: 7,
      sweepCompletedAtMs: 1_000_000,
      failedSteps: 0,
    });
    expect(reply.headers[KEEPER_SIGNATURE_HEADER]).to.match(/^[0-9a-f]{64}$/);
    expect(accepted(reply, secret, nonce)).to.equal(null);
    expect(Buffer.byteLength(reply.body)).to.be.lessThan(4_096);
  });

  it("is not accepted under a wrong key", () => {
    expect(accepted(ask(nonce), "w".repeat(40), nonce)).to.equal("not signed");
  });

  it("does not let an answer for an old nonce satisfy a new one", () => {
    const old = ask(nonce);
    const fresh = "fedcba9876543210fedcba9876543210";
    expect(accepted(old, secret, fresh)).to.equal("another challenge");
    const again = ask(fresh);
    expect(JSON.parse(again.body).nonce).to.equal(fresh);
    expect(again.headers[KEEPER_SIGNATURE_HEADER]).to.not.equal(
      old.headers[KEEPER_SIGNATURE_HEADER],
    );
    const forged = {
      ...old,
      body: old.body.replace(nonce, fresh),
    };
    expect(accepted(forged, secret, fresh), "a nonce swapped in").to.equal(
      "not signed",
    );
  });

  it("says plainly that no sweep has completed yet, and refuses what is not a request for the status", () => {
    const none = ask(nonce, null);
    expect(none.status).to.equal(503);
    expect(none.headers[KEEPER_SIGNATURE_HEADER]).to.equal(undefined);
    expect(ask("short").status).to.equal(400);
    expect(ask("0123456789ABCDEF0123456789ABCDEF").status).to.equal(400);
    expect(statusReply("GET", "/status", config, sweep, 1).status).to.equal(
      400,
    );
    expect(
      statusReply("POST", `/?nonce=${nonce}`, config, sweep, 1).status,
    ).to.equal(405);
  });

  it("reports an unhealthy sweep as such, and counts only healthy sweeps in the sequence", () => {
    let record = afterSweep(null, 0, 10);
    record = afterSweep(record, 2, 20);
    expect(record).to.deep.equal({
      completedAtMs: 20,
      seq: 1,
      healthy: false,
      failedSteps: 2,
    });
    const reply = ask(nonce, record, 30);
    expect(accepted(reply, secret, nonce)).to.equal("unhealthy");
    expect(afterSweep(record, 0, 40).seq).to.equal(2);
    expect(
      JSON.parse(ask(nonce, sweep, 5).body).issuedAtMs,
      "never before the sweep it reports",
    ).to.equal(1_000_000);
  });

  it("is off unless a port is set, and refuses a half setup without echoing the secret", () => {
    expect(keeperStatusSettings({})).to.equal(null);
    expect(keeperStatusSettings({ KEEPER_STATUS_PORT: "" })).to.equal(null);
    expect(
      keeperStatusSettings({
        KEEPER_STATUS_PORT: "9100",
        KEEPER_STATUS_ID: "keeper-a",
        KEEPER_STATUS_SECRET: secret,
      }),
    ).to.deep.equal({ port: 9100, host: "127.0.0.1", id: "keeper-a", secret });
    expect(
      keeperStatusSettings({
        KEEPER_STATUS_PORT: "9100",
        KEEPER_STATUS_HOST: "0.0.0.0",
        KEEPER_STATUS_ID: "keeper-a",
        KEEPER_STATUS_SECRET: secret,
      })?.host,
    ).to.equal("0.0.0.0");
    expect(() =>
      keeperStatusSettings({
        KEEPER_STATUS_PORT: "9100",
        KEEPER_STATUS_ID: "keeper-a",
        KEEPER_STATUS_SECRET: "too-short-secret",
      }),
    ).to.throw(/at least 32/);
    try {
      keeperStatusSettings({
        KEEPER_STATUS_PORT: "9100",
        KEEPER_STATUS_ID: "keeper-a",
        KEEPER_STATUS_SECRET: "too-short-secret",
      });
    } catch (error) {
      expect((error as Error).message).to.not.include("too-short-secret");
    }
    expect(() =>
      keeperStatusSettings({
        KEEPER_STATUS_PORT: "9100",
        KEEPER_STATUS_SECRET: secret,
      }),
    ).to.throw(/KEEPER_STATUS_ID/);
    expect(() =>
      keeperStatusSettings({
        KEEPER_STATUS_PORT: "70000",
        KEEPER_STATUS_ID: "keeper-a",
        KEEPER_STATUS_SECRET: secret,
      }),
    ).to.throw(/more than 65535/);
  });

  it("answers over a real socket", async () => {
    let record: SweepRecord | null = null;
    const server = serveKeeperStatus(
      { port: 0, host: "127.0.0.1", id: "keeper-a", secret },
      "mainnet",
      () => record,
      () => {},
    );
    await new Promise((done) => server.once("listening", done));
    const { port } = server.address() as { port: number };
    try {
      const url = `http://127.0.0.1:${port}/?nonce=${nonce}`;
      expect((await fetch(url)).status, "no sweep yet").to.equal(503);
      record = afterSweep(null, 0, Date.now());
      const answer = await fetch(url);
      const body = await answer.text();
      expect(answer.status).to.equal(200);
      expect(answer.headers.get(KEEPER_SIGNATURE_HEADER)).to.equal(
        signStatus(secret, body),
      );
      expect(JSON.parse(body).sweepSeq).to.equal(1);
    } finally {
      server.close();
    }
  });
});

describe("the crank's websocket watch, without a network", () => {
  /** A rollup that counts the reads made of it and can stop delivering its notifications. */
  class FakeRollup {
    slot = 100;
    deliver = true;
    reads = 0;
    private next = 1;
    private readonly held = new Map<string, Buffer>();
    private readonly listeners = new Map<
      number,
      {
        key: string;
        call: (info: { data: Buffer }, context: { slot: number }) => void;
      }
    >();

    onAccountChange(
      address: PublicKey,
      call: (info: { data: Buffer }, context: { slot: number }) => void,
    ): number {
      const id = this.next++;
      this.listeners.set(id, { key: address.toBase58(), call });
      return id;
    }

    async removeAccountChangeListener(id: number): Promise<void> {
      this.listeners.delete(id);
    }

    async getMultipleAccountsInfoAndContext(addresses: PublicKey[]) {
      this.reads += 1;
      return {
        context: { slot: this.slot },
        value: addresses.map((address) => {
          const data = this.held.get(address.toBase58());
          return data ? { data } : null;
        }),
      };
    }

    write(address: PublicKey, byte: number): void {
      this.slot += 1;
      const data = Buffer.from([byte]);
      this.held.set(address.toBase58(), data);
      if (!this.deliver) return;
      for (const { key, call } of this.listeners.values()) {
        if (key === address.toBase58()) call({ data }, { slot: this.slot });
      }
    }
  }

  const busy = Keypair.generate().publicKey;
  const quiet = Keypair.generate().publicKey;
  const setup = () => {
    const rollup = new FakeRollup();
    const said: string[] = [];
    let now = 0;
    const watch = new AccountWatch(
      rollup as unknown as Socket,
      rollup as unknown as Reads,
      () => now,
      (line) => said.push(line),
    );
    rollup.write(busy, 1);
    rollup.write(quiet, 1);
    return {
      rollup,
      said,
      watch,
      advance: (ms: number) => {
        now += ms;
      },
      at: () => now,
    };
  };
  const byte = async (watch: AccountWatch, address: PublicKey) =>
    (await watch.get(address))?.data[0];

  it("starts a round at once when an account changes, without waiting for the tick", async () => {
    const { rollup, watch } = setup();
    const wakeup = new Wakeup();
    watch.onChange = () => wakeup.signal();
    expect(await byte(watch, busy)).to.equal(1);
    const waiting = wakeup.wait(60_000);
    rollup.write(busy, 2);
    expect(await waiting, "woken by the change, not the tick").to.equal(
      "change",
    );
    expect(await byte(watch, busy), "held without a read").to.equal(2);
    expect(rollup.reads, "one read to load the account").to.equal(1);
    rollup.write(busy, 3);
    expect(
      await wakeup.wait(60_000),
      "a change during a round counts",
    ).to.equal("change");
    expect(await wakeup.wait(10)).to.equal("tick");
  });

  it("reads by hand while the socket is silent, then stops once it speaks again", async () => {
    const { rollup, said, watch, advance } = setup();
    await byte(watch, busy);
    await byte(watch, quiet);
    watch.markBusy(busy);
    const loaded = rollup.reads;
    rollup.deliver = false;
    advance(1_900);
    await watch.maintain();
    expect(rollup.reads, "not silent yet").to.equal(loaded);
    advance(200);
    await watch.maintain();
    expect(rollup.reads, "silent: read by hand").to.equal(loaded + 1);
    advance(1_000);
    await watch.maintain();
    advance(1_000);
    await watch.maintain();
    expect(rollup.reads, "once a second, both accounts in one read").to.equal(
      loaded + 3,
    );
    expect(watch.state().fault, "nothing changed: no fault").to.equal(null);
    rollup.deliver = true;
    rollup.write(busy, 9);
    advance(100);
    for (let nth = 0; nth < 5; nth += 1) {
      advance(1_000);
      rollup.write(busy, 10 + nth);
      await watch.maintain();
    }
    expect(rollup.reads, "polling stopped").to.equal(loaded + 3);
    expect(said.some((line) => /silent for over 2 s/.test(line))).to.equal(
      true,
    );
    expect(said.some((line) => /speaks again/.test(line))).to.equal(true);
  });

  it("counts a socket that delivers nothing while reads show the account changing as a fault, and clears it when the socket speaks", async () => {
    const { rollup, said, watch, advance } = setup();
    await byte(watch, busy);
    watch.markBusy(busy);
    rollup.deliver = false;
    advance(2_100);
    rollup.write(busy, 5);
    await watch.maintain();
    expect(
      await byte(watch, busy),
      "the read still brings the change",
    ).to.equal(5);
    expect(watch.state().fault, "too soon to say").to.equal(null);
    advance(1_600);
    const state = await watch.maintain();
    expect(state.fault).to.match(
      /delivered nothing for .* while reads show it changing/,
    );
    expect(said.some((line) => /websocket fault/.test(line))).to.equal(true);
    rollup.deliver = true;
    rollup.write(busy, 6);
    expect(watch.state().fault).to.equal(null);
  });

  it("subscribes again to a socket that missed a change, with longer waits", async () => {
    const { rollup, said, watch, advance } = setup();
    await byte(watch, busy);
    watch.markBusy(busy);
    rollup.deliver = false;
    advance(2_100);
    rollup.write(busy, 5);
    await watch.maintain();
    for (let nth = 0; nth < 30; nth += 1) {
      advance(1_000);
      await watch.maintain();
    }
    const again = said.filter((line) => /subscribing to the rollup/.test(line));
    expect(
      again.length,
      "3 s into the fault, then 6 s later, then 12 s later",
    ).to.equal(3);
  });

  it("makes the keeper read the public accounts only through the watch, and count a socket fault as a failed sweep", () => {
    const keeper = readFileSync("ops/keeper.ts", "utf8");
    expect(keeper).to.not.match(/on\.rollup\.getAccountInfo/);
    expect(keeper).to.match(/new AccountWatch\(/);
    expect(keeper).to.match(
      /socketFault = \(await rollupWatch\.maintain\(\)\)\.fault !== null/,
    );
    expect(keeper).to.match(/failed = sweep\.failed \|\| socketFault/);
    const reads = readFileSync("ops/keeper-reads.ts", "utf8");
    expect(reads).to.not.match(/getAccountInfo|on\.rollup/);
  });

  it("serves the keeper's per-sweep reads from memory: 37 reads a second before, a tenth of one after", async () => {
    const exchange = Keypair.generate().publicKey;
    const market = Keypair.generate().publicKey;
    const feed = Keypair.generate().publicKey;
    const addresses = {
      exchange,
      market: () => market,
      priceFeed: () => feed,
    } as unknown as Parameters<typeof seatCapacity>[0];
    const asked: string[] = [];
    const recording = {
      get: async (address: PublicKey) => {
        asked.push(address.toBase58());
        return null;
      },
      fresh: async () => {},
      markBusy: () => {},
    };
    await seatCapacity(addresses, recording).catch(() => {});
    await perpMarketCount(addresses, recording).catch(() => {});
    await markOf(addresses, recording, 0).catch(() => {});
    await perpMarkets(addresses, recording).catch(() => {});
    expect(
      asked,
      "each helper reads only through the held accounts, the exchange and the feed",
    ).to.deep.equal([
      exchange.toBase58(),
      exchange.toBase58(),
      feed.toBase58(),
      exchange.toBase58(),
    ]);

    // One sweep of a full table on one market: seat capacity, market count,
    // exchange + market + feed, and the mark before each batch of ORDER_KEYS
    // ranges of 64 seats over 8,192 seats.
    const batches = Math.ceil(Math.ceil(8_192 / 64) / ORDER_KEYS);
    const sweepGets = 1 + 1 + 3 + batches;
    const sweep = async (get: (address: PublicKey) => Promise<unknown>) => {
      await get(exchange);
      await get(exchange);
      await Promise.all([get(exchange), get(market), get(feed)]);
      for (let nth = 0; nth < batches; nth += 1) await get(feed);
    };
    const seconds = 60;
    const before = new FakeRollup();
    for (const address of [exchange, market, feed]) before.write(address, 1);
    const direct = (address: PublicKey) =>
      (before as unknown as Reads).getMultipleAccountsInfoAndContext([address]);
    for (let second = 0; second < seconds; second += 1) await sweep(direct);
    expect(before.reads).to.equal(seconds * sweepGets);
    expect(before.reads / seconds, "reads a second before").to.equal(37);

    const after = new FakeRollup();
    let now = 0;
    for (const address of [exchange, market, feed]) after.write(address, 1);
    const watch = new AccountWatch(
      after as unknown as Socket,
      after as unknown as Reads,
      () => now,
      () => {},
    );
    for (let second = 0; second < seconds; second += 1) {
      now += 1_000;
      after.write(feed, second % 200);
      await watch.maintain();
      await sweep((address) => watch.get(address));
    }
    expect(after.reads / seconds, "reads a second after").to.be.lessThan(0.25);
    expect(after.reads, "three to load, one batched audit every 10 s").to.equal(
      3 + 5,
    );
    expect(watch.state().fault).to.equal(null);
  });

  it("reads nothing in steady state but the audit and the clock, a fraction of a read a second", async () => {
    const { rollup, watch, advance, at } = setup();
    const exchange = Keypair.generate().publicKey;
    rollup.write(exchange, 1);
    await byte(watch, busy);
    await byte(watch, quiet);
    await byte(watch, exchange);
    watch.markBusy(busy);
    let clockReads = 0;
    const clock = new RollupClock(async () => {
      clockReads += 1;
      return 1_700_000_000 + Math.floor(at() / 1_000);
    }, at);
    await clock.ready();
    const loaded = rollup.reads;
    const seconds = 59;
    for (let tick = 0; tick < seconds * 10; tick += 1) {
      advance(100);
      rollup.write(busy, tick % 200);
      await clock.ready();
      await watch.maintain();
      await watch.get(busy);
      await watch.get(quiet);
    }
    const reads = rollup.reads - loaded + clockReads;
    expect(
      rollup.reads - loaded,
      "an audit of all accounts every 10 s",
    ).to.equal(5);
    expect(clockReads, "one at the start, one after 30 s").to.equal(2);
    expect(reads / seconds, "reads a second").to.be.lessThan(0.15);
    expect(clock.seconds(), "counted forward").to.equal(
      1_700_000_000 + Math.floor(at() / 1_000),
    );
    expect(watch.state().fault).to.equal(null);
  });
});

/**
 * What the update-market command decides, apart from the network so it can be
 * checked without one: which caps were asked for, and whether the market may
 * be changed to them. The launch's caps are a ceiling, never a floor: a cap
 * is lowered or kept, and raised back only as far as the launch's own figure
 * and what insurance covers at the live mark. The max price age is set only to
 * the launch's own figure, the one every other command checks the market
 * against. Everything else about the market is written back as it was found.
 */
import type { MarketLimits, MarketParams } from "../sdk/dist/index.js";
import { applyRequested } from "./administering";

const U64_MAX = 2n ** 64n - 1n;
const I64_MAX = 2n ** 63n - 1n;

export type LimitsRequest = {
  /** Lots, or null to keep the market's. */
  openInterestCap: bigint | null;
  positionCap: bigint | null;
  /** Seconds, or null to keep the market's. */
  maxPriceAge: bigint | null;
  /** The operator asked to send it (`APPLY=yes`); without it the command only shows the change. */
  apply: boolean;
};

type Settings = Record<string, string | undefined>;

function lots(name: string, value: string | undefined): bigint | null {
  if (value === undefined || value === "") return null;
  if (!/^[1-9]\d*$/.test(value) || BigInt(value) > U64_MAX) {
    throw new Error(
      `${name} is ${value}, which is not a whole number of lots above zero. Nothing was sent.`,
    );
  }
  return BigInt(value);
}

function seconds(name: string, value: string | undefined): bigint | null {
  if (value === undefined || value === "") return null;
  if (!/^[1-9]\d*$/.test(value) || BigInt(value) > I64_MAX) {
    throw new Error(
      `${name} is ${value}, which is not a whole number of seconds above zero. Nothing was sent.`,
    );
  }
  return BigInt(value);
}

/** The limits asked for, refused unless each is plainly a number; at least one must be given. */
export function limitsRequest(settings: Settings): LimitsRequest {
  const openInterestCap = lots("OPEN_INTEREST_CAP", settings.OPEN_INTEREST_CAP);
  const positionCap = lots("POSITION_CAP", settings.POSITION_CAP);
  const maxPriceAge = seconds("MAX_PRICE_AGE", settings.MAX_PRICE_AGE);
  if (
    openInterestCap === null &&
    positionCap === null &&
    maxPriceAge === null
  ) {
    throw new Error(
      "Set OPEN_INTEREST_CAP or POSITION_CAP, in lots, or MAX_PRICE_AGE, in seconds, or any of them. Nothing was sent.",
    );
  }
  return {
    openInterestCap,
    positionCap,
    maxPriceAge,
    apply: applyRequested(settings),
  };
}

export type LimitsChange = {
  /** Every limit of the market, as `update_market` takes them: the found ones, with the two caps as asked. */
  limits: MarketLimits;
  openInterestCap: bigint;
  positionCap: bigint;
};

/**
 * The limits to write, or a refusal. `launch` holds the launch profile's two
 * caps, the ceiling; `covered` is the lots insurance covers at the live mark,
 * or null where what insurance holds cannot be known here (custody the rollup
 * does not serve, and no figure from the console). Lowering or keeping a cap
 * is always allowed, known cover or not. Raising either needs the open
 * interest cap to stay within what insurance covers, and so needs it known.
 */
export function limitsChange(
  found: MarketParams,
  launch: { openInterestCap: bigint; positionCap: bigint; maxPriceAge: bigint },
  covered: bigint | null,
  request: Pick<
    LimitsRequest,
    "openInterestCap" | "positionCap" | "maxPriceAge"
  >,
): LimitsChange {
  const openInterestCap = request.openInterestCap ?? found.openInterestCap;
  const positionCap = request.positionCap ?? found.positionCap;
  const maxPriceAge = request.maxPriceAge ?? found.maxPriceAge;
  const refuse = (why: string): never => {
    throw new Error(`${why} Nothing was sent.`);
  };
  if (request.maxPriceAge !== null && maxPriceAge !== launch.maxPriceAge) {
    refuse(
      `MAX_PRICE_AGE is ${maxPriceAge} s. The launch's is ${launch.maxPriceAge} s, and it is the only one the other commands accept the market with.`,
    );
  }
  if (
    openInterestCap === found.openInterestCap &&
    positionCap === found.positionCap &&
    maxPriceAge === found.maxPriceAge
  ) {
    refuse(
      `The market already has an open interest cap of ${found.openInterestCap} lots, a position cap of ${found.positionCap} and a max price age of ${found.maxPriceAge} s.`,
    );
  }
  if (openInterestCap > launch.openInterestCap) {
    refuse(
      `An open interest cap of ${openInterestCap} lots is above the launch's ${launch.openInterestCap}, which this command never goes past.`,
    );
  }
  if (positionCap > launch.positionCap) {
    refuse(
      `A position cap of ${positionCap} lots is above the launch's ${launch.positionCap}, which this command never goes past.`,
    );
  }
  if (positionCap > openInterestCap) {
    refuse(
      `A position cap of ${positionCap} lots is above the open interest cap of ${openInterestCap}: lower POSITION_CAP too.`,
    );
  }
  const raises =
    openInterestCap > found.openInterestCap || positionCap > found.positionCap;
  if (raises && covered === null) {
    refuse(
      "Raising a cap needs what insurance holds, and the rollup does not serve the custody token account, so it cannot be read here: " +
        "read the insurance the exchange holds from the admin console and run again with INSURANCE_HELD=<whole USDC>. Lowering a cap needs no figure.",
    );
  }
  if (raises && covered !== null && openInterestCap > covered) {
    refuse(
      `Insurance covers ${covered} lots at the live mark, fewer than the open interest cap of ${openInterestCap} this would leave: nothing is raised until it is covered.`,
    );
  }
  return {
    openInterestCap,
    positionCap,
    limits: {
      minSize: found.minSize,
      minNotional: found.minNotional,
      bandBps: found.bandBps,
      imBps: found.imBps,
      mmBps: found.mmBps,
      takerFeeBps: found.takerFeeBps,
      liqPenaltyBps: found.liqPenaltyBps,
      fundingCapBps: found.fundingCapBps,
      maxMoveBps: found.maxMoveBps,
      maxOpenOrders: found.maxOpenOrders,
      maxPriceAge,
      fundingInterval: found.fundingInterval,
      minPublishGap: found.minPublishGap,
      openInterestCap,
      liqBufferBps: found.liqBufferBps,
      liqInsuranceShareBps: found.liqInsuranceShareBps,
      feeInsuranceShareBps: found.feeInsuranceShareBps,
      settleWindow: found.settleWindow,
      positionCap,
    },
  };
}

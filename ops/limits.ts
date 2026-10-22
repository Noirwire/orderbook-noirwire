/**
 * What the update-market command decides, apart from the network so it can be
 * checked without one: which caps were asked for, and whether the market may
 * be changed to them. The launch's caps are a ceiling, never a floor: a cap
 * is lowered or kept, and raised back only as far as the launch's own figure
 * and what insurance covers at the live mark. Everything else about the market
 * is written back as it was found.
 */
import type { MarketLimits, MarketParams } from "../sdk/dist/index.js";

const U64_MAX = 2n ** 64n - 1n;

export type LimitsRequest = {
  /** Lots, or null to keep the market's. */
  openInterestCap: bigint | null;
  positionCap: bigint | null;
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

/** The caps asked for, refused unless each is plainly a number of lots; at least one must be given. */
export function limitsRequest(settings: Settings): LimitsRequest {
  const openInterestCap = lots("OPEN_INTEREST_CAP", settings.OPEN_INTEREST_CAP);
  const positionCap = lots("POSITION_CAP", settings.POSITION_CAP);
  if (openInterestCap === null && positionCap === null) {
    throw new Error(
      "Set OPEN_INTEREST_CAP, POSITION_CAP or both, in lots. Nothing was sent.",
    );
  }
  const { APPLY } = settings;
  if (APPLY !== undefined && APPLY !== "" && APPLY !== "yes") {
    throw new Error(
      `APPLY is ${APPLY}: use APPLY=yes to send the change, or leave it out to only see it. Nothing was sent.`,
    );
  }
  return { openInterestCap, positionCap, apply: APPLY === "yes" };
}

export type LimitsChange = {
  /** Every limit of the market, as `update_market` takes them: the found ones, with the two caps as asked. */
  limits: MarketLimits;
  openInterestCap: bigint;
  positionCap: bigint;
};

/**
 * The limits to write, or a refusal. `launch` holds the launch profile's two
 * caps, the ceiling; `covered` is the lots insurance covers at the live mark.
 * Lowering or keeping a cap is always allowed. Raising either needs the open
 * interest cap to stay within what insurance covers.
 */
export function limitsChange(
  found: MarketParams,
  launch: { openInterestCap: bigint; positionCap: bigint },
  covered: bigint,
  request: Pick<LimitsRequest, "openInterestCap" | "positionCap">,
): LimitsChange {
  const openInterestCap = request.openInterestCap ?? found.openInterestCap;
  const positionCap = request.positionCap ?? found.positionCap;
  const refuse = (why: string): never => {
    throw new Error(`${why} Nothing was sent.`);
  };
  if (
    openInterestCap === found.openInterestCap &&
    positionCap === found.positionCap
  ) {
    refuse(
      `The market already has an open interest cap of ${found.openInterestCap} lots and a position cap of ${found.positionCap}.`,
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
  if (raises && openInterestCap > covered) {
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
      maxPriceAge: found.maxPriceAge,
      fundingInterval: found.fundingInterval,
      minPublishGap: found.minPublishGap,
      maxAgeLiquidation: found.maxAgeLiquidation,
      openInterestCap,
      liqBufferBps: found.liqBufferBps,
      liqInsuranceShareBps: found.liqInsuranceShareBps,
      feeInsuranceShareBps: found.feeInsuranceShareBps,
      settleWindow: found.settleWindow,
      positionCap,
    },
  };
}

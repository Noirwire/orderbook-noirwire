/**
 * What the set-mark-source command decides, apart from the network so it can be
 * checked without one: which primary price and breaker settings were asked for.
 */
import { MAINNET_MARK_SOURCE } from "../sdk/dist/operator/index.js";

/** RULES 9b: the widest breaker limit `set_mark_source` takes, `MAX_BREAKER_BPS` of the program. */
export const MAX_BREAKER_BPS = 1_000;
/** RULES 9b: the longest breaker age `set_mark_source` takes, `MAX_BREAKER_AGE` of the program. */
export const MAX_BREAKER_AGE = 120;
/** RULES 9b: the widest liquidation band, one byte. */
export const MAX_LIQUIDATION_BAND = 255;

export type MarkSourceRequest = {
  /** The oracle's feed number, or 0 to take the primary price away. */
  markFeed: number;
  /** The breaker's limit in bps, or 0 to take the primary price away. */
  breakerBps: number;
  /** Seconds a Pyth observation counts as fresh, or 0 to take the primary price away. */
  breakerAge: number;
  /** The band in bps a liquidation needs Pyth to agree within, or 0 to take the primary price away. */
  liquidationBand: number;
  /** The operator asked to send it (`APPLY=yes`); without it the command only shows the change. */
  apply: boolean;
};

type Settings = Record<string, string | undefined>;

/**
 * RULES 9b: why a primary price cannot be taken away now, or null. The program
 * refuses unless the exchange is paused, because the mark the primary set stays and
 * nothing confirms it until a sync has replaced it with a Pyth mark. The operator
 * pauses first and keeps it paused until that sync has happened.
 */
export function removalRefusal(
  request: Pick<MarkSourceRequest, "markFeed">,
  current: { markFeed: number },
  exchangePaused: boolean,
): string | null {
  if (request.markFeed !== 0 || current.markFeed === 0 || exchangePaused) {
    return null;
  }
  return "Taking the primary price away needs the exchange paused first, and it stays paused until the crank has synced a fresh Pyth mark and the mark check passes (docs/LAUNCH.md, rollback). Nothing was sent.";
}

/**
 * The binding asked for: the profile's feed with `BREAKER_BPS` (400 by default),
 * `BREAKER_AGE` (90 s by default) and `LIQUIDATION_BAND` (150 by default, and
 * tighter than the limit), or with `REMOVE=yes` none at all. Anything else in
 * `APPLY`, `REMOVE` or the three settings is refused rather than read as a default.
 */
export function markSourceRequest(settings: Settings): MarkSourceRequest {
  const { APPLY, REMOVE, BREAKER_BPS, BREAKER_AGE, LIQUIDATION_BAND } =
    settings;
  const unset = (value: string | undefined) =>
    value === undefined || value === "";
  if (!unset(APPLY) && APPLY !== "yes") {
    throw new Error(
      `APPLY is ${APPLY}: use APPLY=yes to send the change, or leave it out to only see it. Nothing was sent.`,
    );
  }
  if (!unset(REMOVE) && REMOVE !== "yes") {
    throw new Error(
      `REMOVE is ${REMOVE}: use REMOVE=yes to take the primary price away. Nothing was sent.`,
    );
  }
  const apply = APPLY === "yes";
  if (REMOVE === "yes") {
    if (
      !unset(BREAKER_BPS) ||
      !unset(BREAKER_AGE) ||
      !unset(LIQUIDATION_BAND)
    ) {
      throw new Error(
        "REMOVE=yes takes no BREAKER_BPS, BREAKER_AGE or LIQUIDATION_BAND. Nothing was sent.",
      );
    }
    return {
      markFeed: 0,
      breakerBps: 0,
      breakerAge: 0,
      liquidationBand: 0,
      apply,
    };
  }
  const whole = (
    name: string,
    value: string | undefined,
    from: number,
    to: number,
    fallback: number,
  ) => {
    if (unset(value)) return fallback;
    const number = /^\d+$/.test(value ?? "") ? Number(value) : NaN;
    if (!(number >= from && number <= to)) {
      throw new Error(
        `${name} is ${value}: give a whole number from ${from} to ${to}. Nothing was sent.`,
      );
    }
    return number;
  };
  const breakerBps = whole(
    "BREAKER_BPS",
    BREAKER_BPS,
    2,
    MAX_BREAKER_BPS,
    MAINNET_MARK_SOURCE.breakerBps,
  );
  const liquidationBand = whole(
    "LIQUIDATION_BAND",
    LIQUIDATION_BAND,
    1,
    Math.min(MAX_LIQUIDATION_BAND, breakerBps - 1),
    Math.min(MAINNET_MARK_SOURCE.liquidationBand, breakerBps - 1),
  );
  return {
    markFeed: MAINNET_MARK_SOURCE.markFeed,
    breakerBps,
    breakerAge: whole(
      "BREAKER_AGE",
      BREAKER_AGE,
      1,
      MAX_BREAKER_AGE,
      MAINNET_MARK_SOURCE.breakerAge,
    ),
    liquidationBand,
    apply,
  };
}

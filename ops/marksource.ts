/**
 * What the set-mark-source command decides, apart from the network so it can be
 * checked without one: which primary price and band were asked for.
 */
import { MAINNET_MARK_SOURCE } from "../sdk/dist/operator/index.js";

/** RULES 9b: the widest band `set_mark_source` takes, `MAX_BPS` of the program. */
export const MAX_GUARD_BPS = 10_000;
/** RULES 9b: the longest guard window `set_mark_source` takes, Pyth's heartbeat. */
export const MAX_GUARD_WINDOW = 55;

export type MarkSourceRequest = {
  /** The oracle's feed number, or 0 to take the primary price away. */
  markFeed: number;
  /** The band's base in bps, or 0 to take the primary price away. */
  guardBps: number;
  /** Seconds the Pyth guard counts as fresh, or 0 to take the primary price away. */
  guardWindow: number;
  /** The operator asked to send it (`APPLY=yes`); without it the command only shows the change. */
  apply: boolean;
};

type Settings = Record<string, string | undefined>;

/**
 * The binding asked for: the profile's feed with `GUARD_BPS` (100 by default) and
 * `GUARD_WINDOW` (10 s by default), or with `REMOVE=yes` none at all. Anything
 * else in `APPLY`, `REMOVE`, `GUARD_BPS` or `GUARD_WINDOW` is refused rather
 * than read as a default.
 */
export function markSourceRequest(settings: Settings): MarkSourceRequest {
  const { APPLY, REMOVE, GUARD_BPS, GUARD_WINDOW } = settings;
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
    if (!unset(GUARD_BPS) || !unset(GUARD_WINDOW)) {
      throw new Error(
        "REMOVE=yes takes no GUARD_BPS or GUARD_WINDOW. Nothing was sent.",
      );
    }
    return { markFeed: 0, guardBps: 0, guardWindow: 0, apply };
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
  return {
    markFeed: MAINNET_MARK_SOURCE.markFeed,
    guardBps: whole(
      "GUARD_BPS",
      GUARD_BPS,
      1,
      MAX_GUARD_BPS,
      MAINNET_MARK_SOURCE.guardBps,
    ),
    guardWindow: whole(
      "GUARD_WINDOW",
      GUARD_WINDOW,
      1,
      MAX_GUARD_WINDOW,
      MAINNET_MARK_SOURCE.guardWindow,
    ),
    apply,
  };
}

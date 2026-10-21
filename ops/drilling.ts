/**
 * What the drills decide, apart from the network so it can be checked
 * without one: which drills run, where they may not, which outcome of each
 * check counts as ok, when a mark has gone stale, and whether an observation
 * trips the USDC guard.
 */
import {
  ACCOUNT_LEN,
  ACCOUNT_TAG,
  HEADER_LEN,
  RESULT_STATUS,
} from "../sdk/dist/index.js";
import type { Profile } from "./deployment";
import { nameIn } from "./upkeep";

export const DRILLS = ["guard-trip", "stale-price", "rebind"] as const;
export type Drill = (typeof DRILLS)[number];

/**
 * The drills `DRILLS` names, in the order they run, or all of them when it is
 * not set. A name that is not a drill stops the run before anything is sent.
 */
export function drillsSelected(value: string | undefined): Drill[] {
  const named = (value ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  if (named.length === 0) return [...DRILLS];
  const unknown = named.filter(
    (name) => !(DRILLS as readonly string[]).includes(name),
  );
  if (unknown.length > 0) {
    throw new Error(
      `DRILLS names ${unknown.join(", ")}, which is not a drill: the drills are ${DRILLS.join(", ")}. Nothing was sent.`,
    );
  }
  return DRILLS.filter((drill) => named.includes(drill));
}

/**
 * Why the drills may not run here, or null. They trip the USDC guard, let the
 * mark go stale and rebind a market, so never on mainnet, and they drill the
 * mainnet profile's market, which reads Pyth.
 */
export function drillRefusal(on: {
  mainnet: boolean;
  profile: Profile;
}): string | null {
  if (on.mainnet) {
    return "The drills trip the USDC guard, let the mark go stale and rebind the market: they never run on mainnet. Nothing was sent.";
  }
  if (on.profile !== "mainnet") {
    return "The drills prove the mainnet profile's market, which reads Pyth: run them with PROFILE=mainnet. Nothing was sent.";
  }
  return null;
}

/** The program's errors the drills meet, as a failed transaction reports them. */
export const DRILL_ERRORS = {
  StalePrice: 6038,
  PriceTimeWentBackwards: 6070,
  PricePublishedTooSoon: 6073,
  PriceTooOld: 6079,
  QuoteGuardTripped: 6081,
  PriceSourceInUse: 6149,
} as const;

/**
 * A sync refused for its observation rather than its account: one another
 * sender took first, or one that aged out on the way. The next newer
 * observation is waited for.
 */
export const syncWaitsOn = (code: number | null) =>
  code === DRILL_ERRORS.PriceTimeWentBackwards ||
  code === DRILL_ERRORS.PricePublishedTooSoon ||
  code === DRILL_ERRORS.PriceTooOld;

/** What an order or a send came to: taken, or refused with the program's error when there is one. */
export type Attempt =
  | { accepted: true; detail: string }
  | { accepted: false; code: number | null; message: string };

/**
 * What a placed order came to by the result the program wrote: a refusal
 * with the program's error, or a post-only order that would have matched,
 * which the program turns away with no error and nothing rested.
 */
export function orderAttempt(
  result: { status: number; code: number; filled: bigint },
  size: bigint,
): Attempt {
  if (result.status === RESULT_STATUS.refused) {
    return { accepted: false, code: 6000 + result.code, message: "refused" };
  }
  if (result.status === RESULT_STATUS.refusedPostOnlyWouldMatch) {
    return {
      accepted: false,
      code: null,
      message:
        "refusedPostOnlyWouldMatch: the post-only order would have matched",
    };
  }
  return {
    accepted: true,
    detail: `${nameIn(RESULT_STATUS, result.status)}, ${result.filled} of ${size} lots filled`,
  };
}

export type Verdict = "ok" | "FAIL" | "SKIP";
/**
 * One check's outcome. A SKIP leaves the drill's claim unproven unless it is
 * `aside`: a check the endpoint cannot serve, which the claim does not rest on.
 */
export type Line = {
  verdict: Verdict;
  what: string;
  detail: string;
  aside?: boolean;
};

/** A refusal by the name of the program's error where the drills know it. */
export const refusalShown = (attempt: Extract<Attempt, { accepted: false }>) =>
  attempt.code === null
    ? attempt.message
    : `${nameIn(DRILL_ERRORS, attempt.code)} (${attempt.code})`;

/** ok only when the program refused `attempt` with `code`. */
export function refusedWith(
  what: string,
  attempt: Attempt,
  code: number,
): Line {
  const expected = `${nameIn(DRILL_ERRORS, code)} (${code})`;
  if (attempt.accepted) {
    return {
      verdict: "FAIL",
      what,
      detail: `taken (${attempt.detail}), where RULES refuses it with ${expected}`,
    };
  }
  if (attempt.code === code) {
    return { verdict: "ok", what, detail: `refused with ${expected}` };
  }
  return {
    verdict: "FAIL",
    what,
    detail: `refused with ${refusalShown(attempt)}, not ${expected}`,
  };
}

/** ok only when the program took `attempt`. */
export function taken(what: string, attempt: Attempt): Line {
  return attempt.accepted
    ? { verdict: "ok", what, detail: `taken: ${attempt.detail}` }
    : {
        verdict: "FAIL",
        what,
        detail: `refused with ${refusalShown(attempt)}, where RULES takes it`,
      };
}

/**
 * Where a wait for the mark to go stale stands. A mark that got newer while
 * the drill synced nothing was synced by someone else, a crank most likely.
 * Stale is strictly older than `maxAge`, as the program counts it.
 */
export function staleWait(
  startedAt: bigint,
  publishTime: bigint,
  clock: number,
  maxAge: bigint,
): "stale" | "waiting" | "synced meanwhile" {
  if (publishTime > startedAt) return "synced meanwhile";
  return BigInt(clock) - publishTime > maxAge ? "stale" : "waiting";
}

type QuoteRead = { state: number; publishTime: bigint };

/**
 * Whether the USDC guard was synced by someone else around a check that
 * needs it failing as `failing`: it no longer read so before the check, or a
 * newer observation landed during it. Every sync records a newer publish time.
 */
export const quoteMoved = (
  before: QuoteRead,
  after: QuoteRead,
  failing: number,
) =>
  before.state !== failing ||
  after.publishTime !== before.publishTime ||
  after.state !== before.state;

/**
 * A check that did not come out ok while someone else synced what it rests
 * on proves nothing either way: it becomes `crank`, a skip. An ok stands,
 * since the program could only have answered that way under the drill's state.
 */
export const unlessSyncedMeanwhile = (
  line: Line,
  synced: boolean,
  crank: Line,
): Line => (line.verdict !== "ok" && synced ? crank : line);

/** RULES 9a: whether a USDC observation trips a guard of `depegBps`, `|price - 10^-expo| * 10000 > 10^-expo * depeg_bps`. */
export function guardTrips(
  price: bigint,
  expo: number,
  depegBps: number,
): boolean {
  const one = 10n ** BigInt(-expo);
  const distance = price > one ? price - one : one - price;
  return distance * 10_000n > one * BigInt(depegBps);
}

/**
 * The trade that closes two traders' positions against each other as far as
 * they offset: the long one sells and the short one buys the smaller of the
 * two. Null when they do not offset.
 */
export function closingTrade(
  positions: readonly [bigint, bigint],
): { long: 0 | 1; short: 0 | 1; size: bigint } | null {
  const [a, b] = positions;
  if (a > 0n && b < 0n) return { long: 0, short: 1, size: a < -b ? a : -b };
  if (a < 0n && b > 0n) return { long: 1, short: 0, size: b < -a ? b : -a };
  return null;
}

/** RULES 7: a book's funding clock and its totals since then. */
export type BookFunding = {
  lastTime: bigint;
  tradedPremium: bigint;
  tradedSize: bigint;
};

const isBook = (data: Uint8Array) =>
  data.length === ACCOUNT_LEN.book &&
  new TextDecoder().decode(data.subarray(0, ACCOUNT_TAG.book.length)) ===
    ACCOUNT_TAG.book;

/**
 * The funding state at its offsets in a book's body, as the program lays it
 * out, or null when `data` is not a book: the wrong length or tag.
 */
export function bookFunding(data: Uint8Array): BookFunding | null {
  if (!isBook(data)) return null;
  const body = new DataView(data.buffer, data.byteOffset + HEADER_LEN);
  return {
    lastTime: body.getBigInt64(24, true),
    tradedPremium: body.getBigInt64(48, true),
    tradedSize: body.getBigUint64(56, true),
  };
}

/** RULES 7 and 9: a rebind clears the premium sum and the counted size, and restarts the funding clock at the rebind. */
export const fundingReset = (funding: BookFunding, rebindNotBefore: number) =>
  funding.tradedPremium === 0n &&
  funding.tradedSize === 0n &&
  funding.lastTime >= BigInt(rebindNotBefore);

export const lineText = ({ verdict, what, detail }: Line) =>
  `${verdict.padEnd(4)} ${what}${detail ? `: ${detail}` : ""}`;

/** The skips that leave a drill's claim unproven: every skip but an aside. */
export const unproven = (lines: readonly Line[]) =>
  lines.filter(({ verdict, aside }) => verdict === "SKIP" && !aside);

/**
 * The run fails when any check failed, and also when a skip left a claim
 * unproven, so a run that proved nothing never reads as a pass.
 */
export const exitCodeFor = (lines: readonly Line[]) =>
  lines.some(({ verdict }) => verdict === "FAIL") || unproven(lines).length > 0
    ? 1
    : 0;

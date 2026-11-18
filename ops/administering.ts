/**
 * What the admin commands that pause and restrict decide, apart from the
 * network so it can be checked without one: whether a run sends, which key
 * signs, and whether the exchange or the market is in a state the change
 * applies to.
 */
import type { Keypair, PublicKey } from "@solana/web3.js";
import { MARKET_STATUS } from "../sdk/dist/index.js";
import { adminKeyPath, type Target } from "./deployment";
import { adminRefusal } from "./handover";
import { heldKey } from "./keys";

export const DRY_RUN_LINE =
  "Dry run: nothing was sent. Run again with APPLY=yes to send it.";

type Settings = Record<string, string | undefined>;

/** Whether the run sends: only `APPLY=yes`. Anything else that is set is refused rather than read as a dry run. */
export function applyRequested({ APPLY }: Settings): boolean {
  if (APPLY !== undefined && APPLY !== "" && APPLY !== "yes") {
    throw new Error(
      `APPLY is ${APPLY}: use APPLY=yes to send the change, or leave it out to only see it. Nothing was sent.`,
    );
  }
  return APPLY === "yes";
}

/** The admin key kept for this network, refused unless it is the exchange's admin. */
export function adminSigner(on: Target, exchangeAdmin: PublicKey): Keypair {
  const keyFile = adminKeyPath(on);
  const admin = heldKey(keyFile);
  const wrongAdmin = adminRefusal(exchangeAdmin, admin.publicKey, keyFile);
  if (wrongAdmin) throw new Error(wrongAdmin);
  return admin;
}

/**
 * `RUNNING_BUILD=<the program file mainnet runs>`, or null when it is not
 * given. Pausing and restricting are the same instruction in the build mainnet
 * runs before an upgrade and in this checkout's, so they may be sent while the
 * deployed bytes are that earlier file. Unpausing and resuming run on this
 * checkout's build only, and `restricted` says which of the two this is.
 */
function runningBuildOf(
  { RUNNING_BUILD }: Settings,
  allowed: boolean,
  what: string,
): string | null {
  if (RUNNING_BUILD === undefined || RUNNING_BUILD === "") return null;
  if (!allowed) {
    throw new Error(
      `RUNNING_BUILD is for pausing and restricting before an upgrade only: ${what} runs on this checkout's build. Nothing was sent.`,
    );
  }
  return RUNNING_BUILD;
}

export type PauseRequest = {
  paused: boolean;
  apply: boolean;
  runningBuild: string | null;
};

/** `PAUSED=yes` pauses the exchange and `PAUSED=no` unpauses it; anything else is refused. */
export function pauseRequest(settings: Settings): PauseRequest {
  const { PAUSED } = settings;
  if (PAUSED !== "yes" && PAUSED !== "no") {
    throw new Error(
      `Set PAUSED=yes to pause the exchange or PAUSED=no to unpause it${PAUSED ? `, not ${PAUSED}` : ""}. Nothing was sent.`,
    );
  }
  return {
    paused: PAUSED === "yes",
    apply: applyRequested(settings),
    runningBuild: runningBuildOf(settings, PAUSED === "yes", "unpausing"),
  };
}

/** Why the exchange cannot be set to `wanted`, or null: it already is. */
export function pauseRefusal(paused: boolean, wanted: boolean): string | null {
  return paused === wanted
    ? `The exchange is already ${paused ? "paused" : "not paused"}. Nothing was sent.`
    : null;
}

export const STATUS_NAMES = ["paused", "reduce-only", "active"] as const;
export type StatusName = (typeof STATUS_NAMES)[number];

export type StatusRequest = {
  status: StatusName;
  apply: boolean;
  runningBuild: string | null;
};

/** `STATUS=paused`, `reduce-only` or `active` (which is `resume_market`); anything else is refused. */
export function statusRequest(settings: Settings): StatusRequest {
  const status = STATUS_NAMES.find((name) => name === settings.STATUS);
  if (!status) {
    throw new Error(
      `Set STATUS to one of ${STATUS_NAMES.join(", ")}${settings.STATUS ? `, not ${settings.STATUS}` : ""}. Nothing was sent.`,
    );
  }
  return {
    status,
    apply: applyRequested(settings),
    runningBuild: runningBuildOf(settings, status !== "active", "a resume"),
  };
}

const STATUS_CODES: Record<StatusName, number> = {
  paused: MARKET_STATUS.paused,
  "reduce-only": MARKET_STATUS.reduceOnly,
  active: MARKET_STATUS.active,
};

/** The market status number `status` names. */
export const statusCode = (status: StatusName) => STATUS_CODES[status];

/** Why the market cannot be set to `wanted`, or null: it already has that status. */
export function statusRefusal(
  current: number,
  wanted: StatusName,
): string | null {
  return current === statusCode(wanted)
    ? `The market already has the status ${wanted}. Nothing was sent.`
    : null;
}

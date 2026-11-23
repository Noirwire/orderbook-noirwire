/**
 * What the layout command decides, apart from the network so it can be
 * checked without one: whether it was asked to scan and to activate, how many
 * seats a scan call reads, where the scan stands and whether the layout may
 * be activated.
 */
import { applyRequested } from "./administering";
import { isComputeFailure, positiveInteger } from "./upkeep";

/** The seats one `scan_seat_layout` call reads unless `SCAN_SEATS` says another count. */
export const SCAN_SEATS_PER_CALL = 2_048;

/** The most seats a call can be asked for: its count is 16 bits wide. */
const MOST_SCAN_SEATS = 65_535;

export type LayoutRequest = {
  /** The operator asked to send (`APPLY=yes`): the scan runs to the end of the ledger. */
  apply: boolean;
  /** The operator also asked to activate (`ACTIVATE=yes`), the point of no return. */
  activate: boolean;
  /** The seats a call starts with; it is halved after a call that runs out of compute. */
  seatsPerCall: number;
};

/**
 * `APPLY=yes` scans, `APPLY=yes ACTIVATE=yes` scans and then activates. Anything
 * else that is set is refused rather than read as a dry run, and `ACTIVATE=yes`
 * without `APPLY=yes` is refused, since activation is a send.
 */
export function layoutRequest(settings: {
  APPLY?: string;
  ACTIVATE?: string;
  SCAN_SEATS?: string;
}): LayoutRequest {
  const apply = applyRequested(settings);
  const { ACTIVATE } = settings;
  if (ACTIVATE !== undefined && ACTIVATE !== "" && ACTIVATE !== "yes") {
    throw new Error(
      `ACTIVATE is ${ACTIVATE}: use ACTIVATE=yes with APPLY=yes to activate the layout, or leave it out. Nothing was sent.`,
    );
  }
  const activate = ACTIVATE === "yes";
  if (activate && !apply) {
    throw new Error(
      "ACTIVATE=yes sends the activation: run it with APPLY=yes too, or leave it out to scan only. Nothing was sent.",
    );
  }
  return {
    apply,
    activate,
    seatsPerCall: positiveInteger(
      "SCAN_SEATS",
      settings.SCAN_SEATS,
      SCAN_SEATS_PER_CALL,
      MOST_SCAN_SEATS,
    ),
  };
}

/** The exchange as this command reads it. */
export type LayoutExchange = {
  layoutState: "unmigrated" | "preActivation" | "live";
  paused: boolean;
  seatCapacity: number | null;
};

/** Where the scan stands: the account `scan_seat_layout` keeps, or null before its first call. */
export type ScanState = { cursor: number; capacity: number } | null;

/** Why the command cannot work on this exchange at all, or null. */
export function layoutRefusal(exchange: LayoutExchange): string | null {
  if (exchange.layoutState === "unmigrated") {
    return "The exchange does not have a layout this build migrates from. Nothing was sent.";
  }
  if (exchange.layoutState === "live") return null;
  if (!exchange.paused) {
    return "The exchange is not paused. The scan and the activation run only under a pause: pause it first (make mainnet-pause PAUSED=yes). Nothing was sent.";
  }
  return null;
}

/**
 * Why the layout may not be activated now, or null. It may be only while the
 * exchange is paused and the scan has read exactly as many seats as the ledger
 * holds: a scan that is short leaves seats nobody checked, and one that claims
 * more than the ledger holds is not this ledger's.
 */
export function activationRefusal(
  exchange: LayoutExchange,
  scan: ScanState,
): string | null {
  if (!exchange.paused) {
    return "the exchange is not paused";
  }
  const capacity = exchange.seatCapacity;
  if (capacity === null) return "the exchange has no seat capacity";
  if (scan === null) {
    return `the scan has not started: it has read 0 of ${capacity} seats`;
  }
  if (scan.cursor !== capacity) {
    return `the scan has read ${scan.cursor} of ${capacity} seats`;
  }
  return null;
}

const layoutWord = (word: number) =>
  String.fromCharCode(
    word & 0xff,
    (word >> 8) & 0xff,
    (word >> 16) & 0xff,
    (word >>> 24) & 0xff,
  );

/**
 * What the status command says of the exchange's layout and of the seat scan:
 * the layout word and whether it is active, and, before activation, how far
 * the scan has read against the ledger's capacity.
 */
export function layoutStatus(
  exchange: LayoutExchange & { layout: number },
  scan: ScanState,
): { layout: string; scan: string } {
  const word = layoutWord(exchange.layout);
  const capacity = exchange.seatCapacity;
  const read =
    scan === null
      ? `not started (0 of ${capacity} seats)`
      : `${scan.cursor} of ${capacity} seats read${scan.cursor === capacity ? ", complete" : ""} (the ledger held ${scan.capacity} when it began)`;
  if (exchange.layoutState === "live") {
    return {
      layout: `${word}, active`,
      scan: scan === null ? "none (not needed)" : `${read}`,
    };
  }
  if (exchange.layoutState === "preActivation") {
    return {
      layout: `${word}, NOT ACTIVE: the earlier build's seats`,
      scan: read,
    };
  }
  return { layout: `${word}, NOT A LAYOUT THIS BUILD RUNS`, scan: "none" };
}

/**
 * Whether the exchange's layout is one the upgrade starts from or has reached:
 * `NWX2` (before it) or `NWX3` (after). Any other word is a stop: this build
 * does not know the seats' bytes, and the migration instructions cannot
 * correct them, so nothing is reported as ready to deploy.
 */
export function deployReadiness(
  exchange: LayoutExchange & { layout: number },
): { ready: boolean; text: string } {
  const word = layoutWord(exchange.layout);
  if (exchange.layoutState === "preActivation") {
    return {
      ready: true,
      text: `ready to deploy: the layout is ${word}, the layout before the upgrade`,
    };
  }
  if (exchange.layoutState === "live") {
    return {
      ready: true,
      text: `the layout is ${word}, the layout after the upgrade: the new build is already what this exchange runs`,
    };
  }
  return {
    ready: false,
    text: `STOP, not ready to deploy: the layout is ${JSON.stringify(word)} (${exchange.layout}), neither NWX2 (before the upgrade) nor NWX3 (after it)`,
  };
}

/** The seats the next scan call asks for: a full call, or what is left of the ledger. */
export const nextScanCount = (
  cursor: number,
  capacity: number,
  perCall: number,
): number => Math.max(0, Math.min(perCall, capacity - cursor));

/**
 * The seats a call asks for after one that ran out of compute: half, never
 * fewer than one. A call that ran out of compute reverted whole and changed
 * nothing, so the same count is not sent again.
 */
export const halvedScanCount = (perCall: number): number =>
  Math.max(1, Math.floor(perCall / 2));

/**
 * Scans from `cursor` to `capacity`, `perCall` seats a call at the most. A call
 * that runs out of compute is followed by one for half as many seats; any other
 * failure (a seat holding bytes it should not, say) ends the run and is
 * thrown, with the scan where it stood. `read` resolves to the cursor the scan
 * account then holds, once it has moved past `after`. Resolves to the cursor
 * the scan ends at.
 */
export async function scanLedger(run: {
  cursor: number;
  capacity: number;
  perCall: number;
  send: (count: number) => Promise<void>;
  read: (after: number) => Promise<number>;
  say: (line: string) => void;
}): Promise<number> {
  let { cursor, perCall } = run;
  while (cursor < run.capacity) {
    const count = nextScanCount(cursor, run.capacity, perCall);
    const sent = await run.send(count).then(
      () => true,
      (error: Error) => {
        if (!isComputeFailure(error.message) || perCall <= 1) throw error;
        perCall = halvedScanCount(perCall);
        run.say(
          `a call for ${count} seats ran out of compute and changed nothing; the next asks for ${nextScanCount(cursor, run.capacity, perCall)}`,
        );
        return false;
      },
    );
    if (!sent) continue;
    cursor = await run.read(cursor);
  }
  return cursor;
}

/**
 * Moves an exchange the earlier build made onto the active layout: scans every
 * seat of the ledger, then activates it.
 *
 *   [APPLY=yes] [ACTIVATE=yes] [SCAN_SEATS=<seats a call reads, 2048>]
 *
 * An exchange the earlier build made holds seats whose bytes this build reads
 * differently. `scan_seat_layout` reads the ledger in ranges from where the
 * last call stopped and requires the bytes this build reuses to be zero in
 * every seat, reserved and free ones included; a seat that holds anything else
 * refuses the call and stops the run. `activate_layout` then stamps the active
 * layout. It is the point of no return: until it runs, redeploying the earlier
 * build is a safe abort, and after it the earlier build must never run on this
 * data again.
 *
 * Both run only while the exchange is paused. The command shows where the scan
 * stands and what it would do and sends nothing unless APPLY=yes; with it, the
 * scan runs to the end of the ledger, a call that runs out of compute is
 * followed by one for half as many seats, and the run stops there. Activation
 * needs ACTIVATE=yes as well, and is refused unless the scan has read exactly
 * as many seats as the ledger holds. Run again after an interruption: the scan
 * resumes at its own cursor, and an exchange that is already active has
 * nothing left to do.
 *
 * Run it after the trigger books are created and finalised
 * (`make mainnet-trigger-books`) and before the market and the USDC guard are
 * rebound. The Makefile is the way in (`make rehearsal-layout`,
 * `make mainnet-layout`).
 */
import { decodeLayoutScan, type LayoutScan } from "../sdk/dist/index.js";
import { rollupIsRunBy, run, sendingAs } from "./deployment";
import { DRY_RUN_LINE, adminSigner } from "./administering";
import {
  activationRefusal,
  layoutRefusal,
  layoutRequest,
  scanLedger,
  type ScanState,
} from "./layouting";
import { shown } from "./leaving";
import { exchangeInRollup } from "./market";
import { deployedAsBuilt } from "./program";
import { send, until, withFullBudget } from "./sending";
import type { Target } from "./deployment";

async function scanNow(on: Target): Promise<ScanState> {
  const account = await on.rollup.getAccountInfo(
    on.instructions.addresses.layoutScan,
  );
  if (!account) return null;
  const scan: LayoutScan = decodeLayoutScan(account.data);
  return { cursor: scan.cursor, capacity: scan.capacity };
}

const scanText = (scan: ScanState, capacity: number | null) =>
  scan === null
    ? `not started, 0 of ${capacity} seats`
    : `${scan.cursor} of ${capacity} seats read (the ledger held ${scan.capacity} when it began)`;

run(async (on) => {
  if (on.profile !== "mainnet") {
    throw new Error(
      "Only the mainnet profile's exchange is migrated from here. Nothing was sent.",
    );
  }
  const request = layoutRequest(process.env);
  await deployedAsBuilt(on);
  await rollupIsRunBy(on);
  let exchange = await exchangeInRollup(on);
  const refusal = layoutRefusal(exchange);
  if (refusal) throw new Error(refusal);

  shown("network", `${on.network}, program ${on.instructions.programId}`);
  if (exchange.layoutState === "live") {
    shown("layout", "active. Nothing to do.");
    return;
  }
  const capacity = exchange.seatCapacity;
  if (capacity === null) {
    throw new Error("The exchange has no seat capacity. Nothing was sent.");
  }
  let scan = await scanNow(on);
  shown("layout", "not active yet (the earlier build's seats)");
  shown("scan", scanText(scan, capacity));
  shown("exchange", "paused");
  const remaining = capacity - (scan?.cursor ?? 0);
  shown(
    "plan",
    remaining > 0
      ? `scan ${remaining} more seats, ${request.seatsPerCall} to a call${request.activate ? ", then activate" : ""}`
      : request.activate
        ? "activate"
        : "the scan is complete; activate with ACTIVATE=yes",
  );
  if (!request.apply) {
    console.log(DRY_RUN_LINE);
    return;
  }

  const admin = adminSigner(on, exchange.admin);
  const connection = await sendingAs(on, admin);
  await scanLedger({
    cursor: scan?.cursor ?? 0,
    capacity,
    perCall: request.seatsPerCall,
    send: async (count) => {
      await send(
        connection,
        withFullBudget(on.instructions.scanSeatLayout(admin.publicKey, count)),
        admin,
      );
    },
    read: async (after) => {
      scan = await until(async () => {
        const now = await scanNow(on);
        return now && now.cursor > after ? now : null;
      }, `the scan to read past seat ${after}`);
      shown("scan", scanText(scan, capacity));
      return scan.cursor;
    },
    say: (line) => shown("scan", line),
  });

  if (!request.activate) {
    shown(
      "scan",
      "complete. Activate with APPLY=yes ACTIVATE=yes once everything before it in the runbook is done.",
    );
    return;
  }
  exchange = await exchangeInRollup(on);
  const why = activationRefusal(exchange, scan);
  if (why) {
    throw new Error(`The layout is not activated: ${why}. Nothing was sent.`);
  }
  shown(
    "activate_layout",
    await send(
      connection,
      on.instructions.activateLayout(admin.publicKey),
      admin,
    ),
  );
  await until(
    async () => (await exchangeInRollup(on)).layoutState === "live",
    "the exchange to read back the active layout",
  );
  shown("layout", "active");
});

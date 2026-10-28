/**
 * Moves an exchange built with the old seat layout onto the current one, as
 * its admin: `migrate_exchange`, the new ledger, the copy of every seat at the
 * same index and the check that closes it (`relayoutLedger`), then, when
 * `LEDGER_SEATS` names a larger number, `extend_ledger` up to it.
 *
 *   LEDGER_SEATS=<seats>   grow the ledger to this many seats after the copy
 *
 * The exchange must be paused first: the copy needs trading stopped. The run
 * can be repeated; it picks up where the exchange says it stopped, and says
 * so when there is nothing left to do. The old ledger is never written, so
 * until the copy finishes the previous program build can be put back.
 *
 * On mainnet the admin is the console, not a key on this machine: this runs on
 * the local network, devnet and the rehearsal only.
 *
 * The Makefile is the way in (`make local-relayout`, `make devnet-relayout`,
 * `make rehearsal-relayout`).
 */
import { extendLedgerTo, relayoutLedger } from "../sdk/dist/index.js";
import {
  adminKeyPath,
  rollupIsRunBy,
  run,
  sendingAs,
  type Target,
} from "./deployment";
import { heldKey } from "./keys";
import { shown } from "./leaving";
import { exchangeInRollup } from "./market";
import { deployedAsBuilt } from "./program";
import { positiveInteger, relayoutRefusal } from "./upkeep";

async function relayout(on: Target): Promise<void> {
  const exchange = await exchangeInRollup(on);
  const refusal = relayoutRefusal(exchange, on.mainnet);
  if (refusal) throw new Error(refusal);
  const wanted = process.env.LEDGER_SEATS
    ? positiveInteger("LEDGER_SEATS", process.env.LEDGER_SEATS, null)
    : null;
  const admin = heldKey(adminKeyPath(on));
  if (!exchange.admin.equals(admin.publicKey)) {
    throw new Error(
      `The exchange's admin is ${exchange.admin.toBase58()}, not ${admin.publicKey.toBase58()}. Nothing was sent.`,
    );
  }
  if (on.profile === "mainnet") await deployedAsBuilt(on);
  await rollupIsRunBy(on);

  const connection = await sendingAs(on, admin);
  const { programId } = on.instructions;
  shown("network", `${on.network}, ${on.profile} profile`);
  shown("layout", exchange.layoutState);
  const after = await relayoutLedger(connection, admin, programId, (line) =>
    shown("step", line),
  );
  if (wanted !== null) {
    const capacity = await extendLedgerTo(
      connection,
      admin,
      wanted,
      programId,
      (line) => shown("step", line),
    );
    shown("seat capacity", `${capacity}`);
    return;
  }
  shown("seat capacity", `${after.seatCapacity}`);
}

run(relayout);

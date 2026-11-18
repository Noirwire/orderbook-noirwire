/**
 * Pauses or unpauses the exchange with `set_paused`:
 *
 *   PAUSED=yes|no [APPLY=yes]
 *
 * While the exchange is paused no order is placed, no funding advances and no
 * liquidation runs; cancels and withdrawals stay open. It shows the change and
 * sends nothing unless APPLY=yes. Unpausing runs the mark check first, the one
 * `make mainnet-markcheck` prints, and refuses with the reason when it says a
 * resume is not safe, in a dry run as well.
 *
 * `RUNNING_BUILD=<the program file mainnet runs>` (pausing only) checks the
 * deployed program against that file instead of this checkout's build, for the
 * pause before an upgrade: `set_paused` is the same in both builds. Unpausing
 * is refused with it.
 *
 * The Makefile is the way in (`make rehearsal-pause`, `make mainnet-pause`).
 */
import { rollupIsRunBy, run, sendingAs } from "./deployment";
import {
  DRY_RUN_LINE,
  adminSigner,
  pauseRefusal,
  pauseRequest,
} from "./administering";
import { shown } from "./leaving";
import { resumeRefusal } from "./markchecking";
import { exchangeInRollup } from "./market";
import { deployedAsBuilt } from "./program";
import { send, until } from "./sending";

run(async (on) => {
  if (on.profile !== "mainnet") {
    throw new Error(
      "Only the mainnet profile's exchange is paused from here. Nothing was sent.",
    );
  }
  const request = pauseRequest(process.env);
  await deployedAsBuilt(on, request.runningBuild ?? undefined);
  await rollupIsRunBy(on);
  const exchange = await exchangeInRollup(on);
  const refusal = pauseRefusal(exchange.paused, request.paused);
  if (refusal) throw new Error(refusal);

  shown("network", `${on.network}, program ${on.instructions.programId}`);
  if (request.runningBuild) {
    shown("program", `mainnet runs ${request.runningBuild}, not this build`);
  }
  shown(
    "exchange",
    `${exchange.paused ? "paused" : "not paused"} -> ${request.paused ? "paused" : "not paused"}`,
  );
  if (!request.paused) {
    const why = await resumeRefusal(on);
    if (why) {
      throw new Error(
        `The exchange is not unpaused: ${why}. Nothing was sent.`,
      );
    }
    shown("mark check", "a resume is safe by these checks");
  }
  if (!request.apply) {
    console.log(DRY_RUN_LINE);
    return;
  }

  const admin = adminSigner(on, exchange.admin);
  shown(
    "signature",
    await send(
      await sendingAs(on, admin),
      on.instructions.setPaused(admin.publicKey, request.paused),
      admin,
    ),
  );
  await until(
    async () => (await exchangeInRollup(on)).paused === request.paused,
    `the exchange to read back ${request.paused ? "paused" : "not paused"}`,
  );
  shown("exchange", request.paused ? "paused" : "not paused");
});

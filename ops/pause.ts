/**
 * Pauses or unpauses the exchange with `set_paused`:
 *
 *   PAUSED=yes|no [APPLY=yes]
 *
 * While the exchange is paused no order is placed, no funding advances and no
 * liquidation runs; cancels and withdrawals stay open. It shows the change and
 * sends nothing unless APPLY=yes. Unpausing does not look at the mark: run the
 * mark check first (`make mainnet-markcheck`).
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
  await deployedAsBuilt(on);
  await rollupIsRunBy(on);
  const exchange = await exchangeInRollup(on);
  const refusal = pauseRefusal(exchange.paused, request.paused);
  if (refusal) throw new Error(refusal);

  shown("network", `${on.network}, program ${on.instructions.programId}`);
  shown(
    "exchange",
    `${exchange.paused ? "paused" : "not paused"} -> ${request.paused ? "paused" : "not paused"}`,
  );
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
  if (!request.paused) {
    console.log(
      "Unpaused. If the price moved while it was paused, run make mainnet-markcheck before you let the maker quote.",
    );
  }
});

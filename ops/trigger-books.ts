/**
 * Creates, grows and finalises the trigger book of every perp market the
 * exchange has that does not have a ready one:
 *
 *   [APPLY=yes]                         set up each market's trigger book that
 *                                       is missing, partly grown or not
 *                                       finalised, and none that is ready
 *
 * A market set up by an earlier build has no trigger book, and every
 * order-key instruction of this build names it, so each perp market needs one
 * after the program upgrade and before trading resumes. A book is sized once,
 * from the ledger's seat capacity as it stands, and is never resized: extend
 * the ledger to its target first.
 *
 * The book is sealed, so it cannot be read. Where each one stands is found by
 * simulating `finalize_trigger_book` as the admin, which needs the admin key
 * in a dry run too, and the program's refusal says whether the book is
 * missing, partly grown, full size or ready. A ready book's size cannot be
 * checked from here: the program sized it when it was finalised.
 *
 * It shows that plan and sends nothing unless APPLY=yes. With it, each market
 * that is not ready is set up, then every one is read again, and the command
 * fails if any is still not ready. A second run with everything ready sends
 * nothing.
 *
 * Then: run the crank, which fires triggers, and the keeper, which sweeps
 * them, check the mark with the mark check, resume the market. The Makefile
 * is the way in (`make rehearsal-trigger-books`,
 * `make mainnet-trigger-books`). Once the admin role has moved to a hardware
 * wallet this command cannot run.
 */
import {
  MARKET_KIND,
  liveSeatCapacity,
  setupTriggerBook,
  triggerAccountLen,
} from "../sdk/dist/index.js";
import { rollupIsRunBy, run, sendingAs } from "./deployment";
import { adminSigner } from "./administering";
import { shown } from "./leaving";
import { exchangeInRollup, perpMarketIds } from "./market";
import { deployedAsBuilt } from "./program";
import { simulatedError } from "./sending";
import {
  runTriggerBooks,
  triggerBookRequest,
  triggerBookStateOf,
} from "./triggerbooks";

run(async (on) => {
  if (on.profile !== "mainnet") {
    throw new Error(
      "Only the mainnet profile's markets have their trigger books set up from here. Nothing was sent.",
    );
  }
  const request = triggerBookRequest(process.env);
  await deployedAsBuilt(on);
  await rollupIsRunBy(on);
  const exchange = await exchangeInRollup(on);
  const seats = liveSeatCapacity(exchange);
  const admin = adminSigner(on, exchange.admin);
  const connection = await sendingAs(on, admin);

  shown("network", `${on.network}, program ${on.instructions.programId}`);
  shown(
    "ledger",
    `${seats} seats, so a perp market's trigger book is ${triggerAccountLen(seats)} bytes`,
  );

  const sent = await runTriggerBooks({
    marketIds: await perpMarketIds(on),
    apply: request.apply,
    say: shown,
    stateOf: async (marketId) => {
      const refusal = await simulatedError(
        connection,
        [on.instructions.finalizeTriggerBook(admin.publicKey, marketId)],
        admin,
      ).catch((failed: Error) => {
        throw new Error(
          `The endpoint did not simulate finalize_trigger_book for market ${marketId} (${failed.message.split("\n")[0]}). Nothing was sent.`,
        );
      });
      return triggerBookStateOf(refusal, marketId);
    },
    setUp: (marketId) =>
      setupTriggerBook(
        connection,
        admin,
        marketId,
        MARKET_KIND.perp,
        on.instructions.programId,
      ),
  });
  if (sent.length > 0) {
    console.log(
      "Set up. Run the crank and the keeper, check the mark with the mark check, then resume the market.",
    );
  }
});

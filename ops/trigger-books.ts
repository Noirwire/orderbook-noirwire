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
 * after the program upgrade and before trading resumes. A perp market's book
 * is always sized for the most seats a ledger can hold (`PERP_TRIGGER_BOOK_LEN`
 * bytes), whatever the ledger holds now and in whatever order the ledger is
 * extended, so this runs at any point and needs no other step first. It runs
 * before the layout is activated as well as after.
 *
 * The book is sealed, so it cannot be read. Where each one stands is found by
 * simulating `finalize_trigger_book` as the admin, which needs the admin key
 * in a dry run too, and the program's refusal says whether the book is
 * missing, partly grown, full size or ready. Once the layout is active, a
 * ready book is also checked by simulating `sweep_triggers` on it: the program
 * opens a book only at its current version, with the capacity and the exact
 * length the maximum ledger needs, and refuses any other, so a book an earlier
 * candidate left at the address stops the run instead of being read as ready.
 * Before activation that check cannot run (the program refuses the sweep
 * until the layout is active), and the command says so.
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
  MAX_SEATS,
  PERP_TRIGGER_BOOK_LEN,
  setupTriggerBook,
} from "../sdk/dist/index.js";
import type { TransactionInstruction } from "@solana/web3.js";
import { rollupIsRunBy, run, sendingAs } from "./deployment";
import { adminSigner } from "./administering";
import { shown } from "./leaving";
import { exchangeInRollup, perpMarketIds } from "./market";
import { deployedAsBuilt } from "./program";
import { simulatedError } from "./sending";
import {
  ownerRefused,
  readyBookVerdict,
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
  if (exchange.layoutState === "unmigrated") {
    throw new Error(
      "The exchange does not have a layout this build runs. Nothing was sent.",
    );
  }
  const admin = adminSigner(on, exchange.admin);
  const connection = await sendingAs(on, admin);
  const active = exchange.layoutState === "live";

  shown("network", `${on.network}, program ${on.instructions.programId}`);
  shown(
    "layout",
    active
      ? "active"
      : "not yet active: a ready book's version and size cannot be checked until it is",
  );
  shown(
    "trigger book",
    `a perp market's is ${PERP_TRIGGER_BOOK_LEN} bytes for ${MAX_SEATS} seats, whatever the ledger holds`,
  );

  const sent = await runTriggerBooks({
    marketIds: await perpMarketIds(on),
    apply: request.apply,
    say: shown,
    stateOf: async (marketId) => {
      const simulated = (what: string, instruction: TransactionInstruction) =>
        simulatedError(connection, [instruction], admin).catch(
          (failed: Error) => {
            throw new Error(
              `The endpoint did not simulate ${what} for market ${marketId} (${failed.message.split("\n")[0]}). Nothing was sent.`,
            );
          },
        );
      const finalizeRefusal = await simulated(
        "finalize_trigger_book",
        on.instructions.finalizeTriggerBook(admin.publicKey, marketId),
      );
      const state = triggerBookStateOf(
        finalizeRefusal,
        marketId,
        ownerRefused(finalizeRefusal)
          ? await simulated(
              "create_trigger_book",
              on.instructions.createTriggerBook(admin.publicKey, marketId),
            )
          : undefined,
      );
      if (state === "ready" && active) {
        const verdict = readyBookVerdict(
          await simulated(
            "sweep_triggers",
            on.instructions.sweepTriggers(marketId, 1),
          ),
          marketId,
        );
        if (verdict === "refused") {
          throw new Error(
            `Market ${marketId}'s trigger book is ready, but the program refuses to open it: it is not the current version, not sized for ${MAX_SEATS} seats or not exactly ${PERP_TRIGGER_BOOK_LEN} bytes. It cannot be replaced from here. Nothing was sent.`,
          );
        }
      }
      return state;
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

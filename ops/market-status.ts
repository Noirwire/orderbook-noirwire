/**
 * Sets SOL-PERP's status:
 *
 *   STATUS=paused|reduce-only|active [APPLY=yes]
 *
 * `paused` and `reduce-only` send `restrict_market`. `active` sends
 * `resume_market`, and only when the mark check says a resume is safe now (the
 * same check `make mainnet-markcheck` prints): it prints every line of it, and
 * refuses with the reason when the verdict is no, in a dry run as well. It
 * shows the change and sends nothing unless APPLY=yes.
 *
 * `RUNNING_BUILD=<the program file mainnet runs>` (paused and reduce-only
 * only) checks the deployed program against that file instead of this
 * checkout's build, for the pause before an upgrade: these instructions are
 * the same in both builds. A resume is refused with it.
 *
 * The Makefile is the way in (`make rehearsal-market-status`,
 * `make mainnet-market-status`).
 */
import { decodeMarket, MARKET_STATUS } from "../sdk/dist/index.js";
import {
  MAINNET_MARKET,
  rollupIsRunBy,
  run,
  sendingAs,
  type Target,
} from "./deployment";
import {
  DRY_RUN_LINE,
  adminSigner,
  statusCode,
  statusRefusal,
  statusRequest,
} from "./administering";
import { shown } from "./leaving";
import { resumeRefusal } from "./markchecking";
import { exchangeInRollup, perpMarketIds } from "./market";
import { deployedAsBuilt } from "./program";
import { send, until } from "./sending";
import { nameIn } from "./upkeep";

async function statusNow(on: Target): Promise<number> {
  const account = await on.rollup.getAccountInfo(
    on.instructions.addresses.market(MAINNET_MARKET.id),
  );
  if (!account) throw new Error(`${MAINNET_MARKET.symbol} is not set up.`);
  return decodeMarket(account.data).params.status;
}

run(async (on) => {
  if (on.profile !== "mainnet") {
    throw new Error(
      "Only the mainnet profile's market has its status set from here. Nothing was sent.",
    );
  }
  const request = statusRequest(process.env);
  await deployedAsBuilt(on, request.runningBuild ?? undefined);
  await rollupIsRunBy(on);
  const { id, symbol } = MAINNET_MARKET;
  const current = await statusNow(on);
  const refusal = statusRefusal(current, request.status);
  if (refusal) throw new Error(refusal);

  shown("network", `${on.network}, program ${on.instructions.programId}`);
  if (request.runningBuild) {
    shown("program", `mainnet runs ${request.runningBuild}, not this build`);
  }
  shown(
    `${symbol} status`,
    `${nameIn(MARKET_STATUS, current)} -> ${nameIn(MARKET_STATUS, statusCode(request.status))}`,
  );
  if (request.status === "active") {
    const why = await resumeRefusal(on);
    if (why) {
      throw new Error(`${symbol} is not resumed: ${why}. Nothing was sent.`);
    }
    shown("mark check", "a resume is safe by these checks");
  }
  if (!request.apply) {
    console.log(DRY_RUN_LINE);
    return;
  }

  const admin = adminSigner(on, (await exchangeInRollup(on)).admin);
  const instruction =
    request.status === "active"
      ? on.instructions.resumeMarket(
          admin.publicKey,
          id,
          await perpMarketIds(on),
        )
      : on.instructions.restrictMarket(
          admin.publicKey,
          id,
          statusCode(request.status),
        );
  shown(
    "signature",
    await send(await sendingAs(on, admin), instruction, admin),
  );
  await until(
    async () => (await statusNow(on)) === statusCode(request.status),
    `${symbol} to read back ${request.status}`,
  );
  shown(`${symbol} status`, request.status);
});

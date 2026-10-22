/**
 * Changes the launch market's two caps with `update_market`:
 *
 *   OPEN_INTEREST_CAP=<lots> POSITION_CAP=<lots> [APPLY=yes]
 *
 * It shows the change and sends nothing unless APPLY=yes. The caps can be
 * lowered or kept, and raised back only as far as the launch's own figures and
 * what insurance covers at the live mark; every other limit is written back as
 * the market has it. It stops unless the market is the one the launch sets up.
 *
 * The Makefile is the way in (`make rehearsal-update-market`,
 * `make mainnet-update-market`). Once the admin role has moved to a hardware
 * wallet this command cannot send as it.
 */
import { clockOf, decodeMarket } from "../sdk/dist/index.js";
import {
  adminKeyPath,
  launchMarket,
  rollupIsRunBy,
  run,
  sendingAs,
} from "./deployment";
import { adminRefusal } from "./handover";
import { heldKey } from "./keys";
import { limitsChange, limitsRequest } from "./limits";
import { exchangeInRollup, launchedMarket, lotsCovered } from "./market";
import { deployedAsBuilt } from "./program";
import { send, until } from "./sending";

const shown = (label: string, value: string) =>
  console.log(`${label.padEnd(20)}${value}`);

run(async (on) => {
  if (on.profile !== "mainnet") {
    throw new Error(
      "Only the mainnet profile's market has launch caps to keep to. Nothing was sent.",
    );
  }
  const request = limitsRequest(process.env);
  await deployedAsBuilt(on);
  await rollupIsRunBy(on);
  const { id, symbol, settings } = launchMarket(on.insurance);
  const { params, feed } = await launchedMarket(on);
  const launch = settings.limits;
  if (launch.openInterestCap === undefined) {
    throw new Error("The launch sets no open interest cap. Nothing was sent.");
  }
  const covered = lotsCovered(on, feed.price, params);
  const change = limitsChange(
    params,
    {
      openInterestCap: launch.openInterestCap,
      positionCap: launch.positionCap,
    },
    covered,
    request,
  );

  shown("network", `${on.network}, program ${on.instructions.programId}`);
  shown(
    "mark",
    `${feed.price} quote atoms per lot, ${(await clockOf(on.rollup)) - Number(feed.publishTime)} s old`,
  );
  shown("insurance covers", `${covered} lots at this mark`);
  shown(
    `${symbol} open interest`,
    `${params.openInterestCap} -> ${change.openInterestCap} lots (launch ${launch.openInterestCap})`,
  );
  shown(
    `${symbol} position cap`,
    `${params.positionCap} -> ${change.positionCap} lots (launch ${launch.positionCap})`,
  );
  if (!request.apply) {
    console.log(
      "Dry run: nothing was sent. Run again with APPLY=yes to send it.",
    );
    return;
  }

  const keyFile = adminKeyPath(on);
  const admin = heldKey(keyFile);
  const wrongAdmin = adminRefusal(
    (await exchangeInRollup(on)).admin,
    admin.publicKey,
    keyFile,
  );
  if (wrongAdmin) throw new Error(wrongAdmin);
  shown(
    "signature",
    await send(
      await sendingAs(on, admin),
      on.instructions.updateMarket(admin.publicKey, id, change.limits),
      admin,
    ),
  );
  const read = await until(async () => {
    const account = await on.rollup.getAccountInfo(
      on.instructions.addresses.market(id),
    );
    const now = account && decodeMarket(account.data).params;
    return now &&
      now.openInterestCap === change.openInterestCap &&
      now.positionCap === change.positionCap
      ? now
      : null;
  }, `${symbol} to read back with the new caps`);
  shown(
    symbol,
    `open interest cap ${read.openInterestCap} lots, position cap ${read.positionCap} lots`,
  );
});

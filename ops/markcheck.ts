/**
 * The mark check, on its own: it reads, prints and refuses nothing, and needs
 * no admin key, so it works after the admin role went to a hardware wallet,
 * when a resume is given from the console and setup cannot run.
 *
 * It prints the market's status, the mark beside the median of the public
 * exchanges' prices (and Pyth Pro's, given a token), what insurance covers at
 * that mark against the open interest cap, who the upgrade authority is, and
 * the liquidation keeper's seat, funding and liveness (it watches the keeper's
 * view for a write, as long as a running keeper can go between two: give it
 * the keeper's `KEEPER_EVERY`). Then it says plainly whether a resume is safe
 * by what it read. It decides nothing and sends nothing.
 *
 * `INSURANCE_HELD` (whole USDC, read from the console) can only lower the
 * insurance the cover is sized from. The keeper's key must be on this machine
 * (`<network>-keeper.json`) to read its seat; without it the answer is that
 * the keeper cannot be confirmed, which is a no.
 *
 * The Makefile is the way in (`make rehearsal-markcheck`,
 * `make mainnet-markcheck`).
 */
import { existsSync } from "fs";
import { MARKET_STATUS } from "../sdk/dist/index.js";
import {
  RESUME_GAP_BPS,
  type ResumeCheck,
} from "../sdk/dist/operator/index.js";
import {
  errorLine,
  existingKey,
  keyPath,
  readDeployment,
  rollupIsRunBy,
  run,
  type Target,
} from "./deployment";
import { insuranceNow, keeperWatched } from "./keeping";
import { gapBps, markcheckSays, type MarkcheckFound } from "./launch";
import { shown } from "./leaving";
import { checkedMark, exchangeInRollup, launchedMarket } from "./market";
import { deployedAsBuilt } from "./program";
import { nameIn } from "./upkeep";

/** Why the keeper cannot be confirmed here, and what it holds as its view last showed. */
async function keeperChecked(
  on: Target,
  deposited: boolean,
): Promise<{ why: string | null; collateral: bigint | null }> {
  const path = keyPath(on, "keeper");
  if (!existsSync(path)) {
    return {
      why: `the keeper's key is not on this machine (${path}), so its seat and its liveness cannot be read here: read the keeper's log for a sweep every KEEPER_EVERY seconds with no ALERT, and look at its collateral`,
      collateral: null,
    };
  }
  return keeperWatched(on, existingKey(on, "keeper"), deposited, true);
}

/** The checks a resume rests on, as they stand now. */
async function checked(on: Target): Promise<ResumeCheck> {
  const description = readDeployment(on.deploymentPath);
  const recorded =
    description?.programId === on.instructions.programId.toBase58()
      ? description.keeperDeposited
      : undefined;
  const { params } = await launchedMarket(on);
  const status = nameIn(MARKET_STATUS, params.status);
  const insurance = await insuranceNow(on, BigInt(recorded ?? "0"));
  const { mark, reference, covered, openInterestCap } = await checkedMark(
    on,
    insurance,
  );
  const exchange = await exchangeInRollup(on);
  const { upgradeAuthority } = await deployedAsBuilt(on);
  const adminUpgrades = upgradeAuthority?.equals(exchange.admin) ?? false;
  shown("market", `SOL-PERP status ${status}`);
  shown("mark", `${mark} quote atoms per lot`);
  shown(
    "reference",
    mark > 0n
      ? `${reference} (median of the reference sources), ${gapBps(mark, reference)} bps apart, a resume needs at most ${RESUME_GAP_BPS}`
      : `${reference} (median of the reference sources); the market has no mark`,
  );
  shown(
    "insurance",
    `${insurance} atoms the cover is sized from, of ${on.insurance} funded`,
  );
  shown(
    "cover",
    `${covered} lots at this mark, against an open interest cap of ${openInterestCap}`,
  );
  shown(
    "upgrade authority",
    `${upgradeAuthority?.toBase58() ?? "none"}${adminUpgrades ? ", the admin: a resume is refused on mainnet" : ""}`,
  );
  const keeper = await keeperChecked(on, recorded !== undefined);
  shown(
    "keeper",
    `${keeper.collateral === null ? "no seat read" : `${keeper.collateral} atoms collateral as its view last showed`}; ${recorded === undefined ? "no deposit recorded" : `${recorded} atoms recorded deposited`}; ${keeper.why === null ? "funded and running" : "NOT confirmed"}`,
  );
  return {
    mark,
    reference,
    confirmed: true,
    covered,
    openInterestCap,
    adminUpgrades: adminUpgrades && on.mainnet,
    keeperWhy: keeper.why,
  };
}

run(async (on) => {
  if (on.profile !== "mainnet") {
    throw new Error(
      "The mark check is for the mainnet profile's market only. Nothing was read.",
    );
  }
  shown("network", `${on.network}, program ${on.instructions.programId}`);
  await rollupIsRunBy(on);
  let found: MarkcheckFound;
  try {
    found = { check: await checked(on) };
  } catch (error) {
    found = { unreadable: errorLine(error) };
  }
  shown("verdict", markcheckSays(found));
});

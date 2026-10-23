/**
 * The mark check's work, apart from the process that runs it so a test can run
 * it against a connection that refuses to sign or send: it only reads. The
 * command (`ops/markcheck.ts`) says what it prints and when a resume is safe.
 */
import { existsSync } from "fs";
import {
  MARKET_STATUS,
  ORACLE_HEALTH,
  QUOTE_STATE,
} from "../sdk/dist/index.js";
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
  type Target,
} from "./deployment";
import { insuranceNow, keeperWatched } from "./keeping";
import {
  gapBps,
  keeperDepositFor,
  keeperFloorRefusal,
  markcheckSays,
  type MarkcheckFound,
} from "./launch";
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

/** What the deployment records of the keeper's deposit, or plainly that it records none. */
function keeperDepositLine(
  recorded: string | undefined,
  collateral: bigint | null,
): string {
  if (recorded !== undefined) return `${recorded} atoms recorded deposited`;
  return collateral !== null && collateral > 0n
    ? `no deposit record (funded before records existed); collateral ${collateral} read from the keeper's view`
    : "no deposit record";
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
  const keeper = await keeperChecked(on, recorded !== undefined);
  const shownKeeper = (why: string | null) =>
    shown(
      "keeper",
      `${keeper.collateral === null ? "no seat read" : `${keeper.collateral} atoms collateral as its view last showed`}; ${keeperDepositLine(recorded, keeper.collateral)}; ${why === null ? "funded and running" : "NOT confirmed"}`,
    );
  let insurance: bigint;
  try {
    insurance = await insuranceNow(
      on,
      keeperDepositFor(recorded, keeper.collateral),
    );
  } catch (error) {
    shown("market", `SOL-PERP status ${status}`);
    shownKeeper(keeper.why);
    throw error;
  }
  const observed = await checkedMark(on, insurance);
  const { mark, reference, covered, openInterestCap } = observed;
  const { markAge, maxPriceAge, positionCap, imBps } = observed;
  const keeperWhy =
    keeper.why ??
    keeperFloorRefusal({
      collateral: keeper.collateral,
      positionCap,
      mark,
      imBps,
    });
  const exchange = await exchangeInRollup(on);
  const { upgradeAuthority } = await deployedAsBuilt(on);
  const adminUpgrades = upgradeAuthority?.equals(exchange.admin) ?? false;
  shown("market", `SOL-PERP status ${status}`);
  shown(
    "mark",
    `${mark} quote atoms per lot, ${markAge} s old, the market accepts ${maxPriceAge} s${markAge > maxPriceAge ? ": TOO OLD" : ""}`,
  );
  shown(
    "USDC guard",
    `${observed.guardPasses ? "passing" : "NOT passing"}, state ${nameIn(QUOTE_STATE, observed.guardState)}`,
  );
  shown(
    "market health",
    `${nameIn(ORACLE_HEALTH, observed.health)}${observed.marketHealthy ? "" : ": NOT healthy"}`,
  );
  shown(
    "shortfall",
    observed.shortfalls.length === 0
      ? "none recorded on any perp market"
      : observed.shortfalls
          .map(({ id, shortfall }) => `market ${id}: ${shortfall} atoms`)
          .join(", "),
  );
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
  shownKeeper(keeperWhy);
  return {
    mark,
    reference,
    confirmed: true,
    covered,
    openInterestCap,
    markAge,
    maxPriceAge,
    guardPasses: observed.guardPasses,
    marketHealthy: observed.marketHealthy,
    shortfall: observed.shortfall,
    adminUpgrades: adminUpgrades && on.mainnet,
    keeperWhy,
  };
}

/** The mark check on `on`: what it read, and the verdict line, which is the last thing it prints. */
export async function markchecked(on: Target): Promise<void> {
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
}

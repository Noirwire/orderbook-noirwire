/**
 * Adds the BTC perpetual to a mainnet-profile deployment that runs on a test
 * network, beside the SOL perpetual the launch set up. It creates and binds
 * the market (its price source is part of `create_market`), takes its first
 * mark, schedules its funding, records it in the deployment description, and
 * opens it once the same checks the launch's resume makes pass. Running it
 * twice is safe: whatever exists is left as it is. The pure decisions are
 * exported so a test can check them apart from a network.
 *
 * `ops/add-btc-market.ts` is the command; the Makefile is the way in.
 */
import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import {
  MARKET_KIND,
  MARKET_STATUS,
  decodeMarket,
  pythPriceAccount,
  setupMarket,
} from "../sdk/dist/index.js";
import {
  BTC_MARKET,
  FUNDING_INTERVAL_SECONDS,
  MAINNET_MARKET,
  QUOTE_DECIMALS,
  adminKeyPath,
  btcMarket,
  existingKey,
  readDeployment,
  rollupIsRunBy,
  sendingAs,
  type DeploymentDescription,
  type Target,
} from "./deployment";
import { heldKey } from "./keys";
import { insuranceNow, keeperWatched } from "./keeping";
import { keeperFloorRefusal, resumeVerdict } from "./launch";
import {
  BTC_PERP,
  checkedMark,
  launchedMarket,
  perpMarketIds,
  priceFeedInRollup,
} from "./market";
import { deployedAsBuilt } from "./program";
import { send } from "./sending";

type MarketDescription = DeploymentDescription["markets"][number];

const FIRST_FUNDING_TASK_ID = 1_000;
/** The scheduler takes a count of runs; this many outlast any test network. */
const FUNDING_RUNS = 1_000_000_000n;

/** The task a market's funding is scheduled under: the launch's numbering, by market id. */
export const fundingTaskIdFor = (marketId: number) =>
  FIRST_FUNDING_TASK_ID + marketId;

/**
 * Why a market may not be added to this deployment, or null. Only a
 * mainnet-profile deployment on a test network takes one, and only after the
 * launch it adds to recorded its insurance and the launch market's funding.
 */
export function addRefusal(
  on: Pick<Target, "mainnet" | "profile" | "network">,
  description: DeploymentDescription | null,
  programId: string,
): string | null {
  if (on.mainnet) {
    return "This adds a market to a test network's deployment only, and the Solana behind SOLANA_URL is mainnet. Nothing was sent.";
  }
  if (on.profile !== "mainnet") {
    return "This adds a market to the mainnet profile's deployment only; the test profile already has its markets. Nothing was sent.";
  }
  if (description === null || description.programId !== programId) {
    return `There is no deployment description of program ${programId} for ${on.network}: run setup first. Nothing was sent.`;
  }
  if (description.insuranceFunded === undefined) {
    return "The deployment records no insurance funded, and the new market's caps are sized from it: finish the launch first. Nothing was sent.";
  }
  const launched = description.markets.find(
    ({ id }) => id === MAINNET_MARKET.id,
  );
  if (launched?.fundingTaskId === undefined) {
    return `The launch market ${MAINNET_MARKET.symbol} has no scheduled funding recorded: finish the launch first. Nothing was sent.`;
  }
  return null;
}

/** A market as the description records it. */
export function describedMarket(
  on: Pick<Target, "instructions">,
  market: { id: number; symbol: string; baseDecimals: number },
  settings: { kind: number; baseLot: bigint; tick: bigint },
  fundingTaskId: number | undefined,
): MarketDescription {
  const { addresses } = on.instructions;
  const { id } = market;
  return {
    id,
    symbol: market.symbol,
    kind: settings.kind === MARKET_KIND.perp ? "perp" : "spot",
    baseDecimals: market.baseDecimals,
    quoteDecimals: QUOTE_DECIMALS,
    baseLot: settings.baseLot.toString(),
    tick: settings.tick.toString(),
    market: addresses.market(id).toBase58(),
    book: addresses.book(id).toBase58(),
    tape: addresses.tape(id).toBase58(),
    priceFeed: addresses.priceFeed(id).toBase58(),
    ...(fundingTaskId === undefined ? {} : { fundingTaskId }),
  };
}

/** The description with `market` recorded: replaced if its id is there, appended otherwise, the others untouched, in id order. */
export function withMarket(
  description: DeploymentDescription,
  market: MarketDescription,
): DeploymentDescription {
  return {
    ...description,
    markets: [
      ...description.markets.filter(({ id }) => id !== market.id),
      market,
    ].sort((a, b) => a.id - b.id),
  };
}

function recorded(on: Target, description: DeploymentDescription): void {
  mkdirSync(dirname(on.deploymentPath), { recursive: true });
  writeFileSync(on.deploymentPath, `${JSON.stringify(description, null, 2)}\n`);
}

/** Adds the BTC market to `on`'s deployment, and opens it when `RESUME_MARKET=yes` and the resume checks pass. */
export async function btcMarketAdded(on: Target): Promise<void> {
  const programId = on.instructions.programId.toBase58();
  const refused = addRefusal(on, readDeployment(on.deploymentPath), programId);
  if (refused) throw new Error(refused);
  await deployedAsBuilt(on);
  await rollupIsRunBy(on);
  const description = readDeployment(on.deploymentPath)!;
  const { id, symbol, settings } = btcMarket(on.insurance);
  const admin = heldKey(adminKeyPath(on));
  const connection = await sendingAs(on, admin);
  await setupMarket(connection, admin, id, settings, on.instructions.programId);
  await launchedMarket(on, BTC_PERP);
  console.error(`${symbol} exists with the settings it is added with`);

  if (((await priceFeedInRollup(on, id))?.price ?? 0n) === 0n) {
    await send(
      connection,
      on.instructions.syncPrice(
        id,
        pythPriceAccount(settings.priceSource.feedId),
      ),
      admin,
    ).catch((error: Error) => {
      throw new Error(
        `The first sync_price was refused: ${error.message}\nThe BTC/USD account may be older than the market's max age. ` +
          "Run the crank (with CRANK_PUSH=1 where the network's own updates are too slow) and run this again.",
      );
    });
  }

  const known = description.markets.find((market) => market.id === id);
  let fundingTaskId = known?.fundingTaskId;
  if (fundingTaskId === undefined) {
    fundingTaskId = fundingTaskIdFor(id);
    await send(
      connection,
      on.instructions.scheduleFunding(
        admin.publicKey,
        id,
        BigInt(fundingTaskId),
        FUNDING_INTERVAL_SECONDS * 1_000n,
        FUNDING_RUNS,
      ),
      admin,
    );
  }
  recorded(
    on,
    withMarket(
      description,
      describedMarket(on, BTC_MARKET, settings, fundingTaskId),
    ),
  );
  console.error(`${symbol} recorded in ${on.deploymentPath}`);

  await opened(on, description, admin);
}

/** Opens the market under the launch's own rules for a resume, or says why it stays reduce-only. */
async function opened(
  on: Target,
  description: DeploymentDescription,
  admin: ReturnType<typeof heldKey>,
): Promise<void> {
  const { id, symbol } = BTC_MARKET;
  const market = await on.rollup.getAccountInfo(
    on.instructions.addresses.market(id),
  );
  if (
    market !== null &&
    decodeMarket(market.data).params.status === MARKET_STATUS.active
  ) {
    console.error(`${symbol} is open already.`);
    return;
  }
  const confirmed = process.env.RESUME_MARKET === "yes";
  const deposited = BigInt(description.keeperDeposited ?? "0");
  const insurance = await insuranceNow(on, deposited);
  const keeper = await keeperWatched(
    on,
    existingKey(on, "keeper"),
    description.keeperDeposited !== undefined,
    confirmed,
  );
  const checked = await checkedMark(on, insurance, BTC_PERP);
  const keeperWhy =
    keeper.why ??
    (confirmed
      ? keeperFloorRefusal({
          collateral: keeper.collateral,
          positionCap: checked.positionCap,
          mark: checked.mark,
          imBps: checked.imBps,
        })
      : null);
  const verdict = resumeVerdict({
    mark: checked.mark,
    reference: checked.reference,
    confirmed,
    covered: checked.covered,
    openInterestCap: checked.openInterestCap,
    markAge: checked.markAge,
    maxPriceAge: checked.maxPriceAge,
    guardPasses: checked.guardPasses,
    marketHealthy: checked.marketHealthy,
    shortfall: checked.shortfall,
    adminUpgrades: false,
    keeperWhy,
  });
  if (!verdict.resume) {
    const stays = `${symbol} stays reduce-only: ${verdict.why}.`;
    if (confirmed) throw new Error(`${stays} The market was not resumed.`);
    console.error(stays);
    return;
  }
  await send(
    await sendingAs(on, admin),
    on.instructions.resumeMarket(admin.publicKey, id, await perpMarketIds(on)),
    admin,
  );
  console.error(`${symbol} resumed at a mark of ${checked.mark}.`);
}

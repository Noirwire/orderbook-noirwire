import { z } from "zod";
import {
  assertKnownProgram,
  assertMagicBlockDevnet,
  assertTestNetwork,
} from "./network.js";
import { getJson } from "./sim.js";
import { InvalidInput } from "./units.js";

const tokenSchema = z.object({
  symbol: z.string(),
  mint: z.string(),
  decimals: z.number().int().nonnegative(),
});

const marketSchema = z.object({
  marketId: z.number().int().nonnegative(),
  symbol: z.string(),
  kind: z.enum(["spot", "perp"]),
  baseToken: tokenSchema.nullable(),
  quoteToken: tokenSchema,
  baseDecimals: z.number().int().nonnegative(),
  lotSize: z.string(),
  tick: z.string(),
});

const deploymentSchema = z.object({
  network: z.string(),
  programId: z.string(),
  solanaRpcUrl: z.string(),
  rollupRpcUrl: z.string(),
  exchange: z.string(),
  markets: z.array(marketSchema).min(1),
});

/** `GET /v1/deployment`: what is public about the program's deployment. */
export type Deployment = z.infer<typeof deploymentSchema>;
export type DeploymentMarket = Deployment["markets"][number];

/** Fetches the deployment and refuses one that is not a test network. */
export async function fetchDeployment(
  simUrl: string,
  fetchFn?: typeof fetch,
): Promise<Deployment> {
  const deployment = deploymentSchema.parse(
    await getJson(simUrl, "/v1/deployment", {}, fetchFn),
  );
  assertTestNetwork(deployment.network);
  assertKnownProgram(deployment.programId);
  assertMagicBlockDevnet(deployment.rollupRpcUrl);
  return deployment;
}

/** The market named `symbol`, or an error that lists the ones that exist. */
export function marketNamed(
  deployment: Pick<Deployment, "markets">,
  symbol: string,
): DeploymentMarket {
  const market = deployment.markets.find(
    (candidate) => candidate.symbol === symbol,
  );
  if (!market) {
    const known = deployment.markets
      .map((candidate) => candidate.symbol)
      .join(", ");
    throw new InvalidInput(
      `unknown market "${symbol}"; the markets are ${known}`,
    );
  }
  return market;
}

/** Every perp market id: the markets a perp order's margin check must see. */
export function perpMarketIds(
  deployment: Pick<Deployment, "markets">,
): number[] {
  return deployment.markets
    .filter((market) => market.kind === "perp")
    .map((market) => market.marketId);
}

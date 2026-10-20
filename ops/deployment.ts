/**
 * What a deployment consists of, the network it is on, and the description
 * other services read. The Makefile names the network through variables, so
 * nothing here knows a network by heart.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  CUSTODY_VISIBILITIES,
  Instructions,
  MARKET_KIND,
  type CustodyVisibility,
  type MarketLimits,
  type MarketSettings,
  type PriceSourceSettings,
  type QuoteSettings,
} from "../sdk/dist/index.js";
import { readingAs } from "./keys";

const NUSD = 0;
const NSOL = 1;
export const QUOTE_DECIMALS = 6;

export const TOKENS = [
  {
    index: NUSD,
    symbol: "nUSD",
    decimals: QUOTE_DECIMALS,
    faucetAmount: 10_000_000n * 1_000_000n,
  },
  {
    index: NSOL,
    symbol: "nSOL",
    decimals: 9,
    faucetAmount: 100_000n * 1_000_000_000n,
  },
];

export const FUNDING_INTERVAL_SECONDS = 60n;

/**
 * The test networks' limits. Their markets are bound to no price source and
 * the oracle key publishes every few seconds, so the ages are short.
 */
const LIMITS: MarketLimits = {
  minSize: 1n,
  minNotional: 1_000_000n,
  bandBps: 400,
  imBps: 1_000,
  mmBps: 500,
  takerFeeBps: 5,
  liqPenaltyBps: 200,
  /** Per 8 h; each 60 s interval charges 1/480 of it (RULES 7). */
  fundingCapBps: 50,
  maxMoveBps: 250,
  maxOpenOrders: 32,
  maxPriceAge: 10n,
  fundingInterval: FUNDING_INTERVAL_SECONDS,
  minPublishGap: 1,
  maxAgeLiquidation: 60n,
  openInterestCap: 10_000_000n,
  liqBufferBps: 100,
  liqInsuranceShareBps: 5_000,
  feeInsuranceShareBps: 5_000,
  settleWindow: 900n,
};

const feedId = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));

/**
 * RULES 9 and 9a: mainnet's Pyth sources, for when mainnet is wired up
 * (`target` refuses it today). Each account is the Pyth push oracle's shard 0
 * address for its feed id, owned by the Pyth receiver program; `create_market`
 * and `set_quote_source` derive it from the feed id themselves.
 */
export const MAINNET_PRICE_FEEDS = {
  solUsd: {
    feedId: feedId(
      "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
    ),
    account: new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"),
    expo: -8,
  },
  usdcUsd: {
    feedId: feedId(
      "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
    ),
    account: new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"),
    expo: -8,
  },
};

/**
 * Mainnet's limits on top of `LIMITS`. Pyth pushes on a 0.5% move and a 55 s
 * heartbeat, so a 10 s age could not hold; these are to be confirmed by a
 * soak of the rollup's clock against each observation's publish time before
 * any deposit.
 */
export const MAINNET_LIMITS: MarketLimits = {
  ...LIMITS,
  maxPriceAge: 90n,
  maxAgeLiquidation: 180n,
  settleWindow: 900n,
};

/** SOL/USD for a market of 0.001 SOL lots in 6-decimal USDC: $150 is 150,000 atoms per lot. */
export const MAINNET_SOL_SOURCE: PriceSourceSettings = {
  feedId: MAINNET_PRICE_FEEDS.solUsd.feedId,
  expo: MAINNET_PRICE_FEEDS.solUsd.expo,
  maxConfBps: 100,
  baseDecimals: 9,
  quoteDecimals: QUOTE_DECIMALS,
};

/** RULES 9a: perps turn reduce-only beyond 1% from a dollar, or 180 s after the last healthy USDC observation. */
export const MAINNET_QUOTE_SOURCE: QuoteSettings = {
  feedId: MAINNET_PRICE_FEEDS.usdcUsd.feedId,
  expo: MAINNET_PRICE_FEEDS.usdcUsd.expo,
  maxConfBps: 100,
  depegBps: 100,
  maxAge: 180n,
};

/**
 * `baseDecimals` is how many decimals the base asset counts in, token or not.
 * Prices are quote atoms per lot: a lot is 0.001 SOL or 0.01 NVDA.
 * `initialMark` is the test networks' only: their markets are bound to no
 * source and the oracle key publishes it. A mainnet market starts with no mark
 * and takes its first from `sync_price`.
 */
export const MARKETS: {
  id: number;
  symbol: string;
  baseDecimals: number;
  initialMark: bigint;
  settings: MarketSettings;
}[] = [
  {
    id: 0,
    symbol: "NSOL-PERP",
    baseDecimals: 9,
    initialMark: 150_000n,
    settings: {
      kind: MARKET_KIND.perp,
      baseSymbol: "NSOL",
      quoteSymbol: "NUSD",
      baseToken: NUSD,
      quoteToken: NUSD,
      tick: 100n,
      baseLot: 1_000_000n,
      capacity: 1024,
      limits: LIMITS,
    },
  },
  {
    id: 1,
    symbol: "NNVDA-PERP",
    baseDecimals: 6,
    initialMark: 1_800_000n,
    settings: {
      kind: MARKET_KIND.perp,
      baseSymbol: "NNVDA",
      quoteSymbol: "NUSD",
      baseToken: NUSD,
      quoteToken: NUSD,
      tick: 1_000n,
      baseLot: 10_000n,
      capacity: 1024,
      limits: LIMITS,
    },
  },
  {
    id: 2,
    symbol: "NSOL-NUSD",
    baseDecimals: 9,
    initialMark: 150_000n,
    settings: {
      kind: MARKET_KIND.spot,
      baseSymbol: "NSOL",
      quoteSymbol: "NUSD",
      baseToken: NSOL,
      quoteToken: NUSD,
      tick: 100n,
      baseLot: 1_000_000n,
      capacity: 1024,
      limits: LIMITS,
    },
  },
];

export type DeploymentDescription = {
  network: string;
  programId: string;
  solanaUrl: string;
  rollupUrl: string;
  privateUrl: string;
  /**
   * Where `deposit`, `withdraw`, `collect_fees` and `fund_insurance` are sent.
   * A private endpoint refuses every transaction of this program that names a
   * private token balance. Where custody is sealed this is therefore the
   * rollup's own port; where custody is public it is the private endpoint,
   * and the depositor's or withdrawer's token balance must be public too.
   */
  depositUrl: string;
  validator: string;
  exchange: string;
  ledger: string;
  stats: string;
  gate: string;
  oracle: string;
  faucet: string;
  tokens: {
    index: number;
    symbol: string;
    decimals: number;
    mint: string;
    /** The nonce of the token's custody authority, as decimal text, as the exchange records it. */
    custodyNonce: string;
    custody: string;
    /** As the exchange records it. Public shows the token's total in custody to anyone. */
    custodyVisibility: CustodyVisibility;
  }[];
  markets: {
    id: number;
    symbol: string;
    kind: "spot" | "perp";
    /** Decimals of the base asset and of the quote token. */
    baseDecimals: number;
    quoteDecimals: number;
    /** Base atoms in one lot, and quote atoms per lot in one tick, as decimal text. */
    baseLot: string;
    tick: string;
    market: string;
    book: string;
    tape: string;
    priceFeed: string;
    fundingTaskId?: number;
  }[];
};

export function readDeployment(path: string): DeploymentDescription | null {
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as DeploymentDescription)
    : null;
}

/**
 * Whether a description is of the exchange as it stands. The exchange records
 * its mints, so a description left by an earlier network, or by a run that
 * stopped half way, is told apart by them.
 */
export function describesTheseMints(
  previous: Pick<DeploymentDescription, "tokens">,
  tokens: { index: number; mint: string }[],
): boolean {
  return tokens.every(
    (token) =>
      previous.tokens.find(({ index }) => index === token.index)?.mint ===
      token.mint,
  );
}

export type Target = {
  network: string;
  solana: Connection;
  rollup: Connection;
  solanaUrl: string;
  rollupUrl: string;
  privateUrl: string;
  depositUrl: string;
  custody: CustodyVisibility;
  validator: PublicKey;
  floatLamports: number;
  keysDir: string;
  deploymentPath: string;
  instructions: Instructions;
};

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

function setting(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Use the Makefile targets.`);
  return value;
}

function custodySetting(): CustodyVisibility {
  const value = setting("CUSTODY");
  const known = CUSTODY_VISIBILITIES.find((visibility) => visibility === value);
  if (!known) {
    throw new Error(`CUSTODY is one of: ${CUSTODY_VISIBILITIES.join(", ")}`);
  }
  return known;
}

/** The network the Makefile named. Refuses mainnet, and a network whose genesis is not the one named. */
export async function target(): Promise<Target> {
  const network = setting("NETWORK");
  const solanaUrl = setting("SOLANA_URL");
  const rollupUrl = setting("ROLLUP_URL");
  const solana = new Connection(solanaUrl, "confirmed");
  const genesis = await solana.getGenesisHash();
  if (genesis === MAINNET_GENESIS) {
    throw new Error("Mainnet is not wired up. Nothing was sent.");
  }
  if (process.env.GENESIS && genesis !== process.env.GENESIS) {
    throw new Error(`${solanaUrl} is not ${network}: ${genesis}`);
  }
  return {
    network,
    solana,
    rollup: new Connection(rollupUrl, "confirmed"),
    solanaUrl,
    rollupUrl,
    privateUrl: setting("PRIVATE_URL"),
    depositUrl: setting("DEPOSIT_URL"),
    custody: custodySetting(),
    validator: new PublicKey(setting("VALIDATOR")),
    floatLamports: Number(setting("EXCHANGE_FLOAT_LAMPORTS")),
    keysDir: setting("KEYS_DIR"),
    deploymentPath: setting("DEPLOYMENT"),
    instructions: new Instructions(),
  };
}

/** Runs `command` on the network the Makefile named and ends the process, which an open websocket would keep alive. */
export function run(command: (on: Target) => Promise<void>): void {
  target()
    .then(command)
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}

/** Where the deployment keeps the key of `role`, under its keys folder. */
export const keyPath = (on: Target, role: string) =>
  join(on.keysDir, `${on.network}-${role}.json`);

function signedInWhereNeeded(
  on: Target,
  url: string,
  key: Keypair,
): Promise<Connection> {
  return url === on.privateUrl
    ? readingAs(on.privateUrl, key)
    : Promise.resolve(new Connection(url, "confirmed"));
}

/**
 * The connection `key` sends and reads its own accounts through. A private
 * endpoint takes a transaction only from a signed-in caller and serves a
 * token account only to its owner, so there it is signed in as `key`. The
 * rollup's own port, where one is given, needs no sign-in.
 */
export const sendingAs = (on: Target, key: Keypair) =>
  signedInWhereNeeded(on, on.rollupUrl, key);

/** The connection `key` sends what names custody through. */
export const depositingAs = (on: Target, key: Keypair) =>
  signedInWhereNeeded(on, on.depositUrl, key);

/** Stops unless the rollup behind the endpoint is the validator we were told. */
export async function rollupIsRunBy(on: Target): Promise<void> {
  const answer = await fetch(on.rollupUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getIdentity" }),
  });
  const { result } = (await answer.json()) as {
    result?: { identity?: string };
  };
  if (result?.identity !== on.validator.toBase58()) {
    throw new Error(
      `${on.rollupUrl} is run by ${result?.identity}, not ${on.validator.toBase58()}. Nothing was sent.`,
    );
  }
}

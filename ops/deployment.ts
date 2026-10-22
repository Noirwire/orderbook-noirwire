/**
 * What a deployment consists of, the network it is on, and the description
 * other services read. The Makefile names the network through variables, so
 * nothing here knows a network by heart.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  CUSTODY_VISIBILITIES,
  Instructions,
  PROGRAM_ID,
  type CustodyVisibility,
} from "../sdk/dist/index.js";
import { readingAs } from "./keys";
import {
  MAINNET_USDC_MINT,
  PROFILES,
  type Profile,
} from "../sdk/dist/operator/index.js";

export * from "../sdk/dist/operator/profiles.js";

export type DeploymentDescription = {
  network: string;
  profile?: Profile;
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
  /** The test profile's only. */
  faucet?: string;
  /** The mainnet profile's: the quote atoms `fund_insurance` added, as decimal text, so a later run does not add them again. */
  insuranceFunded?: string;
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
  /** Whether the Solana behind `SOLANA_URL` is mainnet, by its genesis. */
  mainnet: boolean;
  profile: Profile;
  solana: Connection;
  rollup: Connection;
  solanaUrl: string;
  /**
   * The Solana RPC the deployment description names, `PUBLIC_SOLANA_URL`.
   * It is read by anyone the description is served to, so it is never the
   * operator's own `SOLANA_URL`, which may carry a provider's API key.
   */
  publicSolanaUrl: string;
  rollupUrl: string;
  privateUrl: string;
  depositUrl: string;
  custody: CustodyVisibility;
  validator: PublicKey;
  floatLamports: number;
  keysDir: string;
  deploymentPath: string;
  /** The mainnet profile's: the local build the program at `PROGRAM_ID` must be byte for byte. */
  builtProgramPath: string | null;
  instructions: Instructions;
};

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const TESTNET_GENESIS = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY";

function setting(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Use the Makefile targets.`);
  return value;
}

function oneOf<T extends string>(
  name: string,
  value: string,
  known: readonly T[],
): T {
  const found = known.find((each) => each === value);
  if (!found) throw new Error(`${name} is one of: ${known.join(", ")}`);
  return found;
}

/**
 * The program the deployment runs: `PROGRAM_ID` when it is set, so the same
 * scripts operate a rehearsal at a fresh program id, and the id the client
 * was built with otherwise.
 */
export function programIdSetting(
  value: string | undefined = process.env.PROGRAM_ID,
): PublicKey {
  return value ? new PublicKey(value) : PROGRAM_ID;
}

/** `GENESIS` for a local validator, whose genesis is new with every reset: any chain but a public cluster. */
export const LOCAL_GENESIS = "local";
const PUBLIC_GENESES = [MAINNET_GENESIS, DEVNET_GENESIS, TESTNET_GENESIS];
/** The networks the mainnet profile runs on: mainnet itself, and its rehearsal. */
const MAINNET_PROFILE_NETWORKS = ["mainnet", "rehearsal"];

/**
 * Why nothing may be sent to the network with `genesis`, or null. Every run
 * names the genesis it expects (`GENESIS`, or `local` for a local
 * validator), so a run pointed at the wrong chain stops before it reads
 * anything else. Only `NETWORK=mainnet` runs on mainnet, and it runs nowhere
 * else; the mainnet profile runs on mainnet and its rehearsal only. Mainnet
 * takes the mainnet profile only, and only when the operator named the
 * program it sends to (`MAINNET_PROGRAM_ID`), which a yes left exported in a
 * shell cannot do for another program.
 */
export function networkRefusal(on: {
  network: string;
  genesis: string;
  expectedGenesis?: string;
  profile: Profile;
  programId: string;
  confirmedProgramId?: string;
}): string | null {
  if (!on.expectedGenesis) {
    return `GENESIS is not set: name ${on.network}'s genesis hash, or GENESIS=${LOCAL_GENESIS} for a local validator. Nothing was sent.`;
  }
  if (on.expectedGenesis === LOCAL_GENESIS) {
    if (PUBLIC_GENESES.includes(on.genesis)) {
      return `GENESIS=${LOCAL_GENESIS}, but ${on.network} is a public cluster: its genesis is ${on.genesis}. Nothing was sent.`;
    }
  } else if (on.genesis !== on.expectedGenesis) {
    return `The network is not ${on.network}: its genesis is ${on.genesis}. Nothing was sent.`;
  }
  const onMainnet = on.genesis === MAINNET_GENESIS;
  if ((on.network === "mainnet") !== onMainnet) {
    return `NETWORK=${on.network} on a chain whose genesis is ${on.genesis}: only NETWORK=mainnet runs on mainnet, and it runs nowhere else. Nothing was sent.`;
  }
  if (
    on.profile === "mainnet" &&
    !MAINNET_PROFILE_NETWORKS.includes(on.network)
  ) {
    return `The mainnet profile runs on mainnet and its rehearsal only (NETWORK=${MAINNET_PROFILE_NETWORKS.join(" or ")}), not ${on.network}. Nothing was sent.`;
  }
  if (!onMainnet) return null;
  if (on.profile !== "mainnet") {
    return "Mainnet takes the mainnet profile only (PROFILE=mainnet). Nothing was sent.";
  }
  if (on.confirmedProgramId !== on.programId) {
    return `This is mainnet: run it again with MAINNET_PROGRAM_ID=${on.programId} to go ahead. Nothing was sent.`;
  }
  return null;
}

/** The network the Makefile named, refused as `networkRefusal` says. */
export async function target(): Promise<Target> {
  const network = setting("NETWORK");
  const solanaUrl = setting("SOLANA_URL");
  const rollupUrl = setting("ROLLUP_URL");
  const profile = oneOf("PROFILE", process.env.PROFILE ?? "test", PROFILES);
  const solana = new Connection(solanaUrl, "confirmed");
  const genesis = await solana.getGenesisHash();
  const programId = programIdSetting();
  const refusal = networkRefusal({
    network,
    genesis,
    expectedGenesis: process.env.GENESIS,
    profile,
    programId: programId.toBase58(),
    confirmedProgramId: process.env.MAINNET_PROGRAM_ID,
  });
  if (refusal) throw new Error(refusal);
  return {
    network,
    mainnet: genesis === MAINNET_GENESIS,
    profile,
    solana,
    rollup: new Connection(rollupUrl, "confirmed"),
    solanaUrl,
    publicSolanaUrl: setting("PUBLIC_SOLANA_URL"),
    rollupUrl,
    privateUrl: setting("PRIVATE_URL"),
    depositUrl: setting("DEPOSIT_URL"),
    custody: oneOf("CUSTODY", setting("CUSTODY"), CUSTODY_VISIBILITIES),
    validator: new PublicKey(setting("VALIDATOR")),
    floatLamports: Number(setting("EXCHANGE_FLOAT_LAMPORTS")),
    keysDir: setting("KEYS_DIR"),
    deploymentPath: setting("DEPLOYMENT"),
    builtProgramPath: process.env.BUILT_PROGRAM || null,
    instructions: new Instructions(programId),
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

/** The admin key is put there by hand, except on the local network, where the Makefile makes it. */
export const adminKeyPath = (on: Target) =>
  on.network === "localnet"
    ? join(on.keysDir, "admin.json")
    : keyPath(on, "admin");

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

/**
 * Stops unless the rollup behind the endpoint is the validator we were told,
 * and, on mainnet, unless that rollup works from mainnet. Both the endpoint
 * and the identity are the operator's to give, and a matching pair copied from
 * a test network passes the identity check, so the rollup is also asked for
 * mainnet's USDC mint: a rollup serves the accounts of the chain it clones
 * from, and that mint exists on mainnet only.
 */
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
  if (!on.mainnet) return;
  const mint = await on.rollup.getAccountInfo(MAINNET_USDC_MINT);
  if (!mint?.owner.equals(TOKEN_PROGRAM_ID)) {
    throw new Error(
      `${on.rollupUrl} serves no USDC mint at ${MAINNET_USDC_MINT.toBase58()}, which a rollup working from mainnet serves: ` +
        "it works from another chain, and an exchange delegated to it could not be used on mainnet. Nothing was sent.",
    );
  }
}

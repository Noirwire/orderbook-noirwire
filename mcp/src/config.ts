import { join, resolve } from "node:path";

export const DEFAULT_SIM_URL = "https://sim-noirwire-production.up.railway.app";
const DEFAULT_KEYPAIR = join(".config", "noirwire", "devnet-trader.json");

export type Config = {
  /** The public simulation service: market data, the deployment and the test grant. */
  simUrl: string;
  /** A Solana CLI keypair file: the trader's owner key. */
  keypairPath: string;
  /** Where the order keys' position in their derivation is kept, beside the keypair. */
  checkpointPath: string;
};

/** The configuration the environment asks for, with the defaults filled in. Reads nothing from disk. */
export function resolveConfig(
  env: Record<string, string | undefined>,
  home: string,
): Config {
  const simUrl = (env.NOIRWIRE_SIM_URL?.trim() || DEFAULT_SIM_URL).replace(
    /\/+$/,
    "",
  );
  const chosen = env.NOIRWIRE_KEYPAIR?.trim();
  const keypairPath = chosen
    ? chosen === "~" || chosen.startsWith("~/")
      ? join(home, chosen.slice(1))
      : resolve(chosen)
    : join(home, DEFAULT_KEYPAIR);
  return {
    simUrl,
    keypairPath,
    checkpointPath: `${keypairPath}.checkpoint.json`,
  };
}

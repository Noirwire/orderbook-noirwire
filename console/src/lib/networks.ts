import config from "../../networks.json";

export const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

/** The wallet-standard chain a genesis is: mainnet, devnet, or a local network. */
export const chainOf = (genesis: string) =>
  genesis === MAINNET_GENESIS
    ? "solana:mainnet"
    : genesis === DEVNET_GENESIS
      ? "solana:devnet"
      : "solana:localnet";

/**
 * One network the console can be pointed at, as `networks.json` names it.
 * `profile` is what its exchange was set up with: the test networks' or the
 * mainnet launch. `rollupUrl` takes the admin's instructions and serves the
 * public accounts; `depositUrl` takes what names custody (`set_custody_cap`,
 * `fund_insurance`); a send to `privateUrl` signs in first. `validator` is
 * the identity both of those endpoints must answer `getIdentity` with, as
 * `VALIDATOR` in the Makefile. `strangers` is what a wallet that is neither
 * the admin nor a viewer sees.
 */
export type Network = {
  name: string;
  label: string;
  profile: "test" | "mainnet";
  solanaUrl: string;
  rollupUrl: string;
  privateUrl: string;
  depositUrl: string;
  validator: string;
  genesis: string;
  programId: string;
  strangers: "stats" | "none";
  setup: string;
};

export const NETWORKS = config.networks as Network[];
export const VIEWERS: string[] = config.viewers;
export const DEFAULT_NETWORK = config.default;
export const NETWORK_COOKIE = "network";

export function networkNamed(name: string | undefined): Network {
  return (
    NETWORKS.find((network) => network.name === name) ??
    NETWORKS.find((network) => network.name === DEFAULT_NETWORK) ??
    NETWORKS[0]
  );
}

/** Why the console shows nothing of `network` until its configuration is filled in, or null. */
export function configGap(network: Network): string | null {
  const missing = (
    [
      ["programId", network.programId],
      ["solanaUrl", network.solanaUrl],
      ["rollupUrl", network.rollupUrl],
      ["depositUrl", network.depositUrl],
      ["validator", network.validator],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([field]) => field);
  return missing.length === 0
    ? null
    : `networks.json leaves ${missing.join(", ")} empty for ${network.label}.`;
}

/** The endpoints a network's rollup is reached at, each once. */
export const rollupEndpoints = (network: {
  rollupUrl: string;
  depositUrl: string;
}) => [...new Set([network.rollupUrl, network.depositUrl])];

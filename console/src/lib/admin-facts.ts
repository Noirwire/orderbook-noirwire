import { MAINNET_GENESIS, type Network } from "./networks";

/** The network an action is reviewed and sent on, its genesis as read and checked by the server. */
export type NetworkFacts = {
  name: string;
  label: string;
  solanaUrl: string;
  rollupUrl: string;
  privateUrl: string;
  depositUrl: string;
  validator: string;
  genesis: string;
  programId: string;
  mainnet: boolean;
};

export const networkFacts = (
  network: Network,
  genesis: string,
): NetworkFacts => ({
  name: network.name,
  label: network.label,
  solanaUrl: network.solanaUrl,
  rollupUrl: network.rollupUrl,
  privateUrl: network.privateUrl,
  depositUrl: network.depositUrl,
  validator: network.validator,
  genesis,
  programId: network.programId,
  mainnet: genesis === MAINNET_GENESIS,
});

/** What the admin's forms need from the chain, as plain values a client component can take. */
export type AdminFacts = {
  network: NetworkFacts;
  /** On the launch profile or mainnet, why the program there is not the checked build; null when it is or elsewhere. */
  buildRefusal: string | null;
  admin: string;
  pendingAdmin: string | null;
  paused: boolean;
  gate: string;
  oracle: string;
  maxSteps: number;
  maxSeatsPerDay: number;
  collateralToken: number;
  tokens: {
    index: number;
    mint: string;
    custodyNonce: string;
    visibility: string;
    cap: string;
    decimals: number | null;
  }[];
  markets: {
    id: number;
    name: string;
    perp: boolean;
    status: number;
    pythAccount: string | null;
    fundingInterval: string;
  }[];
  quoteAccount: string | null;
};

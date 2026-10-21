/** What the admin's forms need from the chain, as plain values a client component can take. */
export type AdminFacts = {
  network: {
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

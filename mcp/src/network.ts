import { PROGRAM_ID, websocketUrl } from "@noirwire/orderbook";

const TEST_NETWORK = "devnet";

/** The genesis hash of Solana devnet. A chain with any other genesis is not devnet, whatever it is called. */
export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

/** Every notice a tool returns, so an agent never mistakes this for real funds. */
export const TEST_MONEY_NOTICE =
  "This is the NoirWire devnet test network. Every balance is test money with no real value.";

/** A deployment this server will not connect to. Raised before any sign-in or signature. */
export class UnsafeDeployment extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeDeployment";
  }
}

/**
 * Refuses a deployment that is not a test network. This server trades on
 * devnet only; it never signs for anything else.
 */
export function assertTestNetwork(network: string): void {
  if (network !== TEST_NETWORK) {
    throw new UnsafeDeployment(
      `the deployment reports the network "${network}"; this server trades on devnet only and will not connect to it`,
    );
  }
}

/** Refuses a deployment of any program but the order book this client is built for. */
export function assertKnownProgram(programId: string): void {
  if (programId !== PROGRAM_ID.toBase58()) {
    throw new UnsafeDeployment(
      `the deployment names the program ${programId}, not the NoirWire order book ${PROGRAM_ID.toBase58()}; nothing was signed`,
    );
  }
}

/**
 * Refuses a rollup endpoint that is not MagicBlock's devnet. The rollup
 * cannot be told apart by genesis hash (it reports the all-ones system
 * address), so the endpoint is pinned by name instead: https, and a host
 * under magicblock.app whose first label starts with "devnet". The
 * websocket address the client derives from it must be wss on that host.
 */
export function assertMagicBlockDevnet(rollupRpcUrl: string): void {
  const refuse = () =>
    new UnsafeDeployment(
      `the deployment's rollup endpoint ${rollupRpcUrl} is not a MagicBlock devnet endpoint (https, under magicblock.app, starting with "devnet"); nothing was signed`,
    );
  let http: URL;
  let socket: URL;
  try {
    http = new URL(rollupRpcUrl);
    socket = new URL(websocketUrl(rollupRpcUrl));
  } catch {
    throw refuse();
  }
  const pinned = (url: URL, protocol: string) =>
    url.protocol === protocol &&
    url.hostname.endsWith(".magicblock.app") &&
    url.hostname.split(".")[0].startsWith("devnet");
  if (
    !pinned(http, "https:") ||
    !pinned(socket, "wss:") ||
    socket.hostname !== http.hostname
  ) {
    throw refuse();
  }
}

/** Refuses a Solana chain whose genesis hash is not devnet's, whatever the deployment calls it. */
export function assertDevnetGenesis(genesisHash: string): void {
  if (genesisHash !== DEVNET_GENESIS) {
    throw new UnsafeDeployment(
      `the deployment's Solana chain has genesis ${genesisHash}, which is not devnet (${DEVNET_GENESIS}); nothing was signed`,
    );
  }
}

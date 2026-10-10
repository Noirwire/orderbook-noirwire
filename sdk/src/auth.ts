import { Connection, type PublicKey } from "@solana/web3.js";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";

export type SignMessage = (message: Uint8Array) => Promise<Uint8Array>;

/** A token the private endpoint accepts as `reader`, signed by the caller's wallet. */
export async function signIn(
  privateUrl: string,
  reader: PublicKey,
  signMessage: SignMessage,
): Promise<string> {
  const { token } = await getAuthToken(privateUrl, reader, signMessage);
  return token;
}

/**
 * Turns `http(s)://host` into the websocket address beside it. Where the
 * address names a port, the validators serve websockets one port above it.
 */
export function websocketUrl(httpUrl: string): string {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (url.port) url.port = String(Number(url.port) + 1);
  return url.toString().replace(/\/$/, "");
}

/** A connection to the private endpoint that reads as the signed-in key. */
export async function privateConnection(
  privateUrl: string,
  reader: PublicKey,
  signMessage: SignMessage,
  commitment: "processed" | "confirmed" = "confirmed",
): Promise<Connection> {
  const token = await signIn(privateUrl, reader, signMessage);
  return new Connection(`${privateUrl}?token=${token}`, {
    commitment,
    wsEndpoint: `${websocketUrl(privateUrl)}?token=${token}`,
  });
}

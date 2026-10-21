import { Connection } from "@solana/web3.js";

const IDENTITY_TIMEOUT_MS = 15_000;

/** The identity the validator behind `url` answers `getIdentity` with. */
export async function identityOf(url: string): Promise<string> {
  const answer = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getIdentity" }),
    cache: "no-store",
    signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS),
  });
  if (!answer.ok) throw new Error(`${url} answered ${answer.status}`);
  const { result } = (await answer.json()) as {
    result?: { identity?: unknown };
  };
  if (typeof result?.identity !== "string") {
    throw new Error(`${url} gave no identity`);
  }
  return result.identity;
}

/** Why the rollup behind `url` is not run by `validator`, or null when it is. */
export async function rollupDiffers(
  url: string,
  validator: string,
): Promise<string | null> {
  const identity = await identityOf(url).catch((error: Error) => error);
  if (identity instanceof Error) {
    return `${url} did not give its identity: ${identity.message}`;
  }
  return identity === validator
    ? null
    : `${url} is run by ${identity}, not ${validator}.`;
}

/** What a send is checked against right before the wallet signs. */
export type Expected = {
  solanaUrl: string;
  genesis: string;
  url: string;
  validator: string;
};

/**
 * Throws unless the Solana RPC still answers with the expected genesis and
 * the endpoint the instruction goes to is still run by the expected
 * validator. Read fresh on every call.
 */
export async function stillTheNetwork(expected: Expected): Promise<void> {
  const [genesis, differs] = await Promise.all([
    new Connection(expected.solanaUrl, "confirmed").getGenesisHash(),
    rollupDiffers(expected.url, expected.validator),
  ]);
  if (genesis !== expected.genesis) {
    throw new Error(
      `${expected.solanaUrl} now answers with genesis ${genesis}, not ${expected.genesis}. Nothing was signed.`,
    );
  }
  if (differs) throw new Error(`${differs} Nothing was signed.`);
}

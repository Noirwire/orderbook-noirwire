/**
 * Pyth as the operator meets it: the price account a market reads, Hermes's
 * latest price for the same feed, and, where the network's own updates come
 * too slowly, posting Hermes's update to that account through Pyth's push
 * oracle, which anyone may do at their own cost.
 */
import {
  VersionedTransaction,
  type Connection,
  type Keypair,
  type PublicKey,
  type Transaction,
} from "@solana/web3.js";
import type { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";

/** The push oracle shard every market and the USDC guard read (RULES 9). */
const SHARD = 0;

/** `programs/noirwire-orderbook/src/pyth.rs`: where a fully verified `PriceUpdateV2` keeps its fields. */
const PRICE_UPDATE_LEN = 134;
const VERIFICATION_AT = 40;
const FULLY_VERIFIED = 1;
const FEED_ID_AT = 41;
const PRICE_AT = 73;
const CONF_AT = 81;
const EXPO_AT = 89;
const PUBLISH_TIME_AT = 93;

export type Observation = {
  feedId: string;
  price: bigint;
  conf: bigint;
  expo: number;
  publishTime: number;
};

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

/** A price account's observation, or null for anything the program would refuse to read. */
export function observationIn(data: Uint8Array): Observation | null {
  if (data.length !== PRICE_UPDATE_LEN) return null;
  if (data[VERIFICATION_AT] !== FULLY_VERIFIED) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    feedId: hex(data.subarray(FEED_ID_AT, FEED_ID_AT + 32)),
    price: view.getBigInt64(PRICE_AT, true),
    conf: view.getBigUint64(CONF_AT, true),
    expo: view.getInt32(EXPO_AT, true),
    publishTime: Number(view.getBigInt64(PUBLISH_TIME_AT, true)),
  };
}

/**
 * RULES 9: `price * 10^expo` USD per whole base token in quote atoms per lot,
 * `price * base_lot * 10^(expo + quote_decimals - base_decimals)`, rounded
 * down, as the program scales it.
 */
export function atomsPerLot(
  observation: Pick<Observation, "price" | "expo">,
  lot: { baseLot: bigint; baseDecimals: number; quoteDecimals: number },
): bigint {
  const e = observation.expo + lot.quoteDecimals - lot.baseDecimals;
  const units = observation.price * lot.baseLot;
  return e >= 0 ? units * 10n ** BigInt(e) : units / 10n ** BigInt(-e);
}

export const PYTH_HERMES = "https://hermes.pyth.network";

/**
 * The Hermes the mark is checked against and updates are read from:
 * `HERMES_URL` on a test network, Pyth's own on mainnet, where another would
 * become the reference that opens the market and would receive the token.
 */
export function hermesUrl(
  mainnet: boolean,
  given = process.env.HERMES_URL,
): string {
  if (!given) return PYTH_HERMES;
  if (mainnet) {
    throw new Error(
      `HERMES_URL is ${given}; mainnet uses ${PYTH_HERMES} only. Nothing was sent.`,
    );
  }
  return given;
}

/** Hermes answers only a caller with a Pyth access token, sent as a bearer token. Never printed. */
const hermesHeaders = (): Record<string, string> =>
  process.env.HERMES_TOKEN
    ? { authorization: `Bearer ${process.env.HERMES_TOKEN}` }
    : {};

export type HermesLatest = {
  observations: Observation[];
  /** The signed update, base64, that the push oracle takes. */
  updates: string[];
};

type HermesAnswer = {
  binary: { data: string[] };
  parsed: {
    id: string;
    price: { price: string; conf: string; expo: number; publish_time: number };
  }[];
};

/** Hermes's latest price of each feed, one signed update for them all, from the Hermes at `url`. */
export async function hermesLatest(
  url: string,
  feedIds: string[],
): Promise<HermesLatest> {
  const query = feedIds.map((id) => `ids[]=${id}`).join("&");
  const answer = await fetch(
    `${url}/v2/updates/price/latest?${query}&encoding=base64`,
    { headers: hermesHeaders() },
  );
  if (!answer.ok) {
    const hint = answer.status === 401 ? ": set HERMES_TOKEN" : "";
    throw new Error(
      `Hermes answered ${answer.status} for ${feedIds.join(", ")}${hint}`,
    );
  }
  const { binary, parsed } = (await answer.json()) as HermesAnswer;
  return {
    updates: binary.data,
    observations: parsed.map(({ id, price }) => ({
      feedId: id.replace(/^0x/, ""),
      price: BigInt(price.price),
      conf: BigInt(price.conf),
      expo: price.expo,
      publishTime: price.publish_time,
    })),
  };
}

/** Pyth's own push rules on mainnet: a 55 s heartbeat and a 0.5% move. */
export const PUSH_RULES = { heartbeatSeconds: 55, moveBps: 50n };

/**
 * Whether Hermes's observation should be posted over the one the account
 * holds, by Pyth's mainnet rules, so a devnet rehearsal sees mainnet's
 * cadence. Never for an observation that is not newer.
 */
export function pushDue(
  held: Pick<Observation, "price" | "publishTime"> | null,
  latest: Pick<Observation, "price" | "publishTime">,
  rules = PUSH_RULES,
): boolean {
  if (!held) return true;
  if (latest.publishTime <= held.publishTime) return false;
  if (latest.publishTime - held.publishTime >= rules.heartbeatSeconds) {
    return true;
  }
  const move =
    latest.price > held.price
      ? latest.price - held.price
      : held.price - latest.price;
  return held.price > 0n && move * 10_000n >= held.price * rules.moveBps;
}

type Signable = Transaction | VersionedTransaction;

function signedBy<T extends Signable>(payer: Keypair, transaction: T): T {
  if (transaction instanceof VersionedTransaction) transaction.sign([payer]);
  else transaction.partialSign(payer);
  return transaction;
}

async function receiverFor(
  solana: Connection,
  payer: Keypair,
): Promise<PythSolanaReceiver> {
  const { PythSolanaReceiver: Receiver } =
    await import("@pythnetwork/pyth-solana-receiver");
  return new Receiver({
    connection: solana,
    wallet: {
      payer,
      publicKey: payer.publicKey,
      signTransaction: async (transaction) => signedBy(payer, transaction),
      signAllTransactions: async (transactions) =>
        transactions.map((transaction) => signedBy(payer, transaction)),
    },
  });
}

/**
 * Posts `updates` to each feed's shard 0 account through Pyth's push oracle,
 * paid by `payer`: the Wormhole message is written to a temporary account,
 * verified, read by the push oracle and closed again, so its rent comes back.
 * Resolves to the signatures.
 */
export async function pushed(
  solana: Connection,
  payer: Keypair,
  updates: string[],
): Promise<string[]> {
  const receiver = await receiverFor(solana, payer);
  const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: true });
  await builder.addUpdatePriceFeed(updates, SHARD);
  const transactions = await builder.buildVersionedTransactions({
    tightComputeBudget: true,
  });
  return receiver.provider.sendAll(transactions, {
    skipPreflight: true,
    commitment: "confirmed",
  });
}

/** The shard 0 account the push oracle keeps for `feedId`, as the receiver package derives it. */
export async function pushedAccount(feedId: string): Promise<PublicKey> {
  const { getPriceFeedAccountForProgram } =
    await import("@pythnetwork/pyth-solana-receiver");
  return getPriceFeedAccountForProgram(SHARD, feedId);
}

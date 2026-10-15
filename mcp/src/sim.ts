import { Transaction, type Keypair, type PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { FundingRefused, verifyFundingTransaction } from "./funding.js";
import { messageOf } from "./outcomes.js";

const marketsSchema = z.object({
  network: z.string(),
  markets: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      base: z.string(),
      quote: z.string(),
      markPrice: z.string().nullable(),
      change24hPercent: z.number().nullable(),
      volume24h: z.string(),
      openInterest: z.string().nullable(),
      tickSize: z.string(),
      lotSize: z.string(),
      maxLeverage: z.number(),
    }),
  ),
});

const tapeSchema = z.object({
  fills: z.array(
    z.object({
      price: z.string(),
      size: z.string(),
      takerSide: z.string(),
      timestampMs: z.number(),
      sequence: z.number(),
    }),
  ),
});

const candlesSchema = z.object({
  candles: z.array(
    z.object({
      startMs: z.number(),
      open: z.string(),
      high: z.string(),
      low: z.string(),
      close: z.string(),
      volume: z.string(),
    }),
  ),
});

export async function getJson(
  simUrl: string,
  path: string,
  query: Record<string, string>,
  fetchFn: typeof fetch = fetch,
): Promise<unknown> {
  const url = `${simUrl}${path}?${new URLSearchParams(query)}`;
  const response = await fetchFn(url, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `${path} answered ${response.status} ${body.slice(0, 200)}`.trim(),
    );
  }
  return response.json();
}

export async function fetchMarkets(simUrl: string) {
  return marketsSchema.parse(await getJson(simUrl, "/v1/markets", {}));
}

export async function fetchTape(simUrl: string, market: string, limit: number) {
  const body = await getJson(simUrl, "/v1/tape", {
    market,
    limit: String(limit),
  });
  return tapeSchema.parse(body).fills;
}

export async function fetchCandles(
  simUrl: string,
  market: string,
  interval: string,
  limit: number,
) {
  const body = await getJson(simUrl, "/v1/candles", {
    market,
    interval,
    limit: String(limit),
  });
  return candlesSchema.parse(body).candles;
}

const preparedSchema = z.object({ transaction: z.string().min(1) });
const fundedSchema = z.object({ amount: z.string(), reference: z.string() });
const errorSchema = z.object({ error: z.string() });

export type FundOutcome =
  | { kind: "granted"; amount: string; reference: string }
  | { kind: "alreadyFunded" }
  | { kind: "tryLater"; reason: string | null }
  | { kind: "error"; message: string };

/** 409 means the owner already has its grant; 429 and 503 are limits that lift by themselves. */
async function fundOutcomeOf(response: Response): Promise<FundOutcome> {
  const body: unknown = await response.json().catch(() => null);
  const parsed = errorSchema.safeParse(body);
  const reason = parsed.success ? parsed.data.error : null;
  if (response.status === 409) return { kind: "alreadyFunded" };
  if (response.status === 429 || response.status === 503) {
    return { kind: "tryLater", reason };
  }
  return {
    kind: "error",
    message: reason ?? `the service answered ${response.status}`,
  };
}

async function post(
  simUrl: string,
  path: string,
  body: unknown,
): Promise<Response> {
  return fetch(`${simUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * The service's two-step funding: `prepare` returns one transaction that
 * opens the owner's account and deposits the test grant, the owner signs
 * it, and `submit` has the service add its own signatures and send it.
 */
export async function openAndFund(
  simUrl: string,
  owner: Keypair,
  orderKeys: PublicKey[],
  programId: PublicKey,
): Promise<FundOutcome> {
  const address = owner.publicKey.toBase58();
  try {
    const prepare = await post(simUrl, "/v1/fund/prepare", {
      owner: address,
      orderKeys: orderKeys.map((key) => key.toBase58()),
    });
    if (!prepare.ok) return await fundOutcomeOf(prepare);
    const { transaction } = preparedSchema.parse(await prepare.json());

    const signed = Transaction.from(Buffer.from(transaction, "base64"));
    verifyFundingTransaction(signed, {
      owner: owner.publicKey,
      orderKeys,
      programId,
    });
    signed.partialSign(owner);
    const submit = await post(simUrl, "/v1/fund/submit", {
      owner: address,
      transaction: signed
        .serialize({ requireAllSignatures: false, verifySignatures: false })
        .toString("base64"),
    });
    if (!submit.ok) return await fundOutcomeOf(submit);
    const funded = fundedSchema.parse(await submit.json());
    return {
      kind: "granted",
      amount: funded.amount,
      reference: funded.reference,
    };
  } catch (error) {
    if (error instanceof FundingRefused) {
      return { kind: "error", message: error.message };
    }
    return {
      kind: "error",
      message: `could not complete the funding call to ${simUrl}: ${messageOf(error)}`,
    };
  }
}

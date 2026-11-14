/**
 * Prices as the operator reads them, with no key: a MagicBlock price
 * account's observation byte by byte, a price in quote atoms per lot, and the
 * reference a first mark is checked against (the median of free exchange
 * prices). Importing it touches nothing, and nothing here reads the
 * environment: the caller passes every URL.
 */
import type { PublicKey } from "@solana/web3.js";
import { bytesEqual } from "../bytes.js";
import { MAGICBLOCK_ORACLE_ID } from "../constants.js";

/** `programs/noirwire-orderbook/src/magicblock_oracle.rs`: where a MagicBlock price account keeps its fields. */
const PRICE_UPDATE_LEN = 134;
const VERIFICATION_AT = 40;
const FULLY_VERIFIED = 1;
const FEED_ID_AT = 41;
const PRICE_AT = 73;
const EXPO_AT = 89;
const PUBLISH_TIME_AT = 93;

export type Observation = {
  price: bigint;
  expo: number;
  publishTime: number;
};

const MAGICBLOCK_DISCRIMINATOR = Uint8Array.of(
  234,
  161,
  14,
  36,
  172,
  239,
  15,
  232,
);
/** `magicblock_oracle.rs`: the exponent field of a price of eight decimals. */
const MAGICBLOCK_STORED_DECIMALS = 8;
/** The exponent every market's binding is fixed at. */
export const BOUND_EXPO = -MAGICBLOCK_STORED_DECIMALS;

/** An account as `getAccountInfo` returns it. */
export type RawAccount = { owner: PublicKey; data: Uint8Array };

/**
 * The program's checks on one MagicBlock price account as the rollup serves
 * it: the bound address, the owning program, the size, the discriminator, full
 * verification, the feed (the account's own address), the exponent and a
 * positive price. The account stores its exponent as +8 and is read at the
 * binding's -8. Anything the program would refuse is an error that says which
 * check; nothing here is a looser read of what the program would reject.
 */
export function checkedObservation(
  address: PublicKey,
  account: RawAccount | null,
  bound: PublicKey,
): Observation {
  if (!address.equals(bound)) {
    throw new Error(
      `${address.toBase58()} is not the bound account ${bound.toBase58()}`,
    );
  }
  if (!account)
    throw new Error(`${address.toBase58()} is missing in the rollup`);
  if (!account.owner.equals(MAGICBLOCK_ORACLE_ID)) {
    throw new Error(
      `${address.toBase58()} is owned by ${account.owner.toBase58()}, not ${MAGICBLOCK_ORACLE_ID.toBase58()}`,
    );
  }
  const { data } = account;
  if (data.length !== PRICE_UPDATE_LEN) {
    throw new Error(
      `${address.toBase58()} is ${data.length} bytes, not ${PRICE_UPDATE_LEN}`,
    );
  }
  if (!bytesEqual(data.subarray(0, 8), MAGICBLOCK_DISCRIMINATOR)) {
    throw new Error(`${address.toBase58()} is not a MagicBlock price update`);
  }
  if (data[VERIFICATION_AT] !== FULLY_VERIFIED) {
    throw new Error(`${address.toBase58()} is not fully verified`);
  }
  if (
    !bytesEqual(data.subarray(FEED_ID_AT, FEED_ID_AT + 32), address.toBytes())
  ) {
    throw new Error(`${address.toBase58()} is for another feed`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const stored = view.getInt32(EXPO_AT, true);
  if (stored !== MAGICBLOCK_STORED_DECIMALS) {
    throw new Error(
      `${address.toBase58()} has exponent ${stored}, the binding's is ${BOUND_EXPO}`,
    );
  }
  const price = view.getBigInt64(PRICE_AT, true);
  if (price <= 0n) {
    throw new Error(`${address.toBase58()} has a price of ${price}`);
  }
  return {
    price,
    expo: BOUND_EXPO,
    publishTime: Number(view.getBigInt64(PUBLISH_TIME_AT, true)),
  };
}

/** A price account's observation, or null for anything the program would refuse to read. */
export function observationIn(data: Uint8Array): Observation | null {
  if (data.length !== PRICE_UPDATE_LEN) return null;
  if (!bytesEqual(data.subarray(0, 8), MAGICBLOCK_DISCRIMINATOR)) return null;
  if (data[VERIFICATION_AT] !== FULLY_VERIFIED) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getInt32(EXPO_AT, true) !== MAGICBLOCK_STORED_DECIMALS) return null;
  return {
    price: view.getBigInt64(PRICE_AT, true),
    expo: BOUND_EXPO,
    publishTime: Number(view.getBigInt64(PUBLISH_TIME_AT, true)),
  };
}

/** What a market's price has to satisfy on its first `sync_price`, from its settings. */
export type FirstSyncLimits = {
  /** The market's `max_price_age`. */
  maxPriceAge: number;
  /**
   * The publish time of the market's current mark. The price has to be stamped
   * after it, or the program refuses the sync (`PriceTimeWentBackwards`). Omitted
   * where the caller has no market to compare with.
   */
  markPublishTime?: number;
};

/**
 * RULES 9: why the first `sync_price` would fail, or null when it would pass.
 * The price has to be no older than `maxPriceAge`, not from the future and
 * stamped after the market's current mark (`markPublishTime`, when given).
 */
export function firstSyncFailure(
  observation: Observation,
  clock: number,
  limits: FirstSyncLimits,
): string | null {
  const age = clock - observation.publishTime;
  if (age < 0) return "MagicBlock's price is from the future";
  if (age > limits.maxPriceAge) {
    return `MagicBlock's price is ${age} s old, past max_price_age ${limits.maxPriceAge}`;
  }
  if (
    limits.markPublishTime !== undefined &&
    observation.publishTime <= limits.markPublishTime
  ) {
    return `MagicBlock's price is stamped ${observation.publishTime}, not after the market's current mark at ${limits.markPublishTime}, so the sync would be refused (PriceTimeWentBackwards): wait for a newer publication`;
  }
  return null;
}

/**
 * RULES 9: `price * 10^expo` USD per whole base token in quote atoms per lot,
 * `price * base_lot * 10^(expo + quote_decimals - base_decimals)`, rounded
 * down, as the program scales it.
 */
export function atomsPerLot(
  observation: Pick<Observation, "price" | "expo">,
  lot: Lot,
): bigint {
  const e = observation.expo + lot.quoteDecimals - lot.baseDecimals;
  const units = observation.price * lot.baseLot;
  return e >= 0 ? units * 10n ** BigInt(e) : units / 10n ** BigInt(-e);
}

/** How long each reference source has to answer before it is skipped. */
export const SOURCE_TIMEOUT_MS = 10_000;

/** The widest gap, in basis points of the lower, between the two prices a median of two sources rests on. */
export const SOURCES_AGREE_BPS = 100n;

/** The fewest sources that answered for a reference to stand. */
export const MIN_SOURCES = 2;

/** The lot a price is converted to: quote atoms per lot, as the program scales a mark. */
export type Lot = {
  baseLot: bigint;
  baseDecimals: number;
  quoteDecimals: number;
};

/** A positive decimal price as an integer and its exponent: "106.50" is 10650 at -2. */
export type DecimalPrice = { price: bigint; expo: number };

const DECIMAL = /^(\d{1,18})(?:\.(\d{1,18}))?$/;

/** A price a source gave as a decimal string. Anything else, and zero, is an error. */
export function decimalPrice(text: unknown): DecimalPrice {
  const match = typeof text === "string" ? DECIMAL.exec(text) : null;
  if (!match) {
    throw new Error(
      `the price is not a decimal string: ${JSON.stringify(text)}`,
    );
  }
  const fraction = match[2] ?? "";
  const price = BigInt(match[1] + fraction);
  if (price <= 0n) throw new Error(`the price is ${text}`);
  return { price, expo: -fraction.length };
}

function member(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** Coinbase Exchange's `ticker` answer: the last trade, `price`. */
export function coinbasePrice(answer: unknown): DecimalPrice {
  return decimalPrice(member(answer, "price"));
}

/** Kraken's `Ticker` answer: `c[0]`, the last trade, of the one pair in `result`; a non-empty `error` is a refusal. */
export function krakenPrice(answer: unknown): DecimalPrice {
  const errors = member(answer, "error");
  if (Array.isArray(errors) && errors.length > 0) {
    throw new Error(`Kraken said ${errors.join(", ")}`);
  }
  const result = member(answer, "result");
  const pairs =
    typeof result === "object" && result !== null ? Object.values(result) : [];
  if (pairs.length !== 1) {
    throw new Error(`Kraken gave ${pairs.length} pairs, not one`);
  }
  const closed = member(pairs[0], "c");
  return decimalPrice(Array.isArray(closed) ? closed[0] : undefined);
}

/** Bitstamp's `ticker` answer: the last trade, `last`. */
export function bitstampPrice(answer: unknown): DecimalPrice {
  return decimalPrice(member(answer, "last"));
}

/** The free public exchanges the reference is taken from. Fixed: no key, and no other host on any network. */
export const EXCHANGES: {
  name: string;
  url: string;
  parse: (answer: unknown) => DecimalPrice;
}[] = [
  {
    name: "Coinbase",
    url: "https://api.exchange.coinbase.com/products/SOL-USD/ticker",
    parse: coinbasePrice,
  },
  {
    name: "Kraken",
    url: "https://api.kraken.com/0/public/Ticker?pair=SOLUSD",
    parse: krakenPrice,
  },
  {
    name: "Bitstamp",
    url: "https://www.bitstamp.net/api/v2/ticker/solusd/",
    parse: bitstampPrice,
  },
];

/** One reference source: what it is called and how to ask it for a price in quote atoms per lot. */
export type ReferenceSource = {
  name: string;
  read: () => Promise<{ atoms: bigint; note?: string }>;
};

export type Quote = { name: string; atoms: bigint; note?: string };

/** The sources that answered, in the order given, and why each of the others did not. */
export type Gathered = {
  quotes: Quote[];
  skipped: { name: string; why: string }[];
};

/** Asks every source at once. A failure of one is kept as a reason and never stops the others. */
export async function gatherQuotes(
  sources: ReferenceSource[],
): Promise<Gathered> {
  const settled = await Promise.allSettled(
    sources.map((source) => source.read()),
  );
  const gathered: Gathered = { quotes: [], skipped: [] };
  settled.forEach((outcome, at) => {
    const { name } = sources[at];
    if (outcome.status === "fulfilled") {
      gathered.quotes.push({ name, ...outcome.value });
    } else {
      const why =
        outcome.reason instanceof Error
          ? outcome.reason.message
          : String(outcome.reason);
      gathered.skipped.push({ name, why });
    }
  });
  return gathered;
}

/**
 * The reference price: the median of the answering sources, in quote atoms
 * per lot. Fewer than `MIN_SOURCES` is an error. With an even number the two
 * middle prices must be within `SOURCES_AGREE_BPS` of each other, else it is an
 * error, and the reference is their mean, rounded down; an odd number's
 * median is the middle price itself.
 */
export function referenceOf(quotes: Pick<Quote, "atoms">[]): bigint {
  if (quotes.length < MIN_SOURCES) {
    throw new Error(
      `${quotes.length} reference source${quotes.length === 1 ? "" : "s"} answered, ${MIN_SOURCES} needed`,
    );
  }
  const sorted = quotes
    .map(({ atoms }) => atoms)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (sorted[0] <= 0n)
    throw new Error("a reference source's price is not positive");
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[middle];
  const [low, high] = [sorted[middle - 1], sorted[middle]];
  if ((high - low) * 10_000n > low * SOURCES_AGREE_BPS) {
    throw new Error(
      `the middle two reference prices, ${low} and ${high}, are more than ${SOURCES_AGREE_BPS} bps apart`,
    );
  }
  return (low + high) / 2n;
}

/** The sources of the reference: the free public exchanges. */
export function referenceSources(
  lot: Lot,
  fetcher: typeof fetch = fetch,
): ReferenceSource[] {
  return EXCHANGES.map(({ name, url, parse }) => ({
    name,
    async read() {
      const answer = await fetcher(url, {
        signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
      });
      if (!answer.ok) throw new Error(`${name} answered ${answer.status}`);
      return { atoms: atomsPerLot(parse(await answer.json()), lot) };
    },
  }));
}

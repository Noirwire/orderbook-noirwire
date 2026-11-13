/**
 * Prices as the operator reads them, with no key and no Pyth package: a Pyth
 * price account's observation byte by byte, a price in quote atoms per lot,
 * and the reference a first mark is checked against (the median of free
 * exchange prices, and Pyth Pro's latest for the same feed when a token is
 * given). Importing it touches nothing, and nothing here reads the
 * environment: the caller passes every URL and token.
 */
import type { PublicKey } from "@solana/web3.js";
import { MAGICBLOCK_ORACLE_ID, PYTH_RECEIVER_ID } from "../constants.js";

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

const PYTH_DISCRIMINATOR = Uint8Array.of(34, 241, 35, 99, 157, 126, 244, 205);
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

/** An account as `getAccountInfo` returns it. */
export type RawAccount = { owner: PublicKey; data: Uint8Array };

/** What the program binds a price account to: its address and exponent, and for Pyth its feed id. */
export type PriceBinding = {
  address: PublicKey;
  expo: number;
  /** Pyth only: the feed id the update must carry. */
  feedId?: Uint8Array;
};

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, at) => byte === b[at]);

/**
 * RULES 9 and 9b, the program's checks 1 to 7 and the price above zero, on one
 * account as the rollup serves it: the bound address, the owning program, the
 * size, the discriminator, full verification, the feed, the exponent and a
 * positive price. A MagicBlock account (`kind` "magicblock") stores its exponent
 * as +8 and is read at the binding's -8, with its own address as its feed id and
 * no confidence. Anything the program would refuse is an error that says which
 * check; nothing here is a looser read of what the program would reject.
 */
export function checkedObservation(
  kind: "pyth" | "magicblock",
  address: PublicKey,
  account: RawAccount | null,
  binding: PriceBinding,
): Observation {
  if (!address.equals(binding.address)) {
    throw new Error(
      `${address.toBase58()} is not the bound account ${binding.address.toBase58()}`,
    );
  }
  if (!account)
    throw new Error(`${address.toBase58()} is missing in the rollup`);
  const owner = kind === "pyth" ? PYTH_RECEIVER_ID : MAGICBLOCK_ORACLE_ID;
  if (!account.owner.equals(owner)) {
    throw new Error(
      `${address.toBase58()} is owned by ${account.owner.toBase58()}, not ${owner.toBase58()}`,
    );
  }
  const { data } = account;
  if (data.length !== PRICE_UPDATE_LEN) {
    throw new Error(
      `${address.toBase58()} is ${data.length} bytes, not ${PRICE_UPDATE_LEN}`,
    );
  }
  const discriminator =
    kind === "pyth" ? PYTH_DISCRIMINATOR : MAGICBLOCK_DISCRIMINATOR;
  if (!sameBytes(data.subarray(0, 8), discriminator)) {
    throw new Error(`${address.toBase58()} is not a ${kind} price update`);
  }
  if (data[VERIFICATION_AT] !== FULLY_VERIFIED) {
    throw new Error(`${address.toBase58()} is not fully verified`);
  }
  const feed = data.subarray(FEED_ID_AT, FEED_ID_AT + 32);
  const wanted = kind === "pyth" ? binding.feedId : address.toBytes();
  if (!wanted || !sameBytes(feed, wanted)) {
    throw new Error(`${address.toBase58()} is for another feed`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const stored = view.getInt32(EXPO_AT, true);
  const exponentOk =
    kind === "pyth"
      ? stored === binding.expo
      : stored === MAGICBLOCK_STORED_DECIMALS &&
        binding.expo === -MAGICBLOCK_STORED_DECIMALS;
  if (!exponentOk) {
    throw new Error(
      `${address.toBase58()} has exponent ${stored}, the binding's is ${binding.expo}`,
    );
  }
  const price = view.getBigInt64(PRICE_AT, true);
  if (price <= 0n) {
    throw new Error(`${address.toBase58()} has a price of ${price}`);
  }
  return {
    feedId: hex(feed),
    price,
    conf: kind === "pyth" ? view.getBigUint64(CONF_AT, true) : 0n,
    expo: binding.expo,
    publishTime: Number(view.getBigInt64(PUBLISH_TIME_AT, true)),
  };
}

/** What a market's primary price has to satisfy on its first `sync_price`, from its settings. */
export type PrimaryLimits = {
  /** The market's `max_price_age`. */
  maxPriceAge: number;
  /** The Pyth binding's `max_conf_bps`. */
  maxConfBps: number;
  breakerBps: number;
  breakerAge: number;
  liquidationBand: number;
};

/**
 * RULES 9b: why the first `sync_price` of a primary price, with Pyth beside it,
 * would fail, or null when it would pass. The primary has to be no older than
 * `maxPriceAge` and not from the future. Pyth has to be fresh (at most
 * `breakerAge` old, not from the future, with a confidence within the binding's)
 * and within `breakerBps` of the primary, measured from Pyth's price; a Pyth
 * that is not fresh would leave the first mark unguarded and unbounded, which
 * the program refuses, so binding waits for one.
 */
export function firstSyncFailure(
  primary: Observation,
  pyth: Observation,
  clock: number,
  limits: PrimaryLimits,
): string | null {
  const primaryAge = clock - primary.publishTime;
  if (primaryAge < 0) return "MagicBlock's price is from the future";
  if (primaryAge > limits.maxPriceAge) {
    return `MagicBlock's price is ${primaryAge} s old, past max_price_age ${limits.maxPriceAge}`;
  }
  const pythAge = clock - pyth.publishTime;
  if (pythAge < 0) return "Pyth's price is from the future";
  if (pythAge > limits.breakerAge) {
    return `Pyth's price is ${pythAge} s old, past the breaker age ${limits.breakerAge}`;
  }
  if (pyth.conf * 10_000n > pyth.price * BigInt(limits.maxConfBps)) {
    return `Pyth's confidence ${pyth.conf} is wider than ${limits.maxConfBps} bps of its price`;
  }
  const gap = primary.price - pyth.price;
  const distance = gap < 0n ? -gap : gap;
  if (distance * 10_000n > pyth.price * BigInt(limits.breakerBps)) {
    return `MagicBlock and Pyth are ${(distance * 10_000n) / pyth.price} bps apart, past the breaker's ${limits.breakerBps}`;
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

export const PYTH_PRO = "https://pyth.dourolabs.app";

/**
 * The Pyth Pro the mark is checked against: `given` (the ops scripts'
 * `PYTH_PRO_URL`) on a test network, Pyth's own on mainnet, where another
 * would become the reference that opens the market and would receive the
 * token.
 */
export function referenceUrl(
  mainnet: boolean,
  given: string | undefined,
): string {
  if (!given) return PYTH_PRO;
  if (mainnet) {
    throw new Error(
      `PYTH_PRO_URL is ${given}; mainnet uses ${PYTH_PRO} only. Nothing was sent.`,
    );
  }
  return given;
}

/** A Pyth Pro price of one feed: atoms are `price * 10^expo` USD per whole token. */
export type ReferencePrice = {
  /** The Pyth Pro id of the feed. */
  proId: number;
  price: bigint;
  expo: number;
  publisherCount: number;
  /** Unix seconds. */
  publishTime: number;
};

type ProAnswer = {
  timestampUs: string;
  priceFeeds: {
    priceFeedId: number;
    price?: string;
    exponent?: number;
    publisherCount?: number;
  }[];
};

/**
 * The prices of `proIds` in a Pyth Pro `latest_price` answer. A feed that is
 * missing, has no price or a price that is not positive is an error, never a
 * zero the check could compare against.
 */
export function referencePrices(
  answer: ProAnswer,
  proIds: number[],
): ReferencePrice[] {
  const publishTime = Math.floor(Number(BigInt(answer.timestampUs)) / 1e6);
  return proIds.map((proId) => {
    const feed = answer.priceFeeds.find(
      ({ priceFeedId }) => priceFeedId === proId,
    );
    if (
      !feed ||
      feed.price === undefined ||
      feed.exponent === undefined ||
      feed.publisherCount === undefined
    ) {
      throw new Error(
        `Pyth Pro gave no price, exponent and publisher count for feed ${proId}`,
      );
    }
    const price = BigInt(feed.price);
    if (price <= 0n) {
      throw new Error(`Pyth Pro's price for feed ${proId} is ${price}`);
    }
    return {
      proId,
      price,
      expo: feed.exponent,
      publisherCount: feed.publisherCount,
      publishTime,
    };
  });
}

/**
 * Pyth Pro's latest price of each of `proIds`, from the Pyth Pro at `url`,
 * with `token` (the ops scripts' `PYTH_PRO_TOKEN`) as a bearer token. The
 * token is never printed.
 */
export async function proLatest(
  url: string,
  proIds: number[],
  token: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<ReferencePrice[]> {
  const ids = proIds.map((id) => `price_feed_ids=${id}`).join("&");
  const answer = await fetcher(
    `${url}/v1/latest_price?${ids}&properties=price&properties=exponent&properties=publisherCount&channel=fixed_rate@200ms`,
    {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
    },
  );
  if (!answer.ok) {
    const hint =
      answer.status === 401
        ? ": PYTH_PRO_TOKEN is not accepted; unset it to use the exchanges alone"
        : "";
    throw new Error(
      `Pyth Pro answered ${answer.status} for feeds ${proIds.join(", ")}${hint}`,
    );
  }
  return referencePrices((await answer.json()) as ProAnswer, proIds);
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

/** The sources of the reference: the exchanges, and Pyth Pro too when `pro` carries a token. */
export function referenceSources(
  lot: Lot,
  pro?: { url: string; proId: number; token: string },
  fetcher: typeof fetch = fetch,
): ReferenceSource[] {
  const exchanges = EXCHANGES.map(({ name, url, parse }) => ({
    name,
    async read() {
      const answer = await fetcher(url, {
        signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
      });
      if (!answer.ok) throw new Error(`${name} answered ${answer.status}`);
      return { atoms: atomsPerLot(parse(await answer.json()), lot) };
    },
  }));
  if (!pro?.token) return exchanges;
  return [
    ...exchanges,
    {
      name: "Pyth Pro",
      async read() {
        const [latest] = await proLatest(
          pro.url,
          [pro.proId],
          pro.token,
          fetcher,
        );
        const age = Math.floor(Date.now() / 1000) - latest.publishTime;
        return {
          atoms: atomsPerLot(latest, lot),
          note: `${latest.publisherCount} publishers, published ${age} s ago`,
        };
      },
    },
  ];
}

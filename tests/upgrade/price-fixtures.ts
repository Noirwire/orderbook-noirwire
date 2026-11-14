/**
 * The four price accounts the in-place upgrade test reads, as bytes: the
 * earlier build's Pyth price update accounts for SOL/USD and USDC/USD, and
 * MagicBlock's oracle accounts for the same two feeds that the current build
 * reads. The local network has neither oracle, so `make test-upgrade` writes
 * these as account files and loads them into the validator at genesis, each
 * owned by the program that owns the real account, with a publish time just
 * before the run. They never change, so each is synced once.
 */
import { PublicKey } from "@solana/web3.js";
import {
  MAGICBLOCK_ORACLE_ID,
  magicblockPriceAccount,
} from "../../sdk/dist/index.js";
import { MAINNET_PRICE_FEEDS } from "../../ops/deployment";

/** The Pyth receiver program, owner of every Pyth price update account. */
const PYTH_RECEIVER_ID = new PublicKey(
  "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ",
);
/** The Pyth push oracle, whose shard 0 address for a feed id is its price account. */
const PYTH_PUSH_ORACLE_ID = new PublicKey(
  "pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT",
);

export const PYTH_SOL_FEED_ID = Buffer.from(
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  "hex",
);
export const PYTH_USDC_FEED_ID = Buffer.from(
  "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
  "hex",
);

const PRICE_UPDATE_LEN = 134;
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
const VERIFICATION_AT = 40;
const FEED_ID_AT = 41;
const PRICE_AT = 73;
const CONF_AT = 81;
const EXPO_AT = 89;
export const PUBLISH_TIME_AT = 93;
const PREVIOUS_PUBLISH_TIME_AT = 101;
const FULLY_VERIFIED = 1;
const PYTH_EXPO = -8;
const MAGICBLOCK_STORED_EXPO = 8;
const FIXTURE_LAMPORTS = 2_000_000;

/**
 * Prices at eight decimals. In a market of 0.001 SOL lots in six-decimal
 * dollars, a SOL price of $150 is 150,000 quote atoms per lot; MagicBlock's is
 * 1% above Pyth's, inside the market's move limit.
 */
export const PRICES = {
  pythSol: 15_000_000_000n,
  pythUsdc: 99_980_000n,
  magicblockSol: 15_150_000_000n,
  magicblockUsdc: 99_990_000n,
};
/** What `PRICES` come to as marks, in quote atoms per lot. */
export const MARKS = { pyth: 150_000n, magicblock: 151_500n };

/** The Pyth push oracle's account for a feed id. */
export function pythPriceAccount(feedId: Uint8Array): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Uint8Array.of(0, 0), feedId],
    PYTH_PUSH_ORACLE_ID,
  )[0];
}

function priceUpdate(
  discriminator: Uint8Array,
  feedId: Uint8Array,
  price: bigint,
  conf: bigint,
  expo: number,
  publishTime: number,
): Buffer {
  const data = Buffer.alloc(PRICE_UPDATE_LEN);
  data.set(discriminator, 0);
  data[VERIFICATION_AT] = FULLY_VERIFIED;
  data.set(feedId, FEED_ID_AT);
  data.writeBigInt64LE(price, PRICE_AT);
  data.writeBigUInt64LE(conf, CONF_AT);
  data.writeInt32LE(expo, EXPO_AT);
  data.writeBigInt64LE(BigInt(publishTime), PUBLISH_TIME_AT);
  data.writeBigInt64LE(BigInt(publishTime - 1), PREVIOUS_PUBLISH_TIME_AT);
  return data;
}

export type PriceFixture = {
  address: PublicKey;
  owner: PublicKey;
  data: Buffer;
};

/**
 * The four accounts. The Pyth ones are stamped `publishedAt` and MagicBlock's
 * two seconds later, so MagicBlock's price is stamped after the mark a Pyth
 * sync leaves, as the program requires of any next price.
 */
export function priceFixtures(publishedAt: number) {
  const magicblock = (feed: number, price: bigint): PriceFixture => {
    const address = magicblockPriceAccount(feed);
    return {
      address,
      owner: MAGICBLOCK_ORACLE_ID,
      data: priceUpdate(
        MAGICBLOCK_DISCRIMINATOR,
        address.toBytes(),
        price,
        0n,
        MAGICBLOCK_STORED_EXPO,
        publishedAt + 2,
      ),
    };
  };
  const pyth = (
    feedId: Uint8Array,
    price: bigint,
    conf: bigint,
  ): PriceFixture => ({
    address: pythPriceAccount(feedId),
    owner: PYTH_RECEIVER_ID,
    data: priceUpdate(
      PYTH_DISCRIMINATOR,
      feedId,
      price,
      conf,
      PYTH_EXPO,
      publishedAt,
    ),
  });
  return {
    pythSol: pyth(PYTH_SOL_FEED_ID, PRICES.pythSol, 1_000_000n),
    pythUsdc: pyth(PYTH_USDC_FEED_ID, PRICES.pythUsdc, 10_000n),
    magicblockSol: magicblock(
      MAINNET_PRICE_FEEDS.solUsd.feed,
      PRICES.magicblockSol,
    ),
    magicblockUsdc: magicblock(
      MAINNET_PRICE_FEEDS.usdcUsd.feed,
      PRICES.magicblockUsdc,
    ),
  };
}

/** An account in the file form `solana-test-validator --account` loads. */
export function accountFile({ address, owner, data }: PriceFixture) {
  return {
    pubkey: address.toBase58(),
    account: {
      lamports: FIXTURE_LAMPORTS,
      data: [data.toString("base64"), "base64"],
      owner: owner.toBase58(),
      executable: false,
      rentEpoch: 0,
      space: data.length,
    },
  };
}

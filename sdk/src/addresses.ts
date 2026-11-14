import { PublicKey } from "@solana/web3.js";
import {
  deriveEphemeralAta,
  permissionPdaFromAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  LEGACY_LEDGER_SEED,
  MAGICBLOCK_ORACLE_ID,
  PROGRAM_ID,
  SEEDS,
  TOKEN_PROGRAM_ID,
  TRIGGER_SEED,
  UPGRADEABLE_LOADER_ID,
} from "./constants.js";
import { randomU64 } from "./internal/random.js";

const encoder = new TextEncoder();
const seed = (text: string) => encoder.encode(text);

const pda = (programId: PublicKey, ...seeds: Uint8Array[]) =>
  PublicKey.findProgramAddressSync(
    seeds.map((bytes) => Buffer.from(bytes)),
    programId,
  )[0];

const u64Le = (value: bigint) => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
};

/**
 * A token as its custody knows it: the mint and the nonce the admin chose
 * for its custody authority when registering it. A registered `TokenInfo`
 * is one.
 */
export type CustodyToken = { mint: PublicKey; custodyNonce: bigint };

/**
 * A custody nonce of 64 random bits. Security: anyone can claim a custody
 * balance before the admin does, if they know its address. Keep the nonce
 * private until its custody balance is created and delegated.
 */
export function randomCustodyNonce(): bigint {
  return randomU64();
}

/** Every address the program derives, for one program id. */
export class Addresses {
  constructor(readonly programId: PublicKey = PROGRAM_ID) {}

  get exchange(): PublicKey {
    return pda(this.programId, seed(SEEDS.exchange));
  }

  /** The key that owns the custody token account of a token registered with `nonce`. */
  custodyAuthority(nonce: bigint): PublicKey {
    return pda(this.programId, seed(SEEDS.custody), u64Le(nonce));
  }

  get ledger(): PublicKey {
    return pda(this.programId, seed(SEEDS.ledger));
  }

  /** The ledger the exchange was first built with; only the relayout reads it. */
  get legacyLedger(): PublicKey {
    return pda(this.programId, seed(LEGACY_LEDGER_SEED));
  }

  get stats(): PublicKey {
    return pda(this.programId, seed(SEEDS.stats));
  }

  get programData(): PublicKey {
    return pda(UPGRADEABLE_LOADER_ID, this.programId.toBytes());
  }

  market(marketId: number): PublicKey {
    return pda(this.programId, seed(SEEDS.market), Uint8Array.of(marketId));
  }

  book(marketId: number): PublicKey {
    return pda(this.programId, seed(SEEDS.book), Uint8Array.of(marketId));
  }

  tape(marketId: number): PublicKey {
    return pda(this.programId, seed(SEEDS.tape), Uint8Array.of(marketId));
  }

  /** The sealed trigger book of a market, which every order-key instruction on that market names. */
  triggers(marketId: number): PublicKey {
    return pda(this.programId, seed(TRIGGER_SEED), Uint8Array.of(marketId));
  }

  priceFeed(marketId: number): PublicKey {
    return pda(this.programId, seed(SEEDS.price), Uint8Array.of(marketId));
  }

  view(owner: PublicKey): PublicKey {
    return pda(this.programId, seed(SEEDS.view), owner.toBytes());
  }

  /** The custody token account of `token`: its custody authority's associated token account. */
  custody({ mint, custodyNonce }: CustodyToken): PublicKey {
    return associatedTokenAddress(this.custodyAuthority(custodyNonce), mint);
  }

  /** The ephemeral token balance behind the custody account of `token`. */
  custodyBalance({ mint, custodyNonce }: CustodyToken): PublicKey {
    return deriveEphemeralAta(this.custodyAuthority(custodyNonce), mint)[0];
  }

  /**
   * The permission that keeps the custody balance of `token` private.
   * `register_token` refuses a sealed token without it and a public one
   * with it.
   */
  custodyPermission(token: CustodyToken): PublicKey {
    return permissionPdaFromAccount(this.custodyBalance(token));
  }

  /** The three accounts a market contributes to a cross-margin risk read. */
  riskAccounts(marketId: number): PublicKey[] {
    return [
      this.market(marketId),
      this.book(marketId),
      this.priceFeed(marketId),
    ];
  }
}

/**
 * RULES 9: MagicBlock's price account for the provider's feed number (SOL/USD
 * is 6, USDC/USD is 7), the oracle program's address for the seeds
 * `price_feed`, `pyth-lazer` and the number in decimal. A market or the USDC
 * guard bound to the feed reads this account and no other. It is live only
 * inside the rollup: Solana holds a stale copy under the delegation program.
 */
export function magicblockPriceAccount(feed: number): PublicKey {
  return pda(
    MAGICBLOCK_ORACLE_ID,
    seed("price_feed"),
    seed("pyth-lazer"),
    seed(String(feed)),
  );
}

export function associatedTokenAddress(
  owner: PublicKey,
  mint: PublicKey,
): PublicKey {
  return pda(
    ASSOCIATED_TOKEN_PROGRAM_ID,
    owner.toBytes(),
    TOKEN_PROGRAM_ID.toBytes(),
    mint.toBytes(),
  );
}

import { PublicKey } from "@solana/web3.js";
import {
  deriveEphemeralAta,
  permissionPdaFromAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  LEGACY_LEDGER_SEED,
  PROGRAM_ID,
  PYTH_PUSH_ORACLE_ID,
  SEEDS,
  TOKEN_PROGRAM_ID,
  UPGRADEABLE_LOADER_ID,
} from "./constants.js";

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
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return new DataView(bytes.buffer).getBigUint64(0, true);
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
 * RULES 9: the Pyth price account of a 32-byte feed id, the push oracle's
 * shard 0 address for it. A market or the USDC guard bound to the feed reads
 * this account and no other.
 */
export function pythPriceAccount(feedId: Uint8Array): PublicKey {
  return pda(PYTH_PUSH_ORACLE_ID, Uint8Array.of(0, 0), feedId);
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

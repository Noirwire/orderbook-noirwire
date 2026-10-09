import { PublicKey } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  PROGRAM_ID,
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

/** Every address the program derives, for one program id. */
export class Addresses {
  constructor(readonly programId: PublicKey = PROGRAM_ID) {}

  get exchange(): PublicKey {
    return pda(this.programId, seed(SEEDS.exchange));
  }

  /** The key that owns every custody token account. */
  get custodyAuthority(): PublicKey {
    return pda(this.programId, seed(SEEDS.custody));
  }

  get ledger(): PublicKey {
    return pda(this.programId, seed(SEEDS.ledger));
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

  /** The custody token account of `mint`: the custody authority's associated token account. */
  custody(mint: PublicKey): PublicKey {
    return associatedTokenAddress(this.custodyAuthority, mint);
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

import type { Connection, PublicKey } from "@solana/web3.js";
import {
  decodePriceFeed,
  decodeStats,
  decodeTape,
  type PriceFeed,
  type Stats,
  type Tape,
} from "./accounts.js";
import { Addresses } from "./addresses.js";
import { PROGRAM_ID } from "./constants.js";
import { subscribe } from "./internal/accountSubscription.js";

export type Unsubscribe = () => Promise<void>;

/** Public reads and subscriptions, for any connection to the rollup or the filter. */
export class MarketReader {
  readonly addresses: Addresses;

  constructor(
    readonly connection: Connection,
    programId: PublicKey = PROGRAM_ID,
  ) {
    this.addresses = new Addresses(programId);
  }

  private async read<T>(
    address: PublicKey,
    decode: (data: Uint8Array) => T,
  ): Promise<T> {
    const account = await this.connection.getAccountInfo(address);
    if (!account) throw new Error(`${address.toBase58()} is not readable here`);
    return decode(account.data);
  }

  tape(marketId: number): Promise<Tape> {
    return this.read(this.addresses.tape(marketId), decodeTape);
  }

  priceFeed(marketId: number): Promise<PriceFeed> {
    return this.read(this.addresses.priceFeed(marketId), decodePriceFeed);
  }

  stats(): Promise<Stats> {
    return this.read(this.addresses.stats, decodeStats);
  }

  subscribeTape(marketId: number, onChange: (tape: Tape) => void): Unsubscribe {
    return subscribe(
      this.connection,
      this.addresses.tape(marketId),
      decodeTape,
      onChange,
    );
  }

  subscribePriceFeed(
    marketId: number,
    onChange: (feed: PriceFeed) => void,
  ): Unsubscribe {
    return subscribe(
      this.connection,
      this.addresses.priceFeed(marketId),
      decodePriceFeed,
      onChange,
    );
  }

  subscribeStats(onChange: (stats: Stats) => void): Unsubscribe {
    return subscribe(
      this.connection,
      this.addresses.stats,
      decodeStats,
      onChange,
    );
  }
}

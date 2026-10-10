import type { Connection } from "@solana/web3.js";

export type Blockhash = Awaited<ReturnType<Connection["getLatestBlockhash"]>>;

/**
 * A rollup blockhash stays valid for about a minute. One is fetched every
 * `BLOCKHASH_REFRESH_MS` in the background and signed with until it is
 * `USABLE_FOR_MS` old, so placing an order asks for none.
 */
export const BLOCKHASH_REFRESH_MS = 15_000;
const USABLE_FOR_MS = 30_000;

export class BlockhashCache {
  private latest?: { value: Blockhash; at: number };
  private fetching?: Promise<Blockhash>;

  constructor(private readonly connection: Connection) {}

  refresh(): Promise<Blockhash> {
    this.fetching ??= this.connection
      .getLatestBlockhash("confirmed")
      .then((value) => {
        this.latest = { value, at: Date.now() };
        return value;
      })
      .finally(() => {
        this.fetching = undefined;
      });
    return this.fetching;
  }

  async current(): Promise<Blockhash> {
    return this.latest && Date.now() - this.latest.at < USABLE_FOR_MS
      ? this.latest.value
      : this.refresh();
  }
}

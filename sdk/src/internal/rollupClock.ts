import type { Connection } from "@solana/web3.js";
import { clockOf } from "../transactions.js";

const deviceSeconds = () => Math.floor(Date.now() / 1000);

/** The rollup's clock, kept as an offset from this device's between reads. */
export class RollupClock {
  private measuredAt = 0;
  private secondsAhead?: number;

  constructor(private readonly connection: Connection) {}

  get measured(): boolean {
    return this.secondsAhead !== undefined;
  }

  olderThan(ms: number): boolean {
    return Date.now() - this.measuredAt > ms;
  }

  async read(): Promise<number> {
    const clock = await clockOf(this.connection);
    this.secondsAhead = clock - deviceSeconds();
    this.measuredAt = Date.now();
    return clock;
  }

  estimate = (): number => deviceSeconds() + (this.secondsAhead ?? 0);
}

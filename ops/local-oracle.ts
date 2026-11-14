/**
 * Keeps the marks of a test network fresh. Under the test profile a mark is
 * written only by the oracle key through `publish_price`, and the program
 * refuses orders on one older than the market's `max_price_age`. Every
 * `LOCAL_ORACLE_EVERY_MS` (2,000 by default) this publishes each perp market's
 * current mark again, stamped with the rollup's clock. It moves no price and
 * takes none from anywhere: a market whose mark is not set is refused, and
 * setting it stays `network.ts setup`'s job.
 *
 * It refuses the mainnet profile and any network that is mainnet. A round
 * that fails (an endpoint's error, a refused send, a deadline) is logged once
 * and the next round goes on; only a wrong setup (a missing oracle key, an
 * unset mark) stops it.
 *
 * The Makefile is the way in (`make local-oracle`).
 */
import { clockOf, type PriceFeed } from "../sdk/dist/index.js";
import {
  errorLine,
  existingKey,
  rollupIsRunBy,
  run,
  sendingAs,
  type Target,
} from "./deployment";
import { at } from "./heartbeat";
import { perpMarketIds, priceFeedInRollup } from "./market";
import { send, sleep } from "./sending";
import { positiveInteger, roundErrorKind, withDeadline } from "./upkeep";

const EVERY_MS = 2_000;
const MAX_EVERY_MS = 60_000;
const DEADLINE_SECONDS = 15;

/** The pause between rounds, `LOCAL_ORACLE_EVERY_MS` or two seconds. */
export const oracleEveryMs = (value: string | undefined) =>
  positiveInteger("LOCAL_ORACLE_EVERY_MS", value, EVERY_MS, MAX_EVERY_MS);

/** Why this network's marks must not be written here, or null. */
export function oracleRefusal(on: {
  profile: string;
  mainnet: boolean;
}): string | null {
  if (on.mainnet || on.profile === "mainnet") {
    return "The local oracle writes marks the test profile takes from its oracle key, and mainnet's come from Pyth. Nothing was sent.";
  }
  return null;
}

/** What a round reads and sends, apart from the network. */
export type OracleRig = {
  marketIds: () => Promise<number[]>;
  feedOf: (marketId: number) => Promise<Pick<PriceFeed, "price"> | null>;
  clock: () => Promise<number>;
  publish: (marketId: number, price: bigint, time: bigint) => Promise<void>;
};

/**
 * One round: every market's current mark published again at the rollup's
 * clock. A market with no mark refuses the round before anything is sent.
 * Each market is tried even when another one's publish fails, and the round
 * then reports every failure in one error.
 */
export async function restampRound(rig: OracleRig): Promise<void> {
  const ids = await rig.marketIds();
  const feeds = await Promise.all(ids.map((id) => rig.feedOf(id)));
  const unset = ids.filter((_, index) => !feeds[index]?.price);
  if (unset.length > 0) {
    throw new Error(
      `Market ${unset.join(", ")} has no mark to publish again. Set it up first. Nothing was sent.`,
    );
  }
  const time = BigInt(await rig.clock());
  const failures: string[] = [];
  for (const [index, id] of ids.entries()) {
    try {
      await rig.publish(id, feeds[index]!.price, time);
    } catch (error) {
      failures.push(`market ${id}: ${errorLine(error)}`);
    }
  }
  if (failures.length > 0) throw new Error(failures.join("; "));
}

/**
 * Runs rounds every `everyMs` until a round says the setup is wrong. A failed
 * round is passed to `failed` and the loop goes on.
 */
export async function keepStamping(
  round: () => Promise<void>,
  everyMs: number,
  failed: (error: unknown) => void,
  pause: (ms: number) => Promise<unknown> = sleep,
  times = Infinity,
): Promise<void> {
  for (let done = 0; done < times; done += 1) {
    try {
      await round();
    } catch (error) {
      if (roundErrorKind(error) === "fatal") throw error;
      failed(error);
    }
    await pause(everyMs);
  }
}

async function localOracle(on: Target): Promise<void> {
  const refusal = oracleRefusal(on);
  if (refusal) throw new Error(refusal);
  const everyMs = oracleEveryMs(process.env.LOCAL_ORACLE_EVERY_MS);
  await rollupIsRunBy(on);
  const oracle = existingKey(on, "oracle");
  const asOracle = await sendingAs(on, oracle);
  const rig: OracleRig = {
    marketIds: () => perpMarketIds(on),
    feedOf: (id) => priceFeedInRollup(on, id),
    clock: () => clockOf(on.rollup),
    publish: async (id, price, time) => {
      await send(
        asOracle,
        on.instructions.publishPrice(oracle.publicKey, id, price, time),
        oracle,
      );
    },
  };
  console.log(
    `${at()} publishing every mark of ${on.network} again every ${everyMs} ms as ${oracle.publicKey.toBase58()}`,
  );
  await keepStamping(
    () => withDeadline("The round", DEADLINE_SECONDS, () => restampRound(rig)),
    everyMs,
    (error) => console.log(`${at()} round failed: ${errorLine(error)}`),
  );
}

if (require.main === module) run(localOracle);

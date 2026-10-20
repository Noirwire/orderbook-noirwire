/**
 * Audit, price feed. Two proofs that need the local network.
 *
 * Runs as part of the story in `tests/orderbook.test.ts`, after
 * `./orderbook/set-up` (it needs the spot market, the oracle key and the admin of
 * `world.ts`). To run it, add `import "./audit/oracle-burst-and-reset";` as the
 * last import there. It leaves the spot market at MARK, fresh and active.
 *
 * Both tests assert the property RULES 9 states and FAIL today:
 * 1. One transaction carrying several `publish_price` instructions, stamped one
 *    publish gap apart in the past, moves the mark several move limits at once.
 * 2. `reset_price` accepts a publish time in the future; the oracle then cannot
 *    publish at all until the rollup clock reaches it.
 */
import { expect } from "chai";
import { MARKET_STATUS, decodePriceFeed } from "../../sdk/dist/index.js";
import {
  addresses,
  admin,
  inPublic,
  instructions,
  publicMarket,
  rollup,
  rollupNow,
  send,
  until,
} from "../support";
import { MARK, SPOT, oracle, refuses } from "../orderbook/world";

const BPS = 10_000n;
const STEP = 3_000n;
const STEPS = 5n;

const feed = async () =>
  decodePriceFeed(await inPublic(addresses.priceFeed(SPOT)));

/** Waits until the rollup clock is at least `seconds` past the feed's last stamp. */
async function slack(seconds: bigint): Promise<bigint> {
  const last = (await feed()).publishTime;
  await until(
    async () => BigInt(await rollupNow()) >= last + seconds,
    "the rollup clock to leave room for a burst",
    60_000,
    100,
  );
  return last;
}

/** One transaction: `STEPS` prices, each `direction * STEP` from the last, stamped a second apart. */
function burst(from: bigint, firstStamp: bigint, direction: 1n | -1n) {
  return Array.from({ length: Number(STEPS) }, (_, index) => {
    const step = BigInt(index) + 1n;
    return instructions.publishPrice(
      oracle.publicKey,
      SPOT,
      from + direction * step * STEP,
      firstStamp + step,
    );
  });
}

describe("audit: the price feed", () => {
  it("moves the mark by at most one move limit per publish gap of rollup time", async () => {
    const limitBps = BigInt((await publicMarket(SPOT)).params.maxMoveBps);
    const last = await slack(STEPS);
    const before = (await feed()).price;
    expect(before).to.equal(MARK);

    await send(rollup, burst(before, last, -1n), oracle);

    const after = await feed();
    const movedBps = ((before - after.price) * BPS) / before;
    const restoreFrom = await slack(STEPS);
    await send(rollup, burst(after.price, restoreFrom, 1n), oracle);
    expect((await feed()).price).to.equal(MARK);
    expect(
      movedBps <= limitBps,
      `RULES 9: one transaction moved the mark ${before} -> ${after.price} ` +
        `(${movedBps} bps, limit ${limitBps} bps per publish gap)`,
    ).to.equal(true);
  });

  it("does not let a reset stamp the feed in the future", async () => {
    await slack(1n);
    const now = BigInt(await rollupNow());
    const inMilliseconds = now * 1_000n;
    let futureResetLanded = true;
    try {
      await send(
        rollup,
        instructions.resetPrice(admin.publicKey, SPOT, MARK, inMilliseconds),
        admin,
      );
    } catch {
      futureResetLanded = false;
    }
    if (futureResetLanded) {
      await refuses(
        send(
          rollup,
          instructions.publishPrice(oracle.publicKey, SPOT, MARK, now + 1n),
          oracle,
        ),
        "PriceTimeWentBackwards",
        "the oracle cannot publish after a reset stamped in the future",
      );
      const repair = BigInt(await rollupNow());
      await send(
        rollup,
        instructions.resetPrice(admin.publicKey, SPOT, MARK, repair),
        admin,
      );
    }
    if ((await publicMarket(SPOT)).params.status !== MARKET_STATUS.active) {
      await send(
        rollup,
        instructions.resumeMarket(admin.publicKey, SPOT),
        admin,
      );
    }
    expect((await publicMarket(SPOT)).params.status).to.equal(
      MARKET_STATUS.active,
    );
    expect(
      futureResetLanded,
      `RULES 9: reset_price accepted publish time ${inMilliseconds} with the rollup clock at ${now}`,
    ).to.equal(false);
  });
});

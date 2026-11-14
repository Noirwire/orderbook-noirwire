/**
 * Binds the launch market's mark to MagicBlock's SOL/USD price, with its bound
 * Pyth account as the circuit breaker (RULES 9b), with `set_mark_source`:
 *
 *   [BREAKER_BPS=<bps>] [BREAKER_AGE=<s>] [LIQUIDATION_BAND=<bps>] [APPLY=yes]
 *                                       bind it: the limit 400 bps, the age 90 s
 *                                       and the liquidation band 150 bps unless given
 *   REMOVE=yes [APPLY=yes]              take it away: the mark follows Pyth alone
 *                                       (the exchange must be paused first; it stays
 *                                       paused until a fresh Pyth mark is synced)
 *
 * It first reads both accounts as the rollup serves them and checks each one as
 * the program does (address, owner, size, discriminator, verification, feed,
 * exponent, a positive price), then the age of each and the breaker's limit, as
 * the market's first `sync_price` would, including that MagicBlock's publish time
 * is later than the market's current mark. It shows each one's age and how far
 * apart they are, and refuses to bind when that sync would fail. It sends nothing
 * unless APPLY=yes, and stops unless the market is the one the launch sets up.
 * The market may be live: the mark does not move by this call.
 *
 * The Makefile is the way in (`make rehearsal-set-mark-source`,
 * `make mainnet-set-mark-source`). Once the admin role has moved to a hardware
 * wallet this command cannot send as it.
 */
import {
  clockOf,
  decodeMarket,
  magicblockPriceAccount,
} from "../sdk/dist/index.js";
import {
  MAINNET_MARK_SOURCE,
  checkedObservation,
  firstSyncFailure,
} from "../sdk/dist/operator/index.js";
import {
  adminKeyPath,
  launchMarket,
  rollupIsRunBy,
  run,
  sendingAs,
} from "./deployment";
import { adminRefusal } from "./handover";
import { heldKey } from "./keys";
import { shown } from "./leaving";
import { exchangeInRollup, launchedMarket } from "./market";
import { markSourceRequest, removalRefusal } from "./marksource";
import { deployedAsBuilt } from "./program";
import { send, until } from "./sending";

const described = (market: ReturnType<typeof decodeMarket>) =>
  market.markFeed === 0
    ? "the mark follows Pyth alone"
    : `feed ${market.markFeed}, limit ${market.breakerBps} bps, age ${market.breakerAge} s, liquidation band ${market.liquidationBand} bps`;

run(async (on) => {
  if (on.profile !== "mainnet") {
    throw new Error(
      "Only the mainnet profile's market has a primary price to bind. Nothing was sent.",
    );
  }
  const request = markSourceRequest(process.env);
  await deployedAsBuilt(on);
  await rollupIsRunBy(on);
  const { id, symbol } = launchMarket(on.insurance);
  const { params, feed } = await launchedMarket(on);
  const primaryAccount = magicblockPriceAccount(MAINNET_MARK_SOURCE.markFeed);
  if (!primaryAccount.equals(MAINNET_MARK_SOURCE.account)) {
    throw new Error(
      `The feed number ${MAINNET_MARK_SOURCE.markFeed} is ${primaryAccount.toBase58()}, not the profile's ${MAINNET_MARK_SOURCE.account.toBase58()}. Nothing was sent.`,
    );
  }
  const [primary, guard, clock] = await Promise.all([
    on.rollup.getAccountInfo(primaryAccount),
    on.rollup.getAccountInfo(feed.binding.account),
    clockOf(on.rollup),
  ]);
  const market = decodeMarket(
    (await on.rollup.getAccountInfo(on.instructions.addresses.market(id)))!
      .data,
  );
  const read = (read: () => ReturnType<typeof checkedObservation>) => {
    try {
      return { observation: read(), why: null };
    } catch (error) {
      return {
        observation: null,
        why: error instanceof Error ? error.message : String(error),
      };
    }
  };
  const mark = read(() =>
    checkedObservation("magicblock", primaryAccount, primary, {
      address: primaryAccount,
      expo: feed.binding.expo,
    }),
  );
  const pyth = read(() =>
    checkedObservation("pyth", feed.binding.account, guard, {
      address: feed.binding.account,
      expo: feed.binding.expo,
      feedId: feed.binding.feedId,
    }),
  );

  shown("network", `${on.network}, program ${on.instructions.programId}`);
  shown("now", described(market));
  shown(
    "MagicBlock",
    mark.observation
      ? `${mark.observation.price} at exponent ${mark.observation.expo}, ${clock - mark.observation.publishTime} s old, ${primaryAccount.toBase58()}`
      : `unreadable: ${mark.why}`,
  );
  shown(
    "Pyth breaker",
    pyth.observation
      ? `${pyth.observation.price} at exponent ${pyth.observation.expo}, ${clock - pyth.observation.publishTime} s old, ${feed.binding.account.toBase58()}`
      : `unreadable: ${pyth.why}`,
  );
  if (mark.observation && pyth.observation) {
    const gap = mark.observation.price - pyth.observation.price;
    const bps = ((gap < 0n ? -gap : gap) * 10_000n) / pyth.observation.price;
    shown("apart", `${bps} bps now`);
    if (bps > BigInt(request.liquidationBand)) {
      shown(
        "liquidation",
        `the two are past the ${request.liquidationBand} bps band, so no liquidation would be done right now`,
      );
    }
  }
  shown(
    "will be",
    request.markFeed === 0
      ? "no primary price: the mark follows Pyth alone"
      : `feed ${request.markFeed}, limit ${request.breakerBps} bps, age ${request.breakerAge} s, liquidation band ${request.liquidationBand} bps`,
  );
  const paused = removalRefusal(
    request,
    market,
    (await exchangeInRollup(on)).paused,
  );
  if (paused) throw new Error(paused);
  if (request.markFeed !== 0) {
    if (!mark.observation || !pyth.observation) {
      throw new Error(
        "A primary price is bound only while both accounts read as the program reads them. Nothing was sent.",
      );
    }
    const failure = firstSyncFailure(
      mark.observation,
      pyth.observation,
      clock,
      {
        maxPriceAge: Number(params.maxPriceAge),
        maxConfBps: feed.binding.maxConfBps,
        breakerBps: request.breakerBps,
        breakerAge: request.breakerAge,
        liquidationBand: request.liquidationBand,
        markPublishTime: Number(feed.publishTime),
      },
    );
    if (failure) {
      throw new Error(
        `The market's first sync after binding would fail: ${failure}. Nothing was sent.`,
      );
    }
  }
  if (request.markFeed !== 0) {
    shown(
      "then",
      `shorten the price ages from the console's update market: max_price_age ${params.maxPriceAge} s to 10 and max_age_liquidation ${params.maxAgeLiquidation} s to 15 (docs/LAUNCH.md, step 6 of the primary price's upgrade). This command does not send it.`,
    );
  }
  if (!request.apply) {
    console.log(
      "Dry run: nothing was sent. Run again with APPLY=yes to send it.",
    );
    return;
  }

  const keyFile = adminKeyPath(on);
  const admin = heldKey(keyFile);
  const wrongAdmin = adminRefusal(
    (await exchangeInRollup(on)).admin,
    admin.publicKey,
    keyFile,
  );
  if (wrongAdmin) throw new Error(wrongAdmin);
  shown(
    "signature",
    await send(
      await sendingAs(on, admin),
      on.instructions.setMarkSource(
        admin.publicKey,
        id,
        request.markFeed,
        request.breakerBps,
        request.breakerAge,
        request.liquidationBand,
      ),
      admin,
    ),
  );
  const bound = await until(async () => {
    const account = await on.rollup.getAccountInfo(
      on.instructions.addresses.market(id),
    );
    const now = account && decodeMarket(account.data);
    return now &&
      now.markFeed === request.markFeed &&
      now.breakerBps === request.breakerBps &&
      now.breakerAge === request.breakerAge &&
      now.liquidationBand === request.liquidationBand
      ? now
      : null;
  }, `${symbol} to read back with the new primary price`);
  shown(symbol, described(bound));
});

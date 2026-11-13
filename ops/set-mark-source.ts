/**
 * Binds the launch market's mark to MagicBlock's SOL/USD price, with its bound
 * Pyth account as the guard (RULES 9b), with `set_mark_source`:
 *
 *   [GUARD_BPS=<bps>] [GUARD_WINDOW=<s>] [APPLY=yes]
 *                                       bind it, the band's base 100 bps and the
 *                                       guard's window 10 s unless given
 *   REMOVE=yes [APPLY=yes]              take it away: the mark follows Pyth alone
 *
 * It first reads both accounts as the rollup serves them and shows each one's
 * age and how far apart they are, so the band is chosen on what the two say now.
 * It sends nothing unless APPLY=yes, and stops unless the market is the one the
 * launch sets up. The market may be live: the mark does not move by this call.
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
  observationIn,
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
import { markSourceRequest } from "./marksource";
import { deployedAsBuilt } from "./program";
import { send, until } from "./sending";

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
  const { feed } = await launchedMarket(on);
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
  const read = (account: typeof primary) =>
    account ? observationIn(account.data) : null;
  const mark = read(primary);
  const pyth = read(guard);
  const market = decodeMarket(
    (await on.rollup.getAccountInfo(on.instructions.addresses.market(id)))!
      .data,
  );

  shown("network", `${on.network}, program ${on.instructions.programId}`);
  shown(
    "now",
    market.markFeed === 0
      ? "the mark follows Pyth alone"
      : `feed ${market.markFeed}, band ${market.guardBps} bps, guard window ${market.guardWindow} s`,
  );
  shown(
    "MagicBlock",
    mark
      ? `${mark.price} at exponent ${mark.expo}, ${clock - mark.publishTime} s old, ${primaryAccount.toBase58()}`
      : `${primaryAccount.toBase58()} is missing or unreadable in the rollup`,
  );
  shown(
    "Pyth guard",
    pyth
      ? `${pyth.price} at exponent ${pyth.expo}, ${clock - pyth.publishTime} s old, ${feed.binding.account.toBase58()}`
      : `${feed.binding.account.toBase58()} is missing or unreadable in the rollup`,
  );
  if (mark && pyth && pyth.price > 0n) {
    const gap = mark.price - pyth.price;
    const bps = ((gap < 0n ? -gap : gap) * 10_000n) / pyth.price;
    shown("apart", `${bps} bps now`);
  }
  shown(
    "will be",
    request.markFeed === 0
      ? "no primary price: the mark follows Pyth alone"
      : `feed ${request.markFeed}, band ${request.guardBps} bps, guard window ${request.guardWindow} s`,
  );
  if (request.markFeed !== 0 && (!mark || !pyth)) {
    throw new Error(
      "A primary price is bound only while both accounts read. Nothing was sent.",
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
        request.guardBps,
        request.guardWindow,
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
      now.guardBps === request.guardBps &&
      now.guardWindow === request.guardWindow
      ? now
      : null;
  }, `${symbol} to read back with the new primary price`);
  shown(
    symbol,
    bound.markFeed === 0
      ? "the mark follows Pyth alone"
      : `feed ${bound.markFeed}, band ${bound.guardBps} bps, guard window ${bound.guardWindow} s`,
  );
});

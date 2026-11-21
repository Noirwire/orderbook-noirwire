/**
 * Binds the launch market and the USDC guard to MagicBlock's price accounts,
 * with `set_price_source_v2` and `set_quote_source_v2`:
 *
 *   [APPLY=yes]                         bind SOL-PERP to MagicBlock's SOL/USD
 *                                       (feed 6) and the guard to its USDC/USD
 *                                       (feed 7), each only if it is not already
 *                                       (a market that reads as bound but still
 *                                       holds the earlier build's liquidation
 *                                       age in its reserved bytes is rebound
 *                                       anyway: only the rebind clears them, and
 *                                       resume_market refuses it until it has)
 *
 * This is how a market that was bound to another source moves to MagicBlock
 * after the program upgrade. The market must be paused: the program rebinds a
 * price source only while it is. A market with positions keeps its mark and
 * reads as settling, so withdrawals and `resume_market` wait until a
 * `sync_price` from the new account is accepted; a far first price opens a
 * dislocation instead of moving the mark.
 *
 * It first reads both MagicBlock accounts as the rollup serves them and checks
 * each as the program does (address, owner, size, discriminator, verification,
 * feed, exponent, a positive price), then the print's freshness against the
 * market's max price age, and shows what each is bound to now and what it will
 * be. Whether the market's mark waits a gap before the first sync (it does only
 * when the book holds positions or orders) is shown as a condition, since the
 * sealed book cannot be read. It sends nothing unless APPLY=yes.
 *
 * After the rebind it sends the first sync, reads the market back and says
 * whether the sync was accepted. Then: run the crank, check the mark with the
 * mark check, resume the market.
 * The Makefile is the way in (`make rehearsal-set-price-source`,
 * `make mainnet-set-price-source`). Once the admin role has moved to a
 * hardware wallet this command cannot send as it.
 */
import {
  clockOf,
  decodeMarket,
  magicblockPriceAccount,
  marketHoldsEarlierBytes,
} from "../sdk/dist/index.js";
import {
  MAINNET_QUOTE_SOURCE,
  checkedObservation,
} from "../sdk/dist/operator/index.js";
import {
  MAINNET_MARKET,
  adminKeyPath,
  rollupIsRunBy,
  run,
  sendingAs,
} from "./deployment";
import { adminRefusal } from "./handover";
import { heldKey } from "./keys";
import { shown } from "./leaving";
import {
  exchangeInRollup,
  priceFeedInRollup,
  quoteBoundAsLaunched,
} from "./market";
import {
  firstSyncVerdict,
  marketRebind,
  rebindPreflight,
  rebindRefusal,
  rebindRequest,
} from "./pricesource";
import { deployedAsBuilt } from "./program";
import { send, until } from "./sending";

const read = (reading: () => ReturnType<typeof checkedObservation>) => {
  try {
    return { observation: reading(), why: null };
  } catch (error) {
    return {
      observation: null,
      why: error instanceof Error ? error.message : String(error),
    };
  }
};

run(async (on) => {
  if (on.profile !== "mainnet") {
    throw new Error(
      "Only the mainnet profile's market is bound to a price source. Nothing was sent.",
    );
  }
  const request = rebindRequest(process.env);
  await deployedAsBuilt(on);
  await rollupIsRunBy(on);
  const { id, symbol, settings } = MAINNET_MARKET;
  const wantedFeed = settings.priceSource.feed;
  const marketAccount = await on.rollup.getAccountInfo(
    on.instructions.addresses.market(id),
  );
  const feed = await priceFeedInRollup(on, id);
  if (!marketAccount || !feed) throw new Error(`${symbol} is not set up.`);
  const { params } = decodeMarket(marketAccount.data);
  const exchange = await exchangeInRollup(on);

  const marketAddress = magicblockPriceAccount(wantedFeed);
  const quoteAddress = magicblockPriceAccount(MAINNET_QUOTE_SOURCE.feed);
  const [marketPrice, quotePrice, clock] = await Promise.all([
    on.rollup.getAccountInfo(marketAddress),
    on.rollup.getAccountInfo(quoteAddress),
    clockOf(on.rollup),
  ]);
  const marketRead = read(() =>
    checkedObservation(marketAddress, marketPrice, marketAddress),
  );
  const quoteRead = read(() =>
    checkedObservation(quoteAddress, quotePrice, quoteAddress),
  );

  const marketBound =
    feed.binding.feed === wantedFeed &&
    feed.binding.account.equals(marketAddress);
  const quoteBound = quoteBoundAsLaunched(exchange);
  const rebind = marketRebind(
    marketBound,
    marketHoldsEarlierBytes(marketAccount.data),
  );

  shown("network", `${on.network}, program ${on.instructions.programId}`);
  shown(
    symbol,
    `${marketBound ? "bound" : "will be bound"} to feed ${wantedFeed}, ${marketAddress.toBase58()}; now feed ${feed.binding.feed}, ${feed.binding.account.toBase58()}`,
  );
  if (rebind.why) shown(`${symbol} will be rebound`, rebind.why);
  shown(
    `${symbol} price`,
    marketRead.observation
      ? `${marketRead.observation.price} at exponent ${marketRead.observation.expo}, ${clock - marketRead.observation.publishTime} s old`
      : `unreadable: ${marketRead.why}`,
  );
  shown(
    "USDC guard",
    `${quoteBound ? "bound" : "will be bound"} to feed ${MAINNET_QUOTE_SOURCE.feed}, ${quoteAddress.toBase58()}; now feed ${exchange.quote.feed}, ${exchange.quote.account.toBase58()}`,
  );
  shown(
    "USDC price",
    quoteRead.observation
      ? `${quoteRead.observation.price} at exponent ${quoteRead.observation.expo}, ${clock - quoteRead.observation.publishTime} s old`
      : `unreadable: ${quoteRead.why}`,
  );

  if (!rebind.needed && quoteBound) {
    console.log("Both are bound as launched. Nothing to send.");
    return;
  }
  const notPaused = rebind.needed ? rebindRefusal(params.status) : null;
  if (notPaused) throw new Error(notPaused);
  if (rebind.needed) {
    if (!marketRead.observation) {
      throw new Error(
        `${symbol}'s price is bound only while its account reads as the program reads it. Nothing was sent.`,
      );
    }
    const preflight = rebindPreflight(
      marketRead.observation,
      clock,
      {
        maxPriceAge: Number(params.maxPriceAge),
        minPublishGap: params.minPublishGap,
      },
      {
        publishTime: Number(feed.publishTime),
        acceptedAt: Number(feed.acceptedAt),
      },
    );
    if (preflight.refusal) {
      throw new Error(
        `The market's first sync after binding would fail: ${preflight.refusal}. Nothing was sent.`,
      );
    }
    shown(
      `${symbol} first sync`,
      preflight.ifHeld
        ? `an empty book is cleared by the rebind and accepts this print; if it holds positions or orders the mark stays and the first sync would be refused: ${preflight.ifHeld}`
        : "this print is fresh; an empty book accepts it and a held mark is past its gap",
    );
  }
  if (!quoteBound && !quoteRead.observation) {
    throw new Error(
      "The USDC guard is bound only while its account reads as the program reads it. Nothing was sent.",
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
  const wrongAdmin = adminRefusal(exchange.admin, admin.publicKey, keyFile);
  if (wrongAdmin) throw new Error(wrongAdmin);
  const connection = await sendingAs(on, admin);
  if (rebind.needed) {
    shown(
      "set_price_source_v2",
      await send(
        connection,
        on.instructions.setPriceSource(admin.publicKey, id, wantedFeed),
        admin,
      ),
    );
    await until(async () => {
      const now = await priceFeedInRollup(on, id);
      const market = await on.rollup.getAccountInfo(
        on.instructions.addresses.market(id),
      );
      return now?.binding.feed === wantedFeed &&
        now.binding.account.equals(marketAddress) &&
        market &&
        !marketHoldsEarlierBytes(market.data)
        ? now
        : null;
    }, `${symbol} to read back bound to feed ${wantedFeed} with its reserved bytes clear`);
    if (marketRead.observation) {
      const sync = await send(
        connection,
        on.instructions.syncPrice(id, marketAddress),
        admin,
      ).then(
        () => null,
        (error: Error) => error.message.split("\n")[0],
      );
      const after = await priceFeedInRollup(on, id);
      const verdict = firstSyncVerdict(
        sync,
        after && {
          sourcePublishTime: Number(after.source.publishTime),
          mark: after.price,
          markPublishTime: Number(after.publishTime),
        },
        marketRead.observation.publishTime,
      );
      shown(`${symbol} first sync`, verdict.line);
    }
  }
  if (!quoteBound) {
    shown(
      "set_quote_source_v2",
      await send(
        connection,
        on.instructions.setQuoteSource(admin.publicKey, MAINNET_QUOTE_SOURCE),
        admin,
      ),
    );
    await until(
      async () =>
        quoteBoundAsLaunched(await exchangeInRollup(on)) ? true : null,
      `the USDC guard to read back bound to feed ${MAINNET_QUOTE_SOURCE.feed}`,
    );
  }
  console.log(
    "Bound. Run the crank so it syncs both, check the mark with the mark check, then resume the market.",
  );
});

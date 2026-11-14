/**
 * Binds the launch market and the USDC guard to MagicBlock's price accounts,
 * with `set_price_source` and `set_quote_source`:
 *
 *   [APPLY=yes]                         bind SOL-PERP to MagicBlock's SOL/USD
 *                                       (feed 6) and the guard to its USDC/USD
 *                                       (feed 7), each only if it is not already
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
 * feed, exponent, a positive price), then the market's first sync against
 * its max price age, and shows what each is bound to now and what it will be.
 * It sends nothing unless APPLY=yes.
 *
 * Then: run the crank, check the mark with the mark check, resume the market.
 * The Makefile is the way in (`make rehearsal-set-price-source`,
 * `make mainnet-set-price-source`). Once the admin role has moved to a
 * hardware wallet this command cannot send as it.
 */
import {
  clockOf,
  decodeMarket,
  magicblockPriceAccount,
} from "../sdk/dist/index.js";
import {
  MAINNET_QUOTE_SOURCE,
  checkedObservation,
  firstSyncFailure,
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
import { rebindRefusal, rebindRequest } from "./pricesource";
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

  shown("network", `${on.network}, program ${on.instructions.programId}`);
  shown(
    symbol,
    `${marketBound ? "bound" : "will be bound"} to feed ${wantedFeed}, ${marketAddress.toBase58()}; now feed ${feed.binding.feed}, ${feed.binding.account.toBase58()}`,
  );
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

  if (marketBound && quoteBound) {
    console.log("Both are bound as launched. Nothing to send.");
    return;
  }
  const notPaused = marketBound ? null : rebindRefusal(params.status);
  if (notPaused) throw new Error(notPaused);
  if (!marketBound) {
    if (!marketRead.observation) {
      throw new Error(
        `${symbol}'s price is bound only while its account reads as the program reads it. Nothing was sent.`,
      );
    }
    const failure = firstSyncFailure(marketRead.observation, clock, {
      maxPriceAge: Number(params.maxPriceAge),
      markPublishTime: Number(feed.publishTime),
    });
    if (failure) {
      throw new Error(
        `The market's first sync after binding would fail: ${failure}. Nothing was sent.`,
      );
    }
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
  if (!marketBound) {
    shown(
      "set_price_source",
      await send(
        connection,
        on.instructions.setPriceSource(admin.publicKey, id, wantedFeed),
        admin,
      ),
    );
    await until(async () => {
      const now = await priceFeedInRollup(on, id);
      return now?.binding.feed === wantedFeed &&
        now.binding.account.equals(marketAddress)
        ? now
        : null;
    }, `${symbol} to read back bound to feed ${wantedFeed}`);
  }
  if (!quoteBound) {
    shown(
      "set_quote_source",
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

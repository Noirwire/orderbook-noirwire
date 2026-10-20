import { Connection, PublicKey } from "@solana/web3.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  ORDER_TYPE,
  OutcomeUnknown,
  SIDE,
  type OrderResult,
  type TraderClient,
} from "@noirwire/orderbook";
import { summariseView } from "./account.js";
import { marketNamed } from "./deployment.js";
import { TEST_MONEY_NOTICE } from "./network.js";
import {
  describeCancel,
  describeSettled,
  describeTransfer,
  explainError,
  messageOf,
} from "./outcomes.js";
import type { Session, SessionHost } from "./session.js";
import { fetchCandles, fetchMarkets, fetchTape, openAndFund } from "./sim.js";
import {
  InvalidInput,
  marketUnitsOf,
  parseDecimal,
  priceToChain,
  sizeToLots,
  worstPriceFromMark,
  type MarketUnits,
} from "./units.js";

const EXPIRY_SECONDS = 5;
/** How long a live subscription is trusted to deliver an order's result before the view is read as well. */
const RESULT_PUSH_WAIT_MS = 1_500;
const GRANT_SYNC_ATTEMPTS = 8;
const GRANT_SYNC_GAP_MS = 1_500;

const DEVNET_PREFIX = `DEVNET TEST NETWORK, TEST MONEY ONLY: nothing here has real value. `;

const READS_PUBLIC_DATA = { readOnlyHint: true, openWorldHint: true };
const CHANGES_THE_ACCOUNT = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: true,
};

const ORDER_TYPES = {
  limit: ORDER_TYPE.limit,
  market: ORDER_TYPE.market,
  post_only: ORDER_TYPE.postOnly,
  ioc: ORDER_TYPE.immediateOrCancel,
} as const;

/** A failure whose message is already written for the agent. */
class Reported extends Error {}

function answer(data: object, warnings: string[]): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            notice: TEST_MONEY_NOTICE,
            ...data,
            ...(warnings.length > 0 ? { warnings } : {}),
          },
          null,
          2,
        ),
      },
    ],
  };
}

function failure(message: string, warnings: string[]): CallToolResult {
  const extra = warnings.map((warning) => ` Warning: ${warning}`).join("");
  return {
    isError: true,
    content: [
      { type: "text", text: `${message}${extra} (${TEST_MONEY_NOTICE})` },
    ],
  };
}

/** Runs a tool's work and turns any failure into one plain message. Warnings the session gathered ride along. */
async function respondWith(
  host: SessionHost,
  work: () => Promise<object>,
): Promise<CallToolResult> {
  try {
    const data = await work();
    return answer(data, host.takeWarnings());
  } catch (error) {
    const message =
      error instanceof Reported ? error.message : explainError(error);
    return failure(message, host.takeWarnings());
  }
}

async function viewExists(session: Session): Promise<boolean> {
  const { client, owner } = session;
  return (
    (await client.reader.getAccountInfo(
      client.addresses.view(owner.publicKey),
    )) !== null
  );
}

/** A call whose outcome was not known in time: wait for what became of it. */
async function resultOf(
  call: () => Promise<OrderResult>,
): Promise<OrderResult | null> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof OutcomeUnknown) return error.settled;
    throw error;
  }
}

/** Copies the seat into the view, so the view's balances and open orders are current. Says whether it worked. */
async function syncView(
  client: TraderClient,
  marketId: number,
): Promise<boolean> {
  try {
    return (
      (await resultOf(() => client.syncView(marketId, EXPIRY_SECONDS))) !== null
    );
  } catch {
    return false;
  }
}

async function accountOf(
  session: Session,
  marketSymbol?: string,
): Promise<object> {
  const { client, deployment, owner } = session;
  const trader = owner.publicKey.toBase58();
  if (!(await viewExists(session))) {
    return {
      trader,
      accountOpen: false,
      hint: "This trader has no account yet. Call fund_account to open one and receive the test grant.",
    };
  }
  const market = marketNamed(
    deployment,
    marketSymbol ?? deployment.markets[0].symbol,
  );
  const synced = await syncView(client, market.marketId);
  const view = await client.view();
  const summary = summariseView(view, deployment, session.tokens);
  return {
    trader,
    accountOpen: true,
    network: deployment.network,
    ...summary,
    openOrders: {
      ...summary.openOrders,
      note: "Open orders cover one market only: the market the last instruction named.",
    },
    ...(synced
      ? {}
      : {
          warning: `The account could not be refreshed for ${market.symbol} just now, so these figures may be a little old.`,
        }),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The grant is credited to the ledger's seat; a keyed call copies it into the view, repeated until the collateral shows. */
async function waitForGrant(session: Session): Promise<void> {
  const first = session.deployment.markets[0];
  for (let attempt = 0; attempt < GRANT_SYNC_ATTEMPTS; attempt += 1) {
    if (await syncView(session.client, first.marketId)) {
      try {
        if ((await session.client.view()).snapshot.seat.collateral > 0n) return;
      } catch {
        // The view is not readable yet; the next attempt asks again.
      }
    }
    await sleep(GRANT_SYNC_GAP_MS);
  }
}

async function fundAccount(host: SessionHost, simUrl: string): Promise<object> {
  const outcome = await host.run(async (session) => {
    if (await viewExists(session)) return { kind: "alreadyFunded" as const };
    return openAndFund(
      simUrl,
      session.owner,
      session.client.keys.publicKeys,
      new PublicKey(session.deployment.programId),
    );
  });
  switch (outcome.kind) {
    case "alreadyFunded":
      return {
        status: "already_funded",
        message:
          "This trader already has an account. Call get_account to see it.",
      };
    case "tryLater":
      throw new Reported(
        `The test grant could not be given right now${outcome.reason ? `: ${outcome.reason}` : ""}. Wait a minute and call fund_account again.`,
      );
    case "error":
      throw new Reported(
        outcome.message.startsWith("Refused to sign")
          ? `${outcome.message}. Nothing was signed or sent. Do not retry until the simulation service is trusted again.`
          : `Funding failed: ${outcome.message}. Check that the simulation service is up and call fund_account again.`,
      );
    case "granted":
      await host.rebuild();
      await host.run(waitForGrant);
      return {
        status: "granted",
        granted: outcome.amount,
        reference: outcome.reference,
        account: await host.run((session) => accountOf(session)),
      };
  }
}

type PlaceOrderInput = {
  market: string;
  side: "buy" | "sell";
  type: keyof typeof ORDER_TYPES;
  size: string;
  price?: string;
  reduce_only?: boolean;
};

/** The price a market order accepts when the caller names none: 1% beyond the mark. */
async function markedWorstPrice(
  simUrl: string,
  symbol: string,
  units: MarketUnits,
  side: "buy" | "sell",
): Promise<string> {
  const { markets } = await fetchMarkets(simUrl);
  const mark = markets.find((candidate) => candidate.id === symbol)?.markPrice;
  if (!mark) {
    throw new InvalidInput(
      `${symbol} has no mark price right now, so a market order needs an explicit price (its worst acceptable price)`,
    );
  }
  return worstPriceFromMark(units, side, mark);
}

async function placeOrder(
  session: Session,
  input: PlaceOrderInput,
  simUrl: string,
): Promise<object> {
  const { client, deployment } = session;
  const target = marketNamed(deployment, input.market);
  const units = marketUnitsOf(target);
  const size = sizeToLots(units, input.size);
  let priceText = input.price;
  if (priceText === undefined) {
    if (input.type !== "market") {
      throw new InvalidInput(`a ${input.type} order needs a price`);
    }
    priceText = await markedWorstPrice(
      simUrl,
      target.symbol,
      units,
      input.side,
    );
  }
  const placed = await client.placeOrder(
    target.marketId,
    {
      side: input.side === "buy" ? SIDE.bid : SIDE.ask,
      orderType: ORDER_TYPES[input.type],
      price: priceToChain(units, priceText),
      size,
      reduceOnly: input.reduce_only ?? false,
    },
    {
      expirySeconds: EXPIRY_SECONDS,
      pushWaitMs: RESULT_PUSH_WAIT_MS,
    },
  );
  const report =
    placed.outcome === "unknown"
      ? describeSettled(await placed.settled, units, true)
      : describeSettled(placed, units);
  return {
    market: target.symbol,
    side: input.side,
    type: input.type,
    requestedSize: input.size,
    price: priceText,
    ...report,
  };
}

type Probe = {
  address: string;
  result: "nothing_returned" | "returned_data" | "check_failed";
  meaning: string;
};

async function probe(
  connection: Connection,
  address: PublicKey,
): Promise<Probe> {
  const base = { address: address.toBase58() };
  try {
    const account = await connection.getAccountInfo(address);
    return account === null
      ? {
          ...base,
          result: "nothing_returned",
          meaning:
            "The rollup returned nothing to an anonymous reader: this account is private.",
        }
      : {
          ...base,
          result: "returned_data",
          meaning:
            "The rollup returned this account to an anonymous reader: it is readable by anyone.",
        };
  } catch (error) {
    return {
      ...base,
      result: "check_failed",
      meaning: `The check did not complete (${messageOf(error)}). It proves nothing either way; try again.`,
    };
  }
}

async function checkPrivacy(
  { client, deployment, owner }: Session,
  marketSymbol: string,
): Promise<object> {
  const target = marketNamed(deployment, marketSymbol);
  const anonymous = new Connection(deployment.rollupRpcUrl, "confirmed");
  const [view, book] = await Promise.all([
    probe(anonymous, client.addresses.view(owner.publicKey)),
    probe(anonymous, client.addresses.book(target.marketId)),
  ]);
  return {
    network: deployment.network,
    endpoint: deployment.rollupRpcUrl,
    checkedAt: new Date().toISOString(),
    market: target.symbol,
    traderView: view,
    orderBook: book,
  };
}

async function transferBalance(
  session: Session,
  direction: "to_spot" | "to_collateral",
  amount: string,
): Promise<object> {
  const quote = session.tokens.find((token) => token.symbol === "nUSD");
  if (!quote) {
    throw new Reported(
      "The exchange has no nUSD token slot this server can find, so it cannot move nUSD. Check the simulation service's deployment.",
    );
  }
  const atoms = parseDecimal(amount, "amount");
  if (atoms === 0n) {
    throw new InvalidInput("amount must be greater than zero");
  }
  const result = await resultOf(() =>
    session.client.transferBetweenBalances(
      direction === "to_collateral",
      quote.index,
      atoms,
      EXPIRY_SECONDS,
    ),
  );
  return { direction, amount, ...describeTransfer(result) };
}

/** Registers the ten tools on `server`. */
export function registerTools(
  server: McpServer,
  simUrl: string,
  host: SessionHost,
): void {
  const respond = (work: () => Promise<object>) => respondWith(host, work);
  const market = z
    .string()
    .describe(
      'Market id such as "NSOL-PERP" or "NSOL-NUSD"; get_markets lists them.',
    );

  server.registerTool(
    "get_markets",
    {
      title: "List markets",
      description: `${DEVNET_PREFIX}Lists the public markets: id, kind (spot or perp), base and quote, mark price, 24h change and volume, open interest, tick size, lot size and maximum leverage. Public data only.`,
      annotations: READS_PUBLIC_DATA,
    },
    () =>
      respond(async () => {
        const { network, markets } = await fetchMarkets(simUrl);
        return { network, markets };
      }),
  );

  server.registerTool(
    "get_trades",
    {
      title: "Recent trades",
      description: `${DEVNET_PREFIX}Recent public fills on a market, newest first: price, size, which side took, time. Resting orders are never public; only fills are.`,
      inputSchema: {
        market,
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe("How many fills, up to 100."),
      },
      annotations: READS_PUBLIC_DATA,
    },
    ({ market: id, limit }) =>
      respond(async () => {
        const fills = await fetchTape(simUrl, id, limit);
        return {
          market: id,
          trades: fills.map((fill) => ({
            time: new Date(fill.timestampMs).toISOString(),
            price: fill.price,
            size: fill.size,
            takerSide: fill.takerSide,
            sequence: fill.sequence,
          })),
        };
      }),
  );

  server.registerTool(
    "get_candles",
    {
      title: "Price candles",
      description: `${DEVNET_PREFIX}OHLC price candles for a market, oldest first.`,
      inputSchema: {
        market,
        interval: z.enum(["1m", "5m", "15m", "1h"]),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(60)
          .describe("How many candles, up to 500."),
      },
      annotations: READS_PUBLIC_DATA,
    },
    ({ market: id, interval, limit }) =>
      respond(async () => {
        const candles = await fetchCandles(simUrl, id, interval, limit);
        return {
          market: id,
          interval,
          candles: candles.map((candle) => ({
            start: new Date(candle.startMs).toISOString(),
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume,
          })),
        };
      }),
  );

  server.registerTool(
    "get_account",
    {
      title: "My account",
      description: `${DEVNET_PREFIX}The trader's own account: address, whether it is open, collateral, spot balances, perp positions and open orders. Only this trader can read it. Open orders cover one market, the one named here (the first market by default).`,
      inputSchema: {
        market: market
          .optional()
          .describe(
            "The market whose open orders to list; defaults to the first market.",
          ),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    ({ market: id }) =>
      respond(() =>
        host.run((session) => accountOf(session, id), { repeatable: true }),
      ),
  );

  server.registerTool(
    "fund_account",
    {
      title: "Open and fund account",
      description: `${DEVNET_PREFIX}Opens the trader's account and deposits the free test grant into the perpetuals collateral. Spot buys spend the spot nUSD balance instead, so move nUSD to spot first with transfer_balance. Works once per trader; when the account already exists it says so. If the service is rate limited or has no seat to offer, it returns the reason and the call can be repeated later.`,
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    () => respond(() => fundAccount(host, simUrl)),
  );

  server.registerTool(
    "place_order",
    {
      title: "Place an order",
      description: `${DEVNET_PREFIX}Places an order on the private book. Perp orders use the collateral; spot buys need nUSD in the spot balance, so move it there first with transfer_balance (the grant arrives as collateral). Sizes and prices are decimal strings: size in base units (a whole number of lots), price per base unit (on the tick). Types: limit; post_only (refused if it would match); ioc (fills what it can now, cancels the rest); market (a price is its worst acceptable price; if omitted it is 1% beyond the mark). Reports filled, rested (with an orderId to cancel by), remainder cancelled, or refused, with filled size, average price and fee.`,
      inputSchema: {
        market,
        side: z.enum(["buy", "sell"]),
        type: z.enum(["limit", "market", "post_only", "ioc"]),
        size: z.string().describe('Size in base units, e.g. "0.5".'),
        price: z
          .string()
          .optional()
          .describe("Price per base unit. Required except for market orders."),
        reduce_only: z
          .boolean()
          .optional()
          .describe("Only reduce an existing position."),
      },
      annotations: CHANGES_THE_ACCOUNT,
    },
    (input) =>
      respond(() => host.run((session) => placeOrder(session, input, simUrl))),
  );

  server.registerTool(
    "cancel_order",
    {
      title: "Cancel an order",
      description: `${DEVNET_PREFIX}Cancels one resting order by the orderId place_order returned or get_account lists.`,
      inputSchema: {
        market,
        order_id: z.string().describe("The orderId of a resting order."),
      },
      annotations: CHANGES_THE_ACCOUNT,
    },
    ({ market: id, order_id }) =>
      respond(() =>
        host.run(async (session) => {
          if (!/^\d+$/.test(order_id)) {
            throw new InvalidInput(`order_id "${order_id}" is not a number`);
          }
          const target = marketNamed(session.deployment, id);
          const result = await resultOf(() =>
            session.client.cancelOrder(
              target.marketId,
              BigInt(order_id),
              EXPIRY_SECONDS,
            ),
          );
          return {
            market: target.symbol,
            orderId: order_id,
            ...describeCancel(result),
          };
        }),
      ),
  );

  server.registerTool(
    "cancel_all",
    {
      title: "Cancel all orders",
      description: `${DEVNET_PREFIX}Cancels every resting order this trader has in one market.`,
      inputSchema: { market },
      annotations: CHANGES_THE_ACCOUNT,
    },
    ({ market: id }) =>
      respond(() =>
        host.run(async (session) => {
          const target = marketNamed(session.deployment, id);
          const result = await resultOf(() =>
            session.client.cancelAll(
              target.marketId,
              undefined,
              EXPIRY_SECONDS,
            ),
          );
          return { market: target.symbol, ...describeCancel(result) };
        }),
      ),
  );

  server.registerTool(
    "check_privacy",
    {
      title: "Check privacy",
      description: `${DEVNET_PREFIX}Shows that nobody can read the book: reads the trader's own account and the market's order book from the rollup with no sign-in, the way any stranger could, and reports whether each came back empty (private) or not.`,
      inputSchema: { market },
      annotations: READS_PUBLIC_DATA,
    },
    ({ market: id }) =>
      respond(() =>
        host.run((session) => checkPrivacy(session, id), { repeatable: true }),
      ),
  );

  server.registerTool(
    "transfer_balance",
    {
      title: "Move nUSD between collateral and spot",
      description: `${DEVNET_PREFIX}Moves nUSD between the perpetuals collateral and the spot balance, no tokens leaving the account. The test grant arrives as collateral, and spot buys spend the spot balance, so use to_spot before buying on a spot market. Amount is a decimal string in nUSD.`,
      inputSchema: {
        direction: z.enum(["to_spot", "to_collateral"]),
        amount: z.string().describe('Amount of nUSD, e.g. "100".'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    ({ direction, amount }) =>
      respond(() =>
        host.run((session) => transferBalance(session, direction, amount)),
      ),
  );
}

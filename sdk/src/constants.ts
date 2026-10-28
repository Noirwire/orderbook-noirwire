import { PublicKey } from "@solana/web3.js";

export const PROGRAM_ID = new PublicKey(
  "9YiFamFrLbCiNYQczPwKfSwnnaTjDNWm9guokUGxB1z8",
);

export const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);
export const UPGRADEABLE_LOADER_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);
/** RULES 9: the Pyth receiver program, owner of every price account a market reads. */
export const PYTH_RECEIVER_ID = new PublicKey(
  "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ",
);
/** RULES 9: the Pyth push oracle, whose shard 0 address for a feed id is its price account. */
export const PYTH_PUSH_ORACLE_ID = new PublicKey(
  "pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT",
);

export const SEEDS = {
  exchange: "exchange",
  custody: "custody",
  ledger: "ledger",
  stats: "stats",
  book: "book",
  market: "market",
  tape: "tape",
  price: "price",
  view: "view",
} as const;

/** Capacities the program is built with. `MIN_SEATS` is the trader seats a ledger is created with. */
export const MIN_SEATS = 2048;
export const ORDERS_PER_SIDE = 1024;
export const MAX_MARKETS = 8;
export const TOKENS = 4;
export const MAX_OPEN_ORDERS = 32;
export const MAX_FILLS = 32;
export const TAPE_FILLS = 512;
export const RESULTS = 16;
export const ORDER_KEYS = 4;
export const GROWTH_STEP = 10_240;
/** RULES 3.0: the furthest ahead an order-key instruction may expire, in seconds. */
export const MAX_EXPIRY_AHEAD = 60;

export const FEE_SEAT = 0;
export const INSURANCE_SEAT = 1;

export const HEADER_LEN = 16;
export const SEAT_LEN = 448;
export const ORDER_VIEW_LEN = 64;
export const SEAT_SNAPSHOT_LEN =
  SEAT_LEN + 16 + MAX_OPEN_ORDERS * ORDER_VIEW_LEN;
export const TAPE_FILL_LEN = 56;
export const ORDER_RESULT_LEN = 64;
export const MARKET_PARAMS_LEN = 120;

/** Full sizes of the accounts the program creates inside the rollup. */
export const ACCOUNT_LEN = {
  ledger: HEADER_LEN + 8 + MIN_SEATS * SEAT_LEN,
  book: HEADER_LEN + 72 + 2 * ORDERS_PER_SIDE * 64,
  market: HEADER_LEN + MARKET_PARAMS_LEN + 24,
  tape: HEADER_LEN + 24 + TAPE_FILLS * TAPE_FILL_LEN,
  priceFeed: HEADER_LEN + 24 + 40 + 72 + 24,
  stats: HEADER_LEN + 16 + 2 * 8 * MAX_MARKETS,
  view:
    HEADER_LEN +
    32 +
    128 +
    16 +
    RESULTS * ORDER_RESULT_LEN +
    SEAT_SNAPSHOT_LEN +
    8,
} as const;

export const ACCOUNT_TAG = {
  ledger: "nwledger",
  book: "nwbook\0\0",
  market: "nwmarket",
  tape: "nwtape\0\0",
  priceFeed: "nwprice\0",
  stats: "nwstats\0",
  view: "nwview\0\0",
} as const;

export const GROW_KIND = { ledger: 0, book: 1, tape: 2 } as const;

export const MARKET_KIND = { spot: 1, perp: 2 } as const;
export const MARKET_STATUS = { active: 0, paused: 1, reduceOnly: 2 } as const;
/** RULES 9: `MarketParams.oracleHealth`. */
export const ORACLE_HEALTH = {
  healthy: 0,
  dislocated: 1,
  settling: 2,
} as const;
/** RULES 9: `PriceFeed.incident.reason`. */
export const INCIDENT_REASON = { moveBeyondLimit: 1, settledGap: 2 } as const;
/** RULES 9a: `Exchange.quote.state`. */
export const QUOTE_STATE = { healthy: 0, depegged: 1, unbound: 2 } as const;
/** RULES 3a: the bits of `MarketParams.access`, a perp market's public switches. */
export const MARKET_ACCESS = { makersListed: 1, takersListed: 2 } as const;
/**
 * RULES 3a: the refusals of the access lists, as `TransactionFailed.code`
 * reports them. Each depends only on the market's public switches, the
 * order's type and flag and the sender's own seat, never on the book.
 */
export const ACCESS_ERROR = {
  seatBlocked: 6090,
  makerNotListed: 6091,
  takerNotListed: 6092,
} as const;

export const SIDE = { bid: 0, ask: 1 } as const;
export const ORDER_TYPE = {
  limit: 0,
  postOnly: 1,
  immediateOrCancel: 2,
  market: 3,
} as const;

export const RESULT_KIND = {
  place: 1,
  cancel: 2,
  cancelAll: 3,
  sync: 4,
  liquidate: 5,
  transfer: 6,
} as const;

/** `OrderResult.status`: the engine's `PlaceStatus` codes, plus done and refused. */
export const RESULT_STATUS = {
  done: 0,
  filled: 1,
  rested: 2,
  remainderCancelled: 3,
  remainderCancelledStepLimit: 4,
  remainderCancelledBookFull: 5,
  refusedPostOnlyWouldMatch: 6,
  remainderCancelledFillCheck: 7,
  refused: 100,
} as const;

/**
 * `OrderResult.status` of a liquidation. The program writes `liquidated`,
 * `stalePrice`, `liquidatorMarginInsufficient` and `nothingToLiquidate`.
 * `nothingToLiquidate` stands for every outcome that depends on the target and
 * changed nothing: no such seat, no position, not below maintenance margin, or
 * a liquidation price beyond the worst price, which is only compared once the
 * target is below maintenance. A liquidator cannot tell them apart.
 */
export const LIQUIDATION_STATUS = {
  liquidated: 1,
  stalePrice: 5,
  liquidatorMarginInsufficient: 7,
  nothingToLiquidate: 8,
} as const;

/** What `initializeExchange` sets when `maxSeatsPerDay` is left out. */
export const DEFAULT_MAX_SEATS_PER_DAY = 100;

export const ROLE = { maker: 0, taker: 1 } as const;

/** The rollup charges this much rent per byte, plus 60 bytes per account. */
export const RENT_PER_BYTE = 32;
export const RENT_OVERHEAD_BYTES = 60;
export const rollupRent = (dataLen: number) =>
  (dataLen + RENT_OVERHEAD_BYTES) * RENT_PER_BYTE;

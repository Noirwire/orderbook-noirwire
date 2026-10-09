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

/** Capacities the program is built with. */
export const SEATS = 2048;
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
export const MARKET_PARAMS_LEN = 104;

/** Full sizes of the accounts the program creates inside the rollup. */
export const ACCOUNT_LEN = {
  ledger: HEADER_LEN + 8 + SEATS * SEAT_LEN,
  book: HEADER_LEN + 72 + 2 * ORDERS_PER_SIDE * 64,
  market: HEADER_LEN + MARKET_PARAMS_LEN + 24,
  tape: HEADER_LEN + 24 + TAPE_FILLS * TAPE_FILL_LEN,
  priceFeed: HEADER_LEN + 16,
  stats: HEADER_LEN + 16 + 2 * 8 * MAX_MARKETS,
  view:
    HEADER_LEN + 32 + 128 + 8 + RESULTS * ORDER_RESULT_LEN + SEAT_SNAPSHOT_LEN,
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

/** `OrderResult.status` of a liquidation: the engine's `LiquidationStatus` codes. */
export const LIQUIDATION_STATUS = {
  liquidated: 1,
  targetSeatNotOpen: 2,
  noPosition: 3,
  notLiquidatable: 4,
  stalePrice: 5,
  worstPriceExceeded: 6,
  liquidatorMarginInsufficient: 7,
} as const;

export const ROLE = { maker: 0, taker: 1 } as const;

/** The rollup charges this much rent per byte, plus 60 bytes per account. */
export const RENT_PER_BYTE = 32;
export const RENT_OVERHEAD_BYTES = 60;
export const rollupRent = (dataLen: number) =>
  (dataLen + RENT_OVERHEAD_BYTES) * RENT_PER_BYTE;

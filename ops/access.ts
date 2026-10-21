/**
 * The admin's access lists (RULES 3a), chosen by `ACCESS`:
 *
 *   show    each perp market's maker and taker list switches, which are public
 *   market  MARKET=<id> MAKERS=on|off TAKERS=on|off, then the market read back
 *   seat    SEAT_OWNER=<key> MAKER_MARKETS=<ids|none> TAKER_MARKETS=<ids|none>
 *           BLOCKED=yes|no
 *
 * The Makefile is the way in (`make local-access`, `make rehearsal-access`,
 * `make mainnet-access`). Who is listed is sealed, so a seat's flags are
 * never read back.
 */
import { Keypair, type Connection } from "@solana/web3.js";
import {
  decodeExchange,
  decodeHeader,
  decodeMarket,
  MAX_MARKETS,
  type Market,
} from "../sdk/dist/index.js";
import {
  accessRequest,
  marketsIn,
  seatAccessInstructions,
  switchesOf,
  switchesText,
  type AccessRequest,
} from "./accessing";
import {
  adminKeyPath,
  rollupIsRunBy,
  run,
  sendingAs,
  type Target,
} from "./deployment";
import { heldKey, readingAs } from "./keys";
import { deployedAsBuilt } from "./program";
import { send, until } from "./sending";

const shown = (label: string, value: string) =>
  console.log(`${label.padEnd(20)}${value}`);

async function exchangeAs(on: Target, reader: Connection) {
  const account = await reader.getAccountInfo(
    on.instructions.addresses.exchange,
  );
  if (!account) {
    throw new Error("The exchange is not in the rollup. Nothing was sent.");
  }
  return decodeExchange(account.data);
}

async function marketAs(
  on: Target,
  reader: Connection,
  id: number,
): Promise<Market> {
  const account = await reader.getAccountInfo(
    on.instructions.addresses.market(id),
  );
  if (!account || !decodeHeader(account.data).ready) {
    throw new Error(`Market ${id} is not ready.`);
  }
  return decodeMarket(account.data);
}

const marketLine = ({ baseSymbol, quoteSymbol, params }: Market) =>
  `${baseSymbol}/${quoteSymbol}: ${switchesText(switchesOf(params.access))}`;

async function show(
  on: Target,
  reader: Connection,
  perpIds: number[],
  request: Extract<AccessRequest, { command: "show" }>,
): Promise<void> {
  shown("network", `${on.network}, program ${on.instructions.programId}`);
  for (const id of perpIds) {
    shown(`market ${id}`, marketLine(await marketAs(on, reader, id)));
  }
  if (perpIds.length === 0) shown("markets", "no perp market");
  if (request.owner) {
    shown(
      "seat",
      `${request.owner.toBase58()}: lists and block flag are sealed, nobody can read them, the admin included`,
    );
  }
}

async function market(
  on: Target,
  reader: Connection,
  request: Extract<AccessRequest, { command: "market" }>,
): Promise<void> {
  const admin = heldKey(adminKeyPath(on));
  const signature = await send(
    await sendingAs(on, admin),
    on.instructions.setMarketAccess(
      admin.publicKey,
      request.marketId,
      request.access,
    ),
    admin,
  );
  shown("signature", signature);
  const wanted = request.access;
  const read = await until(async () => {
    const now = await marketAs(on, reader, request.marketId);
    const found = switchesOf(now.params.access);
    return found.makersListed === wanted.makersListed &&
      found.takersListed === wanted.takersListed
      ? now
      : null;
  }, `market ${request.marketId} to read back as set`);
  shown(`market ${request.marketId}`, marketLine(read));
}

async function seat(
  on: Target,
  perpIds: number[],
  request: Extract<AccessRequest, { command: "seat" }>,
): Promise<void> {
  const admin = heldKey(adminKeyPath(on));
  const signature = await send(
    await sendingAs(on, admin),
    seatAccessInstructions(
      on.instructions,
      admin.publicKey,
      request.owner,
      request.access,
      perpIds,
    ),
    admin,
  );
  const { makerMarkets, takerMarkets, blocked } = request.access;
  shown("signature", signature);
  shown(
    "seat",
    `${request.owner.toBase58()}: maker on [${marketsIn(makerMarkets)}], taker on [${marketsIn(takerMarkets)}], blocked ${blocked ? "yes" : "no"}`,
  );
  shown(
    "note",
    "sealed, so not read back; the seat must have been open (SeatNotOpen otherwise)",
  );
}

async function access(on: Target): Promise<void> {
  const reader = await readingAs(on.privateUrl, Keypair.generate());
  const exchange = await exchangeAs(on, reader);
  const perpIds = Array.from({ length: MAX_MARKETS }, (_, id) => id).filter(
    (id) => (exchange.perpMarkets >> id) & 1,
  );
  const request = accessRequest(process.env, perpIds);
  if (request.command === "show") return show(on, reader, perpIds, request);

  const admin = heldKey(adminKeyPath(on));
  if (!exchange.admin.equals(admin.publicKey)) {
    throw new Error(
      `The exchange's admin is ${exchange.admin.toBase58()}, not ${admin.publicKey.toBase58()}. Nothing was sent.`,
    );
  }
  if (on.profile === "mainnet") await deployedAsBuilt(on);
  await rollupIsRunBy(on);
  if (request.command === "market") return market(on, reader, request);
  return seat(on, perpIds, request);
}

run(access);

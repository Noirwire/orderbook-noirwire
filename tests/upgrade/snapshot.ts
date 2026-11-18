/**
 * Every account the story touches, as the rollup serves it: its bytes and
 * what this build's decoders make of them.
 */
import type { PublicKey } from "@solana/web3.js";
import {
  HEADER_LEN,
  decodeExchange,
  decodeLedger,
  decodeMarket,
  decodePriceFeed,
  decodeStats,
  decodeTape,
  decodeView,
  positionOn,
  type Exchange,
  type Ledger,
  type Market,
  type PerpSlot,
  type PriceFeed,
  type Stats,
  type Tape,
  type View,
} from "../../sdk/dist/index.js";
import { addresses, throughThePort } from "../support";

const BID_COUNT_AT = 32;
const ASK_COUNT_AT = 36;
const OPEN_INTEREST_AT = 64;

export type Snapshot = {
  /** Account data by a name that says which account it is. */
  bytes: Map<string, Buffer>;
  exchange: Exchange;
  ledger: Ledger;
  stats: Stats;
  markets: Map<number, Market>;
  feeds: Map<number, PriceFeed>;
  tapes: Map<number, Tape>;
  /** By the owner's address. */
  views: Map<string, View>;
};

export async function snapshotOf(
  owners: PublicKey[],
  marketIds: number[],
): Promise<Snapshot> {
  const bytes = new Map<string, Buffer>();
  const read = async (name: string, address: PublicKey) => {
    const data = await throughThePort(address);
    bytes.set(name, data);
    return data;
  };
  const exchange = decodeExchange(await read("exchange", addresses.exchange));
  const ledger = decodeLedger(await read("ledger", addresses.ledger));
  const stats = decodeStats(await read("stats", addresses.stats));
  const markets = new Map<number, Market>();
  const feeds = new Map<number, PriceFeed>();
  const tapes = new Map<number, Tape>();
  for (const id of marketIds) {
    markets.set(
      id,
      decodeMarket(await read(`market ${id}`, addresses.market(id))),
    );
    await read(`book ${id}`, addresses.book(id));
    tapes.set(id, decodeTape(await read(`tape ${id}`, addresses.tape(id))));
    feeds.set(
      id,
      decodePriceFeed(await read(`price feed ${id}`, addresses.priceFeed(id))),
    );
  }
  const views = new Map<string, View>();
  for (const owner of owners) {
    const key = owner.toBase58();
    views.set(
      key,
      decodeView(await read(`view ${key}`, addresses.view(owner))),
    );
  }
  return { bytes, exchange, ledger, stats, markets, feeds, tapes, views };
}

/** What a book's header counts: the resting orders on each side and the open interest in lots. */
export function bookCounts(snapshot: Snapshot, marketId: number) {
  const data = snapshot.bytes.get(`book ${marketId}`);
  if (!data) throw new Error(`the snapshot has no book ${marketId}`);
  return {
    bids: data.readUInt32LE(HEADER_LEN + BID_COUNT_AT),
    asks: data.readUInt32LE(HEADER_LEN + ASK_COUNT_AT),
    openInterest: data.readBigUInt64LE(HEADER_LEN + OPEN_INTEREST_AT),
  };
}

/** What the seat of `owner` holds on `marketId`, as the ledger of the snapshot has it. */
export function positionOf(
  snapshot: Snapshot,
  owner: PublicKey,
  marketId: number,
): PerpSlot {
  const view = snapshot.views.get(owner.toBase58());
  if (!view) throw new Error(`the snapshot has no view of ${owner.toBase58()}`);
  return positionOn(snapshot.ledger.seats[view.seat], marketId);
}

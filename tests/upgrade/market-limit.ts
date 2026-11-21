/**
 * The limit on perp markets, on the exchange the upgrade story ended with:
 * perp markets are created and finalised until the exchange has six, and
 * `create_market_v2` refuses a seventh before it creates any account.
 */
import { expect } from "chai";
import {
  ACCOUNT_LEN,
  GROW_KIND,
  MAX_MARKETS,
  growToFullSize,
} from "../../sdk/dist/index.js";
import { addresses, admin, instructions, rollup, send } from "../support";
import { exchangeOn, perpMarket, refuses } from "../orderbook/world";

const MOST_PERP_MARKETS = 6;

const perpCount = (bits: number) =>
  Array.from({ length: MAX_MARKETS }, (_, id) => (bits >> id) & 1).reduce(
    (total: number, bit) => total + bit,
    0,
  );

/** A perp market made ready, with no trigger book: enough for the exchange to count it. */
async function finalised(marketId: number): Promise<void> {
  await send(
    rollup,
    instructions.createMarket(admin.publicKey, marketId, perpMarket()),
    admin,
  );
  await growToFullSize(
    rollup,
    admin,
    GROW_KIND.book,
    marketId,
    addresses.book(marketId),
    ACCOUNT_LEN.book,
  );
  await growToFullSize(
    rollup,
    admin,
    GROW_KIND.tape,
    marketId,
    addresses.tape(marketId),
    ACCOUNT_LEN.tape,
  );
  await send(
    rollup,
    instructions.finalizeMarket(admin.publicKey, marketId),
    admin,
  );
}

describe("upgrade: the limit on perp markets", () => {
  it("makes perp markets until the exchange has six, and refuses a seventh before it creates any of its accounts", async function () {
    this.timeout(600_000);
    const taken = (await exchangeOn(rollup)).perpMarkets;
    const unused = Array.from({ length: MAX_MARKETS }, (_, id) => id).filter(
      (id) => ((taken >> id) & 1) === 0,
    );
    const room = MOST_PERP_MARKETS - perpCount(taken);
    expect(
      unused.length,
      "a seventh perp market has an id to take",
    ).to.be.greaterThan(room);
    for (const id of unused.slice(0, room)) await finalised(id);
    expect(perpCount((await exchangeOn(rollup)).perpMarkets)).to.equal(
      MOST_PERP_MARKETS,
    );

    const seventh = unused[room];
    await refuses(
      send(
        rollup,
        instructions.createMarket(admin.publicKey, seventh, perpMarket()),
        admin,
      ),
      "TooManyPerpMarkets",
    );
    for (const address of [
      addresses.market(seventh),
      addresses.book(seventh),
      addresses.tape(seventh),
      addresses.priceFeed(seventh),
    ]) {
      expect(await rollup.getAccountInfo(address), address.toBase58()).to.equal(
        null,
      );
    }
    expect(perpCount((await exchangeOn(rollup)).perpMarkets)).to.equal(
      MOST_PERP_MARKETS,
    );
  });
});

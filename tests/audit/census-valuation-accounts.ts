/**
 * Audit against a census of hacks on perpetuals venues: the accounts a
 * trader passes to value its own cross-margin account. `withdraw`, a perp
 * `place_order`, `liquidate` and `transfer_between_balances` read every perp
 * market's market, book and price feed from the remaining accounts the caller
 * chooses. A substituted price feed that were accepted would let a seat
 * withdraw, trade or liquidate at a mark of its own choosing.
 *
 * A trader with a long on the perp market tries each instruction with the
 * perp market left out, given twice, given with another market's book or
 * price feed, with an account this program does not own as its price feed,
 * in the wrong order, and one account short. Every attempt is refused, and
 * nothing anyone holds moves. The same withdrawal with the real accounts
 * then lands.
 *
 * Runs after the story and the other audit parts; it opens two traders of
 * its own and leaves every other seat as it found it.
 */
import { expect } from "chai";
import type { PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  ORDER_TYPE,
  SIDE,
  decodePriceFeed,
  type OrderKeyCall,
  type OrderKeyUse,
} from "../../sdk/dist/index.js";
import {
  addresses,
  balanceOf,
  inPublic,
  instructions,
  ledgerThroughThePort,
  rollup,
  rollupNow,
  send,
  until,
} from "../support";
import {
  COLLATERAL,
  NUSD,
  PERP,
  SPOT,
  TINY,
  USD,
  attempted,
  call,
  custodyMatchesLedger,
  custodyOf,
  deposited,
  fundedWith,
  landed,
  mints,
  openedTrader,
  oracle,
  order,
  refuses,
  tokenAccount,
  type Trader,
} from "../orderbook/world";

/** What a substitution is called, the remaining accounts it passes, and the error it must meet. */
type Substitution = [string, PublicKey[], string];

/**
 * The triple of `main` passed wrongly, with `other`'s accounts as the
 * lookalikes and `foreign` as an account this program does not own.
 */
function substitutions(
  main: number,
  other: number,
  foreign: PublicKey,
): Substitution[] {
  const [market, book, feed] = addresses.riskAccounts(main);
  const [, otherBook, otherFeed] = addresses.riskAccounts(other);
  return [
    [
      "the same market twice",
      [market, book, feed, market, book, feed],
      "DuplicateMarket",
    ],
    [
      "another market's price feed",
      [market, book, otherFeed],
      "WrongDerivation",
    ],
    ["another market's book", [market, otherBook, feed], "WrongDerivation"],
    [
      "a price feed this program does not own",
      [market, book, foreign],
      "WrongOwner",
    ],
    [
      "price feed, book and market in that order",
      [feed, book, market],
      "WrongKind",
    ],
    [
      "two accounts where three belong",
      [market, book],
      "MalformedRemainingAccounts",
    ],
  ];
}

const named = (instruction: TransactionInstruction, risk: PublicKey[]) => {
  instruction.keys.push(
    ...risk.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
  );
  return instruction;
};

const PRICE_FEED_OF_AN_ORDER_KEY_CALL = 6;

describe("audit: the accounts a trader names to value its own position", () => {
  let holder: Trader;
  let keeper: Trader;
  let mark: bigint;

  const seats = async () => {
    const { seats } = await ledgerThroughThePort();
    return [seats[holder.seat], seats[keeper.seat]];
  };

  /** An order-key instruction of `trader` on `marketId` that names only `risk` as remaining accounts. */
  const keyed =
    (
      trader: Trader,
      marketId: number,
      build: (keyCall: OrderKeyCall) => TransactionInstruction,
    ) =>
    (risk: PublicKey[]) =>
    (use: OrderKeyUse, clientOrderId: bigint, expiresAt: bigint) =>
      named(
        build({
          ...call(trader, use, marketId, clientOrderId, expiresAt),
          riskMarkets: [],
        }),
        risk,
      );

  before(async () => {
    holder = await openedTrader();
    keeper = await openedTrader();
    for (const trader of [holder, keeper]) {
      await fundedWith(trader, mints.nUSD, 60n * USD);
      await deposited(trader, mints.nUSD, COLLATERAL, 50n * USD);
    }
    await deposited(holder, mints.nUSD, { spot: NUSD }, 5n * USD);

    const feed = decodePriceFeed(await inPublic(addresses.priceFeed(PERP)));
    mark = feed.price;
    await until(
      async () => (await rollupNow()) > Number(feed.acceptedAt),
      "the rollup clock to pass the perp feed's last price",
      30_000,
      50,
    );
    await send(
      rollup,
      instructions.publishPrice(
        oracle.publicKey,
        PERP,
        mark,
        BigInt(await rollupNow()),
      ),
      oracle,
    );
    const ask = mark + 100n;
    landed(
      await keeper.client.placeOrder(
        PERP,
        order(SIDE.ask, ORDER_TYPE.postOnly, ask, 100n),
      ),
    );
    const bought = landed(
      await holder.client.placeOrder(
        PERP,
        order(SIDE.bid, ORDER_TYPE.immediateOrCancel, ask, 100n),
      ),
    );
    expect(bought.filled).to.equal(100n);
    await keeper.client.cancelAll(PERP);
    const [held] = await seats();
    expect(held.perp[PERP].base, "the holder is long").to.equal(100n);
    await custodyMatchesLedger();
  });

  it("refuses every substituted, missing or malformed valuation account, and moves nothing", async () => {
    const before = await seats();
    const to = tokenAccount(holder, mints.nUSD);
    const tokensBefore = await balanceOf(to);
    const custodyBefore = await balanceOf(
      addresses.custody(custodyOf(mints.nUSD)),
    );

    const withdrawal = (risk: PublicKey[]) =>
      named(
        instructions.withdraw(
          holder.owner.publicKey,
          to,
          custodyOf(mints.nUSD),
          COLLATERAL,
          1n,
          [],
        ),
        risk,
      );
    const leftOut: Substitution[] = [
      ["no perp market at all", [], "MarketDataMissing"],
      ["only a spot market", addresses.riskAccounts(TINY), "MarketDataMissing"],
    ];
    for (const [what, risk, error] of [
      ...leftOut,
      ...substitutions(PERP, SPOT, to),
    ]) {
      await refuses(
        send(rollup, withdrawal(risk), holder.owner),
        error,
        `withdraw, ${what}`,
      );
    }

    const transfer = keyed(holder, SPOT, (keyCall) =>
      instructions.transferBetweenBalances(keyCall, false, NUSD, 1n),
    );
    for (const [what, risk, error] of [
      ["no perp market at all", [], "MarketDataMissing"] as Substitution,
      ...substitutions(PERP, TINY, to),
    ]) {
      await refuses(
        attempted(holder, transfer(risk)),
        error,
        `transfer_between_balances, ${what}`,
      );
    }

    const placing = keyed(holder, PERP, (keyCall) =>
      instructions.placeOrder(
        keyCall,
        order(SIDE.bid, ORDER_TYPE.limit, mark - 1_000n, 10n),
      ),
    );
    const liquidating = keyed(keeper, PERP, (keyCall) =>
      instructions.liquidate(keyCall, holder.seat, 100n, mark * 2n),
    );
    for (const [instruction, trader, build] of [
      ["place_order", holder, placing],
      ["liquidate", keeper, liquidating],
    ] as const) {
      for (const [what, risk, error] of substitutions(TINY, SPOT, to)) {
        await refuses(
          attempted(trader, build(risk)),
          error,
          `${instruction}, ${what}`,
        );
      }
      const lookalikeFeed = (
        use: OrderKeyUse,
        clientOrderId: bigint,
        expiresAt: bigint,
      ) => {
        const substituted = build([])(use, clientOrderId, expiresAt);
        substituted.keys[PRICE_FEED_OF_AN_ORDER_KEY_CALL] = {
          ...substituted.keys[PRICE_FEED_OF_AN_ORDER_KEY_CALL],
          pubkey: addresses.priceFeed(SPOT),
        };
        return substituted;
      };
      await refuses(
        attempted(trader, lookalikeFeed),
        "ConstraintSeeds",
        `${instruction}, the spot market's price feed as the perp market's own`,
      );
    }

    expect(await seats()).to.deep.equal(before);
    expect(await balanceOf(to)).to.equal(tokensBefore);
    expect(await balanceOf(addresses.custody(custodyOf(mints.nUSD)))).to.equal(
      custodyBefore,
    );
    await custodyMatchesLedger();

    await send(rollup, withdrawal(addresses.riskAccounts(PERP)), holder.owner);
    expect((await balanceOf(to)) - tokensBefore).to.equal(1n);
    await custodyMatchesLedger();
  });
});

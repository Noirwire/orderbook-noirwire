/**
 * Audit, the access lists of RULES 3a on the local network. Needs the program
 * running and the story's mints, perp market and keys, so it runs after the
 * story and the other audit parts.
 *
 * It proves:
 *
 * 1. State created before any access write reads zero in every access byte:
 *    every market's switches, every open seat's lists and block flag. Under
 *    `make test-audit` this build made that state, so it shows only that a
 *    fresh exchange starts clear. Under `make test-upgrade` an earlier build
 *    made it and this one was deployed over it in place, which is the proof
 *    that an upgrade reads the bytes the access lists took from padding as
 *    zero.
 * 2. Only the admin can set a market's switches or a seat's lists.
 * 3. `set_seat_access` names the admin, the exchange, the ledger and the book
 *    of every perp market, the same accounts with the same flags whoever the
 *    seat is and whatever is set, and the owner it is about appears in none
 *    of them. Through the private endpoint, neither a stranger nor the admin
 *    is shown its accounts, logs or data, and no public account other than
 *    the exchange lists its signature.
 * 4. With the maker list on, an unlisted seat's resting orders are refused
 *    with `MakerNotListed` and its immediate orders fill against the listed
 *    maker. Delisting the maker cancels its resting orders in that
 *    instruction, so the next taker meets nothing and the tape does not move.
 *    The delisted maker closes its position with a reduce-only order.
 * 5. A blocked seat is refused new orders with `SeatBlocked`, and still
 *    cancels and withdraws; a stranger's deposit into it lands.
 * 6. With both lists on, a keeper that is on neither list liquidates; a
 *    blocked one is refused with `SeatBlocked`.
 * 7. Delisting a maker whose one order is the worst of a full bid side, the
 *    most a cleared maker bit scans and shifts on one book, lands and removes
 *    that order; the compute it used is printed, against the 200,000 units a
 *    transaction gets when it asks for nothing.
 *
 * It leaves both switches off, the market active at the mark it found, every
 * seat it listed unlisted and every order it rested cancelled.
 */
import { expect } from "chai";
import { Keypair, type Connection, type PublicKey } from "@solana/web3.js";
import {
  HEADER_LEN,
  LIQUIDATION_STATUS,
  MARKET_ACCESS,
  ORDER_TYPE,
  RESULT_STATUS,
  SIDE,
  decodePriceFeed,
  type SeatAccess,
} from "../../sdk/dist/index.js";
import {
  addresses,
  admin,
  anonymous,
  inPublic,
  instructions,
  ledgerThroughThePort,
  publicMarket,
  publicTape,
  readingAs,
  rollup,
  rollupNow,
  send,
  throughThePort,
  until,
  viewThroughThePort,
} from "../support";
import {
  COLLATERAL,
  PERP,
  USD,
  attempted,
  call,
  custodyOf,
  deposited,
  exchangeOn,
  funded,
  fundedWith,
  landed,
  mints,
  openedTrader,
  oracle,
  order,
  placing,
  refuses,
  stranger,
  tokenAccount,
  type Trader,
} from "../orderbook/world";

const TICK = 100n;
const NOBODY: SeatAccess = { makerMarkets: 0, takerMarkets: 0, blocked: false };
const PERP_BIT = 1 << PERP;

let perpMarketIds: number[] = [];

const feed = async () =>
  decodePriceFeed(await inPublic(addresses.priceFeed(PERP)));

/** The perp mark, republished at the rollup's clock so orders can use it. */
async function freshMark(): Promise<bigint> {
  const { price, acceptedAt } = await feed();
  await until(
    async () => (await rollupNow()) > Number(acceptedAt),
    "the rollup clock to pass the last accepted price",
    30_000,
    50,
  );
  await send(
    rollup,
    instructions.publishPrice(
      oracle.publicKey,
      PERP,
      price,
      BigInt(await rollupNow()),
    ),
    oracle,
  );
  return price - (price % TICK);
}

const seatAccess = (owner: PublicKey, access: SeatAccess) =>
  send(
    rollup,
    instructions.setSeatAccess(admin.publicKey, owner, access, perpMarketIds),
    admin,
  );

const marketAccess = (makersListed: boolean, takersListed: boolean) =>
  send(
    rollup,
    instructions.setMarketAccess(admin.publicKey, PERP, {
      makersListed,
      takersListed,
    }),
    admin,
  );

const seatOf = async (trader: Trader) =>
  (await ledgerThroughThePort()).seats[trader.seat];

async function trader(collateral: bigint): Promise<Trader> {
  const opened = await openedTrader();
  await fundedWith(opened, mints.nUSD, collateral);
  await deposited(opened, mints.nUSD, COLLATERAL, collateral);
  return opened;
}

const placed = async (
  seat: Trader,
  side: number,
  orderType: number,
  price: bigint,
  size: bigint,
  reduceOnly = false,
) =>
  landed(
    await seat.client.placeOrder(PERP, {
      ...order(side, orderType, price, size),
      reduceOnly,
    }),
  );

/** An order sent raw, so a refusal is the program's error by name. */
const sentRaw = (
  seat: Trader,
  side: number,
  orderType: number,
  price: bigint,
  size: bigint,
) => attempted(seat, placing(seat, PERP, order(side, orderType, price, size)));

/** What `connection` shows of a landed transaction, as one string, or `"none"`. */
async function shown(connection: Connection, signature: string) {
  const landed = await connection
    .getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    })
    .catch(() => null);
  if (!landed) return "none";
  const message = landed.transaction.message;
  const compiled =
    "compiledInstructions" in message ? message.compiledInstructions : [];
  return JSON.stringify({
    accounts: landed.transaction.message
      .getAccountKeys()
      .staticAccountKeys.map((key) => key.toBase58()),
    logs: landed.meta?.logMessages ?? [],
    data: compiled.map((ix) => Buffer.from(ix.data).toString("hex")),
  });
}

const SDK_DEFAULT_COMPUTE = 200_000;
const BOOK_HEADER_LEN = 72;
const BID_COUNT_AT = 32;
const ORDER_SEAT_AT = 56;

/** The perp book's bid count and the seat of its worst bid, which sits at index 0. */
async function bidSide(): Promise<{ count: number; worstSeat?: number }> {
  const data = await throughThePort(addresses.book(PERP));
  const count = data.readUInt32LE(HEADER_LEN + BID_COUNT_AT);
  if (count === 0) return { count };
  const worst = HEADER_LEN + BOOK_HEADER_LEN;
  return { count, worstSeat: data.readUInt32LE(worst + ORDER_SEAT_AT) };
}

/** Lots for the smallest order the market takes at `price`: one nUSD of notional. */
const leastLots = (price: bigint) => (USD + price - 1n) / price;

const onTick = (price: bigint) => price - (price % TICK);

async function listedBy(address: PublicKey): Promise<Set<string>> {
  const listed = await anonymous
    .getSignaturesForAddress(address, { limit: 1_000 })
    .catch(() => []);
  return new Set(listed.map((entry) => entry.signature));
}

describe("audit: access lists", () => {
  const signatures: string[] = [];
  const owners: PublicKey[] = [];

  before(async () => {
    const exchange = await exchangeOn(rollup);
    perpMarketIds = [0, 1, 2, 3, 4, 5, 6, 7].filter(
      (id) => (exchange.perpMarkets >> id) & 1,
    );
    expect(perpMarketIds).to.include(PERP);
  });

  after(async () => {
    await marketAccess(false, false);
    for (const owner of owners) await seatAccess(owner, NOBODY);
  });

  it("reads zero in every access byte of state made before any access write", async () => {
    const ledger = await ledgerThroughThePort();
    const open = ledger.seats.filter((seat) => seat.status === 1);
    expect(open.length).to.be.greaterThan(2);
    for (const seat of open) {
      expect([
        seat.makerMarkets,
        seat.takerMarkets,
        seat.blocked,
      ]).to.deep.equal([0, 0, false]);
    }
    const exchange = await exchangeOn(rollup);
    for (const id of perpMarketIds) {
      expect((await publicMarket(id)).params.access, `market ${id}`).to.equal(
        0,
      );
    }
    expect(exchange.perpMarkets).to.be.greaterThan(0);
  });

  it("lets only the admin set a market's switches or a seat's lists", async () => {
    const victim = await openedTrader();
    await refuses(
      send(
        rollup,
        instructions.setMarketAccess(stranger.publicKey, PERP, {
          makersListed: true,
          takersListed: true,
        }),
        stranger,
      ),
      "NotAdmin",
    );
    await refuses(
      send(
        rollup,
        instructions.setSeatAccess(
          stranger.publicKey,
          victim.owner.publicKey,
          { makerMarkets: PERP_BIT, takerMarkets: PERP_BIT, blocked: true },
          perpMarketIds,
        ),
        stranger,
      ),
      "NotAdmin",
    );
    expect((await publicMarket(PERP)).params.access).to.equal(0);
    const seat = await seatOf(victim);
    expect([seat.makerMarkets, seat.takerMarkets, seat.blocked]).to.deep.equal([
      0,
      0,
      false,
    ]);
  });

  it("names the same accounts with the same flags for every seat and setting, and shows nobody what it set", async () => {
    const [listed, unlisted, blocked] = [
      await openedTrader(),
      await openedTrader(),
      await openedTrader(),
    ];
    owners.push(listed.owner.publicKey, blocked.owner.publicKey);
    const settings: [Trader, SeatAccess][] = [
      [
        listed,
        { makerMarkets: PERP_BIT, takerMarkets: PERP_BIT, blocked: false },
      ],
      [unlisted, NOBODY],
      [blocked, { makerMarkets: 0, takerMarkets: 0, blocked: true }],
    ];
    const expected = [
      `${admin.publicKey.toBase58()} s-`,
      `${addresses.exchange.toBase58()} --`,
      `${addresses.ledger.toBase58()} -w`,
      ...perpMarketIds.map((id) => `${addresses.book(id).toBase58()} -w`),
    ];
    const moveFees = instructions.moveFeesToInsurance(admin.publicKey, 1n);
    const flags = (account: {
      pubkey: PublicKey;
      isSigner: boolean;
      isWritable: boolean;
    }) =>
      `${account.pubkey.toBase58()} ${account.isSigner ? "s" : "-"}${account.isWritable ? "w" : "-"}`;
    expect(expected.slice(0, 3)).to.deep.equal(moveFees.keys.map(flags));

    for (const [seat, access] of settings) {
      const built = instructions.setSeatAccess(
        admin.publicKey,
        seat.owner.publicKey,
        access,
        perpMarketIds,
      );
      expect(built.keys.map(flags)).to.deep.equal(expected);
      signatures.push(await send(rollup, built, admin));
      const stored = await seatOf(seat);
      expect([
        stored.makerMarkets,
        stored.takerMarkets,
        stored.blocked,
      ]).to.deep.equal([
        access.makerMarkets,
        access.takerMarkets,
        access.blocked,
      ]);
    }

    const readers = [
      anonymous,
      await readingAs(stranger),
      await readingAs(admin),
    ];
    for (const [index, signature] of signatures.entries()) {
      const owner = settings[index][0].owner.publicKey;
      for (const reader of readers) {
        const seen = await shown(reader, signature);
        const named = seen.includes(owner.toBase58());
        const carried = seen.includes(
          Buffer.from(owner.toBytes()).toString("hex"),
        );
        expect(
          named || carried,
          "the private endpoint shows the owner",
        ).to.equal(false);
        if (seen !== "none") {
          const { accounts, logs } = JSON.parse(seen);
          expect(accounts, "accounts shown").to.have.length(0);
          expect(logs, "logs shown").to.have.length(0);
        }
      }
    }

    const publicAccounts = [
      addresses.market(PERP),
      addresses.priceFeed(PERP),
      addresses.tape(PERP),
      addresses.stats,
      addresses.book(PERP),
      addresses.ledger,
      ...settings.map(([seat]) => addresses.view(seat.owner.publicKey)),
    ];
    for (const address of publicAccounts) {
      const listed = await listedBy(address);
      const linked = signatures.filter((signature) => listed.has(signature));
      expect(linked, `listed by ${address.toBase58()}`).to.have.length(0);
    }
  });

  it("refuses an unlisted maker, fills an unlisted taker, and cancels a delisted maker's orders at once", async () => {
    const price = await freshMark();
    const lots = leastLots(price);
    const maker = await trader(100n * USD);
    const retail = await trader(100n * USD);
    const backstop = await trader(100n * USD);
    owners.push(maker.owner.publicKey, backstop.owner.publicKey);
    await seatAccess(maker.owner.publicKey, {
      makerMarkets: PERP_BIT,
      takerMarkets: PERP_BIT,
      blocked: false,
    });
    await marketAccess(true, false);
    try {
      expect((await publicMarket(PERP)).params.access).to.equal(
        MARKET_ACCESS.makersListed,
      );

      for (const orderType of [ORDER_TYPE.limit, ORDER_TYPE.postOnly]) {
        await refuses(
          sentRaw(retail, SIDE.bid, orderType, price, 2n * lots),
          "MakerNotListed",
          `orderType ${orderType}`,
        );
      }
      const rested = await placed(
        maker,
        SIDE.ask,
        ORDER_TYPE.postOnly,
        price,
        3n * lots,
      );
      expect(rested.status).to.equal(RESULT_STATUS.rested);
      const bought = await placed(
        retail,
        SIDE.bid,
        ORDER_TYPE.immediateOrCancel,
        price,
        lots,
      );
      expect(bought.filled).to.equal(lots);

      const tapeBefore = (await publicTape(PERP)).written;
      const delisting = await seatAccess(maker.owner.publicKey, {
        makerMarkets: 0,
        takerMarkets: PERP_BIT,
        blocked: false,
      });
      const used = (
        await rollup.getTransaction(delisting, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        })
      )?.meta?.computeUnitsConsumed;
      console.log(
        `      a delisting that cancelled a resting order used ${used} compute units`,
      );
      expect(Number(used)).to.be.at.most(200_000);
      const delisted = await seatOf(maker);
      expect(delisted.openOrders[PERP], "cancelled by the delisting").to.equal(
        0,
      );
      expect(delisted.perp[PERP].openAskLots).to.equal(0n);
      const missed = await placed(
        retail,
        SIDE.bid,
        ORDER_TYPE.immediateOrCancel,
        price,
        lots,
      );
      expect(missed.filled).to.equal(0n);
      expect((await publicTape(PERP)).written).to.equal(tapeBefore);
      await refuses(
        sentRaw(maker, SIDE.ask, ORDER_TYPE.limit, price, lots),
        "MakerNotListed",
      );

      await maker.client.syncView(PERP);
      const own = (await maker.client.view()).snapshot.seat;
      expect([own.makerMarkets, own.takerMarkets, own.blocked]).to.deep.equal([
        0,
        PERP_BIT,
        false,
      ]);
      expect(
        (await viewThroughThePort(maker.owner.publicKey)).snapshot.seat
          .makerMarkets,
      ).to.equal(0);

      await seatAccess(backstop.owner.publicKey, {
        makerMarkets: PERP_BIT,
        takerMarkets: 0,
        blocked: false,
      });
      await placed(backstop, SIDE.ask, ORDER_TYPE.postOnly, price, lots);
      const closed = await placed(
        maker,
        SIDE.bid,
        ORDER_TYPE.immediateOrCancel,
        price,
        lots,
        true,
      );
      expect(closed.filled).to.equal(lots);
      expect((await seatOf(maker)).perp[PERP].base).to.equal(0n);
    } finally {
      await marketAccess(false, false);
    }
  });

  it("refuses a blocked seat's new orders and keeps its exits; a stranger's deposit into it lands", async () => {
    const price = await freshMark();
    const below = price - 10n * TICK;
    const seat = await trader(20n * USD);
    owners.push(seat.owner.publicKey);
    const resting = await placed(
      seat,
      SIDE.bid,
      ORDER_TYPE.postOnly,
      below,
      leastLots(below),
    );
    expect(resting.status).to.equal(RESULT_STATUS.rested);
    await seatAccess(seat.owner.publicKey, { ...NOBODY, blocked: true });

    for (const orderType of [
      ORDER_TYPE.limit,
      ORDER_TYPE.postOnly,
      ORDER_TYPE.immediateOrCancel,
    ]) {
      await refuses(
        sentRaw(seat, SIDE.bid, orderType, price, leastLots(price)),
        "SeatBlocked",
        `orderType ${orderType}`,
      );
    }
    expect((await seat.client.cancelAll(PERP)).cancelled).to.equal(1n);

    const depositor = await openedTrader();
    await fundedWith(depositor, mints.nUSD, 3n * USD);
    const before = (await seatOf(seat)).collateral;
    await send(
      rollup,
      instructions.deposit(
        depositor.owner.publicKey,
        tokenAccount(depositor, mints.nUSD),
        custodyOf(mints.nUSD),
        seat.owner.publicKey,
        COLLATERAL,
        3n * USD,
      ),
      depositor.owner,
    );
    expect((await seatOf(seat)).collateral).to.equal(before + 3n * USD);

    await send(
      rollup,
      instructions.withdraw(
        seat.owner.publicKey,
        tokenAccount(seat, mints.nUSD),
        custodyOf(mints.nUSD),
        COLLATERAL,
        5n * USD,
        perpMarketIds,
      ),
      seat.owner,
    );
    expect((await seatOf(seat)).collateral).to.equal(before - 2n * USD);
  });

  it("lets a keeper on neither list liquidate with both lists on, and refuses a blocked one", async () => {
    const price = await freshMark();
    const lots = 100n;
    const notional = lots * price;
    const fee = (notional * 5n + 9_999n) / 10_000n;
    const initial = notional / 10n;
    const maker = await trader(200n * USD);
    const target = await trader(initial + fee + 1_000n);
    const keeper = await trader(200n * USD);
    const blockedKeeper = await trader(200n * USD);
    owners.push(maker.owner.publicKey, blockedKeeper.owner.publicKey);
    await placed(maker, SIDE.ask, ORDER_TYPE.postOnly, price, lots);
    expect(
      (
        await placed(
          target,
          SIDE.bid,
          ORDER_TYPE.immediateOrCancel,
          price,
          lots,
        )
      ).filled,
    ).to.equal(lots);

    await seatAccess(maker.owner.publicKey, {
      makerMarkets: PERP_BIT,
      takerMarkets: PERP_BIT,
      blocked: false,
    });
    await seatAccess(blockedKeeper.owner.publicKey, {
      ...NOBODY,
      blocked: true,
    });
    await marketAccess(true, true);
    let markCrashed = false;
    try {
      const crashed = price - 100n * TICK;
      await send(
        rollup,
        instructions.resetPrice(
          admin.publicKey,
          PERP,
          crashed,
          BigInt(await rollupNow()),
        ),
        admin,
      );
      markCrashed = true;

      await refuses(
        attempted(blockedKeeper, (use, clientOrderId, expiresAt) =>
          instructions.liquidate(
            call(blockedKeeper, use, PERP, clientOrderId, expiresAt),
            target.seat,
            lots,
            price,
          ),
        ),
        "SeatBlocked",
      );
      const done = await keeper.client.liquidate(
        PERP,
        target.seat,
        lots,
        price,
      );
      expect(done.status).to.equal(LIQUIDATION_STATUS.liquidated);
      expect(done.filled > 0n).to.equal(true);
    } finally {
      await marketAccess(false, false);
      if (markCrashed) {
        await send(
          rollup,
          [
            instructions.resetPrice(
              admin.publicKey,
              PERP,
              price,
              BigInt(await rollupNow()),
            ),
            instructions.resumeMarket(admin.publicKey, PERP, perpMarketIds),
          ],
          admin,
        );
      }
    }
    expect((await publicMarket(PERP)).params.status).to.equal(0);
  });

  it("delists a maker whose one order is the worst of a full bid side, and prints the compute it used", async () => {
    const price = await freshMark();
    const worst = onTick(price / 2n) + TICK;
    const filling = onTick((price * 6n) / 10n);
    const { capacity, params } = await publicMarket(PERP);
    const maker = await trader(10n * USD);
    owners.push(maker.owner.publicKey);
    await seatAccess(maker.owner.publicKey, {
      makerMarkets: PERP_BIT,
      takerMarkets: 0,
      blocked: false,
    });
    const rested = await placed(
      maker,
      SIDE.bid,
      ORDER_TYPE.postOnly,
      worst,
      leastLots(worst),
    );
    expect(rested.status).to.equal(RESULT_STATUS.rested);

    const free = capacity - (await bidSide()).count;
    const whale = Keypair.generate();
    const fillers: Trader[] = [];
    for (let left = free; left > 0; left -= params.maxOpenOrders) {
      fillers.push(await openedTrader());
    }
    const whaleUsd = await funded(
      whale,
      mints.nUSD,
      BigInt(fillers.length) * 10n * USD,
    );
    for (const filler of fillers) {
      await send(
        rollup,
        instructions.deposit(
          whale.publicKey,
          whaleUsd,
          custodyOf(mints.nUSD),
          filler.owner.publicKey,
          COLLATERAL,
          10n * USD,
        ),
        whale,
      );
    }

    try {
      await Promise.all(
        fillers.map(async (filler, index) => {
          const share = Math.min(
            params.maxOpenOrders,
            free - index * params.maxOpenOrders,
          );
          for (let n = 0; n < share; n += 1) {
            await attempted(
              filler,
              placing(
                filler,
                PERP,
                order(
                  SIDE.bid,
                  ORDER_TYPE.postOnly,
                  filling,
                  leastLots(filling),
                ),
              ),
            );
          }
        }),
      );
      expect(
        await bidSide(),
        "the maker's bid is the worst of a full side",
      ).to.deep.equal({
        count: capacity,
        worstSeat: maker.seat,
      });

      const delisting = await seatAccess(maker.owner.publicKey, NOBODY);
      const used = Number(
        (
          await rollup.getTransaction(delisting, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          })
        )?.meta?.computeUnitsConsumed,
      );
      console.log(
        `      delisting the worst of ${capacity} bids used ${used} compute units (${used <= SDK_DEFAULT_COMPUTE ? "within" : "over"} the ${SDK_DEFAULT_COMPUTE} a transaction gets by default)`,
      );
      expect(used).to.be.greaterThan(0);
      expect((await seatOf(maker)).openOrders[PERP]).to.equal(0);
      expect((await bidSide()).count).to.equal(capacity - 1);
    } finally {
      for (const filler of fillers) {
        await filler.client.cancelAll(PERP).catch(() => undefined);
      }
      await maker.client.cancelAll(PERP).catch(() => undefined);
    }
  });
});

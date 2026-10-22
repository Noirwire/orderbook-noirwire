/**
 * Audit, availability and privacy on the local network. It needs the program
 * running and the story's cast, mints and keys, so it runs after the story:
 * import it at the end of `tests/orderbook.test.ts`
 * (`import "./audit/availability-privacy-network";`).
 *
 * It creates its own spot market (id 7), fills the bid side to its capacity
 * of 1,024 with 32 seats, and then measures:
 *
 * 1. that a better-priced bid from anyone else rests, evicting the worst bid;
 * 2. the compute units such an eviction, a 16-fill sweep and a `cancel_all`
 *    use against that book, compared with the 200,000 a transaction of one
 *    instruction gets when it asks for nothing (the SDK sends no compute budget
 *    instruction);
 * 3. whether an SDK `cancelAll` on that book lands at all;
 * 4. whether a stranger on the private endpoint can list a trader's
 *    transactions by the address of their view, tell orders with different
 *    outcomes apart by the compute it is shown, or tell an order from a cancel
 *    by the public accounts each one names.
 *
 * Every order is cancelled at the end, so the network is left as it was.
 */
import { expect } from "chai";
import { Keypair, type PublicKey } from "@solana/web3.js";
import {
  ORDER_TYPE,
  RESULT_STATUS,
  SIDE,
  setupMarket,
} from "../../sdk/dist/index.js";
import {
  addresses,
  admin,
  anonymous,
  instructions,
  rollup,
  rollupNow,
  send,
} from "../support";
import {
  MARK,
  NSOL,
  NUSD,
  PERP,
  SOL,
  USD,
  attempted,
  call,
  custodyOf,
  funded,
  landed,
  mints,
  openedTrader,
  order,
  placing,
  resultFor,
  spotMarket,
  type Trader,
} from "../orderbook/world";

const AUDIT_MARKET = 7;
const SIDE_CAPACITY = 1_024;
const OPEN_ORDERS = 32;
const SWEPT_MAKERS = 16;
const SDK_DEFAULT_COMPUTE = 200_000;
const FAR_BID = MARK / 2n;
const MIN_LOTS = (price: bigint) => (1_000_000n + price - 1n) / price;

async function computeOf(signature: string): Promise<number> {
  const landed = await rollup.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  const used = landed?.meta?.computeUnitsConsumed;
  if (used === undefined) throw new Error(`no compute shown for ${signature}`);
  return Number(used);
}

async function signaturesSeenBy(address: PublicKey): Promise<Set<string>> {
  const listed = await anonymous
    .getSignaturesForAddress(address, { limit: 1_000 })
    .catch(() => []);
  return new Set(listed.map((entry) => entry.signature));
}

describe("audit: availability and privacy of a full book", () => {
  const makers: Trader[] = [];
  let taker: Trader;
  const whale = Keypair.generate();
  let whaleUsd: PublicKey;
  let whaleSol: PublicKey;
  let sweep = "";
  let cancelAll = "";
  const placedBy = new Map<string, string[]>();

  const depositFor = (
    owner: PublicKey,
    from: PublicKey,
    mint: PublicKey,
    token: number,
    amount: bigint,
  ) =>
    send(
      rollup,
      instructions.deposit(
        whale.publicKey,
        from,
        custodyOf(mint),
        owner,
        { spot: token },
        amount,
      ),
      whale,
    );

  before(async () => {
    await setupMarket(rollup, admin, AUDIT_MARKET, spotMarket(SIDE_CAPACITY));
    await send(
      rollup,
      [
        instructions.resetPrice(
          admin.publicKey,
          AUDIT_MARKET,
          MARK,
          BigInt(await rollupNow()),
        ),
        instructions.resumeMarket(admin.publicKey, AUDIT_MARKET, [PERP]),
      ],
      admin,
    );
    whaleUsd = await funded(whale, mints.nUSD, 2_000n * USD);
    whaleSol = await funded(whale, mints.nSOL, 1n * SOL);
    for (let n = 0; n < SIDE_CAPACITY / OPEN_ORDERS; n += 1) {
      const maker = await openedTrader();
      await depositFor(
        maker.owner.publicKey,
        whaleUsd,
        mints.nUSD,
        NUSD,
        40n * USD,
      );
      makers.push(maker);
    }
    taker = await openedTrader();
    await depositFor(
      taker.owner.publicKey,
      whaleUsd,
      mints.nUSD,
      NUSD,
      40n * USD,
    );
    await depositFor(
      taker.owner.publicKey,
      whaleSol,
      mints.nSOL,
      NSOL,
      SOL / 2n,
    );

    for (const [index, maker] of makers.entries()) {
      const signatures: string[] = [];
      const orders = [];
      if (index < SWEPT_MAKERS) {
        orders.push(order(SIDE.bid, ORDER_TYPE.limit, MARK, MIN_LOTS(MARK)));
      }
      while (orders.length < OPEN_ORDERS) {
        orders.push(
          order(SIDE.bid, ORDER_TYPE.limit, FAR_BID, MIN_LOTS(FAR_BID)),
        );
      }
      for (const sample of orders) {
        const { signature } = await attempted(
          maker,
          placing(maker, AUDIT_MARKET, sample),
        );
        signatures.push(signature);
      }
      placedBy.set(maker.owner.publicKey.toBase58(), signatures);
    }
  });

  after(async () => {
    for (const trader of [...makers, taker]) {
      if (!trader) continue;
      await attempted(trader, (use, clientOrderId, expiresAt) =>
        instructions.cancelAll(
          call(trader, use, AUDIT_MARKET, clientOrderId, expiresAt),
          OPEN_ORDERS,
        ),
      ).catch(() => undefined);
    }
  });

  it("rests anyone's better-priced bid once 32 seats fill the bid side, mostly at half the mark", async () => {
    const better = landed(
      await taker.client.placeOrder(
        AUDIT_MARKET,
        order(SIDE.bid, ORDER_TYPE.limit, MARK - 100n, MIN_LOTS(MARK)),
      ),
    );
    expect(
      better.status,
      "availability (RULES 3.8): a bid better than 1,008 of the 1,024 resting bids must evict the worst and rest",
    ).to.equal(RESULT_STATUS.rested);
  });

  it("evicts from a full side inside the compute an SDK transaction gets by default", async () => {
    const placed = await attempted(
      taker,
      placing(
        taker,
        AUDIT_MARKET,
        order(SIDE.bid, ORDER_TYPE.limit, MARK - 100n, MIN_LOTS(MARK)),
      ),
    );
    const used = await computeOf(placed.signature);
    console.log(
      `      an eviction near the top of a full side used ${used} compute units`,
    );
    expect(
      used,
      "availability: an order that evicts from a full side must fit the SDK's default compute limit",
    ).to.be.at.most(SDK_DEFAULT_COMPUTE);
  });

  it("sweeps 16 makers inside the compute an SDK transaction gets by default", async () => {
    const sold = await attempted(
      taker,
      placing(
        taker,
        AUDIT_MARKET,
        order(
          SIDE.ask,
          ORDER_TYPE.immediateOrCancel,
          MARK,
          MIN_LOTS(MARK) * BigInt(SWEPT_MAKERS),
        ),
      ),
    );
    sweep = sold.signature;
    const used = await computeOf(sweep);
    console.log(
      `      a 16-fill sweep against a full book used ${used} compute units`,
    );
    expect(
      used,
      "availability: the worst place_order must fit the SDK's default compute limit",
    ).to.be.at.most(SDK_DEFAULT_COMPUTE);
  });

  it("cancels all of one seat's orders on a full book inside the compute an SDK transaction gets by default", async () => {
    const last = makers[makers.length - 1];
    const done = await attempted(last, (use, clientOrderId, expiresAt) =>
      instructions.cancelAll(
        call(last, use, AUDIT_MARKET, clientOrderId, expiresAt),
        OPEN_ORDERS,
      ),
    );
    cancelAll = done.signature;
    const used = await computeOf(cancelAll);
    console.log(
      `      cancel_all of 32 orders on a full side used ${used} compute units`,
    );
    expect(
      used,
      "availability: cancel_all on a full book must fit the SDK's default compute limit",
    ).to.be.at.most(SDK_DEFAULT_COMPUTE);
  });

  it("lands an SDK cancelAll, sent with no compute budget instruction, on a full book", async () => {
    const maker = makers[makers.length - 2];
    const outcome = await maker.client
      .cancelAll(AUDIT_MARKET)
      .then((result) => `cancelled ${result.cancelled}`)
      .catch((error: Error) => `failed: ${error.message.split("\n")[0]}`);
    expect(outcome, "availability: the SDK's own cancelAll must land").to.equal(
      `cancelled ${OPEN_ORDERS}`,
    );
  });

  it("does not let a stranger list a trader's order-key transactions by the address of the trader's view", async () => {
    const maker = makers[0];
    const listed = await signaturesSeenBy(
      addresses.view(maker.owner.publicKey),
    );
    const own = placedBy.get(maker.owner.publicKey.toBase58()) ?? [];
    const linked = own.filter((signature) => listed.has(signature));
    expect(
      linked.length,
      "privacy (DESIGN 4): a stranger links a trader's one-time keys through the view's signature list",
    ).to.equal(0);
  });

  it("shows a stranger the same compute figure for an order whatever it met in the book, and for a cancel_all", async () => {
    const postOnly = async (side: number, price: bigint) => {
      const { clientOrderId, signature } = await attempted(
        taker,
        placing(
          taker,
          AUDIT_MARKET,
          order(side, ORDER_TYPE.postOnly, price, MIN_LOTS(price)),
        ),
      );
      return {
        signature,
        status: (await resultFor(taker, clientOrderId)).status,
      };
    };
    const rested = await postOnly(SIDE.bid, MARK - 200n);
    const refused = await postOnly(SIDE.ask, MARK - 100n);
    expect(rested.status, "a post-only bid below every ask").to.equal(
      RESULT_STATUS.rested,
    );
    expect(refused.status, "a post-only ask onto the best bid").to.equal(
      RESULT_STATUS.refusedPostOnlyWouldMatch,
    );

    const shownFor = async (signature: string) => {
      const shown = await anonymous
        .getTransaction(signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        })
        .catch(() => null);
      const message = shown?.transaction?.message;
      const instructions =
        message && "compiledInstructions" in message
          ? message.compiledInstructions
          : [];
      return JSON.stringify({
        compute: shown?.meta?.computeUnitsConsumed ?? "none",
        instructions: instructions.length,
        dataBytes: instructions.map((ix) => ix.data.length),
      });
    };
    const shown = {
      sweepThatFilled: await shownFor(sweep),
      postOnlyThatRested: await shownFor(rested.signature),
      postOnlyRefusedAsWouldMatch: await shownFor(refused.signature),
      cancelAll: await shownFor(cancelAll),
    };
    console.log(`      what a stranger sees: ${JSON.stringify(shown)}`);
    expect(
      new Set(Object.values(shown)).size,
      "privacy (RULES 3): the compute, instruction count or data length shown to a stranger varies with what the transaction was or met in the book",
    ).to.equal(1);
  });

  it("does not let a stranger tell an order from a cancel by the public accounts each one names", async () => {
    const tape = await signaturesSeenBy(addresses.tape(AUDIT_MARKET));
    const stats = await signaturesSeenBy(addresses.stats);
    const market = await signaturesSeenBy(addresses.market(AUDIT_MARKET));
    const perpMarket = await signaturesSeenBy(addresses.market(PERP));
    const shape = (signature: string) =>
      [tape, stats, market, perpMarket]
        .map((seen) => seen.has(signature))
        .join(",");
    console.log(
      `      seen by a stranger (tape, stats, market, perp market): order ${shape(sweep)}, cancel ${shape(cancelAll)}`,
    );
    expect(
      shape(cancelAll),
      "privacy (DESIGN 1): the accounts of a trading transaction are hidden, yet the public accounts' signature lists set an order apart from a cancel",
    ).to.equal(shape(sweep));
  });
});

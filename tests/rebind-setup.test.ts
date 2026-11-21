import { expect } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  ACCOUNT_LEN,
  Instructions,
  MARKET_KIND,
  MAX_MARKETS,
  setupMarket,
  type MarketSettings,
} from "../sdk/dist/index.js";
import {
  firstSyncFailure,
  heldMarkSyncFailure,
} from "../sdk/dist/operator/index.js";
import { firstSyncVerdict, rebindPreflight } from "../ops/pricesource";

const program = Keypair.generate().publicKey;
const addresses = new Instructions(program).addresses;

const settings = (kind: number): MarketSettings => ({
  kind,
  baseSymbol: "SOL",
  quoteSymbol: "USDC",
  baseToken: 1,
  quoteToken: 2,
  tick: 100n,
  baseLot: 1_000n,
  capacity: 64,
  limits: {
    minSize: 1n,
    minNotional: 1n,
    bandBps: 400,
    imBps: 1_000,
    mmBps: 500,
    takerFeeBps: 5,
    liqPenaltyBps: 100,
    fundingCapBps: 10,
    maxMoveBps: 250,
    maxOpenOrders: 32,
    maxPriceAge: 3_600n,
    fundingInterval: 2n,
    positionCap: 1_000n,
  },
});

const account = (length: number, ready: boolean) => {
  const data = new Uint8Array(length);
  data[8] = ready ? 1 : 0;
  return { data, owner: program, lamports: 1, executable: false };
};

class Stop extends Error {}

/** A connection that holds `markets` by id (ready or not) and stops at the first transaction. */
const fakeConnection = (markets: Record<number, boolean>) => {
  const held = new Map<string, ReturnType<typeof account>>();
  for (const [id, ready] of Object.entries(markets)) {
    held.set(
      addresses.market(Number(id)).toBase58(),
      account(ACCOUNT_LEN.market, ready),
    );
    held.set(
      addresses.book(Number(id)).toBase58(),
      account(ACCOUNT_LEN.book, ready),
    );
    held.set(
      addresses.tape(Number(id)).toBase58(),
      account(ACCOUNT_LEN.tape, ready),
    );
  }
  const sent: number[] = [];
  const connection = {
    sent,
    getAccountInfo: async (address: PublicKey) =>
      held.get(address.toBase58()) ?? null,
    getMultipleAccountsInfo: async (list: PublicKey[]) =>
      list.map((address) => held.get(address.toBase58()) ?? null),
    getLatestBlockhash: async () => ({
      blockhash: PublicKey.default.toBase58(),
      lastValidBlockHeight: 1,
    }),
    sendRawTransaction: async () => {
      sent.push(1);
      throw new Stop("sent");
    },
  };
  return connection;
};

const run = (
  markets: Record<number, boolean>,
  marketId: number,
  kind: number,
) => {
  const connection = fakeConnection(markets);
  const outcome = setupMarket(
    connection as never,
    Keypair.generate(),
    marketId,
    settings(kind),
    program,
  ).then(
    () => null,
    (error: Error) => error,
  );
  return { connection, outcome };
};

describe("creating a perp market while another is created but not finalised", () => {
  const fivePerpsAndOnePending = {
    0: true,
    1: true,
    2: true,
    3: true,
    4: true,
    5: false,
  };

  it("is refused before anything is sent, naming the pending market", async () => {
    const { connection, outcome } = run(
      fivePerpsAndOnePending,
      6,
      MARKET_KIND.perp,
    );
    const error = await outcome;
    expect(error?.message).to.match(/market 5 is created but not finalised/);
    expect(error?.message).to.match(/set-up for market 5/);
    expect(error).to.not.be.instanceOf(Stop);
    expect(connection.sent).to.have.length(0);
  });

  it("still lets the pending market itself be set up again", async () => {
    const { connection, outcome } = run(
      fivePerpsAndOnePending,
      5,
      MARKET_KIND.perp,
    );
    expect(await outcome).to.be.instanceOf(Stop);
    expect(connection.sent).to.have.length(1);
  });

  it("goes ahead when no market is pending", async () => {
    const { connection, outcome } = run(
      { 0: true, 1: true, 2: true, 3: true, 4: true },
      5,
      MARKET_KIND.perp,
    );
    expect(await outcome).to.be.instanceOf(Stop);
    expect(connection.sent).to.have.length(1);
  });

  it("does not look at other markets when a spot market is created", async () => {
    const { connection, outcome } = run(
      fivePerpsAndOnePending,
      6,
      MARKET_KIND.spot,
    );
    expect(await outcome).to.be.instanceOf(Stop);
    expect(connection.sent).to.have.length(1);
  });

  it("reads every market id the program allows", () => {
    expect(MAX_MARKETS).to.equal(8);
  });
});

describe("the rebind preflight and the first sync", () => {
  const observation = (publishTime: number) => ({
    price: 8_000_000_000n,
    expo: -8,
    publishTime,
  });

  it("does not refuse an empty book's rebind because the print is older than the old mark", () => {
    const clock = 100;
    const preflight = rebindPreflight(
      observation(99),
      clock,
      { maxPriceAge: 60, minPublishGap: 10 },
      { publishTime: 100, acceptedAt: 100 },
    );
    expect(preflight.refusal).to.equal(null);
    expect(preflight.ifHeld).to.match(/min_publish_gap 10 s/);
  });

  it("still refuses a print that is stale or from the future", () => {
    const params = { maxPriceAge: 10, minPublishGap: 1 };
    const mark = { publishTime: 0, acceptedAt: 0 };
    expect(
      rebindPreflight(observation(80), 100, params, mark).refusal,
    ).to.match(/past max_price_age/);
    expect(
      rebindPreflight(observation(101), 100, params, mark).refusal,
    ).to.match(/from the future/);
  });

  it("does not report a held mark's market ready on a print one second past the mark", () => {
    const preflight = rebindPreflight(
      observation(101),
      101,
      { maxPriceAge: 60, minPublishGap: 10 },
      { publishTime: 100, acceptedAt: 100 },
    );
    expect(preflight.refusal).to.equal(null);
    expect(preflight.ifHeld).to.match(/PricePublishedTooSoon/);
    expect(Object.keys(preflight)).to.not.include("ready");
    const refused = firstSyncVerdict(
      '{"InstructionError":[0,{"Custom":6012}]}',
      null,
      101,
    );
    expect(refused.ready).to.equal(false);
    expect(refused.line).to.match(/not ready: the first sync was refused/);
  });

  it("says nothing of a held mark when the print is past its gap", () => {
    expect(
      heldMarkSyncFailure(observation(110), 111, {
        publishTime: 100,
        acceptedAt: 100,
        minPublishGap: 10,
      }),
    ).to.equal(null);
    expect(
      heldMarkSyncFailure(observation(110), 105, {
        publishTime: 100,
        acceptedAt: 100,
        minPublishGap: 10,
      }),
    ).to.match(/accepted 5 s ago/);
  });

  it("keeps the mark-ordering check for a caller that has a mark to compare with", () => {
    expect(
      firstSyncFailure(observation(99), 100, {
        maxPriceAge: 60,
        markPublishTime: 100,
      }),
    ).to.match(/PriceTimeWentBackwards/);
  });

  it("calls the market ready only when the read-back shows the print taken", () => {
    const taken = firstSyncVerdict(
      null,
      { sourcePublishTime: 101, mark: 5n, markPublishTime: 101 },
      101,
    );
    expect(taken.ready).to.equal(true);
    const behind = firstSyncVerdict(
      null,
      { sourcePublishTime: 90, mark: 5n, markPublishTime: 90 },
      101,
    );
    expect(behind.ready).to.equal(false);
    expect(firstSyncVerdict(null, null, 101).ready).to.equal(false);
  });
});

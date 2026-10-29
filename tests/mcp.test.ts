import { expect } from "chai";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  Instructions,
  OrderInvalid,
  OutcomeUnknown,
  RESULT_STATUS,
  TransactionFailed,
  type OrderResult,
  type Seat,
  type Settled,
  type View,
} from "../sdk/dist/index.js";
import { summariseView, tokenSlots } from "../mcp/dist/account.js";
import { resolveConfig, DEFAULT_SIM_URL } from "../mcp/dist/config.js";
import { fetchDeployment, marketNamed } from "../mcp/dist/deployment.js";
import { deriveOrderSeed } from "../mcp/dist/keys.js";
import {
  DEVNET_GENESIS,
  UnsafeDeployment,
  assertDevnetGenesis,
  assertMagicBlockDevnet,
  assertKnownProgram,
  assertTestNetwork,
} from "../mcp/dist/network.js";
import { verifyFundingTransaction } from "../mcp/dist/funding.js";
import { KeypairInUse, acquireLock, ownerLockPath } from "../mcp/dist/lock.js";
import { SessionHost, type Session } from "../mcp/dist/session.js";
import {
  describeCancel,
  describePlaced,
  describeSettled,
  explainError,
  TRADER_REFUSALS,
  worthRetrying,
} from "../mcp/dist/outcomes.js";
import { parseCheckpoint, parseKeypair } from "../mcp/dist/storage.js";
import {
  InvalidInput,
  averagePrice,
  chainToPrice,
  lotsToSize,
  marketUnitsOf,
  formatDecimal,
  parseDecimal,
  priceToChain,
  sizeToLots,
  worstPriceFromMark,
} from "../mcp/dist/units.js";
import { errorCode, idl } from "./idl";

const NUSD = {
  symbol: "nUSD",
  mint: "7YSVF4MkenbLn7UHdWiJzMYpkC2fdaVaLf3rMRiPMt4y",
  decimals: 6,
};
const NSOL = {
  symbol: "nSOL",
  mint: "J3arLmcWDmaP2MkpWNMZw1Lak2jKAAbiUaqHAMe6Bnma",
  decimals: 9,
};

const DEPLOYMENT = {
  network: "devnet",
  programId: "9YiFamFrLbCiNYQczPwKfSwnnaTjDNWm9guokUGxB1z8",
  solanaRpcUrl: "https://api.devnet.solana.com",
  rollupRpcUrl: "https://devnet-tee.magicblock.app",
  exchange: "HDSHJEuEedVgRDFJaGiU1NDTGoYrwgqvC6Rr1ftwYsoi",
  markets: [
    {
      marketId: 0,
      symbol: "NSOL-PERP",
      kind: "perp" as const,
      baseToken: null,
      quoteToken: NUSD,
      baseDecimals: 9,
      lotSize: "1000000",
      tick: "100",
    },
    {
      marketId: 1,
      symbol: "NNVDA-PERP",
      kind: "perp" as const,
      baseToken: null,
      quoteToken: NUSD,
      baseDecimals: 6,
      lotSize: "10000",
      tick: "1000",
    },
    {
      marketId: 2,
      symbol: "NSOL-NUSD",
      kind: "spot" as const,
      baseToken: NSOL,
      quoteToken: NUSD,
      baseDecimals: 9,
      lotSize: "1000000",
      tick: "100",
    },
  ],
};

const sol = marketUnitsOf(DEPLOYMENT.markets[0]);
const nvda = marketUnitsOf(DEPLOYMENT.markets[1]);

const result = (fields: Partial<OrderResult>): OrderResult => ({
  clientOrderId: 1n,
  orderSeq: 0n,
  filled: 0n,
  filledNotional: 0n,
  rested: 0n,
  cancelled: 0n,
  fee: 0n,
  kind: 1,
  status: RESULT_STATUS.done,
  code: 0,
  ...fields,
});

const fetchReturning = (body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body))) as typeof fetch;

function viewWith(
  seat: Partial<Seat>,
  orders: View["snapshot"]["orders"],
): View {
  const owner = Keypair.generate().publicKey;
  return {
    header: { tag: "nwview\0\0", ready: true, marketId: 0, bump: 255 },
    owner,
    orderKeys: [owner, owner, owner, owner],
    seat: 3,
    seatRecorded: true,
    snapshotOld: false,
    ownerNonce: 0,
    resultsWritten: 0,
    results: [],
    snapshot: {
      seat: {
        owner,
        version: 1n,
        collateral: 0n,
        spot: [],
        positions: [],
        status: 1,
        makerMarkets: 0n,
        takerMarkets: 0n,
        blocked: false,
        nextFree: 0,
        ...seat,
      },
      layout: 1,
      seatIndex: 3,
      marketId: 0,
      orders,
    },
    used: 1n,
  };
}

describe("mcp units", () => {
  it("reads market scales from the deployment", () => {
    expect(sol).to.deep.equal({
      lotsPerUnit: 1000n,
      sizePerLot: 1000n,
      tick: 100n,
    });
    expect(nvda).to.deep.equal({
      lotsPerUnit: 100n,
      sizePerLot: 10000n,
      tick: 1000n,
    });
  });

  it("round trips sizes through lots", () => {
    expect(sizeToLots(sol, "0.5")).to.equal(500n);
    expect(lotsToSize(sol, 500n)).to.equal("0.5");
    expect(sizeToLots(nvda, "1.25")).to.equal(125n);
    expect(lotsToSize(nvda, 125n)).to.equal("1.25");
  });

  it("round trips prices through quote atoms per lot", () => {
    expect(priceToChain(sol, "106.6")).to.equal(106600n);
    expect(chainToPrice(sol, 106600n)).to.equal("106.6");
    expect(priceToChain(nvda, "225.1")).to.equal(2251000n);
    expect(chainToPrice(nvda, 2251000n)).to.equal("225.1");
  });

  it("refuses a size that is not a whole number of lots", () => {
    expect(() => sizeToLots(sol, "0.0005")).to.throw(
      InvalidInput,
      "whole number of lots",
    );
    expect(() => sizeToLots(nvda, "0.001")).to.throw(
      InvalidInput,
      "whole number of lots",
    );
  });

  it("refuses a price off the tick", () => {
    expect(() => priceToChain(sol, "106.65")).to.throw(InvalidInput, "tick");
    expect(() => priceToChain(nvda, "225.15")).to.throw(InvalidInput, "tick");
  });

  it("refuses more than six decimals and anything that is not a plain number", () => {
    expect(() => parseDecimal("1.0000001", "size")).to.throw(
      InvalidInput,
      "6 decimals",
    );
    expect(parseDecimal("1.1000000", "size")).to.equal(1_100_000n);
    for (const bad of ["", "-1", "1e3", "0x10", "1,5", " ", "abc", ".5"]) {
      expect(() => parseDecimal(bad, "size"), bad).to.throw(InvalidInput);
    }
  });

  it("refuses a zero size and a zero price", () => {
    expect(() => sizeToLots(sol, "0")).to.throw(
      InvalidInput,
      "greater than zero",
    );
    expect(() => priceToChain(sol, "0")).to.throw(
      InvalidInput,
      "greater than zero",
    );
  });

  it("computes the average price of a fill", () => {
    expect(averagePrice(sol, 106600n * 500n, 500n)).to.equal("106.6");
    expect(averagePrice(sol, 0n, 0n)).to.equal(null);
  });

  it("puts a market order's worst price beyond the mark and on the tick", () => {
    expect(worstPriceFromMark(sol, "buy", "106.6")).to.equal("107.7");
    expect(worstPriceFromMark(sol, "sell", "106.6")).to.equal("105.5");
  });
});

describe("mcp account mapping", () => {
  const tokens = tokenSlots(
    [NUSD.mint, NSOL.mint, "11111111111111111111111111111111"],
    DEPLOYMENT,
  );

  it("names the token slots the deployment knows", () => {
    expect(tokens).to.deep.equal([
      { symbol: "nUSD", decimals: 6, index: 0 },
      { symbol: "nSOL", decimals: 9, index: 1 },
    ]);
  });

  it("maps a view to balances, positions and open orders", () => {
    const positions = [
      {
        marketId: 0,
        base: -500n,
        quote: -(106600n * 500n),
        fundingCheckpoint: 0n,
        openBidLots: 0n,
        openAskLots: 0n,
        openOrders: 1,
      },
    ];
    const view = viewWith(
      {
        collateral: 1_000_000_000n,
        spot: [
          { available: 5_000_000n, locked: 0n },
          { available: 2_000_000_000n, locked: 500_000_000n },
        ],
        positions,
      },
      [
        {
          price: 106000n,
          remaining: 200n,
          sequence: 77n,
          locked: 0n,
          expiry: 0n,
          secret: new Uint8Array(32),
          side: 0,
        },
      ],
    );

    const summary = summariseView(view, DEPLOYMENT, tokens);

    expect(summary.collateral).to.deep.equal({ asset: "nUSD", total: "1000" });
    expect(summary.spotBalances).to.deep.equal([
      { asset: "nUSD", available: "5", locked: "0", total: "5" },
      { asset: "nSOL", available: "2", locked: "0.5", total: "2.5" },
    ]);
    expect(summary.perpPositions).to.deep.equal([
      { market: "NSOL-PERP", side: "short", size: "0.5", entryPrice: "106.6" },
    ]);
    expect(summary.openOrders).to.deep.equal({
      market: "NSOL-PERP",
      orders: [{ orderId: "77", side: "buy", price: "106", size: "0.2" }],
    });
  });

  it("maps an empty view to nothing", () => {
    const summary = summariseView(viewWith({}, []), DEPLOYMENT, tokens);
    expect(summary.collateral.total).to.equal("0");
    expect(summary.perpPositions).to.deep.equal([]);
    expect(summary.openOrders.orders).to.deep.equal([]);
  });

  it("says an unseated view has no funds yet, and finds a position by its slot tag", () => {
    const unseated = viewWith({}, []);
    expect(summariseView(unseated, DEPLOYMENT, tokens).status).to.equal(
      undefined,
    );
    const noSeat = { ...unseated, seat: 4_294_967_295, seatRecorded: false };
    expect(summariseView(noSeat, DEPLOYMENT, tokens).status).to.match(
      /^no funds yet/,
    );
    const held = viewWith(
      {
        positions: [
          {
            marketId: 7,
            base: 9n,
            quote: 9n,
            fundingCheckpoint: 0n,
            openBidLots: 0n,
            openAskLots: 0n,
            openOrders: 0,
          },
          {
            marketId: 0,
            base: 500n,
            quote: 106600n * 500n,
            fundingCheckpoint: 0n,
            openBidLots: 0n,
            openAskLots: 0n,
            openOrders: 0,
          },
        ],
      },
      [],
    );
    expect(summariseView(held, DEPLOYMENT, tokens).perpPositions).to.deep.equal(
      [{ market: "NSOL-PERP", side: "long", size: "0.5", entryPrice: "106.6" }],
    );
  });

  it("finds markets by name", () => {
    expect(marketNamed(DEPLOYMENT, "NSOL-NUSD").marketId).to.equal(2);
    expect(() => marketNamed(DEPLOYMENT, "NOPE")).to.throw(
      InvalidInput,
      "NSOL-PERP",
    );
  });
});

describe("mcp outcome wording", () => {
  it("reports a complete fill with its average price and fee", () => {
    const report = describePlaced(
      result({
        status: RESULT_STATUS.filled,
        filled: 500n,
        filledNotional: 106600n * 500n,
        fee: 26_650n,
      }),
      sol,
    );
    expect(report).to.include({
      status: "filled",
      filledSize: "0.5",
      averagePrice: "106.6",
      fee: "0.02665",
      orderId: null,
    });
  });

  it("reports a resting order with the id to cancel it by", () => {
    const report = describePlaced(
      result({ status: RESULT_STATUS.rested, rested: 500n, orderSeq: 12n }),
      sol,
    );
    expect(report).to.include({
      status: "rested",
      orderId: "12",
      restedSize: "0.5",
    });
    expect(report.averagePrice).to.equal(null);
  });

  it("reports a partial fill that rests and one whose remainder was cancelled", () => {
    expect(
      describePlaced(
        result({
          status: RESULT_STATUS.rested,
          filled: 100n,
          rested: 400n,
          orderSeq: 5n,
        }),
        sol,
      ).status,
    ).to.equal("partially_filled_and_rested");
    expect(
      describePlaced(
        result({
          status: RESULT_STATUS.remainderCancelled,
          filled: 100n,
          cancelled: 400n,
        }),
        sol,
      ).status,
    ).to.equal("partially_filled_remainder_cancelled");
    expect(
      describePlaced(
        result({
          status: RESULT_STATUS.remainderCancelledFillCheck,
          cancelled: 500n,
        }),
        sol,
      ).status,
    ).to.equal("remainder_cancelled");
  });

  it("reports a refused post-only order and a stale price", () => {
    expect(
      describePlaced(
        result({ status: RESULT_STATUS.refusedPostOnlyWouldMatch }),
        sol,
      ).status,
    ).to.equal("refused_post_only_would_match");
    const stale = describePlaced(
      result({ status: RESULT_STATUS.refused, code: 38 }),
      sol,
    );
    expect(stale.status).to.equal("refused");
    expect(stale.message).to.contain("mark price is too old");
  });

  it("says an expired order never ran", () => {
    const expired: Settled = {
      outcome: "expired",
      clientOrderId: 1n,
      secret: new Uint8Array(32),
      view: viewWith({}, []),
      sentAt: 0,
    };
    const report = describeSettled(expired, sol);
    expect(report.status).to.equal("expired");
    expect(report.message).to.contain("safe to place again");
  });

  it("notes an order that landed late", () => {
    const placed: Settled = {
      outcome: "placed",
      clientOrderId: 1n,
      result: result({
        status: RESULT_STATUS.rested,
        rested: 10n,
        orderSeq: 9n,
      }),
      secret: new Uint8Array(32),
      view: viewWith({}, []),
      sentAt: 0,
      resultAt: 1,
    };
    expect(describeSettled(placed, sol, true).message).to.contain(
      "landed late",
    );
  });

  it("reports cancels by the number of orders", () => {
    expect(describeCancel(result({ cancelled: 3n })).cancelledOrders).to.equal(
      3,
    );
    expect(describeCancel(result({ cancelled: 0n })).message).to.contain(
      "Nothing was cancelled",
    );
    expect(describeCancel(null).message).to.contain("expired");
  });

  it("explains failures in plain words", () => {
    expect(explainError(new OrderInvalid("PriceOffTick"))).to.contain("tick");
    expect(
      explainError(
        new TransactionFailed("sig", {
          InstructionError: [0, { Custom: errorCode("Expired") }],
        }),
      ),
    ).to.contain("Nothing changed");
    const outsideBand = explainError(
      new TransactionFailed("sig", {
        InstructionError: [0, { Custom: errorCode("PriceOutsideBand") }],
      }),
    );
    expect(outsideBand).to.contain("outside the band");
    expect(outsideBand).to.contain("Nothing changed");
    expect(explainError(new Error("every order key is in use"))).to.contain(
      "four",
    );
    expect(explainError(new InvalidInput("size is bad"))).to.contain(
      "Nothing was sent",
    );
    expect(explainError(new Error("socket hang up."))).to.match(
      /^socket hang up\. If this/,
    );
  });

  it("words only refusals the program can return", () => {
    const programCodes = idl.errors.map((error) => error.code - 6000);
    for (const engineCode of Object.keys(TRADER_REFUSALS).map(Number)) {
      expect(programCodes, `refusal ${engineCode}`).to.include(engineCode);
    }
  });

  it("retries only failures that may be transient", () => {
    expect(
      worthRetrying(new Error("the view is not readable by this connection")),
    ).to.equal(false);
    expect(worthRetrying(new Error("401"))).to.equal(true);
    expect(worthRetrying(new OrderInvalid("SizeTooSmall"))).to.equal(false);
    expect(worthRetrying(new InvalidInput("x"))).to.equal(false);
    expect(worthRetrying(new TransactionFailed("s", {}))).to.equal(false);
    expect(worthRetrying(new Error("every order key is in use"))).to.equal(
      false,
    );
    expect(
      worthRetrying(new OutcomeUnknown(1n, Promise.resolve(null))),
    ).to.equal(false);
  });
});

describe("mcp network guard", () => {
  it("accepts devnet only", () => {
    assertTestNetwork("devnet");
    for (const other of [
      "mainnet-beta",
      "mainnet",
      "testnet",
      "localnet",
      "",
    ]) {
      expect(() => assertTestNetwork(other), other).to.throw("devnet only");
    }
  });

  it("refuses a deployment on another network", async () => {
    let refused: unknown;
    await fetchDeployment(
      "http://sim",
      fetchReturning({ ...DEPLOYMENT, network: "mainnet-beta" }),
    ).catch((error) => (refused = error));
    expect(String(refused)).to.contain("devnet only");
  });

  it("accepts a devnet deployment", async () => {
    const deployment = await fetchDeployment(
      "http://sim",
      fetchReturning(DEPLOYMENT),
    );
    expect(deployment.markets).to.have.length(3);
  });
});

describe("mcp configuration", () => {
  it("has defaults", () => {
    expect(resolveConfig({}, "/home/me")).to.deep.equal({
      simUrl: DEFAULT_SIM_URL,
      keypairPath: "/home/me/.config/noirwire/devnet-trader.json",
      checkpointPath:
        "/home/me/.config/noirwire/devnet-trader.json.checkpoint.json",
    });
  });

  it("takes the environment's choices", () => {
    const config = resolveConfig(
      {
        NOIRWIRE_SIM_URL: "http://localhost:8787/",
        NOIRWIRE_KEYPAIR: "/keys/me.json",
      },
      "/home/me",
    );
    expect(config).to.deep.equal({
      simUrl: "http://localhost:8787",
      keypairPath: "/keys/me.json",
      checkpointPath: "/keys/me.json.checkpoint.json",
    });
  });

  it("expands a leading ~ in the keypair path and ignores empty values", () => {
    const config = resolveConfig(
      { NOIRWIRE_KEYPAIR: "~/k.json", NOIRWIRE_SIM_URL: " " },
      "/home/me",
    );
    expect(config.keypairPath).to.equal("/home/me/k.json");
    expect(config.simUrl).to.equal(DEFAULT_SIM_URL);
  });
});

describe("mcp storage and keys", () => {
  it("reads a Solana CLI keypair and refuses anything else", () => {
    const keypair = Keypair.generate();
    const read = parseKeypair(JSON.stringify(Array.from(keypair.secretKey)));
    expect(read.publicKey.equals(keypair.publicKey)).to.equal(true);
    expect(() => parseKeypair("[1,2,3]")).to.throw("64 bytes");
    expect(() => parseKeypair('{"a":1}')).to.throw("64 bytes");
  });

  it("accepts a well formed checkpoint and drops a malformed one", () => {
    expect(
      parseCheckpoint('{"indices":[4,5,6,7],"nextIndex":8}'),
    ).to.deep.equal({
      indices: [4, 5, 6, 7],
      nextIndex: 8,
    });
    for (const bad of [
      "",
      "nope",
      "null",
      '{"indices":[-1],"nextIndex":8}',
      '{"indices":[1]}',
      '{"indices":"x","nextIndex":1}',
    ]) {
      expect(parseCheckpoint(bad), bad).to.equal(null);
    }
  });

  it("derives one order key seed per owner, the same every time", () => {
    const owner = Keypair.generate();
    const seed = deriveOrderSeed(owner);
    expect(seed).to.have.length(32);
    expect(
      Buffer.from(deriveOrderSeed(owner)).equals(Buffer.from(seed)),
    ).to.equal(true);
    expect(
      Buffer.from(deriveOrderSeed(Keypair.generate())).equals(
        Buffer.from(seed),
      ),
    ).to.equal(false);
  });
});

describe("mcp decimal formatting", () => {
  it("formats a token with no decimals as a whole number", () => {
    expect(formatDecimal(5n, 0)).to.equal("5");
    expect(formatDecimal(0n, 0)).to.equal("0");
    expect(formatDecimal(-120n, 0)).to.equal("-120");
    expect(formatDecimal(5n, 1)).to.equal("0.5");
    expect(formatDecimal(1_500_000n, 6)).to.equal("1.5");
  });
});

describe("mcp rollup endpoint pinning", () => {
  it("accepts MagicBlock's devnet endpoint", () => {
    assertMagicBlockDevnet("https://devnet-tee.magicblock.app");
    assertMagicBlockDevnet("https://devnet-eu.magicblock.app/");
  });

  it("refuses any other endpoint before anything is signed", () => {
    for (const other of [
      "http://devnet-tee.magicblock.app",
      "https://mainnet-tee.magicblock.app",
      "https://tee.magicblock.app",
      "https://devnet-tee.magicblock.app.evil.example",
      "https://evil-magicblock.app",
      "https://devnet.example.com",
      "https://devnetmagicblock.app",
      "http://127.0.0.1:7799",
      "not a url",
    ]) {
      expect(() => assertMagicBlockDevnet(other), other).to.throw(
        UnsafeDeployment,
        "not a MagicBlock devnet endpoint",
      );
    }
  });

  it("refuses a deployment whose rollup endpoint is not devnet's", async () => {
    let refused: unknown;
    await fetchDeployment(
      "http://sim",
      fetchReturning({
        ...DEPLOYMENT,
        rollupRpcUrl: "https://attacker.example",
      }),
    ).catch((error) => (refused = error));
    expect(refused).to.be.instanceOf(UnsafeDeployment);
  });
});

describe("mcp deployment pinning", () => {
  it("refuses a deployment of another program", async () => {
    expect(() =>
      assertKnownProgram(Keypair.generate().publicKey.toBase58()),
    ).to.throw(UnsafeDeployment, "not the NoirWire order book");
    assertKnownProgram(DEPLOYMENT.programId);
    let refused: unknown;
    await fetchDeployment(
      "http://sim",
      fetchReturning({
        ...DEPLOYMENT,
        programId: Keypair.generate().publicKey.toBase58(),
      }),
    ).catch((error) => (refused = error));
    expect(refused).to.be.instanceOf(UnsafeDeployment);
  });

  it("refuses a chain whose genesis is not devnet's", () => {
    assertDevnetGenesis(DEVNET_GENESIS);
    const mainnet = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
    expect(() => assertDevnetGenesis(mainnet)).to.throw(
      UnsafeDeployment,
      "not devnet",
    );
    expect(worthRetrying(new UnsafeDeployment("x"))).to.equal(false);
  });
});

describe("mcp funding transaction check", () => {
  const programId = new PublicKey(DEPLOYMENT.programId);
  const instructions = new Instructions(programId);
  const owner = Keypair.generate().publicKey;
  const gate = Keypair.generate().publicKey;
  const faucet = Keypair.generate().publicKey;
  const source = Keypair.generate().publicKey;
  const token = { mint: Keypair.generate().publicKey, custodyNonce: 1n };
  const orderKeys = Array.from(
    { length: 4 },
    () => Keypair.generate().publicKey,
  );
  const expected = { owner, orderKeys, programId };

  const transactionOf = (
    feePayer: PublicKey,
    ...inside: TransactionInstruction[]
  ) =>
    new Transaction({
      feePayer,
      blockhash: gate.toBase58(),
      lastValidBlockHeight: 1,
    }).add(...inside);
  const open = instructions.openTrader(gate, owner, orderKeys);
  const deposit = instructions.deposit(
    faucet,
    source,
    token,
    owner,
    { collateral: true },
    1_000_000n,
  );

  it("accepts the transaction the service promises, as it arrives over the wire", () => {
    const sent = transactionOf(gate, open, deposit);
    verifyFundingTransaction(sent, expected);
    const received = Transaction.from(
      sent.serialize({ requireAllSignatures: false, verifySignatures: false }),
    );
    verifyFundingTransaction(received, expected);
  });

  const refused = (transaction: Transaction, reason: string) => {
    let message = "";
    try {
      verifyFundingTransaction(transaction, expected);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).to.contain("Refused to sign the funding transaction");
    expect(message).to.contain(reason);
  };

  it("refuses to make the owner pay the fee", () => {
    refused(
      transactionOf(
        owner,
        instructions.openTrader(owner, owner, orderKeys),
        deposit,
      ),
      "owner pay",
    );
  });

  it("refuses an extra instruction, such as a transfer from the owner", () => {
    const steal = SystemProgram.transfer({
      fromPubkey: owner,
      toPubkey: gate,
      lamports: 1,
    });
    refused(transactionOf(gate, open, deposit, steal), "3 instructions");
  });

  it("refuses an instruction for another program", () => {
    const foreign = new TransactionInstruction({
      programId: Keypair.generate().publicKey,
      keys: deposit.keys,
      data: deposit.data,
    });
    refused(transactionOf(gate, open, foreign), "other than the order book");
  });

  it("refuses order keys other than the ones that were sent", () => {
    const others = Array.from(
      { length: 4 },
      () => Keypair.generate().publicKey,
    );
    refused(
      transactionOf(
        gate,
        instructions.openTrader(gate, owner, others),
        deposit,
      ),
      "open_trader",
    );
  });

  it("refuses a deposit that is not into the collateral", () => {
    const spot = instructions.deposit(
      faucet,
      source,
      token,
      owner,
      { spot: 0 },
      1n,
    );
    refused(transactionOf(gate, open, spot), "collateral");
  });

  it("refuses a deposit the owner pays, and the two instructions out of order", () => {
    const owned = instructions.deposit(
      owner,
      source,
      token,
      owner,
      { collateral: true },
      1n,
    );
    refused(transactionOf(gate, open, owned), "owner");
    refused(transactionOf(gate, deposit, open), "open_trader");
  });
});

describe("mcp session host", () => {
  const fakeSession = (saveCheckpoint: () => void = () => {}) =>
    ({ saveCheckpoint, close: () => {} }) as unknown as Session;
  const pause = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  it("keeps a checkpoint failure out of the call and reports it as a warning", async () => {
    const host = new SessionHost(async () =>
      fakeSession(() => {
        throw new Error("disk full");
      }),
    );
    let calls = 0;
    const placed = await host.run(async () => {
      calls += 1;
      return "placed";
    });
    expect(placed).to.equal("placed");
    expect(calls).to.equal(1);
    expect(host.takeWarnings()).to.have.length(1);
    expect(host.takeWarnings()).to.deep.equal([]);
  });

  it("never repeats a call that started, unless it says it is safe to", async () => {
    let builds = 0;
    const host = new SessionHost(async () => {
      builds += 1;
      return fakeSession();
    });
    let calls = 0;
    const failing = async () => {
      calls += 1;
      throw new Error("socket hang up");
    };
    await host.run(failing).catch(() => {});
    expect(calls).to.equal(1);
    expect(builds).to.equal(1);
    await host.run(failing, { repeatable: true }).catch(() => {});
    expect(calls).to.equal(3);
    expect(builds).to.equal(2);
  });

  it("builds a session that failed once more, and not a refused deployment", async () => {
    let builds = 0;
    const flaky = new SessionHost(async () => {
      builds += 1;
      if (builds === 1) throw new Error("502");
      return fakeSession();
    });
    expect(await flaky.run(async () => "ok")).to.equal("ok");
    expect(builds).to.equal(2);

    let refusedBuilds = 0;
    const refusing = new SessionHost(async () => {
      refusedBuilds += 1;
      throw new UnsafeDeployment("mainnet");
    });
    await refusing.run(async () => "ok").catch(() => {});
    expect(refusedBuilds).to.equal(1);
  });

  it("runs calls one at a time, and a rebuild waits for the call in flight", async () => {
    const events: string[] = [];
    const host = new SessionHost(async () => fakeSession());
    const first = host.run(async () => {
      events.push("first start");
      await pause(30);
      events.push("first end");
    });
    const second = host.run(async () => {
      events.push("second start");
      await pause(5);
      events.push("second end");
    });
    const rebuilt = host.rebuild().then(() => events.push("rebuilt"));
    await Promise.all([first, second, rebuilt]);
    expect(events).to.deep.equal([
      "first start",
      "first end",
      "second start",
      "second end",
      "rebuilt",
    ]);
  });
});

describe("mcp keypair lock", () => {
  const directory = mkdtempSync(join(tmpdir(), "mcp-lock-"));
  after(() => rmSync(directory, { recursive: true, force: true }));
  const lockAt = (name: string) => join(directory, `${name}.json.lock`);

  it("lets only one process take over a stale lock, even when another arrives mid-takeover", () => {
    const path = lockAt("race");
    writeFileSync(path, "4242");
    let rival: unknown;
    const release = acquireLock(path, 5151, (pid) => {
      // Judged under the takeover file: a second process arriving now
      // cannot take the lock or delete it.
      try {
        acquireLock(path, 6262, () => false);
      } catch (error) {
        rival = error;
      }
      return pid === 6262;
    });
    expect(rival).to.be.instanceOf(KeypairInUse);
    expect(readFileSync(path, "utf8")).to.equal("5151");
    expect(existsSync(`${path}.takeover`)).to.equal(false);
    release();
  });

  it("does not delete a lock a rival took over first", () => {
    const path = lockAt("lost");
    writeFileSync(path, "4242");
    acquireLock(path, 6262, () => false);
    expect(() => acquireLock(path, 5151, (pid) => pid === 6262)).to.throw(
      KeypairInUse,
    );
    expect(readFileSync(path, "utf8")).to.equal("6262");
    expect(existsSync(`${path}.takeover`)).to.equal(false);
  });

  it("locks on the owner's public key, whatever file or path holds the keypair", () => {
    const keypair = Keypair.generate();
    const bytes = JSON.stringify(Array.from(keypair.secretKey));
    const first = join(directory, "first.json");
    const copy = join(directory, "copy.json");
    writeFileSync(first, bytes);
    writeFileSync(copy, bytes);
    const lockOf = (path: string) =>
      ownerLockPath(
        directory,
        parseKeypair(readFileSync(path, "utf8")).publicKey,
      );

    expect(lockOf(copy)).to.equal(lockOf(first));
    expect(ownerLockPath(directory, Keypair.generate().publicKey)).to.not.equal(
      lockOf(first),
    );
    expect(lockOf(first)).to.equal(
      join(
        directory,
        ".config",
        "noirwire",
        "locks",
        `${keypair.publicKey.toBase58()}.lock`,
      ),
    );

    const release = acquireLock(lockOf(first), 4242, () => false);
    expect(() =>
      acquireLock(lockOf(copy), 5151, (pid) => pid === 4242),
    ).to.throw(KeypairInUse);
    const other = acquireLock(
      ownerLockPath(directory, Keypair.generate().publicKey),
      5151,
      () => false,
    );
    other();
    release();
  });

  it("holds the lock with its pid and removes it on release", () => {
    const path = lockAt("held");
    const release = acquireLock(path, 4242, () => false);
    expect(readFileSync(path, "utf8")).to.equal("4242");
    release();
    expect(() => readFileSync(path)).to.throw("ENOENT");
  });

  it("refuses when the process holding the lock is alive", () => {
    const path = lockAt("busy");
    const release = acquireLock(path, 4242, () => false);
    expect(() => acquireLock(path, 5151, (pid) => pid === 4242)).to.throw(
      KeypairInUse,
      "NOIRWIRE_KEYPAIR",
    );
    release();
  });

  it("takes over a lock whose process is gone, and the old owner cannot remove it", () => {
    const path = lockAt("stale");
    const releaseOld = acquireLock(path, 4242, () => false);
    const releaseNew = acquireLock(path, 5151, () => false);
    expect(readFileSync(path, "utf8")).to.equal("5151");
    releaseOld();
    expect(readFileSync(path, "utf8")).to.equal("5151");
    releaseNew();
  });

  it("takes over a lock file that holds no pid", () => {
    const path = lockAt("garbage");
    writeFileSync(path, "not a pid");
    acquireLock(path, 7, () => true)();
  });
});

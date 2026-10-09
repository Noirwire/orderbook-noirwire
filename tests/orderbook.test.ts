import { expect } from "chai";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  ACCOUNT_LEN,
  FEE_SEAT,
  GROWTH_STEP,
  GROW_KIND,
  INSURANCE_SEAT,
  LIQUIDATION_STATUS,
  MARKET_KIND,
  MARKET_STATUS,
  MAX_FILLS,
  ORDER_TYPE,
  OrderKeyManager,
  RESULT_KIND,
  RESULT_STATUS,
  SIDE,
  TraderClient,
  decodeExchange,
  decodeMarket,
  decodeStats,
  decodeTape,
  growToFullSize,
  instructionData,
  ownFills,
  randomSecret,
  rollupRent,
  setupLedger,
  setupMarket,
  type MarketLimits,
  type MarketSettings,
  type OrderKeyUse,
  type OrderResult,
  type View,
} from "../sdk/dist/index.js";
import {
  createMint,
  ensureCustody,
  ensureExchange,
  fundRentPda,
  minted,
  registeredToken,
} from "../ops/network";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import {
  delegateEphemeralAtaIx,
  deriveEphemeralAta,
  initEphemeralAtaIx,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  PROGRAM_ID,
  VALIDATOR,
  addresses,
  admin,
  airdropped,
  anonymous,
  balanceOf,
  base,
  funded,
  fundingThroughThePort,
  idl,
  instructions,
  ledgerThroughThePort,
  nowSeconds,
  readingAs,
  refusal,
  rollup,
  rollupNow,
  send,
  sentRaw,
  summary,
  tokenAccountOf,
  until,
  viewThroughThePort,
  waitFor,
  type Mints,
  type Trader,
} from "./support";

const EXCHANGE_FLOAT = 0.2 * LAMPORTS_PER_SOL;
const SPOT = 0;
const PERP = 1;
const TINY = 2;
const UNFINISHED = 3;
const VIA_FILTER = 6;
const NUSD = 0;
const NSOL = 1;
const USD = 1_000_000n;
const SOL = 1_000_000_000n;
const LOT = 1_000_000n;
const MARK = 150_000n;
const SEATS_PER_DAY = 1_000;

const gate = Keypair.generate();
const oracle = Keypair.generate();
const stranger = Keypair.generate();
const mints = {} as Mints;

const settings = (
  over: Partial<{ maxSteps: number; collateralToken: number }> = {},
) => ({
  gate: gate.publicKey,
  oracle: oracle.publicKey,
  maxSteps: 16,
  collateralToken: NUSD,
  maxSeatsPerDay: SEATS_PER_DAY,
  ...over,
});

const limits = (over: Partial<MarketLimits> = {}): MarketLimits => ({
  minSize: 1n,
  minNotional: 1_000_000n,
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
  status: MARKET_STATUS.active,
  minPublishGap: 1,
  maxAgeLiquidation: 3_600n,
  openInterestCap: 1_000_000n,
  liqBufferBps: 100,
  liqInsuranceShareBps: 0,
  feeInsuranceShareBps: 0,
  ...over,
});

const spotMarket = (capacity = 1024): MarketSettings => ({
  kind: MARKET_KIND.spot,
  baseSymbol: "NSOL",
  quoteSymbol: "NUSD",
  baseToken: NSOL,
  quoteToken: NUSD,
  tick: 100n,
  baseLot: LOT,
  capacity,
  limits: limits(),
});

const perpMarket = (): MarketSettings => ({
  kind: MARKET_KIND.perp,
  baseSymbol: "NSOL",
  quoteSymbol: "NUSD",
  baseToken: NUSD,
  quoteToken: NUSD,
  tick: 100n,
  baseLot: LOT,
  capacity: 1024,
  limits: limits(),
});

const exchangeOn = async (connection: Connection) =>
  decodeExchange((await connection.getAccountInfo(addresses.exchange))!.data);

const exchangeBalance = () => rollup.getBalance(addresses.exchange);

const unsignedBy = (instruction: TransactionInstruction, key: PublicKey) => {
  instruction.keys = instruction.keys.map((meta) =>
    meta.pubkey.equals(key) ? { ...meta, isSigner: false } : meta,
  );
  return instruction;
};

/** Reads the private feed as the trader and waits for a result for `clientOrderId`. */
async function resultFor(
  trader: Trader,
  clientOrderId: bigint,
): Promise<OrderResult> {
  return waitFor(async () => {
    const view = await trader.client.view();
    return view.results.find(
      (result) => result.clientOrderId === clientOrderId,
    );
  }, `a result for order ${clientOrderId}`);
}

/**
 * An order-key instruction built by hand and sent raw, so a refusal is seen as
 * the program's error. On success the key swap landed; on failure the key is
 * still live and goes back to the manager.
 */
async function attempted(
  trader: Trader,
  build: (
    use: OrderKeyUse,
    clientOrderId: bigint,
    expiresAt: bigint,
  ) => TransactionInstruction,
  over: { expiresAt?: bigint; feePayer?: Keypair } = {},
): Promise<{ clientOrderId: bigint; use: OrderKeyUse; signature: string }> {
  const use = trader.keys.take();
  const clientOrderId =
    BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
  const expiresAt = over.expiresAt ?? BigInt(nowSeconds() + 5);
  try {
    const signature = await send(
      rollup,
      build(use, clientOrderId, expiresAt),
      over.feePayer ?? use.keypair,
    );
    trader.keys.confirm(use);
    return { clientOrderId, use, signature };
  } catch (error) {
    trader.keys.release(use);
    throw error;
  }
}

const call = (
  trader: Trader,
  use: OrderKeyUse,
  marketId: number,
  clientOrderId: bigint,
  expiresAt: bigint,
) => ({
  orderKey: use.keypair.publicKey,
  owner: trader.owner.publicKey,
  expiresAt,
  replacement: use.replacement.publicKey,
  clientOrderId,
  marketId,
  riskMarkets: [PERP],
});

const order = (
  side: number,
  orderType: number,
  price: bigint,
  size: bigint,
) => ({
  side,
  orderType,
  price,
  size,
  secret: randomSecret(),
  reduceOnly: false,
  expiry: 0n,
});

async function openedTrader(
  name: string,
  seed = randomSecret32(),
): Promise<Trader> {
  const owner = Keypair.generate();
  const keys = OrderKeyManager.fresh(seed);
  await send(
    rollup,
    instructions.openTrader(gate.publicKey, owner.publicKey, keys.publicKeys),
    gate,
    [owner],
  );
  const reader = await readingAs(owner);
  const client = new TraderClient(
    rollup,
    reader,
    owner.publicKey,
    keys,
    PROGRAM_ID,
  );
  const view = await client.view();
  return {
    name,
    owner,
    seed,
    keys,
    client,
    reader,
    tokenAccounts: new Map(),
    seat: view.seat,
  };
}

function randomSecret32(): Uint8Array {
  const seed = new Uint8Array(32);
  globalThis.crypto.getRandomValues(seed);
  return seed;
}

const mintTo = (owner: PublicKey, mint: PublicKey, amount: bigint) =>
  minted(base, admin, mint, owner, amount);

async function fundedWith(
  trader: Trader,
  mint: PublicKey,
  amount: bigint,
): Promise<PublicKey> {
  const account = await funded(trader.owner, mint, amount, mintTo);
  trader.tokenAccounts.set(mint.toBase58(), account);
  return account;
}

const tokenAccount = (trader: Trader, mint: PublicKey) =>
  trader.tokenAccounts.get(mint.toBase58())!;

async function deposited(
  trader: Trader,
  mint: PublicKey,
  tokenIndex: number,
  amount: bigint,
  collateral = false,
) {
  await send(
    rollup,
    instructions.deposit(
      trader.owner.publicKey,
      tokenAccount(trader, mint),
      mint,
      trader.owner.publicKey,
      collateral ? { collateral: true } : { spot: tokenIndex },
      amount,
    ),
    trader.owner,
  );
}

/**
 * RULES 13.1: custody equals the sum of seat balances, per token. The
 * collateral token also carries collateral and every perp position's quote,
 * with unpaid funding counted as paid. Read through the port, tests only.
 */
async function custodyMatchesLedger(): Promise<void> {
  const ledger = await ledgerThroughThePort();
  const funding = { [PERP]: (await fundingThroughThePort(PERP)).index };
  const open = ledger.seats.filter((seat) => seat.status === 1);
  for (const [index, mint] of [
    [NUSD, mints.nUSD],
    [NSOL, mints.nSOL],
  ] as const) {
    let total = 0n;
    for (const seat of open) {
      total += seat.spot[index].available + seat.spot[index].locked;
      if (index === NUSD) {
        total += seat.collateral;
        for (const [market, slot] of seat.perp.entries()) {
          const unpaid =
            slot.base *
            ((funding[market as typeof PERP] ?? 0n) - slot.fundingCheckpoint);
          total += slot.quote - unpaid;
        }
      }
    }
    expect(
      await balanceOf(addresses.custody(mint)),
      `custody of token ${index}`,
    ).to.equal(total);
  }
}

function handsOverItsAdminRole(
  connection: () => Connection,
  powers: (by: PublicKey) => TransactionInstruction[],
) {
  const heir = Keypair.generate();
  const adminIs = async (key: Keypair) =>
    expect(
      (await exchangeOn(connection())).admin.equals(key.publicKey),
    ).to.equal(true);

  it("offers its admin role only through its admin, and gives it only to a nominee who signs", async () => {
    expect(
      await refusal(
        send(
          connection(),
          instructions.proposeAdmin(stranger.publicKey, stranger.publicKey),
          stranger,
        ),
      ),
    ).to.include("NotAdmin");
    await send(
      connection(),
      instructions.proposeAdmin(admin.publicKey, heir.publicKey),
      admin,
    );
    expect(
      await refusal(
        send(
          connection(),
          instructions.acceptAdmin(stranger.publicKey),
          stranger,
        ),
      ),
    ).to.include("NotNominee");
    expect(
      await refusal(
        send(
          connection(),
          unsignedBy(instructions.acceptAdmin(heir.publicKey), heir.publicKey),
          stranger,
        ),
      ),
    ).to.include("AccountNotSigner");
    await adminIs(admin);
  });

  it("leaves the old admin no power once the nominee accepts, and the new admin can hand it back", async () => {
    await send(
      connection(),
      instructions.acceptAdmin(heir.publicKey),
      stranger,
      [heir],
    );
    await adminIs(heir);
    expect((await exchangeOn(connection())).pendingAdmin).to.equal(null);
    for (const power of powers(admin.publicKey)) {
      expect(await refusal(send(connection(), power, admin))).to.include(
        "NotAdmin",
      );
    }
    await send(
      connection(),
      instructions.proposeAdmin(heir.publicKey, admin.publicKey),
      stranger,
      [heir],
    );
    await send(connection(), instructions.acceptAdmin(admin.publicKey), admin);
    await adminIs(admin);
  });
}

let alice: Trader;
let bob: Trader;
let carol: Trader;

describe("the client's instruction builders", () => {
  it("name every account, in the program's order and with its flags, and carry the program's discriminator", () => {
    const key = Keypair.generate().publicKey;
    const keys = [1, 2, 3, 4].map(() => Keypair.generate().publicKey);
    const use = {
      orderKey: key,
      owner: key,
      expiresAt: 1n,
      replacement: key,
      clientOrderId: 1n,
      marketId: 1,
    };
    const sample = order(SIDE.bid, ORDER_TYPE.limit, 100n, 1n);
    const built: Record<string, TransactionInstruction> = {
      initialize_exchange: instructions.initializeExchange(key, settings()),
      update_exchange: instructions.updateExchange(key, settings()),
      set_paused: instructions.setPaused(key, true),
      propose_admin: instructions.proposeAdmin(key, null),
      accept_admin: instructions.acceptAdmin(key),
      register_token: instructions.registerToken(key, 0, key),
      delegate_exchange: instructions.delegateExchange(key, key),
      undelegate_exchange: instructions.undelegateExchange(key),
      withdraw_exchange: instructions.withdrawExchange(key, 1n),
      create_ledger: instructions.createLedger(key),
      finalize_ledger: instructions.finalizeLedger(key),
      create_market: instructions.createMarket(key, 1, spotMarket()),
      grow_account: instructions.growAccount(key, 0, 0, key, 1),
      finalize_market: instructions.finalizeMarket(key, 1),
      update_market: instructions.updateMarket(key, 1, limits()),
      open_trader: instructions.openTrader(key, key, keys),
      set_order_keys: instructions.setOrderKeys(key, keys),
      close_trader: instructions.closeTrader(key),
      deposit: instructions.deposit(key, key, key, key, { spot: 1 }, 1n),
      withdraw: instructions.withdraw(key, key, key, { collateral: true }, 1n),
      place_order: instructions.placeOrder(use, sample),
      cancel_order: instructions.cancelOrder(use, 1n),
      cancel_all: instructions.cancelAll(use, 1),
      sync_view: instructions.syncView(use),
      liquidate: instructions.liquidate(use, 1, 1n, 1n),
      publish_price: instructions.publishPrice(key, 1, 1n, 1n),
      reset_price: instructions.resetPrice(key, 1, 1n, 1n),
      update_funding: instructions.updateFunding(1),
      schedule_funding: instructions.scheduleFunding(key, 1, 1n, 1n, 1n),
      cover_shortfall: instructions.coverShortfall(1, 2),
      reconcile_shortfall: instructions.reconcileShortfall([]),
      transfer_between_balances: instructions.transferBetweenBalances(
        use,
        true,
        0,
        1n,
      ),
      resume_market: instructions.resumeMarket(key, 1),
      move_fees_to_insurance: instructions.moveFeesToInsurance(key, 1n),
      collect_fees: instructions.collectFees(key, key, key, { spot: 1 }, 1n),
      restrict_market: instructions.restrictMarket(
        key,
        1,
        MARKET_STATUS.paused,
      ),
      fund_insurance: instructions.fundInsurance(key, key, key, 1n),
      close_unused_trader: instructions.closeUnusedTrader(key, key),
    };
    const declared = idl.instructions.filter(
      (instruction) => instruction.name !== "process_undelegation",
    );
    expect(Object.keys(built).sort()).to.deep.equal(
      declared.map((instruction) => instruction.name).sort(),
    );
    for (const instruction of declared) {
      const ours = built[instruction.name];
      expect(
        Array.from(ours.data.subarray(0, 8)),
        instruction.name,
      ).to.deep.equal(instruction.discriminator);
      expect(
        ours.keys.map(
          (meta) =>
            `${meta.isSigner ? "s" : "-"}${meta.isWritable ? "w" : "-"}`,
        ),
        instruction.name,
      ).to.deep.equal(
        instruction.accounts.map(
          (account) =>
            `${account.signer ? "s" : "-"}${account.writable ? "w" : "-"}`,
        ),
      );
    }
  });
});

describe("the exchange, on Solana", () => {
  before(async () => {
    await Promise.all([
      airdropped(admin.publicKey, 100),
      airdropped(stranger.publicKey, 5),
    ]);
  });

  it("can only be set up by the program's upgrade authority", async () => {
    expect(
      await refusal(
        send(
          base,
          instructions.initializeExchange(stranger.publicKey, settings()),
          stranger,
        ),
      ),
    ).to.include("NotUpgradeAuthority");
    expect(await base.getAccountInfo(addresses.exchange)).to.equal(null);
  });

  it("refuses a step limit of zero or above what one order may perform, and an unknown collateral token", async () => {
    for (const over of [
      { maxSteps: 0 },
      { maxSteps: MAX_FILLS + 1 },
      { collateralToken: 4 },
    ]) {
      expect(
        await refusal(
          send(
            base,
            instructions.initializeExchange(admin.publicKey, settings(over)),
            admin,
          ),
        ),
      ).to.include("InvalidSettings");
    }
  });

  it("is set up by the upgrade authority, who becomes its admin, and takes a plain transfer from anyone", async () => {
    await send(
      base,
      instructions.initializeExchange(admin.publicKey, settings()),
      admin,
    );
    const exchange = await exchangeOn(base);
    expect(exchange.admin.equals(admin.publicKey)).to.equal(true);
    expect(exchange.gate.equals(gate.publicKey)).to.equal(true);
    await send(
      base,
      SystemProgram.transfer({
        fromPubkey: stranger.publicKey,
        toPubkey: addresses.exchange,
        lamports: EXCHANGE_FLOAT,
      }),
      stranger,
    );
    const rent = await base.getMinimumBalanceForRentExemption(
      (await base.getAccountInfo(addresses.exchange))!.data.length,
    );
    expect(await base.getBalance(addresses.exchange)).to.equal(
      rent + EXCHANGE_FLOAT,
    );
  });

  handsOverItsAdminRole(
    () => base,
    (by) => [
      instructions.updateExchange(by, settings()),
      instructions.setPaused(by, true),
      instructions.proposeAdmin(by, by),
      instructions.withdrawExchange(by, 1n),
      instructions.delegateExchange(by, VALIDATOR),
    ],
  );

  it("is delegated to the rollup only by its admin, with its whole balance", async () => {
    expect(
      await refusal(
        send(
          base,
          instructions.delegateExchange(stranger.publicKey, VALIDATOR),
          stranger,
        ),
      ),
    ).to.include("NotAdmin");
    const balance = await base.getBalance(addresses.exchange);
    await ensureExchange({
      solana: base,
      rollup,
      admin,
      gate: gate.publicKey,
      oracle: oracle.publicKey,
      validator: VALIDATOR,
      floatLamports: EXCHANGE_FLOAT,
    });
    expect(await exchangeBalance()).to.equal(balance);
  });
});

describe("set-up inside the rollup", () => {
  before(async () => {
    await fundRentPda(base, admin);
    mints.nUSD = await createMint(base, admin, 6);
    mints.nSOL = await createMint(base, admin, 9);
  });

  it("registers a token only by the admin, and only once its custody account exists in the rollup", async () => {
    expect(
      await refusal(
        send(
          rollup,
          instructions.registerToken(admin.publicKey, NUSD, mints.nUSD),
          admin,
        ),
      ),
    ).to.include("WrongTokenProgram");
    for (const [index, mint] of [
      [NUSD, mints.nUSD],
      [NSOL, mints.nSOL],
    ] as const) {
      await ensureCustody(base, admin, addresses, mint, VALIDATOR);
      expect(
        await refusal(
          send(
            rollup,
            instructions.registerToken(stranger.publicKey, index, mint),
            stranger,
          ),
        ),
      ).to.include("NotAdmin");
      await registeredToken(rollup, instructions, admin, index, mint);
    }
    const exchange = await exchangeOn(rollup);
    expect(exchange.tokens[NUSD].mint.equals(mints.nUSD)).to.equal(true);
    expect(
      exchange.tokens[NSOL].custody.equals(addresses.custody(mints.nSOL)),
    ).to.equal(true);
  });

  it("registers a token only when its custody balance has its own private permission that nobody reads through", async () => {
    const UNUSED = 2;
    const open = await createMint(base, admin, 6);
    const custody = addresses.custody(open);
    const balance = deriveEphemeralAta(addresses.custodyAuthority, open)[0];
    await send(
      base,
      [
        createAssociatedTokenAccountIdempotentInstruction(
          admin.publicKey,
          custody,
          addresses.custodyAuthority,
          open,
        ),
        initEphemeralAtaIx(
          balance,
          addresses.custodyAuthority,
          open,
          admin.publicKey,
        ),
        delegateEphemeralAtaIx(admin.publicKey, balance, VALIDATOR),
      ],
      admin,
    );
    await until(() => rollup.getAccountInfo(custody), "the open custody");
    const register = instructions.registerToken(admin.publicKey, UNUSED, open);
    expect(
      await refusal(send(rollup, register, admin)),
      "a custody balance with no permission",
    ).to.include("CustodyNotPrivate");

    const borrowed = instructions.registerToken(admin.publicKey, UNUSED, open);
    borrowed.keys[4] = {
      ...borrowed.keys[4],
      pubkey: addresses.custodyPermission(mints.nUSD),
    };
    expect(
      await refusal(send(rollup, borrowed, admin)),
      "the permission of another custody balance",
    ).to.include("WrongDerivation");

    expect((await exchangeOn(rollup)).tokens[UNUSED].mint.toBase58()).to.equal(
      PublicKey.default.toBase58(),
    );
    for (const reader of [anonymous, await readingAs(stranger)]) {
      for (const mint of [mints.nUSD, mints.nSOL]) {
        expect(await reader.getAccountInfo(addresses.custody(mint))).to.equal(
          null,
        );
      }
    }
  });

  it("keeps the collateral token it was created with, whatever an update asks for", async () => {
    const carryingAToken = instructions.updateExchange(
      admin.publicKey,
      settings(),
    );
    carryingAToken.data = instructionData("update_exchange")
      .pubkey(gate.publicKey)
      .pubkey(oracle.publicKey)
      .u8(16)
      .u8(NSOL)
      .build();
    expect(await refusal(send(rollup, carryingAToken, admin))).to.include(
      "InstructionDidNotDeserialize",
    );
    await send(
      rollup,
      instructions.updateExchange(admin.publicKey, {
        ...settings(),
        collateralToken: NSOL,
      }),
      admin,
    );
    const exchange = await exchangeOn(rollup);
    expect(exchange.collateralToken).to.equal(NUSD);
    expect(exchange.maxSeatsPerDay).to.equal(SEATS_PER_DAY);
    const fromAnotherCustody = instructions.collectFees(
      admin.publicKey,
      admin.publicKey,
      mints.nSOL,
      { collateral: true },
      1n,
    );
    expect(await refusal(send(rollup, fromAnotherCustody, admin))).to.include(
      "WrongCustody",
    );
  });

  it("refuses to use the ledger before it has its full size, and then until it is finalised", async () => {
    const keys = OrderKeyManager.fresh(randomSecret32()).publicKeys;
    const owner = Keypair.generate();
    const open = () =>
      send(
        rollup,
        instructions.openTrader(gate.publicKey, owner.publicKey, keys),
        gate,
        [owner],
      );
    await send(rollup, instructions.createLedger(admin.publicKey), admin);
    expect(
      (await rollup.getAccountInfo(addresses.ledger))!.data.length,
    ).to.equal(10_240);
    expect(await refusal(open())).to.include("WrongSize");
    await growToFullSize(
      rollup,
      admin,
      GROW_KIND.ledger,
      0,
      addresses.ledger,
      ACCOUNT_LEN.ledger,
    );
    expect(
      (await rollup.getAccountInfo(addresses.ledger))!.data.length,
    ).to.equal(ACCOUNT_LEN.ledger);
    expect(await refusal(open())).to.include("NotReady");
    await setupLedger(rollup, admin);
    await open();
    expect((await viewThroughThePort(owner.publicKey)).seat).to.equal(2);
  });

  it("refuses to use a market before it is finalised, and serves it to anyone afterwards", async () => {
    await send(
      rollup,
      instructions.createMarket(admin.publicKey, SPOT, spotMarket()),
      admin,
    );
    const publish = async () =>
      send(
        rollup,
        instructions.publishPrice(
          oracle.publicKey,
          SPOT,
          MARK,
          BigInt(await rollupNow()),
        ),
        oracle,
      );
    expect(await refusal(publish())).to.include("NotReady");
    await setupMarket(rollup, admin, SPOT, spotMarket());
    await publish();
    const market = decodeMarket(
      (await anonymous.getAccountInfo(addresses.market(SPOT)))!.data,
    );
    expect(market.params.tick).to.equal(100n);
    expect(market.baseSymbol).to.equal("NSOL");
    await setupMarket(rollup, admin, PERP, perpMarket());
    await setupMarket(rollup, admin, TINY, spotMarket(2));
    for (const marketId of [PERP, TINY]) {
      await send(
        rollup,
        instructions.publishPrice(
          oracle.publicKey,
          marketId,
          MARK,
          BigInt(await rollupNow()),
        ),
        oracle,
      );
    }
  });

  it("grows an unready account by at most one step, by the admin only, and never a finalised one", async () => {
    await send(
      rollup,
      instructions.createMarket(admin.publicKey, UNFINISHED, perpMarket()),
      admin,
    );
    const book = addresses.book(UNFINISHED);
    const grow = (
      by: PublicKey,
      target: PublicKey,
      marketId: number,
      to: number,
    ) => instructions.growAccount(by, GROW_KIND.book, marketId, target, to);
    expect(
      await refusal(
        send(
          rollup,
          grow(stranger.publicKey, book, UNFINISHED, 20_480),
          stranger,
        ),
      ),
    ).to.include("NotAdmin");
    expect(
      await refusal(
        send(rollup, grow(admin.publicKey, book, UNFINISHED, 30_720), admin),
      ),
    ).to.include("InvalidGrowth");
    expect(
      await refusal(
        send(
          rollup,
          grow(admin.publicKey, addresses.book(SPOT), SPOT, ACCOUNT_LEN.book),
          admin,
        ),
      ),
    ).to.include("AlreadyReady");
    await send(rollup, grow(admin.publicKey, book, UNFINISHED, 20_480), admin);
    expect((await rollup.getAccountInfo(book))!.data.length).to.equal(20_480);
  });

  it("publishes a price only through the oracle, never backwards in time or beyond the move limit", async () => {
    const published = (await anonymous.getAccountInfo(
      addresses.priceFeed(SPOT),
    ))!.data;
    const lastPublish = new DataView(
      published.buffer,
      published.byteOffset,
    ).getBigInt64(24, true);
    await waitFor(
      async () => (await rollupNow()) > Number(lastPublish),
      "the rollup clock to pass the last publish",
    );
    const now = BigInt(await rollupNow());
    expect(
      await refusal(
        send(
          rollup,
          instructions.publishPrice(stranger.publicKey, SPOT, MARK, now),
          stranger,
        ),
      ),
    ).to.include("NotOracle");
    expect(
      await refusal(
        send(
          rollup,
          instructions.publishPrice(oracle.publicKey, SPOT, MARK, now - 100n),
          oracle,
        ),
      ),
    ).to.include("PriceTimeWentBackwards");
    expect(
      await refusal(
        send(
          rollup,
          instructions.publishPrice(oracle.publicKey, SPOT, MARK * 2n, now),
          oracle,
        ),
      ),
    ).to.include("PriceMoveTooLarge");
    expect(
      await refusal(
        send(
          rollup,
          instructions.resetPrice(stranger.publicKey, SPOT, MARK, now),
          stranger,
        ),
      ),
    ).to.include("NotAdmin");
  });

  it("changes a market's limits only by the admin and only within the bounds", async () => {
    expect(
      await refusal(
        send(
          rollup,
          instructions.updateMarket(stranger.publicKey, SPOT, limits()),
          stranger,
        ),
      ),
    ).to.include("NotAdmin");
    expect(
      await refusal(
        send(
          rollup,
          instructions.updateMarket(
            admin.publicKey,
            SPOT,
            limits({ bandBps: 0 }),
          ),
          admin,
        ),
      ),
    ).to.include("InvalidSettings");
    expect(
      await refusal(
        send(
          rollup,
          instructions.updateMarket(
            admin.publicKey,
            PERP,
            limits({ mmBps: 2_000 }),
          ),
          admin,
        ),
      ),
    ).to.include("InvalidMarketParams");
    await send(
      rollup,
      instructions.updateMarket(admin.publicKey, SPOT, spotMarket().limits),
      admin,
    );
  });

  it("finishes a market's set-up through the private endpoint, where its sealed book cannot be read", async () => {
    const book = addresses.book(VIA_FILTER);
    await send(
      rollup,
      instructions.createMarket(admin.publicKey, VIA_FILTER, spotMarket()),
      admin,
    );
    await send(
      rollup,
      [2, 3].map((steps) =>
        instructions.growAccount(
          admin.publicKey,
          GROW_KIND.book,
          VIA_FILTER,
          book,
          steps * GROWTH_STEP,
        ),
      ),
      admin,
    );
    const asAdmin = await readingAs(admin);
    expect(await asAdmin.getAccountInfo(book)).to.equal(null);
    await setupMarket(asAdmin, admin, VIA_FILTER, spotMarket(), PROGRAM_ID);
    expect((await rollup.getAccountInfo(book))!.data.length).to.equal(
      ACCOUNT_LEN.book,
    );
    const market = await anonymous.getAccountInfo(addresses.market(VIA_FILTER));
    expect(decodeMarket(market!.data).header.ready).to.equal(true);
    await setupMarket(asAdmin, admin, VIA_FILTER, spotMarket(), PROGRAM_ID);
  });
});

describe("a trader", () => {
  it("gets a seat and a view with four order keys in one instruction, paid by the exchange", async () => {
    const before = await exchangeBalance();
    alice = await openedTrader("alice");
    expect(before - (await exchangeBalance())).to.equal(
      rollupRent(ACCOUNT_LEN.view) + rollupRent(35 + 2 * 33),
    );
    const view = await alice.client.view();
    expect(view.orderKeys.map((key) => key.toBase58())).to.deep.equal(
      alice.keys.publicKeys.map((key) => key.toBase58()),
    );
    expect(
      (await ledgerThroughThePort()).seats[alice.seat].owner.equals(
        alice.owner.publicKey,
      ),
    ).to.equal(true);
  });

  it("is not opened without the gate, with the owner as an order key, or with a repeated key", async () => {
    const owner = Keypair.generate();
    const keys = OrderKeyManager.fresh(randomSecret32()).publicKeys;
    expect(
      await refusal(
        send(
          rollup,
          instructions.openTrader(stranger.publicKey, owner.publicKey, keys),
          stranger,
          [owner],
        ),
      ),
    ).to.include("GateMissing");
    expect(
      await refusal(
        send(
          rollup,
          instructions.openTrader(gate.publicKey, owner.publicKey, [
            owner.publicKey,
            ...keys.slice(1),
          ]),
          gate,
          [owner],
        ),
      ),
    ).to.include("InvalidOrderKey");
    expect(
      await refusal(
        send(
          rollup,
          instructions.openTrader(gate.publicKey, owner.publicKey, [
            keys[0],
            keys[0],
            keys[2],
            keys[3],
          ]),
          gate,
          [owner],
        ),
      ),
    ).to.include("InvalidOrderKey");
    expect(
      await rollup.getAccountInfo(addresses.view(owner.publicKey)),
    ).to.equal(null);
  });

  it("reads its own view through the private endpoint, while a stranger, an anonymous caller and the owner read no ledger, no book and no other view", async () => {
    bob = await openedTrader("bob");
    carol = await openedTrader("carol");
    const mine = await alice.client.view();
    expect(mine.owner.equals(alice.owner.publicKey)).to.equal(true);
    for (const reader of [await readingAs(stranger), anonymous, alice.reader]) {
      expect(await reader.getAccountInfo(addresses.market(SPOT))).to.not.equal(
        null,
      );
      expect(await reader.getAccountInfo(addresses.ledger)).to.equal(null);
      expect(await reader.getAccountInfo(addresses.book(SPOT))).to.equal(null);
      expect(
        await reader.getAccountInfo(addresses.view(bob.owner.publicKey)),
      ).to.equal(null);
    }
  });

  it("takes a deposit from any key into any open seat, crediting exactly what moved into custody", async () => {
    await fundedWith(alice, mints.nUSD, 2_000n * USD);
    await fundedWith(bob, mints.nSOL, 10n * SOL);
    await fundedWith(bob, mints.nUSD, 200n * USD);
    await fundedWith(carol, mints.nUSD, 1_000n * USD);
    const custodyBefore = await balanceOf(addresses.custody(mints.nUSD));
    await deposited(alice, mints.nUSD, NUSD, 1_000n * USD);
    await deposited(bob, mints.nSOL, NSOL, 10n * SOL);
    await deposited(bob, mints.nUSD, NUSD, 100n * USD);
    expect(
      (await balanceOf(addresses.custody(mints.nUSD))) - custodyBefore,
    ).to.equal(1_100n * USD);
    const ledger = await ledgerThroughThePort();
    expect(ledger.seats[alice.seat].spot[NUSD].available).to.equal(
      1_000n * USD,
    );
    expect(ledger.seats[bob.seat].spot[NSOL].available).to.equal(10n * SOL);
    await custodyMatchesLedger();
  });

  it("refuses a deposit of the wrong mint, of an unregistered token, or of nothing", async () => {
    const wrongMint = instructions.deposit(
      bob.owner.publicKey,
      tokenAccount(bob, mints.nSOL),
      mints.nUSD,
      bob.owner.publicKey,
      { spot: NUSD },
      1n,
    );
    expect(await refusal(send(rollup, wrongMint, bob.owner))).to.include(
      "WrongMint",
    );
    const unknown = instructions.deposit(
      bob.owner.publicKey,
      tokenAccount(bob, mints.nSOL),
      mints.nSOL,
      bob.owner.publicKey,
      { spot: 3 },
      1n,
    );
    expect(await refusal(send(rollup, unknown, bob.owner))).to.include(
      "UnknownToken",
    );
    const nothing = instructions.deposit(
      bob.owner.publicKey,
      tokenAccount(bob, mints.nSOL),
      mints.nSOL,
      bob.owner.publicKey,
      { spot: NSOL },
      0n,
    );
    expect(await refusal(send(rollup, nothing, bob.owner))).to.include(
      "ZeroAmount",
    );
    await custodyMatchesLedger();
  });

  it("refuses a deposit into the fee seat or the insurance seat, which no view names", async () => {
    const before = await ledgerThroughThePort();
    for (const seat of [FEE_SEAT, INSURANCE_SEAT]) {
      const reservedOwner = before.seats[seat].owner;
      expect(reservedOwner.equals(PROGRAM_ID), `seat ${seat}`).to.equal(true);
      for (const asset of [{ spot: NUSD }, { collateral: true as const }]) {
        const reserved = instructions.deposit(
          bob.owner.publicKey,
          tokenAccount(bob, mints.nUSD),
          mints.nUSD,
          reservedOwner,
          asset,
          1n,
        );
        expect(
          await refusal(send(rollup, reserved, bob.owner)),
          `seat ${seat}`,
        ).to.include("AccountMissing");
      }
    }
    const after = await ledgerThroughThePort();
    expect(after.seats[FEE_SEAT]).to.deep.equal(before.seats[FEE_SEAT]);
    expect(after.seats[INSURANCE_SEAT]).to.deep.equal(
      before.seats[INSURANCE_SEAT],
    );
    await custodyMatchesLedger();
  });

  it("deposits and withdraws through the rollup's own port on the local network, whose query filter refuses both", async () => {
    const zoe = await openedTrader("zoe");
    const from = await fundedWith(zoe, mints.nUSD, 10n * USD);
    const deposit = instructions.deposit(
      zoe.owner.publicKey,
      from,
      mints.nUSD,
      zoe.owner.publicKey,
      { spot: NUSD },
      4n * USD,
    );
    const withdraw = instructions.withdraw(
      zoe.owner.publicKey,
      from,
      mints.nUSD,
      { spot: NUSD },
      1n * USD,
      [PERP],
    );
    const available = async () =>
      (await ledgerThroughThePort()).seats[zoe.seat].spot[NUSD].available;

    expect(
      await refusal(send(zoe.reader, deposit, zoe.owner)),
      "a deposit through the local query filter",
    ).to.include("Access denied");
    await send(rollup, deposit, zoe.owner);
    expect(await available()).to.equal(4n * USD);
    expect(
      await refusal(send(zoe.reader, withdraw, zoe.owner)),
      "a withdrawal through the local query filter",
    ).to.include("Access denied");
    await send(rollup, withdraw, zoe.owner);
    expect(await available()).to.equal(3n * USD);
    expect(await balanceOf(from)).to.equal(7n * USD);
    await custodyMatchesLedger();
  });

  it("opens a seat and funds it from another key in one transaction", async () => {
    const service = Keypair.generate();
    const source = await funded(service, mints.nUSD, 5n * USD, mintTo);
    const owner = Keypair.generate();
    const keys = OrderKeyManager.fresh(randomSecret32());
    await send(
      rollup,
      [
        instructions.openTrader(
          gate.publicKey,
          owner.publicKey,
          keys.publicKeys,
        ),
        instructions.deposit(
          service.publicKey,
          source,
          mints.nUSD,
          owner.publicKey,
          { spot: NUSD },
          5n * USD,
        ),
      ],
      gate,
      [owner, service],
    );
    const view = await viewThroughThePort(owner.publicKey);
    const seat = (await ledgerThroughThePort()).seats[view.seat];
    expect(seat.owner.equals(owner.publicKey)).to.equal(true);
    expect(seat.spot[NUSD].available).to.equal(5n * USD);
    expect(seat.version > view.openedVersion).to.equal(true);
    await custodyMatchesLedger();
  });
});

describe("orders, signed by one-time keys", () => {
  const ioc = (price = 140_000n, size = 10n) =>
    order(SIDE.bid, ORDER_TYPE.immediateOrCancel, price, size);

  it("is placed only by one of the view's keys, and a used key is refused afterwards", async () => {
    const impostor = Keypair.generate();
    const probe = alice.keys.take();
    const wrong = instructions.placeOrder(
      {
        ...call(alice, probe, SPOT, 1n, BigInt(nowSeconds() + 5)),
        orderKey: impostor.publicKey,
      },
      ioc(),
    );
    expect(await refusal(send(rollup, wrong, impostor))).to.include(
      "NotOrderKey",
    );
    alice.keys.release(probe);
    const { use } = await attempted(alice, (use, id, expiresAt) =>
      instructions.placeOrder(call(alice, use, SPOT, id, expiresAt), ioc()),
    );
    const again = instructions.placeOrder(
      {
        ...call(alice, use, SPOT, 2n, BigInt(nowSeconds() + 5)),
        replacement: Keypair.generate().publicKey,
      },
      ioc(),
    );
    expect(await refusal(send(rollup, again, use.keypair))).to.include(
      "NotOrderKey",
    );
    const view = await alice.client.view();
    expect(view.orderKeys[use.slot].equals(use.replacement.publicKey)).to.equal(
      true,
    );
  });

  it("refuses a replacement that is a live key, the owner, or the zero key, and leaves the key live", async () => {
    const live = (await alice.client.view()).orderKeys;
    const use = alice.keys.take();
    for (const replacement of [
      live[(use.slot + 1) % 4],
      alice.owner.publicKey,
      PublicKey.default,
    ]) {
      const bad = instructions.placeOrder(
        {
          ...call(alice, use, SPOT, 3n, BigInt(nowSeconds() + 5)),
          replacement,
        },
        ioc(),
      );
      expect(await refusal(send(rollup, bad, use.keypair))).to.include(
        "InvalidOrderKey",
      );
    }
    alice.keys.release(use);
    expect(
      (await alice.client.view()).orderKeys.map((key) => key.toBase58()),
    ).to.deep.equal(live.map((key) => key.toBase58()));
  });

  it("refuses an expired order and one that expires too far ahead, and the same key then places a fresh one", async () => {
    const use = alice.keys.take();
    const stale = instructions.placeOrder(
      call(alice, use, SPOT, 4n, BigInt(nowSeconds() - 5)),
      ioc(),
    );
    expect(await refusal(send(rollup, stale, use.keypair))).to.include(
      "Expired",
    );
    const far = instructions.placeOrder(
      call(alice, use, SPOT, 5n, BigInt(nowSeconds() + 120)),
      ioc(),
    );
    expect(await refusal(send(rollup, far, use.keypair))).to.include(
      "ExpiryTooFar",
    );
    const fresh = instructions.placeOrder(
      call(alice, use, SPOT, 6n, BigInt(nowSeconds() + 5)),
      ioc(),
    );
    await send(rollup, fresh, use.keypair);
    alice.keys.confirm(use);
    const result = await resultFor(alice, 6n);
    expect(result.status).to.equal(RESULT_STATUS.remainderCancelled);
  });

  it("executes the same signed order once when it is sent twice", async () => {
    const use = alice.keys.take();
    const clientOrderId = 7n;
    const written = (await alice.client.view()).resultsWritten;
    const instruction = instructions.placeOrder(
      call(alice, use, SPOT, clientOrderId, BigInt(nowSeconds() + 5)),
      ioc(),
    );
    const { raw } = await sentRaw([instruction], use.keypair);
    await rollup
      .sendRawTransaction(raw, { skipPreflight: true })
      .catch(() => undefined);
    await resultFor(alice, clientOrderId);
    await rollup
      .sendRawTransaction(raw, { skipPreflight: true })
      .catch(() => undefined);
    alice.keys.confirm(use);
    await until(
      async () => (await alice.client.view()).resultsWritten > written,
      "the result to be written",
    );
    const view = await alice.client.view();
    expect(view.resultsWritten).to.equal(written + 1);
    expect(
      view.results.filter((result) => result.clientOrderId === clientOrderId),
    ).to.have.length(1);
    expect(view.orderKeys[use.slot].equals(use.replacement.publicKey)).to.equal(
      true,
    );
  });

  it("signs two consecutive orders with different keys, neither the owner, and shows a stranger an empty transaction", async () => {
    const first = await attempted(alice, (use, id, expiresAt) =>
      instructions.placeOrder(call(alice, use, SPOT, id, expiresAt), ioc()),
    );
    const second = await attempted(alice, (use, id, expiresAt) =>
      instructions.placeOrder(call(alice, use, SPOT, id, expiresAt), ioc()),
    );
    expect(
      first.use.keypair.publicKey.equals(second.use.keypair.publicKey),
    ).to.equal(false);
    for (const { use } of [first, second]) {
      expect(use.keypair.publicKey.equals(alice.owner.publicKey)).to.equal(
        false,
      );
    }
    const signatures = await rollup.getSignaturesForAddress(PROGRAM_ID, {
      limit: 2,
    });
    const landed = await rollup.getTransaction(signatures[0].signature, {
      maxSupportedTransactionVersion: 0,
    });
    expect(
      landed!.transaction.message
        .getAccountKeys()
        .get(0)!
        .equals(second.use.keypair.publicKey),
    ).to.equal(true);
    const shell = await anonymous.getTransaction(signatures[0].signature, {
      maxSupportedTransactionVersion: 0,
    });
    expect(shell!.transaction.message.getAccountKeys().length).to.equal(0);
    expect(shell!.meta!.logMessages ?? []).to.have.length(0);
  });

  it("writes a post-only order that would match as an outcome, and leaves the book as it was", async () => {
    const resting = await bob.client.placeOrder(
      SPOT,
      order(SIDE.ask, ORDER_TYPE.limit, MARK, 100n),
    );
    expect(resting.outcome).to.equal("placed");
    const placed = await alice.client.placeOrder(
      SPOT,
      order(SIDE.bid, ORDER_TYPE.postOnly, MARK, 10n),
    );
    expect(placed.outcome === "placed" && placed.result.status).to.equal(
      RESULT_STATUS.refusedPostOnlyWouldMatch,
    );
    expect(placed.outcome === "placed" && placed.result.filled).to.equal(0n);
    const bobsView = await bob.client.syncView(SPOT);
    expect(bobsView?.kind).to.equal(4);
    expect(
      (await bob.client.view()).snapshot.orders.map((entry) => entry.remaining),
    ).to.deep.equal([100n]);
    const cancelled = await bob.client.cancelAll(SPOT);
    expect(cancelled?.cancelled).to.equal(1n);
  });

  it("writes a full side as an outcome: the remainder is cancelled and nothing is evicted", async () => {
    const bid = (price: bigint) =>
      alice.client.placeOrder(
        TINY,
        order(SIDE.bid, ORDER_TYPE.limit, price, 10n),
      );
    for (const price of [MARK - 100n, MARK - 200n]) {
      const placed = await bid(price);
      expect(placed.outcome === "placed" && placed.result.status).to.equal(
        RESULT_STATUS.rested,
      );
    }
    const third = await bid(MARK - 300n);
    expect(third.outcome === "placed" && third.result.status).to.equal(
      RESULT_STATUS.remainderCancelledBookFull,
    );
    expect(third.outcome === "placed" && third.result.rested).to.equal(0n);
    expect(third.outcome === "placed" && third.result.cancelled).to.equal(10n);
    expect(
      (await alice.client.view()).snapshot.orders.map((entry) => entry.price),
    ).to.deep.equal([MARK - 100n, MARK - 200n]);
    expect((await alice.client.cancelAll(TINY))?.cancelled).to.equal(2n);
  });

  it("writes an immediate-or-cancel that matched nothing as an outcome with nothing filled", async () => {
    const placed = await alice.client.placeOrder(SPOT, ioc(140_000n, 10n));
    expect(placed.outcome === "placed" && placed.result.status).to.equal(
      RESULT_STATUS.remainderCancelled,
    );
    expect(placed.outcome === "placed" && placed.result.filled).to.equal(0n);
    expect(placed.outcome === "placed" && placed.result.cancelled).to.equal(
      10n,
    );
  });

  it("refuses what depends only on public settings as an error that changes nothing", async () => {
    const offTick = (use: OrderKeyUse, id: bigint, expiresAt: bigint) =>
      instructions.placeOrder(
        call(alice, use, SPOT, id, expiresAt),
        order(SIDE.bid, ORDER_TYPE.limit, MARK + 1n, 1n),
      );
    expect(await refusal(attempted(alice, offTick))).to.include("PriceOffTick");
    const outside = (use: OrderKeyUse, id: bigint, expiresAt: bigint) =>
      instructions.placeOrder(
        call(alice, use, SPOT, id, expiresAt),
        order(SIDE.bid, ORDER_TYPE.limit, MARK / 2n - 100n, 100n),
      );
    expect(await refusal(attempted(alice, outside))).to.include(
      "PriceOutsideBand",
    );
    const tooMuch = (use: OrderKeyUse, id: bigint, expiresAt: bigint) =>
      instructions.placeOrder(
        call(alice, use, SPOT, id, expiresAt),
        order(SIDE.bid, ORDER_TYPE.limit, MARK, 100_000n),
      );
    expect(await refusal(attempted(alice, tooMuch))).to.include(
      "InsufficientBalance",
    );
    await custodyMatchesLedger();
  });
});

describe("spot money, end to end", () => {
  let askSeq: bigint;
  let aliceSecret: Uint8Array;
  let bobSecret: Uint8Array;

  it("fills a bid against the resting ask at the ask's price, pays the fee to the fee seat, and prints receipts both sides recognise", async () => {
    const ledgerBefore = await ledgerThroughThePort();
    const ask = await bob.client.placeOrder(
      SPOT,
      order(SIDE.ask, ORDER_TYPE.limit, MARK, 1_000n),
    );
    if (ask.outcome !== "placed") throw new Error("the ask did not land");
    askSeq = ask.result.orderSeq;
    bobSecret = ask.secret;
    const bid = await alice.client.placeOrder(
      SPOT,
      order(SIDE.bid, ORDER_TYPE.limit, MARK + 1_000n, 400n),
    );
    if (bid.outcome !== "placed") throw new Error("the bid did not land");
    aliceSecret = bid.secret;
    expect(bid.result.status).to.equal(RESULT_STATUS.filled);
    expect(bid.result.filled).to.equal(400n);
    expect(bid.result.filledNotional).to.equal(400n * MARK);
    expect(bid.result.fee).to.equal(30_000n);

    const ledger = await ledgerThroughThePort();
    const before = (seat: number) => ledgerBefore.seats[seat];
    expect(ledger.seats[alice.seat].spot[NUSD].available).to.equal(
      before(alice.seat).spot[NUSD].available - 400n * MARK - 30_000n,
    );
    expect(ledger.seats[alice.seat].spot[NSOL].available).to.equal(400n * LOT);
    expect(ledger.seats[bob.seat].spot[NSOL].locked).to.equal(600n * LOT);
    expect(ledger.seats[bob.seat].spot[NSOL].available).to.equal(
      before(bob.seat).spot[NSOL].available - 1_000n * LOT,
    );
    expect(ledger.seats[bob.seat].spot[NUSD].available).to.equal(
      before(bob.seat).spot[NUSD].available + 400n * MARK,
    );
    expect(ledger.seats[FEE_SEAT].spot[NUSD].available).to.equal(
      before(FEE_SEAT).spot[NUSD].available + 30_000n,
    );

    const tape = decodeTape(
      (await anonymous.getAccountInfo(addresses.tape(SPOT)))!.data,
    );
    expect(tape.fills[0].price).to.equal(MARK);
    expect(tape.fills[0].size).to.equal(400n);
    expect(
      ownFills(tape.fills, [aliceSecret]).map((own) => own.role),
    ).to.deep.equal(["taker"]);
    expect(
      ownFills(tape.fills, [bobSecret]).map((own) => own.role),
    ).to.deep.equal(["maker"]);
    expect(ownFills(tape.fills, [randomSecret()])).to.have.length(0);
    const stats = decodeStats(
      (await anonymous.getAccountInfo(addresses.stats))!.data,
    );
    expect(stats.fills).to.equal(1n);
    expect(stats.volume[SPOT]).to.equal(400n * MARK);
    await custodyMatchesLedger();
  });

  it("shows the maker the fill only after a sync, with the seat's version moved on", async () => {
    const stale = await bob.client.view();
    expect(stale.snapshot.seat.spot[NUSD].available).to.not.equal(
      (await ledgerThroughThePort()).seats[bob.seat].spot[NUSD].available,
    );
    await bob.client.syncView(SPOT);
    const synced = await bob.client.view();
    expect(synced.snapshot.seat.version > stale.snapshot.seat.version).to.equal(
      true,
    );
    expect(synced.snapshot.seat.spot[NUSD].available).to.equal(
      (await ledgerThroughThePort()).seats[bob.seat].spot[NUSD].available,
    );
    expect(
      synced.snapshot.orders.map((entry) => entry.remaining),
    ).to.deep.equal([600n]);
  });

  it("cancels the resting remainder and releases exactly what was locked, and reports a gone order as an outcome", async () => {
    const cancelled = await bob.client.cancelOrder(SPOT, askSeq);
    expect(cancelled?.cancelled).to.equal(1n);
    const seat = (await ledgerThroughThePort()).seats[bob.seat];
    expect(seat.spot[NSOL].locked).to.equal(0n);
    expect(seat.spot[NSOL].available).to.equal(10n * SOL - 400n * LOT);
    const gone = await bob.client.cancelOrder(SPOT, askSeq);
    expect(gone?.status).to.equal(RESULT_STATUS.refused);
    expect(gone?.code).to.equal(50);
    await custodyMatchesLedger();
  });

  it("cancels a resting order whose own expiry has passed when matching reaches it, instead of filling it", async () => {
    const expiry = BigInt((await rollupNow()) + 1);
    const bid = await alice.client.placeOrder(
      SPOT,
      order(SIDE.bid, ORDER_TYPE.limit, MARK - 2_000n, 10n),
      { secret: randomSecret() },
    );
    expect(bid.outcome === "placed" && bid.result.status).to.equal(
      RESULT_STATUS.rested,
    );
    const seq = bid.outcome === "placed" ? bid.result.orderSeq : 0n;
    await alice.client.cancelOrder(SPOT, seq);
    const timed = await alice.client.placeOrder(SPOT, {
      ...order(SIDE.bid, ORDER_TYPE.limit, MARK - 2_000n, 10n),
      expiry,
    });
    expect(timed.outcome === "placed" && timed.result.status).to.equal(
      RESULT_STATUS.rested,
    );
    expect((await alice.client.view()).snapshot.orders[0].expiry).to.equal(
      expiry,
    );
    await waitFor(
      async () => (await rollupNow()) > Number(expiry),
      "the rollup clock to pass the order's expiry",
    );
    const ask = await bob.client.placeOrder(
      SPOT,
      order(SIDE.ask, ORDER_TYPE.immediateOrCancel, MARK - 2_000n, 10n),
    );
    expect(ask.outcome === "placed" && ask.result.filled).to.equal(0n);
    await alice.client.syncView(SPOT);
    expect((await alice.client.view()).snapshot.orders).to.have.length(0);
    expect(
      (await ledgerThroughThePort()).seats[alice.seat].spot[NUSD].locked,
    ).to.equal(0n);
    await custodyMatchesLedger();
  });

  it("sells into a resting bid, and a cancel of what is left returns the lock", async () => {
    const bid = await alice.client.placeOrder(
      SPOT,
      order(SIDE.bid, ORDER_TYPE.limit, MARK - 1_000n, 100n),
    );
    expect(bid.outcome === "placed" && bid.result.status).to.equal(
      RESULT_STATUS.rested,
    );
    const ask = await bob.client.placeOrder(
      SPOT,
      order(SIDE.ask, ORDER_TYPE.immediateOrCancel, MARK - 1_000n, 40n),
    );
    expect(ask.outcome === "placed" && ask.result.filled).to.equal(40n);
    expect(ask.outcome === "placed" && ask.result.fee).to.equal(2_980n);
    const left = await alice.client.cancelAll(SPOT);
    expect(left?.cancelled).to.equal(1n);
    const seat = (await ledgerThroughThePort()).seats[alice.seat];
    expect(seat.spot[NUSD].locked).to.equal(0n);
    expect(seat.spot[NSOL].available).to.equal(440n * LOT);
    await custodyMatchesLedger();
  });

  it("withdraws inside the rollup, to the owner's own token account, what the seat has available", async () => {
    const to = tokenAccount(alice, mints.nUSD);
    const before = await balanceOf(to);
    const custodyBefore = await balanceOf(addresses.custody(mints.nUSD));
    await send(
      rollup,
      instructions.withdraw(
        alice.owner.publicKey,
        to,
        mints.nUSD,
        { spot: NUSD },
        50n * USD,
        [PERP],
      ),
      alice.owner,
    );
    expect((await balanceOf(to)) - before).to.equal(50n * USD);
    expect(
      custodyBefore - (await balanceOf(addresses.custody(mints.nUSD))),
    ).to.equal(50n * USD);
    expect(
      (await alice.client.view()).snapshot.seat.spot[NUSD].available,
    ).to.equal(
      (await ledgerThroughThePort()).seats[alice.seat].spot[NUSD].available,
    );
    const elsewhere = instructions.withdraw(
      alice.owner.publicKey,
      tokenAccount(bob, mints.nUSD),
      mints.nUSD,
      { spot: NUSD },
      1n,
      [PERP],
    );
    expect(await refusal(send(rollup, elsewhere, alice.owner))).to.include(
      "WrongTokenAccountOwner",
    );
    const tooMuch = instructions.withdraw(
      alice.owner.publicKey,
      to,
      mints.nUSD,
      { spot: NUSD },
      10_000n * USD,
      [PERP],
    );
    expect(await refusal(send(rollup, tooMuch, alice.owner))).to.include(
      "InsufficientBalance",
    );
    await custodyMatchesLedger();
  });
});

describe("perpetual money, end to end", () => {
  before(async () => {
    await deposited(alice, mints.nUSD, NUSD, 100n * USD, true);
    await deposited(bob, mints.nUSD, NUSD, 10n * USD, true);
    await deposited(carol, mints.nUSD, NUSD, 100n * USD, true);
  });

  it("opens a long against a short, takes the fee from the taker's collateral, and counts open interest", async () => {
    const short = await alice.client.placeOrder(
      PERP,
      order(SIDE.ask, ORDER_TYPE.postOnly, MARK, 500n),
      { riskMarkets: [PERP] },
    );
    expect(short.outcome === "placed" && short.result.status).to.equal(
      RESULT_STATUS.rested,
    );
    const long = await bob.client.placeOrder(
      PERP,
      order(SIDE.bid, ORDER_TYPE.limit, MARK, 500n),
      { riskMarkets: [PERP] },
    );
    expect(long.outcome === "placed" && long.result.status).to.equal(
      RESULT_STATUS.filled,
    );
    expect(long.outcome === "placed" && long.result.fee).to.equal(37_500n);
    const ledger = await ledgerThroughThePort();
    expect(ledger.seats[bob.seat].perp[PERP].base).to.equal(500n);
    expect(ledger.seats[bob.seat].perp[PERP].quote).to.equal(-500n * MARK);
    expect(ledger.seats[bob.seat].collateral).to.equal(10n * USD - 37_500n);
    expect(ledger.seats[alice.seat].perp[PERP].base).to.equal(-500n);
    expect(ledger.seats[FEE_SEAT].collateral).to.equal(37_500n);
    const stats = decodeStats(
      (await anonymous.getAccountInfo(addresses.stats))!.data,
    );
    expect(stats.openInterest[PERP]).to.equal(500n);
    await custodyMatchesLedger();
  });

  it("refuses an order that would take equity below initial margin", async () => {
    const more = (use: OrderKeyUse, id: bigint, expiresAt: bigint) =>
      instructions.placeOrder(
        call(bob, use, PERP, id, expiresAt),
        order(SIDE.bid, ORDER_TYPE.limit, MARK, 2_000n),
      );
    expect(await refusal(attempted(bob, more))).to.include(
      "InsufficientMargin",
    );
    await custodyMatchesLedger();
  });

  it("applies funding once per interval from what traded, capped, and a position that is touched pays it", async () => {
    await alice.client.placeOrder(
      PERP,
      order(SIDE.ask, ORDER_TYPE.postOnly, MARK + 2_000n, 10n),
      { riskMarkets: [PERP] },
    );
    const lifted = await bob.client.placeOrder(
      PERP,
      order(SIDE.bid, ORDER_TYPE.immediateOrCancel, MARK + 2_000n, 10n),
      { riskMarkets: [PERP] },
    );
    expect(lifted.outcome === "placed" && lifted.result.filled).to.equal(10n);
    const bobBefore = (await ledgerThroughThePort()).seats[bob.seat].perp[PERP];
    const before = await fundingThroughThePort(PERP);
    const after = await until(
      async () => {
        await send(rollup, instructions.updateFunding(PERP), stranger);
        const now = await fundingThroughThePort(PERP);
        return now.lastTime > before.lastTime && now;
      },
      "the funding interval to pass",
      20_000,
      250,
    );
    expect(before.tradedSize > 0n).to.equal(true);
    const atMark = MARK * before.tradedSize;
    const above = before.tradedNotional >= atMark;
    const distance = above
      ? before.tradedNotional - atMark
      : atMark - before.tradedNotional;
    const capBps = BigInt(limits().fundingCapBps);
    const magnitude =
      distance * 10_000n > atMark * capBps
        ? (MARK * capBps) / 10_000n
        : distance / before.tradedSize;
    expect(magnitude).to.not.equal(0n);
    expect(after.index - before.index).to.equal(above ? magnitude : -magnitude);
    expect(after.tradedSize).to.equal(0n);
    await send(rollup, instructions.updateFunding(PERP), admin);
    expect((await fundingThroughThePort(PERP)).index).to.equal(after.index);
    await bob.client.syncView(PERP);
    const synced = await bob.client.view();
    expect(synced.snapshot.seat.perp[PERP].fundingCheckpoint).to.equal(
      bobBefore.fundingCheckpoint,
    );
    const bidLater = await bob.client.placeOrder(
      PERP,
      order(SIDE.bid, ORDER_TYPE.immediateOrCancel, MARK - 10_000n, 10n),
      {
        riskMarkets: [PERP],
      },
    );
    expect(bidLater.outcome === "placed" && bidLater.result.filled).to.equal(
      0n,
    );
    const touched = (await ledgerThroughThePort()).seats[bob.seat].perp[PERP];
    expect(touched.fundingCheckpoint).to.equal(after.index);
    expect(touched.quote).to.equal(
      bobBefore.quote -
        bobBefore.base * (after.index - bobBefore.fundingCheckpoint),
    );
    await custodyMatchesLedger();
  });

  it("advances funding on its own once the admin schedules it, and nobody else can", async () => {
    expect(
      await refusal(
        send(
          rollup,
          instructions.scheduleFunding(stranger.publicKey, PERP, 7n, 500n, 10n),
          stranger,
        ),
      ),
    ).to.include("NotAdmin");
    expect(
      await refusal(
        send(
          rollup,
          instructions.scheduleFunding(admin.publicKey, SPOT, 8n, 500n, 10n),
          admin,
        ),
      ),
    ).to.include("NotPerpMarket");
    const before = await fundingThroughThePort(PERP);
    await send(
      rollup,
      instructions.scheduleFunding(admin.publicKey, PERP, 9n, 500n, 30n),
      admin,
    );
    const first = await until(
      async () => {
        const now = await fundingThroughThePort(PERP);
        return now.lastTime > before.lastTime && now;
      },
      "the scheduler to apply one interval",
      20_000,
      100,
    );
    const second = await until(
      async () => {
        const now = await fundingThroughThePort(PERP);
        return now.lastTime > first.lastTime && now;
      },
      "the scheduler to apply a second interval",
      20_000,
      100,
    );
    expect(second.lastTime - first.lastTime >= 2n).to.equal(true);
  });

  it("gives a stranger the same public result for a healthy seat, a missing seat and a seat with no position, and the liquidator one recorded result for all three", async () => {
    const publicAccounts = async () =>
      Promise.all(
        [
          addresses.stats,
          addresses.market(PERP),
          addresses.tape(PERP),
          addresses.priceFeed(PERP),
        ].map(async (address) =>
          Buffer.from((await anonymous.getAccountInfo(address))!.data).toString(
            "hex",
          ),
        ),
      );
    const seenByAStranger = async (target: number) => {
      const before = await publicAccounts();
      const { clientOrderId, signature } = await attempted(
        carol,
        (use, id, expiresAt) =>
          instructions.liquidate(
            call(carol, use, PERP, id, expiresAt),
            target,
            1_000n,
            200_000n,
          ),
      );
      const shown = await anonymous.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
      });
      const status = (await rollup.getSignatureStatus(signature)).value;
      const recorded = await resultFor(carol, clientOrderId);
      const mine = await carol.client.view();
      return {
        recorded: { ...recorded, clientOrderId: 0n },
        snapshot: mine.snapshot,
        public: {
          error: status?.err ?? null,
          accounts: shown!.transaction.message.getAccountKeys().length,
          logs: shown!.meta!.logMessages ?? [],
          changed: (await publicAccounts()).map(
            (data, index) => data !== before[index],
          ),
        },
      };
    };
    const flatSeat = (await ledgerThroughThePort()).seats.findIndex(
      (seat, index) =>
        index > INSURANCE_SEAT &&
        index !== carol.seat &&
        seat.status === 1 &&
        seat.perp.every((slot) => slot.base === 0n),
    );
    const healthy = await seenByAStranger(bob.seat);
    const missing = await seenByAStranger(2_000);
    const flat = await seenByAStranger(flatSeat);
    expect(healthy.recorded).to.deep.equal({
      clientOrderId: 0n,
      orderSeq: 0n,
      filled: 0n,
      filledNotional: 0n,
      rested: 0n,
      cancelled: 0n,
      fee: 0n,
      kind: RESULT_KIND.liquidate,
      status: LIQUIDATION_STATUS.nothingToLiquidate,
      code: 0,
    });
    expect(missing.recorded).to.deep.equal(healthy.recorded);
    expect(flat.recorded).to.deep.equal(healthy.recorded);
    expect(missing.snapshot).to.deep.equal(healthy.snapshot);
    expect(flat.snapshot).to.deep.equal(healthy.snapshot);
    expect(healthy.public).to.deep.equal({
      error: null,
      accounts: 0,
      logs: [],
      changed: [false, false, false, false],
    });
    expect(missing.public).to.deep.equal(healthy.public);
    expect(flat.public).to.deep.equal(healthy.public);
  });

  it("liquidates only below maintenance margin with a fresh price, at the penalised price and the size that restores margin, moving no public volume, fill counter or tape", async () => {
    const liquidate = (target: number, worstPrice = 200_000n) =>
      carol.client.liquidate(PERP, target, 1_000n, worstPrice, [PERP]);
    const now = BigInt(await rollupNow());
    const crash = 136_000n;
    await send(
      rollup,
      instructions.resetPrice(admin.publicKey, PERP, crash, now - 100_000n),
      admin,
    );
    const stale = await liquidate(bob.seat);
    expect(stale?.status).to.equal(LIQUIDATION_STATUS.stalePrice);
    await send(
      rollup,
      instructions.resetPrice(admin.publicKey, PERP, crash, now),
      admin,
    );

    const before = await ledgerThroughThePort();
    const bobBefore = before.seats[bob.seat];
    const lots = bobBefore.perp[PERP].base;
    const tooCheap = await liquidate(bob.seat, crash - 2_000n);
    expect(tooCheap?.status).to.equal(LIQUIDATION_STATUS.nothingToLiquidate);
    const publicStats = async () =>
      decodeStats((await anonymous.getAccountInfo(addresses.stats))!.data);
    const statsBefore = await publicStats();
    const tapeBefore = (await anonymous.getAccountInfo(addresses.tape(PERP)))!
      .data;
    const done = await liquidate(bob.seat);
    expect(done?.status).to.equal(LIQUIDATION_STATUS.liquidated);
    expect(await publicStats(), "public counters").to.deep.equal(statsBefore);
    expect(
      (await anonymous.getAccountInfo(addresses.tape(PERP)))!.data.equals(
        tapeBefore,
      ),
      "the public tape",
    ).to.equal(true);
    const taken = done?.filled ?? 0n;
    const price = crash - 1_360n;
    expect(done?.filledNotional).to.equal(taken * price);
    expect(done?.fee).to.equal(0n);
    const ledger = await ledgerThroughThePort();
    const bobAfter = ledger.seats[bob.seat];
    expect(bobAfter.perp[PERP].base).to.equal(lots - taken);
    const funding =
      lots *
      (bobAfter.perp[PERP].fundingCheckpoint -
        bobBefore.perp[PERP].fundingCheckpoint);
    const { mmBps, liqBufferBps, liqPenaltyBps } = decodeMarket(
      (await anonymous.getAccountInfo(addresses.market(PERP)))!.data,
    ).params;
    const equity =
      bobBefore.collateral +
      lots * crash +
      bobBefore.perp[PERP].quote -
      funding;
    const shortage =
      lots * crash * BigInt(mmBps + liqBufferBps) - equity * 10_000n;
    const freedPerLot = crash * BigInt(mmBps + liqBufferBps - liqPenaltyBps);
    const restoring = (shortage + freedPerLot - 1n) / freedPerLot;
    expect(restoring > 0n && restoring < lots).to.equal(true);
    expect(taken).to.equal(restoring);
    const settled = bobBefore.perp[PERP].quote - funding + taken * price;
    if (taken === lots) {
      expect(bobAfter.collateral).to.equal(bobBefore.collateral + settled);
    } else {
      expect(bobAfter.perp[PERP].quote).to.equal(settled);
    }
    expect(ledger.seats[carol.seat].perp[PERP].base).to.equal(taken);
    expect(ledger.seats[carol.seat].perp[PERP].quote).to.equal(-taken * price);
    const stats = decodeStats(
      (await anonymous.getAccountInfo(addresses.stats))!.data,
    );
    expect(stats.openInterest[PERP]).to.equal(lots);
    await custodyMatchesLedger();
  });

  it("goes reduce-only on a reset, and only the admin returns it to normal", async () => {
    const status = async () =>
      decodeMarket(
        (await anonymous.getAccountInfo(addresses.market(PERP)))!.data,
      ).params.status;
    expect(await status()).to.equal(MARKET_STATUS.reduceOnly);
    const grow = (use: OrderKeyUse, id: bigint, expiresAt: bigint) =>
      instructions.placeOrder(
        call(carol, use, PERP, id, expiresAt),
        order(SIDE.bid, ORDER_TYPE.limit, 136_000n, 1n),
      );
    expect(await refusal(attempted(carol, grow))).to.include(
      "MarketReduceOnly",
    );
    expect(
      await refusal(
        send(
          rollup,
          instructions.resumeMarket(stranger.publicKey, PERP),
          stranger,
        ),
      ),
    ).to.include("NotAdmin");
    await send(
      rollup,
      instructions.updateMarket(admin.publicKey, PERP, limits()),
      admin,
    );
    expect(await status(), "after a limits update").to.equal(
      MARKET_STATUS.reduceOnly,
    );
    expect(() =>
      instructions.updateMarket(
        admin.publicKey,
        PERP,
        limits({ status: MARKET_STATUS.paused }),
      ),
    ).to.throw("restrictMarket");
    const restrict = (by: Keypair, to: number) =>
      send(rollup, instructions.restrictMarket(by.publicKey, PERP, to), by);
    expect(await refusal(restrict(stranger, MARKET_STATUS.paused))).to.include(
      "NotAdmin",
    );
    expect(await refusal(restrict(admin, MARKET_STATUS.active))).to.include(
      "ResumeOnly",
    );
    await restrict(admin, MARKET_STATUS.paused);
    expect(await status()).to.equal(MARKET_STATUS.paused);
    await restrict(admin, MARKET_STATUS.reduceOnly);
    expect(await status()).to.equal(MARKET_STATUS.reduceOnly);
    await send(rollup, instructions.resumeMarket(admin.publicKey, PERP), admin);
    expect(await status()).to.equal(MARKET_STATUS.active);
  });

  it("withdraws collateral only down to initial margin, and never when the feed is stale", async () => {
    const to = tokenAccount(carol, mints.nUSD);
    const withdraw = (amount: bigint) =>
      instructions.withdraw(
        carol.owner.publicKey,
        to,
        mints.nUSD,
        { collateral: true },
        amount,
        [PERP],
      );
    expect(
      await refusal(send(rollup, withdraw(100n * USD - 1n), carol.owner)),
    ).to.include("InsufficientMargin");
    const before = await balanceOf(to);
    await send(rollup, withdraw(50n * USD), carol.owner);
    expect((await balanceOf(to)) - before).to.equal(50n * USD);
    await send(
      rollup,
      instructions.resetPrice(
        admin.publicKey,
        PERP,
        136_000n,
        BigInt(await rollupNow()) - 100_000n,
      ),
      admin,
    );
    expect(
      await refusal(send(rollup, withdraw(1n * USD), carol.owner)),
    ).to.include("StalePrice");
    await send(
      rollup,
      instructions.resetPrice(
        admin.publicKey,
        PERP,
        136_000n,
        BigInt(await rollupNow()),
      ),
      admin,
    );
    await send(rollup, instructions.resumeMarket(admin.publicKey, PERP), admin);
    await custodyMatchesLedger();
  });
});

describe("the fee seat and the insurance seat", () => {
  it("pay out fees only to the admin, from custody, and move perp fees to insurance", async () => {
    const to = tokenAccount(carol, mints.nUSD);
    const fees = (await ledgerThroughThePort()).seats[FEE_SEAT];
    const collect = (by: PublicKey, amount: bigint) =>
      instructions.collectFees(by, to, mints.nUSD, { spot: NUSD }, amount);
    expect(
      await refusal(send(rollup, collect(stranger.publicKey, 1n), stranger)),
    ).to.include("NotAdmin");
    expect(
      await refusal(
        send(
          rollup,
          collect(admin.publicKey, fees.spot[NUSD].available + 1n),
          admin,
        ),
      ),
    ).to.include("InsufficientBalance");
    const before = await balanceOf(to);
    await send(
      rollup,
      collect(admin.publicKey, fees.spot[NUSD].available),
      admin,
    );
    expect((await balanceOf(to)) - before).to.equal(fees.spot[NUSD].available);
    expect(fees.spot[NUSD].available > 0n).to.equal(true);

    expect(
      await refusal(
        send(
          rollup,
          instructions.moveFeesToInsurance(stranger.publicKey, 1n),
          stranger,
        ),
      ),
    ).to.include("NotAdmin");
    await send(
      rollup,
      instructions.moveFeesToInsurance(admin.publicKey, fees.collateral),
      admin,
    );
    const ledger = await ledgerThroughThePort();
    expect(ledger.seats[FEE_SEAT].collateral).to.equal(0n);
    expect(ledger.seats[INSURANCE_SEAT].collateral).to.equal(fees.collateral);
    expect(fees.collateral > 0n).to.equal(true);
    await custodyMatchesLedger();
  });

  it("take insurance funding only from the admin, out of the admin's own token account into custody", async () => {
    const amount = 1_000n;
    const from = await funded(admin, mints.nUSD, amount, mintTo);
    const fund = (by: Keypair, source: PublicKey) =>
      send(
        rollup,
        instructions.fundInsurance(by.publicKey, source, mints.nUSD, amount),
        by,
      );
    expect(await refusal(fund(stranger, from))).to.include("NotAdmin");
    expect(
      await refusal(fund(admin, tokenAccount(carol, mints.nUSD))),
    ).to.include("WrongTokenAccountOwner");
    const before = await ledgerThroughThePort();
    const custody = await balanceOf(addresses.custody(mints.nUSD));
    await fund(admin, from);
    const after = await ledgerThroughThePort();
    expect(
      after.seats[INSURANCE_SEAT].collateral -
        before.seats[INSURANCE_SEAT].collateral,
    ).to.equal(amount);
    expect((await balanceOf(addresses.custody(mints.nUSD))) - custody).to.equal(
      amount,
    );
    expect(await balanceOf(from)).to.equal(0n);
    await custodyMatchesLedger();
  });

  it("cover a shortfall for anyone who asks, and change nothing for a seat that owes nothing", async () => {
    const before = await ledgerThroughThePort();
    await send(rollup, instructions.coverShortfall(PERP, bob.seat), stranger);
    const after = await ledgerThroughThePort();
    expect(after.seats[bob.seat]).to.deep.equal(before.seats[bob.seat]);
    expect(after.seats[INSURANCE_SEAT]).to.deep.equal(
      before.seats[INSURANCE_SEAT],
    );
    await custodyMatchesLedger();
  });
});

describe("margin at the fill, caps, fee shares and bad debt", () => {
  const PRICE = 136_000n;
  let dave: Trader;
  let erin: Trader;
  let frank: Trader;

  /** `feePayer` differs when the same limits are set twice inside one blockhash. */
  const perpLimits = (over: Partial<MarketLimits>, feePayer = admin) =>
    send(
      rollup,
      instructions.updateMarket(admin.publicKey, PERP, limits(over)),
      feePayer,
      feePayer === admin ? [] : [admin],
    );
  const rests = async (trader: Trader, price: bigint, size: bigint) => {
    const placed = await trader.client.placeOrder(
      PERP,
      order(SIDE.ask, ORDER_TYPE.postOnly, price, size),
      { riskMarkets: [PERP] },
    );
    expect(placed.outcome === "placed" && placed.result.status).to.equal(
      RESULT_STATUS.rested,
    );
  };
  const buys = async (trader: Trader, price: bigint, size: bigint) => {
    const placed = await trader.client.placeOrder(
      PERP,
      order(SIDE.bid, ORDER_TYPE.limit, price, size),
      { riskMarkets: [PERP] },
    );
    if (placed.outcome !== "placed") throw new Error("the bid did not land");
    return placed.result;
  };
  const seat = async (trader: Trader) =>
    (await ledgerThroughThePort()).seats[trader.seat];
  const perp = async () =>
    decodeMarket((await anonymous.getAccountInfo(addresses.market(PERP)))!.data)
      .params;

  before(async () => {
    dave = await openedTrader("dave");
    erin = await openedTrader("erin");
    frank = await openedTrader("frank");
    await fundedWith(dave, mints.nUSD, 40n * USD);
    await fundedWith(erin, mints.nUSD, 100n * USD);
    await fundedWith(frank, mints.nUSD, 15n * USD);
    await deposited(dave, mints.nUSD, NUSD, 20n * USD);
    await deposited(erin, mints.nUSD, NUSD, 100n * USD, true);
    await deposited(frank, mints.nUSD, NUSD, 15n * USD, true);
  });

  it("moves value between the spot balance and collateral in both directions, and not when it would break margin", async () => {
    const transfer = (toCollateral: boolean, amount: bigint) =>
      dave.client.transferBetweenBalances(toCollateral, NUSD, amount, [PERP]);
    const custody = await balanceOf(addresses.custody(mints.nUSD));
    const posted = await transfer(true, 20n * USD);
    expect(posted?.filled).to.equal(20n * USD);
    expect((await seat(dave)).collateral).to.equal(20n * USD);
    expect((await seat(dave)).spot[NUSD].available).to.equal(0n);
    const out = await transfer(false, 5n * USD);
    expect(out?.filled).to.equal(5n * USD);
    expect((await seat(dave)).collateral).to.equal(15n * USD);
    expect((await seat(dave)).spot[NUSD].available).to.equal(5n * USD);
    expect(
      (await dave.client.view()).snapshot.seat.spot[NUSD].available,
    ).to.equal(5n * USD);
    expect(await balanceOf(addresses.custody(mints.nUSD))).to.equal(custody);

    await rests(erin, PRICE, 1_000n);
    expect((await buys(dave, PRICE, 1_000n)).filled).to.equal(1_000n);
    const before = await seat(dave);
    const breaking = (use: OrderKeyUse, id: bigint, expiresAt: bigint) =>
      instructions.transferBetweenBalances(
        call(dave, use, PERP, id, expiresAt),
        false,
        NUSD,
        2n * USD,
      );
    expect(await refusal(attempted(dave, breaking))).to.include(
      "InsufficientMargin",
    );
    expect(await seat(dave)).to.deep.equal(before);
    await custodyMatchesLedger();
  });

  it("writes a fill the fill check refuses as an outcome in the taker's view, with nothing traded", async () => {
    const above = PRICE + 4_000n;
    await rests(erin, above, 1_000n);
    const before = await seat(frank);
    const refused = await buys(frank, above, 1_000n);
    expect(refused.status).to.equal(RESULT_STATUS.remainderCancelledFillCheck);
    expect(refused.filled).to.equal(0n);
    expect(refused.cancelled).to.equal(1_000n);
    const after = await seat(frank);
    expect(after.collateral).to.equal(before.collateral);
    expect(after.perp[PERP].base).to.equal(0n);
    expect(after.perp[PERP].quote).to.equal(0n);
    expect((await erin.client.cancelAll(PERP))?.cancelled).to.equal(1n);
    await custodyMatchesLedger();
  });

  it("stops matching at the open interest cap and cancels the remainder", async () => {
    const openInterest = async () =>
      decodeStats((await anonymous.getAccountInfo(addresses.stats))!.data)
        .openInterest[PERP];
    const cap = (await openInterest()) + 10n;
    await perpLimits({ openInterestCap: cap });
    await rests(erin, PRICE, 10n);
    await rests(erin, PRICE + 100n, 20n);
    const capped = await buys(frank, PRICE + 100n, 30n);
    expect(capped.status).to.equal(RESULT_STATUS.remainderCancelledFillCheck);
    expect(capped.filled).to.equal(10n);
    expect(capped.cancelled).to.equal(20n);
    expect(await openInterest()).to.equal(cap);
    expect((await erin.client.cancelAll(PERP))?.cancelled).to.equal(1n);
    await perpLimits({});
    await custodyMatchesLedger();
  });

  it("sends the set share of a taker fee to the insurance seat and the rest to the fee seat", async () => {
    await perpLimits({ feeInsuranceShareBps: 5_000 });
    const before = await ledgerThroughThePort();
    await rests(erin, PRICE, 100n);
    const bought = await buys(frank, PRICE, 100n);
    expect(bought.fee).to.equal(6_800n);
    const after = await ledgerThroughThePort();
    expect(
      after.seats[INSURANCE_SEAT].collateral -
        before.seats[INSURANCE_SEAT].collateral,
    ).to.equal(3_400n);
    expect(
      after.seats[FEE_SEAT].collateral - before.seats[FEE_SEAT].collateral,
    ).to.equal(3_400n);
    await perpLimits({}, gate);
    await custodyMatchesLedger();
  });

  it("lowers a recorded shortfall to what the debtor still owes once it repays, for anyone who asks, and never raises it", async () => {
    const reset = async (price: bigint) =>
      send(
        rollup,
        instructions.resetPrice(
          admin.publicKey,
          PERP,
          price,
          BigInt(await rollupNow()),
        ),
        admin,
      );
    const reconcile = (by: Keypair) =>
      send(rollup, instructions.reconcileShortfall([PERP]), by);
    const repays = (amount: bigint) =>
      deposited(dave, mints.nUSD, NUSD, amount, true);

    await reset(110_000n);
    const insurance = (await ledgerThroughThePort()).seats[INSURANCE_SEAT]
      .collateral;
    const done = await erin.client.liquidate(
      PERP,
      dave.seat,
      1_000n,
      200_000n,
      [PERP],
    );
    expect(done?.status).to.equal(LIQUIDATION_STATUS.liquidated);
    expect(done?.filled).to.equal(1_000n);
    expect(done?.fee).to.equal(insurance);
    const owed = done?.rested ?? 0n;
    expect(owed > 10n * USD).to.equal(true);
    expect((await seat(dave)).perp[PERP].base).to.equal(0n);
    expect((await seat(dave)).collateral).to.equal(-owed);
    expect((await perp()).uncoveredShortfall).to.equal(owed);
    expect((await perp()).status).to.equal(MARKET_STATUS.reduceOnly);
    await perpLimits({}, oracle);
    expect(
      (await perp()).status,
      "a limits update while a shortfall is recorded",
    ).to.equal(MARKET_STATUS.reduceOnly);
    expect(
      await refusal(
        send(rollup, instructions.resumeMarket(admin.publicKey, PERP), admin),
      ),
    ).to.include("ShortfallOutstanding");

    await reconcile(stranger);
    expect((await perp()).uncoveredShortfall).to.equal(owed);
    await repays(5n * USD);
    await reconcile(oracle);
    expect((await perp()).uncoveredShortfall).to.equal(owed - 5n * USD);
    await repays(owed - 5n * USD);
    await reconcile(gate);
    expect((await perp()).uncoveredShortfall).to.equal(0n);
    expect((await seat(dave)).collateral).to.equal(0n);

    await reset(PRICE);
    await send(rollup, instructions.resumeMarket(admin.publicKey, PERP), admin);
    expect((await perp()).status).to.equal(MARKET_STATUS.active);
    await custodyMatchesLedger();
  });
});

describe("authority", () => {
  it("refuses every instruction for the wrong signer", async () => {
    const forger = alice.keys.take();
    const forged = {
      ...call(alice, forger, SPOT, 11n, BigInt(nowSeconds() + 5)),
      owner: bob.owner.publicKey,
    };
    const probe = alice.keys.take();
    const orderKey = probe.keypair.publicKey;
    const table: [string, TransactionInstruction, Keypair, string][] = [
      [
        "update_exchange",
        instructions.updateExchange(stranger.publicKey, settings()),
        stranger,
        "NotAdmin",
      ],
      [
        "set_paused",
        instructions.setPaused(stranger.publicKey, true),
        stranger,
        "NotAdmin",
      ],
      [
        "create_market",
        instructions.createMarket(stranger.publicKey, 5, spotMarket()),
        stranger,
        "NotAdmin",
      ],
      [
        "finalize_market",
        instructions.finalizeMarket(stranger.publicKey, UNFINISHED),
        stranger,
        "NotAdmin",
      ],
      [
        "finalize_ledger",
        instructions.finalizeLedger(stranger.publicKey),
        stranger,
        "NotAdmin",
      ],
      [
        "create_ledger",
        instructions.createLedger(stranger.publicKey),
        stranger,
        "NotAdmin",
      ],
      [
        "undelegate_exchange",
        instructions.undelegateExchange(stranger.publicKey),
        stranger,
        "NotAdmin",
      ],
      [
        "set_order_keys by a stranger with the owner's view",
        {
          ...instructions.setOrderKeys(
            stranger.publicKey,
            alice.keys.publicKeys,
          ),
          keys: instructions
            .setOrderKeys(alice.owner.publicKey, alice.keys.publicKeys)
            .keys.map((meta, at) =>
              at === 0 ? { ...meta, pubkey: stranger.publicKey } : meta,
            ),
        } as TransactionInstruction,
        stranger,
        "ConstraintSeeds",
      ],
      [
        "close_trader by a stranger with the owner's view",
        {
          ...instructions.closeTrader(alice.owner.publicKey),
          keys: instructions
            .closeTrader(alice.owner.publicKey)
            .keys.map((meta, at) =>
              at === 0 ? { ...meta, pubkey: stranger.publicKey } : meta,
            ),
        } as TransactionInstruction,
        stranger,
        "ConstraintSeeds",
      ],
      [
        "withdraw by an order key",
        {
          ...instructions.withdraw(
            alice.owner.publicKey,
            tokenAccount(alice, mints.nUSD),
            mints.nUSD,
            { spot: NUSD },
            1n,
            [PERP],
          ),
          keys: instructions
            .withdraw(
              alice.owner.publicKey,
              tokenAccount(alice, mints.nUSD),
              mints.nUSD,
              { spot: NUSD },
              1n,
              [PERP],
            )
            .keys.map((meta, at) =>
              at === 0 ? { ...meta, pubkey: orderKey } : meta,
            ),
        } as TransactionInstruction,
        probe.keypair,
        "ConstraintSeeds",
      ],
      [
        "place_order with another owner's view",
        instructions.placeOrder(
          forged,
          order(SIDE.bid, ORDER_TYPE.immediateOrCancel, MARK, 10n),
        ),
        forger.keypair,
        "NotOrderKey",
      ],
      [
        "liquidate by a non-key",
        instructions.liquidate(
          {
            ...forged,
            owner: carol.owner.publicKey,
            orderKey: stranger.publicKey,
          },
          bob.seat,
          1n,
          1n,
        ),
        stranger,
        "NotOrderKey",
      ],
      [
        "cancel_all by the owner",
        instructions.cancelAll(
          {
            ...forged,
            owner: alice.owner.publicKey,
            orderKey: alice.owner.publicKey,
          },
          1,
        ),
        alice.owner,
        "NotOrderKey",
      ],
    ];
    for (const [what, instruction, signer, expected] of table) {
      expect(await refusal(send(rollup, instruction, signer)), what).to.include(
        expected,
      );
    }
    const view = await alice.client.view();
    alice.keys.release(forger, view);
    alice.keys.release(probe, view);
  });

  it("refuses to impersonate an owner through a view at the wrong derivation", async () => {
    const impostor = instructions.withdraw(
      stranger.publicKey,
      tokenAccount(alice, mints.nUSD),
      mints.nUSD,
      { spot: NUSD },
      1n,
      [PERP],
    );
    impostor.keys[3] = {
      ...impostor.keys[3],
      pubkey: addresses.view(alice.owner.publicKey),
    };
    expect(await refusal(send(rollup, impostor, stranger))).to.include(
      "ConstraintSeeds",
    );
  });

  it("refuses orders and liquidations while paused, by the admin's hand only, and still cancels", async () => {
    await send(rollup, instructions.setPaused(admin.publicKey, true), admin);
    const paused = (use: OrderKeyUse, id: bigint, expiresAt: bigint) =>
      instructions.placeOrder(
        call(alice, use, SPOT, id, expiresAt),
        order(SIDE.bid, ORDER_TYPE.limit, MARK - 1_000n, 1n),
      );
    expect(await refusal(attempted(alice, paused))).to.include(
      "ExchangePaused",
    );
    expect((await alice.client.cancelAll(SPOT))?.cancelled).to.equal(0n);
    await send(rollup, instructions.setPaused(admin.publicKey, false), admin);
  });

  handsOverItsAdminRole(
    () => rollup,
    (by) => [
      instructions.setPaused(by, true),
      instructions.proposeAdmin(by, by),
      instructions.updateMarket(by, SPOT, limits()),
    ],
  );

  it("replaces all four keys at the owner's word, and closes an empty seat with the rent back", async () => {
    const trader = await openedTrader("dave");
    const fresh = OrderKeyManager.fresh(randomSecret32());
    await send(
      rollup,
      instructions.setOrderKeys(trader.owner.publicKey, fresh.publicKeys),
      trader.owner,
    );
    expect(
      (await trader.client.view()).orderKeys.map((key) => key.toBase58()),
    ).to.deep.equal(fresh.publicKeys.map((key) => key.toBase58()));
    const before = await exchangeBalance();
    await send(
      rollup,
      instructions.closeTrader(trader.owner.publicKey),
      trader.owner,
    );
    expect((await exchangeBalance()) - before).to.equal(
      rollupRent(ACCOUNT_LEN.view) + rollupRent(35 + 2 * 33),
    );
    expect(
      await rollup.getAccountInfo(addresses.view(trader.owner.publicKey)),
    ).to.equal(null);
    expect((await ledgerThroughThePort()).seats[trader.seat].status).to.equal(
      0,
    );
    const closeAlice = instructions.closeTrader(alice.owner.publicKey);
    expect(await refusal(send(rollup, closeAlice, alice.owner))).to.include(
      "SeatNotEmpty",
    );
  });

  it("opens no more seats in a day than the exchange allows, and lets the admin close a seat nobody ever used", async () => {
    const cap = (maxSeatsPerDay: number) =>
      send(
        rollup,
        instructions.updateExchange(admin.publicKey, {
          ...settings(),
          maxSeatsPerDay,
        }),
        admin,
      );
    const today = await exchangeOn(rollup);
    expect(today.seatsDay).to.equal(BigInt(await rollupNow()) / 86_400n);
    expect(today.seatsOpened > 0).to.equal(true);

    await cap(today.seatsOpened + 1);
    const idle = await openedTrader("idle");
    const refused = Keypair.generate();
    expect(
      await refusal(
        send(
          rollup,
          instructions.openTrader(
            gate.publicKey,
            refused.publicKey,
            OrderKeyManager.fresh(randomSecret32()).publicKeys,
          ),
          gate,
          [refused],
        ),
      ),
    ).to.include("DailySeatLimitReached");
    expect(
      await rollup.getAccountInfo(addresses.view(refused.publicKey)),
    ).to.equal(null);
    await cap(SEATS_PER_DAY);

    const close = (by: Keypair, owner: PublicKey) =>
      send(rollup, instructions.closeUnusedTrader(by.publicKey, owner), by);
    expect(await refusal(close(stranger, idle.owner.publicKey))).to.include(
      "NotAdmin",
    );
    expect(await refusal(close(admin, alice.owner.publicKey))).to.include(
      "SeatUsed",
    );
    const used = await openedTrader("used");
    await fundedWith(used, mints.nUSD, 2n);
    await deposited(used, mints.nUSD, NUSD, 2n);
    await send(
      rollup,
      instructions.withdraw(
        used.owner.publicKey,
        tokenAccount(used, mints.nUSD),
        mints.nUSD,
        { spot: NUSD },
        2n,
        [PERP],
      ),
      used.owner,
    );
    expect(await refusal(close(admin, used.owner.publicKey))).to.include(
      "SeatUsed",
    );

    const before = await exchangeBalance();
    await close(admin, idle.owner.publicKey);
    expect((await exchangeBalance()) - before).to.equal(
      rollupRent(ACCOUNT_LEN.view) + rollupRent(35 + 2 * 33),
    );
    expect(
      await rollup.getAccountInfo(addresses.view(idle.owner.publicKey)),
    ).to.equal(null);
    expect((await ledgerThroughThePort()).seats[idle.seat].status).to.equal(0);
    await custodyMatchesLedger();
  });
});

describe("latency, measured", () => {
  it("prints the time from send to the result in the view over 300 orders", async () => {
    const samples: number[] = [];
    for (let nth = 0; nth < 300; nth += 1) {
      const started = performance.now();
      const placed = await alice.client.placeOrder(
        SPOT,
        order(SIDE.bid, ORDER_TYPE.immediateOrCancel, MARK - 5_000n, 10n),
        { pollMs: 1 },
      );
      if (placed.outcome !== "placed") throw new Error(`order ${nth} expired`);
      samples.push(performance.now() - started);
    }
    console.log(
      `      ms from send to the result in the view, 300 orders: ${JSON.stringify(summary(samples))}`,
    );
    expect(samples).to.have.length(300);
    const view = await alice.client.view();
    expect(view.results.length).to.equal(16);
  });
});

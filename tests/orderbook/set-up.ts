import { expect } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import {
  delegateEphemeralAtaIx,
  deriveEphemeralAta,
  initEphemeralAtaIx,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  ACCOUNT_LEN,
  GROWTH_STEP,
  GROW_KIND,
  INSURANCE_SEAT,
  decodePriceFeed,
  growToFullSize,
  instructionData,
  setupLedger,
  setupMarket,
  type CustodyVisibility,
} from "../../sdk/dist/index.js";
import {
  createMint,
  ensureCustody,
  fundRentPda,
  registeredToken,
} from "../../ops/tokens";
import {
  PROGRAM_ID,
  VALIDATOR,
  addresses,
  admin,
  anonymous,
  inPublic,
  instructions,
  publicMarket,
  readingAs,
  refusal,
  rollup,
  rollupNow,
  send,
  solana,
  throughThePort,
  until,
  viewThroughThePort,
} from "../support";
import {
  MARK,
  NSOL,
  NUSD,
  OPEN,
  PERP,
  SEATS_PER_DAY,
  SPOT,
  TINY,
  UNFINISHED,
  UNREGISTERED,
  VIA_FILTER,
  exchangeOn,
  gate,
  limits,
  mints,
  newOrderKeys,
  oracle,
  perpMarket,
  refuses,
  settings,
  spotMarket,
  stranger,
} from "./world";

const published = async (marketId: number) =>
  send(
    rollup,
    instructions.publishPrice(
      oracle.publicKey,
      marketId,
      MARK,
      BigInt(await rollupNow()),
    ),
    oracle,
  );

describe("set-up inside the rollup", () => {
  before(async () => {
    await fundRentPda(solana, admin);
    mints.nUSD = await createMint(solana, admin, 6);
    mints.nSOL = await createMint(solana, admin, 9);
  });

  it("registers a token only by the admin, and only once its custody account exists in the rollup", async () => {
    await refuses(
      send(
        rollup,
        instructions.registerToken(admin.publicKey, NUSD, mints.nUSD, "sealed"),
        admin,
      ),
      "WrongTokenProgram",
    );
    for (const [index, mint] of [
      [NUSD, mints.nUSD],
      [NSOL, mints.nSOL],
    ] as const) {
      await ensureCustody(solana, admin, addresses, mint, VALIDATOR);
      await refuses(
        send(
          rollup,
          instructions.registerToken(stranger.publicKey, index, mint, "sealed"),
          stranger,
        ),
        "NotAdmin",
      );
      await registeredToken(rollup, instructions, admin, index, mint);
    }
    const exchange = await exchangeOn(rollup);
    expect(exchange.tokens[NUSD].mint.equals(mints.nUSD)).to.equal(true);
    expect(
      exchange.tokens[NSOL].custody.equals(addresses.custody(mints.nSOL)),
    ).to.equal(true);
  });

  it("registers a token only when its custody balance has its own private permission that nobody reads through", async () => {
    mints.open = await createMint(solana, admin, 6);
    const custody = addresses.custody(mints.open);
    const balance = deriveEphemeralAta(
      addresses.custodyAuthority,
      mints.open,
    )[0];
    await send(
      solana,
      [
        createAssociatedTokenAccountIdempotentInstruction(
          admin.publicKey,
          custody,
          addresses.custodyAuthority,
          mints.open,
        ),
        initEphemeralAtaIx(
          balance,
          addresses.custodyAuthority,
          mints.open,
          admin.publicKey,
        ),
        delegateEphemeralAtaIx(admin.publicKey, balance, VALIDATOR),
      ],
      admin,
    );
    await until(() => rollup.getAccountInfo(custody), "the open custody");
    const registerSealed = () =>
      instructions.registerToken(admin.publicKey, OPEN, mints.open, "sealed");
    await refuses(
      send(rollup, registerSealed(), admin),
      "CustodyNotPrivate",
      "a custody balance with no permission",
    );

    const borrowed = registerSealed();
    borrowed.keys[4] = {
      ...borrowed.keys[4],
      pubkey: addresses.custodyPermission(mints.nUSD),
    };
    await refuses(
      send(rollup, borrowed, admin),
      "WrongDerivation",
      "the permission of another custody balance",
    );

    expect((await exchangeOn(rollup)).tokens[OPEN].mint.toBase58()).to.equal(
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

  it("registers a public custody only as an explicit choice, only with no permission at all, and never changes the choice", async () => {
    const register = (
      index: number,
      mint: PublicKey,
      visibility: CustodyVisibility,
    ) =>
      send(
        rollup,
        instructions.registerToken(admin.publicKey, index, mint, visibility),
        admin,
      );
    await refuses(
      register(NUSD, mints.nUSD, "public"),
      "CustodyNotPublic",
      "a sealed token registered again as public",
    );
    const unused = await createMint(solana, admin, 6);
    await ensureCustody(solana, admin, addresses, unused, VALIDATOR);
    const withPermission = await until(async () => {
      const refused = await refusal(register(UNREGISTERED, unused, "public"));
      return !refused.includes("WrongTokenProgram") && refused;
    }, "the custody with a permission to reach the rollup");
    expect(withPermission, "a custody with a permission, as public").to.include(
      "CustodyNotPublic",
    );

    await register(OPEN, mints.open, "public");
    await refuses(
      register(OPEN, mints.open, "sealed"),
      "CustodyNotPrivate",
      "a public token registered again as sealed",
    );
    const { tokens } = await exchangeOn(rollup);
    expect(tokens.map((token) => token.custodyVisibility)).to.deep.equal([
      "sealed",
      "sealed",
      "public",
      "sealed",
    ]);
    expect(tokens[OPEN].mint.equals(mints.open)).to.equal(true);
    expect(tokens[UNREGISTERED].mint.equals(PublicKey.default)).to.equal(true);
    expect(
      await anonymous.getAccountInfo(addresses.custody(mints.open)),
      "a public custody, read by anyone",
    ).to.not.equal(null);
  });

  it("keeps the collateral token it was created with, whatever an update asks for", async () => {
    const carryingAToken = instructions.updateExchange(
      admin.publicKey,
      settings(),
    );
    carryingAToken.data = instructionData("update_exchange")
      .pubkey(gate.publicKey)
      .pubkey(oracle.publicKey)
      .u8(settings().maxSteps)
      .u8(NSOL)
      .build();
    await refuses(
      send(rollup, carryingAToken, admin),
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
    await refuses(send(rollup, fromAnotherCustody, admin), "WrongCustody");
  });

  it("refuses to use the ledger before it has its full size, and then until it is finalised", async () => {
    const keys = newOrderKeys();
    const owner = Keypair.generate();
    const open = () =>
      send(
        rollup,
        instructions.openTrader(gate.publicKey, owner.publicKey, keys),
        gate,
        [owner],
      );
    const ledgerLength = async () =>
      (await throughThePort(addresses.ledger)).length;
    await send(rollup, instructions.createLedger(admin.publicKey), admin);
    expect(await ledgerLength()).to.equal(GROWTH_STEP);
    await refuses(open(), "WrongSize");
    await growToFullSize(
      rollup,
      admin,
      GROW_KIND.ledger,
      0,
      addresses.ledger,
      ACCOUNT_LEN.ledger,
    );
    expect(await ledgerLength()).to.equal(ACCOUNT_LEN.ledger);
    await refuses(open(), "NotReady");
    await setupLedger(rollup, admin);
    await open();
    expect((await viewThroughThePort(owner.publicKey)).seat).to.equal(
      INSURANCE_SEAT + 1,
    );
  });

  it("refuses to use a market before it is finalised, and serves it to anyone afterwards", async () => {
    await send(
      rollup,
      instructions.createMarket(admin.publicKey, SPOT, spotMarket()),
      admin,
    );
    await refuses(published(SPOT), "NotReady");
    await setupMarket(rollup, admin, SPOT, spotMarket());
    await published(SPOT);
    const market = await publicMarket(SPOT);
    expect(market.params.tick).to.equal(100n);
    expect(market.baseSymbol).to.equal("NSOL");
    await setupMarket(rollup, admin, PERP, perpMarket());
    await setupMarket(rollup, admin, TINY, spotMarket(2));
    for (const marketId of [PERP, TINY]) await published(marketId);
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
    await refuses(
      send(
        rollup,
        grow(stranger.publicKey, book, UNFINISHED, 2 * GROWTH_STEP),
        stranger,
      ),
      "NotAdmin",
    );
    await refuses(
      send(
        rollup,
        grow(admin.publicKey, book, UNFINISHED, 3 * GROWTH_STEP),
        admin,
      ),
      "InvalidGrowth",
    );
    await refuses(
      send(
        rollup,
        grow(admin.publicKey, addresses.book(SPOT), SPOT, ACCOUNT_LEN.book),
        admin,
      ),
      "AlreadyReady",
    );
    await send(
      rollup,
      grow(admin.publicKey, book, UNFINISHED, 2 * GROWTH_STEP),
      admin,
    );
    expect((await throughThePort(book)).length).to.equal(2 * GROWTH_STEP);
  });

  it("publishes a price only through the oracle, never backwards in time or beyond the move limit", async () => {
    const { publishTime } = decodePriceFeed(
      await inPublic(addresses.priceFeed(SPOT)),
    );
    await until(
      async () => (await rollupNow()) > Number(publishTime),
      "the rollup clock to pass the last publish",
      30_000,
      50,
    );
    const now = BigInt(await rollupNow());
    await refuses(
      send(
        rollup,
        instructions.publishPrice(stranger.publicKey, SPOT, MARK, now),
        stranger,
      ),
      "NotOracle",
    );
    await refuses(
      send(
        rollup,
        instructions.publishPrice(oracle.publicKey, SPOT, MARK, now - 100n),
        oracle,
      ),
      "PriceTimeWentBackwards",
    );
    await refuses(
      send(
        rollup,
        instructions.publishPrice(oracle.publicKey, SPOT, MARK * 2n, now),
        oracle,
      ),
      "PriceMoveTooLarge",
    );
    await refuses(
      send(
        rollup,
        instructions.resetPrice(stranger.publicKey, SPOT, MARK, now),
        stranger,
      ),
      "NotAdmin",
    );
  });

  it("changes a market's limits only by the admin and only within the bounds", async () => {
    const update = (by: Keypair, marketId: number, to = limits()) =>
      send(rollup, instructions.updateMarket(by.publicKey, marketId, to), by);
    await refuses(update(stranger, SPOT), "NotAdmin");
    await refuses(
      update(admin, SPOT, limits({ bandBps: 0 })),
      "InvalidSettings",
    );
    await refuses(
      update(admin, PERP, limits({ mmBps: 2_000 })),
      "InvalidMarketParams",
    );
    await update(admin, SPOT, spotMarket().limits);
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
    expect((await throughThePort(book)).length).to.equal(ACCOUNT_LEN.book);
    expect((await publicMarket(VIA_FILTER)).header.ready).to.equal(true);
    await setupMarket(asAdmin, admin, VIA_FILTER, spotMarket(), PROGRAM_ID);
  });
});

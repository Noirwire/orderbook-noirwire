import { expect } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import {
  delegateEphemeralAtaIx,
  initEphemeralAtaIx,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  ACCOUNT_LEN,
  GROWTH_STEP,
  GROW_KIND,
  INSURANCE_SEAT,
  LEGACY_LEDGER_LEN,
  MARKET_STATUS,
  MIN_SEATS,
  NO_SEAT,
  decodePriceFeed,
  growToFullSize,
  instructionData,
  setupLedger,
  setupMarket,
  type CustodyVisibility,
} from "../../sdk/dist/index.js";
import { MAINNET_PRICE_FEEDS } from "../../ops/deployment";
import { runsOnEarlierBuild } from "../legacy";
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
  ledgerThroughThePort,
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
  BOUND,
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
  USD,
  VIA_FILTER,
  boundMarket,
  custodyOf,
  exchangeOn,
  funded,
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

/** The admin's reset, the only way a feed gets its first price. */
const seed = async (marketId: number) =>
  instructions.resetPrice(
    admin.publicKey,
    marketId,
    MARK,
    BigInt(await rollupNow()),
  );

/** A first price and the market opened on it, in one transaction. */
const seeded = async (marketId: number, perpMarketIds: number[]) =>
  send(
    rollup,
    [
      await seed(marketId),
      instructions.resumeMarket(admin.publicKey, marketId, perpMarketIds),
    ],
    admin,
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
        instructions.registerToken(
          admin.publicKey,
          NUSD,
          custodyOf(mints.nUSD),
          "sealed",
        ),
        admin,
      ),
      "WrongTokenProgram",
    );
    for (const [index, mint] of [
      [NUSD, mints.nUSD],
      [NSOL, mints.nSOL],
    ] as const) {
      await ensureCustody(solana, admin, addresses, custodyOf(mint), VALIDATOR);
      await refuses(
        send(
          rollup,
          instructions.registerToken(
            stranger.publicKey,
            index,
            custodyOf(mint),
            "sealed",
          ),
          stranger,
        ),
        "NotAdmin",
      );
      await registeredToken(
        rollup,
        instructions,
        admin,
        index,
        custodyOf(mint),
      );
    }
    const exchange = await exchangeOn(rollup);
    expect(exchange.tokens[NUSD].mint.equals(mints.nUSD)).to.equal(true);
    expect(exchange.tokens[NSOL].custodyNonce).to.equal(
      custodyOf(mints.nSOL).custodyNonce,
    );
    expect(
      exchange.tokens[NSOL].custody.equals(
        addresses.custody(custodyOf(mints.nSOL)),
      ),
    ).to.equal(true);
  });

  it("keeps a registered token's custody nonce, whatever custody a second registration names", async () => {
    const another = {
      mint: mints.nUSD,
      custodyNonce: custodyOf(mints.nUSD).custodyNonce ^ 1n,
    };
    await ensureCustody(solana, admin, addresses, another, VALIDATOR);
    await refuses(
      registeredToken(rollup, instructions, admin, NUSD, another),
      "InvalidSettings",
    );
    expect((await exchangeOn(rollup)).tokens[NUSD].custodyNonce).to.equal(
      custodyOf(mints.nUSD).custodyNonce,
    );
    await refuses(
      registeredToken(rollup, instructions, admin, UNREGISTERED, another),
      "WrongCustody",
      "the collateral mint at another index, kept in another custody account",
    );
    expect(
      (await exchangeOn(rollup)).tokens[UNREGISTERED].mint.equals(
        PublicKey.default,
      ),
    ).to.equal(true);
  });

  it("registers a token only when its custody balance has its own private permission that nobody reads through", async () => {
    mints.open = await createMint(solana, admin, 6);
    const open = custodyOf(mints.open);
    const authority = addresses.custodyAuthority(open.custodyNonce);
    const custody = addresses.custody(open);
    const balance = addresses.custodyBalance(open);
    await send(
      solana,
      [
        createAssociatedTokenAccountIdempotentInstruction(
          admin.publicKey,
          custody,
          authority,
          mints.open,
        ),
        initEphemeralAtaIx(balance, authority, mints.open, admin.publicKey),
        delegateEphemeralAtaIx(admin.publicKey, balance, VALIDATOR),
      ],
      admin,
    );
    await until(() => rollup.getAccountInfo(custody), "the open custody");
    const registerSealed = () =>
      instructions.registerToken(admin.publicKey, OPEN, open, "sealed");
    await refuses(
      send(rollup, registerSealed(), admin),
      "CustodyNotPrivate",
      "a custody balance with no permission",
    );

    const borrowed = registerSealed();
    borrowed.keys[4] = {
      ...borrowed.keys[4],
      pubkey: addresses.custodyPermission(custodyOf(mints.nUSD)),
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
        expect(
          await reader.getAccountInfo(addresses.custody(custodyOf(mint))),
        ).to.equal(null);
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
        instructions.registerToken(
          admin.publicKey,
          index,
          custodyOf(mint),
          visibility,
        ),
        admin,
      );
    await refuses(
      register(NUSD, mints.nUSD, "public"),
      "CustodyNotPublic",
      "a sealed token registered again as public",
    );
    const unused = await createMint(solana, admin, 6);
    await ensureCustody(solana, admin, addresses, custodyOf(unused), VALIDATOR);
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
      await anonymous.getAccountInfo(addresses.custody(custodyOf(mints.open))),
      "a public custody, read by anyone",
    ).to.not.equal(null);
  });

  (runsOnEarlierBuild ? it : it.skip)(
    "raises the earlier build's custody caps, which start at zero and take no deposit",
    async () => {
      const cap = 1_000_000_000n * USD;
      for (const index of [NUSD, NSOL, OPEN]) {
        await send(
          rollup,
          instructions.setCustodyCap(admin.publicKey, index, cap),
          admin,
        );
      }
    },
  );

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
    const exchange = await exchangeOn(rollup);
    expect(exchange.collateralToken).to.equal(NUSD);
    expect(exchange.maxSeatsPerDay).to.equal(SEATS_PER_DAY);
    const fromAnotherCustody = instructions.collectFees(
      admin.publicKey,
      admin.publicKey,
      custodyOf(mints.nSOL),
      { collateral: true },
      1n,
      [],
    );
    await refuses(send(rollup, fromAnotherCustody, admin), "WrongCustody");
    const signedByAnotherAuthority = instructions.collectFees(
      admin.publicKey,
      admin.publicKey,
      custodyOf(mints.nUSD),
      { collateral: true },
      1n,
      [],
    );
    signedByAnotherAuthority.keys[3] = {
      ...signedByAnotherAuthority.keys[3],
      pubkey: addresses.custodyAuthority(custodyOf(mints.nSOL).custodyNonce),
    };
    await refuses(
      send(rollup, signedByAnotherAuthority, admin),
      "WrongDerivation",
    );
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
    const source = await funded(owner, mints.nUSD, 10n * USD);
    const takeSeat = () =>
      send(
        rollup,
        instructions.deposit(
          owner.publicKey,
          source,
          custodyOf(mints.nUSD),
          owner.publicKey,
          { collateral: true },
          3n * USD,
        ),
        owner,
      );
    const earlier = runsOnEarlierBuild;
    const fullLength = earlier ? LEGACY_LEDGER_LEN : ACCOUNT_LEN.ledger;
    const usesTheLedger = earlier ? open : takeSeat;
    const ledgerLength = async () =>
      (await throughThePort(addresses.ledger)).length;
    await send(rollup, instructions.createLedger(admin.publicKey), admin);
    expect(await ledgerLength()).to.equal(GROWTH_STEP);
    if (!earlier) {
      await open();
      expect(
        (await viewThroughThePort(owner.publicKey)).seat,
        "a view opens without touching the ledger",
      ).to.equal(NO_SEAT);
    }
    await refuses(usesTheLedger(), "WrongSize");
    await growToFullSize(
      rollup,
      admin,
      GROW_KIND.ledger,
      0,
      addresses.ledger,
      fullLength,
    );
    expect(await ledgerLength()).to.equal(fullLength);
    await refuses(usesTheLedger(), "NotReady");
    if (earlier) {
      await send(rollup, instructions.finalizeLedger(admin.publicKey), admin);
      await open();
    } else {
      await setupLedger(rollup, admin);
    }
    await takeSeat();
    const view = await viewThroughThePort(owner.publicKey);
    expect(view.seat).to.equal(INSURANCE_SEAT + 1);
    const ledger = await ledgerThroughThePort();
    expect(ledger.seats[view.seat].collateral).to.equal(3n * USD);
    expect(ledger.seats.length).to.equal(MIN_SEATS);
  });

  it("refuses to use a market before it is finalised, and serves it to anyone afterwards", async () => {
    await send(
      rollup,
      instructions.createMarket(admin.publicKey, SPOT, spotMarket()),
      admin,
    );
    await refuses(published(SPOT), "NotReady");
    await setupMarket(rollup, admin, SPOT, spotMarket());
    await refuses(
      published(SPOT),
      "FeedNotSeeded",
      "the oracle never sets a feed's first price",
    );
    await send(rollup, await seed(SPOT), admin);
    expect((await publicMarket(SPOT)).params.status).to.equal(
      MARKET_STATUS.reduceOnly,
    );
    await send(
      rollup,
      instructions.resumeMarket(admin.publicKey, SPOT, []),
      admin,
    );
    const market = await publicMarket(SPOT);
    expect(market.params.status).to.equal(MARKET_STATUS.active);
    expect(market.params.tick).to.equal(100n);
    expect(market.baseSymbol).to.equal("NSOL");
    await setupMarket(rollup, admin, PERP, perpMarket());
    await setupMarket(rollup, admin, TINY, spotMarket(2));
    for (const marketId of [PERP, TINY]) await seeded(marketId, [PERP]);
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
    const { acceptedAt } = decodePriceFeed(
      await inPublic(addresses.priceFeed(SPOT)),
    );
    await until(
      async () => (await rollupNow()) > Number(acceptedAt),
      "the rollup clock to pass the last accepted price",
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

  it("binds a market to its Pyth account, which no key can price over and no other account can sync", async () => {
    await setupMarket(rollup, admin, BOUND, boundMarket());
    const feed = decodePriceFeed(await inPublic(addresses.priceFeed(BOUND)));
    expect(feed.binding.account.toBase58()).to.equal(
      MAINNET_PRICE_FEEDS.solUsd.account.toBase58(),
    );
    expect(feed.price, "no mark until the first sync").to.equal(0n);
    const now = BigInt(await rollupNow());
    await refuses(
      send(
        rollup,
        instructions.publishPrice(oracle.publicKey, BOUND, MARK, now),
        oracle,
      ),
      "PriceSourceBound",
    );
    await refuses(
      send(
        rollup,
        instructions.resetPrice(admin.publicKey, BOUND, MARK, now),
        admin,
      ),
      "PriceSourceBound",
    );
    const lookalike = addresses.priceFeed(SPOT);
    await refuses(
      send(rollup, instructions.syncPrice(BOUND, lookalike), stranger),
      "WrongPriceAccount",
    );
    await refuses(
      send(
        rollup,
        instructions.syncPrice(SPOT, addresses.priceFeed(BOUND)),
        stranger,
      ),
      "WrongPriceAccount",
      "a market bound to nothing syncs from no account",
    );
    await refuses(
      send(rollup, instructions.syncQuote(lookalike), stranger),
      "WrongPriceAccount",
      "the USDC guard is bound to nothing here",
    );
    await refuses(
      send(
        rollup,
        instructions.setPriceSource(
          admin.publicKey,
          BOUND,
          MAINNET_PRICE_FEEDS.usdcUsd.feedId,
          -8,
        ),
        admin,
      ),
      "PriceSourceInUse",
      "only a paused market is rebound",
    );
    expect(
      decodePriceFeed(await inPublic(addresses.priceFeed(BOUND))),
      "a refused sync writes nothing",
    ).to.deep.equal(feed);
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

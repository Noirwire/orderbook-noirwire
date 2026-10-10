import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import { FEE_SEAT, INSURANCE_SEAT } from "../../sdk/dist/index.js";
import { minted, movedIntoRollup, tokenBalance } from "../../ops/tokens";
import {
  PROGRAM_ID,
  VALIDATOR,
  addresses,
  admin,
  anonymous,
  balanceOf,
  instructions,
  ledgerThroughThePort,
  readingAs,
  rollup,
  send,
  solana,
  viewThroughThePort,
} from "../support";
import {
  NSOL,
  NUSD,
  OPEN,
  PERP,
  SOL,
  SPOT,
  TRADER_RENT,
  UNREGISTERED,
  USD,
  cast,
  custodyMatchesLedger,
  deposited,
  exchangeBalance,
  funded,
  fundedWith,
  gate,
  mints,
  newOrderKeys,
  openedTrader,
  refuses,
  stranger,
  tokenAccount,
} from "./world";

describe("a trader", () => {
  it("gets a seat and a view with four order keys in one instruction, paid by the exchange", async () => {
    const before = await exchangeBalance();
    cast.alice = await openedTrader();
    const { alice } = cast;
    expect(before - (await exchangeBalance())).to.equal(TRADER_RENT);
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
    const keys = newOrderKeys();
    await refuses(
      send(
        rollup,
        instructions.openTrader(stranger.publicKey, owner.publicKey, keys),
        stranger,
        [owner],
      ),
      "GateMissing",
    );
    for (const invalid of [
      [owner.publicKey, ...keys.slice(1)],
      [keys[0], keys[0], keys[2], keys[3]],
    ]) {
      await refuses(
        send(
          rollup,
          instructions.openTrader(gate.publicKey, owner.publicKey, invalid),
          gate,
          [owner],
        ),
        "InvalidOrderKey",
      );
    }
    expect(
      await rollup.getAccountInfo(addresses.view(owner.publicKey)),
    ).to.equal(null);
  });

  it("reads its own view through the private endpoint, while a stranger, an anonymous caller and the owner read no ledger, no book and no other view", async () => {
    cast.bob = await openedTrader();
    cast.carol = await openedTrader();
    const { alice, bob } = cast;
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
    const { alice, bob, carol } = cast;
    await fundedWith(alice, mints.nUSD, 2_000n * USD);
    await fundedWith(bob, mints.nSOL, 10n * SOL);
    await fundedWith(bob, mints.nUSD, 200n * USD);
    await fundedWith(carol, mints.nUSD, 1_000n * USD);
    const custodyBefore = await balanceOf(addresses.custody(mints.nUSD));
    await deposited(alice, mints.nUSD, { spot: NUSD }, 1_000n * USD);
    await deposited(bob, mints.nSOL, { spot: NSOL }, 10n * SOL);
    await deposited(bob, mints.nUSD, { spot: NUSD }, 100n * USD);
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
    const { bob } = cast;
    const fromBobsSol = (
      mint = mints.nSOL,
      asset = { spot: NSOL },
      amount = 1n,
    ) =>
      send(
        rollup,
        instructions.deposit(
          bob.owner.publicKey,
          tokenAccount(bob, mints.nSOL),
          mint,
          bob.owner.publicKey,
          asset,
          amount,
        ),
        bob.owner,
      );
    await refuses(fromBobsSol(mints.nUSD, { spot: NUSD }), "WrongMint");
    await refuses(
      fromBobsSol(mints.nSOL, { spot: UNREGISTERED }),
      "UnknownToken",
    );
    await refuses(fromBobsSol(mints.nSOL, { spot: NSOL }, 0n), "ZeroAmount");
    await custodyMatchesLedger();
  });

  it("refuses a deposit into the fee seat or the insurance seat, which no view names", async () => {
    const { bob } = cast;
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
        await refuses(
          send(rollup, reserved, bob.owner),
          "AccountMissing",
          `seat ${seat}`,
        );
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
    const zoe = await openedTrader();
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

    await refuses(
      send(zoe.reader, deposit, zoe.owner),
      "Access denied",
      "a deposit through the local query filter",
    );
    await send(rollup, deposit, zoe.owner);
    expect(await available()).to.equal(4n * USD);
    await refuses(
      send(zoe.reader, withdraw, zoe.owner),
      "Access denied",
      "a withdrawal through the local query filter",
    );
    await send(rollup, withdraw, zoe.owner);
    expect(await available()).to.equal(3n * USD);
    expect(await balanceOf(from)).to.equal(7n * USD);
    await custodyMatchesLedger();
  });

  it("deposits and withdraws a token in public custody through the query filter, from a public balance", async () => {
    const yan = await openedTrader();
    await minted(solana, admin, mints.open, yan.owner.publicKey, 10n * USD);
    const from = await movedIntoRollup(
      solana,
      yan.reader,
      admin,
      yan.owner,
      mints.open,
      10n * USD,
      VALIDATOR,
      "public",
    );
    const available = async () =>
      (await ledgerThroughThePort()).seats[yan.seat].spot[OPEN].available;
    const custody = () =>
      tokenBalance(anonymous, addresses.custody(mints.open));
    const before = await custody();

    await send(
      yan.reader,
      instructions.deposit(
        yan.owner.publicKey,
        from,
        mints.open,
        yan.owner.publicKey,
        { spot: OPEN },
        4n * USD,
      ),
      yan.owner,
    );
    expect(await available()).to.equal(4n * USD);
    expect(await custody(), "custody, read by anyone").to.equal(
      before + 4n * USD,
    );
    await send(
      yan.reader,
      instructions.withdraw(
        yan.owner.publicKey,
        from,
        mints.open,
        { spot: OPEN },
        1n * USD,
        [PERP],
      ),
      yan.owner,
    );
    expect(await available()).to.equal(3n * USD);
    expect(await custody()).to.equal(before + 3n * USD);
    expect(await balanceOf(from)).to.equal(7n * USD);
  });

  it("opens a seat and funds it from another key in one transaction", async () => {
    const service = Keypair.generate();
    const source = await funded(service, mints.nUSD, 5n * USD);
    const owner = Keypair.generate();
    await send(
      rollup,
      [
        instructions.openTrader(
          gate.publicKey,
          owner.publicKey,
          newOrderKeys(),
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

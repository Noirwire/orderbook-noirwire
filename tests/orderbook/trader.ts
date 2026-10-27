import { expect } from "chai";
import {
  ComputeBudgetProgram,
  Keypair,
  SystemProgram,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  ACCOUNT_SIZE,
  TOKEN_PROGRAM_ID,
  createInitializeAccount3Instruction,
} from "@solana/spl-token";
import nacl from "tweetnacl";
import {
  FEE_SEAT,
  INSURANCE_SEAT,
  clockOf,
  ownerActionEnvelope,
  ownerActionMessage,
  ownerProofInstruction,
} from "../../sdk/dist/index.js";
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
  custodyOf,
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
  type Trader,
} from "./world";

function signedKeyChange(trader: Trader, expiresAt: bigint) {
  const replacement = newOrderKeys();
  const owner = trader.owner.publicKey;
  const message = ownerActionMessage(
    "replace",
    PROGRAM_ID,
    owner,
    replacement,
    expiresAt,
    0,
  );
  const signature = nacl.sign.detached(message, trader.owner.secretKey);
  return {
    proof: instructions.setOrderKeysProof(
      owner,
      replacement,
      0,
      expiresAt,
      signature,
    ),
    update: instructions.setOrderKeysSigned(owner, replacement, 0, expiresAt),
  };
}

async function refusesWithoutChangingView(
  trader: Trader,
  steps: TransactionInstruction[],
  error?: string,
): Promise<void> {
  const address = addresses.view(trader.owner.publicKey);
  const before = (await rollup.getAccountInfo(address))!.data;
  if (error) {
    await refuses(send(rollup, steps, stranger), error);
  } else {
    let refused = false;
    try {
      await send(rollup, steps, stranger);
    } catch {
      refused = true;
    }
    expect(refused).to.equal(true);
  }
  expect((await rollup.getAccountInfo(address))!.data).to.deep.equal(before);
}

describe("a trader", () => {
  it("opens with a matching owner message and refuses a changed message without creating a view", async () => {
    const owner = Keypair.generate();
    const keys = newOrderKeys();
    const expiresAt = BigInt((await clockOf(rollup)) + 90);
    const message = ownerActionMessage(
      "open",
      PROGRAM_ID,
      owner.publicKey,
      keys,
      expiresAt,
    );
    const signature = nacl.sign.detached(message, owner.secretKey);
    const proof = instructions.openTraderProof(
      owner.publicKey,
      keys,
      expiresAt,
      signature,
    );
    const wrongKeys = newOrderKeys();
    await refuses(
      send(
        rollup,
        [
          proof,
          instructions.openTraderSigned(
            gate.publicKey,
            owner.publicKey,
            wrongKeys,
            expiresAt,
          ),
        ],
        gate,
      ),
      "InvalidOwnerProof",
    );
    expect(
      await rollup.getAccountInfo(addresses.view(owner.publicKey)),
    ).to.equal(null);
    await send(
      rollup,
      [
        proof,
        instructions.openTraderSigned(
          gate.publicKey,
          owner.publicKey,
          keys,
          expiresAt,
        ),
      ],
      gate,
    );
    const view = await viewThroughThePort(owner.publicKey);
    expect(view.ownerNonce).to.equal(0);
    expect(view.orderKeys.map(String)).to.deep.equal(keys.map(String));
  });

  it("refuses signed opening after expiry and beyond the 120 second limit", async () => {
    const owner = Keypair.generate();
    const keys = newOrderKeys();
    for (const [expiresAt, error] of [
      [BigInt((await clockOf(rollup)) - 5), "Expired"],
      [BigInt((await clockOf(rollup)) + 180), "OwnerExpiryTooFar"],
    ] as const) {
      const message = ownerActionMessage(
        "open",
        PROGRAM_ID,
        owner.publicKey,
        keys,
        expiresAt,
      );
      const proof = instructions.openTraderProof(
        owner.publicKey,
        keys,
        expiresAt,
        nacl.sign.detached(message, owner.secretKey),
      );
      await refuses(
        send(
          rollup,
          [
            proof,
            instructions.openTraderSigned(
              gate.publicKey,
              owner.publicKey,
              keys,
              expiresAt,
            ),
          ],
          gate,
        ),
        error,
      );
      expect(
        await rollup.getAccountInfo(addresses.view(owner.publicKey)),
      ).to.equal(null);
    }
  });

  it("changes keys with an owner message, consumes its counter, and refuses replay", async () => {
    const trader = await openedTrader();
    const replacement = newOrderKeys();
    const expiresAt = BigInt((await clockOf(rollup)) + 90);
    const message = ownerActionMessage(
      "replace",
      PROGRAM_ID,
      trader.owner.publicKey,
      replacement,
      expiresAt,
      0,
    );
    const signature = nacl.sign.detached(message, trader.owner.secretKey);
    const proof = instructions.setOrderKeysProof(
      trader.owner.publicKey,
      replacement,
      0,
      expiresAt,
      signature,
    );
    const update = instructions.setOrderKeysSigned(
      trader.owner.publicKey,
      replacement,
      0,
      expiresAt,
    );
    const before = (await rollup.getAccountInfo(
      addresses.view(trader.owner.publicKey),
    ))!.data;
    const refusedWithoutChange = async (
      steps: ReturnType<typeof instructions.setOrderKeysSigned>[],
    ) => {
      let failed = false;
      try {
        await send(rollup, steps, stranger);
      } catch {
        failed = true;
      }
      expect(failed).to.equal(true);
      expect(
        (await rollup.getAccountInfo(addresses.view(trader.owner.publicKey)))!
          .data,
      ).to.deep.equal(before);
    };
    const other = Keypair.generate();
    const otherMessage = ownerActionMessage(
      "replace",
      PROGRAM_ID,
      other.publicKey,
      replacement,
      expiresAt,
      0,
    );
    await refusedWithoutChange([
      instructions.setOrderKeysProof(
        other.publicKey,
        replacement,
        0,
        expiresAt,
        nacl.sign.detached(otherMessage, other.secretKey),
      ),
      update,
    ]);
    await refusedWithoutChange([
      proof,
      instructions.setOrderKeysSigned(
        trader.owner.publicKey,
        newOrderKeys(),
        0,
        expiresAt,
      ),
    ]);
    await refusedWithoutChange([
      proof,
      instructions.setOrderKeysSigned(
        trader.owner.publicKey,
        replacement,
        1,
        expiresAt,
      ),
    ]);
    await refusedWithoutChange([update]);
    await send(rollup, [proof, update], stranger);
    const changed = await viewThroughThePort(trader.owner.publicKey);
    expect(changed.ownerNonce).to.equal(1);
    expect(changed.orderKeys.map(String)).to.deep.equal(
      replacement.map(String),
    );
    await refuses(send(rollup, [proof, update], stranger), "WrongOwnerNonce");
    expect(
      (await viewThroughThePort(trader.owner.publicKey)).ownerNonce,
    ).to.equal(1);
  });

  it("moves the counter on an unsigned key reset, and refuses a signed change prepared before it", async () => {
    const trader = await openedTrader();
    const expiresAt = BigInt((await clockOf(rollup)) + 90);
    const { proof, update } = signedKeyChange(trader, expiresAt);

    await send(
      rollup,
      instructions.setOrderKeys(trader.owner.publicKey, newOrderKeys()),
      trader.owner,
    );

    expect(
      (await viewThroughThePort(trader.owner.publicKey)).ownerNonce,
    ).to.equal(1);
    await refusesWithoutChangingView(
      trader,
      [proof, update],
      "WrongOwnerNonce",
    );
  });

  it("refuses signed key changes after expiry and beyond the 120 second limit", async () => {
    const trader = await openedTrader();
    for (const [expiresAt, error] of [
      [BigInt((await clockOf(rollup)) - 5), "Expired"],
      [BigInt((await clockOf(rollup)) + 180), "OwnerExpiryTooFar"],
    ] as const) {
      const { proof, update } = signedKeyChange(trader, expiresAt);
      await refusesWithoutChangingView(trader, [proof, update], error);
    }
  });

  it("refuses a nonadjacent owner proof without changing the view", async () => {
    const trader = await openedTrader();
    const { proof, update } = signedKeyChange(
      trader,
      BigInt((await clockOf(rollup)) + 90),
    );
    await refusesWithoutChangingView(trader, [
      proof,
      ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }),
      update,
    ]);
  });

  it("refuses a two-signature owner proof without changing the view", async () => {
    const trader = await openedTrader();
    const { proof, update } = signedKeyChange(
      trader,
      BigInt((await clockOf(rollup)) + 90),
    );
    proof.data[0] = 2;
    await refusesWithoutChangingView(trader, [proof, update]);
  });

  it("refuses cross-instruction proof offsets without changing the view", async () => {
    const trader = await openedTrader();
    const { proof, update } = signedKeyChange(
      trader,
      BigInt((await clockOf(rollup)) + 90),
    );
    proof.data.writeUInt16LE(1, 4);
    await refusesWithoutChangingView(trader, [proof, update]);
  });

  it("opens with the owner's signature over the off-chain message envelope, and refuses every other wrapping", async () => {
    const owner = Keypair.generate();
    const keys = newOrderKeys();
    const expiresAt = BigInt((await clockOf(rollup)) + 90);
    const text = ownerActionMessage(
      "open",
      PROGRAM_ID,
      owner.publicKey,
      keys,
      expiresAt,
    );
    const open = instructions.openTraderSigned(
      gate.publicKey,
      owner.publicKey,
      keys,
      expiresAt,
    );
    const proofOver = (bytes: Uint8Array) =>
      ownerProofInstruction(
        owner.publicKey,
        bytes,
        nacl.sign.detached(bytes, owner.secretKey),
      );
    const wrapped = ownerActionEnvelope(text);
    const mutated = (at: number, value: number) => {
      const bytes = wrapped.slice();
      bytes[at] = value;
      return bytes;
    };
    const otherText = ownerActionMessage(
      "open",
      PROGRAM_ID,
      owner.publicKey,
      newOrderKeys(),
      expiresAt,
    );
    const refused: [string, Uint8Array][] = [
      ["another text", ownerActionEnvelope(otherText)],
      ["a wrong domain", mutated(0, 0xfe)],
      ["a wrong header version", mutated(16, 1)],
      ["restricted ASCII format", mutated(17, 0)],
      ["extended UTF-8 format", mutated(17, 2)],
      ["a short length", mutated(18, wrapped[18] - 1)],
      ["a long length", mutated(19, wrapped[19] + 1)],
      ["a trailing byte", Uint8Array.of(...wrapped, 10)],
      ["a truncated text", wrapped.subarray(0, wrapped.length - 1)],
      ["a nested envelope", ownerActionEnvelope(wrapped)],
      ["its header alone", wrapped.subarray(0, 20)],
    ];
    for (const [what, bytes] of refused) {
      await refuses(
        send(rollup, [proofOver(bytes), open], gate),
        "InvalidOwnerProof",
        what,
      );
      expect(
        await rollup.getAccountInfo(addresses.view(owner.publicKey)),
        what,
      ).to.equal(null);
    }
    await send(rollup, [proofOver(wrapped), open], gate);
    const view = await viewThroughThePort(owner.publicKey);
    expect(view.ownerNonce).to.equal(0);
    expect(view.orderKeys.map(String)).to.deep.equal(keys.map(String));
  });

  it("changes keys with the owner's signature over the off-chain message envelope, and refuses an envelope around another text", async () => {
    const trader = await openedTrader();
    const owner = trader.owner.publicKey;
    const replacement = newOrderKeys();
    const expiresAt = BigInt((await clockOf(rollup)) + 90);
    const textFor = (keys: typeof replacement, nonce: number) =>
      ownerActionMessage("replace", PROGRAM_ID, owner, keys, expiresAt, nonce);
    const signedEnvelope = (keys: typeof replacement, nonce: number) =>
      nacl.sign.detached(
        ownerActionEnvelope(textFor(keys, nonce)),
        trader.owner.secretKey,
      );
    const update = instructions.setOrderKeysSigned(
      owner,
      replacement,
      0,
      expiresAt,
    );
    const proofAround = (keys: typeof replacement, nonce: number) => {
      const wrapped = ownerActionEnvelope(textFor(keys, nonce));
      return ownerProofInstruction(
        owner,
        wrapped,
        nacl.sign.detached(wrapped, trader.owner.secretKey),
      );
    };
    await refusesWithoutChangingView(
      trader,
      [proofAround(newOrderKeys(), 0), update],
      "InvalidOwnerProof",
    );
    await refusesWithoutChangingView(
      trader,
      [proofAround(replacement, 7), update],
      "InvalidOwnerProof",
    );
    await send(
      rollup,
      [
        instructions.setOrderKeysProof(
          owner,
          replacement,
          0,
          expiresAt,
          signedEnvelope(replacement, 0),
          "envelope",
        ),
        update,
      ],
      stranger,
    );
    const changed = await viewThroughThePort(owner);
    expect(changed.ownerNonce).to.equal(1);
    expect(changed.orderKeys.map(String)).to.deep.equal(
      replacement.map(String),
    );
  });

  it("returns tokens to the owner's associated account with a consumed order key", async () => {
    const trader = await openedTrader();
    const destination = await fundedWith(trader, mints.nUSD, 5n * USD);
    await send(
      rollup,
      instructions.deposit(
        trader.owner.publicKey,
        destination,
        custodyOf(mints.nUSD),
        trader.owner.publicKey,
        { collateral: true },
        3n * USD,
      ),
      trader.owner,
    );
    const use = trader.keys.take();
    const other = await openedTrader();
    const wrongDestination = await fundedWith(other, mints.nUSD, 1n * USD);
    const expiresAt = BigInt((await clockOf(rollup)) + 30);
    const call = (to: typeof destination, expiry = expiresAt) =>
      instructions.withdrawByKey(
        use.keypair.publicKey,
        trader.owner.publicKey,
        use.replacement.publicKey,
        expiry,
        to,
        custodyOf(mints.nUSD),
        { collateral: true },
        1n * USD,
        [PERP],
      );
    const before = await viewThroughThePort(trader.owner.publicKey);
    const anotherAccount = Keypair.generate();
    await send(
      solana,
      [
        SystemProgram.createAccount({
          fromPubkey: admin.publicKey,
          newAccountPubkey: anotherAccount.publicKey,
          lamports:
            await solana.getMinimumBalanceForRentExemption(ACCOUNT_SIZE),
          space: ACCOUNT_SIZE,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeAccount3Instruction(
          anotherAccount.publicKey,
          mints.nUSD,
          trader.owner.publicKey,
        ),
      ],
      admin,
      [anotherAccount],
    );
    await refuses(
      send(rollup, call(anotherAccount.publicKey), use.keypair),
      "WrongWithdrawDestination",
    );
    await refuses(
      send(rollup, call(wrongDestination), use.keypair),
      "WrongTokenAccountOwner",
    );
    await refuses(
      send(
        rollup,
        call(destination, BigInt((await clockOf(rollup)) - 1)),
        use.keypair,
      ),
      "Expired",
    );
    expect(
      (await viewThroughThePort(trader.owner.publicKey)).orderKeys.map(String),
    ).to.deep.equal(before.orderKeys.map(String));
    await send(rollup, call(destination), use.keypair);
    const after = await viewThroughThePort(trader.owner.publicKey);
    expect(after.orderKeys[use.slot].toBase58()).to.equal(
      use.replacement.publicKey.toBase58(),
    );
    expect(await balanceOf(destination)).to.equal(3n * USD);
  });
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
    const custodyBefore = await balanceOf(
      addresses.custody(custodyOf(mints.nUSD)),
    );
    await deposited(alice, mints.nUSD, { spot: NUSD }, 1_000n * USD);
    await deposited(bob, mints.nSOL, { spot: NSOL }, 10n * SOL);
    await deposited(bob, mints.nUSD, { spot: NUSD }, 100n * USD);
    expect(
      (await balanceOf(addresses.custody(custodyOf(mints.nUSD)))) -
        custodyBefore,
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
          custodyOf(mint),
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
          custodyOf(mints.nUSD),
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
      custodyOf(mints.nUSD),
      zoe.owner.publicKey,
      { spot: NUSD },
      4n * USD,
    );
    const withdraw = instructions.withdraw(
      zoe.owner.publicKey,
      from,
      custodyOf(mints.nUSD),
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
      tokenBalance(anonymous, addresses.custody(custodyOf(mints.open)));
    const before = await custody();

    await send(
      yan.reader,
      instructions.deposit(
        yan.owner.publicKey,
        from,
        custodyOf(mints.open),
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
        custodyOf(mints.open),
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
          custodyOf(mints.nUSD),
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

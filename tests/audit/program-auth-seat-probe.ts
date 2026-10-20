/**
 * Audit, program authority. Two proofs that need the local network.
 *
 * Runs as part of the story in `tests/orderbook.test.ts`, after
 * `./orderbook/authority` (it needs the public-custody mint registered in
 * `set-up.ts` and the gate key of `world.ts`). To run it, add
 * `import "./audit/program-auth-seat-probe";` as the last import there.
 *
 * Both tests assert the property the program should have and FAIL today.
 */
import { expect } from "chai";
import { Keypair, type PublicKey } from "@solana/web3.js";
import { minted, movedIntoRollup } from "../../ops/tokens";
import {
  VALIDATOR,
  admin,
  anonymous,
  instructions,
  readingAs,
  rollup,
  send,
  solana,
} from "../support";
import {
  OPEN,
  exchangeOn,
  gate,
  mints,
  newOrderKeys,
  openedTrader,
  refuses,
} from "../orderbook/world";

/** A key outside the exchange, holding `amount` atoms of the public-custody token as a public balance in the rollup. */
async function outsiderWithOpenTokens(amount: bigint) {
  const key = Keypair.generate();
  const reader = await readingAs(key);
  await minted(solana, admin, mints.open, key.publicKey, amount);
  const from = await movedIntoRollup(
    solana,
    reader,
    admin,
    key,
    mints.open,
    amount,
    VALIDATOR,
    "public",
  );
  return { key, reader, from };
}

/** What the private endpoint answers to a one-atom deposit by `prober` that names `owner`'s view. */
async function depositAnswer(
  prober: Awaited<ReturnType<typeof outsiderWithOpenTokens>>,
  owner: PublicKey,
  through = prober.reader,
): Promise<string> {
  return send(
    through,
    instructions.deposit(
      prober.key.publicKey,
      prober.from,
      mints.open,
      owner,
      { spot: OPEN },
      1n,
    ),
    prober.key,
  ).then(
    () => "accepted",
    (error: unknown) =>
      error instanceof Error && error.message.includes("AccountMissing")
        ? "AccountMissing"
        : String(error),
  );
}

describe("audit: program authority", () => {
  it("lets a stranger learn through the private endpoint whether a given wallet holds a seat", async () => {
    const prober = await outsiderWithOpenTokens(2n);

    const before = (await exchangeOn(anonymous)).seatsOpened;
    const member = await openedTrader();
    const after = (await exchangeOn(anonymous)).seatsOpened;
    expect(after, "the exchange's public seat counter moved").to.equal(
      before + 1,
    );

    const withSeat = await depositAnswer(prober, member.owner.publicKey);
    const withoutSeat = await depositAnswer(
      prober,
      Keypair.generate().publicKey,
    );
    expect(withoutSeat).to.equal("AccountMissing");
    expect(
      withSeat,
      "INVARIANT BROKEN: whether a given wallet holds a seat is not observable by a stranger " +
        "(the liquidation outcome hides seat existence; a deposit naming the wallet's view reveals it)",
    ).to.equal(withoutSeat);
  });

  it("lets a gate-key holder keep a seat from the admin's close_unused_trader with a one-atom deposit", async () => {
    const thief = await outsiderWithOpenTokens(1n);
    const spam = Keypair.generate();
    await send(
      rollup,
      instructions.openTrader(gate.publicKey, spam.publicKey, newOrderKeys()),
      gate,
      [spam],
    );
    expect(await depositAnswer(thief, spam.publicKey, rollup)).to.equal(
      "accepted",
    );

    let reclaimed = true;
    try {
      await refuses(
        send(
          rollup,
          instructions.closeUnusedTrader(admin.publicKey, spam.publicKey),
          admin,
        ),
        "SeatUsed",
      );
      reclaimed = false;
    } catch {
      reclaimed = true;
    }
    expect(
      reclaimed,
      "INVARIANT BROKEN: the admin gives back seats opened through a stolen gate key " +
        "(SECURITY.md, the gate key); one atom deposited by anyone makes close_unused_trader refuse with SeatUsed",
    ).to.equal(true);
  });
});

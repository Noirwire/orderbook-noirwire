/**
 * Audit, program authority. Two accepted limits that need the local network,
 * pinned as `SECURITY.md` states them.
 *
 * Runs as part of the story in `tests/orderbook.test.ts`, after
 * `./orderbook/authority` (it needs the public-custody mint registered in
 * `set-up.ts` and the gate key of `world.ts`). To run it, add
 * `import "./audit/program-auth-seat-probe";` as the last import there.
 */
import { expect } from "chai";
import { Keypair, type PublicKey } from "@solana/web3.js";
import { TransactionFailed } from "../../sdk/dist/index.js";
import { minted, movedIntoRollup } from "../../ops/tokens";
import {
  VALIDATOR,
  admin,
  anonymous,
  errorCode,
  instructions,
  readingAs,
  rollup,
  send,
  solana,
} from "../support";
import {
  OPEN,
  custodyOf,
  exchangeOn,
  gate,
  mints,
  newOrderKeys,
  openedTrader,
  refuses,
} from "../orderbook/world";

/** `AccountMissing` in the program's error list, numbered as `TransactionFailed.code` numbers it. */
const ACCOUNT_MISSING = errorCode("AccountMissing");

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

/**
 * The program's error number in what `send` threw, read from the status it
 * reports first the way the SDK's `TransactionFailed` reads it, or null.
 */
function programCode(error: unknown): number | null {
  if (!(error instanceof Error)) return null;
  try {
    const status: unknown = JSON.parse(error.message.split("\n")[0]);
    return new TransactionFailed("", status).code;
  } catch {
    return null;
  }
}

/** What the endpoint answers to a one-atom deposit by `prober` that names `owner`'s view. */
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
      custodyOf(mints.open),
      owner,
      { spot: OPEN },
      1n,
    ),
    prober.key,
  ).then(
    () => "accepted",
    (error: unknown) => `refused with ${programCode(error) ?? String(error)}`,
  );
}

describe("audit: program authority", () => {
  it("accepted_limit: anyone who knows a wallet learns through the private endpoint whether it holds a seat, by a deposit that names it", async () => {
    const prober = await outsiderWithOpenTokens(2n);
    const member = await openedTrader();

    const withSeat = await depositAnswer(prober, member.owner.publicKey);
    const withoutSeat = await depositAnswer(
      prober,
      Keypair.generate().publicKey,
    );
    expect(
      withoutSeat,
      "SECURITY.md, what an observer can learn: a deposit into a wallet with no seat is refused",
    ).to.equal(`refused with ${ACCOUNT_MISSING}`);
    expect(
      withSeat,
      "SECURITY.md, what an observer can learn: a deposit into any open seat is accepted",
    ).to.equal("accepted");
  });

  it("accepted_limit: close_unused_trader refuses a seat that holds a one-atom deposit, and only the gate key opens such seats, each counted against max_seats_per_day", async () => {
    const thief = await outsiderWithOpenTokens(1n);
    const spam = Keypair.generate();
    await refuses(
      send(
        rollup,
        instructions.openTrader(
          thief.key.publicKey,
          spam.publicKey,
          newOrderKeys(),
        ),
        thief.key,
        [spam],
      ),
      "GateMissing",
      "a seat is opened only with the gate key's signature",
    );

    const before = await exchangeOn(anonymous);
    await send(
      rollup,
      instructions.openTrader(gate.publicKey, spam.publicKey, newOrderKeys()),
      gate,
      [spam],
    );
    const after = await exchangeOn(anonymous);
    expect(
      after.seatsOpened,
      "the seat counts against the day's max_seats_per_day",
    ).to.equal(before.seatsOpened + 1);
    expect(after.seatsOpened).to.be.at.most(after.maxSeatsPerDay);

    expect(await depositAnswer(thief, spam.publicKey, rollup)).to.equal(
      "accepted",
    );
    await refuses(
      send(
        rollup,
        instructions.closeUnusedTrader(admin.publicKey, spam.publicKey),
        admin,
      ),
      "SeatUsed",
      "SECURITY.md, the gate key: a seat that ever took a deposit is no longer the admin's to close",
    );
  });
});

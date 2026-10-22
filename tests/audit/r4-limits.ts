/**
 * Audit round 4, limits. Needs the local network.
 *
 * RULES 11: a deposit's answer does not depend on the seat it names.
 * `deposit_tokens` moves the tokens before it reads the seat, then checks
 * custody against the token's cap, which is at most `BALANCE_CAP` (2^62),
 * and only then credits the seat. So a stranger who holds one atom of the
 * collateral token and knows two traders' wallets gets the token program's
 * refusal for every deposit of `2^62 - x` into either seat, whatever `x`
 * and whatever each seat holds: never `BalanceCapExceeded`, which a binary
 * search over `x` once turned into a seat's exact collateral. Nothing
 * changes in the ledger or in custody.
 *
 * Runs after the story in `tests/orderbook.test.ts`.
 */
import { expect } from "chai";
import type { PublicKey } from "@solana/web3.js";
import {
  addresses,
  balanceOf,
  instructions,
  ledgerThroughThePort,
  refusal,
  rollup,
  send,
} from "../support";
import {
  COLLATERAL,
  USD,
  custodyOf,
  deposited,
  fundedWith,
  mints,
  openedTrader,
  tokenAccount,
  type Trader,
} from "../orderbook/world";

const BALANCE_CAP = 1n << 62n;
const SEAT_ANSWERS = ["BalanceCapExceeded", "CustodyCapReached"];

const custody = () => balanceOf(addresses.custody(custodyOf(mints.nUSD)));

const depositFor = (depositor: Trader, owner: PublicKey, amount: bigint) =>
  send(
    rollup,
    instructions.deposit(
      depositor.owner.publicKey,
      tokenAccount(depositor, mints.nUSD),
      custodyOf(mints.nUSD),
      owner,
      COLLATERAL,
      amount,
    ),
    depositor.owner,
  );

/** Which answer a refusal is: one that reads the seat or the cap, or the token program's. */
const answerOf = (message: string) =>
  SEAT_ANSWERS.find((name) => message.includes(name)) ?? "token program";

describe("audit r4: limits", () => {
  it("answers a stranger's deposits alike whatever the seat they name holds", async () => {
    const small = await openedTrader();
    await fundedWith(small, mints.nUSD, 7n * USD);
    await deposited(small, mints.nUSD, COLLATERAL, 7n * USD - 12_345n);
    const large = await openedTrader();
    await fundedWith(large, mints.nUSD, 50n * USD);
    await deposited(large, mints.nUSD, COLLATERAL, 50n * USD);
    const prober = await openedTrader();
    await fundedWith(prober, mints.nUSD, 1n);

    const ledgerBefore = await ledgerThroughThePort();
    const custodyBefore = await custody();
    for (const victim of [small, large]) {
      const held = ledgerBefore.seats[victim.seat].collateral;
      for (const x of [0n, 1n, held - 1n, held, held + 1n, BALANCE_CAP / 2n]) {
        const message = await refusal(
          depositFor(prober, victim.owner.publicKey, BALANCE_CAP - x),
        );
        expect(answerOf(message), `x = ${x}`).to.equal("token program");
      }
    }

    const ledgerAfter = await ledgerThroughThePort();
    for (const victim of [small, large]) {
      expect(ledgerAfter.seats[victim.seat]).to.deep.equal(
        ledgerBefore.seats[victim.seat],
      );
    }
    expect(await custody()).to.equal(custodyBefore);
  });
});

/**
 * Audit against a census of hacks on perpetuals venues: the custody side of
 * every token movement. `deposit`, `withdraw` and `fund_insurance` name the
 * custody account, its custody authority and the token program themselves. A
 * deposit into an account that is not custody would credit a seat with
 * nothing moved into custody, and a withdrawal from another token's custody
 * would pay a balance out of the wrong account.
 *
 * Each instruction is built as the client builds it and then one account is
 * replaced: the custody account by another token's custody or by a lookalike
 * holding the same mint, the custody authority by another token's, and the
 * token program by the System Program and by Token-2022. Every attempt is
 * refused, and no seat, custody account or token account moves. The same
 * deposit with the real accounts then lands.
 *
 * Runs after the story and the other audit parts; it opens one trader of its
 * own.
 */
import { expect } from "chai";
import {
  SystemProgram,
  type Keypair,
  type PublicKey,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { INSURANCE_SEAT } from "../../sdk/dist/index.js";
import {
  addresses,
  admin,
  balanceOf,
  instructions,
  ledgerThroughThePort,
  rollup,
  send,
} from "../support";
import {
  NUSD,
  PERP,
  USD,
  custodyMatchesLedger,
  custodyOf,
  deposited,
  fundedWith,
  mints,
  openedTrader,
  refuses,
  type Trader,
} from "../orderbook/world";

/** Where the custody leg sits in each instruction's accounts. */
type Leg = { authority: number; custody: number; tokenProgram: number };
const DEPOSIT_OR_WITHDRAW: Leg = { authority: 4, custody: 5, tokenProgram: 7 };
const FUND_INSURANCE: Leg = { authority: 3, custody: 4, tokenProgram: 6 };

function replaced(
  instruction: TransactionInstruction,
  at: number,
  pubkey: PublicKey,
): TransactionInstruction {
  instruction.keys[at] = { ...instruction.keys[at], pubkey };
  return instruction;
}

describe("audit: the custody account, its authority and the token program of a token movement", () => {
  let bob: Trader;
  let bobUsd: PublicKey;
  const adminUsd = () =>
    getAssociatedTokenAddressSync(mints.nUSD, admin.publicKey, true);
  const usd = () => custodyOf(mints.nUSD);
  const sol = () => custodyOf(mints.nSOL);

  const held = async () => {
    const { seats } = await ledgerThroughThePort();
    return {
      seats: [seats[bob.seat], seats[INSURANCE_SEAT]],
      tokens: await Promise.all(
        [
          addresses.custody(usd()),
          addresses.custody(sol()),
          bobUsd,
          adminUsd(),
        ].map(balanceOf),
      ),
    };
  };

  before(async () => {
    bob = await openedTrader();
    bobUsd = await fundedWith(bob, mints.nUSD, 100n * USD);
    await deposited(bob, mints.nUSD, { spot: NUSD }, 50n * USD);
    await custodyMatchesLedger();
  });

  it("refuses another token's custody, a lookalike custody, another custody authority and a fake token program", async () => {
    const deposit = () =>
      instructions.deposit(
        bob.owner.publicKey,
        bobUsd,
        usd(),
        bob.owner.publicKey,
        { spot: NUSD },
        10n * USD,
      );
    const withdrawal = () =>
      instructions.withdraw(
        bob.owner.publicKey,
        bobUsd,
        usd(),
        { spot: NUSD },
        10n * USD,
        [PERP],
      );
    const funding = () =>
      instructions.fundInsurance(admin.publicKey, adminUsd(), usd(), 10n * USD);
    const otherAuthority = addresses.custodyAuthority(sol().custodyNonce);
    const fakePrograms = [SystemProgram.programId, TOKEN_2022_PROGRAM_ID];

    const table: [
      string,
      () => TransactionInstruction,
      Keypair,
      Leg,
      PublicKey[],
    ][] = [
      ["deposit", deposit, bob.owner, DEPOSIT_OR_WITHDRAW, [bobUsd]],
      ["withdraw", withdrawal, bob.owner, DEPOSIT_OR_WITHDRAW, [bobUsd]],
      ["fund_insurance", funding, admin, FUND_INSURANCE, [adminUsd()]],
    ];
    for (const [name, build, signer, leg, lookalikes] of table) {
      const attempts: [string, TransactionInstruction, string][] = [
        [
          "the nSOL custody",
          replaced(build(), leg.custody, addresses.custody(sol())),
          "WrongCustody",
        ],
        ...lookalikes.map(
          (lookalike): [string, TransactionInstruction, string] => [
            "a token account of the same mint that is not custody",
            replaced(build(), leg.custody, lookalike),
            "WrongCustody",
          ],
        ),
        [
          "the nSOL custody authority",
          replaced(build(), leg.authority, otherAuthority),
          "WrongDerivation",
        ],
        ...fakePrograms.map(
          (program): [string, TransactionInstruction, string] => [
            `${program.toBase58()} as the token program`,
            replaced(build(), leg.tokenProgram, program),
            "WrongTokenProgram",
          ],
        ),
      ];
      for (const [what, instruction, error] of attempts) {
        const before = await held();
        await refuses(
          send(rollup, instruction, signer),
          error,
          `${name}, ${what}`,
        );
        expect(await held(), `${name}, ${what}`).to.deep.equal(before);
      }
    }
    await custodyMatchesLedger();

    const before = await held();
    await send(rollup, deposit(), bob.owner);
    const after = await held();
    expect(after.seats[0].spot[NUSD].available).to.equal(
      before.seats[0].spot[NUSD].available + 10n * USD,
    );
    expect(after.tokens[0] - before.tokens[0]).to.equal(10n * USD);
    expect(before.tokens[2] - after.tokens[2]).to.equal(10n * USD);
    await custodyMatchesLedger();
  });
});

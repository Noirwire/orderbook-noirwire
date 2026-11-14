/**
 * The price accounts as the validator holds them, and what the test says when
 * the rollup does not serve one: the validator is started with them at
 * genesis, and the rollup clones an account from Solana when a transaction
 * names it. The programs that own these accounts, Pyth's receiver and
 * MagicBlock's oracle, are not on the local network.
 */
import { solana } from "../support";
import {
  PUBLISH_TIME_AT,
  priceFixtures,
  type PriceFixture,
} from "./price-fixtures";

export type PriceFixtures = ReturnType<typeof priceFixtures>;

/** The four accounts, stamped as `make test-upgrade` stamped the files it loaded. */
export async function fixturesOnSolana(): Promise<PriceFixtures> {
  const written = await solana.getAccountInfo(priceFixtures(0).pythSol.address);
  if (!written) {
    throw new Error(
      "The validator was not started with the price accounts: `make test-upgrade` writes them under .localnet/fixtures and loads them with --account.",
    );
  }
  return priceFixtures(Number(written.data.readBigInt64LE(PUBLISH_TIME_AT)));
}

export const notServed = (
  name: string,
  { address, owner }: PriceFixture,
  refused: string,
) =>
  new Error(
    `The rollup does not serve the price account ${name} (${address.toBase58()}, owned by ${owner.toBase58()}), which the validator loaded at genesis. ` +
      "This test needs the rollup to clone an account whose owner program is not on the local network; if it does not, the upgrade cannot be proved here until those programs are loaded as well. " +
      `The rollup's answer: ${refused}`,
  );

/**
 * Awaits a call that names `fixture`. A failure that is not one of the
 * program's own refusals, or is its refusal of the account's owner, says the
 * account is not served as it was loaded.
 */
export async function sentWith(
  name: string,
  fixture: PriceFixture,
  sending: Promise<unknown>,
): Promise<void> {
  try {
    await sending;
  } catch (error) {
    const refused = error instanceof Error ? error.message : String(error);
    const theProgramsOwn =
      refused.includes("Error Code:") &&
      !refused.includes("WrongPriceAccountOwner");
    throw theProgramsOwn ? error : notServed(name, fixture, refused);
  }
}

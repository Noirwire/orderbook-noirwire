import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { Instructions, type Addresses } from "../sdk/dist/index.js";
import { send, until } from "./sending";

const MAX_STEPS = 16;
const COLLATERAL_TOKEN = 0;

export async function exchangeOnSolana(
  solana: Connection,
  addresses: Addresses,
): Promise<{ lamports: number; rent: number; delegated: boolean } | null> {
  const account = await solana.getAccountInfo(addresses.exchange);
  if (!account) return null;
  return {
    lamports: account.lamports,
    rent: await solana.getMinimumBalanceForRentExemption(account.data.length),
    delegated: account.owner.equals(DELEGATION_PROGRAM_ID),
  };
}

type ExchangeSetup = {
  solana: Connection;
  rollup: Connection;
  admin: Keypair;
  gate: PublicKey;
  oracle: PublicKey;
  validator: PublicKey;
  floatLamports: number;
};

/** The exchange exists on Solana, holds its float, and is delegated to the rollup. */
export async function ensureExchange(setup: ExchangeSetup): Promise<void> {
  const instructions = new Instructions();
  const { addresses } = instructions;
  const { solana, admin } = setup;
  if (!(await exchangeOnSolana(solana, addresses))) {
    await send(
      solana,
      instructions.initializeExchange(admin.publicKey, {
        gate: setup.gate,
        oracle: setup.oracle,
        maxSteps: MAX_STEPS,
        collateralToken: COLLATERAL_TOKEN,
      }),
      admin,
    );
  }
  const exchange = await exchangeOnSolana(solana, addresses);
  if (!exchange) {
    throw new Error(
      "The exchange was initialised and Solana does not serve it yet. Run setup again.",
    );
  }
  if (exchange.delegated) return;
  const missing = exchange.rent + setup.floatLamports - exchange.lamports;
  if (missing > 0) {
    await send(
      solana,
      SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: addresses.exchange,
        lamports: missing,
      }),
      admin,
    );
  }
  await send(
    solana,
    instructions.delegateExchange(admin.publicKey, setup.validator),
    admin,
  );
  await until(
    async () =>
      (await setup.rollup.getAccountInfo(addresses.exchange))?.owner.equals(
        instructions.programId,
      ),
    "the exchange to appear in the rollup",
  );
}

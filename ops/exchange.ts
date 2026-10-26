import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { Instructions, type Addresses } from "../sdk/dist/index.js";
import { send, until } from "./sending";

const MAX_STEPS = 16;
const COLLATERAL_TOKEN = 0;
/** Below this the gate may not cover the next account opening, and it pays for every one. */
export const GATE_LOW_SOL = 0.005;

/** What status shows of the gate's SOL: the balance, and a warning when it is below `GATE_LOW_SOL`. */
export function gateBalanceLine(
  gate: PublicKey,
  lamports: number,
): { text: string; low: boolean } {
  const low = lamports < GATE_LOW_SOL * LAMPORTS_PER_SOL;
  const key = gate.toBase58();
  const balance = `${(lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL`;
  return low
    ? {
        text: `${key.slice(0, 4)}...${key.slice(-4)}: ${balance}. gate low on SOL: account openings will fail; send SOL to ${key}`,
        low,
      }
    : { text: `${key.slice(0, 4)}...${key.slice(-4)}: ${balance}`, low };
}

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
  /** The client's own program id when left out. */
  instructions?: Instructions;
  admin: Keypair;
  gate: PublicKey;
  oracle: PublicKey;
  validator: PublicKey;
  floatLamports: number;
  /** The client's default when left out. */
  maxSeatsPerDay?: number;
};

/** The exchange exists on Solana, holds its float, and is delegated to the rollup. */
export async function ensureExchange(setup: ExchangeSetup): Promise<void> {
  const { instructions = new Instructions(), solana, admin } = setup;
  const { addresses } = instructions;
  if (!(await exchangeOnSolana(solana, addresses))) {
    await send(
      solana,
      instructions.initializeExchange(admin.publicKey, {
        gate: setup.gate,
        oracle: setup.oracle,
        maxSteps: MAX_STEPS,
        collateralToken: COLLATERAL_TOKEN,
        maxSeatsPerDay: setup.maxSeatsPerDay,
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

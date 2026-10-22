/**
 * The exit back to Solana, shared by the exit and round-trip commands. The
 * program's `withdraw` pays collateral into the owner's token account inside
 * the rollup and stops there; the token program then carries the balance from
 * the rollup to the owner's token account on Solana. Every step is signed by
 * the owner's own key. Nothing here can move tokens for another owner: the
 * program pays out to its owner only, and the token program's withdrawal
 * asks the owner's signature too.
 */
import { existsSync } from "fs";
import { type Connection, type Keypair, PublicKey } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import {
  DELEGATION_PROGRAM_ID,
  DelegationStatus,
  decodeEphemeralAta,
  delegateEphemeralAtaIx,
  deriveEphemeralAta,
  getDelegationRecord,
  initEphemeralAtaIx,
  undelegateIx,
  withdrawSpl,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import type { TokenInfo } from "../sdk/dist/index.js";
import { depositingAs, rollupIsRunBy, type Target } from "./deployment";
import {
  heldRefusal,
  rollupBalanceStep,
  returnShortfall,
  sealedBalanceRefusal,
  seatWithdrawalFailure,
  type ExitMethod,
  type ExitSource,
} from "./exiting";
import { heldKey, readingAs } from "./keys";
import { exchangeInRollup, perpMarketIds } from "./market";
import { deployedAsBuilt } from "./program";
import { quoteRefusal } from "./seating";
import { send, simulatedError, until } from "./sending";
import { tokenBalance } from "./tokens";

const HANDED_BACK_WITHIN_MS = 180_000;
const ARRIVES_WITHIN_MS = 120_000;
const SHOWN_IN_ROLLUP_WITHIN_MS = 30_000;

export const shown = (label: string, value: string) =>
  console.log(`${label.padEnd(20)}${value}`);

/** What an exit works with: the owner, the quote token, and the owner's token account, which has one address on Solana and in the rollup. */
export type Leaving = {
  on: Target;
  owner: Keypair;
  token: TokenInfo;
  decimals: number;
  account: PublicKey;
  /** The connection the owner sends what names custody through, and reads its own token account from. */
  rollup: Connection;
};

export type Exited = {
  /** The owner's token account on Solana before the exit and after it. */
  before: bigint;
  after: bigint;
  /** What the exit asked the token program to send back to Solana. */
  moved: bigint;
};

/** The owner's key, kept at `keyFile`. */
export function ownerAt(keyFile: string): Keypair {
  if (!existsSync(keyFile)) {
    throw new Error(
      `There is no key file at ${keyFile}. Give KEYFILE the file the owner's key is kept in. Nothing was sent.`,
    );
  }
  return heldKey(keyFile);
}

/** Checks the deployment is the one built and the quote token is one `owner` can exit, and gathers what the exit needs. */
export async function leavingAs(on: Target, owner: Keypair): Promise<Leaving> {
  await deployedAsBuilt(on);
  await rollupIsRunBy(on);
  const exchange = await exchangeInRollup(on);
  const token = exchange.tokens[exchange.collateralToken];
  if (token.mint.equals(PublicKey.default)) {
    throw new Error("The quote token is not registered. Run setup first.");
  }
  const refusal = quoteRefusal(on, token.mint);
  if (refusal) throw new Error(refusal);
  return {
    on,
    owner,
    token,
    decimals: (await getMint(on.solana, token.mint)).decimals,
    account: getAssociatedTokenAddressSync(token.mint, owner.publicKey, true),
    rollup: await depositingAs(on, owner),
  };
}

/** Whether the owner has an open seat, which only the gate can open. */
export async function seatIsOpen({ on, owner }: Leaving): Promise<boolean> {
  const reader = await readingAs(on.privateUrl, owner);
  return (
    (await reader.getAccountInfo(
      on.instructions.addresses.view(owner.publicKey),
    )) !== null
  );
}

/**
 * Makes the owner's token account show in the rollup, which the program's
 * withdrawal checks before anything else. A seat funded by another key may
 * have none: the owner then creates its balance on Solana and delegates it
 * to this rollup, or only delegates one that was handed back to Solana.
 */
async function balanceInRollup(l: Leaving): Promise<void> {
  const { on, owner, token, account, rollup } = l;
  if (await rollup.getAccountInfo(account)) return;
  const sealed = sealedBalanceRefusal(token.custodyVisibility, owner.publicKey);
  if (sealed) throw new Error(sealed);
  const balance = deriveEphemeralAta(owner.publicKey, token.mint)[0];
  const record = await getDelegationRecord(on.solana, balance);
  const step = rollupBalanceStep(
    (await on.solana.getAccountInfo(balance)) !== null,
    record.status === DelegationStatus.Delegated ? record.validator : null,
    on.validator,
  );
  if (step !== "wait") {
    const signature = await send(
      on.solana,
      step === "create"
        ? [
            createAssociatedTokenAccountIdempotentInstruction(
              owner.publicKey,
              account,
              owner.publicKey,
              token.mint,
            ),
            initEphemeralAtaIx(
              balance,
              owner.publicKey,
              token.mint,
              owner.publicKey,
            ),
            delegateEphemeralAtaIx(owner.publicKey, balance, on.validator),
          ]
        : delegateEphemeralAtaIx(owner.publicKey, balance, on.validator),
      owner,
    );
    shown("token account", `made in the rollup (${step})`);
    shown("signature", signature);
  }
  await until(
    async () => (await rollup.getAccountInfo(account)) !== null,
    "the rollup to show the owner's token account",
    SHOWN_IN_ROLLUP_WITHIN_MS,
  );
}

/**
 * Pays `atoms` of the seat's collateral into the owner's token account in the
 * rollup, simulated first so a refusal sends nothing, and waits until the
 * rollup shows it there.
 */
async function withdrawnToRollup(l: Leaving, atoms: bigint): Promise<void> {
  const { on, owner, token, account, rollup } = l;
  if (!(await seatIsOpen(l))) {
    throw new Error(
      `${owner.publicKey.toBase58()} has no open seat on this exchange, so there is nothing to withdraw. Nothing was sent.`,
    );
  }
  await balanceInRollup(l);
  const held = await tokenBalance(rollup, account);
  const withdrawal = on.instructions.withdraw(
    owner.publicKey,
    account,
    token,
    { collateral: true },
    atoms,
    await perpMarketIds(on),
  );
  const failed = await simulatedError(rollup, [withdrawal], owner).catch(
    (error: Error) => {
      throw new Error(
        `The endpoint did not simulate the withdrawal (${error.message.split("\n")[0]}), so it is not sent. Nothing was sent.`,
      );
    },
  );
  if (failed !== null) throw new Error(seatWithdrawalFailure(failed));
  shown("seat withdrawal", await send(rollup, withdrawal, owner));
  await until(
    async () => (await tokenBalance(rollup, account)) >= held + atoms,
    `the rollup to show ${held + atoms} atoms in the owner's token account`,
    SHOWN_IN_ROLLUP_WITHIN_MS,
  );
}

/** The token program's shuttle withdrawal: exactly `atoms` go to Solana and the owner's balance stays in the rollup. */
async function throughShuttle(l: Leaving, atoms: bigint): Promise<bigint> {
  const { on, owner, token } = l;
  const instructions = await withdrawSpl(owner.publicKey, token.mint, atoms, {
    validator: on.validator,
    payer: owner.publicKey,
    initAtasIfMissing: true,
  });
  shown("exit signature", await send(on.solana, instructions, owner));
  return atoms;
}

/**
 * The token program's two steps: the owner's whole balance is undelegated in
 * the rollup and handed back to Solana, then withdrawn there. It leaves the
 * balance undelegated, which the next exit delegates again. Returns what it
 * withdrew, which is everything the owner held in the rollup.
 */
async function throughUndelegate(l: Leaving, atoms: bigint): Promise<bigint> {
  const { on, owner, token, account, rollup } = l;
  const refusal = heldRefusal(await tokenBalance(rollup, account), atoms);
  if (refusal) throw new Error(refusal);
  const balance = deriveEphemeralAta(owner.publicKey, token.mint)[0];
  shown(
    "undelegate",
    await send(rollup, undelegateIx(owner.publicKey, token.mint), owner),
  );
  await until(
    async () =>
      !(await on.solana.getAccountInfo(balance))?.owner.equals(
        DELEGATION_PROGRAM_ID,
      ),
    "the balance to be handed back on Solana",
    HANDED_BACK_WITHIN_MS,
    2_000,
  );
  const info = await on.solana.getAccountInfo(balance);
  if (!info)
    throw new Error(
      "The owner's balance is not on Solana after the undelegate.",
    );
  const held = decodeEphemeralAta(info).amount;
  const instructions = await withdrawSpl(owner.publicKey, token.mint, held, {
    idempotent: false,
    payer: owner.publicKey,
    initAtasIfMissing: true,
  });
  shown("exit signature", await send(on.solana, instructions, owner));
  return held;
}

/**
 * Takes `atoms` out of the seat, into the owner's token account in the
 * rollup, and on to the owner's token account on Solana, and fails loudly if
 * the Solana balance did not rise by what was sent back. `from` set to
 * `rollup` skips the seat's withdrawal, for tokens that already sit in the
 * owner's balance in the rollup, as after a run whose second step failed.
 */
export async function exitedToSolana(
  l: Leaving,
  atoms: bigint,
  method: ExitMethod,
  from: ExitSource,
): Promise<Exited> {
  const { on, account, rollup } = l;
  const before = await tokenBalance(on.solana, account);
  shown("USDC on Solana", `${before} atoms before`);
  if (from === "seat") {
    await withdrawnToRollup(l, atoms);
  } else {
    const refusal = heldRefusal(await tokenBalance(rollup, account), atoms);
    if (refusal) throw new Error(refusal);
  }
  shown(
    "USDC in the rollup",
    `${await tokenBalance(rollup, account)} atoms in the owner's balance`,
  );
  const moved =
    method === "shuttle"
      ? await throughShuttle(l, atoms)
      : await throughUndelegate(l, atoms);
  const arrived = await until(
    async () => {
      const now = await tokenBalance(on.solana, account);
      return now - before >= moved ? now : false;
    },
    `the owner's token account on Solana to rise by ${moved} atoms`,
    ARRIVES_WITHIN_MS,
    2_000,
  ).catch(() => null);
  const after = arrived ?? (await tokenBalance(on.solana, account));
  shown("USDC on Solana", `${after} atoms after`);
  shown(
    "USDC in the rollup",
    `${await tokenBalance(rollup, account)} atoms in the owner's balance`,
  );
  const short = returnShortfall(before, after, moved);
  if (short) throw new Error(short);
  return { before, after, moved };
}

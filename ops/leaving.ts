/**
 * The exit back to Solana, shared by the exit and round-trip commands. The
 * program's `withdraw` pays collateral into the owner's token account inside
 * the rollup and stops there; the token program then carries the balance from
 * the rollup to the owner's token account on Solana. Every step is signed by
 * the owner's own key. Nothing here can move tokens for another owner: the
 * program pays out to its owner only, and the token program's withdrawal
 * asks the owner's signature too.
 */
import { randomBytes } from "crypto";
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
import {
  adminKeyPath,
  depositingAs,
  rollupIsRunBy,
  type Target,
} from "./deployment";
import {
  type BalanceOnSolana,
  handBackStep,
  heldRefusal,
  isStaleMark,
  rollupBalanceStep,
  returnShortfall,
  sealedBalanceRefusal,
  seatWithdrawalFailure,
  seatWithdrawalUnconfirmed,
  SOLANA_EXIT_LAMPORTS,
  solanaFeePayer,
  type ExitMethod,
  type ExitSource,
} from "./exiting";
import {
  clearExit,
  exitBookPath,
  exitOperation,
  readExit,
  seatPendingRefusal,
  seatVerdict,
  solanaPendingRefusal,
  solanaVerdict,
  writeExit,
  type ExitOperation,
  type SeatSend,
  type SolanaSend,
} from "./exitbook";
import { heldKey, readingAs } from "./keys";
import { refusedOnChain } from "./launch";
import { exchangeInRollup, perpMarketIds } from "./market";
import { deployedAsBuilt } from "./program";
import { quoteRefusal } from "./seating";
import {
  retried,
  send,
  sendOnSolana,
  simulatedError,
  sleep,
  until,
} from "./sending";
import { tokenBalance } from "./tokens";

const HANDED_BACK_WITHIN_MS = 180_000;
const ARRIVES_WITHIN_MS = 180_000;
const SHOWN_IN_ROLLUP_WITHIN_MS = 30_000;
/** Longer than the crank's push interval, so a mark that has just gone stale is waited out. */
const FRESH_MARK_WITHIN_MS = 240_000;
const FRESH_MARK_POLL_MS = 10_000;

export const shown = (label: string, value: string) =>
  console.log(`${label.padEnd(20)}${value}`);

/** What an exit works with: the owner, the quote token, and the owner's token account, which has one address on Solana and in the rollup. */
export type Leaving = {
  on: Target;
  owner: Keypair;
  /** Pays for the transactions on Solana: the owner when it holds SOL there, else the test network's admin key. */
  payer: Keypair;
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

/**
 * Checks the deployment is the one built and the quote token is one `owner`
 * can exit, and gathers what the exit needs. `lamportsNeeded` is what the
 * steps on Solana cost their payer: the exit's, or more where the command also
 * moves the tokens in (the round trip).
 */
export async function leavingAs(
  on: Target,
  owner: Keypair,
  lamportsNeeded = SOLANA_EXIT_LAMPORTS,
): Promise<Leaving> {
  await deployedAsBuilt(on);
  await rollupIsRunBy(on);
  const exchange = await exchangeInRollup(on);
  const token = exchange.tokens[exchange.collateralToken];
  if (token.mint.equals(PublicKey.default)) {
    throw new Error("The quote token is not registered. Run setup first.");
  }
  const refusal = quoteRefusal(on, token.mint);
  if (refusal) throw new Error(refusal);
  const adminKey = adminKeyPath(on);
  const adminCanPay = !on.mainnet && existsSync(adminKey);
  const payer =
    solanaFeePayer(
      await on.solana.getBalance(owner.publicKey),
      adminCanPay,
      owner.publicKey,
      lamportsNeeded,
    ) === "owner"
      ? owner
      : heldKey(adminKey);
  return {
    on,
    owner,
    payer,
    token,
    decimals: (await getMint(on.solana, token.mint)).decimals,
    account: getAssociatedTokenAddressSync(token.mint, owner.publicKey, true),
    rollup: await depositingAs(on, owner),
  };
}

/** The keys besides the payer that sign a transaction on Solana: the owner's, unless the owner pays. */
const signingFor = ({ owner, payer }: Leaving): Keypair[] =>
  payer.publicKey.equals(owner.publicKey) ? [] : [owner];

/** The owner's balance account on Solana: its atoms and whether a rollup holds it, or null before one was made. */
async function balanceOnSolana({
  on,
  owner,
  token,
}: Leaving): Promise<BalanceOnSolana> {
  const info = await retried(() =>
    on.solana.getAccountInfo(
      deriveEphemeralAta(owner.publicKey, token.mint)[0],
    ),
  );
  return info
    ? {
        delegated: info.owner.equals(DELEGATION_PROGRAM_ID),
        amount: decodeEphemeralAta(info).amount,
      }
    : null;
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
  const balance = deriveEphemeralAta(owner.publicKey, token.mint)[0];
  const record = await getDelegationRecord(on.solana, balance);
  const step = rollupBalanceStep(
    (await on.solana.getAccountInfo(balance)) !== null,
    record.status === DelegationStatus.Delegated ? record.validator : null,
    on.validator,
  );
  if (step !== "wait") {
    const sealed = sealedBalanceRefusal(
      token.custodyVisibility,
      owner.publicKey,
    );
    if (sealed) throw new Error(sealed);
    const signature = await sendOnSolana(
      on.solana,
      step === "create"
        ? [
            createAssociatedTokenAccountIdempotentInstruction(
              l.payer.publicKey,
              account,
              owner.publicKey,
              token.mint,
            ),
            initEphemeralAtaIx(
              balance,
              owner.publicKey,
              token.mint,
              l.payer.publicKey,
            ),
            delegateEphemeralAtaIx(l.payer.publicKey, balance, on.validator),
          ]
        : delegateEphemeralAtaIx(l.payer.publicKey, balance, on.validator),
      l.payer,
      signingFor(l),
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

/** The exit under way and where its record is kept (`ops/exitbook.ts`). */
export type Book = { path: string; op: ExitOperation };

const saved = (book: Book) => writeExit(book.path, book.op);

/** The record of this owner's exit: the unfinished one when it asked for the same, else a new one, written before anything is sent. */
function bookFor(l: Leaving, atoms: bigint, method: ExitMethod): Book {
  const path = exitBookPath(l.on.keysDir, l.on.network, l.owner.publicKey);
  const op = exitOperation(readExit(path), {
    id: randomBytes(4).toString("hex"),
    owner: l.owner.publicKey.toBase58(),
    atoms,
    method,
  });
  const book = { path, op };
  saved(book);
  return book;
}

/**
 * What a Solana send writes down once it is signed and before it is
 * broadcast: its own signature, derived from the signed bytes, and the block
 * height after which it can no longer land, so a response lost in the
 * broadcast cannot leave a transaction that may have landed unknown.
 */
const writtenBefore =
  (book: Book, step: string, before: bigint, moved: bigint) =>
  (signature: string, lastValidBlockHeight: number) => {
    book.op.solana.push({
      signature,
      lastValidBlockHeight,
      step,
      at: new Date().toISOString(),
      before: before.toString(),
      moved: moved.toString(),
    });
    saved(book);
  };

/**
 * Reconciles the Solana sends an earlier run wrote down against Solana before
 * this one builds another: one that landed is returned, so only its arrival
 * is checked; one that failed or can never land is dropped; one that may still
 * land, or that was only ever seen as processed, stops the run. A read that fails stops it too.
 */
export async function reconciledSolana(
  l: Pick<Leaving, "on">,
  book: Book,
): Promise<SolanaSend | null> {
  const keep: SolanaSend[] = [];
  let landed: SolanaSend | null = null;
  for (const send of book.op.solana) {
    const verdict = await solanaVerdict(
      l.on.solana,
      send,
      process.env.EXIT_SENT,
    );
    if (send.everProcessed) saved(book);
    if (verdict === "landed") {
      landed = send;
      keep.push(send);
    } else if (verdict === "wait") {
      throw new Error(
        solanaPendingRefusal(
          send,
          await l.on.solana.getBlockHeight("confirmed"),
        ),
      );
    }
  }
  book.op.solana = landed ? keep : [];
  saved(book);
  return landed;
}

/**
 * The seat's withdrawal, once: not again where the record shows it landed or
 * the rollup shows the owner's balance rose by it, and not at all where its
 * outcome is unknown until the operator answers for that record.
 */
async function seatWithdrawn(
  l: Leaving,
  atoms: bigint,
  book: Book,
): Promise<void> {
  const rollupNow = await tokenBalance(l.rollup, l.account);
  const verdict = seatVerdict(
    book.op.seat,
    atoms,
    rollupNow,
    process.env.EXIT_SENT,
  );
  if (verdict === "ask" && book.op.seat) {
    throw new Error(seatPendingRefusal(book.op.seat, rollupNow));
  }
  if (verdict === "landed") {
    shown(
      "seat withdrawal",
      "recorded as landed by an earlier run: not withdrawn again",
    );
    if (book.op.seat?.state === "pending") {
      book.op.seat = { ...book.op.seat, state: "landed" };
      saved(book);
    }
    return;
  }
  await withdrawnToRollup(l, atoms, book);
}

/**
 * Pays `atoms` of the seat's collateral into the owner's token account in the
 * rollup, simulated first so a refusal sends nothing, and waits until the
 * rollup shows it there. It is recorded before it is sent.
 */
async function withdrawnToRollup(
  l: Leaving,
  atoms: bigint,
  book: Book,
): Promise<void> {
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
  const waitUntil = Date.now() + FRESH_MARK_WITHIN_MS;
  let failed: string | null;
  for (;;) {
    failed = await simulatedError(rollup, [withdrawal], owner).catch(
      (error: Error) => {
        throw new Error(
          `The endpoint did not simulate the withdrawal (${error.message.split("\n")[0]}), so it is not sent. Nothing was sent.`,
        );
      },
    );
    if (!isStaleMark(failed) || Date.now() > waitUntil) break;
    shown("seat withdrawal", "waiting for the crank to push a fresh mark");
    await sleep(FRESH_MARK_POLL_MS);
  }
  if (failed !== null) throw new Error(seatWithdrawalFailure(failed));
  const expected = held + atoms;
  const pending: SeatSend = {
    state: "pending",
    at: new Date().toISOString(),
    id: randomBytes(4).toString("hex"),
    before: held.toString(),
  };
  book.op.seat = pending;
  saved(book);
  shown(
    "seat withdrawal",
    await send(rollup, withdrawal, owner).catch((error: Error) => {
      if (!refusedOnChain(error.message)) {
        throw new Error(seatWithdrawalUnconfirmed(error.message, expected));
      }
      book.op.seat = undefined;
      saved(book);
      throw error;
    }),
  );
  await until(
    async () => (await tokenBalance(rollup, account)) >= expected,
    `the rollup to show ${expected} atoms in the owner's token account`,
    SHOWN_IN_ROLLUP_WITHIN_MS,
  ).catch((error: Error) => {
    throw new Error(seatWithdrawalUnconfirmed(error.message, expected));
  });
  book.op.seat = { ...pending, state: "landed" };
  saved(book);
}

/** The token program's shuttle withdrawal: exactly `atoms` go to Solana and the owner's balance stays in the rollup. */
async function throughShuttle(
  l: Leaving,
  atoms: bigint,
  book: Book,
  before: bigint,
): Promise<bigint> {
  const { on, owner, token, payer } = l;
  const instructions = await withdrawSpl(owner.publicKey, token.mint, atoms, {
    validator: on.validator,
    payer: payer.publicKey,
    initAtasIfMissing: true,
  });
  shown(
    "exit signature",
    await sendOnSolana(
      on.solana,
      instructions,
      payer,
      signingFor(l),
      writtenBefore(book, "shuttle", before, atoms),
    ),
  );
  return atoms;
}

/** Withdraws the balance that is back on Solana, all of it, to the owner's token account there. Returns what it withdrew. */
async function withdrawnOnSolana(
  l: Leaving,
  atoms: bigint,
  book: Book,
  before: bigint,
): Promise<bigint> {
  const { on, owner, token, payer } = l;
  const back = await balanceOnSolana(l);
  if (!back || back.delegated || back.amount < atoms) {
    throw new Error(
      "The owner's balance is not on Solana and undelegated, so there is nothing to withdraw there yet. Nothing was sent.",
    );
  }
  const instructions = await withdrawSpl(
    owner.publicKey,
    token.mint,
    back.amount,
    { idempotent: false, payer: payer.publicKey, initAtasIfMissing: true },
  );
  shown(
    "exit signature",
    await sendOnSolana(
      on.solana,
      instructions,
      payer,
      signingFor(l),
      writtenBefore(book, "withdraw", before, back.amount),
    ),
  );
  return back.amount;
}

/**
 * The token program's two steps: the owner's whole balance is undelegated in
 * the rollup and handed back to Solana, then withdrawn there. It leaves the
 * balance undelegated, which the next exit delegates again. Returns what it
 * withdrew, which is everything the owner held in the rollup.
 */
async function throughUndelegate(
  l: Leaving,
  atoms: bigint,
  book: Book,
  before: bigint,
): Promise<bigint> {
  const { owner, token, account, rollup } = l;
  const step = handBackStep(
    await balanceOnSolana(l),
    await tokenBalance(rollup, account),
    atoms,
  );
  if (step === "undelegate") {
    shown(
      "undelegate",
      await send(rollup, undelegateIx(owner.publicKey, token.mint), owner),
    );
    await until(
      async () => {
        const back = await balanceOnSolana(l);
        return back !== null && !back.delegated;
      },
      "the balance to be handed back on Solana",
      HANDED_BACK_WITHIN_MS,
      2_000,
    );
  } else {
    shown("undelegate", "not sent: the balance is already back on Solana");
  }
  return withdrawnOnSolana(l, atoms, book, before);
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
  const onSolana = () => retried(() => tokenBalance(on.solana, account));
  const book = bookFor(l, atoms, method);
  shown("exit record", book.path);
  const landed = await reconciledSolana(l, book);
  const before = landed ? BigInt(landed.before) : await onSolana();
  shown("USDC on Solana", `${before} atoms before`);
  let moved: bigint;
  if (landed) {
    moved = BigInt(landed.moved);
    shown(
      "exit",
      `the ${landed.step} transaction ${landed.signature} of this exit landed: nothing more is sent, only its arrival is checked`,
    );
  } else {
    const found = from === "rollup" ? await balanceOnSolana(l) : null;
    const handedBack = found && !found.delegated && found.amount > 0n;
    if (from === "seat") {
      await seatWithdrawn(l, atoms, book);
    } else if (handedBack) {
      shown(
        "balance",
        `${found.amount} atoms are already back on Solana, undelegated: only the withdrawal there is left`,
      );
    } else {
      const refusal = heldRefusal(await tokenBalance(rollup, account), atoms);
      if (refusal) throw new Error(refusal);
    }
    shown(
      "USDC in the rollup",
      `${await tokenBalance(rollup, account)} atoms in the owner's balance`,
    );
    moved = handedBack
      ? await withdrawnOnSolana(l, atoms, book, before)
      : method === "shuttle"
        ? await throughShuttle(l, atoms, book, before)
        : await throughUndelegate(l, atoms, book, before);
  }
  const arrived = await until(
    async () => {
      const now = await onSolana();
      return now - before >= moved ? now : false;
    },
    `the owner's token account on Solana to rise by ${moved} atoms`,
    ARRIVES_WITHIN_MS,
    2_000,
  ).catch(() => null);
  const after = arrived ?? (await onSolana());
  shown("USDC on Solana", `${after} atoms after`);
  shown(
    "USDC in the rollup",
    `${await tokenBalance(rollup, account)} atoms in the owner's balance`,
  );
  const short = returnShortfall(before, after, moved);
  if (short) throw new Error(short);
  clearExit(book.path);
  return { before, after, moved };
}

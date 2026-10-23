/**
 * What the exit commands decide, apart from the network so it can be checked
 * without one: what was asked for, how an amount of tokens becomes atoms,
 * what to do about the owner's token account in the rollup, and what each way
 * of failing means for the tokens. The exit is the owner's: every step is
 * signed by the key of the seat, and nothing here moves tokens for anyone
 * else.
 */
import { type PublicKey } from "@solana/web3.js";
import { type CustodyVisibility } from "../sdk/dist/index.js";
import { CUSTODY_CAP_REACHED, NO_SEAT } from "./funding";
import { errorCode } from "./upkeep";

/**
 * How the tokens leave the rollup. `shuttle` is the token program's own
 * withdrawal: it carries exactly the amount out and leaves the owner's
 * balance in the rollup. `undelegate` is its older two steps: it hands the
 * owner's whole balance back to Solana and withdraws that.
 */
export const EXIT_METHODS = ["shuttle", "undelegate"] as const;
export type ExitMethod = (typeof EXIT_METHODS)[number];

/** Where the tokens start: the seat's collateral, or what the owner already holds in the rollup. */
export const EXIT_SOURCES = ["seat", "rollup"] as const;
export type ExitSource = (typeof EXIT_SOURCES)[number];

/** What a round trip puts into the seat when no amount is given, in whole tokens. */
export const ROUND_TRIP_DEFAULT = "0.01";
/** The most a round trip takes, in whole tokens: it is a proof, done with dust. */
const ROUND_TRIP_MOST_TOKENS = 2n;

const U64_MAX = 2n ** 64n - 1n;

type Settings = Record<string, string | undefined>;

export type ExitRequest = {
  /** The file the owner's key is kept in. */
  keyFile: string;
  /** Whole tokens, as written. */
  amount: string;
  method: ExitMethod;
  from: ExitSource;
};

export type RoundTripRequest = Omit<ExitRequest, "from">;

function oneOf<T extends string>(
  name: string,
  value: string | undefined,
  known: readonly T[],
  otherwise: T,
): T {
  if (value === undefined || value === "") return otherwise;
  const found = known.find((each) => each === value);
  if (!found) {
    throw new Error(
      `${name} is ${value}; use one of: ${known.join(", ")}. Nothing was sent.`,
    );
  }
  return found;
}

function keyFileSetting(settings: Settings): string {
  const keyFile = settings.KEYFILE;
  if (keyFile === undefined || keyFile === "") {
    throw new Error(
      "Set KEYFILE to the file the owner's key is kept in. Nothing was sent.",
    );
  }
  return keyFile;
}

/** What was asked for, refused unless the key and the amount are plainly given and the method and source are known. */
export function exitRequest(settings: Settings): ExitRequest {
  if (settings.AMOUNT === undefined || settings.AMOUNT === "") {
    throw new Error("Set AMOUNT to the tokens to exit. Nothing was sent.");
  }
  return {
    keyFile: keyFileSetting(settings),
    amount: settings.AMOUNT,
    method: oneOf("METHOD", settings.METHOD, EXIT_METHODS, "shuttle"),
    from: oneOf("FROM", settings.FROM, EXIT_SOURCES, "seat"),
  };
}

/** What was asked for: the amount is dust unless given, and the tokens always start in the seat. */
export function roundTripRequest(settings: Settings): RoundTripRequest {
  return {
    keyFile: keyFileSetting(settings),
    amount: settings.AMOUNT || ROUND_TRIP_DEFAULT,
    method: oneOf("METHOD", settings.METHOD, EXIT_METHODS, "shuttle"),
  };
}

/**
 * `amount`, whole tokens with an optional fraction, in atoms of a token of
 * `decimals`. Refused unless it is plainly a number above zero that the token
 * can hold, so 0.0000001 of a token of 6 decimals is not rounded to nothing.
 */
export function tokenAtoms(amount: string, decimals: number): bigint {
  const parts = /^(\d+)(?:\.(\d+))?$/.exec(amount);
  if (!parts) {
    throw new Error(
      `AMOUNT is ${amount}, which is not a number of tokens such as 5 or 0.25. Nothing was sent.`,
    );
  }
  const fraction = parts[2] ?? "";
  if (fraction.length > decimals) {
    throw new Error(
      `AMOUNT is ${amount}, with more decimal places than the token has (${decimals}). Nothing was sent.`,
    );
  }
  const atoms =
    BigInt(parts[1]) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0") || "0");
  if (atoms === 0n || atoms > U64_MAX) {
    throw new Error(
      `AMOUNT is ${amount}, which is not an amount above zero that a balance can hold. Nothing was sent.`,
    );
  }
  return atoms;
}

/** Why a round trip may not take `atoms`, or null: it is a proof with dust, not a transfer. */
export function roundTripRefusal(
  atoms: bigint,
  decimals: number,
): string | null {
  const most = ROUND_TRIP_MOST_TOKENS * 10n ** BigInt(decimals);
  return atoms <= most
    ? null
    : `A round trip is a proof done with dust: it takes ${ROUND_TRIP_MOST_TOKENS} tokens at the most, and ${atoms} atoms is more. Use the exit target to move more. Nothing was sent.`;
}

/**
 * What to do about the owner's token account, which the program's withdrawal
 * pays into and the rollup must already show, when it does not:
 * `create` the owner's ephemeral balance on Solana and delegate it,
 * `delegate` one that exists on Solana but was handed back to it, or `wait`
 * for the rollup to show one that is delegated to this rollup already. A
 * balance delegated to another rollup is refused, since only its owner could
 * undo that.
 */
export function rollupBalanceStep(
  existsOnSolana: boolean,
  delegatedTo: PublicKey | null,
  validator: PublicKey,
): "create" | "delegate" | "wait" {
  if (delegatedTo && !delegatedTo.equals(validator)) {
    throw new Error(
      `The owner's balance is delegated to ${delegatedTo.toBase58()}, not to this rollup (${validator.toBase58()}). Nothing was sent.`,
    );
  }
  if (delegatedTo) return "wait";
  return existsOnSolana ? "delegate" : "create";
}

/** Why the owner's balance cannot be made in a sealed custody's rollup, or null: a sealed balance is made by the deposit's own move. */
export function sealedBalanceRefusal(
  visibility: CustodyVisibility,
  owner: PublicKey,
): string | null {
  return visibility === "public"
    ? null
    : `${owner.toBase58()} has no token account in the rollup for the withdrawal to pay into, and this exchange's custody is sealed, so one cannot be made here. Deposit a little first to make it. Nothing was sent.`;
}

/**
 * What the exit's steps on Solana cost their fee payer, in lamports: the
 * transaction fee and the rent of the accounts the token program makes (the
 * owner's token account, and the shuttle's). Generous on purpose, since a
 * payer that falls short fails every step there.
 */
export const SOLANA_EXIT_LAMPORTS = 10_000_000;

/**
 * What the round trip's steps on Solana cost their fee payer: the move into
 * the rollup (the balance account's rent and the vault, when no earlier move
 * made them) as well as the exit's own shuttle, so about 0.03 SOL, three
 * times the exit's.
 */
export const ROUND_TRIP_LAMPORTS = 30_000_000;

/**
 * Who pays for the exit's transactions on Solana. They are the owner's to
 * pay: the owner's own key signs them, and the rollup charges no fee, so a
 * seat funded from another key can hold tokens and still no SOL. Without
 * SOL a transaction on Solana never executes and is never shown anywhere,
 * so this is decided before anything is sent. `admin` is the test network's
 * key, which pays when the owner cannot; mainnet has none, and the owner is
 * then told what to send. `needed` is what the steps cost: the exit's by
 * default, the round trip's when it does the move in as well.
 */
export function solanaFeePayer(
  ownerLamports: number,
  adminCanPay: boolean,
  owner: PublicKey,
  needed = SOLANA_EXIT_LAMPORTS,
): "owner" | "admin" {
  if (ownerLamports >= needed) return "owner";
  if (adminCanPay) return "admin";
  return fail(
    `${owner.toBase58()} holds ${ownerLamports} lamports on Solana, and the steps there need about ${needed} for fees and rent. ` +
      "Send it that much SOL and run this again. Nothing was sent.",
  );
}

function fail(message: string): never {
  throw new Error(message);
}

/** Where the owner's balance stands on Solana: the balance account's atoms, and whether it is delegated to a rollup. */
export type BalanceOnSolana = { delegated: boolean; amount: bigint } | null;

/**
 * What the token program's older exit does next, read from the balance on
 * Solana and in the rollup, so a run that stopped half way is carried on
 * rather than begun again: `undelegate` while the balance is in the rollup,
 * `withdraw` once it is back on Solana and undelegated. A balance back on
 * Solana that holds less than asked is refused, since sending nothing is
 * better than withdrawing a different amount.
 */
export function handBackStep(
  onSolana: BalanceOnSolana,
  inRollup: bigint,
  atoms: bigint,
): "undelegate" | "withdraw" {
  if (onSolana && !onSolana.delegated) {
    if (onSolana.amount >= atoms) return "withdraw";
    return fail(
      `The owner's balance is back on Solana and holds ${onSolana.amount} atoms, fewer than the ${atoms} asked for` +
        (onSolana.amount === 0n ? ": it may already have been withdrawn" : "") +
        ". Nothing was sent.",
    );
  }
  const refusal = heldRefusal(inRollup, atoms);
  return refusal ? fail(refusal) : "undelegate";
}

/** Why the owner's rollup balance cannot be exited, or null: it must hold what is asked. */
export function heldRefusal(held: bigint, atoms: bigint): string | null {
  return held >= atoms
    ? null
    : `The owner holds ${held} atoms in the rollup, fewer than the ${atoms} asked for. Nothing was sent.`;
}

/** The program's `StalePrice`, as a failed transaction reports it. */
const STALE_PRICE = 6038;

/** Whether a simulated failure is the mark being stale, which the crank's next push mends. */
export function isStaleMark(failed: string | null): boolean {
  return failed !== null && errorCode(failed) === STALE_PRICE;
}

/**
 * Why the withdrawal from the seat would fail, in the operator's terms; the
 * error itself where it is not one the program's code names.
 */
export function seatWithdrawalFailure(failed: string): string {
  return `The withdrawal would fail with ${failed}, so it is not sent: the seat may hold less than that free of margin, or the market may refuse withdrawals now (a price incident, a recorded shortfall, or a stale mark for a seat holding a position). Nothing was sent.`;
}

/**
 * What to tell the operator when the seat's withdrawal was sent but this run
 * could not confirm it: it may have landed, so a plain run of the exit again
 * would withdraw from the seat a second time. `expected` is the balance the
 * owner's token account in the rollup shows once it has landed, `detail` what
 * the send or the wait said.
 */
export function seatWithdrawalUnconfirmed(
  detail: string,
  expected: bigint,
): string {
  return (
    `The seat's withdrawal was sent, but this run could not confirm it (${detail.split("\n")[0]}), so it may have landed. ` +
    "It is recorded with the keys before it was sent: run the exit target again with the same KEYFILE and AMOUNT, which reads the owner's token account in the rollup and that record before it builds anything, " +
    "and never withdraws from the seat a second time for the same exit. " +
    `The rollup shows ${expected} atoms in the owner's token account once it has landed (for the house maker, SEAT=show prints the balance as USDC in the rollup); ` +
    "if it still has not after a few minutes, the run asks for EXIT_SENT=landed:<id> or lost:<id> and says which record to look at."
  );
}

/** What a failed dust deposit means, in the operator's terms; the error itself when the program's code is not one it knows. */
export function roundTripDepositFailure(
  message: string,
  owner: PublicKey,
): Error {
  const code = errorCode(message);
  if (code === CUSTODY_CAP_REACHED) {
    return new Error(
      "The custody cap refused the deposit. Raise it with CUSTODY_CAP on the setup target, then run this again; this command never raises it. " +
        "Nothing was deposited; whatever moved into the rollup stays in the owner's balance there, and the exit target with FROM=rollup takes it back to Solana.",
    );
  }
  if (code === NO_SEAT) {
    return new Error(
      `${owner.toBase58()} has no open seat on this exchange. The gate opens a seat; then run this again. Nothing was deposited.`,
    );
  }
  return new Error(`The deposit was refused: ${message}`);
}

/**
 * Why the tokens did not come back, or null. The Solana balance has to rise
 * by what was moved; if it has not, the tokens are in the rollup or on their
 * way, not gone, and the message says where to look and what to run.
 */
export function returnShortfall(
  before: bigint,
  after: bigint,
  moved: bigint,
): string | null {
  const gained = after - before;
  if (gained >= moved) return null;
  return (
    `The Solana balance went from ${before} to ${after} atoms, ${moved - gained} short of the ${moved} that were sent back. ` +
    "The tokens are not lost by this alone: they are in the owner's balance in the rollup or still on their way. " +
    "Look at the signatures above, wait a minute, and read the balance again. If it has not come, run the exit target with FROM=rollup to send what is left."
  );
}

/** Why a round trip lost tokens, or null: the owner must end with at least what it started with on Solana. */
export function roundTripLoss(start: bigint, end: bigint): string | null {
  return end >= start
    ? null
    : `The round trip is short: the owner held ${start} atoms on Solana before it and holds ${end} after, ${start - end} fewer. The exit is not proven. Do not raise any cap.`;
}

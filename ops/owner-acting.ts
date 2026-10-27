/**
 * What the owner-actions check decides, apart from the network so it can be
 * checked without one: how much it funds, what each refusal must be called,
 * and the line each step prints. The check uses a throwaway owner key held in
 * memory only, so nothing here reads or writes a key file.
 */
import { OWNER_TRANSACTION_ERROR } from "../sdk/dist/index.js";
import { ROUND_TRIP_DEFAULT } from "./exiting";
import { errorCode } from "./upkeep";

/** `InvalidOwnerProof`: the proof before the instruction does not match this action. */
export const INVALID_OWNER_PROOF = OWNER_TRANSACTION_ERROR.invalidProof;
/** `WrongOwnerNonce`: the proof names a counter the view is no longer at. */
export const WRONG_OWNER_NONCE = OWNER_TRANSACTION_ERROR.wrongNonce;
/** `OwnerExpiryTooFar`: the proof expires more than the program's limit ahead. */
export const OWNER_EXPIRY_TOO_FAR = OWNER_TRANSACTION_ERROR.expiryTooFar;
/** `WrongWithdrawDestination`: an order key may withdraw only to the owner's associated token account. */
export const WRONG_WITHDRAW_DESTINATION =
  OWNER_TRANSACTION_ERROR.wrongWithdrawDestination;

/** The program's owner-action refusals by number, as the check names them. */
export const OWNER_ERRORS: Record<number, string> = {
  [INVALID_OWNER_PROOF]: "InvalidOwnerProof",
  [WRONG_OWNER_NONCE]: "WrongOwnerNonce",
  [OWNER_EXPIRY_TOO_FAR]: "OwnerExpiryTooFar",
  [WRONG_WITHDRAW_DESTINATION]: "WrongWithdrawDestination",
};

/** How long a proof the check signs lives, in seconds; the program takes 120 at the most. */
export const PROOF_LIFETIME_SECONDS = 90;

/** How far ahead the too-far proof expires, in seconds: past the limit with room for a slow clock. */
export const TOO_FAR_SECONDS = 150;

/**
 * The tokens to fund the throwaway seat with, in whole tokens as written, or
 * null for none. A rehearsal funds the default dust. Mainnet funds nothing and
 * refuses an `AMOUNT`: the tokens there are real and the owner key is not
 * kept, so they could not be taken back out.
 */
export function fundingAmount(
  settings: Record<string, string | undefined>,
  mainnet: boolean,
): string | null {
  if (mainnet) {
    if (settings.AMOUNT) {
      throw new Error(
        "AMOUNT is refused on mainnet: the throwaway owner's key is not kept, so tokens sent to it could not be taken back. Run it without AMOUNT. Nothing was sent.",
      );
    }
    return null;
  }
  return settings.AMOUNT || ROUND_TRIP_DEFAULT;
}

/** The program's name for a failed send's text, or its number, or "no program error". */
export function refusalName(message: string): string {
  const code = errorCode(message);
  if (code === null) return "no program error";
  return OWNER_ERRORS[code] ? `${OWNER_ERRORS[code]} (${code})` : `${code}`;
}

export type Verdict = { pass: boolean; detail: string };

/**
 * Whether a send that had to be refused was refused for `wanted`. `message`
 * is the failed send's text, or null when the send was accepted. A refusal
 * for any other reason fails the step: on a rollup that cannot read the
 * proof, every owner action is refused, and only the number tells that apart
 * from the refusal the step is proving.
 */
export function refusalVerdict(
  wanted: number,
  message: string | null,
): Verdict {
  const expected = OWNER_ERRORS[wanted] ?? `${wanted}`;
  if (message === null) {
    return {
      pass: false,
      detail: `accepted, expected ${expected} (${wanted})`,
    };
  }
  const found = errorCode(message);
  return found === wanted
    ? { pass: true, detail: `refused with ${expected} (${wanted})` }
    : {
        pass: false,
        detail: `refused with ${refusalName(message)}, expected ${expected} (${wanted})`,
      };
}

/** One line of the check: the status, the step and what it found. */
export const stepLine = (
  status: "PASS" | "FAIL" | "SKIP",
  step: string,
  detail: string,
) => `${status.padEnd(5)}${step}: ${detail}`;

/** Whether two lists of keys, as base58 text, name the same keys in the same places. */
export const sameKeys = (a: string[], b: string[]) =>
  a.length === b.length && a.every((key, place) => key === b[place]);

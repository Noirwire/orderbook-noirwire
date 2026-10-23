/**
 * What the seat command decides, apart from the network so it can be checked
 * without one: which step of the house maker's seat was asked for, and when it
 * is refused. The seat is the maker's only: its owner is always the key kept
 * as the maker, its balance is collateral in the quote token, and nothing is
 * ever paid to anyone else.
 */
import { PublicKey } from "@solana/web3.js";
import { MAINNET_USDC_MINT } from "../sdk/dist/operator/index.js";
import { CUSTODY_CAP_REACHED, NO_SEAT, wholeTokens } from "./funding";
import type { CustodyHeld } from "./launch";
import { errorCode } from "./upkeep";

export const SEAT_COMMANDS = ["show", "open", "deposit", "withdraw"] as const;
export type SeatCommand = (typeof SEAT_COMMANDS)[number];

export type SeatRequest =
  | { command: "show" }
  | { command: "open" }
  | {
      command: "deposit" | "withdraw";
      /** Whole quote tokens. */
      tokens: bigint;
    };

type Settings = Record<string, string | undefined>;

/** What was asked for, refused unless the step is one of the four and a deposit or withdrawal has an amount. */
export function seatRequest(settings: Settings): SeatRequest {
  const asked = settings.SEAT;
  if (asked === undefined || asked === "") {
    throw new Error(
      `Set SEAT to one of: ${SEAT_COMMANDS.join(", ")}. Nothing was sent.`,
    );
  }
  const command = SEAT_COMMANDS.find((each) => each === asked);
  if (!command) {
    throw new Error(
      `SEAT is ${asked}; use one of: ${SEAT_COMMANDS.join(", ")}. Nothing was sent.`,
    );
  }
  if (command === "show" || command === "open") return { command };
  return { command, tokens: wholeTokens(settings.AMOUNT) };
}

/** Why the maker's key may not be used, or null: it must hold no other role on the exchange. */
export function makerRefusal(
  maker: PublicKey,
  exchange: { admin: PublicKey; gate: PublicKey; oracle: PublicKey },
): string | null {
  const roles = (["admin", "gate", "oracle"] as const).filter((role) =>
    exchange[role].equals(maker),
  );
  return roles.length === 0
    ? null
    : `The maker's key ${maker.toBase58()} is the exchange's ${roles[0]}. The house maker is a hot key that holds only its own capital: give it a key of its own. Nothing was sent.`;
}

/** Why the seat may not be funded in this quote token, or null: on mainnet it is USDC. */
export function quoteRefusal(
  on: { mainnet: boolean },
  mint: PublicKey,
  seat = "the maker's seat",
): string | null {
  return !on.mainnet || mint.equals(MAINNET_USDC_MINT)
    ? null
    : `The exchange's quote token is ${mint.toBase58()}, not USDC (${MAINNET_USDC_MINT.toBase58()}), and ${seat} is funded in USDC only. Nothing was sent.`;
}

/** Why the key kept as the gate cannot open the seat, or null: it must be the exchange's gate. */
export function gateRefusal(
  exchangeGate: PublicKey,
  kept: PublicKey,
  keyFile: string,
): string | null {
  return exchangeGate.equals(kept)
    ? null
    : `The exchange's gate is ${exchangeGate.toBase58()}, not the key at ${keyFile} (${kept.toBase58()}): the gate that opens a seat is the launch's gate key. Put it in place. Nothing was sent.`;
}

/**
 * Why custody cannot pay out `atoms`, or null; `held` is what public custody
 * holds, null where it is sealed and `"unreadable"` where it is public and the
 * rollup does not serve it. Only a balance that was read can refuse: where it
 * was not, the withdrawal's simulation and the program speak for it.
 */
export function withdrawRefusal(
  atoms: bigint,
  held: CustodyHeld,
): string | null {
  return held === null || held === "unreadable" || atoms <= held
    ? null
    : `Custody holds ${held} atoms, fewer than the ${atoms} asked for. Nothing was sent.`;
}

/** What a failed deposit means, in the operator's terms; the error itself when the program's code is not one it knows. */
export function seatDepositFailure(message: string): Error {
  const code = errorCode(message);
  if (code === CUSTODY_CAP_REACHED) {
    return new Error(
      "The custody cap refused the deposit. Raise it from the admin console or with CUSTODY_CAP on the setup target, then run this again; this command never raises it. " +
        "Nothing was deposited; the USDC moved into the rollup stays in the maker's balance there, and the next run uses it.",
    );
  }
  if (code === NO_SEAT) {
    return new Error(
      "The maker has no open seat. Run it with SEAT=open first. Nothing was deposited.",
    );
  }
  return new Error(`The deposit was refused: ${message}`);
}

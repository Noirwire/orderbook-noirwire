/**
 * What the fund command decides, apart from the network so it can be checked
 * without one: whom it funds and with how much, when it refuses to run, and
 * what the program's refusals of the deposit mean.
 */
import { type PublicKey } from "@solana/web3.js";
import type { DeploymentDescription, Profile } from "./deployment";
import { ownerKey } from "./accessing";
import { errorCode } from "./upkeep";

/** `CustodyCapReached`: the deposit would take custody above its cap. */
export const CUSTODY_CAP_REACHED = 6150;
/** `AccountMissing`: the deposit named a view that does not exist, so its owner has no seat. */
export const NO_SEAT = 6114;

const U64_MAX = 2n ** 64n - 1n;

export type FundRequest = {
  owner: PublicKey;
  /** Whole quote tokens. */
  tokens: bigint;
};

type Settings = Record<string, string | undefined>;

/** `AMOUNT` as a whole number of tokens above zero, refused unless it is plainly given. */
export function wholeTokens(amount: string | undefined): bigint {
  if (amount === undefined || amount === "") throw new Error("Set AMOUNT.");
  if (!/^\d+$/.test(amount) || BigInt(amount) === 0n) {
    throw new Error(
      `AMOUNT is ${amount}, which is not a whole number of tokens above zero.`,
    );
  }
  return BigInt(amount);
}

/** Whom to fund and with how many whole tokens, refused unless both are plainly given. */
export function fundRequest(settings: Settings): FundRequest {
  const owner = ownerKey("OWNER", settings.OWNER);
  return { owner, tokens: wholeTokens(settings.AMOUNT) };
}

/** The symbols the fund desk of the test service finds its collateral token under. */
export const FAUCET_QUOTE_SYMBOLS = ["nUSD", "USDC"];

/** Why nothing may be handed to a faucet here, or null. Faucet tokens are minted from nothing, so never on mainnet. */
export function faucetRefusal(on: { mainnet: boolean }): string | null {
  return on.mainnet
    ? "A faucet mints test tokens, so it is never set up on mainnet. Nothing was sent."
    : null;
}

/**
 * Why the description cannot name a faucet for this quote token, or null: it
 * must be the description of this program and list the token under a symbol
 * the fund desk looks for.
 */
export function faucetDescriptionRefusal(
  description: {
    programId: string;
    tokens: { mint: string; symbol: string }[];
  } | null,
  program: PublicKey,
  mint: PublicKey,
): string | null {
  if (!description) {
    return "There is no deployment description. Run setup first. Nothing was sent.";
  }
  if (description.programId !== program.toBase58()) {
    return `The description is of program ${description.programId}, not ${program.toBase58()}. Nothing was sent.`;
  }
  const token = description.tokens.find(
    (each) => each.mint === mint.toBase58(),
  );
  if (!token) {
    return `The description does not list the quote token ${mint.toBase58()}. Run setup again. Nothing was sent.`;
  }
  if (!FAUCET_QUOTE_SYMBOLS.includes(token.symbol)) {
    return `The quote token is listed as ${token.symbol}; the fund desk looks for ${FAUCET_QUOTE_SYMBOLS.join(" or ")}. Nothing was sent.`;
  }
  return null;
}

/**
 * The description with `faucet` set to the faucet's public key, placed after
 * `oracle` as the test profile writes it, and every other field exactly as it
 * was. Repeating it changes nothing.
 */
export function withFaucet(
  description: DeploymentDescription,
  faucet: PublicKey,
): DeploymentDescription {
  const named = Object.entries(description).flatMap(([field, value]) =>
    field === "faucet"
      ? []
      : field === "oracle"
        ? [
            [field, value],
            ["faucet", faucet.toBase58()],
          ]
        : [[field, value]],
  );
  if (!("oracle" in description)) named.push(["faucet", faucet.toBase58()]);
  return Object.fromEntries(named) as DeploymentDescription;
}

/** The custody cap, in whole tokens rounded up, that lets the faucet hand out all of `amount` on top of what custody holds. */
export function capNeededWhole(
  held: bigint,
  amount: bigint,
  decimals: number,
): bigint {
  const unit = 10n ** BigInt(decimals);
  return (held + amount + unit - 1n) / unit;
}

/** `tokens` whole tokens in atoms of a token of `decimals`, refused beyond what an amount can hold. */
export function fundingAtoms(tokens: bigint, decimals: number): bigint {
  const atoms = tokens * 10n ** BigInt(decimals);
  if (atoms > U64_MAX) {
    throw new Error(
      `AMOUNT is ${tokens} tokens, which is more atoms than an amount can hold.`,
    );
  }
  return atoms;
}

/** Why nothing may be funded here, or null. The tokens are minted from nothing, so never on mainnet. */
export function fundRefusal(on: { mainnet: boolean }): string | null {
  return on.mainnet
    ? "Funding mints test tokens, so it never runs on mainnet. Nothing was sent."
    : null;
}

/**
 * The refusal to mint for a quote token whose mint authority is not the
 * admin, which is any token that is not a test token. Null when it is.
 */
export function mintRefusal(
  mint: PublicKey,
  mintAuthority: PublicKey | null,
  admin: PublicKey,
): string | null {
  if (mintAuthority?.equals(admin)) return null;
  return `The quote token ${mint.toBase58()} has ${mintAuthority ? `${mintAuthority.toBase58()} as its mint authority` : "no mint authority"}, not the admin ${admin.toBase58()}, so it is not a test token the admin can mint. Nothing was sent.`;
}

/** Where a cap is set, by profile: the rehearsal's setup takes `CUSTODY_CAP`, a test network's cap is fixed. */
function capAdvice(profile: Profile): string {
  return profile === "mainnet"
    ? "Raise it with CUSTODY_CAP=<whole tokens> on the setup target (make rehearsal-setup CUSTODY_CAP=...), then run this again. This command never raises the cap."
    : "A test network's setup sets its cap to the faucet's whole supply (CUSTODY_CAP belongs to the rehearsal's setup target); this command never raises the cap.";
}

function capMessage(
  profile: Profile,
  detail: string,
  untouched: string,
): string {
  return `${detail} ${capAdvice(profile)} ${untouched}`;
}

/**
 * Why the deposit would pass the token's custody cap, or null. The cap counts
 * the whole custody account, insurance included. `held` is what custody holds
 * as far as it can be read: a custody the endpoint does not show reads as
 * zero, and the program's own refusal then speaks for it.
 */
export function capRefusal(
  profile: Profile,
  custody: { held: bigint; cap: bigint },
  amount: bigint,
): string | null {
  if (custody.held + amount <= custody.cap) return null;
  return capMessage(
    profile,
    `The deposit would take custody to ${custody.held + amount} atoms, past the cap of ${custody.cap}.`,
    "Nothing was minted or sent.",
  );
}

/** What a failed deposit means, in the operator's terms; the error itself when the program's code is not one it knows. */
export function depositFailure(
  message: string,
  on: { profile: Profile },
  owner: PublicKey,
): Error {
  const code = errorCode(message);
  if (code === CUSTODY_CAP_REACHED) {
    return new Error(
      capMessage(
        on.profile,
        "The custody cap refused the deposit.",
        "Nothing was deposited; the tokens minted for the admin stay in its balance in the rollup, and the next run uses them.",
      ),
    );
  }
  if (code === NO_SEAT) {
    return new Error(
      `${owner.toBase58()} has no open seat on this exchange. A trader opens its own seat through the gate; then run this again. Nothing was deposited; the tokens minted for the admin stay in its balance in the rollup, and the next run uses them.`,
    );
  }
  return new Error(`The deposit was refused: ${message}`);
}

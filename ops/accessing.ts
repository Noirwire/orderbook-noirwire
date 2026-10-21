/**
 * What the access command decides, apart from the network so it can be
 * checked without one: which command was asked for, and the markets, seat and
 * switches it names, each refused unless it is a value the program takes.
 */
import {
  ComputeBudgetProgram,
  PublicKey,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  MARKET_ACCESS,
  type Instructions,
  type MarketAccess,
  type SeatAccess,
} from "../sdk/dist/index.js";

export const ACCESS_COMMANDS = ["show", "market", "seat"] as const;
export type AccessCommand = (typeof ACCESS_COMMANDS)[number];

/** SECURITY.md: the most a transaction may use, which clearing a maker bit on a full book can need. */
export const SEAT_ACCESS_COMPUTE_UNITS = 1_400_000;

export type AccessRequest =
  | { command: "show"; owner: PublicKey | null }
  | { command: "market"; marketId: number; access: MarketAccess }
  | { command: "seat"; owner: PublicKey; access: SeatAccess };

type Settings = Record<string, string | undefined>;

function given(name: string, value: string | undefined): string {
  if (value === undefined || value === "") throw new Error(`Set ${name}.`);
  return value;
}

function oneOf<T extends string>(
  name: string,
  value: string | undefined,
  known: readonly T[],
): T {
  const text = given(name, value);
  const found = known.find((each) => each === text);
  if (!found) {
    throw new Error(`${name} is ${text}; use one of: ${known.join(", ")}.`);
  }
  return found;
}

export const accessCommand = (value: string | undefined): AccessCommand =>
  oneOf("ACCESS", value, ACCESS_COMMANDS);

/** `on` or `off`: whether a market's list is switched on. */
export const listSwitch = (name: string, value: string | undefined): boolean =>
  oneOf(name, value, ["on", "off"]) === "on";

/** `yes` or `no`. */
export const yesNo = (name: string, value: string | undefined): boolean =>
  oneOf(name, value, ["yes", "no"]) === "yes";

function marketNumber(name: string, text: string, perpIds: number[]): number {
  if (!/^(0|[1-9]\d*)$/.test(text)) {
    throw new Error(`${name} names ${text}, which is not a market id.`);
  }
  const id = Number(text);
  if (!perpIds.includes(id)) {
    throw new Error(
      `${name} names market ${id}, which is not a perp market of this exchange (perp markets: ${perpIds.join(", ") || "none"}).`,
    );
  }
  return id;
}

/** The perp market a command is about. */
export const perpMarketId = (
  name: string,
  value: string | undefined,
  perpIds: number[],
): number => marketNumber(name, given(name, value), perpIds);

/** The seat owner's public key. */
export function ownerKey(name: string, value: string | undefined): PublicKey {
  const text = given(name, value);
  try {
    const key = new PublicKey(text);
    if (key.toBase58() === text) return key;
  } catch {
    // reported below
  }
  throw new Error(`${name} is ${text}, which is not a public key.`);
}

/**
 * The bits for a seat's list: `none`, or a comma-separated list of perp
 * market ids, each once. Bit `m` stands for market `m`.
 */
export function marketBits(
  name: string,
  value: string | undefined,
  perpIds: number[],
): number {
  const text = given(name, value);
  if (text === "none") return 0;
  let bits = 0;
  for (const part of text.split(",")) {
    const id = marketNumber(name, part.trim(), perpIds);
    if (bits & (1 << id)) {
      throw new Error(`${name} names market ${id} twice.`);
    }
    bits |= 1 << id;
  }
  return bits;
}

/** The market ids in `bits`, rising. */
export const marketsIn = (bits: number): number[] =>
  Array.from({ length: 8 }, (_, id) => id).filter((id) => (bits >> id) & 1);

/** A market's two public switches, from the `access` byte it records. */
export const switchesOf = (access: number): MarketAccess => ({
  makersListed: (access & MARKET_ACCESS.makersListed) !== 0,
  takersListed: (access & MARKET_ACCESS.takersListed) !== 0,
});

/** "makers listed (on), takers listed (off)". */
export const switchesText = ({
  makersListed,
  takersListed,
}: MarketAccess): string =>
  `maker list ${makersListed ? "on" : "off"}, taker list ${takersListed ? "on" : "off"}`;

/** What was asked for, refused unless every value is one the program takes. */
export function accessRequest(
  settings: Settings,
  perpIds: number[],
): AccessRequest {
  const command = accessCommand(settings.ACCESS);
  if (command === "show") {
    const owner = settings.SEAT_OWNER
      ? ownerKey("SEAT_OWNER", settings.SEAT_OWNER)
      : null;
    return { command, owner };
  }
  if (command === "market") {
    return {
      command,
      marketId: perpMarketId("MARKET", settings.MARKET, perpIds),
      access: {
        makersListed: listSwitch("MAKERS", settings.MAKERS),
        takersListed: listSwitch("TAKERS", settings.TAKERS),
      },
    };
  }
  return {
    command,
    owner: ownerKey("SEAT_OWNER", settings.SEAT_OWNER),
    access: {
      makerMarkets: marketBits(
        "MAKER_MARKETS",
        settings.MAKER_MARKETS,
        perpIds,
      ),
      takerMarkets: marketBits(
        "TAKER_MARKETS",
        settings.TAKER_MARKETS,
        perpIds,
      ),
      blocked: yesNo("BLOCKED", settings.BLOCKED),
    },
  };
}

/**
 * The instructions of one `set_seat_access`: the compute budget SECURITY.md
 * asks for, then the call with the book of every perp market. The admin cannot
 * read the seat's current lists, so it cannot tell whether a call clears a
 * maker bit; the budget is therefore on every call, which also keeps the
 * transaction the same shape whatever it sets.
 */
export function seatAccessInstructions(
  instructions: Instructions,
  admin: PublicKey,
  owner: PublicKey,
  access: SeatAccess,
  perpIds: number[],
): TransactionInstruction[] {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({
      units: SEAT_ACCESS_COMPUTE_UNITS,
    }),
    instructions.setSeatAccess(admin, owner, access, perpIds),
  ];
}

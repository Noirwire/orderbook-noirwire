import {
  Reader,
  bytesEqual,
  discriminator,
  MARKET_STATUS,
} from "@noirwire/orderbook";
import {
  ComputeBudgetProgram,
  type PublicKey,
  type TransactionInstruction,
} from "@solana/web3.js";
import { marketsIn } from "@ops/accessing";

type Field = [label: string, value: string];

const statusName = (status: number) =>
  Object.entries(MARKET_STATUS).find(([, code]) => code === status)?.[0] ??
  `unknown (${status})`;

const onOff = (on: boolean) => (on ? "on" : "off");

/** A seat list's bits as the market ids they name. */
const marketList = (bits: number) =>
  `${marketsIn(bits).join(", ") || "none"} (bits ${bits})`;

/**
 * The fields of every instruction the console sends, read back out of the
 * built bytes in the program's order, so what is shown before signing is
 * what the bytes say, not what the form asked for.
 */
const LAYOUTS: Record<string, (reader: Reader) => Field[]> = {
  set_paused: (r) => [["paused", String(r.bool())]],
  update_exchange: (r) => [
    ["gate", r.pubkey().toBase58()],
    ["oracle", r.pubkey().toBase58()],
    ["max steps", String(r.u8())],
    ["max seats per day", String(r.u32())],
  ],
  propose_admin: (r) => [
    [
      "nominee",
      r.bool() ? r.pubkey().toBase58() : "none (withdraws a nomination)",
    ],
  ],
  accept_admin: () => [],
  set_custody_cap: (r) => [
    ["token index", String(r.u8())],
    ["cap, atoms", r.u64().toString()],
  ],
  restrict_market: (r) => [
    ["market", String(r.u8())],
    ["status", statusName(r.u8())],
  ],
  resume_market: (r) => [["market", String(r.u8())]],
  sync_price: (r) => [["market", String(r.u8())]],
  sync_quote: () => [],
  schedule_funding: (r) => [
    ["market", String(r.u8())],
    ["task id", r.i64().toString()],
    ["interval, ms", r.i64().toString()],
    ["iterations", r.i64().toString()],
  ],
  fund_insurance: (r) => [["amount, atoms", r.u64().toString()]],
  set_market_access: (r) => [
    ["market", String(r.u8())],
    ["maker list", onOff(r.bool())],
    ["taker list", onOff(r.bool())],
  ],
  set_seat_access: (r) => [
    ["seat owner", r.pubkey().toBase58()],
    ["maker on markets", marketList(r.u8())],
    ["taker on markets", marketList(r.u8())],
    ["blocked", r.bool() ? "yes" : "no"],
  ],
};

/** The Compute Budget program's `SetComputeUnitLimit`: its tag, then the units as a little-endian u32. */
const SET_COMPUTE_UNIT_LIMIT = 2;
const COMPUTE_UNIT_LIMIT_LEN = 5;

export type DecodedAccount = {
  address: string;
  signer: boolean;
  writable: boolean;
};

export type Decoded = {
  name: string;
  programId: string;
  fields: Field[];
  accounts: DecodedAccount[];
  dataHex: string;
};

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** The instruction as its bytes say, refused unless it is one the console knows, for `programId`, with no byte left over. */
export function decodeInstruction(
  instruction: TransactionInstruction,
  programId: PublicKey,
): Decoded {
  if (!instruction.programId.equals(programId)) {
    throw new Error(
      `the instruction is for ${instruction.programId.toBase58()}, not ${programId.toBase58()}`,
    );
  }
  const data = Uint8Array.from(instruction.data);
  const name = Object.keys(LAYOUTS).find((each) =>
    bytesEqual(data.subarray(0, 8), discriminator(each)),
  );
  if (!name) throw new Error("the instruction is not one the console sends");
  const reader = new Reader(data, 8);
  const fields = LAYOUTS[name](reader);
  if (reader.offset !== data.length) {
    throw new Error(
      `${name} carries ${data.length - reader.offset} bytes beyond its fields`,
    );
  }
  return {
    name,
    programId: programId.toBase58(),
    fields,
    accounts: instruction.keys.map((key) => ({
      address: key.pubkey.toBase58(),
      signer: key.isSigner,
      writable: key.isWritable,
    })),
    dataHex: hex(data),
  };
}

/** A compute unit limit as its bytes say, refused when it is any other Compute Budget instruction or names an account. */
function decodeComputeUnitLimit(instruction: TransactionInstruction): Decoded {
  const data = Uint8Array.from(instruction.data);
  if (
    data.length !== COMPUTE_UNIT_LIMIT_LEN ||
    data[0] !== SET_COMPUTE_UNIT_LIMIT ||
    instruction.keys.length > 0
  ) {
    throw new Error(
      "the Compute Budget instruction is not a compute unit limit alone",
    );
  }
  const units = new DataView(data.buffer).getUint32(1, true);
  return {
    name: "set_compute_unit_limit",
    programId: ComputeBudgetProgram.programId.toBase58(),
    fields: [["compute units", String(units)]],
    accounts: [],
    dataHex: hex(data),
  };
}

/**
 * Every instruction of one transaction as its bytes say, in order: the
 * program's own, each refused as `decodeInstruction` refuses it, and a
 * compute unit limit at most once, and only directly in front of a program
 * instruction.
 */
export function decodeInstructions(
  instructions: TransactionInstruction[],
  programId: PublicKey,
): Decoded[] {
  const isBudget = (instruction: TransactionInstruction) =>
    instruction.programId.equals(ComputeBudgetProgram.programId);
  if (instructions.filter(isBudget).length > 1) {
    throw new Error("the transaction carries more than one compute unit limit");
  }
  return instructions.map((instruction, at) => {
    if (!isBudget(instruction)) {
      return decodeInstruction(instruction, programId);
    }
    if (at === instructions.length - 1) {
      throw new Error(
        "a compute unit limit comes before a program instruction",
      );
    }
    return decodeComputeUnitLimit(instruction);
  });
}

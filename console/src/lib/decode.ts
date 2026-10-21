import {
  Reader,
  bytesEqual,
  discriminator,
  MARKET_STATUS,
} from "@noirwire/orderbook";
import type { PublicKey, TransactionInstruction } from "@solana/web3.js";

type Field = [label: string, value: string];

const statusName = (status: number) =>
  Object.entries(MARKET_STATUS).find(([, code]) => code === status)?.[0] ??
  `unknown (${status})`;

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
};

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

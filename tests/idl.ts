/** The program's interface file as `make build` writes it. Reading it needs no network. */
import { readFileSync } from "fs";
import { join } from "path";

export const idl = JSON.parse(
  readFileSync(
    join(process.cwd(), "target/idl/noirwire_orderbook.json"),
    "utf8",
  ),
) as {
  address: string;
  instructions: {
    name: string;
    discriminator: number[];
    accounts: { name: string; writable?: boolean; signer?: boolean }[];
    args: { name: string; type: IdlType }[];
  }[];
  types: {
    name: string;
    type:
      | { kind: "struct"; fields: { name: string; type: IdlType }[] }
      | {
          kind: "enum";
          variants: {
            name: string;
            fields?: { name: string; type: IdlType }[];
          }[];
        };
  }[];
  errors: { code: number; name: string; msg: string }[];
};

export type IdlType =
  | string
  | { array: [IdlType, number] }
  | { vec: IdlType }
  | { option: IdlType }
  | { defined: { name: string } };

const WIDTHS: Record<string, number> = {
  u8: 1,
  u16: 2,
  u32: 4,
  u64: 8,
  i32: 4,
  i64: 8,
  bool: 1,
  pubkey: 32,
};

/**
 * Reads `data` as the interface file's `type` says, field by field, and
 * returns what it read and where it stopped. Structs are objects keyed by the
 * program's field names, fixed arrays and vectors are arrays, an enum is
 * `{ variant, ...fields }`, and a number is a bigint when it is 8 bytes wide.
 */
export function decodeAs(
  type: IdlType,
  data: Buffer,
  at = 0,
): { value: unknown; end: number } {
  if (typeof type === "string") {
    if (type === "bytes") {
      const length = data.readUInt32LE(at);
      return {
        value: data.subarray(at + 4, at + 4 + length),
        end: at + 4 + length,
      };
    }
    const width = WIDTHS[type];
    if (width === undefined) throw new Error(`no width for type ${type}`);
    if (at + width > data.length) throw new Error(`${type} runs past the data`);
    const slice = data.subarray(at, at + width);
    let value: unknown;
    if (type === "pubkey") value = new Uint8Array(slice);
    else if (type === "bool") value = slice[0] === 1;
    else if (width === 8) {
      value =
        type === "i64" ? data.readBigInt64LE(at) : data.readBigUInt64LE(at);
    } else if (type === "i32") value = data.readInt32LE(at);
    else value = slice.readUIntLE(0, width);
    return { value, end: at + width };
  }
  if ("array" in type) {
    const items: unknown[] = [];
    let end = at;
    for (let each = 0; each < type.array[1]; each += 1) {
      const read = decodeAs(type.array[0], data, end);
      items.push(read.value);
      end = read.end;
    }
    return { value: items, end };
  }
  if ("vec" in type) {
    const count = data.readUInt32LE(at);
    const items: unknown[] = [];
    let end = at + 4;
    for (let each = 0; each < count; each += 1) {
      const read = decodeAs(type.vec, data, end);
      items.push(read.value);
      end = read.end;
    }
    return { value: items, end };
  }
  if ("option" in type) {
    if (data[at] === 0) return { value: null, end: at + 1 };
    return decodeAs(type.option, data, at + 1);
  }
  const defined = idl.types.find(({ name }) => name === type.defined.name);
  if (!defined) throw new Error(`no type ${type.defined.name}`);
  if (defined.type.kind === "enum") {
    const variant = defined.type.variants[data[at]];
    if (!variant) throw new Error(`${defined.name} has no variant ${data[at]}`);
    const fields = decodeFields(variant.fields ?? [], data, at + 1);
    return {
      value: { variant: variant.name, ...fields.value },
      end: fields.end,
    };
  }
  return decodeFields(defined.type.fields, data, at);
}

function decodeFields(
  fields: { name: string; type: IdlType }[],
  data: Buffer,
  at: number,
): { value: Record<string, unknown>; end: number } {
  const value: Record<string, unknown> = {};
  let end = at;
  for (const field of fields) {
    const read = decodeAs(field.type, data, end);
    value[field.name] = read.value;
    end = read.end;
  }
  return { value, end };
}

/** The arguments of an instruction's data, read as the interface file declares them, and whether the data ends exactly where they do. */
export function decodeArgs(
  name: string,
  data: Buffer,
): { args: Record<string, unknown>; exact: boolean } {
  const instruction = idl.instructions.find((each) => each.name === name);
  if (!instruction) throw new Error(`the program has no instruction ${name}`);
  const read = decodeFields(instruction.args, data, 8);
  return { args: read.value, exact: read.end === data.length };
}

/** The program's error called `name`, numbered as a failed transaction reports it. */
export function errorCode(name: string): number {
  const error = idl.errors.find((candidate) => candidate.name === name);
  if (!error) throw new Error(`the program has no error called ${name}`);
  return error.code;
}

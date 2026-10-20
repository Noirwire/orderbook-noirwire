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
  }[];
  errors: { code: number; name: string; msg: string }[];
};

/** The program's error called `name`, numbered as a failed transaction reports it. */
export function errorCode(name: string): number {
  const error = idl.errors.find((candidate) => candidate.name === name);
  if (!error) throw new Error(`the program has no error called ${name}`);
  return error.code;
}

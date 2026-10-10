import type { Connection, PublicKey } from "@solana/web3.js";
import type { Unsubscribe } from "../marketReader.js";

export function subscribe<T>(
  connection: Connection,
  address: PublicKey,
  decode: (data: Uint8Array) => T,
  onChange: (value: T) => void,
): Unsubscribe {
  const id = connection.onAccountChange(
    address,
    (account) => onChange(decode(account.data)),
    { commitment: "confirmed" },
  );
  return () => connection.removeAccountChangeListener(id);
}

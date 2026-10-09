import { PublicKey } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha256";

/** Reads little-endian fields out of account data, integers as bigint. */
export class Reader {
  private readonly view: DataView;

  constructor(
    readonly data: Uint8Array,
    public offset = 0,
  ) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  seek(offset: number): this {
    this.offset = offset;
    return this;
  }

  u8(): number {
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  u16(): number {
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  u32(): number {
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  u64(): bigint {
    const value = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return value;
  }

  i64(): bigint {
    const value = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    return value;
  }

  bytes(length: number): Uint8Array {
    const value = this.data.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  pubkey(): PublicKey {
    return new PublicKey(this.bytes(32));
  }

  skip(length: number): this {
    this.offset += length;
    return this;
  }

  /** Bytes up to the first zero, as text. */
  symbol(length: number): string {
    const raw = this.bytes(length);
    const end = raw.indexOf(0);
    return new TextDecoder().decode(end < 0 ? raw : raw.subarray(0, end));
  }
}

/** Writes Borsh-encoded instruction data. */
export class Writer {
  private parts: Uint8Array[] = [];

  u8(value: number): this {
    this.parts.push(Uint8Array.of(value));
    return this;
  }

  bool(value: boolean): this {
    return this.u8(value ? 1 : 0);
  }

  u16(value: number): this {
    const bytes = new Uint8Array(2);
    new DataView(bytes.buffer).setUint16(0, value, true);
    this.parts.push(bytes);
    return this;
  }

  u32(value: number): this {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, true);
    this.parts.push(bytes);
    return this;
  }

  u64(value: bigint | number): this {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true);
    this.parts.push(bytes);
    return this;
  }

  i64(value: bigint | number): this {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigInt64(0, BigInt(value), true);
    this.parts.push(bytes);
    return this;
  }

  bytes(value: Uint8Array): this {
    this.parts.push(value);
    return this;
  }

  pubkey(value: PublicKey): this {
    return this.bytes(value.toBytes());
  }

  option(value: PublicKey | null): this {
    if (value === null) return this.u8(0);
    return this.u8(1).pubkey(value);
  }

  /** A fixed-size byte array, padded with zeros. */
  fixed(value: Uint8Array | string, length: number): this {
    const bytes = new Uint8Array(length);
    const source =
      typeof value === "string" ? new TextEncoder().encode(value) : value;
    if (source.length > length) {
      throw new Error(`${source.length} bytes do not fit in ${length}`);
    }
    bytes.set(source);
    return this.bytes(bytes);
  }

  build(): Buffer {
    const length = this.parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(length);
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.length;
    }
    return Buffer.from(out);
  }
}

/** The eight bytes Anchor puts in front of an instruction's data. */
export function discriminator(instruction: string): Uint8Array {
  return sha256(new TextEncoder().encode(`global:${instruction}`)).slice(0, 8);
}

export function instructionData(name: string): Writer {
  return new Writer().bytes(discriminator(name));
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, at) => byte === b[at]);
}

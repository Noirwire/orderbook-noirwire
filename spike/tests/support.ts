import { readFileSync } from "fs";
import { join } from "path";
import * as anchor from "@anchor-lang/core";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  EPHEMERAL_VAULT_ID,
  MAGIC_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  getAuthToken,
  permissionPdaFromAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import nacl from "tweetnacl";

const idl = JSON.parse(
  readFileSync(join(process.cwd(), "target/idl/ob_spike.json"), "utf8"),
);

export const BASE_URL = "http://127.0.0.1:8899";
export const ROLLUP_URL = "http://127.0.0.1:7799";
export const ROLLUP_WS = "ws://127.0.0.1:7800";
export const FILTER_URL = "http://127.0.0.1:6699";
export const FILTER_WS = "ws://127.0.0.1:6700";

export const VALIDATOR = new PublicKey(
  "mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev",
);

export const base = new Connection(BASE_URL, "confirmed");
export const rollup = new Connection(ROLLUP_URL, {
  commitment: "confirmed",
  wsEndpoint: ROLLUP_WS,
});

export const admin = Keypair.fromSecretKey(
  Uint8Array.from(
    JSON.parse(
      readFileSync(join(process.cwd(), ".localnet/admin.json"), "utf8"),
    ),
  ),
);

export const program = new anchor.Program(
  idl,
  new anchor.AnchorProvider(base, new anchor.Wallet(Keypair.generate()), {
    commitment: "confirmed",
  }),
);
export const PROGRAM_ID: PublicKey = program.programId;

const pda = (...seeds: (Buffer | Uint8Array)[]) =>
  PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];

export const SPONSOR = pda(Buffer.from("sponsor"));
export const CUSTODY = pda(Buffer.from("custody"));
export const cellOf = (id: number) =>
  pda(Buffer.from("cell"), Buffer.from([id]));
export const bigOf = (id: number) => pda(Buffer.from("big"), Buffer.from([id]));

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function until<T>(
  read: () => Promise<T | null | undefined | false>,
  what: string,
  timeoutMs = 60_000,
  everyMs = 200,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read().catch(() => null);
    if (value) return value;
    await sleep(everyMs);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const shortVec = (length: number) => {
  const bytes: number[] = [];
  for (let rest = length; ; rest >>= 7) {
    if (rest < 0x80) {
      bytes.push(rest);
      return Buffer.from(bytes);
    }
    bytes.push((rest & 0x7f) | 0x80);
  }
};

/** A signed legacy transaction, built by hand so it may exceed 1,232 bytes. */
export function wire(transaction: Transaction, signers: Keypair[]): Buffer {
  const compiled = transaction.compileMessage();
  const message = Buffer.concat([
    Buffer.from([
      compiled.header.numRequiredSignatures,
      compiled.header.numReadonlySignedAccounts,
      compiled.header.numReadonlyUnsignedAccounts,
    ]),
    shortVec(compiled.accountKeys.length),
    ...compiled.accountKeys.map((key) => key.toBuffer()),
    anchor.utils.bytes.bs58.decode(compiled.recentBlockhash),
    shortVec(compiled.instructions.length),
    ...compiled.instructions.flatMap((instruction) => {
      const data = anchor.utils.bytes.bs58.decode(instruction.data);
      return [
        Buffer.from([instruction.programIdIndex]),
        shortVec(instruction.accounts.length),
        Buffer.from(instruction.accounts),
        shortVec(data.length),
        data,
      ];
    }),
  ]);
  const signatures = compiled.accountKeys
    .slice(0, compiled.header.numRequiredSignatures)
    .map((key) => {
      const signer = signers.find((held) => held.publicKey.equals(key));
      if (!signer) throw new Error(`${key.toBase58()} did not sign`);
      return nacl.sign.detached(message, signer.secretKey);
    });
  return Buffer.concat([shortVec(signatures.length), ...signatures, message]);
}

export async function signed(
  connection: Connection,
  instructions: TransactionInstruction[],
  feePayer: Keypair,
  signers: Keypair[] = [],
): Promise<Buffer> {
  const latest = await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({
    feePayer: feePayer.publicKey,
    ...latest,
  }).add(...instructions);
  return wire(transaction, [feePayer, ...signers]);
}

/** Sends instructions as one transaction; throws with the logs if it fails. */
export async function send(
  connection: Connection,
  instructions: TransactionInstruction | TransactionInstruction[],
  feePayer: Keypair,
  signers: Keypair[] = [],
  everyMs = 50,
): Promise<string> {
  const signature = await connection.sendRawTransaction(
    await signed(connection, [instructions].flat(), feePayer, signers),
    { skipPreflight: true },
  );
  const status = await until(
    async () => {
      const { value } = await connection.getSignatureStatus(signature);
      return value && value.confirmationStatus !== "processed" && value;
    },
    `transaction ${signature} to be confirmed`,
    60_000,
    everyMs,
  );
  if (status.err) {
    const landed = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    throw new Error(
      `${JSON.stringify(status.err)}\n${(landed?.meta?.logMessages ?? []).join("\n")}`,
    );
  }
  return signature;
}

/** Resolves to the error text of a call, or null if it succeeded. */
export async function failure(call: Promise<unknown>): Promise<string | null> {
  try {
    await call;
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : JSON.stringify(error);
  }
}

export async function airdropped(to: PublicKey, sol: number) {
  const signature = await base.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
  await base.confirmTransaction(
    { signature, ...(await base.getLatestBlockhash()) },
    "confirmed",
  );
}

export async function tokenFor(reader: Keypair, url = FILTER_URL) {
  const { token } = await getAuthToken(
    url,
    reader.publicKey,
    async (message) => nacl.sign.detached(message, reader.secretKey),
  );
  return token;
}

/** A connection to the query filter that reads as `reader`. */
export async function readingAs(reader: Keypair): Promise<Connection> {
  const token = await tokenFor(reader);
  return new Connection(`${FILTER_URL}?token=${token}`, {
    commitment: "confirmed",
    wsEndpoint: `${FILTER_WS}?token=${token}`,
  });
}

/** One JSON-RPC call, returned whole, so a refusal can be shown as it came. */
export async function rpc(url: string, method: string, params: unknown[]) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  try {
    const body = JSON.parse(text);
    return body.error ? { error: body.error } : body.result;
  } catch {
    return { http: response.status, text: text.slice(0, 200) };
  }
}

/** Trims a JSON value for printing. */
export const brief = (value: unknown, max = 260) => {
  const text = JSON.stringify(value);
  return text === undefined
    ? "undefined"
    : text.length > max
      ? `${text.slice(0, max)}... (${text.length} chars)`
      : text;
};

export const computeLimit = (units: number) =>
  ComputeBudgetProgram.setComputeUnitLimit({ units });

/** Compute units a landed rollup transaction used. */
export async function unitsOf(signature: string): Promise<number> {
  const landed = await until(
    () =>
      rollup.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      }),
    `transaction ${signature}`,
    10_000,
    50,
  );
  return landed.meta?.computeUnitsConsumed ?? -1;
}

/** The sponsor exists on Solana, holds `sol`, and is delegated to the rollup. */
export async function ready(sol = 2): Promise<void> {
  if ((await base.getBalance(admin.publicKey)) < 50 * LAMPORTS_PER_SOL) {
    await airdropped(admin.publicKey, 500);
  }
  const onRollup = await rollup.getAccountInfo(SPONSOR);
  if (onRollup?.owner.equals(PROGRAM_ID)) return;
  if (!(await base.getAccountInfo(SPONSOR))) {
    await send(
      base,
      await program.methods
        .initSponsor()
        .accountsPartial({ payer: admin.publicKey, sponsor: SPONSOR })
        .instruction(),
      admin,
    );
    await send(
      base,
      SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: SPONSOR,
        lamports: sol * LAMPORTS_PER_SOL,
      }),
      admin,
    );
    await send(
      base,
      await program.methods
        .delegateSponsor(VALIDATOR)
        .accountsPartial({ payer: admin.publicKey, sponsor: SPONSOR })
        .instruction(),
      admin,
    );
  }
  await until(
    async () => (await rollup.getAccountInfo(SPONSOR))?.owner.equals(PROGRAM_ID),
    "the sponsor to appear in the rollup",
  );
}

export type Reader = { flags: number; key: PublicKey };

export const cellAccounts = (id: number, user: PublicKey) => ({
  user,
  sponsor: SPONSOR,
  cell: cellOf(id),
  permission: permissionPdaFromAccount(cellOf(id)),
  permissionProgram: PERMISSION_PROGRAM_ID,
  vault: EPHEMERAL_VAULT_ID,
  magicProgram: MAGIC_PROGRAM_ID,
});

/** Creates cell `id` in the rollup. `guard` gives it a permission. */
export async function createCell(
  id: number,
  size: number,
  guard: { isPrivate: boolean; readers: Reader[] } | null,
  user = Keypair.generate(),
): Promise<string> {
  const instruction = await program.methods
    .createCell(
      id,
      size,
      guard !== null,
      guard?.isPrivate ?? false,
      guard?.readers ?? [],
    )
    .accountsPartial(cellAccounts(id, user.publicKey))
    .instruction();
  return send(rollup, withPermissionWritable(instruction, id, guard !== null), user);
}

/** The permission is writable only in a transaction that creates or changes it. */
export function withPermissionWritable(
  instruction: TransactionInstruction,
  id: number,
  writable: boolean,
): TransactionInstruction {
  const permission = permissionPdaFromAccount(cellOf(id));
  instruction.keys = instruction.keys.map((meta) =>
    meta.pubkey.equals(permission) ? { ...meta, isWritable: writable } : meta,
  );
  return instruction;
}

export const poke = (id: number, user: PublicKey, price: number, size: number) =>
  program.methods
    .poke(id, new anchor.BN(price), new anchor.BN(size))
    .accountsPartial({ user, cell: cellOf(id) })
    .instruction();

/** Cell `id` grown to `size` bytes, 10,240 at a time, sealed from every reader. */
export async function grownCell(id: number, size: number, user = Keypair.generate()) {
  const step = 10_240;
  await createCell(id, step, { isPrivate: true, readers: [] }, user);
  for (let length = step; length < size; ) {
    const batch: TransactionInstruction[] = [computeLimit(1_400_000)];
    while (length < size && batch.length <= 30) {
      length = Math.min(size, length + step);
      batch.push(
        await program.methods
          .growCell(id, length)
          .accountsPartial({
            user: user.publicKey,
            sponsor: SPONSOR,
            cell: cellOf(id),
            vault: EPHEMERAL_VAULT_ID,
            magicProgram: MAGIC_PROGRAM_ID,
          })
          .instruction(),
      );
    }
    await send(rollup, batch, user);
  }
  return cellOf(id);
}

/**
 * One websocket carrying many subscriptions. A refusal is returned, never
 * retried, so what the endpoint said is what the caller sees.
 */
export class Socket {
  private next = 1;
  private waiting = new Map<number, (reply: any) => void>();
  private handlers = new Map<number, (params: any) => void>();

  private constructor(private socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined && this.waiting.has(message.id)) {
        this.waiting.get(message.id)!(message);
        this.waiting.delete(message.id);
      } else if (message.params?.subscription !== undefined) {
        this.handlers.get(message.params.subscription)?.(message.params.result);
      }
    });
  }

  static open(url: string, timeoutMs = 5000): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => reject(new Error(`no websocket at ${url} in ${timeoutMs} ms`)), timeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(new Socket(socket));
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`websocket error at ${url}`));
      });
    });
  }

  /** Resolves to null when subscribed, or to the endpoint's refusal. */
  subscribe(method: string, params: unknown[], onNote: (result: any) => void, timeoutMs = 5000): Promise<string | null> {
    const id = this.next++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve("no reply to the subscription"), timeoutMs);
      this.waiting.set(id, (reply) => {
        clearTimeout(timer);
        if (reply.error) return resolve(brief(reply.error, 120));
        this.handlers.set(reply.result, onNote);
        resolve(null);
      });
      this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

export function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

export function summary(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const fixed = (value: number) => Number(value.toFixed(2));
  return {
    n: sorted.length,
    min: fixed(sorted[0]),
    median: fixed(percentile(sorted, 50)),
    p95: fixed(percentile(sorted, 95)),
    p99: fixed(percentile(sorted, 99)),
    max: fixed(sorted[sorted.length - 1]),
  };
}

export function main(run: () => Promise<void>) {
  run().then(
    () => process.exit(0),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}

/**
 * Probe: do token balances work through MagicBlock's hosted private rollup
 * endpoint on Solana devnet? Run from the spike folder, one stage at a time:
 *
 *   node_modules/.bin/ts-node -P tsconfig.json devnet/token-probe.ts <stage>
 *
 * Stages: fund <sol>, base, read, transfers, custody, history, latency,
 * withdraw, balances, peek. Keys and progress live in devnet/.keys/state.json.
 * No secret key is ever printed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  DELEGATION_PROGRAM_ID,
  EPHEMERAL_SPL_TOKEN_PROGRAM_ID,
  createEataPermissionIx,
  delegateEataPermissionIx,
  delegateEphemeralAtaIx,
  delegateSpl,
  deriveEphemeralAta,
  deriveRentPda,
  getAuthToken,
  initEphemeralAtaIx,
  permissionPdaFromAccount,
  undelegateIx,
  withdrawSpl,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import nacl from "tweetnacl";

const SOLANA_URL = "https://api.devnet.solana.com";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const ROLLUP_URL = "https://devnet-tee.magicblock.app";
const VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
const FUNDER_PATH = join(process.cwd(), "../../profile-noirwire/.keys/devnet-admin.json");
const FUNDING_CAP = 0.6 * LAMPORTS_PER_SOL;
const KEYS_DIR = join(process.cwd(), "devnet/.keys");
const STATE_PATH = join(KEYS_DIR, "state.json");
const UNIT = 1_000_000n;

type State = {
  keys: Record<string, number[]>;
  addresses: Record<string, string>;
  done: Record<string, string>;
  funded: number;
  notes: Record<string, unknown>;
};

const state: State = existsSync(STATE_PATH)
  ? JSON.parse(readFileSync(STATE_PATH, "utf8"))
  : { keys: {}, addresses: {}, done: {}, funded: 0, notes: {} };

function save() {
  mkdirSync(KEYS_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state), { mode: 0o600 });
}

function key(name: string): Keypair {
  if (!state.keys[name]) {
    state.keys[name] = Array.from(Keypair.generate().secretKey);
    save();
  }
  return Keypair.fromSecretKey(Uint8Array.from(state.keys[name]));
}

function unsignable(name: string): PublicKey {
  if (!state.addresses[name]) {
    let candidate = Keypair.generate().publicKey;
    while (PublicKey.isOnCurve(candidate.toBytes())) {
      candidate = new PublicKey(nacl.randomBytes(32));
    }
    state.addresses[name] = candidate.toBase58();
    save();
  }
  return new PublicKey(state.addresses[name]);
}

const solana = new Connection(SOLANA_URL, "confirmed");
const payer = key("payer");
const mint = key("mint");
const alice = key("alice");
const bob = key("bob");
const carol = key("carol");
const stranger = key("stranger");
const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(mint.publicKey, owner, true);
const eata = (owner: PublicKey) => deriveEphemeralAta(owner, mint.publicKey)[0];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sol = (lamports: number) => `${(lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`;
const brief = (value: unknown, max = 320) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}... (${text.length} chars)` : text;
};

async function until<T>(read: () => Promise<T | null | undefined | false>, what: string, timeoutMs: number, everyMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read().catch(() => null);
    if (value) return value;
    await sleep(everyMs);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
}

type Reply = { http: number; result?: any; error?: any; text?: string };

async function raw(url: string, method: string, params: unknown[] = []): Promise<Reply> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  try {
    const body = JSON.parse(text);
    return { http: response.status, result: body.result, error: body.error };
  } catch {
    return { http: response.status, text: text.trim().slice(0, 300) };
  }
}

const shown = (reply: Reply) =>
  reply.error || reply.text !== undefined
    ? `HTTP ${reply.http} ${brief(reply.error ?? reply.text)}`
    : `HTTP ${reply.http} ${brief(reply.result)}`;

const tokens: Record<string, string> = {};
async function urlAs(reader: Keypair | null): Promise<string> {
  if (!reader) return ROLLUP_URL;
  const name = reader.publicKey.toBase58();
  if (!tokens[name]) {
    const { token } = await getAuthToken(ROLLUP_URL, reader.publicKey, async (message) =>
      nacl.sign.detached(message, reader.secretKey),
    );
    tokens[name] = token;
  }
  return `${ROLLUP_URL}?token=${tokens[name]}`;
}

async function amountAt(url: string, account: PublicKey): Promise<string> {
  const reply = await raw(url, "getAccountInfo", [account.toBase58(), { encoding: "base64", commitment: "confirmed" }]);
  if (reply.error || reply.text !== undefined) return shown(reply);
  if (!reply.result?.value) return "null";
  const data = Buffer.from(reply.result.value.data[0], "base64");
  const amount = data.length >= 72 ? data.readBigUInt64LE(64) : "?";
  return `amount ${amount}, owner ${reply.result.value.owner.slice(0, 8)}, ${data.length} bytes, ${reply.result.value.lamports} lamports`;
}

async function unitsAt(url: string, account: PublicKey): Promise<bigint | null> {
  const reply = await raw(url, "getAccountInfo", [account.toBase58(), { encoding: "base64", commitment: "confirmed" }]);
  if (!reply.result?.value) return null;
  const data = Buffer.from(reply.result.value.data[0], "base64");
  return data.length >= 72 ? data.readBigUInt64LE(64) : null;
}

/** Sends on Solana devnet, split in two when one transaction would be too large. */
async function onSolana(label: string, instructions: TransactionInstruction[], signers: Keypair[] = []): Promise<boolean> {
  if (state.done[label]) {
    console.log(`skip   ${label} (done: ${state.done[label].slice(0, 12)})`);
    return false;
  }
  const build = async (part: TransactionInstruction[]) => {
    const latest = await solana.getLatestBlockhash("confirmed");
    const transaction = new Transaction({ feePayer: payer.publicKey, ...latest }).add(...part);
    const needed = transaction.compileMessage().accountKeys.slice(0, transaction.compileMessage().header.numRequiredSignatures);
    transaction.sign(...[payer, ...signers].filter((held) => needed.some((one) => one.equals(held.publicKey))));
    return transaction.serialize();
  };
  let parts = [instructions];
  try {
    await build(instructions);
  } catch (error) {
    if (!/too large/i.test((error as Error).message)) throw error;
    const half = Math.ceil(instructions.length / 2);
    parts = [instructions.slice(0, half), instructions.slice(half)];
  }
  const before = await solana.getBalance(payer.publicKey);
  const started = Date.now();
  const signatures: string[] = [];
  for (const part of parts) {
    const signature = await solana.sendRawTransaction(await build(part), { preflightCommitment: "confirmed" });
    const status = await until(
      async () => {
        const { value } = await solana.getSignatureStatus(signature);
        return value && value.confirmationStatus !== "processed" && value;
      },
      `${label} to confirm`,
      90_000,
      1500,
    );
    if (status.err) throw new Error(`${label}: ${JSON.stringify(status.err)} ${signature}`);
    signatures.push(signature);
  }
  const spent = before - (await solana.getBalance(payer.publicKey));
  state.done[label] = signatures.join(",");
  state.notes[`cost:${label}`] = spent;
  save();
  console.log(`ok     ${label}: ${parts.length} transaction(s), ${Date.now() - started} ms, payer spent ${spent} lamports (${sol(spent)})`);
  return true;
}

type Outcome = { accepted: boolean; landed: boolean; signature?: string; text: string };

/** One rollup transaction through the hosted endpoint; the refusal is kept as it came. */
async function onRollup(
  url: string,
  instructions: TransactionInstruction[],
  feePayer: Keypair,
  signers: Keypair[],
  mode: "simulate" | "preflight" | "skipPreflight",
): Promise<Outcome> {
  const blockhash = await raw(url, "getLatestBlockhash", [{ commitment: "confirmed" }]);
  if (!blockhash.result?.value) return { accepted: false, landed: false, text: `getLatestBlockhash ${shown(blockhash)}` };
  const transaction = new Transaction({ feePayer: feePayer.publicKey, ...blockhash.result.value }).add(...instructions);
  transaction.sign(feePayer, ...signers.filter((held) => !held.publicKey.equals(feePayer.publicKey)));
  const wire = transaction.serialize().toString("base64");
  if (mode === "simulate") {
    const reply = await raw(url, "simulateTransaction", [wire, { encoding: "base64", commitment: "confirmed" }]);
    const value = reply.result?.value;
    return {
      accepted: !!value && !value.err,
      landed: false,
      text: value ? `HTTP ${reply.http} err=${JSON.stringify(value.err)} units=${value.unitsConsumed} logs=${brief(value.logs ?? null, 200)}` : shown(reply),
    };
  }
  const started = performance.now();
  const reply = await raw(url, "sendTransaction", [
    wire,
    { encoding: "base64", skipPreflight: mode === "skipPreflight", preflightCommitment: "confirmed" },
  ]);
  if (typeof reply.result !== "string") return { accepted: false, landed: false, text: shown(reply) };
  const signature: string = reply.result;
  const status = await until(
    async () => (await raw(url, "getSignatureStatuses", [[signature]])).result?.value?.[0],
    "status",
    15_000,
    100,
  ).catch(() => null);
  const took = Math.round(performance.now() - started);
  if (!status) return { accepted: true, landed: false, signature, text: `HTTP ${reply.http} accepted ${signature.slice(0, 12)} but no status in 15 s` };
  return {
    accepted: true,
    landed: !status.err,
    signature,
    text: `HTTP ${reply.http} ${status.err ? `landed with err ${JSON.stringify(status.err)}` : "landed ok"} in ${took} ms, ${signature}`,
  };
}

const transfer = (from: Keypair, to: PublicKey, units: bigint) =>
  createTransferInstruction(ata(from.publicKey), ata(to), from.publicKey, units);

let nonce = BigInt(Date.now() % 1000) + 1n;
const odd = () => (nonce += 1n);

/** Simulation, a send with preflight and a send without, each a distinct amount. */
async function tried(label: string, from: Keypair, to: PublicKey, readers: [string, Keypair | null][]) {
  console.log(`\n-- ${label}`);
  const url = await urlAs(from);
  const before = await unitsAt(url, ata(from.publicKey));
  for (const mode of ["simulate", "preflight", "skipPreflight"] as const) {
    const outcome = await onRollup(url, [transfer(from, to, odd())], from, [], mode);
    console.log(`   ${mode.padEnd(13)} ${outcome.accepted ? (mode === "simulate" || outcome.landed ? "WORKED " : "FAILED ") : "REFUSED"} ${outcome.text}`);
    if (outcome.signature) state.notes[`sig:${label}:${mode}`] = outcome.signature;
  }
  save();
  const after = await unitsAt(url, ata(from.publicKey));
  console.log(`   sender balance ${before} -> ${after} (moved ${before !== null && after !== null ? before - after : "?"})`);
  for (const [who, reader] of readers) {
    console.log(`   receiver read by ${who}: ${await amountAt(await urlAs(reader), ata(to))}`);
  }
}

async function guard() {
  const genesis = await solana.getGenesisHash();
  if (genesis !== DEVNET_GENESIS) throw new Error(`${SOLANA_URL} is not devnet: ${genesis}`);
  const identity = (await raw(ROLLUP_URL, "getIdentity")).result?.identity;
  if (identity !== VALIDATOR.toBase58()) throw new Error(`rollup is run by ${identity}`);
}

async function fund() {
  const lamports = Math.round(Number(process.argv[3] ?? "0.2") * LAMPORTS_PER_SOL);
  if (state.funded + lamports > FUNDING_CAP) throw new Error(`that would pass the ${sol(FUNDING_CAP)} cap (already ${sol(state.funded)})`);
  const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(FUNDER_PATH, "utf8"))));
  const latest = await solana.getLatestBlockhash("confirmed");
  const transaction = new Transaction({ feePayer: funder.publicKey, ...latest }).add(
    SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: payer.publicKey, lamports }),
  );
  transaction.sign(funder);
  const signature = await solana.sendRawTransaction(transaction.serialize());
  state.funded += lamports;
  save();
  await until(async () => (await solana.getSignatureStatus(signature)).value?.confirmationStatus === "confirmed" || (await solana.getSignatureStatus(signature)).value?.confirmationStatus === "finalized", "funding", 90_000, 1500);
  console.log(`funded ${sol(lamports)} to ${payer.publicKey.toBase58()} (${signature}); total taken ${sol(state.funded)}; payer holds ${sol(await solana.getBalance(payer.publicKey))}`);
}

async function appears(label: string, owner: PublicKey, reader: Keypair | null, units: bigint) {
  const started = Date.now();
  const url = await urlAs(reader);
  try {
    await until(async () => (await unitsAt(url, ata(owner))) === units, label, 60_000, 250);
    console.log(`       ${label}: visible in the rollup after ${Date.now() - started} ms from Solana confirmation`);
  } catch (error) {
    console.log(`       ${label}: ${(error as Error).message}; last read ${await amountAt(url, ata(owner))}`);
  }
}

async function base() {
  console.log(`payer ${payer.publicKey.toBase58()} holds ${sol(await solana.getBalance(payer.publicKey))}`);
  console.log(`mint ${mint.publicKey.toBase58()}\nalice ${alice.publicKey.toBase58()}\nbob ${bob.publicKey.toBase58()}\ncarol ${carol.publicKey.toBase58()}`);
  const rentPda = deriveRentPda()[0];
  console.log(`token program rent address ${rentPda.toBase58()} holds ${sol(await solana.getBalance(rentPda))}`);
  for (const [name, id] of [["Ephemeral SPL Token", EPHEMERAL_SPL_TOKEN_PROGRAM_ID], ["SPL Token", TOKEN_PROGRAM_ID]] as const) {
    const there = await raw(ROLLUP_URL, "getAccountInfo", [id.toBase58(), { encoding: "base64", dataSlice: { offset: 0, length: 0 } }]);
    console.log(`${name} in the rollup: ${there.result?.value ? `executable=${there.result.value.executable}` : shown(there)}`);
  }

  await onSolana(
    "mint and three holders with 1,000 each",
    [
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mint.publicKey,
        space: MINT_SIZE,
        lamports: await solana.getMinimumBalanceForRentExemption(MINT_SIZE),
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMintInstruction(mint.publicKey, 6, payer.publicKey, null),
      ...[alice, bob, carol].flatMap((holder) => [
        createAssociatedTokenAccountInstruction(payer.publicKey, ata(holder.publicKey), holder.publicKey, mint.publicKey),
        createMintToInstruction(mint.publicKey, ata(holder.publicKey), payer.publicKey, 1000n * UNIT),
      ]),
    ],
    [mint],
  );

  const moved = async (label: string, owner: Keypair, units: bigint, first: boolean, isPrivate: boolean) => {
    const instructions = await delegateSpl(owner.publicKey, mint.publicKey, units, {
      validator: VALIDATOR,
      idempotent: false,
      payer: payer.publicKey,
      initVaultIfMissing: first,
      private: isPrivate,
    });
    if (isPrivate) instructions.push(delegateEataPermissionIx(payer.publicKey, eata(owner.publicKey), VALIDATOR));
    if (await onSolana(label, instructions, [owner])) await appears(label, owner.publicKey, owner, units);
  };
  await moved("alice moves 100 in, public, creating the mint's vault", alice, 100n * UNIT, true, false);
  await moved("bob moves 100 in, private", bob, 100n * UNIT, false, true);
  await moved("carol moves 10 in, public", carol, 10n * UNIT, false, false);

  for (const [name, isPrivate] of [["custodyPublic", false], ["custodyPrivate", true]] as const) {
    const owner = unsignable(name);
    const made = await onSolana(
      `${name}: token account for an address nobody can sign for (${owner.toBase58().slice(0, 8)})`,
      [
        createAssociatedTokenAccountInstruction(payer.publicKey, ata(owner), owner, mint.publicKey),
        initEphemeralAtaIx(eata(owner), owner, mint.publicKey, payer.publicKey),
        ...(isPrivate
          ? [createEataPermissionIx(eata(owner), payer.publicKey), delegateEataPermissionIx(payer.publicKey, eata(owner), VALIDATOR)]
          : []),
        delegateEphemeralAtaIx(payer.publicKey, eata(owner), VALIDATOR),
      ],
    );
    if (made && !isPrivate) await appears(name, owner, null, 0n);
  }
  console.log(`payer now holds ${sol(await solana.getBalance(payer.publicKey))}`);
}

async function read() {
  const readers: [string, Keypair | null][] = [["anonymous", null], ["stranger", stranger], ["alice", alice], ["bob", bob]];
  const accounts: [string, PublicKey][] = [
    ["alice (public) ordinary address", ata(alice.publicKey)],
    ["alice ephemeral address", eata(alice.publicKey)],
    ["bob (private) ordinary address", ata(bob.publicKey)],
    ["bob ephemeral address", eata(bob.publicKey)],
    ["bob permission", permissionPdaFromAccount(eata(bob.publicKey))],
    ["custody public ordinary address", ata(unsignable("custodyPublic"))],
    ["custody private ordinary address", ata(unsignable("custodyPrivate"))],
    ["custody private permission", permissionPdaFromAccount(eata(unsignable("custodyPrivate")))],
  ];
  for (const [label, account] of accounts) {
    for (const [who, reader] of readers) {
      console.log(`${label} read by ${who}: ${await amountAt(await urlAs(reader), account)}`);
    }
  }
  for (const [label, account] of [["bob", eata(bob.publicKey)], ["custody private", eata(unsignable("custodyPrivate"))]] as const) {
    const permission = await solana.getAccountInfo(permissionPdaFromAccount(account));
    console.log(`${label} permission as Solana holds it: ${permission ? `${permission.data.length} bytes, owner ${permission.owner.toBase58().slice(0, 8)}, ${permission.data.toString("hex")}` : "absent"}`);
    const status = await fetch(`${ROLLUP_URL}/permission?pubkey=${account.toBase58()}`).then(async (answer) => `HTTP ${answer.status} ${(await answer.text()).slice(0, 200)}`);
    console.log(`${label} /permission: ${status}`);
  }
  console.log(`getTokenAccountBalance alice, anonymous: ${shown(await raw(ROLLUP_URL, "getTokenAccountBalance", [ata(alice.publicKey).toBase58()]))}`);
  console.log(`getBalance alice (fee payer) in the rollup: ${shown(await raw(ROLLUP_URL, "getBalance", [alice.publicKey.toBase58()]))}`);
}

async function transfers() {
  const all: [string, Keypair | null][] = [["anonymous", null], ["stranger", stranger], ["alice", alice], ["bob", bob]];
  await tried("alice (public) to bob (private)", alice, bob.publicKey, all);
  await tried("bob (private) to alice (public)", bob, alice.publicKey, [["anonymous", null]]);
  await tried("alice (public) to carol (public)", alice, carol.publicKey, [["anonymous", null]]);
  console.log("\n-- alice to carol sent with NO sign-in token");
  for (const mode of ["simulate", "skipPreflight"] as const) {
    const outcome = await onRollup(ROLLUP_URL, [transfer(alice, carol.publicKey, odd())], alice, [], mode);
    console.log(`   ${mode.padEnd(13)} ${outcome.accepted ? "ACCEPTED" : "REFUSED"} ${outcome.text}`);
  }
  console.log("\n-- alice to carol, fee paid by a brand new key holding nothing, signed in as that key");
  const fresh = Keypair.generate();
  const outcome = await onRollup(await urlAs(fresh), [transfer(alice, carol.publicKey, odd())], fresh, [alice], "skipPreflight");
  console.log(`   skipPreflight ${outcome.accepted ? "ACCEPTED" : "REFUSED"} ${outcome.text}`);
}

async function custody() {
  console.log("-- is simulation real? alice sends more than she holds");
  for (const mode of ["simulate", "preflight", "skipPreflight"] as const) {
    const outcome = await onRollup(await urlAs(alice), [transfer(alice, carol.publicKey, 5000n * UNIT + odd())], alice, [], mode);
    console.log(`   ${mode.padEnd(13)} ${outcome.text}`);
  }
  console.log("-- alice's transfer to carol sent through a STRANGER's sign-in");
  const relayed = await onRollup(await urlAs(stranger), [transfer(alice, carol.publicKey, odd())], alice, [], "skipPreflight");
  console.log(`   skipPreflight ${relayed.text}`);
  await tried("alice to the PUBLIC custody account", alice, unsignable("custodyPublic"), [["anonymous", null], ["alice", alice]]);
  await tried("alice to the PRIVATE custody account (no member)", alice, unsignable("custodyPrivate"), [["anonymous", null], ["alice", alice]]);
}

async function history() {
  const readers: [string, Keypair | null][] = [["anonymous", null], ["stranger", stranger], ["alice", alice], ["bob", bob]];
  const cases: [string, string | undefined][] = [
    ["alice to bob (private receiver)", state.notes["sig:alice (public) to bob (private):skipPreflight"] as string],
    ["bob (private sender) to alice", state.notes["sig:bob (private) to alice (public):skipPreflight"] as string],
    ["alice to carol (all public)", state.notes["sig:alice (public) to carol (public):skipPreflight"] as string],
    ["alice to private custody", state.notes["sig:alice to the PRIVATE custody account (no member):skipPreflight"] as string],
  ];
  for (const [label, signature] of cases) {
    if (!signature) {
      console.log(`${label}: no landed signature on file`);
      continue;
    }
    for (const [who, reader] of readers) {
      const reply = await raw(await urlAs(reader), "getTransaction", [signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
      const seen = reply.result
        ? `returned: fee ${reply.result.meta?.fee}, units ${reply.result.meta?.computeUnitsConsumed}, ${reply.result.meta?.logMessages?.length ?? 0} log lines, token balances ${brief(reply.result.meta?.postTokenBalances ?? null, 120)}, ${reply.result.transaction?.message?.accountKeys?.length} account keys`
        : shown(reply);
      console.log(`getTransaction ${label} as ${who}: ${seen}`);
    }
  }
  console.log(`alice's ephemeral account now, anonymous: ${await amountAt(ROLLUP_URL, eata(alice.publicKey))}`);
  for (const [who, reader] of readers) {
    const url = await urlAs(reader);
    console.log(`getTokenAccountBalance of alice as ${who}: ${shown(await raw(url, "getTokenAccountBalance", [ata(alice.publicKey).toBase58()]))}`);
    console.log(`getTokenAccountsByOwner bob as ${who}: ${shown(await raw(url, "getTokenAccountsByOwner", [bob.publicKey.toBase58(), { mint: mint.publicKey.toBase58() }, { encoding: "base64" }]))}`);
    console.log(`getMultipleAccounts [alice, bob, private custody] as ${who}: ${brief((await raw(url, "getMultipleAccounts", [[ata(alice.publicKey), ata(bob.publicKey), ata(unsignable("custodyPrivate"))].map((one) => one.toBase58()), { encoding: "base64", dataSlice: { offset: 64, length: 8 } }])).result?.value?.map((one: any) => (one ? Buffer.from(one.data[0], "base64").readBigUInt64LE(0).toString() : null)) ?? "refused")}`);
  }
  const addresses: [string, PublicKey][] = [
    ["alice's token account (public)", ata(alice.publicKey)],
    ["bob's token account (private)", ata(bob.publicKey)],
    ["bob's wallet", bob.publicKey],
    ["private custody token account", ata(unsignable("custodyPrivate"))],
  ];
  for (const [label, address] of addresses) {
    for (const [who, reader] of readers) {
      const reply = await raw(await urlAs(reader), "getSignaturesForAddress", [address.toBase58(), { limit: 20 }]);
      console.log(`getSignaturesForAddress ${label} as ${who}: ${Array.isArray(reply.result) ? `${reply.result.length} signatures` : shown(reply)}`);
    }
  }
}

function spread(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return `n=${sorted.length} min ${sorted[0]} median ${sorted[Math.floor(sorted.length / 2)]} worst ${sorted[sorted.length - 1]} ms`;
}

async function latency() {
  const url = await urlAs(carol);
  const pings: number[] = [];
  for (let sample = 0; sample < 20; sample += 1) {
    const started = performance.now();
    await raw(url, "getSlot");
    pings.push(Math.round(performance.now() - started));
  }
  console.log(`getSlot round trip: ${spread(pings)}`);
  const toAccepted: number[] = [];
  const toVisible: number[] = [];
  for (let sample = 0; sample < 20; sample += 1) {
    const before = await unitsAt(url, ata(carol.publicKey));
    const blockhash = (await raw(url, "getLatestBlockhash", [{ commitment: "confirmed" }])).result.value;
    const transaction = new Transaction({ feePayer: carol.publicKey, ...blockhash }).add(transfer(carol, bob.publicKey, odd()));
    transaction.sign(carol);
    const wire = transaction.serialize().toString("base64");
    const started = performance.now();
    const reply = await raw(url, "sendTransaction", [wire, { encoding: "base64", skipPreflight: true }]);
    if (typeof reply.result !== "string") {
      console.log(`   transfer ${sample}: ${shown(reply)}`);
      continue;
    }
    toAccepted.push(Math.round(performance.now() - started));
    await until(async () => (await unitsAt(url, ata(carol.publicKey))) !== before, "the balance to change", 15_000, 0);
    toVisible.push(Math.round(performance.now() - started));
  }
  console.log(`sendTransaction answered: ${spread(toAccepted)}`);
  console.log(`send to balance change visible (polled back to back): ${spread(toVisible)}`);
}

async function withdraw() {
  const url = await urlAs(alice);
  const units = await unitsAt(url, ata(alice.publicKey));
  console.log(`alice holds ${units} in the rollup, ${(await solana.getTokenAccountBalance(ata(alice.publicKey))).value.amount} on Solana`);
  const eataOnSolana = async () => (await solana.getAccountInfo(eata(alice.publicKey)))?.owner;
  if (!state.done["undelegate"]) {
    const started = Date.now();
    const outcome = await onRollup(url, [undelegateIx(alice.publicKey, mint.publicKey)], alice, [], "skipPreflight");
    console.log(`undelegate in the rollup: ${outcome.accepted && outcome.landed ? "WORKED" : "REFUSED/FAILED"} ${outcome.text}`);
    if (!outcome.landed) return;
    state.done["undelegate"] = outcome.signature!;
    state.notes["withdrawUnits"] = String(units);
    save();
    await until(async () => !(await eataOnSolana())?.equals(DELEGATION_PROGRAM_ID), "the balance to be handed back on Solana", 180_000, 2000);
    console.log(`handed back on Solana ${Date.now() - started} ms after the undelegate was sent`);
  }
  const owner = await eataOnSolana();
  const held = await solana.getAccountInfo(eata(alice.publicKey));
  console.log(`alice's ephemeral account on Solana: owner ${owner?.toBase58()}, ${held?.data.length} bytes, ${held?.data.toString("hex").slice(0, 160)}`);
  const amount = BigInt(state.notes["withdrawUnits"] as string);
  await onSolana("withdraw alice's balance to her Solana token account", await withdrawSpl(alice.publicKey, mint.publicKey, amount, { idempotent: false }), [alice]);
  console.log(`alice on Solana now: ${(await solana.getTokenAccountBalance(ata(alice.publicKey))).value.amount}`);
  console.log(`alice in the rollup now: ${await amountAt(url, ata(alice.publicKey))}`);
}

async function balances() {
  console.log(`payer ${payer.publicKey.toBase58()}: ${sol(await solana.getBalance(payer.publicKey))} left of ${sol(state.funded)} taken`);
  for (const [label, lamports] of Object.entries(state.notes).filter(([label]) => label.startsWith("cost:"))) {
    console.log(`${String(lamports).padStart(9)} lamports  ${label.slice(5)}`);
  }
}

const stages: Record<string, () => Promise<void>> = { fund, base, read, transfers, custody, history, latency, withdraw, balances, peek };

/** Raw answers, to see exactly what a transaction read and a signature list give back. */
async function peek() {
  const signature = state.notes["sig:alice (public) to carol (public):skipPreflight"] as string;
  for (const [who, reader] of [["anonymous", null], ["alice", alice]] as [string, Keypair | null][]) {
    for (const encoding of ["json", "base64"]) {
      const reply = await raw(await urlAs(reader), "getTransaction", [signature, { encoding, commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
      console.log(`getTransaction ${encoding} as ${who}: ${brief(reply, 900)}`);
    }
  }
  for (const [who, reader] of [["anonymous", null], ["bob", bob]] as [string, Keypair | null][]) {
    const reply = await raw(await urlAs(reader), "getSignaturesForAddress", [bob.publicKey.toBase58(), { limit: 20 }]);
    console.log(`signatures for bob's wallet as ${who}: ${brief(reply.result, 1200)}`);
  }
  console.log(`known: ${brief(Object.entries(state.notes).filter(([label]) => label.startsWith("sig:")).map(([label, value]) => `${label.slice(4)}=${String(value).slice(0, 10)}`), 1500)}`);
}

const stage = stages[process.argv[2]];
if (!stage) throw new Error(`Use one of: ${Object.keys(stages).join(", ")}`);
guard()
  .then(stage)
  .then(
    () => process.exit(0),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );

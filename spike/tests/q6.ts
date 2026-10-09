/**
 * Question 6. Latency and throughput on the local stack, for a simple write
 * and for a 10-fill match, all against ONE account, as an order book is.
 * These are numbers from one laptop with client and validators side by side.
 */
import { spawn } from "child_process";
import { createPrivateKey, sign } from "crypto";
import { cpus, totalmem } from "os";
import * as anchor from "@anchor-lang/core";
import { Keypair, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  ROLLUP_URL,
  ROLLUP_WS,
  Socket,
  base,
  brief,
  cellOf,
  createCell,
  grownCell,
  main,
  poke,
  program,
  ready,
  rollup,
  rpc,
  send,
  sleep,
  summary,
} from "./support";

const BN = anchor.BN;
const SAMPLES = Number(process.env.SAMPLES ?? 600);
const SECONDS = Number(process.env.SECONDS ?? 30);
const PROCESSES = Number(process.env.PROCESSES ?? 4);
const BOOK_BYTES = 24 + 2 * 512 * 40 + 4096 * 64;
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");
const NONCE_AT = 9;

type Kind = "write" | "match";
type Job = { kind: Kind; id: number; senders: number; startAt: number; endAt: number };

/** Signs with the platform's Ed25519, far faster than the pure JavaScript one. */
function signer(keypair: Keypair) {
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519, Buffer.from(keypair.secretKey.subarray(0, 32))]),
    format: "der",
    type: "pkcs8",
  });
  return (message: Buffer) => sign(null, message, key);
}

/** A one-signer transaction on the wire, and its signature in base58. */
function packed(instructions: TransactionInstruction[], payer: Keypair, blockhash: string, signWith: (m: Buffer) => Buffer) {
  const transaction = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash }).add(...instructions);
  const message = transaction.serializeMessage();
  const signature = signWith(message);
  return {
    raw: Buffer.concat([Buffer.from([1]), signature, message]).toString("base64"),
    signature: anchor.utils.bytes.bs58.encode(signature),
  };
}

let blockhash = "";
async function refreshBlockhash() {
  blockhash = (await rollup.getLatestBlockhash("confirmed")).blockhash;
}

const submit = (raw: string) =>
  rpc(ROLLUP_URL, "sendTransaction", [raw, { encoding: "base64", skipPreflight: true }]);

/**
 * The instructions of one transaction, built once. `nonce` is written into a
 * number the program does not act on (the write's price, the taker's limit),
 * so every transaction is distinct without rebuilding anything.
 *
 * "match" rests 10 asks of 3 lots one tick apart, each from its own seat,
 * then takes all 30 lots: 10 fills, 20 seat updates, in one transaction.
 */
async function workload(kind: Kind, id: number, user: Keypair) {
  const account = cellOf(id);
  const instructions =
    kind === "write"
      ? [await poke(id, user.publicKey, 0, 1)]
      : [
          await program.methods
            .restMany(1, new BN(2000), new BN(1), new BN(3), 200, 10)
            .accountsPartial({ user: user.publicKey, book: account })
            .instruction(),
          await program.methods
            .take(0, new BN(0), new BN(30), 7)
            .accountsPartial({ user: user.publicKey, book: account })
            .instruction(),
        ];
  const stamped = instructions[instructions.length - 1].data;
  return (nonce: number) => {
    stamped.writeBigUInt64LE(BigInt(1_000_000 + nonce), NONCE_AT);
    return instructions;
  };
}

/** Time from sending to the signature notification at one commitment. */
async function latency(kind: Kind, id: number, commitment: string) {
  const user = Keypair.generate();
  const build = await workload(kind, id, user);
  const socket = await Socket.open(ROLLUP_WS);
  const signWith = signer(user);
  const roundTrip: number[] = [];
  const notified: number[] = [];
  let failed = 0;
  let unheard = 0;
  for (let nth = 0; nth < SAMPLES; nth += 1) {
    if (nth % 100 === 0) await refreshBlockhash();
    const { raw, signature } = packed(build(nth), user, blockhash, signWith);
    let heard = 0;
    const refusal = await socket.subscribe("signatureSubscribe", [signature, { commitment }], (note) => {
      heard = performance.now();
      if (note?.value?.err) failed += 1;
    });
    if (refusal && nth === 0) console.log(`   signatureSubscribe ${commitment}: ${refusal}`);
    const sent = performance.now();
    const reply = await submit(raw);
    const returned = performance.now();
    if (reply?.error) {
      failed += 1;
      if (failed < 3) console.log("   send error:", brief(reply.error, 200));
      continue;
    }
    roundTrip.push(returned - sent);
    for (let waited = 0; waited < 300 && !heard; waited += 1) await sleep(1);
    if (heard) notified.push(heard - sent);
    else unheard += 1;
  }
  socket.close();
  console.log(
    `   "${commitment}": ${SAMPLES} sent one after another, ${failed} failed, ${unheard} never notified`,
  );
  console.log(`      ms until the sendTransaction call returns: ${JSON.stringify(summary(roundTrip))}`);
  if (notified.length) {
    console.log(`      ms from send to the "${commitment}" notification: ${JSON.stringify(summary(notified))}`);
  }
}

/** Which confirmation levels the rollup ever reports for a fresh transaction. */
async function levels(id: number) {
  const user = Keypair.generate();
  const build = await workload("write", id, user);
  const signWith = signer(user);
  const seen = new Map<string, number>();
  await refreshBlockhash();
  for (let nth = 0; nth < 100; nth += 1) {
    const { raw, signature } = packed(build(nth), user, blockhash, signWith);
    await submit(raw);
    const status = await rpc(ROLLUP_URL, "getSignatureStatuses", [[signature]]);
    const level = status?.value?.[0]?.confirmationStatus ?? "not found yet";
    seen.set(level, (seen.get(level) ?? 0) + 1);
  }
  console.log(
    "status asked for the instant sendTransaction returns, 100 transactions:",
    JSON.stringify(Object.fromEntries(seen)),
  );
}

/** Closed-loop senders in this process, each sending as fast as the rollup answers. */
async function sendLoop(job: Job) {
  await refreshBlockhash();
  const refresher = setInterval(() => void refreshBlockhash().catch(() => {}), 5000);
  let sent = 0;
  let refused = 0;
  let firstRefusal = "";
  const sampled: string[] = [];
  const senders = await Promise.all(
    Array.from({ length: job.senders }, async () => {
      const user = Keypair.generate();
      return { user, signWith: signer(user), build: await workload(job.kind, job.id, user) };
    }),
  );
  await sleep(Math.max(0, job.startAt - Date.now()));
  await Promise.all(
    senders.map(async ({ user, signWith, build }) => {
      for (let nonce = 0; Date.now() < job.endAt; nonce += 1) {
        const { raw, signature } = packed(build(nonce), user, blockhash, signWith);
        const reply = await submit(raw).catch((error) => ({ error: String(error) }));
        sent += 1;
        if (sent % 100 === 0) sampled.push(signature);
        if (reply?.error) {
          refused += 1;
          firstRefusal ||= brief(reply.error, 160);
        }
      }
    }),
  );
  clearInterval(refresher);
  // What became of one transaction in a hundred, asked after the run.
  await sleep(1000);
  const fate: Record<string, number> = {};
  for (let from = 0; from < sampled.length; from += 200) {
    const statuses = await rpc(ROLLUP_URL, "getSignatureStatuses", [
      sampled.slice(from, from + 200),
      { searchTransactionHistory: true },
    ]);
    for (const status of statuses?.value ?? []) {
      const outcome = status === null ? "not found" : status.err ? `failed ${brief(status.err, 80)}` : "ok";
      fate[outcome] = (fate[outcome] ?? 0) + 1;
    }
  }
  return { sent, refused, firstRefusal, fate };
}

/** The same loop in a child process, so the client is not one busy thread. */
function inChild(job: Job): Promise<{ sent: number; refused: number; firstRefusal: string; fate: Record<string, number> }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node_modules/.bin/ts-node", ["-P", "tsconfig.json", "tests/q6.ts"], {
      env: { ...process.env, Q6_JOB: JSON.stringify(job) },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("exit", () => {
      try {
        resolve(JSON.parse(out.trim().split("\n").pop()!));
      } catch {
        reject(new Error(`sender process said: ${out.slice(0, 300)}`));
      }
    });
  });
}

/** `senders` keys writing one account for SECONDS, counted by the account itself. */
async function throughput(kind: Kind, id: number, senders: number, executed: () => Promise<bigint>) {
  const processes = Math.min(PROCESSES, senders);
  const startAt = Date.now() + 9000;
  const endAt = startAt + SECONDS * 1000;
  const jobs = Array.from({ length: processes }, (_, nth) =>
    inChild({ kind, id, senders: Math.floor(senders / processes) + (nth < senders % processes ? 1 : 0), startAt, endAt }),
  );
  await sleep(startAt - Date.now());
  const before = await executed();
  const results = await Promise.all(jobs);
  await sleep(1500);
  const done = Number((await executed()) - before);
  const sent = results.reduce((sum, result) => sum + result.sent, 0);
  const refused = results.reduce((sum, result) => sum + result.refused, 0);
  const refusal = results.find((result) => result.firstRefusal)?.firstRefusal;
  const fate: Record<string, number> = {};
  for (const result of results) {
    for (const [outcome, count] of Object.entries(result.fate)) fate[outcome] = (fate[outcome] ?? 0) + count;
  }
  console.log(
    `   ${senders} sender${senders > 1 ? "s" : ""} in ${processes} process${processes > 1 ? "es" : ""}, ${SECONDS} s: sent ${sent}, refused at send ${refused}, executed ${done} = ${Math.round(done / SECONDS)} per second; fate of 1 in 100: ${JSON.stringify(fate)}${refusal ? ` (first refusal: ${refusal})` : ""}`,
  );
}

if (process.env.Q6_JOB) {
  main(async () => {
    console.log(JSON.stringify(await sendLoop(JSON.parse(process.env.Q6_JOB!))));
  });
} else {
  main(async () => {
    await ready();
    console.log(
      `machine: ${cpus()[0].model}, ${cpus().length} cores, ${(totalmem() / 2 ** 30).toFixed(0)} GB, macOS, Node ${process.version}; client, Solana validator, rollup and filter all on this one machine over loopback`,
    );
    const first = 220 + 2 * Math.floor(Math.random() * 15);
    const CELL = first;
    const BOOK = first + 1;
    await createCell(CELL, 64, { isPrivate: true, readers: [] });
    await grownCell(BOOK, BOOK_BYTES + 1000);
    const writes = async () => (await rollup.getAccountInfo(cellOf(CELL)))!.data.readBigUInt64LE(0);
    const matches = async () => (await rollup.getAccountInfo(cellOf(BOOK)))!.data.readBigUInt64LE(8) / 10n;

    console.log("\n== can a key with zero lamports pay the fee?");
    const broke = Keypair.generate();
    const signature = await send(rollup, await poke(CELL, broke.publicKey, 1, 1), broke);
    const landed = await rollup.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    console.log(
      `balance on Solana ${await base.getBalance(broke.publicKey)}, in the rollup ${await rollup.getBalance(broke.publicKey)}; its transaction landed with err=${JSON.stringify(landed?.meta?.err)} fee=${landed?.meta?.fee}`,
    );

    console.log("\n== latency, one sender, one transaction at a time");
    await levels(CELL);
    for (const [what, kind, id] of [
      ["simple write to one 64-byte private account", "write", CELL],
      ["rest 10 orders, then one taker fills all 10 (one 304 KB private book)", "match", BOOK],
    ] as [string, Kind, number][]) {
      console.log(what);
      for (const commitment of ["processed", "confirmed"]) await latency(kind, id, commitment);
    }

    console.log(`\n== sustained throughput, every sender writing the SAME account`);
    console.log("simple write");
    for (const senders of [1, 16, 64]) await throughput("write", CELL, senders, writes);
    console.log("rest 10 + match 10 (counted in transactions, each 10 fills)");
    for (const senders of [1, 16, 64]) await throughput("match", BOOK, senders, matches);
    const book = (await rollup.getAccountInfo(cellOf(BOOK)))!.data;
    console.log(`book afterwards: bids ${book.readUInt32LE(16)}, asks ${book.readUInt32LE(20)}, fills ${book.readBigUInt64LE(8)}`);
  });
}

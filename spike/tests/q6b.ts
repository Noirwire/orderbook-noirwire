/**
 * Question 6, follow-up. Why did accepted transactions go unexecuted under
 * concurrent load? Two suspects: a blockhash that expires sooner than on
 * Solana, and the rollup dropping transactions under load.
 */
import { spawn } from "child_process";
import { createPrivateKey, sign } from "crypto";
import * as anchor from "@anchor-lang/core";
import { Keypair, Transaction, TransactionInstruction } from "@solana/web3.js";
import { ROLLUP_URL, cellOf, createCell, main, poke, ready, rollup, rpc, sleep } from "./support";

const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");
const NONCE_AT = 9;
const SECONDS = Number(process.env.SECONDS ?? 10);

function signer(keypair: Keypair) {
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519, Buffer.from(keypair.secretKey.subarray(0, 32))]),
    format: "der",
    type: "pkcs8",
  });
  return (message: Buffer) => sign(null, message, key);
}

function packed(instructions: TransactionInstruction[], payer: Keypair, blockhash: string, signWith: (m: Buffer) => Buffer) {
  const transaction = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash }).add(...instructions);
  const message = transaction.serializeMessage();
  const signature = signWith(message);
  return {
    raw: Buffer.concat([Buffer.from([1]), signature, message]).toString("base64"),
    signature: anchor.utils.bytes.bs58.encode(signature),
  };
}

const submit = (raw: string, skipPreflight: boolean) =>
  rpc(ROLLUP_URL, "sendTransaction", [raw, { encoding: "base64", skipPreflight }]);

async function stampedPoke(id: number, user: Keypair) {
  const instruction = await poke(id, user.publicKey, 0, 1);
  return (nonce: number) => {
    instruction.data.writeBigUInt64LE(BigInt(1_000_000 + nonce), NONCE_AT);
    return [instruction];
  };
}

async function blockhashLifetime(id: number, count: () => Promise<bigint>) {
  const user = Keypair.generate();
  const build = await stampedPoke(id, user);
  const signWith = signer(user);
  const { blockhash } = await rollup.getLatestBlockhash("confirmed");
  const bornAt = Date.now();
  const bornSlot = await rollup.getSlot("confirmed");
  let lastGoodAge = 0;
  for (let nth = 0; nth < 120; nth += 1) {
    const before = await count();
    const age = Date.now() - bornAt;
    const reply = await submit(packed(build(nth), user, blockhash, signWith).raw, true);
    await sleep(150);
    const ran = (await count()) > before;
    if (ran) lastGoodAge = age;
    else {
      const slot = await rollup.getSlot("confirmed");
      const checked = await submit(packed(build(nth + 5000), user, blockhash, signWith).raw, false);
      console.log(
        `one blockhash stopped working at age ${age} ms (last worked at ${lastGoodAge} ms), ${slot - bornSlot} slots after it was fetched`,
      );
      console.log(`   the send that did not run answered: ${JSON.stringify(reply).slice(0, 160)}`);
      console.log(`   the same send WITH the pre-check answers: ${JSON.stringify(checked).slice(0, 260)}`);
      return;
    }
    await sleep(350);
  }
  console.log(`one blockhash still worked after ${lastGoodAge} ms`);
}

async function concurrent(id: number, senders: number, refreshMs: number, count: () => Promise<bigint>) {
  let blockhash = (await rollup.getLatestBlockhash("confirmed")).blockhash;
  let refreshes = 0;
  let longestGap = 0;
  let lastRefresh = Date.now();
  const refresher = setInterval(() => {
    void rollup.getLatestBlockhash("confirmed").then((latest) => {
      blockhash = latest.blockhash;
      refreshes += 1;
      longestGap = Math.max(longestGap, Date.now() - lastRefresh);
      lastRefresh = Date.now();
    });
  }, refreshMs);
  const keys = await Promise.all(
    Array.from({ length: senders }, async () => {
      const user = Keypair.generate();
      return { user, signWith: signer(user), build: await stampedPoke(id, user) };
    }),
  );
  const before = await count();
  const endAt = Date.now() + SECONDS * 1000;
  let sent = 0;
  let refused = 0;
  await Promise.all(
    keys.map(async ({ user, signWith, build }) => {
      for (let nonce = 0; Date.now() < endAt; nonce += 1) {
        const reply = await submit(packed(build(nonce), user, blockhash, signWith).raw, true);
        sent += 1;
        if (reply?.error) refused += 1;
      }
    }),
  );
  clearInterval(refresher);
  await sleep(1500);
  const executed = Number((await count()) - before);
  console.log(
    `${senders} senders, blockhash refreshed every ${refreshMs} ms (${refreshes} refreshes, longest gap ${longestGap} ms): sent ${sent}, refused ${refused}, executed ${executed}, lost ${sent - executed} (${(((sent - executed) / sent) * 100).toFixed(2)}%)`,
  );
}

type ChildJob = { id: number; senders: number; startAt: number; endAt: number };

/** One sender process: closed-loop senders, each reply inspected, nothing assumed. */
async function childLoop(job: ChildJob) {
  let blockhash = (await rollup.getLatestBlockhash("confirmed")).blockhash;
  const refresher = setInterval(() => {
    void rollup.getLatestBlockhash("confirmed").then((latest) => (blockhash = latest.blockhash));
  }, 2000);
  const keys = await Promise.all(
    Array.from({ length: job.senders }, async () => {
      const user = Keypair.generate();
      return { user, signWith: signer(user), build: await stampedPoke(job.id, user) };
    }),
  );
  await sleep(Math.max(0, job.startAt - Date.now()));
  let sent = 0;
  let refused = 0;
  let threw = 0;
  let noSignature = 0;
  const refusals: Record<string, number> = {};
  const samples: { nonce: number; signature: string }[][] = keys.map(() => []);
  const SAMPLED = new Set([0, 1, 2, 5, 20, 100, 400, 800, 1200, 1600]);
  await Promise.all(
    keys.map(async ({ user, signWith, build }, keyIndex) => {
      for (let nonce = 0; Date.now() < job.endAt; nonce += 1) {
        const { raw, signature } = packed(build(nonce), user, blockhash, signWith);
        if (SAMPLED.has(nonce)) samples[keyIndex].push({ nonce, signature });
        sent += 1;
        try {
          const reply = await submit(raw, true);
          if (reply?.error) {
            refused += 1;
            const why = JSON.stringify(reply.error).slice(0, 90);
            refusals[why] = (refusals[why] ?? 0) + 1;
          } else if (reply !== signature) noSignature += 1;
        } catch (error) {
          threw += 1;
          const why = String(error).slice(0, 90);
          refusals[why] = (refusals[why] ?? 0) + 1;
        }
      }
    }),
  );
  clearInterval(refresher);
  await sleep(1500);
  const perKey: string[] = [];
  for (const marks of samples) {
    const statuses = await rpc(ROLLUP_URL, "getSignatureStatuses", [
      marks.map((mark) => mark.signature),
      { searchTransactionHistory: true },
    ]);
    perKey.push(
      marks
        .map((mark, nth) => `${mark.nonce}:${statuses?.value?.[nth] === null ? "LOST" : statuses?.value?.[nth]?.err ? "err" : "ok"}`)
        .join(" "),
    );
  }
  console.error(perKey.map((line) => `      key ${line}`).join("\n"));
  console.log(JSON.stringify({ sent, refused, threw, noSignature, refusals }));
}

function inChild(job: ChildJob): Promise<{ sent: number; refused: number; threw: number; noSignature: number; refusals: Record<string, number> }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node_modules/.bin/ts-node", ["-P", "tsconfig.json", "tests/q6b.ts"], {
      env: { ...process.env, Q6B_JOB: JSON.stringify(job) },
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

async function manyProcesses(id: number, processes: number, sendersEach: number, count: () => Promise<bigint>) {
  const startAt = Date.now() + 9000;
  const endAt = startAt + SECONDS * 1000;
  const before = await count();
  const results = await Promise.all(
    Array.from({ length: processes }, () => inChild({ id, senders: sendersEach, startAt, endAt })),
  );
  await sleep(2000);
  const executed = Number((await count()) - before);
  const total = (field: "sent" | "refused" | "threw" | "noSignature") =>
    results.reduce((sum, result) => sum + result[field], 0);
  const refusals: Record<string, number> = {};
  for (const result of results) {
    for (const [why, times] of Object.entries(result.refusals)) refusals[why] = (refusals[why] ?? 0) + times;
  }
  const accepted = total("sent") - total("refused") - total("threw") - total("noSignature");
  console.log(
    `${processes} processes x ${sendersEach} senders: sent ${total("sent")}, refused ${total("refused")}, threw ${total("threw")}, odd reply ${total("noSignature")}, accepted ${accepted}, executed ${executed}, accepted but not executed ${accepted - executed}`,
  );
  if (Object.keys(refusals).length) console.log(`   refusals: ${JSON.stringify(refusals)}`);
}

if (process.env.Q6B_JOB) {
  main(async () => {
    await childLoop(JSON.parse(process.env.Q6B_JOB!));
  });
} else
main(async () => {
  await ready();
  const CELL = 180 + Math.floor(Math.random() * 30);
  await createCell(CELL, 64, { isPrivate: true, readers: [] });
  const count = async () => (await rollup.getAccountInfo(cellOf(CELL)))!.data.readBigUInt64LE(0);

  const slotA = await rollup.getSlot("confirmed");
  await sleep(2000);
  const slotB = await rollup.getSlot("confirmed");
  console.log(`rollup slot time: ${(2000 / (slotB - slotA)).toFixed(1)} ms (${slotB - slotA} slots in 2 s)`);

  if (process.env.ONLY !== "processes") {
    console.log("\n== how long does one blockhash stay valid?");
    await blockhashLifetime(CELL, count);

    console.log("\n== concurrent senders on one account, same key set-up, only the refresh interval changes");
    for (const [senders, refreshMs] of [
      [16, 5000],
      [64, 400],
    ]) {
      await concurrent(CELL, senders, refreshMs, count);
    }
  }

  console.log("\n== several sender PROCESSES on one account, every reply inspected");
  for (const [processes, sendersEach] of [
    [1, 16],
    [4, 4],
    [4, 16],
    [8, 8],
  ]) {
    await manyProcesses(CELL, processes, sendersEach, count);
  }
});

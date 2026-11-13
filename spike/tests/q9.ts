/**
 * Question 9. What it costs to keep trigger orders (take-profit, stop-loss,
 * scheduled buys) in one sealed account with a fixed slot per seat.
 *
 * Layout A is the slots alone, scanned in full. Layout B adds three binary
 * heaps (fire above, fire below, due time) and a back-pointer per slot.
 * Measured on the local Solana validator and inside the local private rollup.
 *
 * Bulk setup (`trig_fill`) writes slots in whatever order makes the heap
 * arrays valid without sifting; it is not what a real insert costs.
 */
import * as anchor from "@anchor-lang/core";
import { Connection, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  SPONSOR,
  admin,
  airdropped,
  base,
  bigOf,
  cellOf,
  computeLimit,
  createCell,
  failure,
  main,
  program,
  ready,
  rollup,
  send,
  until,
} from "./support";

const STEP = 10_240;
const LIMIT = 1_400_000;
const ACCOUNT_LIMIT = 10_485_760;
const SEATS = 34_492;
const SCAN_SIZES = [1_024, 4_096, 8_192, 16_384, 34_492];
const HEAP_SIZES = [1_024, 16_384, 34_492];
const POP_COUNTS = [1, 8, 32];
const BN = anchor.BN;

const HEAPS = ["fire-above (min by trigger)", "fire-below (max by trigger)", "due-time (min by next time)"];
const aboveKey = (slot: number) => 2_000_000 + 16 * slot;
const belowKey = (slot: number) => 500_000 - 8 * slot;
const timeKey = (slot: number) => 1_000_000_000 + 60 * slot;
const keyOf = [aboveKey, belowKey, timeKey];
const recordOf = [(slot: number) => slot & 1, (slot: number) => 1 - (slot & 1), () => 0];
const NO_PRICE_DUE = 1_000_000;
const ALL_ABOVE_DUE = 100_000_000;
const ALL_TIME_DUE = 2_000_000_000;

type Env = { name: string; conn: Connection; signer: Keypair; fillChunk: number };
type Sizes = { priceRec: number; dcaRec: number; slotA: number; slotB: number; header: number };

const lastLog = (text: string | null) => (text ?? "ok").split("\n").filter(Boolean).slice(-2).join(" / ").slice(0, 200);
const num = (value: number) => value.toLocaleString("en-US");
const pad = (value: string | number, width: number) => String(typeof value === "number" ? num(value) : value).padStart(width);

let sizes: Sizes;
const bytesA = (seats: number) => sizes.header + seats * sizes.slotA;
const bytesB = (seats: number) => sizes.header + seats * sizes.slotB + 3 * seats * 4;

async function unitsOn(conn: Connection, signature: string) {
  const landed = await until(
    () => conn.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }),
    `transaction ${signature}`,
    10_000,
    50,
  );
  return { units: landed.meta?.computeUnitsConsumed ?? -1, logs: landed.meta?.logMessages ?? [] };
}

/** Runs one instruction as its own transaction. Resolves to units and logs, or to the failure text. */
async function run(env: Env, account: PublicKey, build: (methods: any) => any) {
  const instruction: TransactionInstruction = await build(program.methods)
    .accountsPartial({ user: env.signer.publicKey, book: account })
    .instruction();
  let signature = "";
  const error = await failure(
    (async () => {
      signature = await send(env.conn, [computeLimit(LIMIT), instruction], env.signer);
    })(),
  );
  if (error) return { error: lastLog(error) };
  return unitsOn(env.conn, signature);
}

const must = async (env: Env, account: PublicKey, build: (methods: any) => any) => {
  const result = await run(env, account, build);
  if ("error" in result) throw new Error(`unexpected failure: ${result.error}`);
  return result;
};

const growBase = (id: number, newLen: number) =>
  program.methods.growBig(id, new BN(newLen)).accountsPartial({ payer: admin.publicKey, big: bigOf(id) }).instruction();

const growRollup = (user: PublicKey, id: number, newLen: number) =>
  program.methods
    .growCell(id, newLen)
    .accountsPartial({ user, sponsor: SPONSOR, cell: cellOf(id), vault: EPHEMERAL_VAULT_ID, magicProgram: MAGIC_PROGRAM_ID })
    .instruction();

/** Creates a Solana account of `size` bytes owned by the program, in 10,240 byte steps. */
async function createOnBase(id: number, size: number) {
  await send(base, await program.methods.initBig(id, new BN(STEP)).accountsPartial({ payer: admin.publicKey, big: bigOf(id) }).instruction(), admin);
  // A grow costs more as the account gets bigger, so the batch halves when one runs out of compute.
  let perTransaction = 36;
  for (let length = STEP; length < size; ) {
    const batch: TransactionInstruction[] = [computeLimit(LIMIT)];
    let reached = length;
    while (reached < size && batch.length <= perTransaction) {
      reached = Math.min(size, reached + STEP);
      batch.push(await growBase(id, reached));
    }
    const error = await failure(send(base, batch, admin));
    if (error) {
      if (perTransaction <= 1) throw new Error(error);
      perTransaction = Math.floor(perTransaction / 2);
      continue;
    }
    length = reached;
  }
  return bigOf(id);
}

/** Creates a sealed account of `size` bytes inside the rollup, in 10,240 byte steps. */
async function createInRollup(id: number, size: number, user: Keypair) {
  await createCell(id, STEP, { isPrivate: true, readers: [] }, user);
  for (let length = STEP; length < size; ) {
    const batch: TransactionInstruction[] = [computeLimit(LIMIT)];
    while (length < size && batch.length <= 30) {
      length = Math.min(size, length + STEP);
      batch.push(await growRollup(user.publicKey, id, length));
    }
    await send(rollup, batch, user);
  }
  return cellOf(id);
}

async function lengthOf(conn: Connection, account: PublicKey) {
  return (await conn.getAccountInfo(account))?.data.length ?? 0;
}

/** Fills slots in chunks, halving the chunk if a call runs out of compute. */
async function fillAll(env: Env, account: PublicKey, kind: number, seats: number, heapN: number) {
  for (let first = 0; first < seats; ) {
    const count = Math.min(env.fillChunk, seats - first);
    const result = await run(env, account, (m) => m.trigFill(kind, first, count, heapN));
    if ("error" in result) {
      if (env.fillChunk <= 50) throw new Error(`fill failed at ${first}: ${result.error}`);
      env.fillChunk = Math.floor(env.fillChunk / 2);
      console.log(`  fill chunk too big (${result.error.slice(0, 80)}), now ${env.fillChunk}`);
      continue;
    }
    first += count;
  }
}

async function scanTable(env: Env, account: PublicKey, seats: number) {
  console.log(`\n== layout A, flat scan, ${env.name}: ${num(seats)} slots in the account`);
  await must(env, account, (m) => m.trigInit(1, seats));
  const started = Date.now();
  await fillAll(env, account, 1, seats, 0);
  console.log(`bulk setup of ${num(seats)} slots: ${Date.now() - started} ms (chunk ${env.fillChunk} slots per call)`);

  const scenarios: [string, number, number, boolean][] = [
    ["TP+SL, none due", NO_PRICE_DUE, 0, false],
    ["TP+SL, one record per slot due", ALL_ABOVE_DUE, 0, false],
    ["TP+SL+DCA, all DCA due", ALL_ABOVE_DUE, ALL_TIME_DUE, true],
  ];
  const slope: Record<string, { perSlot: number; fixed: number }> = {};
  console.log(`${"scenario".padEnd(34)}${pad("slots", 8)}${pad("CU", 11)}${pad("CU/slot", 10)}${pad("CU/record", 11)}`);
  for (const [label, mark, now, dca] of scenarios) {
    const seen: [number, number][] = [];
    for (const n of SCAN_SIZES.filter((size) => size <= seats)) {
      const result = await run(env, account, (m) => m.trigScan(new BN(mark), new BN(now), 0, n, dca));
      if ("error" in result) {
        console.log(`${label.padEnd(34)}${pad(n, 8)}${pad("over limit", 11)}  ${result.error.slice(0, 90)}`);
        continue;
      }
      seen.push([n, result.units]);
      const records = dca ? 3 * n : 2 * n;
      console.log(`${label.padEnd(34)}${pad(n, 8)}${pad(result.units, 11)}${pad((result.units / n).toFixed(1), 10)}${pad((result.units / records).toFixed(1), 11)}`);
    }
    if (seen.length >= 2) {
      const [[n1, c1], [n2, c2]] = [seen[0], seen[seen.length - 1]];
      const perSlot = (c2 - c1) / (n2 - n1);
      slope[label] = { perSlot, fixed: c1 - perSlot * n1 };
    }
  }

  console.log(`\nmost slots one transaction can scan (limit ${num(LIMIT)} CU), predicted from the slope then run:`);
  for (const [label, mark, now, dca] of scenarios) {
    const fit = slope[label];
    if (!fit) continue;
    const predicted = Math.floor((LIMIT - fit.fixed) / fit.perSlot);
    if (predicted >= seats) {
      console.log(`${label.padEnd(34)}predicted ${num(predicted)} slots, so the whole ${num(seats)} fit; at ${fit.perSlot.toFixed(1)} CU/slot`);
      continue;
    }
    let best = predicted;
    let ok = await run(env, account, (m) => m.trigScan(new BN(mark), new BN(now), 0, best, dca));
    while ("error" in ok && best > 1) {
      best = Math.floor(best * 0.99);
      ok = await run(env, account, (m) => m.trigScan(new BN(mark), new BN(now), 0, best, dca));
    }
    const over = Math.min(seats, Math.ceil(best * 1.01));
    const past = await run(env, account, (m) => m.trigScan(new BN(mark), new BN(now), 0, over, dca));
    console.log(
      `${label.padEnd(34)}${num(best)} slots ok (${"units" in ok ? num(ok.units) : "?"} CU); ${num(over)} ${"error" in past ? "fails" : "also passes"}; ${fit.perSlot.toFixed(1)} CU/slot, ${num(Math.round(fit.fixed))} CU fixed`,
    );
    const chunk = Math.floor(best * 0.98);
    let total = 0;
    let calls = 0;
    for (let start = 0; start < seats; start += chunk) {
      const piece = await must(env, account, (m) => m.trigScan(new BN(mark), new BN(now), start, Math.min(seats, start + chunk), dca));
      total += piece.units;
      calls += 1;
    }
    console.log(`${"".padEnd(34)}full ${num(seats)}-slot pass in chunks of ${num(chunk)}: ${calls} transactions, ${num(total)} CU in all`);
  }
}

async function checkHeap(env: Env, account: PublicKey, heap: number, length: number) {
  for (let start = 0; start < length; start += 4_000) {
    const result = await must(env, account, (m) => m.trigCheck(heap, start, start + 4_000));
    const line = result.logs.find((entry) => entry.includes("ok="));
    if (!line?.includes("ok=true")) return `FAILED at ${start}: ${line}`;
  }
  return "ok";
}

type HeapRow = Record<string, number | string>;

async function heapTable(env: Env, account: PublicKey, seats: number) {
  console.log(`\n== layout B, three heaps, ${env.name}: ${num(seats)} slots in the account`);
  await must(env, account, (m) => m.trigInit(2, seats));
  const summary: { n: number; heap: number; pop: Record<number, number>; idle: number; insertRoot: number; removeRoot: number }[] = [];
  for (const n of HEAP_SIZES) {
    if (n > seats) continue;
    const started = Date.now();
    await fillAll(env, account, 2, seats, n);
    console.log(`\nheap size ${num(n)} in each heap (bulk setup ${Date.now() - started} ms, chunk ${env.fillChunk})`);
    console.log(
      `${"heap".padEnd(30)}${pad("rm tail", 9)}${pad("rm mid", 9)}${pad("rm root", 9)}${pad("ins tail", 10)}${pad("ins mid", 9)}${pad("ins best", 10)}${pad("peek", 7)}${pad("pop 1", 8)}${pad("pop 8", 9)}${pad("pop 32", 9)}${pad("/pop@32", 9)}`,
    );
    for (const heap of [0, 1, 2]) {
      const row: HeapRow = {};
      const at = { tail: n - 1, mid: Math.floor(n / 2), root: 0 };
      for (const [where, slot] of Object.entries(at)) {
        const removed = await must(env, account, (m) => m.trigRemove(heap, slot));
        const inserted = await must(env, account, (m) => m.trigInsert(heap, slot, recordOf[heap](slot), new BN(keyOf[heap](slot))));
        row[`rm ${where}`] = removed.units;
        row[`ins ${where}`] = inserted.units;
      }
      const due = (count: number): [number, number] => {
        const key = keyOf[heap](count - 1);
        return heap === 2 ? [0, key] : [key, 0];
      };
      const idleArgs: [number, number] = heap === 0 ? [0, 0] : heap === 1 ? [Number.MAX_SAFE_INTEGER, 0] : [0, 0];
      const idle = await must(env, account, (m) => m.trigPopDue(heap, new BN(idleArgs[0]), new BN(idleArgs[1]), 1));
      row.peek = idle.units;
      const pops: Record<number, number> = {};
      for (const count of POP_COUNTS) {
        const [mark, now] = due(count);
        const popped = await must(env, account, (m) => m.trigPopDue(heap, new BN(mark), new BN(now), count));
        const got = popped.logs.find((entry) => entry.includes("popped="));
        if (!got?.includes(`popped=${count}`)) throw new Error(`heap ${heap} n ${n}: wanted ${count} popped, saw ${got}`);
        pops[count] = popped.units;
        const batch: TransactionInstruction[] = [computeLimit(LIMIT)];
        for (let slot = 0; slot < count; slot++) {
          batch.push(
            await program.methods
              .trigInsert(heap, slot, recordOf[heap](slot), new BN(keyOf[heap](slot)))
              .accountsPartial({ user: env.signer.publicKey, book: account })
              .instruction(),
          );
        }
        await send(env.conn, batch, env.signer);
      }
      const perPop = (pops[32] - pops[1]) / 31;
      console.log(
        `${HEAPS[heap].padEnd(30)}${pad(row["rm tail"], 9)}${pad(row["rm mid"], 9)}${pad(row["rm root"], 9)}${pad(row["ins tail"], 10)}${pad(row["ins mid"], 9)}${pad(row["ins root"], 10)}${pad(row.peek, 7)}${pad(pops[1], 8)}${pad(pops[8], 9)}${pad(pops[32], 9)}${pad(perPop.toFixed(0), 9)}`,
      );
      summary.push({ n, heap, pop: pops, idle: idle.units, insertRoot: row["ins root"] as number, removeRoot: row["rm root"] as number });
    }
    for (const heap of [0, 1, 2]) {
      console.log(`  invariants after the operations, ${HEAPS[heap]}: ${await checkHeap(env, account, heap, n)}`);
    }
  }
  return summary;
}

function firesPerTransaction(summary: Awaited<ReturnType<typeof heapTable>>) {
  const largest = Math.max(...summary.map((row) => row.n));
  const top = summary.filter((row) => row.n === largest);
  if (top.length === 0) return;
  const popOne = Math.max(...top.map((row) => (row.pop[32] - row.pop[1]) / 31));
  const reinsert = Math.max(...top.map((row) => row.insertRoot));
  console.log(`\nfires per transaction at heap size ${num(largest)}, if each fire costs (pop ${popOne.toFixed(0)} CU) + the order path:`);
  console.log(`${pad("order path CU", 14)}${pad("fires / tx", 12)}   (a partial fill that re-queues adds about ${num(Math.round(reinsert))} CU for the insert)`);
  for (const order of [10_000, 25_000, 50_000, 100_000, 200_000]) {
    console.log(`${pad(order, 14)}${pad(Math.floor(LIMIT / (popOne + order)), 12)}`);
  }
}

function byteTable(rows: { layout: string; seats: number; planned: number; actual: number }[]) {
  console.log(`\n== account bytes (limit ${num(ACCOUNT_LIMIT)})`);
  console.log(`${"layout".padEnd(24)}${pad("seats", 8)}${pad("planned", 12)}${pad("created", 12)}${pad("per seat", 10)}${pad("% of limit", 12)}  fits`);
  for (const row of rows) {
    console.log(
      `${row.layout.padEnd(24)}${pad(row.seats, 8)}${pad(row.planned, 12)}${pad(row.actual, 12)}${pad((row.planned / row.seats).toFixed(1), 10)}${pad(((100 * row.planned) / ACCOUNT_LIMIT).toFixed(1), 12)}  ${row.actual === row.planned && row.actual <= ACCOUNT_LIMIT ? "yes" : "NO"}`,
    );
  }
}

main(async () => {
  await ready(20);
  if ((await base.getBalance(admin.publicKey)) < 250 * 1_000_000_000) await airdropped(admin.publicKey, 400);
  const first = 100 + Math.floor(Math.random() * 4) * 4;
  const user = Keypair.generate();
  const onBase: Env = { name: "local Solana validator", conn: base, signer: admin, fillChunk: 2_000 };
  const inRollup: Env = { name: "local private rollup", conn: rollup, signer: user, fillChunk: 2_000 };

  const sizeLog = await (async () => {
    const signature = await send(base, await program.methods.trigSizes().accountsPartial({ user: admin.publicKey }).instruction(), admin);
    return (await unitsOn(base, signature)).logs.find((line) => line.includes("sizes price_rec"));
  })();
  const pick = (name: string) => Number(sizeLog?.match(new RegExp(`${name}=(\\d+)`))?.[1]);
  sizes = { priceRec: pick("price_rec"), dcaRec: pick("dca_rec"), slotA: pick("slot_a"), slotB: pick("slot_b"), header: pick("header") };
  console.log("== record sizes (bytes), from size_of in the program");
  console.log(`TP or SL record ${sizes.priceRec}, DCA record ${sizes.dcaRec}, owner 32`);
  console.log(`layout A slot ${sizes.slotA} bytes per seat (owner + TP + SL + DCA)`);
  console.log(`layout B slot ${sizes.slotB} bytes per seat (A + three u32 back-pointers + pad), plus 3 heaps x 4 bytes = ${sizes.slotB + 12} bytes per seat`);
  console.log(`header ${sizes.header} bytes`);

  console.log("\n== creating accounts on the local Solana validator");
  const plan = [
    { layout: "A flat", seats: 8_192, planned: bytesA(8_192), id: first },
    { layout: "A flat", seats: 34_492, planned: bytesA(34_492), id: first + 1 },
    { layout: "B three heaps", seats: 8_192, planned: bytesB(8_192), id: first + 2 },
    { layout: "B three heaps", seats: 34_492, planned: bytesB(34_492), id: first + 3 },
  ];
  const rows: { layout: string; seats: number; planned: number; actual: number }[] = [];
  const accounts: PublicKey[] = [];
  for (const item of plan) {
    const started = Date.now();
    const before = await base.getBalance(admin.publicKey);
    const account = await createOnBase(item.id, item.planned);
    const actual = await lengthOf(base, account);
    console.log(`${item.layout} ${num(item.seats)} seats: ${num(actual)} bytes, ${Date.now() - started} ms, rent ${((before - (await base.getBalance(admin.publicKey))) / 1e9).toFixed(2)} SOL (refundable)`);
    rows.push({ layout: item.layout, seats: item.seats, planned: item.planned, actual });
    accounts.push(account);
  }
  byteTable(rows);

  await scanTable(onBase, accounts[1], SEATS);
  const baseSummary = await heapTable(onBase, accounts[3], SEATS);
  firesPerTransaction(baseSummary);

  console.log("\n== creating accounts inside the local private rollup, paid by the sponsor");
  const inside: Record<string, { account: PublicKey; seats: number } | null> = { A: null, B: null };
  let id = first + 4;
  // The layout that needs more room goes first: a failed attempt leaves its bytes behind in the rollup's database.
  for (const [letter, bytes] of [["B", bytesB], ["A", bytesA]] as [string, (seats: number) => number][]) {
    for (const seats of [SEATS, 24_576, 16_384, 8_192]) {
      const started = Date.now();
      const error = await failure(
        (async () => {
          const account = await createInRollup(id++, bytes(seats), user);
          const actual = await lengthOf(rollup, account);
          if (actual !== bytes(seats)) throw new Error(`created ${actual} bytes, wanted ${bytes(seats)}`);
          inside[letter] = { account, seats };
        })(),
      );
      console.log(`layout ${letter}, ${num(seats)} seats (${num(bytes(seats))} bytes) in the rollup: ${error ? `FAILED ${lastLog(error)}` : `ok in ${Date.now() - started} ms`}`);
      if (!error) break;
    }
  }
  if (inside.A) await scanTable(inRollup, inside.A.account, inside.A.seats);
  if (inside.B) firesPerTransaction(await heapTable(inRollup, inside.B.account, inside.B.seats));
});

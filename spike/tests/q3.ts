/**
 * Question 3. A big account for a zero-copy book: created inside the rollup,
 * or created on Solana and delegated. Then compute units for resting and
 * matching orders in it, and where the per-transaction compute ceiling sits.
 */
import * as anchor from "@anchor-lang/core";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  EPHEMERAL_VAULT_ID,
  MAGIC_PROGRAM_ID,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationMetadataPdaFromDelegatedAccount,
  delegationRecordPdaFromDelegatedAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  PROGRAM_ID,
  SPONSOR,
  VALIDATOR,
  admin,
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
  unitsOf,
  until,
} from "./support";

const KB = 1024;
const MB = 1024 * KB;
const STEP = 10_240;
const BOOK_BYTES = 24 + 2 * 512 * 40 + 4096 * 64;
const BID = 0;
const ASK = 1;
const user = Keypair.generate();
const BN = anchor.BN;
const firstLine = (text: string | null) => (text ?? "ok").split("\n").slice(0, 1).join("").slice(0, 200);
const lastLog = (text: string | null) => (text ?? "ok").split("\n").filter(Boolean).slice(-2).join(" / ").slice(0, 260);

const growCell = (id: number, newLen: number) =>
  program.methods
    .growCell(id, newLen)
    .accountsPartial({
      user: user.publicKey,
      sponsor: SPONSOR,
      cell: cellOf(id),
      vault: EPHEMERAL_VAULT_ID,
      magicProgram: MAGIC_PROGRAM_ID,
    })
    .instruction();

/** Creates cell `id` of `size` bytes in the rollup, by whatever route works. */
async function rollupAccount(id: number, size: number) {
  const before = await rollup.getBalance(SPONSOR);
  const started = Date.now();
  const oneStep = await failure(createCell(id, size, { isPrivate: true, readers: [] }, user));
  let transactions = 1;
  if (oneStep) {
    console.log(`  create ${size} bytes in one instruction: FAILED ${lastLog(oneStep)}`);
    await createCell(id, STEP, { isPrivate: true, readers: [] }, user);
    let length = STEP;
    while (length < size) {
      const batch: TransactionInstruction[] = [computeLimit(1_400_000)];
      // 64 instructions per transaction, inner calls included: 30 grows of two each.
      while (length < size && batch.length <= 30) {
        length = Math.min(size, length + STEP);
        batch.push(await growCell(id, length));
      }
      await send(rollup, batch, user);
      transactions += 1;
    }
  } else {
    console.log(`  create ${size} bytes in one instruction: ok`);
  }
  const account = await rollup.getAccountInfo(cellOf(id));
  console.log(
    `  rollup account of ${account?.data.length} bytes: ${transactions} transactions, ${Date.now() - started} ms, sponsor paid ${before - (await rollup.getBalance(SPONSOR))} lamports`,
  );
}

/** Creates PDA `id` of `size` bytes on Solana, then delegates it. */
async function delegatedAccount(id: number, size: number) {
  const big = bigOf(id);
  const before = await base.getBalance(admin.publicKey);
  const started = Date.now();
  const accounts = { payer: admin.publicKey, big };
  await send(base, await program.methods.initBig(id, new BN(STEP)).accountsPartial(accounts).instruction(), admin);
  let transactions = 1;
  let length = STEP;
  while (length < size) {
    const batch: TransactionInstruction[] = [computeLimit(400_000)];
    while (length < size && batch.length <= 12) {
      length = Math.min(size, length + STEP);
      batch.push(await program.methods.growBig(id, new BN(length)).accountsPartial(accounts).instruction());
    }
    await send(base, batch, admin);
    transactions += 1;
  }
  const created = Date.now() - started;
  const rent = before - (await base.getBalance(admin.publicKey));
  console.log(
    `  Solana account of ${size} bytes: ${transactions} transactions, ${created} ms, cost ${rent} lamports (${(rent / LAMPORTS_PER_SOL).toFixed(4)} SOL, rent is refundable)`,
  );

  const delegateStarted = Date.now();
  const delegated = await failure(
    send(
      base,
      [
        computeLimit(1_400_000),
        await program.methods
          .delegateBig(id, VALIDATOR)
          .accountsPartial({
            payer: admin.publicKey,
            big,
            bufferBig: delegateBufferPdaFromDelegatedAccountAndOwnerProgram(big, PROGRAM_ID),
            delegationRecordBig: delegationRecordPdaFromDelegatedAccount(big),
            delegationMetadataBig: delegationMetadataPdaFromDelegatedAccount(big),
          })
          .instruction(),
      ],
      admin,
    ),
  );
  if (delegated) {
    console.log(`  delegate ${size} bytes: FAILED ${lastLog(delegated)}`);
    return false;
  }
  console.log(`  delegate ${size} bytes: ok in ${Date.now() - delegateStarted} ms`);
  const usable = await failure(
    (async () => {
      if (size >= BOOK_BYTES) {
        await send(rollup, [computeLimit(1_400_000), await rest(big, BID, 100, 1, 0)], user);
      }
      await until(
        async () => (await rollup.getAccountInfo(big))?.data.length === size,
        "the delegated account in the rollup",
        30_000,
      );
    })(),
  );
  console.log(
    `  ${size >= BOOK_BYTES ? "first write to it in the rollup" : "seen in the rollup at full size"}: ${usable ? `FAILED ${lastLog(usable)}` : `ok, ${Date.now() - delegateStarted} ms after the delegate was sent`}`,
  );
  return !usable;
}

const rest = (book: PublicKey, side: number, price: number, size: number, seat: number) =>
  program.methods
    .rest(side, new BN(price), new BN(size), seat)
    .accountsPartial({ user: user.publicKey, book })
    .instruction();

const restMany = (book: PublicKey, side: number, firstPrice: number, step: number, size: number, firstSeat: number, count: number) =>
  program.methods
    .restMany(side, new BN(firstPrice), new BN(step), new BN(size), firstSeat, count)
    .accountsPartial({ user: user.publicKey, book })
    .instruction();

const take = (book: PublicKey, side: number, limit: number, size: number, seat: number) =>
  program.methods
    .take(side, new BN(limit), new BN(size), seat)
    .accountsPartial({ user: user.publicKey, book })
    .instruction();

const clear = (book: PublicKey) =>
  program.methods.clearBook().accountsPartial({ user: user.publicKey, book }).instruction();

async function units(instruction: Promise<TransactionInstruction>) {
  return unitsOf(await send(rollup, [computeLimit(1_400_000), await instruction], user));
}

async function computeUnits(book: PublicKey, label: string) {
  console.log(`\n== compute units, book in ${label}`);
  await send(rollup, await clear(book), user);
  console.log("rest one order in an empty book:", await units(rest(book, BID, 1000, 5, 1)));
  await send(rollup, await clear(book), user);

  // 511 bids from 1000 upward: the side is one short of full.
  for (let done = 0; done < 511; ) {
    const count = Math.min(64, 511 - done);
    await send(rollup, [computeLimit(1_400_000), await restMany(book, BID, 1000 + done, 1, 5, 100 + done, count)], user);
    done += count;
  }
  console.log("rest one order at the BEST price, 511 resting (no shift):", await units(rest(book, BID, 5000, 5, 1)));
  await send(rollup, await clear(book), user);
  for (let done = 0; done < 511; ) {
    const count = Math.min(64, 511 - done);
    await send(rollup, [computeLimit(1_400_000), await restMany(book, BID, 1000 + done, 1, 5, 100 + done, count)], user);
    done += count;
  }
  console.log("rest one order at the WORST price, 511 resting (shifts 511 orders):", await units(rest(book, BID, 1, 5, 1)));
  console.log("rest one order in a FULL side:", firstLine(await failure(send(rollup, await rest(book, BID, 2, 5, 1), user))).slice(0, 80));

  for (const fills of [1, 10, 32]) {
    await send(rollup, await clear(book), user);
    await send(
      rollup,
      [computeLimit(1_400_000), await restMany(book, ASK, 2000, 1, 3, 200, 64)],
      user,
    );
    const signature = await send(
      rollup,
      [computeLimit(1_400_000), await take(book, BID, 9999, 3 * fills, 7)],
      user,
    );
    const landed = await rollup.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    console.log(
      `taker against ${fills} resting orders, both seats updated per fill: ${landed?.meta?.computeUnitsConsumed} CU (${landed?.meta?.logMessages?.find((line) => line.includes("fills="))})`,
    );
  }
  const data = (await rollup.getAccountInfo(book))!.data;
  console.log(
    "book after the 32-fill match: asks left",
    data.readUInt32LE(20),
    "fills counted",
    data.readBigUInt64LE(8),
    "taker seat base",
    data.readBigInt64LE(24 + 2 * 512 * 40 + 7 * 64 + 32),
  );
}

async function ceiling() {
  console.log("\n== compute ceiling per transaction in the rollup");
  const burn = (rounds: number) =>
    program.methods.burn(rounds).accountsPartial({ user: user.publicKey }).instruction();
  const tries: [string, number | null, number][] = [
    ["no limit asked, small work", null, 1_000],
    ["no limit asked, 300k CU of work", null, 30_000],
    ["limit 1,400,000 asked, about 1.2M CU of work", 1_400_000, 120_000],
    ["limit 1,400,000 asked, about 2M CU of work", 1_400_000, 200_000],
    ["limit 10,000,000 asked, about 2M CU of work", 10_000_000, 200_000],
  ];
  for (const [what, limit, rounds] of tries) {
    const instructions = [...(limit ? [computeLimit(limit)] : []), await burn(rounds)];
    let signature = "";
    const failed = await failure(
      (async () => {
        signature = await send(rollup, instructions, user);
      })(),
    );
    const used = failed
      ? (failed.match(/consumed (\d+) of (\d+)/) ?? [failed.split("\n")[0]])[0]
      : `${await unitsOf(signature)} CU used`;
    console.log(`${what}: ${failed ? "FAILED" : "ok"} (${used})`);
  }
}

main(async () => {
  await ready(20);
  // Fresh accounts on every run, so the script can be repeated on one network.
  const first = 60 + 4 * Math.floor(Math.random() * 5);

  console.log("== a book needs", BOOK_BYTES, "bytes (512 orders a side at 40 bytes, 4,096 seats at 64 bytes)");

  console.log("\n== created inside the rollup, paid by the sponsor");
  console.log("1 MB:");
  await rollupAccount(first, MB);
  console.log("4 MB:");
  await rollupAccount(first + 1, 4 * MB);
  // 10 MB is left to `TEN_MB=1 make q3`: on the stock local rollup it fails
  // with "Database full", and what it leaves behind is not worth risking the
  // measurements that follow.
  if (process.env.TEN_MB) {
    console.log("10 MB (Solana's own account limit):");
    await failure(rollupAccount(first + 2, 10 * MB)).then((error) => error && console.log("  FAILED", lastLog(error)));
  }

  console.log("\n== created on Solana in steps, then delegated");
  let delegatedBook: PublicKey | null = null;
  for (const [label, id, size] of [
    ["10 KB", first, STEP],
    ["100 KB", first + 1, 100 * KB],
    ["1 MB", first + 2, MB],
    ["4 MB", first + 3, 4 * MB],
  ] as [string, number, number][]) {
    console.log(`${label}:`);
    const error = await failure(
      (async () => {
        if ((await delegatedAccount(id, size)) && size >= MB && !delegatedBook) delegatedBook = bigOf(id);
      })(),
    );
    if (error) console.log(`  FAILED ${lastLog(error)}`);
  }

  await computeUnits(cellOf(first), "a 1 MB account created inside the rollup");
  if (delegatedBook) await computeUnits(delegatedBook, "a 1 MB delegated account");
  await ceiling();
});

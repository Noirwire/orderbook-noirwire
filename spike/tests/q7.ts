/**
 * Question 7. The built-in scheduler: does ScheduleTask run on the local
 * rollup, how closely does it keep an interval, what does it cost, and how is
 * a task cancelled?
 */
import * as anchor from "@anchor-lang/core";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { MAGIC_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  ROLLUP_WS,
  SPONSOR,
  Socket,
  brief,
  cellOf,
  createCell,
  failure,
  main,
  program,
  ready,
  rollup,
  send,
  sleep,
  summary,
} from "./support";

const BN = anchor.BN;
const lastLog = (text: string | null) =>
  (text ?? "ok").split("\n").filter(Boolean).slice(-3).join(" / ").slice(0, 400);

const schedule = (id: number, payer: PublicKey, taskId: number, intervalMs: number, iterations: number) =>
  program.methods
    .schedule(id, new BN(taskId), new BN(intervalMs), new BN(iterations))
    .accountsPartial({ payer, cell: cellOf(id), magicProgram: MAGIC_PROGRAM_ID })
    .instruction();

/** CancelTask sent straight to the magic program: variant 7, then the task id. */
function cancel(authority: PublicKey, taskId: number, extra: PublicKey[] = []): TransactionInstruction {
  const data = Buffer.alloc(12);
  data.writeUInt32LE(7, 0);
  data.writeBigInt64LE(BigInt(taskId), 4);
  return new TransactionInstruction({
    programId: MAGIC_PROGRAM_ID,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      ...extra.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
    ],
    data,
  });
}

const counter = async (id: number) =>
  Number((await rollup.getAccountInfo(cellOf(id)))!.data.readBigUInt64LE(0));

main(async () => {
  await ready();
  // Fresh accounts on every run, so the script can be repeated on one network.
  const first = 100 + 5 * Math.floor(Math.random() * 5);
  const payer = Keypair.generate();
  const taskBase = Math.floor(Math.random() * 1_000_000) * 10;
  const socket = await Socket.open(ROLLUP_WS);

  const runs: [number, number][] = [
    [1000, 5],
    [100, 30],
    [10, 100],
  ];
  for (const [nth, [intervalMs, iterations]] of runs.entries()) {
    const id = first + nth;
    await createCell(id, 64, null);
    const arrivals: number[] = [];
    await socket.subscribe("accountSubscribe", [cellOf(id).toBase58(), { encoding: "base64", commitment: "processed" }], () =>
      arrivals.push(performance.now()),
    );
    const sponsorBefore = await rollup.getBalance(SPONSOR);
    const payerBefore = await rollup.getBalance(payer.publicKey);
    const started = performance.now();
    const error = await failure(send(rollup, await schedule(id, payer.publicKey, taskBase + nth, intervalMs, iterations), payer));
    if (error) {
      console.log(`every ${intervalMs} ms x ${iterations}: schedule FAILED ${lastLog(error)}`);
      continue;
    }
    await sleep(intervalMs * iterations + 2500);
    const gaps = arrivals.slice(1).map((at, index) => at - arrivals[index]);
    console.log(
      `every ${intervalMs} ms x ${iterations}: account counter ${await counter(id)}, ${arrivals.length} change notifications, first ${(arrivals[0] - started).toFixed(0)} ms after scheduling, all done in ${(arrivals[arrivals.length - 1] - arrivals[0]).toFixed(0)} ms`,
    );
    if (gaps.length) console.log(`   ms between runs: ${JSON.stringify(summary(gaps))}`);
    console.log(
      `   cost: payer ${payerBefore} -> ${await rollup.getBalance(payer.publicKey)} lamports, sponsor ${sponsorBefore} -> ${await rollup.getBalance(SPONSOR)}`,
    );
  }

  console.log("\n== who signs the scheduled instruction?");
  const signatures = await rollup.getSignaturesForAddress(cellOf(first), { limit: 3 });
  const ran = await rollup.getTransaction(signatures[0].signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  console.log(
    "a run's transaction: signer",
    ran?.transaction.message.getAccountKeys().get(0)?.toBase58(),
    "fee",
    ran?.meta?.fee,
    "compute units",
    ran?.meta?.computeUnitsConsumed,
    "logs",
    brief(ran?.meta?.logMessages, 500),
  );

  console.log("\n== cancelling");
  const id = first + 3;
  await createCell(id, 64, null);
  const taskId = taskBase + 3;
  await send(rollup, await schedule(id, payer.publicKey, taskId, 200, 1000), payer);
  await sleep(1500);
  const before = await counter(id);
  const stranger = Keypair.generate();
  console.log(
    "a stranger cancels:",
    lastLog(await failure(send(rollup, cancel(stranger.publicKey, taskId), stranger))),
  );
  await sleep(800);
  const afterStranger = await counter(id);
  console.log(`   counter ${before} -> ${afterStranger} (${afterStranger > before ? "still running" : "STOPPED"})`);
  console.log(
    "the scheduling payer cancels:",
    lastLog(await failure(send(rollup, cancel(payer.publicKey, taskId), payer))),
  );
  await sleep(500);
  const atCancel = await counter(id);
  await sleep(1500);
  const later = await counter(id);
  console.log(`   counter ${atCancel} just after the cancel, ${later} 1.5 s later (${later === atCancel ? "stopped" : "STILL RUNNING"})`);

  console.log("\n== can a task write a private account, and is its run visible?");
  const sealed = first + 4;
  await createCell(sealed, 64, { isPrivate: true, readers: [] });
  const sealedError = await failure(send(rollup, await schedule(sealed, payer.publicKey, taskBase + 4, 100, 5), payer));
  await sleep(1500);
  console.log(`schedule on a sealed account: ${sealedError ? `FAILED ${lastLog(sealedError)}` : `ok, counter ${await counter(sealed)} of 5`}`);
  socket.close();
});

/**
 * Question 2. After a transaction that writes a private account and carries
 * numbers in its instruction data, who can fetch what through the query filter?
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  FILTER_URL,
  FILTER_WS,
  PROGRAM_ID,
  ROLLUP_URL,
  ROLLUP_WS,
  brief,
  cellOf,
  createCell,
  main,
  poke,
  ready,
  rollup,
  rpc,
  send,
  sleep,
  tokenFor,
} from "./support";

const AUTHORITY = 1;
const TX_LOGS = 2;
const TX_BALANCES = 4;
const TX_MESSAGE = 8;
const ACCOUNT_SIGNATURES = 16;

/** What one getTransaction answer gives away. */
function shown(result: any): string {
  if (result === null) return "null";
  if (result?.error) return `error ${brief(result.error, 90)}`;
  const message = result.transaction?.message;
  const meta = result.meta;
  const data = (message?.instructions ?? []).map((ix: any) => ix.data).join(",");
  return [
    `keys=${message?.accountKeys?.length ?? 0}`,
    `data=${data ? data.slice(0, 24) : "none"}`,
    `logs=${meta?.logMessages?.length ?? 0}`,
    `balances=${meta?.preBalances?.length ?? 0}`,
    `fee=${meta?.fee}`,
  ].join(" ");
}

const signatures = (result: any): string =>
  Array.isArray(result) ? `${result.length} signatures` : brief(result, 90);

main(async () => {
  await ready();
  const trader = Keypair.generate();
  const stranger = Keypair.generate();
  const views: [string, string][] = [
    ["anonymous", FILTER_URL],
    ["stranger", `${FILTER_URL}?token=${await tokenFor(stranger)}`],
    ["sender", `${FILTER_URL}?token=${await tokenFor(trader)}`],
  ];

  const cases: [string, number, { isPrivate: boolean; readers: { flags: number; key: PublicKey }[] } | null][] = [
    ["public account, no permission", 20, null],
    ["private, no members", 21, { isPrivate: true, readers: [] }],
    ["private, sender is member, flags 0", 22, { isPrivate: true, readers: [{ flags: 0, key: trader.publicKey }] }],
    ["private, sender has TX_LOGS", 23, { isPrivate: true, readers: [{ flags: TX_LOGS, key: trader.publicKey }] }],
    ["private, sender has TX_BALANCES", 24, { isPrivate: true, readers: [{ flags: TX_BALANCES, key: trader.publicKey }] }],
    ["private, sender has TX_MESSAGE", 25, { isPrivate: true, readers: [{ flags: TX_MESSAGE, key: trader.publicKey }] }],
    ["private, sender has ACCOUNT_SIGNATURES", 26, { isPrivate: true, readers: [{ flags: ACCOUNT_SIGNATURES, key: trader.publicKey }] }],
    ["private, sender has every flag", 27, { isPrivate: true, readers: [{ flags: AUTHORITY | TX_LOGS | TX_BALANCES | TX_MESSAGE | ACCOUNT_SIGNATURES, key: trader.publicKey }] }],
    ["private, a third key has every flag", 28, { isPrivate: true, readers: [{ flags: 31, key: Keypair.generate().publicKey }] }],
  ];

  // Fresh accounts on every run, so the script can be repeated on one network.
  const shift = 10 * Math.floor(Math.random() * 3);
  for (const entry of cases) entry[1] += shift;

  // The client library retries a refused subscription forever and prints each
  // refusal. One line per kind of refusal is enough.
  const refusals = new Set<string>();
  console.error = (...parts: unknown[]) => {
    const line = parts.map((part) => (typeof part === "string" ? part : brief(part, 200))).join(" ");
    if (!refusals.has(line)) refusals.add(line);
  };

  const heard: Record<string, string[]> = {};
  const listeners: [string, Connection][] = [
    ["direct 7800", new Connection(ROLLUP_URL, { wsEndpoint: ROLLUP_WS, commitment: "confirmed" })],
    ...views.map(
      ([who, url]): [string, Connection] => [
        `filter 6700 ${who}`,
        new Connection(url, {
          wsEndpoint: url.replace(FILTER_URL, FILTER_WS),
          commitment: "confirmed",
        }),
      ],
    ),
  ];
  for (const [who, connection] of listeners) {
    heard[who] = [];
    for (const filter of [PROGRAM_ID, "all" as const]) {
      try {
        connection.onLogs(
          filter,
          (logs) => {
            heard[who].push(
              `${filter === "all" ? "all" : "program"}:${logs.signature.slice(0, 8)}:${logs.logs.length} logs`,
            );
          },
          "confirmed",
        );
      } catch (error) {
        heard[who].push(`subscribe failed ${(error as Error).message}`);
      }
    }
  }
  await sleep(1500);

  const landed: [string, number, string][] = [];
  for (const [what, id, guard] of cases) {
    await createCell(id, 64, guard);
    const signature = await send(
      rollup,
      await poke(id, trader.publicKey, 4242, 77),
      trader,
    );
    landed.push([what, id, signature]);
  }
  // One transaction that writes several accounts, as placing an order would:
  // the sealed book, a public tape, and the sender's own private view.
  const id = (what: string) => cases.find(([name]) => name === what)![1];
  const sealedId = id("private, no members");
  const publicId = id("public account, no permission");
  const ownId = id("private, sender has every flag");
  const mixes: [string, number[]][] = [
    ["MIXED sealed + public", [sealedId, publicId]],
    ["MIXED sealed + sender's own view", [sealedId, ownId]],
    ["MIXED public + sender's own view", [publicId, ownId]],
  ];
  const mixed: [string, string][] = [];
  for (const [what, ids] of mixes) {
    const instructions = [];
    for (const cell of ids) instructions.push(await poke(cell, trader.publicKey, 5151, 88));
    mixed.push([what, await send(rollup, instructions, trader)]);
  }
  await sleep(2000);

  const reference = await rpc(ROLLUP_URL, "getTransaction", [
    landed[1][2],
    { encoding: "json", maxSupportedTransactionVersion: 0 },
  ]);
  console.log("== the order-like transaction as the rollup port (7799) serves it to anyone");
  console.log(shown(reference));
  console.log("instruction data (base58):", reference.transaction.message.instructions[0].data);
  console.log("logs:", brief(reference.meta.logMessages, 400));
  const slot = reference.slot;

  console.log("\n== getTransaction through the filter (6699)");
  for (const [what, , signature] of landed) {
    for (const [who, url] of views) {
      const result = await rpc(url, "getTransaction", [
        signature,
        { encoding: "json", maxSupportedTransactionVersion: 0 },
      ]);
      console.log(`${what} | ${who}: ${shown(result)}`);
    }
  }

  for (const [what, signature] of mixed) {
    for (const [who, url] of views) {
      const result = await rpc(url, "getTransaction", [
        signature,
        { encoding: "json", maxSupportedTransactionVersion: 0 },
      ]);
      console.log(`${what} | ${who}: ${shown(result)}`);
    }
  }
  const sealedSignature = landed[1][2];
  console.log(
    "\nthe whole answer a stranger gets for the sealed transaction:",
    brief(
      await rpc(views[1][1], "getTransaction", [sealedSignature, { encoding: "json", maxSupportedTransactionVersion: 0 }]),
      900,
    ),
  );
  for (const [who, url] of views.slice(0, 2)) {
    const byProgram = await rpc(url, "getSignaturesForAddress", [PROGRAM_ID.toBase58()]);
    const entry = (byProgram as any[]).find((row) => row.signature === sealedSignature);
    console.log(
      `is the sealed transaction in the program id's signature list | ${who}: ${entry ? `YES ${brief(entry, 200)}` : "no"}`,
    );
    const bySender = await rpc(url, "getSignaturesForAddress", [trader.publicKey.toBase58()]);
    console.log(
      `is it in the sender key's signature list | ${who}: ${(bySender as any[]).some((row) => row.signature === sealedSignature) ? "YES" : "no"}`,
    );
  }

  console.log("\n== getSignatureStatuses through the filter (does the transaction exist?)");
  for (const [who, url] of views) {
    const result = await rpc(url, "getSignatureStatuses", [[landed[1][2]]]);
    console.log(`private, no members | ${who}: ${brief(result?.value ?? result, 160)}`);
  }

  console.log("\n== getSignaturesForAddress through the filter");
  for (const [what, id] of landed) {
    for (const [who, url] of views) {
      const result = await rpc(url, "getSignaturesForAddress", [cellOf(id).toBase58()]);
      console.log(`account of "${what}" | ${who}: ${signatures(result)}`);
    }
  }
  for (const [who, url] of views) {
    console.log(
      `program id | ${who}: ${signatures(await rpc(url, "getSignaturesForAddress", [PROGRAM_ID.toBase58()]))}`,
    );
    console.log(
      `the sender's key | ${who}: ${signatures(await rpc(url, "getSignaturesForAddress", [trader.publicKey.toBase58()]))}`,
    );
  }
  console.log(
    `program id | direct 7799: ${signatures(await rpc(ROLLUP_URL, "getSignaturesForAddress", [PROGRAM_ID.toBase58()]))}`,
  );

  console.log(`\n== getBlock ${slot} (the slot of the private, no members transaction)`);
  const wanted = landed[1][2];
  for (const [who, url] of [["direct 7799", ROLLUP_URL] as [string, string], ...views]) {
    const block = await rpc(url, "getBlock", [
      slot,
      { encoding: "json", transactionDetails: "full", maxSupportedTransactionVersion: 0, rewards: false },
    ]);
    if (!block || block.error) {
      console.log(`${who}: ${brief(block, 160)}`);
      continue;
    }
    const mine = (block.transactions ?? []).find((tx: any) =>
      tx.transaction.signatures.includes(wanted),
    );
    console.log(
      `${who}: ${block.transactions?.length ?? 0} transactions in the block; ours: ${mine ? shown(mine) : "absent"}`,
    );
    const viaSignatures = await rpc(url, "getBlock", [
      slot,
      { transactionDetails: "signatures", maxSupportedTransactionVersion: 0, rewards: false },
    ]);
    console.log(
      `${who}, signatures only: ours ${viaSignatures?.signatures?.includes(wanted) ? "LISTED" : "absent"} (${brief(viaSignatures?.signatures ?? viaSignatures, 80)})`,
    );
  }

  console.log("\n== logsSubscribe: what each listener heard while the 9 pokes landed");
  console.log("refusals printed by the client library:", [...refusals].join(" || ") || "none");
  for (const [who] of listeners) {
    const pokes = heard[who].filter((line) =>
      landed.some(([, , signature]) => line.includes(signature.slice(0, 8))),
    );
    console.log(`${who}: ${heard[who].length} notifications, ${pokes.length} of them for the pokes`);
    for (const [what, , signature] of landed) {
      const lines = heard[who].filter((line) => line.includes(signature.slice(0, 8)));
      if (lines.length) console.log(`   ${what}: ${lines.join(" | ")}`);
    }
  }
});

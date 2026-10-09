/**
 * Question 1. A private account with no members: does the program still read
 * and write it for any signer, and what does each way of reading it return?
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import { permissionPdaFromAccount } from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  FILTER_URL,
  PROGRAM_ID,
  ROLLUP_URL,
  brief,
  cellOf,
  createCell,
  failure,
  main,
  poke,
  ready,
  readingAs,
  rollup,
  rpc,
  send,
  signed,
  tokenFor,
} from "./support";

// Fresh accounts on every run, so the script can be repeated on one network.
const SEALED = 1 + 3 * Math.floor(Math.random() * 6);
const OPEN = SEALED + 1;
const MEMBERS_ONLY = SEALED + 2;
const ALL_FLAGS = 0b11110;

main(async () => {
  await ready();
  const trader = Keypair.generate();
  const stranger = Keypair.generate();
  const member = Keypair.generate();

  console.log("== create: private with no members, public, private with one member");
  await createCell(SEALED, 64, { isPrivate: true, readers: [] });
  await createCell(OPEN, 64, null);
  await createCell(MEMBERS_ONLY, 64, {
    isPrivate: true,
    readers: [{ flags: ALL_FLAGS, key: member.publicKey }],
  });
  const sealed = cellOf(SEALED);
  const permission = await rollup.getAccountInfo(permissionPdaFromAccount(sealed));
  console.log(
    "sealed permission (direct 7799): len",
    permission?.data.length,
    "private byte",
    permission?.data[34],
    "member bytes",
    permission?.data.subarray(35).toString("hex") || "(none)",
  );

  console.log("\n== (a) a non-member signs, the program reads and writes");
  const viaRollup = await send(
    rollup,
    await poke(SEALED, trader.publicKey, 101, 7),
    trader,
  );
  const filterAsTrader = await readingAs(trader);
  const viaFilter = await send(
    filterAsTrader,
    await poke(SEALED, trader.publicKey, 102, 8),
    trader,
  ).catch((error) => `FAILED ${error.message.split("\n")[0]}`);
  console.log("poke sent to 7799:", viaRollup);
  console.log("poke sent to 6699 as the trader:", viaFilter);
  const direct = (await rollup.getAccountInfo(sealed))!;
  console.log(
    "direct read of the sealed cell: count",
    direct.data.readBigUInt64LE(0),
    "price",
    direct.data.readBigUInt64LE(8),
    "size",
    direct.data.readBigUInt64LE(16),
  );

  console.log("\n== (b) getAccountInfo through the query filter (6699)");
  const strangerToken = await tokenFor(stranger);
  const traderToken = await tokenFor(trader);
  const memberToken = await tokenFor(member);
  const asked = [sealed.toBase58(), { encoding: "base64" }];
  const views: [string, string][] = [
    ["no token", FILTER_URL],
    ["garbage token", `${FILTER_URL}?token=not-a-token`],
    ["signed-in stranger", `${FILTER_URL}?token=${strangerToken}`],
    ["the trader who wrote it", `${FILTER_URL}?token=${traderToken}`],
  ];
  for (const [who, url] of views) {
    console.log(`sealed cell, ${who}:`, brief(await rpc(url, "getAccountInfo", asked)));
  }
  for (const [who, url] of views.slice(2)) {
    console.log(
      `getMultipleAccounts, ${who}:`,
      brief(await rpc(url, "getMultipleAccounts", [[sealed.toBase58()], { encoding: "base64" }])),
    );
    console.log(
      `getProgramAccounts, ${who}:`,
      brief(await rpc(url, "getProgramAccounts", [PROGRAM_ID.toBase58(), { encoding: "base64" }]), 700),
    );
    console.log(
      `getBalance, ${who}:`,
      brief(await rpc(url, "getBalance", [sealed.toBase58()])),
    );
  }

  console.log("\n== simulateTransaction asking for the sealed cell's data after a simulated write");
  const dryRun = (await signed(rollup, [await poke(SEALED, stranger.publicKey, 103, 9)], stranger)).toString("base64");
  for (const [who, url] of [...views, ["rollup port 7799", ROLLUP_URL] as [string, string]]) {
    const result = await rpc(url, "simulateTransaction", [
      dryRun,
      { encoding: "base64", sigVerify: false, accounts: { encoding: "base64", addresses: [sealed.toBase58()] } },
    ]);
    console.log(
      `${who}:`,
      result?.error
        ? brief(result, 200)
        : `err=${JSON.stringify(result?.value?.err)} unitsConsumed=${result?.value?.unitsConsumed} logs=${brief(result?.value?.logs ?? null, 220)} accounts=${brief(result?.value?.accounts ?? null, 160)}`,
    );
  }

  console.log("\n== controls through the filter");
  const open = [cellOf(OPEN).toBase58(), { encoding: "base64" }];
  const membersOnly = [cellOf(MEMBERS_ONLY).toBase58(), { encoding: "base64" }];
  console.log("public cell, no token:", brief(await rpc(FILTER_URL, "getAccountInfo", open)));
  console.log(
    "public cell, stranger:",
    brief(await rpc(`${FILTER_URL}?token=${strangerToken}`, "getAccountInfo", open)),
  );
  console.log(
    "member-only cell, stranger:",
    brief(await rpc(`${FILTER_URL}?token=${strangerToken}`, "getAccountInfo", membersOnly)),
  );
  console.log(
    "member-only cell, its member:",
    brief(await rpc(`${FILTER_URL}?token=${memberToken}`, "getAccountInfo", membersOnly)),
  );
  console.log(
    "sealed cell's permission account, stranger:",
    brief(
      await rpc(`${FILTER_URL}?token=${strangerToken}`, "getAccountInfo", [
        permissionPdaFromAccount(sealed).toBase58(),
        { encoding: "base64" },
      ]),
    ),
  );

  console.log("\n== (c) the rollup port itself (7799), no token");
  console.log("sealed cell:", brief(await rpc(ROLLUP_URL, "getAccountInfo", asked)));

  console.log("\n== does a permission restrict who may write?");
  console.log(
    "a non-member pokes the member-only cell:",
    (await failure(
      send(
        rollup,
        await poke(MEMBERS_ONLY, stranger.publicKey, 1, 1),
        stranger,
      ),
    )) ?? "succeeded (a permission guards reads only; the program is the gate on writes)",
  );
  console.log(
    "the member the permission program adds by itself (flags 0):",
    new PublicKey(permission!.data.subarray(36, 68)).toBase58(),
    "program id:",
    PROGRAM_ID.toBase58(),
  );
});

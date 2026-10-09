/**
 * Question 5. accountSubscribe on the rollup port and through the query
 * filter, for a public account and for a private account as its member, with
 * the delay from a transaction's confirmation to the notification.
 */
import { Keypair } from "@solana/web3.js";
import {
  FILTER_WS,
  ROLLUP_WS,
  Socket,
  cellOf,
  createCell,
  main,
  poke,
  ready,
  rollup,
  signed,
  sleep,
  summary,
  tokenFor,
} from "./support";

const ROUNDS = 60;

main(async () => {
  await ready();
  // Fresh accounts on every run, so the script can be repeated on one network.
  const first = 50 + 3 * Math.floor(Math.random() * 3);
  const [OPEN, MEMBERS_ONLY, SEALED] = [first, first + 1, first + 2];
  const member = Keypair.generate();
  const stranger = Keypair.generate();
  const trader = Keypair.generate();
  await createCell(OPEN, 64, null);
  await createCell(MEMBERS_ONLY, 64, { isPrivate: true, readers: [{ flags: 30, key: member.publicKey }] });
  await createCell(SEALED, 64, { isPrivate: true, readers: [] });

  const memberWs = `${FILTER_WS}?token=${await tokenFor(member)}`;
  const strangerWs = `${FILTER_WS}?token=${await tokenFor(stranger)}`;
  const cases: [string, string, number][] = [
    ["rollup 7800, public account", ROLLUP_WS, OPEN],
    ["rollup 7800, private account (no token exists here)", ROLLUP_WS, MEMBERS_ONLY],
    ["rollup 7800, sealed account", ROLLUP_WS, SEALED],
    ["filter 6700, public account, anonymous", FILTER_WS, OPEN],
    ["filter 6700, public account, signed-in stranger", strangerWs, OPEN],
    ["filter 6700, private account, its member", memberWs, MEMBERS_ONLY],
    ["filter 6700, private account, signed-in stranger", strangerWs, MEMBERS_ONLY],
    ["filter 6700, private account, anonymous", FILTER_WS, MEMBERS_ONLY],
    ["filter 6700, sealed account, signed-in stranger", strangerWs, SEALED],
    ["filter 6700, sealed account, anonymous", FILTER_WS, SEALED],
  ];

  for (const [what, url, id] of cases) {
    let socket: Socket;
    try {
      socket = await Socket.open(url);
    } catch (error) {
      console.log(`${what}: ${(error as Error).message}`);
      continue;
    }
    let heard = 0;
    let lastHeard = 0;
    let lastBytes = 0;
    const refusal = await socket.subscribe(
      "accountSubscribe",
      [cellOf(id).toBase58(), { encoding: "base64", commitment: "confirmed" }],
      (note) => {
        heard += 1;
        lastHeard = performance.now();
        lastBytes = Buffer.from(note?.value?.data?.[0] ?? "", "base64").length;
      },
    );
    if (refusal) {
      console.log(`${what}: subscription REFUSED ${refusal}`);
      socket.close();
      continue;
    }
    const afterSend: number[] = [];
    const afterConfirm: number[] = [];
    let rounds = 0;
    for (let round = 0; round < ROUNDS; round += 1) {
      // Five writes with nothing heard is an answer; do not wait out the rest.
      if (round === 5 && heard === 0) break;
      rounds += 1;
      const raw = await signed(rollup, [await poke(id, trader.publicKey, 1000 + round, 1)], trader);
      const before = heard;
      const sent = performance.now();
      const signature = await rollup.sendRawTransaction(raw, { skipPreflight: true });
      let confirmed = 0;
      for (let waited = 0; waited < 400 && (!confirmed || heard === before); waited += 1) {
        if (!confirmed) {
          const { value } = await rollup.getSignatureStatus(signature);
          if (value?.confirmationStatus && value.confirmationStatus !== "processed") confirmed = performance.now();
        } else {
          await sleep(1);
        }
      }
      if (heard > before) {
        afterSend.push(lastHeard - sent);
        afterConfirm.push(lastHeard - confirmed);
      }
    }
    await sleep(300);
    console.log(
      `${what}: subscribed, ${heard} notifications for ${rounds} writes${heard ? `, ${lastBytes} data bytes each` : ""}`,
    );
    if (afterSend.length) {
      console.log(`   ms from send to notification:`, JSON.stringify(summary(afterSend)));
      console.log(`   ms from seeing it confirmed (polled) to notification, negative = notified first:`, JSON.stringify(summary(afterConfirm)));
    }
    socket.close();
  }
});

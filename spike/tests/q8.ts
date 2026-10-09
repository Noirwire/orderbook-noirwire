/**
 * Question 8. Read-only checks against the devnet private validator.
 * Nothing here sends a transaction: it signs in (a signed challenge over
 * HTTPS, no transaction) and reads.
 */
import { Keypair } from "@solana/web3.js";
import {
  EPHEMERAL_SPL_TOKEN_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Socket, brief, failure, main, rpc, tokenFor } from "./support";

const HTTPS = "https://devnet-tee.magicblock.app";
const WSS = "wss://devnet-tee.magicblock.app";

main(async () => {
  const reader = Keypair.generate();
  console.log("getVersion, no token:", brief(await rpc(HTTPS, "getVersion", [])));
  console.log("getIdentity, no token:", brief(await rpc(HTTPS, "getIdentity", [])));

  let token = "";
  const signIn = await failure(
    (async () => {
      token = await tokenFor(reader, HTTPS);
    })(),
  );
  console.log("sign-in with a throwaway key:", signIn ? `FAILED ${signIn.slice(0, 200)}` : `ok, token of ${token.length} characters`);
  const authed = token ? `${HTTPS}?token=${token}` : HTTPS;
  console.log("getVersion, with token:", brief(await rpc(authed, "getVersion", [])));
  console.log("getSlot, with token:", brief(await rpc(authed, "getSlot", [])));

  for (const [name, key] of [
    ["Ephemeral SPL Token program", EPHEMERAL_SPL_TOKEN_PROGRAM_ID],
    ["SPL Token program", TOKEN_PROGRAM_ID],
    ["Permission program", PERMISSION_PROGRAM_ID],
  ] as const) {
    for (const [who, url] of [["no token", HTTPS], ["with token", authed]] as const) {
      const info = await rpc(url, "getAccountInfo", [key.toBase58(), { encoding: "base64", dataSlice: { offset: 0, length: 0 } }]);
      console.log(
        `${name}, ${who}:`,
        info?.value ? `present, executable=${info.value.executable}, owner ${info.value.owner}` : brief(info, 200),
      );
    }
  }

  for (const [who, url] of [["no token", WSS], ["with token", token ? `${WSS}?token=${token}` : WSS]] as const) {
    try {
      const socket = await Socket.open(url, 10_000);
      let slots = 0;
      const refusal = await socket.subscribe("slotSubscribe", [], () => (slots += 1), 10_000);
      let notes = 0;
      const accountRefusal = await socket.subscribe(
        "accountSubscribe",
        [reader.publicKey.toBase58(), { encoding: "base64", commitment: "confirmed" }],
        () => (notes += 1),
        10_000,
      );
      await new Promise((resolve) => setTimeout(resolve, 3000));
      console.log(
        `wss, ${who}: connected; slotSubscribe ${refusal ? `refused: ${refusal}` : `accepted, ${slots} slot notifications in 3 s`}; accountSubscribe ${accountRefusal ? `refused: ${accountRefusal}` : `accepted (${notes} notifications, none expected)`}`,
      );
      socket.close();
    } catch (error) {
      console.log(`wss, ${who}: ${(error as Error).message}`);
    }
  }
});

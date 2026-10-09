/**
 * Question 4. Ephemeral SPL Token on the local stack: a balance into the
 * rollup, a payout signed by our program, and whether a balance can be private.
 */
import * as anchor from "@anchor-lang/core";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
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
  EPHEMERAL_SPL_TOKEN_PROGRAM_ID,
  createEataPermissionIx,
  delegateEataPermissionIx,
  delegateEphemeralAtaIx,
  delegateSpl,
  deriveEphemeralAta,
  deriveRentPda,
  initEphemeralAtaIx,
  permissionPdaFromAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  CUSTODY,
  FILTER_URL,
  ROLLUP_URL,
  VALIDATOR,
  admin,
  airdropped,
  base,
  brief,
  failure,
  main,
  program,
  ready,
  rollup,
  rpc,
  send,
  tokenFor,
  until,
} from "./support";

const lastLog = (text: string | null) =>
  (text ?? "ok").split("\n").filter(Boolean).slice(-2).join(" / ").slice(0, 300);

async function step(what: string, work: () => Promise<unknown>): Promise<boolean> {
  const started = Date.now();
  const error = await failure(work());
  console.log(`${error ? "FAILED" : "ok    "} ${what} (${Date.now() - started} ms)${error ? `: ${lastLog(error)}` : ""}`);
  return !error;
}

/** Token balance of `account` as `url` reports it, or a note on why not. */
async function balance(url: string, account: PublicKey): Promise<string> {
  const result = await rpc(url, "getAccountInfo", [account.toBase58(), { encoding: "base64" }]);
  if (result?.error) return `error ${brief(result.error, 80)}`;
  if (!result?.value) return "null";
  const data = Buffer.from(result.value.data[0], "base64");
  const amount = data.length >= 72 ? data.readBigUInt64LE(64) : "?";
  return `amount ${amount}, owner program ${result.value.owner.slice(0, 8)}, ${data.length} bytes`;
}

main(async () => {
  await ready();
  console.log("== is the program there?");
  for (const [where, connection] of [["Solana 8899", base], ["rollup 7799", rollup]] as const) {
    const info = await connection.getAccountInfo(EPHEMERAL_SPL_TOKEN_PROGRAM_ID);
    console.log(`${where}: Ephemeral SPL Token ${info ? `present, executable=${info.executable}, owner ${info.owner.toBase58()}` : "ABSENT"}`);
    const token = await connection.getAccountInfo(TOKEN_PROGRAM_ID);
    console.log(`${where}: SPL Token ${token ? `present, executable=${token.executable}` : "ABSENT"}`);
  }

  const mint = Keypair.generate();
  const alice = Keypair.generate();
  const bob = Keypair.generate();
  const stranger = Keypair.generate();
  const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(mint.publicKey, owner, true);
  const eata = (owner: PublicKey) => deriveEphemeralAta(owner, mint.publicKey)[0];

  console.log("\n== on Solana: a mint, two holders with 1,000 each");
  await step("airdrop to the two holders and fund the token program's rent address", async () => {
    await airdropped(alice.publicKey, 1);
    await airdropped(bob.publicKey, 1);
    await send(
      base,
      SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: deriveRentPda()[0], lamports: 0.2 * LAMPORTS_PER_SOL }),
      admin,
    );
  });
  await step("create the mint, the two token accounts, mint 1,000 to each", async () => {
    await send(
      base,
      [
        SystemProgram.createAccount({
          fromPubkey: admin.publicKey,
          newAccountPubkey: mint.publicKey,
          space: MINT_SIZE,
          lamports: await base.getMinimumBalanceForRentExemption(MINT_SIZE),
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMintInstruction(mint.publicKey, 0, admin.publicKey, null),
        createAssociatedTokenAccountInstruction(admin.publicKey, ata(alice.publicKey), alice.publicKey, mint.publicKey),
        createAssociatedTokenAccountInstruction(admin.publicKey, ata(bob.publicKey), bob.publicKey, mint.publicKey),
        createMintToInstruction(mint.publicKey, ata(alice.publicKey), admin.publicKey, 1000n),
        createMintToInstruction(mint.publicKey, ata(bob.publicKey), admin.publicKey, 1000n),
      ],
      admin,
      [mint],
    );
  });

  console.log("\n== balances into the rollup");
  const delegated = async (owner: Keypair, amount: bigint, first: boolean, isPrivate: boolean) => {
    const instructions = await delegateSpl(owner.publicKey, mint.publicKey, amount, {
      validator: VALIDATOR,
      idempotent: false,
      payer: admin.publicKey,
      initVaultIfMissing: first,
      private: isPrivate,
    });
    if (isPrivate) {
      instructions.push(delegateEataPermissionIx(admin.publicKey, eata(owner.publicKey), VALIDATOR));
    }
    await send(base, instructions, admin, [owner]);
  };
  const inRollup = (account: PublicKey, amount: bigint) =>
    until(
      async () => {
        const info = await rollup.getAccountInfo(account);
        return info && info.data.length >= 72 && info.data.readBigUInt64LE(64) === amount;
      },
      `${account.toBase58()} to hold ${amount} in the rollup`,
      30_000,
    );
  await step("alice moves 100 in (public), which also creates the mint's vault", () => delegated(alice, 100n, true, false));
  await step("alice's 100 shows in the rollup at her ordinary token account address", () => inRollup(ata(alice.publicKey), 100n));
  const bobPrivate = await step("bob moves 50 in with a private balance (permission created and delegated)", () => delegated(bob, 50n, false, true));
  if (bobPrivate) {
    await step("bob's 50 shows in the rollup", () => inRollup(ata(bob.publicKey), 50n));
  }

  console.log("\n== a token account owned by our program's address");
  const custodyReady = await step("create and delegate the custody balance (no signature from the owning address)", async () => {
    await send(
      base,
      [
        // Without an ordinary token account on Solana for the same owner, the
        // rollup never shows a token account at all (measured: 30 s timeout).
        createAssociatedTokenAccountInstruction(admin.publicKey, ata(CUSTODY), CUSTODY, mint.publicKey),
        initEphemeralAtaIx(eata(CUSTODY), CUSTODY, mint.publicKey, admin.publicKey),
        delegateEphemeralAtaIx(admin.publicKey, eata(CUSTODY), VALIDATOR),
      ],
      admin,
    );
  });
  if (custodyReady) {
    await step("the custody account appears in the rollup with 0", () => inRollup(ata(CUSTODY), 0n));
  }
  const describe = async (label: string, account: PublicKey) => {
    const info = await rollup.getAccountInfo(account);
    console.log(`   ${label} ${account.toBase58().slice(0, 8)} in the rollup: ${info ? `${info.data.length} bytes, owner ${info.owner.toBase58().slice(0, 8)}` : "absent"}`);
  };
  await describe("alice ordinary token account", ata(alice.publicKey));
  await describe("alice ephemeral token account", eata(alice.publicKey));
  await describe("custody ordinary token account", ata(CUSTODY));
  await describe("custody ephemeral token account", eata(CUSTODY));

  console.log("\n== inside the rollup");
  const plainTransfer = (from: Keypair, to: PublicKey, amount: bigint): TransactionInstruction =>
    createTransferInstruction(ata(from.publicKey), ata(to), from.publicKey, amount);
  await step("deposit: alice sends 40 to custody with a standard SPL transfer", () =>
    send(rollup, plainTransfer(alice, CUSTODY, 40n), alice),
  );
  const payOut = (to: PublicKey, amount: number, caller: PublicKey) =>
    program.methods
      .payOut(new anchor.BN(amount))
      .accountsPartial({ user: caller, custody: CUSTODY, from: ata(CUSTODY), to: ata(to), tokenProgram: TOKEN_PROGRAM_ID })
      .instruction();
  const caller = Keypair.generate();
  let payoutSignature = "";
  await step("payout: our program signs a transfer of 15 from custody to alice (standard SPL Transfer, program-address signer)", async () => {
    payoutSignature = await send(rollup, await payOut(alice.publicKey, 15, caller.publicKey), caller);
  });
  if (bobPrivate) {
    await step("payout of 5 from custody into bob's PRIVATE balance", async () => {
      await send(rollup, await payOut(bob.publicKey, 5, caller.publicKey), caller);
    });
  }
  await step("a payout larger than custody holds is refused", async () => {
    const error = await failure(send(rollup, await payOut(alice.publicKey, 1000, caller.publicKey), caller));
    if (!error) throw new Error("it went through");
    console.log(`   refusal: ${lastLog(error)}`);
  });
  await step("a stranger cannot move custody's tokens with a plain transfer", async () => {
    const forged = createTransferInstruction(ata(CUSTODY), ata(alice.publicKey), stranger.publicKey, 1n);
    const error = await failure(send(rollup, forged, stranger));
    if (!error) throw new Error("it went through");
    console.log(`   refusal: ${lastLog(error)}`);
  });
  if (payoutSignature) {
    const landed = await rollup.getTransaction(payoutSignature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    console.log(`   payout used ${landed?.meta?.computeUnitsConsumed} compute units`);
  }
  console.log("   balances by the rollup port: alice", await balance(ROLLUP_URL, ata(alice.publicKey)));
  console.log("   balances by the rollup port: custody", await balance(ROLLUP_URL, ata(CUSTODY)));
  console.log("   balances by the rollup port: bob", await balance(ROLLUP_URL, ata(bob.publicKey)));

  console.log("\n== can a balance be private? reads through the query filter");
  const asStranger = `${FILTER_URL}?token=${await tokenFor(stranger)}`;
  const asBob = `${FILTER_URL}?token=${await tokenFor(bob)}`;
  for (const [label, account] of [
    ["alice (public) ordinary address", ata(alice.publicKey)],
    ["bob (private) ordinary address", ata(bob.publicKey)],
    ["bob (private) ephemeral address", eata(bob.publicKey)],
    ["custody ordinary address", ata(CUSTODY)],
  ] as [string, PublicKey][]) {
    console.log(`${label}: anonymous -> ${await balance(FILTER_URL, account)}`);
    console.log(`${label}: stranger  -> ${await balance(asStranger, account)}`);
    console.log(`${label}: bob       -> ${await balance(asBob, account)}`);
  }
  const bobPermission = await rollup.getAccountInfo(permissionPdaFromAccount(eata(bob.publicKey)));
  console.log("bob's permission account in the rollup:", bobPermission ? `${bobPermission.data.length} bytes ${bobPermission.data.toString("hex")}` : "absent");

  console.log("\n== can custody be made private?");
  const sealedMint = Keypair.generate();
  const sealedEata = deriveEphemeralAta(CUSTODY, sealedMint.publicKey)[0];
  const sealedAta = getAssociatedTokenAddressSync(sealedMint.publicKey, CUSTODY, true);
  const sealed = await step("a second mint whose custody balance is created with a permission, then both delegated", async () => {
    await send(
      base,
      [
        SystemProgram.createAccount({
          fromPubkey: admin.publicKey,
          newAccountPubkey: sealedMint.publicKey,
          space: MINT_SIZE,
          lamports: await base.getMinimumBalanceForRentExemption(MINT_SIZE),
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMintInstruction(sealedMint.publicKey, 0, admin.publicKey, null),
      ],
      admin,
      [sealedMint],
    );
    await send(
      base,
      [
        createAssociatedTokenAccountInstruction(admin.publicKey, sealedAta, CUSTODY, sealedMint.publicKey),
        initEphemeralAtaIx(sealedEata, CUSTODY, sealedMint.publicKey, admin.publicKey),
        createEataPermissionIx(sealedEata, admin.publicKey),
        delegateEataPermissionIx(admin.publicKey, sealedEata, VALIDATOR),
        delegateEphemeralAtaIx(admin.publicKey, sealedEata, VALIDATOR),
      ],
      admin,
    );
  });
  if (sealed) {
    await step("it appears in the rollup", () =>
      until(async () => await rollup.getAccountInfo(sealedAta), "the sealed custody account", 30_000),
    );
    console.log(`private custody: rollup port -> ${await balance(ROLLUP_URL, sealedAta)}`);
    console.log(`private custody: anonymous   -> ${await balance(FILTER_URL, sealedAta)}`);
    console.log(`private custody: stranger    -> ${await balance(asStranger, sealedAta)}`);
    const permission = await rollup.getAccountInfo(permissionPdaFromAccount(sealedEata));
    console.log("its permission in the rollup:", permission ? `${permission.data.length} bytes ${permission.data.toString("hex")}` : "absent");
  }
});

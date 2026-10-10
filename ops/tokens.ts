/** Test mints, balances inside the rollup, and the custody a token is registered with. */
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  DELEGATION_PROGRAM_ID,
  createEataPermissionIx,
  delegateEataPermissionIx,
  delegateEphemeralAtaIx,
  delegateSpl,
  deriveEphemeralAta,
  deriveRentPda,
  initEphemeralAtaIx,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  type Addresses,
  type CustodyVisibility,
  type Instructions,
} from "../sdk/dist/index.js";
import { send, sleep, until } from "./sending";

const RENT_PDA_FLOOR = 0.1 * LAMPORTS_PER_SOL;
const RENT_PDA_TOP_UP = 0.2 * LAMPORTS_PER_SOL;

/** Pays the token program's rent address once, so balances can move into the rollup. */
export async function fundRentPda(
  solana: Connection,
  payer: Keypair,
): Promise<void> {
  const rentPda = deriveRentPda()[0];
  if ((await solana.getBalance(rentPda)) >= RENT_PDA_FLOOR) return;
  await send(
    solana,
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: rentPda,
      lamports: RENT_PDA_TOP_UP,
    }),
    payer,
  );
}

export async function createMint(
  solana: Connection,
  payer: Keypair,
  decimals: number,
  mint = Keypair.generate(),
): Promise<PublicKey> {
  await send(
    solana,
    [
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mint.publicKey,
        space: MINT_SIZE,
        lamports: await solana.getMinimumBalanceForRentExemption(MINT_SIZE),
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMintInstruction(
        mint.publicKey,
        decimals,
        payer.publicKey,
        null,
      ),
    ],
    payer,
    [mint],
  );
  return mint.publicKey;
}

/** Mints `amount` to `owner`'s token account on Solana. The payer is the mint authority. */
export async function minted(
  solana: Connection,
  payer: Keypair,
  mint: PublicKey,
  owner: PublicKey,
  amount: bigint,
): Promise<PublicKey> {
  const account = getAssociatedTokenAddressSync(mint, owner, true);
  await send(
    solana,
    [
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        account,
        owner,
        mint,
      ),
      createMintToInstruction(mint, account, payer.publicKey, amount),
    ],
    payer,
  );
  return account;
}

const TOKEN_AMOUNT_OFFSET = 64;
const TOKEN_AMOUNT_END = TOKEN_AMOUNT_OFFSET + 8;

/** The amount a token account holds, and nothing for an account that is not there. */
export async function tokenBalance(
  connection: Connection,
  account: PublicKey,
): Promise<bigint> {
  const info = await connection.getAccountInfo(account);
  if (!info || info.data.length < TOKEN_AMOUNT_END) return 0n;
  return new DataView(info.data.buffer, info.data.byteOffset).getBigUint64(
    TOKEN_AMOUNT_OFFSET,
    true,
  );
}

/**
 * Moves `amount` of `owner`'s balance into the rollup, as a private balance
 * unless `visibility` is public, creating the mint's vault when it is the
 * first move of that mint. A deposit into public custody through a private
 * endpoint needs a public balance. `rollup` must be able to read the owner's
 * token account: a private endpoint serves a token account to its owner
 * only, so there it is a connection signed in as `owner`.
 */
export async function movedIntoRollup(
  solana: Connection,
  rollup: Connection,
  payer: Keypair,
  owner: Keypair,
  mint: PublicKey,
  amount: bigint,
  validator: PublicKey,
  visibility: CustodyVisibility = "sealed",
): Promise<PublicKey> {
  const sealed = visibility === "sealed";
  const instructions = await delegateSpl(owner.publicKey, mint, amount, {
    validator,
    idempotent: false,
    payer: payer.publicKey,
    initVaultIfMissing: true,
    private: sealed,
  });
  if (sealed) {
    instructions.push(
      delegateEataPermissionIx(
        payer.publicKey,
        deriveEphemeralAta(owner.publicKey, mint)[0],
        validator,
      ),
    );
  }
  await send(solana, instructions, payer, [owner]);
  const account = getAssociatedTokenAddressSync(mint, owner.publicKey, true);
  await until(
    async () => (await tokenBalance(rollup, account)) >= amount,
    `${account.toBase58()} to hold ${amount} in the rollup`,
    30_000,
  );
  return account;
}

/**
 * The custody token account of `mint`: created on Solana for the custody
 * authority, given a private permission unless `visibility` is public, and
 * delegated to the rollup. Whether that was done is read on Solana. Nothing
 * here reads custody in the rollup: a private endpoint serves a sealed token
 * account owned by a program address to nobody. The rollup can take several
 * seconds to show the account to the program; `registeredToken` waits for
 * that.
 */
export async function ensureCustody(
  solana: Connection,
  payer: Keypair,
  addresses: Addresses,
  mint: PublicKey,
  validator: PublicKey,
  visibility: CustodyVisibility = "sealed",
): Promise<PublicKey> {
  const authority = addresses.custodyAuthority;
  const custody = addresses.custody(mint);
  const eata = deriveEphemeralAta(authority, mint)[0];
  const onSolana = await solana.getAccountInfo(eata);
  if (onSolana?.owner.equals(DELEGATION_PROGRAM_ID)) return custody;
  await send(
    solana,
    [
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        custody,
        authority,
        mint,
      ),
      initEphemeralAtaIx(eata, authority, mint, payer.publicKey),
      ...(visibility === "sealed"
        ? [
            createEataPermissionIx(eata, payer.publicKey),
            delegateEataPermissionIx(payer.publicKey, eata, validator),
          ]
        : []),
      delegateEphemeralAtaIx(payer.publicKey, eata, validator),
    ],
    payer,
  );
  return custody;
}

/**
 * How the program refuses a custody account the rollup has not shown it yet:
 * `WrongTokenProgram` and `CustodyNotPrivate`, by name where the logs are
 * served and by number where they are not.
 */
const CUSTODY_NOT_THERE_YET = [
  "WrongTokenProgram",
  "CustodyNotPrivate",
  "6111",
  "6136",
];
const CUSTODY_APPEARS_WITHIN_MS = 60_000;
const REGISTER_AGAIN_AFTER_MS = 1_000;

/**
 * Registers `mint` at `index`, trying again while the rollup has not yet
 * shown the program the custody account that was just delegated to it.
 */
export async function registeredToken(
  rollup: Connection,
  instructions: Instructions,
  admin: Keypair,
  index: number,
  mint: PublicKey,
  visibility: CustodyVisibility = "sealed",
): Promise<void> {
  const register = instructions.registerToken(
    admin.publicKey,
    index,
    mint,
    visibility,
  );
  const deadline = Date.now() + CUSTODY_APPEARS_WITHIN_MS;
  for (;;) {
    const refused = await send(rollup, register, admin).then(
      () => null,
      (error: Error) => error.message,
    );
    if (refused === null) return;
    const waiting = CUSTODY_NOT_THERE_YET.some((sign) =>
      refused.includes(sign),
    );
    if (!waiting || Date.now() > deadline) throw new Error(refused);
    await sleep(REGISTER_AGAIN_AFTER_MS);
  }
}

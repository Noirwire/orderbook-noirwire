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
  getMint,
} from "@solana/spl-token";
import {
  DelegationStatus,
  createEataPermissionIx,
  delegateEataPermissionIx,
  delegateEphemeralAtaIx,
  delegateSpl,
  deriveEphemeralAta,
  deriveRentPda,
  deriveVault,
  getDelegationRecord,
  initEphemeralAtaIx,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  type Addresses,
  type CustodyToken,
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
 * unless `visibility` is public, creating the mint's vault when no earlier
 * move made it. A deposit into public custody through a private endpoint
 * needs a public balance. The first move of an owner's balance creates it in
 * the rollup; a later one is merged into it by the token program's
 * idempotent path. `rollup` must be able to read the owner's token account:
 * a private endpoint serves a token account to its owner only, so there it
 * is a connection signed in as `owner`.
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
  const balance = deriveEphemeralAta(owner.publicKey, mint)[0];
  const first = !(await solana.getAccountInfo(balance));
  const vaultMissing = !(await solana.getAccountInfo(deriveVault(mint)[0]));
  const account = getAssociatedTokenAddressSync(mint, owner.publicKey, true);
  const before = first ? 0n : await tokenBalance(rollup, account);
  const instructions = await delegateSpl(owner.publicKey, mint, amount, {
    validator,
    idempotent: !first,
    payer: payer.publicKey,
    initVaultIfMissing: vaultMissing,
    private: sealed,
  });
  if (sealed && first) {
    instructions.push(
      delegateEataPermissionIx(payer.publicKey, balance, validator),
    );
  }
  await send(solana, instructions, payer, [owner]);
  await until(
    async () => (await tokenBalance(rollup, account)) >= before + amount,
    `${account.toBase58()} to hold ${before + amount} in the rollup`,
    30_000,
  );
  return account;
}

/**
 * Makes `owner`'s balance inside the rollup hold at least `amount`, moving
 * what is missing from its token account on Solana, and minting that first
 * when `owner` is the mint's authority, as on a test mint. Real USDC has to be
 * in the owner's account on Solana already.
 */
export async function heldInRollup(
  solana: Connection,
  rollup: Connection,
  owner: Keypair,
  mint: PublicKey,
  amount: bigint,
  validator: PublicKey,
  visibility: CustodyVisibility,
): Promise<PublicKey> {
  const account = getAssociatedTokenAddressSync(mint, owner.publicKey, true);
  const inRollup = await tokenBalance(rollup, account);
  if (inRollup >= amount) return account;
  const missing = amount - inRollup;
  const onSolana = await tokenBalance(solana, account);
  if (onSolana < missing) {
    const { mintAuthority } = await getMint(solana, mint);
    if (!mintAuthority?.equals(owner.publicKey)) {
      throw new Error(
        `${owner.publicKey.toBase58()} holds ${inRollup} atoms in the rollup and ${onSolana} on Solana, short of ${amount}. Send it the rest on Solana and run this again.`,
      );
    }
    await minted(solana, owner, mint, owner.publicKey, missing - onSolana);
  }
  return movedIntoRollup(
    solana,
    rollup,
    owner,
    owner,
    mint,
    missing,
    validator,
    visibility,
  );
}

/** Refuses a mint whose decimals are not `decimals`: every price and amount is scaled by them. */
export async function mintOfDecimals(
  solana: Connection,
  mint: PublicKey,
  decimals: number,
): Promise<PublicKey> {
  const found = (await getMint(solana, mint)).decimals;
  if (found !== decimals) {
    throw new Error(
      `${mint.toBase58()} has ${found} decimals, not ${decimals}. Nothing was registered.`,
    );
  }
  return mint;
}

/** A custody this exchange cannot use, because someone else set it up first. */
const claimed = (account: PublicKey, what: string) =>
  new Error(
    `Custody account ${account.toBase58()} ${what}. Someone else ` +
      "may have set it up, and only its owner could undo that.",
  );

/**
 * Whether `account` is delegated to `validator`, read from its delegation
 * record. Refuses one delegated to any other validator.
 */
async function delegatedTo(
  solana: Connection,
  account: PublicKey,
  validator: PublicKey,
): Promise<boolean> {
  const record = await getDelegationRecord(solana, account);
  if (record.status === DelegationStatus.Undelegated) return false;
  if (!record.validator.equals(validator)) {
    throw claimed(
      account,
      `is delegated to ${record.validator.toBase58()}, not ${validator.toBase58()}`,
    );
  }
  return true;
}

/**
 * The custody token account of `token`: created on Solana for its custody
 * authority, given a private permission unless `visibility` is public, and
 * delegated to the rollup run by `validator`. Whether that was done is read
 * on Solana, from the delegation records, and a custody balance or
 * permission delegated to another validator, a public custody with a
 * permission, or a sealed one whose permission is missing is refused loudly.
 * Nothing here reads custody in the rollup: a private endpoint serves a
 * sealed token account owned by a program address to nobody. The rollup can
 * take several seconds to show the account to the program;
 * `registeredToken` waits for that.
 */
export async function ensureCustody(
  solana: Connection,
  payer: Keypair,
  addresses: Addresses,
  token: CustodyToken,
  validator: PublicKey,
  visibility: CustodyVisibility = "sealed",
): Promise<PublicKey> {
  const authority = addresses.custodyAuthority(token.custodyNonce);
  const custody = addresses.custody(token);
  const balance = addresses.custodyBalance(token);
  const permission = addresses.custodyPermission(token);
  const sealed = visibility === "sealed";
  if (!sealed && (await solana.getAccountInfo(permission))) {
    throw claimed(balance, "has a permission, so it cannot be public");
  }
  const balanceIsOurs = await delegatedTo(solana, balance, validator);
  const permissionIsOurs =
    sealed && (await delegatedTo(solana, permission, validator));
  if (balanceIsOurs && (!sealed || permissionIsOurs)) return custody;
  if (balanceIsOurs) {
    throw claimed(balance, "is delegated without its private permission");
  }
  await send(
    solana,
    [
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        custody,
        authority,
        token.mint,
      ),
      initEphemeralAtaIx(balance, authority, token.mint, payer.publicKey),
      ...(sealed
        ? [
            createEataPermissionIx(balance, payer.publicKey),
            delegateEataPermissionIx(payer.publicKey, balance, validator),
          ]
        : []),
      delegateEphemeralAtaIx(payer.publicKey, balance, validator),
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
 * Registers `token` at `index`, trying again while the rollup has not yet
 * shown the program the custody account that was just delegated to it.
 */
export async function registeredToken(
  rollup: Connection,
  instructions: Instructions,
  admin: Keypair,
  index: number,
  token: CustodyToken,
  visibility: CustodyVisibility = "sealed",
): Promise<void> {
  const register = instructions.registerToken(
    admin.publicKey,
    index,
    token,
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

/**
 * Operates one deployment of the order book on a network: sets up the
 * exchange, the ledger, the markets, the test mints, custody and a faucet,
 * and prints a JSON description other services read.
 *
 * The Makefile is the way in (`make local-setup`, `make local-status`). It
 * names the network through variables, so nothing here knows a network by
 * heart. No secret key is ever printed: keys are read from, and written to,
 * files. Running `setup` twice is safe: whatever exists is left as it is.
 *
 * The exported functions are also what the tests set their network up with.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
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
  delegationRecordPdaFromDelegatedAccount,
  deriveEphemeralAta,
  deriveRentPda,
  initEphemeralAtaIx,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import nacl from "tweetnacl";
import {
  Addresses,
  Instructions,
  MARKET_KIND,
  PROGRAM_ID,
  decodeExchange,
  decodeHeader,
  decodeMarket,
  privateConnection,
  CUSTODY_VISIBILITIES,
  type CustodyVisibility,
  sendAndConfirm,
  setupLedger,
  setupMarket,
  type MarketSettings,
} from "../sdk/dist/index.js";

export async function until<T>(
  read: () => Promise<T | null | undefined | false>,
  what: string,
  timeoutMs = 60_000,
  everyMs = 200,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read().catch(() => null);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const CLOCK = new PublicKey("SysvarC1ock11111111111111111111111111111111");

/**
 * A network's own clock in unix seconds, from the Clock sysvar it serves. The
 * program measures a publish time against this clock, which can trail the
 * caller's.
 */
export async function clockOf(connection: Connection): Promise<number> {
  const clock = await connection.getAccountInfo(CLOCK);
  if (!clock) throw new Error("The network serves no clock");
  return Number(
    new DataView(clock.data.buffer, clock.data.byteOffset).getBigInt64(
      32,
      true,
    ),
  );
}

/** Sends instructions as one transaction and resolves to the signature, or throws with the logs. */
export function send(
  connection: Connection,
  instructions: TransactionInstruction | TransactionInstruction[],
  feePayer: Keypair,
  signers: Keypair[] = [],
): Promise<string> {
  return sendAndConfirm(connection, [instructions].flat(), feePayer, signers);
}

/** Resolves to the error text of a call that must fail, and throws if it succeeds. */
export async function refusal(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (error) {
    return error instanceof Error ? error.message : JSON.stringify(error);
  }
  throw new Error("The call succeeded, and it must not");
}

export const signMessageWith = (key: Keypair) => async (message: Uint8Array) =>
  nacl.sign.detached(message, key.secretKey);

/** A connection to the private endpoint that reads as `reader`. */
export function readingAs(
  privateUrl: string,
  reader: Keypair,
): Promise<Connection> {
  return privateConnection(
    privateUrl,
    reader.publicKey,
    signMessageWith(reader),
  );
}

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

export function heldKey(path: string): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))),
  );
}

/** Keeps a new key in a file only its owner can read, and never overwrites one. */
export function keptKey(path: string, key = Keypair.generate()): Keypair {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(Array.from(key.secretKey)), {
    mode: 0o600,
    flag: "wx",
  });
  return key;
}

export function keyAt(path: string): Keypair {
  return existsSync(path) ? heldKey(path) : keptKey(path);
}

/** Pays the token program's rent address once, so balances can move into the rollup. */
export async function fundRentPda(
  solana: Connection,
  payer: Keypair,
): Promise<void> {
  const rentPda = deriveRentPda()[0];
  if ((await solana.getBalance(rentPda)) >= 0.1 * LAMPORTS_PER_SOL) return;
  await send(
    solana,
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: rentPda,
      lamports: 0.2 * LAMPORTS_PER_SOL,
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

export async function tokenBalance(
  connection: Connection,
  account: PublicKey,
): Promise<bigint> {
  const info = await connection.getAccountInfo(account);
  if (!info || info.data.length < 72) return 0n;
  return new DataView(info.data.buffer, info.data.byteOffset).getBigUint64(
    64,
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
  // WrongTokenProgram and CustodyNotPrivate, by name where the logs are
  // served and by number where they are not.
  const notThereYet = [
    "WrongTokenProgram",
    "CustodyNotPrivate",
    "6111",
    "6136",
  ];
  const deadline = Date.now() + 60_000;
  for (;;) {
    const refused = await send(rollup, register, admin).then(
      () => null,
      (error: Error) => error.message,
    );
    if (refused === null) return;
    const waiting = notThereYet.some((sign) => refused.includes(sign));
    if (!waiting || Date.now() > deadline) throw new Error(refused);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

export type ExchangeOnSolana = {
  lamports: number;
  rent: number;
  delegated: boolean;
  validator: PublicKey | null;
};

export async function exchangeOnSolana(
  solana: Connection,
  addresses: Addresses,
): Promise<ExchangeOnSolana | null> {
  const account = await solana.getAccountInfo(addresses.exchange);
  if (!account) return null;
  const delegated = account.owner.equals(DELEGATION_PROGRAM_ID);
  const record = delegated
    ? await solana.getAccountInfo(
        delegationRecordPdaFromDelegatedAccount(addresses.exchange),
      )
    : null;
  return {
    lamports: account.lamports,
    rent: await solana.getMinimumBalanceForRentExemption(account.data.length),
    delegated,
    validator: record ? new PublicKey(record.data.subarray(8, 40)) : null,
  };
}

export type ExchangeSetup = {
  solana: Connection;
  rollup: Connection;
  admin: Keypair;
  gate: PublicKey;
  oracle: PublicKey;
  validator: PublicKey;
  floatLamports: number;
  programId?: PublicKey;
};

/** The exchange exists on Solana, holds its float, and is delegated to the rollup. */
export async function ensureExchange(setup: ExchangeSetup): Promise<void> {
  const instructions = new Instructions(setup.programId);
  const { addresses } = instructions;
  const admin = setup.admin;
  if (!(await exchangeOnSolana(setup.solana, addresses))) {
    await send(
      setup.solana,
      instructions.initializeExchange(admin.publicKey, {
        gate: setup.gate,
        oracle: setup.oracle,
        maxSteps: 16,
        collateralToken: 0,
      }),
      admin,
    );
  }
  const exchange = (await exchangeOnSolana(setup.solana, addresses))!;
  if (exchange.delegated) return;
  const missing = exchange.rent + setup.floatLamports - exchange.lamports;
  if (missing > 0) {
    await send(
      setup.solana,
      SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: addresses.exchange,
        lamports: missing,
      }),
      admin,
    );
  }
  await send(
    setup.solana,
    instructions.delegateExchange(admin.publicKey, setup.validator),
    admin,
  );
  await until(
    async () =>
      (await setup.rollup.getAccountInfo(addresses.exchange))?.owner.equals(
        instructions.programId,
      ),
    "the exchange to appear in the rollup",
  );
}

export type TokenSpec = { index: number; symbol: string; decimals: number };

export const TOKENS: TokenSpec[] = [
  { index: 0, symbol: "nUSD", decimals: 6 },
  { index: 1, symbol: "nSOL", decimals: 9 },
];

const NUSD = 0;
const NSOL = 1;

/** Prices in quote atoms per lot: a lot is 0.001 SOL or 0.01 NVDA, nUSD has 6 decimals. */
export const INITIAL_MARK = {
  "NSOL-PERP": 150_000n,
  "NNVDA-PERP": 1_800_000n,
  "NSOL-NUSD": 150_000n,
};

const perpLimits = (fundingInterval: bigint) => ({
  minSize: 1n,
  minNotional: 1_000_000n,
  bandBps: 400,
  imBps: 1_000,
  mmBps: 500,
  takerFeeBps: 5,
  liqPenaltyBps: 200,
  fundingCapBps: 100,
  maxMoveBps: 250,
  maxOpenOrders: 32,
  maxPriceAge: 10n,
  fundingInterval,
  minPublishGap: 1,
  maxAgeLiquidation: 60n,
  openInterestCap: 10_000_000n,
  liqBufferBps: 100,
  liqInsuranceShareBps: 5_000,
  feeInsuranceShareBps: 5_000,
});

const QUOTE_DECIMALS = 6;

/** `baseDecimals` is how many decimals the base asset counts in, token or not. */
export const MARKETS: {
  id: number;
  symbol: string;
  baseDecimals: number;
  settings: MarketSettings;
}[] = [
  {
    id: 0,
    symbol: "NSOL-PERP",
    baseDecimals: 9,
    settings: {
      kind: MARKET_KIND.perp,
      baseSymbol: "NSOL",
      quoteSymbol: "NUSD",
      baseToken: NUSD,
      quoteToken: NUSD,
      tick: 100n,
      baseLot: 1_000_000n,
      capacity: 1024,
      limits: perpLimits(60n),
    },
  },
  {
    id: 1,
    symbol: "NNVDA-PERP",
    baseDecimals: 6,
    settings: {
      kind: MARKET_KIND.perp,
      baseSymbol: "NNVDA",
      quoteSymbol: "NUSD",
      baseToken: NUSD,
      quoteToken: NUSD,
      tick: 1_000n,
      baseLot: 10_000n,
      capacity: 1024,
      limits: perpLimits(60n),
    },
  },
  {
    id: 2,
    symbol: "NSOL-NUSD",
    baseDecimals: 9,
    settings: {
      kind: MARKET_KIND.spot,
      baseSymbol: "NSOL",
      quoteSymbol: "NUSD",
      baseToken: NSOL,
      quoteToken: NUSD,
      tick: 100n,
      baseLot: 1_000_000n,
      capacity: 1024,
      limits: perpLimits(60n),
    },
  },
];

export type DeploymentDescription = {
  network: string;
  programId: string;
  solanaUrl: string;
  rollupUrl: string;
  privateUrl: string;
  /**
   * Where `deposit`, `withdraw`, `collect_fees` and `fund_insurance` are sent.
   * A private endpoint refuses every transaction of this program that names a
   * private token balance. Where custody is sealed this is therefore the
   * rollup's own port; where custody is public it is the private endpoint,
   * and the depositor's or withdrawer's token balance must be public too.
   */
  depositUrl: string;
  validator: string;
  exchange: string;
  custodyAuthority: string;
  ledger: string;
  stats: string;
  gate: string;
  oracle: string;
  faucet: string;
  tokens: {
    index: number;
    symbol: string;
    decimals: number;
    mint: string;
    custody: string;
    /** As the exchange records it. Public shows the token's total in custody to anyone. */
    custodyVisibility: CustodyVisibility;
  }[];
  markets: {
    id: number;
    symbol: string;
    kind: "spot" | "perp";
    /** Decimals of the base asset and of the quote token. */
    baseDecimals: number;
    quoteDecimals: number;
    /** Base atoms in one lot, and quote atoms per lot in one tick, as decimal text. */
    baseLot: string;
    tick: string;
    market: string;
    book: string;
    tape: string;
    priceFeed: string;
    fundingTaskId?: number;
  }[];
};

function setting(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Use the Makefile targets.`);
  return value;
}

export type Target = {
  network: string;
  solana: Connection;
  rollup: Connection;
  solanaUrl: string;
  rollupUrl: string;
  privateUrl: string;
  depositUrl: string;
  custody: CustodyVisibility;
  validator: PublicKey;
  float: number;
  keys: string;
  deploymentPath: string;
  instructions: Instructions;
};

export async function target(): Promise<Target> {
  const network = setting("NETWORK");
  const solanaUrl = setting("SOLANA_URL");
  const rollupUrl = setting("ROLLUP_URL");
  const solana = new Connection(solanaUrl, "confirmed");
  const genesis = await solana.getGenesisHash();
  if (genesis === MAINNET_GENESIS) {
    throw new Error("Mainnet is not wired up. Nothing was sent.");
  }
  if (process.env.GENESIS && genesis !== process.env.GENESIS) {
    throw new Error(`${solanaUrl} is not ${network}: ${genesis}`);
  }
  const custody = setting("CUSTODY") as CustodyVisibility;
  if (!CUSTODY_VISIBILITIES.includes(custody)) {
    throw new Error(`CUSTODY is one of: ${CUSTODY_VISIBILITIES.join(", ")}`);
  }
  return {
    network,
    solana,
    rollup: new Connection(rollupUrl, "confirmed"),
    solanaUrl,
    rollupUrl,
    privateUrl: setting("PRIVATE_URL"),
    depositUrl: setting("DEPOSIT_URL"),
    custody,
    validator: new PublicKey(setting("VALIDATOR")),
    float: Number(setting("EXCHANGE_FLOAT_LAMPORTS")),
    keys: setting("KEYS_DIR"),
    deploymentPath: setting("DEPLOYMENT"),
    instructions: new Instructions(PROGRAM_ID),
  };
}

/**
 * The connection `key` sends and reads its own accounts through. A private
 * endpoint takes a transaction only from a signed-in caller and serves a
 * token account only to its owner, so there it is signed in as `key`. The
 * rollup's own port, where one is given, needs no sign-in.
 */
export function sendingAs(on: Target, key: Keypair): Promise<Connection> {
  return on.rollupUrl === on.privateUrl
    ? readingAs(on.privateUrl, key)
    : Promise.resolve(on.rollup);
}

/** Stops unless the rollup behind the endpoint is the validator we were told. */
export async function rollupIsRunBy(on: Target): Promise<void> {
  const answer = await fetch(on.rollupUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getIdentity" }),
  });
  const { result } = (await answer.json()) as {
    result?: { identity?: string };
  };
  if (result?.identity !== on.validator.toBase58()) {
    throw new Error(
      `${on.rollupUrl} is run by ${result?.identity}, not ${on.validator.toBase58()}.`,
    );
  }
}

export function readDeployment(path: string): DeploymentDescription | null {
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as DeploymentDescription)
    : null;
}

const FAUCET_AMOUNT = {
  nUSD: 10_000_000n * 1_000_000n,
  nSOL: 100_000n * 1_000_000_000n,
};

/**
 * The mint of `spec`, under a key kept with the others, so a run that stops
 * before the token is registered does not leave a mint behind and pay for
 * another one the next time.
 */
async function keptMint(
  on: Target,
  admin: Keypair,
  spec: TokenSpec,
): Promise<PublicKey> {
  const mint = keyAt(join(on.keys, `${on.network}-mint-${spec.symbol}.json`));
  if (!(await on.solana.getAccountInfo(mint.publicKey))) {
    await createMint(on.solana, admin, spec.decimals, mint);
  }
  return mint.publicKey;
}

/** The connection `key` sends what names custody through, signed in where that is the private endpoint. */
export function depositingAs(on: Target, key: Keypair): Promise<Connection> {
  return on.depositUrl === on.privateUrl
    ? readingAs(on.privateUrl, key)
    : Promise.resolve(new Connection(on.depositUrl, "confirmed"));
}

/**
 * The test mints with their custody registered as the network's `CUSTODY`
 * says, and the faucet holding its amount of each inside the rollup, in a
 * balance as visible as custody is.
 */
async function tokensSetUp(
  on: Target,
  admin: Keypair,
  faucet: Keypair,
): Promise<DeploymentDescription["tokens"]> {
  const { addresses } = on.instructions;
  await fundRentPda(on.solana, admin);
  const deposits = await depositingAs(on, admin);
  const asFaucet = await sendingAs(on, faucet);
  const recorded = async (index: number) =>
    decodeExchange((await on.rollup.getAccountInfo(addresses.exchange))!.data)
      .tokens[index];
  const tokens: DeploymentDescription["tokens"] = [];
  for (const spec of TOKENS) {
    const registered = await recorded(spec.index);
    const isRegistered = !registered.mint.equals(PublicKey.default);
    const mint = isRegistered
      ? registered.mint
      : await keptMint(on, admin, spec);
    const visibility = isRegistered ? registered.custodyVisibility : on.custody;
    const custody = await ensureCustody(
      on.solana,
      admin,
      addresses,
      mint,
      on.validator,
      visibility,
    );
    if (!isRegistered) {
      await registeredToken(
        deposits,
        on.instructions,
        admin,
        spec.index,
        mint,
        visibility,
      );
    }
    const faucetAccount = getAssociatedTokenAddressSync(
      mint,
      faucet.publicKey,
      true,
    );
    if ((await tokenBalance(asFaucet, faucetAccount)) === 0n) {
      const amount = FAUCET_AMOUNT[spec.symbol as keyof typeof FAUCET_AMOUNT];
      await minted(on.solana, admin, mint, faucet.publicKey, amount);
      await movedIntoRollup(
        on.solana,
        asFaucet,
        admin,
        faucet,
        mint,
        amount,
        on.validator,
        visibility,
      );
    }
    tokens.push({
      ...spec,
      mint: mint.toBase58(),
      custody: custody.toBase58(),
      custodyVisibility: (await recorded(spec.index)).custodyVisibility,
    });
  }
  return tokens;
}

async function setup(on: Target): Promise<void> {
  const admin = heldKey(
    join(
      on.keys,
      on.network === "localnet" ? "admin.json" : `${on.network}-admin.json`,
    ),
  );
  const gate = keyAt(join(on.keys, `${on.network}-gate.json`));
  const oracle = keyAt(join(on.keys, `${on.network}-oracle.json`));
  const faucet = keyAt(join(on.keys, `${on.network}-faucet.json`));
  const { addresses } = on.instructions;
  await rollupIsRunBy(on);

  if (
    on.network === "localnet" &&
    (await on.solana.getBalance(admin.publicKey)) < 10 * LAMPORTS_PER_SOL
  ) {
    const signature = await on.solana.requestAirdrop(
      admin.publicKey,
      100 * LAMPORTS_PER_SOL,
    );
    await on.solana.confirmTransaction({
      signature,
      ...(await on.solana.getLatestBlockhash()),
    });
  }

  await ensureExchange({
    solana: on.solana,
    rollup: on.rollup,
    admin,
    gate: gate.publicKey,
    oracle: oracle.publicKey,
    validator: on.validator,
    floatLamports: on.float,
  });

  const asAdmin = await sendingAs(on, admin);
  const asOracle = await sendingAs(on, oracle);

  const tokens = await tokensSetUp(on, admin, faucet);

  // The exchange records its mints, so a description left by an earlier
  // network, or by a run that stopped half way, is told apart by them.
  const previous = readDeployment(on.deploymentPath);
  const kept =
    previous &&
    tokens.every(
      (token) =>
        previous.tokens.find(({ index }) => index === token.index)?.mint ===
        token.mint,
    )
      ? previous
      : null;

  await setupLedger(asAdmin, admin);
  const markets: DeploymentDescription["markets"] = [];
  for (const { id, symbol, baseDecimals, settings } of MARKETS) {
    await setupMarket(asAdmin, admin, id, settings);
    const feed = await on.rollup.getAccountInfo(addresses.priceFeed(id));
    const published =
      feed &&
      new DataView(feed.data.buffer, feed.data.byteOffset).getBigUint64(
        16,
        true,
      ) > 0n;
    if (!published) {
      await send(
        asOracle,
        on.instructions.publishPrice(
          oracle.publicKey,
          id,
          INITIAL_MARK[symbol as keyof typeof INITIAL_MARK],
          BigInt(await clockOf(on.rollup)),
        ),
        oracle,
      );
    }
    const known = kept?.markets.find((market) => market.id === id);
    let fundingTaskId = known?.fundingTaskId;
    if (settings.kind === MARKET_KIND.perp && fundingTaskId === undefined) {
      fundingTaskId = 1_000 + id;
      await send(
        asAdmin,
        on.instructions.scheduleFunding(
          admin.publicKey,
          id,
          BigInt(fundingTaskId),
          60_000n,
          1_000_000_000n,
        ),
        admin,
      );
    }
    markets.push({
      id,
      symbol,
      kind: settings.kind === MARKET_KIND.perp ? "perp" : "spot",
      baseDecimals,
      quoteDecimals: QUOTE_DECIMALS,
      baseLot: settings.baseLot.toString(),
      tick: settings.tick.toString(),
      market: addresses.market(id).toBase58(),
      book: addresses.book(id).toBase58(),
      tape: addresses.tape(id).toBase58(),
      priceFeed: addresses.priceFeed(id).toBase58(),
      ...(fundingTaskId === undefined ? {} : { fundingTaskId }),
    });
  }

  const description: DeploymentDescription = {
    network: on.network,
    programId: on.instructions.programId.toBase58(),
    solanaUrl: on.solanaUrl,
    rollupUrl: on.rollupUrl,
    privateUrl: on.privateUrl,
    depositUrl: on.depositUrl,
    validator: on.validator.toBase58(),
    exchange: addresses.exchange.toBase58(),
    custodyAuthority: addresses.custodyAuthority.toBase58(),
    ledger: addresses.ledger.toBase58(),
    stats: addresses.stats.toBase58(),
    gate: gate.publicKey.toBase58(),
    oracle: oracle.publicKey.toBase58(),
    faucet: faucet.publicKey.toBase58(),
    tokens,
    markets,
  };
  mkdirSync(dirname(on.deploymentPath), { recursive: true });
  writeFileSync(on.deploymentPath, JSON.stringify(description, null, 2) + "\n");
  console.log(JSON.stringify(description, null, 2));
}

async function status(on: Target): Promise<void> {
  const { addresses } = on.instructions;
  const onSolana = await exchangeOnSolana(on.solana, addresses);
  console.log(`network             ${on.network}`);
  console.log(`program             ${on.instructions.programId.toBase58()}`);
  console.log(`exchange            ${addresses.exchange.toBase58()}`);
  if (!onSolana) return console.log("exchange            not set up");
  console.log(
    `on Solana           ${onSolana.lamports} lamports, delegated ${onSolana.delegated}`,
  );
  const reader = await readingAs(on.privateUrl, Keypair.generate());
  const there = await reader.getAccountInfo(addresses.exchange);
  if (!there) return console.log("on the rollup       not there");
  const exchange = decodeExchange(there.data);
  console.log(`on the rollup       ${there.lamports} lamports`);
  console.log(`admin               ${exchange.admin.toBase58()}`);
  console.log(
    `pending admin       ${exchange.pendingAdmin?.toBase58() ?? "none"}`,
  );
  console.log(`gate                ${exchange.gate.toBase58()}`);
  console.log(`oracle              ${exchange.oracle.toBase58()}`);
  console.log(`paused              ${exchange.paused}`);
  for (const [index, token] of exchange.tokens.entries()) {
    if (!token.mint.equals(PublicKey.default)) {
      console.log(
        `token ${index}             mint ${token.mint.toBase58()} custody ${token.custody.toBase58()} (${token.custodyVisibility})`,
      );
    }
  }
  if (!exchange.tokens.some((token) => !token.mint.equals(PublicKey.default))) {
    console.log("tokens              none registered");
  }
  // The stats account is public, made with the ledger and finalised after
  // it, so it tells a ledger nobody can read from one that is not there.
  const stats = await reader.getAccountInfo(addresses.stats);
  const ledger = await reader.getAccountInfo(addresses.ledger);
  const ledgerIs = ledger
    ? "readable by a stranger (WRONG)"
    : !stats
      ? "not created"
      : decodeHeader(stats.data).ready
        ? "sealed"
        : "not finalised";
  console.log(`ledger              ${ledgerIs}`);
  for (const { id } of MARKETS) {
    const account = await reader.getAccountInfo(addresses.market(id));
    if (!account) {
      console.log(`market ${id}            absent`);
      continue;
    }
    const header = decodeHeader(account.data);
    const market = header.ready ? decodeMarket(account.data) : null;
    console.log(
      `market ${id}            ${header.ready ? `${market!.baseSymbol}/${market!.quoteSymbol} ready, status ${market!.params.status}` : "not ready"}`,
    );
  }
}

if (require.main === module) {
  const commands = { setup, status };
  const command = commands[process.argv[2] as keyof typeof commands];
  if (!command)
    throw new Error(`Use one of: ${Object.keys(commands).join(", ")}`);
  target()
    .then(command)
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}

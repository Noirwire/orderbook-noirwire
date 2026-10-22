/**
 * Operates one deployment of the order book on a network: `setup` sets it up
 * and prints a JSON description other services read; `status` shows what is
 * there.
 *
 * `PROFILE` says what `setup` sets up. The test profile is the test networks'
 * exchange: two test mints, custody, a faucet and three markets priced by the
 * oracle key. The mainnet profile is the launch of SECURITY.md, "Running a
 * small mainnet market", on a program it first checks is the mainnet build:
 * one quote token with a custody cap of 0, the SOL perpetual bound to Pyth,
 * the USDC guard, insurance, a first custody cap, a funded liquidation keeper
 * and, last, the first mark checked against the median of public exchange
 * prices (and Pyth Pro's, given a token) and against what insurance
 * covers before the market opens.
 *
 * The Makefile is the way in (`make local-setup`, `make rehearsal-setup`).
 * Running `setup` twice is safe: whatever exists is left as it is.
 */
import { randomBytes } from "crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname } from "path";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  type AccountInfo,
  type Connection,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  MARKET_KIND,
  MARKET_STATUS,
  OrderKeyManager,
  QUOTE_STATE,
  TraderClient,
  clockOf,
  decodeExchange,
  decodeHeader,
  decodeMarket,
  decodePriceFeed,
  decodeStats,
  decodeView,
  pythPriceAccount,
  randomCustodyNonce,
  setupLedger,
  setupMarket,
  type CustodyToken,
  type Exchange,
  type MarketSettings,
  type TokenInfo,
} from "../sdk/dist/index.js";
import {
  FUNDING_INTERVAL_SECONDS,
  MAINNET_MARKET,
  MAINNET_MAX_SEATS_PER_DAY,
  MAINNET_QUOTE_SOURCE,
  MAINNET_QUOTE_TOKEN,
  MAINNET_USDC_MINT,
  MARKETS,
  QUOTE_DECIMALS,
  TOKENS,
  adminKeyPath,
  depositingAs,
  describesTheseMints,
  keeperKeysPath,
  keyPath,
  launchMarket,
  readDeployment,
  rollupIsRunBy,
  run,
  sendingAs,
  type DeploymentDescription,
  type Target,
} from "./deployment";
import { ensureExchange, exchangeOnSolana } from "./exchange";
import { heldKey, keepOrderKeys, keyAt, orderKeysFor, readingAs } from "./keys";
import {
  atomsOf,
  custodyCapRefusal,
  insuranceHeldRefusal,
  launchSteps,
  leftAsFound,
  pendingVerdict,
  recordId,
  refusedOnChain,
  restorableStep,
  resumeVerdict,
  type LaunchObserved,
  type LaunchStep,
  type RestorableStep,
  type SentRecord,
} from "./launch";
import {
  checkedMark,
  exchangeInRollup,
  launchedMarket,
  perpMarketIds,
  priceFeedInRollup,
  quoteBoundAsLaunched,
  quotePasses,
} from "./market";
import { deployedAsBuilt } from "./program";
import { U32_MAX, nameIn, positiveInteger } from "./upkeep";
import { airdropped, send, until } from "./sending";
import {
  createMint,
  ensureCustody,
  fundRentPda,
  heldInRollup,
  mintOfDecimals,
  minted,
  movedIntoRollup,
  registeredToken,
  tokenBalance,
} from "./tokens";

const LOCAL_ADMIN_FLOOR_SOL = 10;
const LOCAL_ADMIN_AIRDROP_SOL = 100;
const FIRST_FUNDING_TASK_ID = 1_000;
/** The scheduler takes a count of runs; this many outlast any test network. */
const FUNDING_RUNS = 1_000_000_000n;

type Sender = { key: Keypair; connection: Connection };
type TokenSpec = (typeof TOKENS)[number];
type MarketSpec = (typeof MARKETS)[number];
type TokenDescription = DeploymentDescription["tokens"][number];
type MarketDescription = DeploymentDescription["markets"][number];

async function localAdminFunded(on: Target, admin: Keypair): Promise<void> {
  if (on.network !== "localnet") return;
  const balance = await on.solana.getBalance(admin.publicKey);
  if (balance >= LOCAL_ADMIN_FLOOR_SOL * LAMPORTS_PER_SOL) return;
  await airdropped(on.solana, admin.publicKey, LOCAL_ADMIN_AIRDROP_SOL);
}

/**
 * The mint of `symbol`, under a key kept with the others, so a run that
 * stops before the token is registered does not leave a mint behind and pay
 * for another one the next time.
 */
async function keptMint(
  on: Target,
  admin: Keypair,
  symbol: string,
  decimals: number,
): Promise<PublicKey> {
  const mint = keyAt(keyPath(on, `mint-${symbol}`));
  if (!(await on.solana.getAccountInfo(mint.publicKey))) {
    await createMint(on.solana, admin, decimals, mint);
  }
  return mint.publicKey;
}

/**
 * The custody nonce of `symbol`, kept with the keys so a run that stops
 * before the token is registered sets up the same custody the next time. A
 * new one is random and stays in that file, so nobody can claim its custody
 * balance before this run delegates it.
 */
function keptCustodyNonce(path: string): bigint {
  if (existsSync(path)) return BigInt(JSON.parse(readFileSync(path, "utf8")));
  const nonce = randomCustodyNonce();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(nonce.toString()), {
    mode: 0o600,
    flag: "wx",
  });
  return nonce;
}

/**
 * The token at `index`, registered under the mint `mintIfNew` gives with its
 * custody as the network's `CUSTODY` says, unless the exchange has one there
 * already. A registered token's custody cap starts at zero.
 */
async function tokenRegistered(
  on: Target,
  { index, symbol }: { index: number; symbol: string },
  admin: Keypair,
  deposits: Connection,
  mintIfNew: () => Promise<PublicKey>,
): Promise<CustodyToken & { custody: PublicKey }> {
  const registered = (await exchangeInRollup(on)).tokens[index];
  const isRegistered = !registered.mint.equals(PublicKey.default);
  const noncePath = keyPath(on, `custody-nonce-${symbol}`);
  const token = isRegistered
    ? registered
    : {
        mint: await mintIfNew(),
        custodyNonce: keptCustodyNonce(noncePath),
      };
  const visibility = isRegistered ? registered.custodyVisibility : on.custody;
  const custody = await ensureCustody(
    on.solana,
    admin,
    on.instructions.addresses,
    token,
    on.validator,
    visibility,
  ).catch((error: Error) => {
    throw new Error(
      isRegistered
        ? `${error.message} ${symbol} is registered with this custody, and a ` +
            "registered token's custody never changes, so it is no longer " +
            "usable through this endpoint (SECURITY.md)."
        : `${error.message} Nothing was registered: remove ${noncePath} ` +
            "and run setup again to register under another custody nonce.",
    );
  });
  if (!isRegistered) {
    await registeredToken(
      deposits,
      on.instructions,
      admin,
      index,
      token,
      visibility,
    );
  }
  return {
    mint: token.mint,
    custodyNonce: token.custodyNonce,
    custody,
  };
}

type TokenNamed = { index: number; symbol: string; decimals: number };

async function described(
  on: Target,
  { index, symbol, decimals }: TokenNamed,
  token: CustodyToken & { custody: PublicKey },
): Promise<TokenDescription> {
  return {
    index,
    symbol,
    decimals,
    mint: token.mint.toBase58(),
    custodyNonce: token.custodyNonce.toString(),
    custody: token.custody.toBase58(),
    custodyVisibility: (await exchangeInRollup(on)).tokens[index]
      .custodyVisibility,
  };
}

/**
 * A test mint registered with its custody cap at the faucet's whole supply,
 * and the faucet holding that supply inside the rollup, in a balance as
 * visible as custody is.
 */
async function tokenSetUp(
  on: Target,
  spec: TokenSpec,
  admin: Keypair,
  deposits: Connection,
  faucet: Sender,
): Promise<TokenDescription> {
  const { index, symbol, decimals, faucetAmount, custodyCap } = spec;
  const token = await tokenRegistered(on, spec, admin, deposits, () =>
    keptMint(on, admin, symbol, decimals),
  );
  const registered = (await exchangeInRollup(on)).tokens[index];
  if (registered.custodyCap !== custodyCap) {
    await send(
      deposits,
      on.instructions.setCustodyCap(admin.publicKey, index, custodyCap),
      admin,
    );
  }
  const faucetAccount = getAssociatedTokenAddressSync(
    token.mint,
    faucet.key.publicKey,
    true,
  );
  if ((await tokenBalance(faucet.connection, faucetAccount)) === 0n) {
    await minted(
      on.solana,
      admin,
      token.mint,
      faucet.key.publicKey,
      faucetAmount,
    );
    await movedIntoRollup(
      on.solana,
      faucet.connection,
      admin,
      faucet.key,
      token.mint,
      faucetAmount,
      on.validator,
      registered.custodyVisibility,
    );
  }
  return described(on, spec, token);
}

async function tokensSetUp(
  on: Target,
  admin: Keypair,
  faucetKey: Keypair,
): Promise<DeploymentDescription["tokens"]> {
  await fundRentPda(on.solana, admin);
  const deposits = await depositingAs(on, admin);
  const faucet = { key: faucetKey, connection: await sendingAs(on, faucetKey) };
  const tokens: DeploymentDescription["tokens"] = [];
  for (const spec of TOKENS) {
    tokens.push(await tokenSetUp(on, spec, admin, deposits, faucet));
  }
  return tokens;
}

async function pricePublished(on: Target, marketId: number): Promise<boolean> {
  return ((await priceFeedInRollup(on, marketId))?.price ?? 0n) > 0n;
}

function marketDescription(
  on: Target,
  {
    id,
    symbol,
    baseDecimals,
  }: { id: number; symbol: string; baseDecimals: number },
  settings: MarketSettings,
  fundingTaskId: number | undefined,
): MarketDescription {
  const { addresses } = on.instructions;
  return {
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
  };
}

const fundingTaskIdOf = (marketId: number) => FIRST_FUNDING_TASK_ID + marketId;

/** The mainnet profile's market as described once its funding is scheduled. */
const launchedMarketDescription = (on: Target) =>
  marketDescription(
    on,
    MAINNET_MARKET,
    launchMarket(on.insurance).settings,
    fundingTaskIdOf(MAINNET_MARKET.id),
  );

/** Schedules a perp market's funding under a new task, unless `scheduledAs` says it is. */
async function fundingScheduled(
  on: Target,
  admin: Sender,
  marketId: number,
  scheduledAs: number | undefined,
): Promise<number> {
  if (scheduledAs !== undefined) return scheduledAs;
  const taskId = fundingTaskIdOf(marketId);
  await send(
    admin.connection,
    on.instructions.scheduleFunding(
      admin.key.publicKey,
      marketId,
      BigInt(taskId),
      FUNDING_INTERVAL_SECONDS * 1_000n,
      FUNDING_RUNS,
    ),
    admin.key,
  );
  return taskId;
}

/**
 * A market that is ready, has a mark, and, when it is a perp, has its funding
 * scheduled under `fundingTaskId` or under a new task. The oracle never sets
 * a feed's first price: the admin's reset does, which leaves the market
 * reduce-only, and the same transaction opens it.
 */
async function marketSetUp(
  on: Target,
  spec: MarketSpec,
  admin: Sender,
  scheduledAs: number | undefined,
): Promise<MarketDescription> {
  const { id, initialMark, settings } = spec;
  const { programId } = on.instructions;
  await setupMarket(admin.connection, admin.key, id, settings, programId);
  if (!(await pricePublished(on, id))) {
    await send(
      admin.connection,
      [
        on.instructions.resetPrice(
          admin.key.publicKey,
          id,
          initialMark,
          BigInt(await clockOf(on.rollup)),
        ),
        on.instructions.resumeMarket(
          admin.key.publicKey,
          id,
          await perpMarketIds(on),
        ),
      ],
      admin.key,
    );
  }
  const fundingTaskId =
    settings.kind === MARKET_KIND.perp
      ? await fundingScheduled(on, admin, id, scheduledAs)
      : undefined;
  return marketDescription(on, spec, settings, fundingTaskId);
}

/** Writes the description where the Makefile said, for the services that read it. */
function recorded(on: Target, description: DeploymentDescription): string {
  const text = JSON.stringify(description, null, 2);
  mkdirSync(dirname(on.deploymentPath), { recursive: true });
  writeFileSync(on.deploymentPath, `${text}\n`);
  return text;
}

function baseDescription(
  on: Target,
  keys: { gate: Keypair; oracle: Keypair },
): Omit<DeploymentDescription, "tokens" | "markets"> {
  const { addresses } = on.instructions;
  return {
    network: on.network,
    profile: on.profile,
    programId: on.instructions.programId.toBase58(),
    solanaUrl: on.publicSolanaUrl,
    rollupUrl: on.rollupUrl,
    privateUrl: on.privateUrl,
    depositUrl: on.depositUrl,
    validator: on.validator.toBase58(),
    exchange: addresses.exchange.toBase58(),
    ledger: addresses.ledger.toBase58(),
    stats: addresses.stats.toBase58(),
    gate: keys.gate.publicKey.toBase58(),
    oracle: keys.oracle.publicKey.toBase58(),
  };
}

async function testSetup(on: Target): Promise<void> {
  const adminKey = heldKey(adminKeyPath(on));
  const gate = keyAt(keyPath(on, "gate"));
  const oracle = keyAt(keyPath(on, "oracle"));
  const faucet = keyAt(keyPath(on, "faucet"));
  await rollupIsRunBy(on);
  await localAdminFunded(on, adminKey);
  await ensureExchange({
    solana: on.solana,
    rollup: on.rollup,
    instructions: on.instructions,
    admin: adminKey,
    gate: gate.publicKey,
    oracle: oracle.publicKey,
    validator: on.validator,
    floatLamports: on.floatLamports,
  });
  const admin = { key: adminKey, connection: await sendingAs(on, adminKey) };

  const tokens = await tokensSetUp(on, adminKey, faucet);
  const previous = readDeployment(on.deploymentPath);
  const kept =
    previous && describesTheseMints(previous, tokens) ? previous : null;

  await setupLedger(admin.connection, adminKey, on.instructions.programId);
  const markets: DeploymentDescription["markets"] = [];
  for (const spec of MARKETS) {
    const known = kept?.markets.find((market) => market.id === spec.id);
    markets.push(await marketSetUp(on, spec, admin, known?.fundingTaskId));
  }

  console.log(
    recorded(on, {
      ...baseDescription(on, { gate, oracle }),
      faucet: faucet.publicKey.toBase58(),
      tokens,
      markets,
    }),
  );
}

/** RULES 9a: whether the guard has taken an observation since `set_quote_source` left it unread. */
const quoteRead = ({ quote }: Exchange) =>
  quote.state === QUOTE_STATE.depegged || quote.okUntil > 0n;

async function isReady(on: Target, address: PublicKey): Promise<boolean> {
  const account = await on.rollup.getAccountInfo(address);
  return account !== null && decodeHeader(account.data).ready;
}

/** What the mainnet profile works with, read once per run. */
type Launch = {
  admin: Sender;
  gate: Keypair;
  oracle: Keypair;
  keeper: Keypair;
  deposits: Connection;
  description: DeploymentDescription;
  /** The quote atoms the keeper's seat should hold, when the operator gave `KEEPER_DEPOSIT`. */
  keeperDeposit: bigint | null;
  /** The first custody cap, when the operator gave `CUSTODY_CAP`. */
  custodyCap: bigint | null;
  /** Who may upgrade the program, as Solana records it; null once nobody can. */
  upgradeAuthority: PublicKey | null;
  /** The market has been opened once (`openedOnce`). */
  launched: boolean;
  /** The one launch setting the operator asked to write back after launch (`RESTORE`). */
  restore: RestorableStep | null;
};

/** The quote mint the operator named in `QUOTE_MINT`, which on mainnet must be USDC. */
function namedQuoteMint(on: Target): PublicKey | null {
  const given = process.env.QUOTE_MINT;
  if (on.mainnet && given !== MAINNET_USDC_MINT.toBase58()) {
    throw new Error(
      `Mainnet's quote token is USDC, ${MAINNET_USDC_MINT.toBase58()}, and QUOTE_MINT is ${given || "not set"}. Nothing was sent.`,
    );
  }
  return given ? new PublicKey(given) : null;
}

const keptQuoteMintPath = (on: Target) =>
  keyPath(on, `mint-${MAINNET_QUOTE_TOKEN.symbol}`);

/** The quote mint: `QUOTE_MINT`, or a test mint kept with the keys where it is not given and the network is not mainnet. */
async function quoteMint(on: Target, admin: Keypair): Promise<PublicKey> {
  const named = namedQuoteMint(on);
  const { symbol, decimals } = MAINNET_QUOTE_TOKEN;
  return named
    ? mintOfDecimals(on.solana, named, decimals)
    : keptMint(on, admin, symbol, decimals);
}

/** Stops when the token registered at the quote index is not the one this run names, or keeps as its test mint. */
function quoteMintAsNamed(on: Target, exchange: Exchange): void {
  const registered = exchange.tokens[MAINNET_QUOTE_TOKEN.index].mint;
  if (registered.equals(PublicKey.default)) return;
  const kept = keptQuoteMintPath(on);
  const named =
    namedQuoteMint(on) ?? (existsSync(kept) ? heldKey(kept).publicKey : null);
  if (named && !registered.equals(named)) {
    throw new Error(
      `The exchange's quote token is ${registered.toBase58()}, not ${named.toBase58()}. Nothing was sent.`,
    );
  }
}

/** The steps that send once per program, whatever the description says. */
type OneShot = "insurance" | "funding";
/** The one-shot sends, and `resumed` once a run has opened the market. */
type SentBook = Partial<Record<OneShot | "resumed", SentRecord>>;

/** Kept with the keys, under the program id, so a lost or foreign description cannot hide a send. */
const sentPath = (on: Target) =>
  keyPath(on, `sent-${on.instructions.programId.toBase58()}`);

function sentBook(on: Target): SentBook {
  const path = sentPath(on);
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as SentBook)
    : {};
}

function sentNoted(
  on: Target,
  step: keyof SentBook,
  record: SentRecord | null,
) {
  const book = Object.fromEntries(
    Object.entries(sentBook(on)).filter(([each]) => each !== step),
  );
  const path = sentPath(on);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(record ? { ...book, [step]: record } : book, null, 2)}\n`,
  );
}

const landed = (record: SentRecord | undefined) => record?.state === "landed";

/**
 * Sends `step` once per program. It is recorded as pending, under an id of
 * its own, before it is sent and as landed once it has, so a run that stops
 * in between, or a send whose outcome never came back, leaves it pending, and
 * every later run stops there until the operator answers
 * `<STEP>_SENT=landed:<id>` or `lost:<id>` for that very record. A `lost`
 * sends once more under a new id, so the same answer never sends twice. A
 * send the network ran and refused changed nothing, and is forgotten.
 * `beforeSending` may refuse once the verdict is to send.
 */
async function sentOnce(
  on: Target,
  step: OneShot,
  sending: () => Promise<unknown>,
  beforeSending: (variable: string) => Promise<void> = async () => {},
): Promise<void> {
  const variable = `${step.toUpperCase()}_SENT`;
  const answer = process.env[variable];
  const record = sentBook(on)[step];
  const verdict = pendingVerdict(record, answer);
  if (verdict === "ask" && record) {
    const id = recordId(record);
    const stale = answer
      ? ` ${variable}=${answer} names no pending record of this step.`
      : "";
    throw new Error(
      `The ${step} step was sent at ${record.at} by a run that stopped before it learned the outcome (record ${id} in ${sentPath(on)}).${stale} ` +
        `Look up the admin's transactions from that time, then run again with ${variable}=landed:${id} if it landed or ${variable}=lost:${id} to send it again. ` +
        "Nothing was sent.",
    );
  }
  if (verdict === "send") {
    await beforeSending(variable);
    sentNoted(on, step, {
      state: "pending",
      at: new Date().toISOString(),
      id: randomBytes(4).toString("hex"),
    });
    await sending().catch((error: Error) => {
      if (refusedOnChain(error.message)) sentNoted(on, step, null);
      throw error;
    });
  }
  sentNoted(on, step, { state: "landed", at: new Date().toISOString() });
}

/**
 * How long the keeper's view must stay unwritten before a run signs with the
 * keeper's order keys: longer than a running keeper goes between sweeps.
 */
const KEEPER_QUIET_MS = 12_000;

/**
 * The keeper's collateral, read as the keeper, since nobody else may read its
 * view, or null while it has no seat. A deposit does not write the view, so
 * once the market exists the keeper syncs its view before it is read.
 *
 * Every order key replaces itself when it is used, so a keeper sweeping from
 * the same seat replaces the keys this run would sign with, several times a
 * second. The view is read twice, a quiet spell apart, and a view that moved
 * in between stops the run before anything is sent. It picks the keys up from
 * the keeper's saved checkpoint and saves it again after its own send, so the
 * keeper's next start finds them where this run left them.
 */
async function keeperCollateral(
  on: Target,
  keeper: Keypair,
): Promise<bigint | null> {
  const reader = await readingAs(on.privateUrl, keeper);
  const viewAddress = on.instructions.addresses.view(keeper.publicKey);
  const account = await reader.getAccountInfo(viewAddress);
  if (!account) return null;
  const first = decodeView(account.data);
  const { addresses, programId } = on.instructions;
  if (!(await isReady(on, addresses.market(MAINNET_MARKET.id)))) {
    return first.snapshot.seat.collateral;
  }
  await new Promise((resolve) => setTimeout(resolve, KEEPER_QUIET_MS));
  const again = await reader.getAccountInfo(viewAddress);
  if (!again) throw new Error("The keeper's view is gone. Nothing was sent.");
  const view = decodeView(again.data);
  if (view.resultsWritten !== first.resultsWritten) {
    throw new Error(
      "A keeper is sweeping from the keeper's seat: it replaces the seat's order keys as it goes, so this run cannot sign with them. Stop the keeper entirely (its whole process group), then run again. Nothing was sent.",
    );
  }
  const keysAt = keeperKeysPath(on);
  const client = new TraderClient(
    await sendingAs(on, keeper),
    reader,
    keeper.publicKey,
    orderKeysFor(keeper.secretKey.subarray(0, 32), view, keysAt),
    programId,
    { push: false },
  );
  try {
    await client.syncView(MAINNET_MARKET.id);
    return (await client.view()).snapshot.seat.collateral;
  } finally {
    keepOrderKeys(keysAt, client.keys);
    client.close();
  }
}

/** The custody token the exchange records at the quote index. */
async function quoteToken(on: Target): Promise<TokenInfo> {
  const token = (await exchangeInRollup(on)).tokens[MAINNET_QUOTE_TOKEN.index];
  if (token.mint.equals(PublicKey.default)) {
    throw new Error("The quote token is not registered. Run setup again.");
  }
  return token;
}

const LAUNCH: Record<
  LaunchStep,
  (on: Target, launch: Launch) => Promise<void>
> = {
  async seatsPerDay(on, { admin }) {
    const exchange = await exchangeInRollup(on);
    const wanted = seatsPerDayFor(on);
    if (exchange.maxSeatsPerDay === wanted) return;
    await send(
      admin.connection,
      on.instructions.updateExchange(admin.key.publicKey, {
        gate: exchange.gate,
        oracle: exchange.oracle,
        maxSteps: exchange.maxSteps,
        maxSeatsPerDay: wanted,
      }),
      admin.key,
    );
  },

  async quoteToken(on, launch) {
    await fundRentPda(on.solana, launch.admin.key);
    const token = await tokenRegistered(
      on,
      MAINNET_QUOTE_TOKEN,
      launch.admin.key,
      launch.deposits,
      () => quoteMint(on, launch.admin.key),
    );
    launch.description.tokens = [
      await described(on, MAINNET_QUOTE_TOKEN, token),
    ];
  },

  async ledger(on, { admin }) {
    await setupLedger(admin.connection, admin.key, on.instructions.programId);
  },

  async market(on, { admin }) {
    const { id, settings } = launchMarket(on.insurance);
    await setupMarket(
      admin.connection,
      admin.key,
      id,
      settings,
      on.instructions.programId,
    );
  },

  async quoteSource(on, { admin }) {
    if (quoteBoundAsLaunched(await exchangeInRollup(on))) return;
    await send(
      admin.connection,
      on.instructions.setQuoteSource(admin.key.publicKey, MAINNET_QUOTE_SOURCE),
      admin.key,
    );
  },

  async syncQuote(on, { admin }) {
    const exchange = await exchangeInRollup(on);
    if (quoteRead(exchange)) return;
    await send(
      admin.connection,
      on.instructions.syncQuote(exchange.quote.account),
      admin.key,
    ).catch((error: Error) => {
      throw new Error(
        `sync_quote was refused: ${error.message}\nThe USDC/USD account may be older than the guard's max age. ` +
          "Run the crank (with CRANK_PUSH=1 where the network's own updates are too slow) and run setup again.",
      );
    });
  },

  async syncPrice(on, { admin }) {
    const { id } = MAINNET_MARKET;
    if (await pricePublished(on, id)) return;
    await send(
      admin.connection,
      on.instructions.syncPrice(
        id,
        pythPriceAccount(MAINNET_MARKET.settings.priceSource.feedId),
      ),
      admin.key,
    ).catch((error: Error) => {
      throw new Error(
        `The first sync_price was refused: ${error.message}\nThe SOL/USD account may be older than the market's max age. ` +
          "Run the crank (with CRANK_PUSH=1 where the network's own updates are too slow) and run setup again.",
      );
    });
  },

  async funding(on, launch) {
    const { id } = MAINNET_MARKET;
    await sentOnce(on, "funding", () =>
      fundingScheduled(on, launch.admin, id, undefined),
    );
    launch.description.markets = [launchedMarketDescription(on)];
    recorded(on, launch.description);
  },

  async adminFunds(on, launch) {
    const insurance = launch.description.insuranceFunded ? 0n : on.insurance;
    const held = (await keeperCollateral(on, launch.keeper)) ?? 0n;
    const keeper =
      launch.keeperDeposit !== null && launch.keeperDeposit > held
        ? launch.keeperDeposit - held
        : 0n;
    if (insurance + keeper === 0n) return;
    await heldInRollup(
      on.solana,
      launch.deposits,
      launch.admin.key,
      (await quoteToken(on)).mint,
      insurance + keeper,
      on.validator,
      on.custody,
    );
  },

  async insurance(on, launch) {
    if (launch.description.insuranceFunded) return;
    const token = await quoteToken(on);
    await sentOnce(
      on,
      "insurance",
      () =>
        send(
          launch.deposits,
          on.instructions.fundInsurance(
            launch.admin.key.publicKey,
            getAssociatedTokenAddressSync(
              token.mint,
              launch.admin.key.publicKey,
              true,
            ),
            token,
            on.insurance,
          ),
          launch.admin.key,
        ),
      async (variable) => {
        const held =
          token.custodyVisibility === "public"
            ? await tokenBalance(
                on.rollup,
                on.instructions.addresses.custody(token),
              )
            : null;
        const refused = insuranceHeldRefusal(
          held,
          on.insurance,
          process.env[variable],
          variable,
        );
        if (refused) throw new Error(refused);
      },
    );
    launch.description.insuranceFunded = on.insurance.toString();
    recorded(on, launch.description);
  },

  async custodyCap(on, { admin, deposits, custodyCap }) {
    const { index } = MAINNET_QUOTE_TOKEN;
    const now = (await exchangeInRollup(on)).tokens[index].custodyCap;
    if (custodyCap === null || custodyCap === now) return;
    console.error(`custody cap ${now} -> ${custodyCap} atoms (CUSTODY_CAP)`);
    await send(
      deposits,
      on.instructions.setCustodyCap(admin.key.publicKey, index, custodyCap),
      admin.key,
    );
  },

  async keeper(on, launch) {
    const { keeper, gate, admin } = launch;
    if ((await keeperCollateral(on, keeper)) === null) {
      const keys = OrderKeyManager.fresh(keeper.secretKey.subarray(0, 32));
      await send(
        await sendingAs(on, gate),
        on.instructions.openTrader(
          gate.publicKey,
          keeper.publicKey,
          keys.publicKeys,
        ),
        gate,
        [keeper],
      );
    }
    const { held } = await until(
      async () => {
        const collateral = await keeperCollateral(on, keeper);
        return collateral === null ? null : { held: collateral };
      },
      "the keeper's view",
      30_000,
    );
    if (launch.keeperDeposit === null || held >= launch.keeperDeposit) return;
    const token = await quoteToken(on);
    await send(
      launch.deposits,
      on.instructions.deposit(
        admin.key.publicKey,
        getAssociatedTokenAddressSync(token.mint, admin.key.publicKey, true),
        token,
        keeper.publicKey,
        { collateral: true },
        launch.keeperDeposit - held,
      ),
      admin.key,
    ).catch((error: Error) => {
      throw new Error(
        `The keeper's deposit was refused: ${error.message}\n` +
          "Deposits are held to the custody cap, which counts insurance too: set CUSTODY_CAP above insurance plus every deposit.",
      );
    });
  },

  async checkMark(on) {
    await checkedMark(on);
  },

  async resume(on, { admin, upgradeAuthority, launched, restore }) {
    const { id, symbol } = MAINNET_MARKET;
    const { mark, reference, covered, openInterestCap } = await checkedMark(on);
    const adminUpgrades =
      upgradeAuthority?.equals((await exchangeInRollup(on)).admin) ?? false;
    if (adminUpgrades && !on.mainnet) {
      console.error(
        "The admin is the program's upgrade authority: on mainnet the market would stay reduce-only until they differ.",
      );
    }
    const verdict = resumeVerdict(
      {
        mark,
        reference,
        confirmed: launched
          ? restore === "resume"
          : process.env.RESUME_MARKET === "yes",
        covered,
        openInterestCap,
        adminUpgrades: adminUpgrades && on.mainnet,
      },
      launched ? "run this again with RESTORE=resume" : undefined,
    );
    if (!verdict.resume) {
      console.error(`${symbol} stays reduce-only: ${verdict.why}.`);
      return;
    }
    await send(
      admin.connection,
      on.instructions.resumeMarket(
        admin.key.publicKey,
        id,
        await perpMarketIds(on),
      ),
      admin.key,
    );
    sentNoted(on, "resumed", { state: "landed", at: new Date().toISOString() });
    console.error(`${symbol} resumed at a mark of ${mark}.`);
  },
};

/**
 * The seats a day the exchange opens: the launch's figure on mainnet, and on a
 * test network `SEATS_PER_DAY` when set, since every user who takes test
 * money from its faucet opens a seat. The program stores it in 32 bits.
 */
function seatsPerDayFor(on: Target): number {
  if (on.mainnet) return MAINNET_MAX_SEATS_PER_DAY;
  return positiveInteger(
    "SEATS_PER_DAY",
    process.env.SEATS_PER_DAY,
    MAINNET_MAX_SEATS_PER_DAY,
    U32_MAX,
  );
}

/**
 * Whether the launch's market has been opened once: this copy of the keys
 * recorded a resume, the market is active, or the public stats show it traded
 * or holds open interest, which a market never resumed cannot. A market
 * resumed and restricted again before any trade, by a run whose record is not
 * with these keys, reads as never opened.
 */
async function openedOnce(on: Target): Promise<boolean> {
  if (landed(sentBook(on).resumed)) return true;
  const { addresses } = on.instructions;
  const { id } = MAINNET_MARKET;
  const [market, stats] = await Promise.all([
    on.rollup.getAccountInfo(addresses.market(id)),
    on.rollup.getAccountInfo(addresses.stats),
  ]);
  if (
    market !== null &&
    decodeHeader(market.data).ready &&
    decodeMarket(market.data).params.status === MARKET_STATUS.active
  ) {
    return true;
  }
  if (stats === null || !decodeHeader(stats.data).ready) return false;
  const { volume, openInterest } = decodeStats(stats.data);
  return volume[id] > 0n || openInterest[id] > 0n;
}

/** What a run after launch leaves as it finds it, and how to have it written back. */
async function leftLine(on: Target, step: RestorableStep): Promise<string> {
  const how = `left as it is, since the market has opened; RESTORE=${step} writes it back`;
  if (step === "seatsPerDay") {
    const { maxSeatsPerDay } = await exchangeInRollup(on);
    return `max_seats_per_day is ${maxSeatsPerDay}, not the launch's ${seatsPerDayFor(on)}: ${how}`;
  }
  if (step === "quoteSource") {
    return `the USDC guard is not bound as the launch binds it: ${how}`;
  }
  const { symbol, id } = MAINNET_MARKET;
  const market = await on.rollup.getAccountInfo(
    on.instructions.addresses.market(id),
  );
  const status = market
    ? nameIn(MARKET_STATUS, decodeMarket(market.data).params.status)
    : "unreadable";
  return `${symbol} is ${status}: ${how} after checking the mark`;
}

/** What a run of the mainnet profile finds already done. */
async function observed(on: Target, launch: Launch): Promise<LaunchObserved> {
  const { addresses } = on.instructions;
  const exchange = await exchangeInRollup(on);
  const quote = exchange.tokens[MAINNET_QUOTE_TOKEN.index];
  const market = await on.rollup.getAccountInfo(
    addresses.market(MAINNET_MARKET.id),
  );
  const keeperHolds = await keeperCollateral(on, launch.keeper);
  return {
    seatsPerDay: exchange.maxSeatsPerDay === seatsPerDayFor(on),
    quoteToken: !quote.mint.equals(PublicKey.default),
    ledger: await isReady(on, addresses.stats),
    market: market !== null && decodeHeader(market.data).ready,
    quoteSource: quoteBoundAsLaunched(exchange),
    quoteRead: quoteRead(exchange),
    marked: await pricePublished(on, MAINNET_MARKET.id),
    active:
      market !== null &&
      decodeHeader(market.data).ready &&
      decodeMarket(market.data).params.status === MARKET_STATUS.active,
    resumeConfirmed: process.env.RESUME_MARKET === "yes",
    funding: launch.description.markets.some(
      (described) =>
        described.id === MAINNET_MARKET.id &&
        described.fundingTaskId !== undefined,
    ),
    insurance: launch.description.insuranceFunded !== undefined,
    custodyCap:
      launch.custodyCap === null || quote.custodyCap === launch.custodyCap,
    keeper:
      keeperHolds !== null &&
      (launch.keeperDeposit === null || keeperHolds >= launch.keeperDeposit),
    launched: launch.launched,
    restore: launch.restore,
  };
}

/**
 * What the description records of the one-shot sends: the earlier
 * description's own record, or else the record kept with the keys, so a
 * description that is lost or written for another program cannot make a run
 * send them again.
 */
function oneShotsDescribed(
  on: Target,
  kept: DeploymentDescription | null,
): Pick<DeploymentDescription, "markets" | "insuranceFunded"> {
  const sent = sentBook(on);
  const insuranceFunded =
    kept?.insuranceFunded ??
    (landed(sent.insurance) ? on.insurance.toString() : undefined);
  const fundingDescribed = kept?.markets.some(
    ({ fundingTaskId }) => fundingTaskId !== undefined,
  );
  return {
    markets:
      fundingDescribed || !landed(sent.funding)
        ? (kept?.markets ?? [])
        : [launchedMarketDescription(on)],
    ...(insuranceFunded ? { insuranceFunded } : {}),
  };
}

/**
 * Runs `work` while this process holds the setup lock of the program, a file
 * kept with the keys and made only if absent, so two runs from the same keys
 * never read the record of a one-shot send before either has written it.
 */
async function holdingSetupLock(
  on: Target,
  work: () => Promise<void>,
): Promise<void> {
  const lock = keyPath(
    on,
    `setup-lock-${on.instructions.programId.toBase58()}`,
  );
  mkdirSync(dirname(lock), { recursive: true });
  try {
    writeFileSync(lock, `${process.pid}\n`, { flag: "wx" });
  } catch {
    throw new Error(
      `Another setup run holds ${lock}. If none is running, one stopped without letting go: delete the file and run again. Nothing was sent.`,
    );
  }
  try {
    await work();
  } finally {
    unlinkSync(lock);
  }
}

/** Stops unless the exchange's gate is the key kept with these keys, which the keeper's seat is opened with. */
function gateAsKept(on: Target, exchange: Exchange, gate: Keypair): void {
  if (exchange.gate.equals(gate.publicKey)) return;
  throw new Error(
    `The exchange's gate is ${exchange.gate.toBase58()}, not the key at ${keyPath(on, "gate")}: ` +
      `these are not the keys the launch ran with, or the gate was replaced since. Run from the launch's keys folder, with ${sentPath(on)} in it, ` +
      "or put the gate key in place. Nothing was sent.",
  );
}

const mainnetSetup = (on: Target) =>
  holdingSetupLock(on, () => mainnetSetupHeld(on));

async function mainnetSetupHeld(on: Target): Promise<void> {
  const { upgradeAuthority } = await deployedAsBuilt(on);
  namedQuoteMint(on);
  const keeperDeposit = atomsOf(process.env.KEEPER_DEPOSIT, QUOTE_DECIMALS);
  const custodyCap = atomsOf(process.env.CUSTODY_CAP, QUOTE_DECIMALS);
  const capRefused = custodyCapRefusal(on.insurance, keeperDeposit, custodyCap);
  if (capRefused) throw new Error(capRefused);
  const restore = restorableStep(process.env.RESTORE);
  const adminKey = heldKey(adminKeyPath(on));
  const gate = keyAt(keyPath(on, "gate"));
  const oracle = keyAt(keyPath(on, "oracle"));
  await rollupIsRunBy(on);
  await localAdminFunded(on, adminKey);
  await ensureExchange({
    solana: on.solana,
    rollup: on.rollup,
    instructions: on.instructions,
    admin: adminKey,
    gate: gate.publicKey,
    oracle: oracle.publicKey,
    validator: on.validator,
    floatLamports: on.floatLamports,
    maxSeatsPerDay: MAINNET_MAX_SEATS_PER_DAY,
  });
  const exchange = await exchangeInRollup(on);
  gateAsKept(on, exchange, gate);
  quoteMintAsNamed(on, exchange);
  const previous = readDeployment(on.deploymentPath);
  const kept =
    previous?.programId === on.instructions.programId.toBase58() &&
    previous.exchange === on.instructions.addresses.exchange.toBase58()
      ? previous
      : null;
  const faucet =
    kept?.faucet && !on.mainnet ? { faucet: kept.faucet } : undefined;
  const launch: Launch = {
    admin: { key: adminKey, connection: await sendingAs(on, adminKey) },
    gate,
    oracle,
    keeper: keyAt(keyPath(on, "keeper")),
    deposits: await depositingAs(on, adminKey),
    description: {
      ...baseDescription(on, { gate, oracle }),
      ...faucet,
      tokens: kept?.tokens ?? [],
      ...oneShotsDescribed(on, kept),
    },
    keeperDeposit,
    custodyCap,
    upgradeAuthority,
    launched: await openedOnce(on),
    restore,
  };
  const found = await observed(on, launch);
  if (found.market) await launchedMarket(on);
  for (const step of leftAsFound(found)) {
    console.error(await leftLine(on, step));
  }
  for (const step of launchSteps(found)) {
    console.error(`step: ${step}`);
    await LAUNCH[step](on, launch);
  }
  if (launch.description.tokens.length === 0) {
    const token = await quoteToken(on);
    launch.description.tokens = [
      await described(on, MAINNET_QUOTE_TOKEN, {
        ...token,
        custody: on.instructions.addresses.custody(token),
      }),
    ];
  }
  console.log(recorded(on, launch.description));
}

const setup = (on: Target) =>
  on.profile === "mainnet" ? mainnetSetup(on) : testSetup(on);

type Account = AccountInfo<Buffer> | null;

/**
 * The stats account is public, made with the ledger and finalised after it,
 * so it tells a ledger nobody can read from one that is not there.
 */
function ledgerState(ledger: Account, stats: Account): string {
  if (ledger) return "readable by a stranger (WRONG)";
  if (!stats) return "not created";
  return decodeHeader(stats.data).ready ? "sealed" : "not finalised";
}

function marketState(account: Account): string {
  if (!account) return "absent";
  if (!decodeHeader(account.data).ready) return "not ready";
  const { baseSymbol, quoteSymbol, params } = decodeMarket(account.data);
  return `${baseSymbol}/${quoteSymbol} ready, status ${params.status}, health ${params.oracleHealth}, shortfall ${params.uncoveredShortfall}`;
}

function feedState(account: Account, clock: number): string {
  if (!account || !decodeHeader(account.data).ready) return "absent";
  const feed = decodePriceFeed(account.data);
  const bound = feed.binding.account.equals(PublicKey.default)
    ? "bound to no source"
    : `bound to ${feed.binding.account.toBase58()}`;
  return `mark ${feed.price}, ${clock - Number(feed.publishTime)} s old, ${bound}`;
}

const shown = (label: string, value: string) =>
  console.log(`${label.padEnd(20)}${value}`);

const profileMarketIds = (on: Target) =>
  on.profile === "mainnet" ? [MAINNET_MARKET.id] : MARKETS.map(({ id }) => id);

async function status(on: Target): Promise<void> {
  const { addresses } = on.instructions;
  const onSolana = await exchangeOnSolana(on.solana, addresses);
  shown("network", `${on.network}, ${on.profile} profile`);
  shown("program", on.instructions.programId.toBase58());
  if (on.profile === "mainnet") {
    const deployed = await deployedAsBuilt(on).catch((error: Error) => {
      shown("program bytes", `NOT THE BUILD: ${error.message}`);
      return null;
    });
    if (deployed) {
      shown("program bytes", `the build at ${on.builtProgramPath}`);
      shown(
        "upgrade authority",
        deployed.upgradeAuthority?.toBase58() ?? "none",
      );
    }
  }
  shown("exchange", addresses.exchange.toBase58());
  if (!onSolana) return shown("exchange", "not set up");
  shown(
    "on Solana",
    `${onSolana.lamports} lamports, delegated ${onSolana.delegated}`,
  );
  const stranger = await readingAs(on.privateUrl, Keypair.generate());
  const inRollup = await stranger.getAccountInfo(addresses.exchange);
  if (!inRollup) return shown("on the rollup", "not there");
  const exchange = decodeExchange(inRollup.data);
  const clock = await clockOf(on.rollup);
  shown("on the rollup", `${inRollup.lamports} lamports`);
  shown("admin", exchange.admin.toBase58());
  shown("pending admin", exchange.pendingAdmin?.toBase58() ?? "none");
  shown("gate", exchange.gate.toBase58());
  shown("oracle", exchange.oracle.toBase58());
  shown("paused", `${exchange.paused}`);
  shown(
    "seats a day",
    `${exchange.maxSeatsPerDay}, ${exchange.seatsOpened} opened on day ${exchange.seatsDay}`,
  );
  shown(
    "USDC guard",
    exchange.quote.account.equals(PublicKey.default)
      ? "unbound"
      : `${quotePasses(exchange, clock) ? "passing" : "NOT passing"}, state ${exchange.quote.state}, price ${exchange.quote.price}, ${clock - Number(exchange.quote.publishTime)} s old`,
  );
  const registered = [...exchange.tokens.entries()].filter(
    ([, token]) => !token.mint.equals(PublicKey.default),
  );
  for (const [index, token] of registered) {
    shown(
      `token ${index}`,
      `mint ${token.mint.toBase58()} custody ${token.custody.toBase58()} (${token.custodyVisibility}, cap ${token.custodyCap})`,
    );
  }
  if (registered.length === 0) shown("tokens", "none registered");
  shown(
    "ledger",
    ledgerState(
      await stranger.getAccountInfo(addresses.ledger),
      await stranger.getAccountInfo(addresses.stats),
    ),
  );
  for (const id of profileMarketIds(on)) {
    shown(
      `market ${id}`,
      marketState(await stranger.getAccountInfo(addresses.market(id))),
    );
    shown(
      `price ${id}`,
      feedState(await stranger.getAccountInfo(addresses.priceFeed(id)), clock),
    );
  }
}

const commands = new Map([
  ["setup", setup],
  ["status", status],
]);
const command = commands.get(process.argv[2]);
if (!command) {
  throw new Error(`Use one of: ${[...commands.keys()].join(", ")}`);
}
run(command);

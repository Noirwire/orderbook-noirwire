/**
 * Operates one deployment of the order book on a network: `setup` sets up
 * the exchange, the ledger, the markets, the test mints, custody and a
 * faucet, and prints a JSON description other services read; `status` shows
 * what is there.
 *
 * The Makefile is the way in (`make local-setup`, `make local-status`).
 * Running `setup` twice is safe: whatever exists is left as it is.
 */
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
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
  clockOf,
  decodeExchange,
  decodeHeader,
  decodeMarket,
  decodePriceFeed,
  setupLedger,
  setupMarket,
  type Exchange,
} from "../sdk/dist/index.js";
import {
  FUNDING_INTERVAL_SECONDS,
  MARKETS,
  QUOTE_DECIMALS,
  TOKENS,
  depositingAs,
  describesTheseMints,
  keyPath,
  readDeployment,
  rollupIsRunBy,
  run,
  sendingAs,
  type DeploymentDescription,
  type Target,
} from "./deployment";
import { ensureExchange, exchangeOnSolana } from "./exchange";
import { heldKey, keyAt, readingAs } from "./keys";
import { airdropped, send } from "./sending";
import {
  createMint,
  ensureCustody,
  fundRentPda,
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

/** The admin key is put there by hand, except on the local network, where the Makefile makes it. */
const adminKeyPath = (on: Target) =>
  on.network === "localnet"
    ? join(on.keysDir, "admin.json")
    : keyPath(on, "admin");

async function localAdminFunded(on: Target, admin: Keypair): Promise<void> {
  if (on.network !== "localnet") return;
  const balance = await on.solana.getBalance(admin.publicKey);
  if (balance >= LOCAL_ADMIN_FLOOR_SOL * LAMPORTS_PER_SOL) return;
  await airdropped(on.solana, admin.publicKey, LOCAL_ADMIN_AIRDROP_SOL);
}

async function exchangeInRollup(on: Target): Promise<Exchange> {
  const account = await on.rollup.getAccountInfo(
    on.instructions.addresses.exchange,
  );
  if (!account) {
    throw new Error("The exchange is not in the rollup. Run setup again.");
  }
  return decodeExchange(account.data);
}

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
  const mint = keyAt(keyPath(on, `mint-${spec.symbol}`));
  if (!(await on.solana.getAccountInfo(mint.publicKey))) {
    await createMint(on.solana, admin, spec.decimals, mint);
  }
  return mint.publicKey;
}

/**
 * A test mint with its custody registered as the network's `CUSTODY` says,
 * and the faucet holding its amount inside the rollup, in a balance as
 * visible as custody is.
 */
async function tokenSetUp(
  on: Target,
  spec: TokenSpec,
  admin: Keypair,
  deposits: Connection,
  faucet: Sender,
): Promise<DeploymentDescription["tokens"][number]> {
  const { addresses } = on.instructions;
  const { index, symbol, decimals, faucetAmount } = spec;
  const registered = (await exchangeInRollup(on)).tokens[index];
  const isRegistered = !registered.mint.equals(PublicKey.default);
  const mint = isRegistered ? registered.mint : await keptMint(on, admin, spec);
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
      index,
      mint,
      visibility,
    );
  }
  const faucetAccount = getAssociatedTokenAddressSync(
    mint,
    faucet.key.publicKey,
    true,
  );
  if ((await tokenBalance(faucet.connection, faucetAccount)) === 0n) {
    await minted(on.solana, admin, mint, faucet.key.publicKey, faucetAmount);
    await movedIntoRollup(
      on.solana,
      faucet.connection,
      admin,
      faucet.key,
      mint,
      faucetAmount,
      on.validator,
      visibility,
    );
  }
  return {
    index,
    symbol,
    decimals,
    mint: mint.toBase58(),
    custody: custody.toBase58(),
    custodyVisibility: (await exchangeInRollup(on)).tokens[index]
      .custodyVisibility,
  };
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
  const feed = await on.rollup.getAccountInfo(
    on.instructions.addresses.priceFeed(marketId),
  );
  return feed !== null && decodePriceFeed(feed.data).price > 0n;
}

/**
 * A market that is ready, has a mark, and, when it is a perp, has its funding
 * scheduled under `fundingTaskId` or under a new task.
 */
async function marketSetUp(
  on: Target,
  { id, symbol, baseDecimals, initialMark, settings }: MarketSpec,
  admin: Sender,
  oracle: Sender,
  scheduledAs: number | undefined,
): Promise<DeploymentDescription["markets"][number]> {
  const { addresses } = on.instructions;
  const isPerp = settings.kind === MARKET_KIND.perp;
  await setupMarket(admin.connection, admin.key, id, settings);
  if (!(await pricePublished(on, id))) {
    await send(
      oracle.connection,
      on.instructions.publishPrice(
        oracle.key.publicKey,
        id,
        initialMark,
        BigInt(await clockOf(on.rollup)),
      ),
      oracle.key,
    );
  }
  let fundingTaskId = scheduledAs;
  if (isPerp && fundingTaskId === undefined) {
    fundingTaskId = FIRST_FUNDING_TASK_ID + id;
    await send(
      admin.connection,
      on.instructions.scheduleFunding(
        admin.key.publicKey,
        id,
        BigInt(fundingTaskId),
        FUNDING_INTERVAL_SECONDS * 1_000n,
        FUNDING_RUNS,
      ),
      admin.key,
    );
  }
  return {
    id,
    symbol,
    kind: isPerp ? "perp" : "spot",
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

async function setup(on: Target): Promise<void> {
  const adminKey = heldKey(adminKeyPath(on));
  const gate = keyAt(keyPath(on, "gate"));
  const oracleKey = keyAt(keyPath(on, "oracle"));
  const faucet = keyAt(keyPath(on, "faucet"));
  const { addresses } = on.instructions;
  await rollupIsRunBy(on);
  await localAdminFunded(on, adminKey);
  await ensureExchange({
    solana: on.solana,
    rollup: on.rollup,
    admin: adminKey,
    gate: gate.publicKey,
    oracle: oracleKey.publicKey,
    validator: on.validator,
    floatLamports: on.floatLamports,
  });
  const admin = { key: adminKey, connection: await sendingAs(on, adminKey) };
  const oracle = { key: oracleKey, connection: await sendingAs(on, oracleKey) };

  const tokens = await tokensSetUp(on, adminKey, faucet);
  const previous = readDeployment(on.deploymentPath);
  const kept =
    previous && describesTheseMints(previous, tokens) ? previous : null;

  await setupLedger(admin.connection, adminKey);
  const markets: DeploymentDescription["markets"] = [];
  for (const spec of MARKETS) {
    const known = kept?.markets.find((market) => market.id === spec.id);
    markets.push(
      await marketSetUp(on, spec, admin, oracle, known?.fundingTaskId),
    );
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
    oracle: oracleKey.publicKey.toBase58(),
    faucet: faucet.publicKey.toBase58(),
    tokens,
    markets,
  };
  const text = JSON.stringify(description, null, 2);
  mkdirSync(dirname(on.deploymentPath), { recursive: true });
  writeFileSync(on.deploymentPath, `${text}\n`);
  console.log(text);
}

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
  return `${baseSymbol}/${quoteSymbol} ready, status ${params.status}`;
}

const shown = (label: string, value: string) =>
  console.log(`${label.padEnd(20)}${value}`);

async function status(on: Target): Promise<void> {
  const { addresses } = on.instructions;
  const onSolana = await exchangeOnSolana(on.solana, addresses);
  shown("network", on.network);
  shown("program", on.instructions.programId.toBase58());
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
  shown("on the rollup", `${inRollup.lamports} lamports`);
  shown("admin", exchange.admin.toBase58());
  shown("pending admin", exchange.pendingAdmin?.toBase58() ?? "none");
  shown("gate", exchange.gate.toBase58());
  shown("oracle", exchange.oracle.toBase58());
  shown("paused", `${exchange.paused}`);
  const registered = [...exchange.tokens.entries()].filter(
    ([, token]) => !token.mint.equals(PublicKey.default),
  );
  for (const [index, token] of registered) {
    shown(
      `token ${index}`,
      `mint ${token.mint.toBase58()} custody ${token.custody.toBase58()} (${token.custodyVisibility})`,
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
  for (const { id } of MARKETS) {
    shown(
      `market ${id}`,
      marketState(await stranger.getAccountInfo(addresses.market(id))),
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

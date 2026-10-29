/**
 * Funds a trader's seat on a network that has no faucet:
 *
 *   OWNER=<key> AMOUNT=<whole quote tokens>
 *
 * The admin mints that many of the deployment's test quote token, the mint
 * whose authority is the admin key, moves them into the rollup the way setup
 * and the smoke do, and deposits them as collateral to OWNER's seat. The seat
 * must be open already: a trader opens its own through the gate. It never
 * runs on mainnet.
 *
 * The Makefile is the way in (`make local-fund`, `make rehearsal-fund`).
 */
import { existsSync } from "fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getMint } from "@solana/spl-token";
import {
  OrderKeyManager,
  TraderClient,
  decodeView,
} from "../sdk/dist/index.js";
import {
  adminKeyPath,
  depositingAs,
  keyPath,
  readDeployment,
  rollupIsRunBy,
  run,
  sendingAs,
  type Target,
} from "./deployment";
import {
  depositFailure,
  fundRefusal,
  fundRequest,
  fundingAtoms,
  mintRefusal,
} from "./funding";
import { heldKey, readingAs } from "./keys";
import { shown } from "./leaving";
import { exchangeInRollup } from "./market";
import { deployedAsBuilt } from "./program";
import { send } from "./sending";
import { heldInRollup } from "./tokens";

/** The names the smoke keeps its traders' keys under. */
const KEPT_TRADERS = ["smoke-a", "smoke-b"];

/**
 * The seat's collateral after the deposit, or null. A seat's balance is
 * sealed to its owner, so it is read only where this machine holds the
 * owner's key: the smoke's kept traders.
 */
async function collateralOf(
  on: Target,
  owner: PublicKey,
): Promise<bigint | null> {
  const marketId = readDeployment(on.deploymentPath)?.markets[0]?.id;
  const held = KEPT_TRADERS.map((name) => keyPath(on, name))
    .filter((path) => existsSync(path))
    .map(heldKey)
    .find((key) => key.publicKey.equals(owner));
  if (!held || marketId === undefined) return null;
  const reader = await readingAs(on.privateUrl, held);
  const view = await reader.getAccountInfo(
    on.instructions.addresses.view(owner),
  );
  if (!view) return null;
  const client = new TraderClient(
    await sendingAs(on, held),
    reader,
    owner,
    OrderKeyManager.fromView(
      held.secretKey.subarray(0, 32),
      decodeView(view.data),
    ),
    on.instructions.programId,
    { push: false },
  );
  try {
    await client.syncView(marketId);
    return (await client.view()).snapshot.seat.collateral;
  } catch {
    return null;
  } finally {
    client.close();
  }
}

async function fund(on: Target): Promise<void> {
  const refusal = fundRefusal(on);
  if (refusal) throw new Error(refusal);
  const request = fundRequest(process.env);
  const admin: Keypair = heldKey(adminKeyPath(on));
  const exchange = await exchangeInRollup(on);
  if (!exchange.admin.equals(admin.publicKey)) {
    throw new Error(
      `The exchange's admin is ${exchange.admin.toBase58()}, not ${admin.publicKey.toBase58()}. Nothing was sent.`,
    );
  }
  if (on.profile === "mainnet") await deployedAsBuilt(on);
  await rollupIsRunBy(on);

  const token = exchange.tokens[exchange.collateralToken];
  if (token.mint.equals(PublicKey.default)) {
    throw new Error("The quote token is not registered. Run setup first.");
  }
  const { mintAuthority, decimals } = await getMint(on.solana, token.mint);
  const refusedMint = mintRefusal(token.mint, mintAuthority, admin.publicKey);
  if (refusedMint) throw new Error(refusedMint);

  const atoms = fundingAtoms(request.tokens, decimals);
  const deposits = await depositingAs(on, admin);
  await heldInRollup(
    on.solana,
    deposits,
    admin,
    token.mint,
    atoms,
    on.validator,
    token.custodyVisibility,
  );
  const signature = await send(
    deposits,
    on.instructions.deposit(
      admin.publicKey,
      getAssociatedTokenAddressSync(token.mint, admin.publicKey, true),
      token,
      request.owner,
      { collateral: true },
      atoms,
    ),
    admin,
  ).catch((error: Error) => {
    throw depositFailure(error.message, request.owner);
  });

  shown("network", `${on.network}, program ${on.instructions.programId}`);
  shown("owner", request.owner.toBase58());
  shown("deposited", `${request.tokens} tokens (${atoms} atoms) as collateral`);
  shown("signature", signature);
  const collateral = await collateralOf(on, request.owner);
  shown(
    "collateral",
    collateral === null
      ? "not read back: a seat's balance is sealed to its owner"
      : `${collateral} atoms`,
  );
}

run(fund);

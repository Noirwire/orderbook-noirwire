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
import type { PublicKey } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import {
  OrderKeyManager,
  TraderClient,
  decodeView,
} from "../sdk/dist/index.js";
import { adminSigner } from "./administering";
import {
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
import { collateralTokenOf, exchangeInRollup } from "./market";
import { deployedAsBuilt } from "./program";
import { depositedAsCollateral } from "./tokens";

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
  const exchange = await exchangeInRollup(on);
  const admin = adminSigner(on, exchange.admin);
  if (on.profile === "mainnet") await deployedAsBuilt(on);
  await rollupIsRunBy(on);

  const token = collateralTokenOf(exchange);
  const { mintAuthority, decimals } = await getMint(on.solana, token.mint);
  const refusedMint = mintRefusal(token.mint, mintAuthority, admin.publicKey);
  if (refusedMint) throw new Error(refusedMint);

  const atoms = fundingAtoms(request.tokens, decimals);
  const deposits = await depositingAs(on, admin);
  const signature = await depositedAsCollateral(
    on,
    deposits,
    admin,
    request.owner,
    token,
    atoms,
    (message) => depositFailure(message, request.owner),
  );

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

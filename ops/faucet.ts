/**
 * Gives a network that has no faucet one, so people can be handed test money:
 *
 *   AMOUNT=<whole quote tokens>
 *
 * The faucet's key is made under the keys folder when it is not there, never
 * printed, and left alone when it is. The admin, who must be the quote
 * token's mint authority, mints AMOUNT of the test quote token and moves it
 * into the rollup to the faucet's balance, the way setup does for the test
 * profile's faucet; a balance already at AMOUNT or more is left as it is, so
 * running it again tops the faucet up to AMOUNT. The faucet's public key is
 * then recorded in the deployment description as `faucet`, the field the test
 * profile writes, and nothing else in the description changes.
 *
 * Each grant the faucet pays is a deposit to custody and counts against the
 * token's custody cap, which this command never raises; it says what cap the
 * grants need. It never runs on mainnet.
 *
 * The Makefile is the way in (`make local-faucet`, `make rehearsal-faucet`).
 */
import { writeFileSync } from "fs";
import { resolve } from "path";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getMint } from "@solana/spl-token";
import {
  adminKeyPath,
  keyPath,
  readDeployment,
  rollupIsRunBy,
  run,
  sendingAs,
  type Target,
} from "./deployment";
import {
  capNeededWhole,
  faucetDescriptionRefusal,
  faucetRefusal,
  fundingAtoms,
  mintRefusal,
  wholeTokens,
  withFaucet,
} from "./funding";
import { heldKey, keyAt } from "./keys";
import { exchangeInRollup } from "./market";
import { deployedAsBuilt } from "./program";
import { heldInRollup, tokenBalance } from "./tokens";

const shown = (label: string, value: string) =>
  console.log(`${label.padEnd(24)}${value}`);

async function faucet(on: Target): Promise<void> {
  const refusal = faucetRefusal(on);
  if (refusal) throw new Error(refusal);
  const tokens = wholeTokens(process.env.AMOUNT);
  const admin = heldKey(adminKeyPath(on));
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
  const description = readDeployment(on.deploymentPath);
  const refusedDescription = faucetDescriptionRefusal(
    description,
    on.instructions.programId,
    token.mint,
  );
  if (refusedDescription) throw new Error(refusedDescription);
  if (!description) throw new Error("There is no deployment description.");
  const atoms = fundingAtoms(tokens, decimals);

  const faucetKeyPath = keyPath(on, "faucet");
  const key = keyAt(faucetKeyPath);
  const balance = await sendingAs(on, key);
  await heldInRollup(
    on.solana,
    balance,
    key,
    token.mint,
    atoms,
    on.validator,
    token.custodyVisibility,
    admin,
  );
  const held = await tokenBalance(
    balance,
    getAssociatedTokenAddressSync(token.mint, key.publicKey, true),
  );

  writeFileSync(
    on.deploymentPath,
    `${JSON.stringify(withFaucet(description, key.publicKey), null, 2)}\n`,
  );

  const inCustody = await tokenBalance(
    on.rollup,
    on.instructions.addresses.custody(token),
  );
  const capNeeded = capNeededWhole(inCustody, held, decimals);
  const capNow = token.custodyCap / 10n ** BigInt(decimals);
  shown("network", `${on.network}, ${on.profile} profile`);
  shown("faucet", key.publicKey.toBase58());
  shown(
    "holds in the rollup",
    `${held} atoms (${held / 10n ** BigInt(decimals)} tokens)`,
  );
  shown("description", on.deploymentPath);
  shown("custody holds", `${inCustody} atoms; cap ${token.custodyCap} atoms`);
  shown(
    "cap needed",
    `${capNeeded} whole tokens, for the faucet to hand out all it holds`,
  );
  if (capNow < capNeeded) {
    console.log(
      `WARNING: the cap is ${capNow} whole tokens, short of ${capNeeded}: grants would be refused past it. Raise it with CUSTODY_CAP=${capNeeded} on the setup target. This command never raises it.`,
    );
  }
  shown(
    "new seats a day",
    `${exchange.maxSeatsPerDay}; ${exchange.seatsOpened} opened on day ${exchange.seatsDay}`,
  );
  console.log("");
  console.log("The test service needs, in its environment:");
  console.log(`  DEPLOYMENT_PATH=${resolve(on.deploymentPath)}`);
  console.log(`  FAUCET_SECRET_KEY_FILE=${resolve(faucetKeyPath)}`);
  console.log(`  GATE_SECRET_KEY_FILE=${resolve(keyPath(on, "gate"))}`);
}

run(faucet);

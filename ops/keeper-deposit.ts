/**
 * Tops up the liquidation keeper's seat:
 *
 *   KEYFILE=<the funded wallet's key file> AMOUNT=<whole USDC> [KEEPER=<the keeper's public key>]
 *
 * The wallet that owns KEYFILE moves that much USDC from its token account on
 * Solana into the rollup and deposits it as collateral to the keeper's seat.
 * It is any funded wallet with a little SOL for the move: not the exchange's
 * admin, whose key may be on a hardware wallet by now, and not the keeper,
 * which holds nothing of its own to move. Anyone can deposit to a seat, and
 * nothing here can take anything out of it. The keeper's address is the one of
 * the key kept for it (`<network>-keeper.json`), or KEEPER, which must then be
 * the same when both are there. A seat that does not exist is refused by the
 * program, with the USDC left in the wallet's balance in the rollup.
 *
 * A takeover the keeper's margin cannot carry makes the keeper print an ALERT
 * that names this command. The keeper's view shows a deposit only after its
 * next sweep.
 * Where this machine's deployment description records the keeper's deposit,
 * the amount is added to it, so the checks that size insurance from public
 * custody beyond the keeper's deposit stay honest.
 *
 * The Makefile is the way in (`make rehearsal-keeper-deposit`,
 * `make mainnet-keeper-deposit`).
 */
import { existsSync, writeFileSync } from "fs";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getMint } from "@solana/spl-token";
import {
  depositingAs,
  existingKey,
  keyPath,
  readDeployment,
  rollupIsRunBy,
  run,
} from "./deployment";
import { fundingAtoms } from "./funding";
import {
  keeperDepositFailure,
  keeperSeatOwner,
  keeperTopUpRequest,
  withKeeperTopUp,
} from "./launch";
import { ownerAt, shown } from "./leaving";
import { exchangeInRollup } from "./market";
import { deployedAsBuilt } from "./program";
import { quoteRefusal } from "./seating";
import { send } from "./sending";
import { heldInRollup } from "./tokens";

run(async (on) => {
  if (on.profile !== "mainnet") {
    throw new Error(
      "The keeper's seat is set up for the mainnet profile only. Nothing was sent.",
    );
  }
  const request = keeperTopUpRequest(process.env);
  const wallet = ownerAt(request.keyFile);
  const keeperKeyFile = keyPath(on, "keeper");
  const keeper = keeperSeatOwner(
    request.keeper,
    existsSync(keeperKeyFile) ? existingKey(on, "keeper").publicKey : null,
    keeperKeyFile,
  );
  await deployedAsBuilt(on);
  await rollupIsRunBy(on);
  const exchange = await exchangeInRollup(on);
  const token = exchange.tokens[exchange.collateralToken];
  if (token.mint.equals(PublicKey.default)) {
    throw new Error("The quote token is not registered. Run setup first.");
  }
  const wrongQuote = quoteRefusal(on, token.mint, "the keeper's seat");
  if (wrongQuote) throw new Error(wrongQuote);

  const { decimals } = await getMint(on.solana, token.mint);
  const atoms = fundingAtoms(request.tokens, decimals);
  shown("network", `${on.network}, program ${on.instructions.programId}`);
  shown("keeper", keeper.toBase58());
  shown("from", wallet.publicKey.toBase58());
  const deposits = await depositingAs(on, wallet);
  await heldInRollup(
    on.solana,
    deposits,
    wallet,
    token.mint,
    atoms,
    on.validator,
    token.custodyVisibility,
  );
  const signature = await send(
    deposits,
    on.instructions.deposit(
      wallet.publicKey,
      getAssociatedTokenAddressSync(token.mint, wallet.publicKey, true),
      token,
      keeper,
      { collateral: true },
      atoms,
    ),
    wallet,
  ).catch((error: Error) => {
    throw keeperDepositFailure(error.message, keeper);
  });
  shown("deposited", `${request.tokens} USDC (${atoms} atoms) as collateral`);
  shown("signature", signature);

  const topped = withKeeperTopUp(
    readDeployment(on.deploymentPath),
    on.instructions.programId.toBase58(),
    atoms,
  );
  if (topped) {
    writeFileSync(on.deploymentPath, `${JSON.stringify(topped, null, 2)}\n`);
    shown(
      "recorded",
      `${topped.keeperDeposited} atoms deposited to the keeper in ${on.deploymentPath}`,
    );
  } else {
    shown(
      "recorded",
      `nothing: ${on.deploymentPath} records no keeper deposit for this program, so give INSURANCE_HELD (whole USDC, from the console) to the mark check`,
    );
  }
  shown(
    "keeper's view",
    "the keeper shows the deposit after its next sweep: run the mark check (make mainnet-markcheck or make rehearsal-markcheck) to see its funding",
  );
});

/**
 * The house maker's seat, by SEAT:
 *
 *   show      the maker's address, its seat and its balances
 *   open      the gate key and the maker's key together open the maker's seat
 *   deposit   AMOUNT=<whole USDC> moves USDC the maker holds on Solana into the
 *             rollup and deposits it as collateral to the seat
 *   withdraw  AMOUNT=<whole USDC> pays collateral out of the seat into the
 *             maker's own balance in the rollup
 *
 * The seat is always the one of the key kept as `<network>-maker.json`; the
 * USDC for a deposit has to be in that key's account on Solana already, with
 * a little SOL for the move, and this command never mints. Moving a withdrawn
 * balance on from the rollup to Solana is the exit command's step
 * (`make rehearsal-exit`, `make mainnet-exit`), which this command does not do.
 *
 * The Makefile is the way in (`make rehearsal-seat`, `make mainnet-seat`).
 */
import { getAssociatedTokenAddressSync, getMint } from "@solana/spl-token";
import { OrderKeyManager } from "../sdk/dist/index.js";
import {
  depositingAs,
  existingKey,
  keyPath,
  rollupIsRunBy,
  run,
  sendingAs,
} from "./deployment";
import { fundingAtoms } from "./funding";
import { custodyShown } from "./keeping";
import { readingAs } from "./keys";
import { custodyText } from "./launch";
import { shown } from "./leaving";
import { collateralTokenOf, exchangeInRollup, perpMarketIds } from "./market";
import { deployedAsBuilt } from "./program";
import {
  gateRefusal,
  makerRefusal,
  quoteRefusal,
  seatDepositFailure,
  seatRequest,
  withdrawRefusal,
} from "./seating";
import { send, simulatedError, until } from "./sending";
import { depositedAsCollateral, tokenBalance } from "./tokens";

run(async (on) => {
  if (on.profile !== "mainnet") {
    throw new Error(
      "The house maker's seat is set up for the mainnet profile only. Nothing was sent.",
    );
  }
  const request = seatRequest(process.env);
  const maker = existingKey(on, "maker");
  await deployedAsBuilt(on);
  await rollupIsRunBy(on);
  const exchange = await exchangeInRollup(on);
  const token = collateralTokenOf(exchange);
  const refusal =
    makerRefusal(maker.publicKey, exchange) ?? quoteRefusal(on, token.mint);
  if (refusal) throw new Error(refusal);

  const { addresses } = on.instructions;
  const reader = await readingAs(on.privateUrl, maker);
  const isOpen = async () =>
    (await reader.getAccountInfo(addresses.view(maker.publicKey))) !== null;
  const account = getAssociatedTokenAddressSync(
    token.mint,
    maker.publicKey,
    true,
  );
  const deposits = await depositingAs(on, maker);
  const held = await custodyShown(
    on,
    token.custodyVisibility,
    addresses.custody(token),
  );

  shown("network", `${on.network}, program ${on.instructions.programId}`);
  shown("maker", maker.publicKey.toBase58());
  const open = await isOpen();

  if (request.command === "show") {
    shown("seat", open ? "open" : "not open");
    shown(
      "SOL on Solana",
      `${await on.solana.getBalance(maker.publicKey)} lamports`,
    );
    shown("USDC on Solana", `${await tokenBalance(on.solana, account)} atoms`);
    shown(
      "USDC in the rollup",
      `${await tokenBalance(deposits, account)} atoms`,
    );
    shown("custody", custodyText(held));
    shown(
      "collateral",
      "sealed to the maker: it is not read here, since reading it signs with the order keys the maker rotates",
    );
    return;
  }

  if (request.command === "open") {
    if (open) return shown("seat", "already open. Nothing was sent.");
    const gate = existingKey(on, "gate");
    const wrongGate = gateRefusal(
      exchange.gate,
      gate.publicKey,
      keyPath(on, "gate"),
    );
    if (wrongGate) throw new Error(wrongGate);
    shown(
      "signature",
      await send(
        await sendingAs(on, gate),
        on.instructions.openTrader(
          gate.publicKey,
          maker.publicKey,
          OrderKeyManager.fresh(maker.secretKey.subarray(0, 32)).publicKeys,
        ),
        gate,
        [maker],
      ),
    );
    await until(isOpen, "the maker's seat to open");
    return shown("seat", "open");
  }

  if (!open) {
    throw new Error(
      "The maker has no open seat. Run it with SEAT=open first. Nothing was sent.",
    );
  }
  const { decimals } = await getMint(on.solana, token.mint);
  const atoms = fundingAtoms(request.tokens, decimals);

  if (request.command === "deposit") {
    const signature = await depositedAsCollateral(
      on,
      deposits,
      maker,
      maker.publicKey,
      token,
      atoms,
      seatDepositFailure,
    );
    shown("deposited", `${request.tokens} USDC (${atoms} atoms) as collateral`);
    return shown("signature", signature);
  }

  const unpayable = withdrawRefusal(atoms, held);
  if (unpayable) throw new Error(unpayable);
  if (held === "unreadable") {
    console.error(
      "What custody holds is not readable here, so the check that custody can pay this out is skipped: the simulation below and the program refuse a withdrawal custody cannot pay.",
    );
  }
  const withdrawal = on.instructions.withdraw(
    maker.publicKey,
    account,
    token,
    { collateral: true },
    atoms,
    await perpMarketIds(on),
  );
  const failed = await simulatedError(deposits, [withdrawal], maker).catch(
    (error: Error) => {
      throw new Error(
        `The endpoint did not simulate the withdrawal (${error.message.split("\n")[0]}), so it is not sent. Nothing was sent.`,
      );
    },
  );
  if (failed !== null) {
    throw new Error(
      `The withdrawal would fail with ${failed}, so it is not sent: the seat may hold less than that free of margin, or the market may refuse withdrawals now. Nothing was sent.`,
    );
  }
  const signature = await send(deposits, withdrawal, maker);
  shown("withdrawn", `${request.tokens} USDC (${atoms} atoms) from collateral`);
  shown("signature", signature);
  shown(
    "USDC in the rollup",
    `${await tokenBalance(deposits, account)} atoms in the maker's own balance`,
  );
});

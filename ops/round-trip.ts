/**
 * Proves the way out of the exchange with dust:
 *
 *   KEYFILE=<the owner's key file> [AMOUNT=<tokens, 0.01 by default>]
 *
 * Moves AMOUNT of the owner's quote token on Solana into the rollup and
 * deposits it as collateral to the owner's seat, then exits it with the exit
 * command's steps (the seat to the owner's token account in the rollup, and
 * on to Solana), and fails loudly unless the owner ends with at least what it
 * started with on Solana. It takes 2 tokens at the most. The seat must be
 * open already, the tokens must be in the owner's account on Solana with a
 * little SOL for the moves. On a test network the admin key mints the tokens
 * the owner lacks, as the fund command does; on mainnet nothing is minted.
 *
 * METHOD=shuttle|undelegate picks how the tokens leave the rollup, as in the
 * exit command. The Makefile is the way in (`make rehearsal-round-trip`,
 * `make mainnet-round-trip`).
 */
import { existsSync } from "fs";
import { adminKeyPath, run } from "./deployment";
import {
  ROUND_TRIP_LAMPORTS,
  roundTripDepositFailure,
  roundTripLoss,
  roundTripRefusal,
  roundTripRequest,
  tokenAtoms,
} from "./exiting";
import {
  exitedToSolana,
  leavingAs,
  ownerAt,
  seatIsOpen,
  shown,
} from "./leaving";
import { heldKey } from "./keys";
import { retried, send } from "./sending";
import { heldInRollup, tokenBalance } from "./tokens";

run(async (on) => {
  const request = roundTripRequest(process.env);
  const owner = ownerAt(request.keyFile);
  const leaving = await leavingAs(on, owner, ROUND_TRIP_LAMPORTS);
  const { token, decimals, account, rollup } = leaving;
  const atoms = tokenAtoms(request.amount, decimals);
  const tooMuch = roundTripRefusal(atoms, decimals);
  if (tooMuch) throw new Error(tooMuch);
  if (!(await seatIsOpen(leaving))) {
    throw new Error(
      `${owner.publicKey.toBase58()} has no open seat on this exchange. The gate opens a seat; then run this again. Nothing was sent.`,
    );
  }
  shown("network", `${on.network}, program ${on.instructions.programId}`);
  shown("owner", owner.publicKey.toBase58());
  shown("round trip", `${atoms} atoms by ${request.method}`);
  const start = await retried(() => tokenBalance(on.solana, account));
  shown("USDC on Solana", `${start} atoms at the start`);

  const adminKey = adminKeyPath(on);
  const payer = !on.mainnet && existsSync(adminKey) ? heldKey(adminKey) : owner;
  await heldInRollup(
    on.solana,
    rollup,
    owner,
    token.mint,
    atoms,
    on.validator,
    token.custodyVisibility,
    payer,
  );
  shown(
    "deposit signature",
    await send(
      rollup,
      on.instructions.deposit(
        owner.publicKey,
        account,
        token,
        owner.publicKey,
        { collateral: true },
        atoms,
      ),
      owner,
    ).catch((error: Error) => {
      throw roundTripDepositFailure(error.message, owner.publicKey);
    }),
  );

  await exitedToSolana(leaving, atoms, request.method, "seat");
  const end = await retried(() => tokenBalance(on.solana, account));
  shown("USDC on Solana", `${start} atoms at the start, ${end} at the end`);
  const lost = roundTripLoss(start, end);
  if (lost) throw new Error(lost);
  shown(
    "round trip",
    "proved: the tokens went into the seat and came back to Solana",
  );
});

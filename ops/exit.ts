/**
 * The exit back to Solana for one seat's owner:
 *
 *   KEYFILE=<the owner's key file> AMOUNT=<tokens, such as 5 or 0.25>
 *
 * Withdraws AMOUNT of the seat's collateral into the owner's token account in
 * the rollup, which is where the program's withdrawal stops, then sends it on
 * to the owner's token account on Solana, and prints the Solana balance
 * before and after and every signature. It stops loudly if the Solana balance
 * did not rise by what was sent back. The owner's key signs everything, so it
 * works for any seat whose key this machine holds, such as the house maker's;
 * no key of the exchange can exit a seat for its owner.
 *
 *   METHOD=shuttle|undelegate  how the tokens leave the rollup. shuttle, the
 *                              default, is the token program's own withdrawal
 *                              and carries exactly AMOUNT. undelegate is its
 *                              older two steps and sends the owner's whole
 *                              balance in the rollup, not only AMOUNT.
 *   FROM=seat|rollup           rollup skips the seat's withdrawal, for tokens
 *                              already in the owner's balance in the rollup,
 *                              as after a run whose second step failed.
 *
 * The Makefile is the way in (`make rehearsal-exit`, `make mainnet-exit`).
 */
import { exitRequest, tokenAtoms } from "./exiting";
import { run } from "./deployment";
import { exitedToSolana, leavingAs, ownerAt, shown } from "./leaving";

run(async (on) => {
  const request = exitRequest(process.env);
  const owner = ownerAt(request.keyFile);
  const leaving = await leavingAs(on, owner);
  const atoms = tokenAtoms(request.amount, leaving.decimals);

  shown("network", `${on.network}, program ${on.instructions.programId}`);
  shown("owner", owner.publicKey.toBase58());
  shown(
    "exit",
    `${atoms} atoms by ${request.method}, from the ${request.from}`,
  );
  const exited = await exitedToSolana(
    leaving,
    atoms,
    request.method,
    request.from,
  );
  shown(
    "back on Solana",
    `${exited.moved} atoms: ${exited.before} before, ${exited.after} after`,
  );
});

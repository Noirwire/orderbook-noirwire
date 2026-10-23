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
 * no key of the exchange can exit a seat for its owner. The rollup charges no
 * fee but Solana does: the owner pays there when it holds SOL, and on a test
 * network the admin key pays when it does not.
 *
 * Every send is written down in the keys folder before it is broadcast
 * (`<network>-exit-<owner>.json`: the amount, the step and the signature of
 * each transaction signed for Solana), and a run reconciles that record against
 * Solana and the rollup before it builds anything, so a response lost on the
 * way never leads to a second withdrawal for the same exit. A run that stops
 * part way is finished by running it again with the same KEYFILE, AMOUNT and
 * METHOD: it finds what landed and sends only what is left. A send whose
 * outcome cannot be shown asks for EXIT_SENT=landed:<id> or lost:<id> after
 * the operator has looked. Keep the same AMOUNT: a different one is refused
 * while an unfinished exit is recorded.
 *
 *   METHOD=shuttle|undelegate  how the tokens leave the rollup. shuttle, the
 *                              default, is the token program's own withdrawal
 *                              and carries exactly AMOUNT. undelegate is its
 *                              older two steps and sends the owner's whole
 *                              balance in the rollup, not only AMOUNT.
 *   FROM=seat|rollup           rollup skips the seat's withdrawal, for tokens
 *                              already in the owner's balance in the rollup,
 *                              as after a run whose second step failed. A
 *                              plain re-run of FROM=seat does the same on its
 *                              own where the record shows the seat's
 *                              withdrawal landed.
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

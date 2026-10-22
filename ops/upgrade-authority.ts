/**
 * Moves the program's upgrade authority to a multisig, MULTISIG=<its vault
 * address>. It sends nothing: the upgrade authority signs on Solana, so the
 * exact `solana` command is printed for the operator to run, and the command
 * then reads who the upgrade authority is. Run it again after the `solana`
 * command to check the move.
 *
 * The Makefile is the way in (`make rehearsal-upgrade-authority`,
 * `make mainnet-upgrade-authority`).
 */
import { existsSync } from "fs";
import { ownerKey } from "../sdk/dist/operator/index.js";
import { adminKeyPath, rollupIsRunBy, run } from "./deployment";
import {
  upgradeAuthorityCheck,
  upgradeAuthorityCommand,
  upgradeAuthorityNotes,
  upgradeAuthorityRefusal,
} from "./handover";
import { heldKey } from "./keys";
import { exchangeInRollup } from "./market";
import { deployedProgram } from "./program";

const shown = (label: string, value: string) =>
  console.log(`${label.padEnd(20)}${value}`);

run(async (on) => {
  const authority = ownerKey("MULTISIG", process.env.MULTISIG);
  const { upgradeAuthority } = await deployedProgram(on);
  await rollupIsRunBy(on);
  const { admin } = await exchangeInRollup(on);
  const check = upgradeAuthorityCheck(upgradeAuthority, authority);
  if (!check.moved) {
    const refusal = upgradeAuthorityRefusal(authority, upgradeAuthority, admin);
    if (refusal) throw new Error(refusal);
  }

  shown("network", `${on.network}, program ${on.instructions.programId}`);
  shown("upgrade authority", upgradeAuthority?.toBase58() ?? "none");
  shown("exchange admin", admin.toBase58());
  shown("multisig", authority.toBase58());
  if (!check.moved && upgradeAuthority) {
    const kept = adminKeyPath(on);
    const keyFile =
      existsSync(kept) && heldKey(kept).publicKey.equals(upgradeAuthority)
        ? kept
        : `<key file of ${upgradeAuthority.toBase58()}>`;
    console.log(
      "\nThis command sends nothing. Run this yourself, signed by the current upgrade authority:\n",
    );
    console.log(
      `  ${upgradeAuthorityCommand({
        programId: on.instructions.programId,
        authority,
        keyFile,
        url: on.publicSolanaUrl,
      })}\n`,
    );
  }
  for (const note of upgradeAuthorityNotes(authority)) {
    console.log(`Note: ${note}`);
  }
  console.log(`\n${check.line}`);
});

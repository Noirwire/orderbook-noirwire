/**
 * Moves the program's upgrade authority to a multisig, MULTISIG=<its vault
 * address>. It sends nothing: the upgrade authority signs on Solana, so the
 * exact `solana` command is printed for the operator to run, and the command
 * then reads who the upgrade authority is. Run it again after the `solana`
 * command to check the move. An address on the curve is refused, since a
 * multisig's vault never is: it is almost certainly a signer's key or a typo,
 * and the printed command skips the new authority's signer check. Only
 * MULTISIG_IS_A_KEY=yes allows it, and then the printed command keeps the
 * signer check and names the new key's file, so the key must co-sign. The address is printed on a line of its
 * own to compare with the multisig's app.
 *
 * The Makefile is the way in (`make rehearsal-upgrade-authority`,
 * `make mainnet-upgrade-authority`).
 */
import { existsSync } from "fs";
import { PublicKey } from "@solana/web3.js";
import { ownerKey } from "../sdk/dist/operator/index.js";
import { adminKeyPath, rollupIsRunBy, run } from "./deployment";
import {
  upgradeAuthorityCheck,
  upgradeAuthorityCheckLine,
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
    const refusal = upgradeAuthorityRefusal(
      authority,
      upgradeAuthority,
      admin,
      process.env.MULTISIG_IS_A_KEY === "yes",
    );
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
    console.log(`\n${upgradeAuthorityCheckLine(authority)}`);
    console.log(
      "This command sends nothing. Run this yourself, signed by the current upgrade authority:\n",
    );
    console.log(
      `  ${upgradeAuthorityCommand({
        programId: on.instructions.programId,
        authority,
        keyFile,
        url: on.publicSolanaUrl,
        newKeyFile:
          process.env.MULTISIG_IS_A_KEY === "yes" &&
          PublicKey.isOnCurve(authority.toBytes())
            ? `<key file of ${authority.toBase58()}, which co-signs>`
            : undefined,
      })}\n`,
    );
  }
  for (const note of upgradeAuthorityNotes(authority)) {
    console.log(`Note: ${note}`);
  }
  console.log(`\n${check.line}`);
});

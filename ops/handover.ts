/**
 * What the handover commands decide, apart from the network so it can be
 * checked without one: who may be nominated as the admin, what the nominee
 * does next, and the command that moves the program's upgrade authority to a
 * multisig.
 */
import { PublicKey } from "@solana/web3.js";

/** Whether a key can sign: an address off the curve, such as a multisig's vault, cannot. */
const signs = (key: PublicKey) => PublicKey.isOnCurve(key.toBytes());

/**
 * Why `nominee` cannot be proposed as the admin, or null. The admin signs
 * every instruction with a key inside the rollup, so the nominee must be a key
 * that signs, and must be neither the admin already nor the upgrade authority
 * (SECURITY.md keeps those two apart).
 */
export function nominationRefusal(
  nominee: PublicKey,
  admin: PublicKey,
  upgradeAuthority: PublicKey | null,
): string | null {
  if (nominee.equals(admin)) {
    return `NEW_ADMIN ${nominee.toBase58()} is the admin already. Nothing was sent.`;
  }
  if (upgradeAuthority?.equals(nominee)) {
    return `NEW_ADMIN ${nominee.toBase58()} is the program's upgrade authority, and the admin and the upgrade authority are never one key with real money. Name the key of the hardware wallet instead. Nothing was sent.`;
  }
  if (!signs(nominee)) {
    return `NEW_ADMIN ${nominee.toBase58()} is not a key anyone signs with (it is the address of a program, such as a multisig's vault), and the admin signs every instruction with its own key, so it could never accept the role. Name the key of the hardware wallet. Nothing was sent.`;
  }
  return null;
}

/** What the nominee does to take the role, which is the console's job: the disk key only proposes. */
export function acceptSteps(
  nominee: PublicKey,
  network: string,
  pending: boolean,
): string[] {
  return [
    pending
      ? `${nominee.toBase58()} is already the pending admin. Nothing was sent.`
      : `${nominee.toBase58()} is now the pending admin. The admin stays as it was until that key accepts.`,
    "Next, to take the role:",
    `  1. Check ${nominee.toBase58()} with the person who holds that wallet, through a second channel, not this terminal.`,
    "  2. In the admin console, connect the wallet that holds it and open the admin actions.",
    "  3. Choose Accept admin and check the decoded instruction (accept_admin on this exchange) on the device before signing.",
    `  4. Run make ${network}-status and check that the admin is ${nominee.toBase58()} and no admin is pending.`,
    "From then on the admin key on this machine can no longer send as admin: the console is the admin.",
  ];
}

/**
 * Why `authority` cannot be named as the new upgrade authority, or null. The
 * command printed for it tells `solana` not to ask the new authority to sign,
 * so a typo would move the program to an address nobody can sign for. A
 * multisig's vault is the address of a program, off the curve, so an address
 * on the curve is almost certainly a member's key or a slip, and is refused
 * unless `keyAllowed` (`MULTISIG_IS_A_KEY=yes`) says it is meant.
 */
export function upgradeAuthorityRefusal(
  authority: PublicKey,
  current: PublicKey | null,
  admin: PublicKey,
  keyAllowed = false,
): string | null {
  if (current === null) {
    return "The program has no upgrade authority, so it is final and cannot be moved. Nothing was sent.";
  }
  if (authority.equals(admin)) {
    return `MULTISIG ${authority.toBase58()} is the exchange's admin, and the admin and the upgrade authority are never one key with real money. Nothing was sent.`;
  }
  if (signs(authority) && !keyAllowed) {
    return (
      `MULTISIG ${authority.toBase58()} is the address of an ordinary key, and a multisig's vault never is: it is a program's address, off the curve. ` +
      "This is almost certainly a signer's own key or a mistyped address, and the command to be printed does not ask the new authority to sign, so the program would move to a key nobody has checked. " +
      "Copy the vault address from the multisig's own app. If a plain key really is meant, run again with MULTISIG_IS_A_KEY=yes. Nothing was sent."
    );
  }
  return null;
}

/**
 * The address to check by eye, apart from the rest of the output, before the
 * printed command is run: with the signer check skipped, nothing but the
 * operator's own comparison with the multisig's app catches a wrong address.
 */
export function upgradeAuthorityCheckLine(authority: PublicKey): string {
  return (
    "Before you run it, compare this address, character by character, with the vault address in the multisig's own app, through a second channel and not this terminal:\n\n" +
    `  ${authority.toBase58()}\n`
  );
}

/**
 * The `solana` command that moves the upgrade authority of `programId` to
 * `authority`, signed by the key file of the current one. The new authority
 * is a multisig's vault, an address that cannot sign, so the command has to
 * be told not to ask it to. When the new authority is a plain key
 * (`newKeyFile` given), the command names that key's file instead and keeps
 * the signer check, so the key co-signs and a mistyped address cannot pass:
 * the CLI takes the new authority from the file it is given.
 */
export function upgradeAuthorityCommand(set: {
  programId: PublicKey;
  authority: PublicKey;
  keyFile: string;
  url: string;
  newKeyFile?: string;
}): string {
  return [
    "solana program set-upgrade-authority",
    set.programId.toBase58(),
    set.newKeyFile
      ? `--new-upgrade-authority ${set.newKeyFile}`
      : `--new-upgrade-authority ${set.authority.toBase58()}`,
    ...(set.newKeyFile ? [] : ["--skip-new-upgrade-authority-signer-check"]),
    `--upgrade-authority ${set.keyFile}`,
    `--keypair ${set.keyFile}`,
    `--url ${set.url}`,
  ].join(" ");
}

/** Notes on the multisig address worth reading before the command is run. */
export function upgradeAuthorityNotes(authority: PublicKey): string[] {
  const notes = [
    "Use the multisig's vault address, the one that holds its funds, not the address of the multisig account itself.",
    "Check that multisig's signers and threshold in its own program before the market is resumed: nothing on chain shows them to this tool.",
  ];
  return signs(authority)
    ? [
        `${authority.toBase58()} is the address of an ordinary key, not of a program: a multisig's vault never is. Check you copied the vault and not a member's key.`,
        ...notes,
      ]
    : notes;
}

export type UpgradeAuthorityCheck = { moved: boolean; line: string };

/** Whether the upgrade authority `found` on chain is the `wanted` one, and what to tell the operator. */
export function upgradeAuthorityCheck(
  found: PublicKey | null,
  wanted: PublicKey,
): UpgradeAuthorityCheck {
  if (found?.equals(wanted)) {
    return {
      moved: true,
      line: `The program's upgrade authority is ${wanted.toBase58()}, as asked.`,
    };
  }
  return {
    moved: false,
    line: found
      ? `The program's upgrade authority is still ${found.toBase58()}, not ${wanted.toBase58()}. Run the command above, then run this again.`
      : "The program has no upgrade authority: it is final and cannot be upgraded or moved again. That is not what this command sets.",
  };
}

/** The refusal to sign as an admin the exchange no longer has, or null; after a handover the console is the admin. */
export function adminRefusal(
  exchangeAdmin: PublicKey,
  key: PublicKey,
  keyFile: string,
): string | null {
  if (exchangeAdmin.equals(key)) return null;
  return `The exchange's admin is ${exchangeAdmin.toBase58()}, not ${key.toBase58()} (${keyFile}). If the role was handed over, the admin console is the admin now and this command cannot send as it. Nothing was sent.`;
}

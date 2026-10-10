import { expect } from "chai";
import {
  Keypair,
  type Connection,
  type PublicKey,
  type TransactionInstruction,
} from "@solana/web3.js";
import { admin, instructions, send } from "../support";
import { exchangeOn, refuses, stranger } from "./world";

const unsignedBy = (instruction: TransactionInstruction, key: PublicKey) => {
  instruction.keys = instruction.keys.map((meta) =>
    meta.pubkey.equals(key) ? { ...meta, isSigner: false } : meta,
  );
  return instruction;
};

/**
 * The two-step hand-over of the admin role, which holds on Solana and inside
 * the rollup alike. `powers` are instructions only the admin may send there.
 */
export function handsOverItsAdminRole(
  connection: Connection,
  powers: (by: PublicKey) => TransactionInstruction[],
) {
  const heir = Keypair.generate();
  const adminIs = async (key: Keypair) =>
    expect((await exchangeOn(connection)).admin.equals(key.publicKey)).to.equal(
      true,
    );

  it("offers its admin role only through its admin, and gives it only to a nominee who signs", async () => {
    await refuses(
      send(
        connection,
        instructions.proposeAdmin(stranger.publicKey, stranger.publicKey),
        stranger,
      ),
      "NotAdmin",
    );
    await send(
      connection,
      instructions.proposeAdmin(admin.publicKey, heir.publicKey),
      admin,
    );
    await refuses(
      send(connection, instructions.acceptAdmin(stranger.publicKey), stranger),
      "NotNominee",
    );
    await refuses(
      send(
        connection,
        unsignedBy(instructions.acceptAdmin(heir.publicKey), heir.publicKey),
        stranger,
      ),
      "AccountNotSigner",
    );
    await adminIs(admin);
  });

  it("leaves the old admin no power once the nominee accepts, and the new admin can hand it back", async () => {
    await send(connection, instructions.acceptAdmin(heir.publicKey), stranger, [
      heir,
    ]);
    await adminIs(heir);
    expect((await exchangeOn(connection)).pendingAdmin).to.equal(null);
    for (const power of powers(admin.publicKey)) {
      await refuses(send(connection, power, admin), "NotAdmin");
    }
    await send(
      connection,
      instructions.proposeAdmin(heir.publicKey, admin.publicKey),
      stranger,
      [heir],
    );
    await send(connection, instructions.acceptAdmin(admin.publicKey), admin);
    await adminIs(admin);
  });
}

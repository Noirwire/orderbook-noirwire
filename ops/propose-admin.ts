/**
 * Starts the admin handover (RULES 3): the admin names a new admin with
 * `propose_admin`, NEW_ADMIN=<public key>, and the exchange records it as
 * pending. The nominee takes the role with `accept_admin`, which only its own
 * key can sign, from the admin console, so the new admin's key never has to
 * touch this machine. Until it accepts, the admin is unchanged.
 *
 * The Makefile is the way in (`make rehearsal-propose-admin`,
 * `make mainnet-propose-admin`).
 */
import { ownerKey } from "../sdk/dist/operator/index.js";
import { adminKeyPath, rollupIsRunBy, run, sendingAs } from "./deployment";
import { acceptSteps, adminRefusal, nominationRefusal } from "./handover";
import { heldKey } from "./keys";
import { shown } from "./leaving";
import { exchangeInRollup } from "./market";
import { deployedAsBuilt } from "./program";
import { send, until } from "./sending";

run(async (on) => {
  const nominee = ownerKey("NEW_ADMIN", process.env.NEW_ADMIN);
  const keyFile = adminKeyPath(on);
  const admin = heldKey(keyFile);
  const { upgradeAuthority } = await deployedAsBuilt(on);
  await rollupIsRunBy(on);
  const exchange = await exchangeInRollup(on);
  const wrongAdmin = adminRefusal(exchange.admin, admin.publicKey, keyFile);
  if (wrongAdmin) throw new Error(wrongAdmin);
  const refusal = nominationRefusal(nominee, exchange.admin, upgradeAuthority);
  if (refusal) throw new Error(refusal);

  shown("network", `${on.network}, program ${on.instructions.programId}`);
  shown("admin", exchange.admin.toBase58());
  shown("new admin", nominee.toBase58());
  const pending = exchange.pendingAdmin?.equals(nominee) ?? false;
  if (!pending) {
    shown(
      "signature",
      await send(
        await sendingAs(on, admin),
        on.instructions.proposeAdmin(admin.publicKey, nominee),
        admin,
      ),
    );
    await until(
      async () =>
        (await exchangeInRollup(on)).pendingAdmin?.equals(nominee) ?? false,
      "the exchange to read back the pending admin",
    );
  }
  for (const line of acceptSteps(nominee, on.network, pending)) {
    console.log(line);
  }
});

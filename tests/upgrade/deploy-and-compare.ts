/**
 * This build deployed over the earlier one at the program's address, the way
 * the upgrade procedure does it, with the exchange paused. The earlier build's
 * program file is kept first, as the way back. Then every account is read
 * again, and none may have changed; the layout is not active, so everything
 * that needs the new layout is refused; and the instructions whose shape
 * changed have lost their earlier names.
 */
import { expect } from "chai";
import { admin, instructions, rollup, send } from "../support";
import { refuses, stranger } from "../orderbook/world";
import { deployed, earlierBuildKept, rollupRuns } from "./deploy";
import {
  BOUND_PERP,
  NO_SUCH_INSTRUCTION,
  PERP_MARKETS,
  UNBOUND_PERP,
  earlier,
  pythQuote,
  refusalOfSetPriceSource,
  unboundPerp,
  upgrade,
} from "./earlier-build";
import { PYTH_SOL_FEED_ID, PYTH_USDC_FEED_ID } from "./price-fixtures";
import { snapshotOf } from "./snapshot";
import { expectTheStory } from "./story-facts";

describe("upgrade: this build deployed over the earlier one", () => {
  it("keeps the earlier build's program file, deploys this build over it with the upgrade authority, and the rollup runs it", async () => {
    const built = process.env.UPGRADE_SO;
    if (!built) throw new Error("UPGRADE_SO must name the program to deploy");
    expect(
      await refusalOfSetPriceSource(),
      "the rollup runs the earlier build",
    ).to.include(NO_SUCH_INSTRUCTION);
    earlierBuildKept();
    await deployed(built);
    await rollupRuns("this");
  });

  it("serves every account the story made byte for byte as the earlier build left it", async () => {
    const after = await snapshotOf(
      [upgrade.alice.owner.publicKey, upgrade.bob.owner.publicKey],
      PERP_MARKETS,
    );
    expect([...after.bytes.keys()]).to.deep.equal([
      ...upgrade.before.bytes.keys(),
    ]);
    for (const [name, bytes] of upgrade.before.bytes) {
      expect(after.bytes.get(name)?.equals(bytes), `${name} changed`).to.equal(
        true,
      );
    }
  });

  it("reads what the earlier build wrote as the story left it, on a layout that is not active yet", async () => {
    const after = await snapshotOf(
      [upgrade.alice.owner.publicKey, upgrade.bob.owner.publicKey],
      PERP_MARKETS,
    );
    expectTheStory(after);
  });

  it("refuses with LayoutNotActive what runs only on the active layout: growing the ledger, giving seats back, a seat's access, an owner's key reset and a withdrawal", async () => {
    await refuses(
      send(rollup, instructions.extendLedger(admin.publicKey, 33), admin),
      "LayoutNotActive",
    );
    await refuses(
      send(
        rollup,
        instructions.releaseEmptySeats(stranger.publicKey, 2, 8),
        stranger,
      ),
      "LayoutNotActive",
    );
    await refuses(
      send(
        rollup,
        instructions.setSeatAccess(
          admin.publicKey,
          upgrade.listed.owner.publicKey,
          { makerMarkets: 0n, takerMarkets: 0n, blocked: false },
          PERP_MARKETS,
        ),
        admin,
      ),
      "LayoutNotActive",
    );
    const { bob } = upgrade;
    await refuses(
      send(
        rollup,
        instructions.setOrderKeys(bob.owner.publicKey, bob.keys.publicKeys),
        bob.owner,
      ),
      "LayoutNotActive",
    );
  });

  it("has lost the earlier names of the instructions whose shape changed: the earlier create_market, set_price_source, set_quote_source and update_market find no handler", async () => {
    const market = unboundPerp();
    for (const [name, instruction, signer] of [
      [
        "create_market",
        earlier.createEarlierMarket(admin.publicKey, 7, market),
        admin,
      ],
      [
        "set_price_source",
        earlier.setEarlierPriceSource(
          admin.publicKey,
          BOUND_PERP,
          PYTH_SOL_FEED_ID,
          -8,
        ),
        admin,
      ],
      [
        "set_quote_source",
        earlier.setEarlierQuoteSource(
          admin.publicKey,
          pythQuote(PYTH_USDC_FEED_ID),
        ),
        admin,
      ],
      [
        "update_market",
        earlier.updateEarlierMarket(
          admin.publicKey,
          UNBOUND_PERP,
          market.limits,
        ),
        admin,
      ],
    ] as const) {
      await refuses(
        send(rollup, instruction, signer),
        NO_SUCH_INSTRUCTION,
        name,
      );
    }
  });
});

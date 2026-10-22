/**
 * Audit, custody area. `collect_fees` into the custody account itself. The
 * engine would debit the fee seat, the program would sign an SPL transfer
 * from custody to custody, and SPL Token accepts a transfer whose source and
 * destination are the same account and moves nothing (spl-token 4.0.0,
 * `process_transfer`, the `self_transfer` branch). Custody would then hold
 * more than the seats sum to, for good: no instruction pays out a balance no
 * seat holds. The program refuses a custody account as the destination.
 *
 * Can run anywhere after `./orderbook/reserved-seats`; it changes nothing.
 */
import { expect } from "chai";
import { FEE_SEAT } from "../../sdk/dist/index.js";
import {
  addresses,
  admin,
  balanceOf,
  instructions,
  ledgerThroughThePort,
  rollup,
  send,
} from "../support";
import {
  NUSD,
  PERP,
  custodyMatchesLedger,
  custodyOf,
  mints,
  refuses,
} from "../orderbook/world";

describe("audit: fees collected into custody itself", () => {
  it("refuses the payout, so the fee seat and custody keep to RULES 13.1", async () => {
    await custodyMatchesLedger();
    const fees = (await ledgerThroughThePort()).seats[FEE_SEAT];
    const token = custodyOf(mints.nUSD);
    const custody = addresses.custody(token);
    const before = await balanceOf(custody);

    for (const asset of [{ spot: NUSD }, { collateral: true }] as const) {
      await refuses(
        send(
          rollup,
          instructions.collectFees(admin.publicKey, custody, token, asset, 1n, [
            PERP,
          ]),
          admin,
        ),
        "PayoutIntoCustody",
      );
    }

    expect((await ledgerThroughThePort()).seats[FEE_SEAT]).to.deep.equal(fees);
    expect(await balanceOf(custody), "custody did not move").to.equal(before);
    await custodyMatchesLedger();
  });
});

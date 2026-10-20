/**
 * Audit, custody area. `collect_fees` accepts the custody account itself as
 * the destination. The engine debits the fee seat, the program signs an SPL
 * transfer from custody to custody, and SPL Token accepts a transfer whose
 * source and destination are the same account and moves nothing (spl-token
 * 4.0.0, `process_transfer`, the `self_transfer` branch). Custody then holds
 * more than the seats sum to, for good: no instruction pays out a balance no
 * seat holds.
 *
 * Run it LAST in `orderbook.test.ts`, after `./orderbook/latency`: it leaves
 * custody one atom (or more) above the ledger, so every later
 * `custodyMatchesLedger` would fail.
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
  mints,
  refuses,
} from "../orderbook/world";

describe("audit: fees collected into custody itself", () => {
  it("debits the fee seat while custody keeps the tokens, breaking RULES 13.1", async function () {
    await custodyMatchesLedger();
    const fees = (await ledgerThroughThePort()).seats[FEE_SEAT];
    const asset =
      fees.spot[NUSD].available > 0n
        ? ({ spot: NUSD } as const)
        : fees.collateral > 0n
          ? ({ collateral: true } as const)
          : null;
    if (asset === null) this.skip();
    const custody = addresses.custody(mints.nUSD);
    const before = await balanceOf(custody);

    await send(
      rollup,
      instructions.collectFees(
        admin.publicKey,
        custody,
        mints.nUSD,
        asset!,
        1n,
        [PERP],
      ),
      admin,
    );

    const after = (await ledgerThroughThePort()).seats[FEE_SEAT];
    const debited =
      "spot" in asset!
        ? fees.spot[NUSD].available - after.spot[NUSD].available
        : fees.collateral - after.collateral;
    expect(debited, "the fee seat was debited").to.equal(1n);
    expect(await balanceOf(custody), "custody did not move").to.equal(before);
    await refuses(custodyMatchesLedger(), "custody of token 0");
  });
});

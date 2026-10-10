import { expect } from "chai";
import type { Keypair, PublicKey } from "@solana/web3.js";
import { FEE_SEAT, INSURANCE_SEAT } from "../../sdk/dist/index.js";
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
  cast,
  custodyMatchesLedger,
  funded,
  mints,
  refuses,
  stranger,
  tokenAccount,
} from "./world";

describe("the fee seat and the insurance seat", () => {
  it("pay out fees only to the admin, from custody, and move perp fees to insurance", async () => {
    const to = tokenAccount(cast.carol, mints.nUSD);
    const fees = (await ledgerThroughThePort()).seats[FEE_SEAT];
    const collect = (by: Keypair, amount: bigint) =>
      send(
        rollup,
        instructions.collectFees(
          by.publicKey,
          to,
          mints.nUSD,
          { spot: NUSD },
          amount,
        ),
        by,
      );
    await refuses(collect(stranger, 1n), "NotAdmin");
    await refuses(
      collect(admin, fees.spot[NUSD].available + 1n),
      "InsufficientBalance",
    );
    const before = await balanceOf(to);
    await collect(admin, fees.spot[NUSD].available);
    expect((await balanceOf(to)) - before).to.equal(fees.spot[NUSD].available);
    expect(fees.spot[NUSD].available > 0n).to.equal(true);

    await refuses(
      send(
        rollup,
        instructions.moveFeesToInsurance(stranger.publicKey, 1n),
        stranger,
      ),
      "NotAdmin",
    );
    await send(
      rollup,
      instructions.moveFeesToInsurance(admin.publicKey, fees.collateral),
      admin,
    );
    const ledger = await ledgerThroughThePort();
    expect(ledger.seats[FEE_SEAT].collateral).to.equal(0n);
    expect(ledger.seats[INSURANCE_SEAT].collateral).to.equal(fees.collateral);
    expect(fees.collateral > 0n).to.equal(true);
    await custodyMatchesLedger();
  });

  it("take insurance funding only from the admin, out of the admin's own token account into custody", async () => {
    const amount = 1_000n;
    const from = await funded(admin, mints.nUSD, amount);
    const fund = (by: Keypair, source: PublicKey) =>
      send(
        rollup,
        instructions.fundInsurance(by.publicKey, source, mints.nUSD, amount),
        by,
      );
    await refuses(fund(stranger, from), "NotAdmin");
    await refuses(
      fund(admin, tokenAccount(cast.carol, mints.nUSD)),
      "WrongTokenAccountOwner",
    );
    const before = await ledgerThroughThePort();
    const custody = await balanceOf(addresses.custody(mints.nUSD));
    await fund(admin, from);
    const after = await ledgerThroughThePort();
    expect(
      after.seats[INSURANCE_SEAT].collateral -
        before.seats[INSURANCE_SEAT].collateral,
    ).to.equal(amount);
    expect((await balanceOf(addresses.custody(mints.nUSD))) - custody).to.equal(
      amount,
    );
    expect(await balanceOf(from)).to.equal(0n);
    await custodyMatchesLedger();
  });

  it("cover a shortfall for anyone who asks, and change nothing for a seat that owes nothing", async () => {
    const { bob } = cast;
    const before = await ledgerThroughThePort();
    await send(rollup, instructions.coverShortfall(PERP, bob.seat), stranger);
    const after = await ledgerThroughThePort();
    expect(after.seats[bob.seat]).to.deep.equal(before.seats[bob.seat]);
    expect(after.seats[INSURANCE_SEAT]).to.deep.equal(
      before.seats[INSURANCE_SEAT],
    );
    await custodyMatchesLedger();
  });
});

import { expect } from "chai";
import { Keypair, type TransactionInstruction } from "@solana/web3.js";
import { MARKET_STATUS, ORDER_TYPE, SIDE } from "../../sdk/dist/index.js";
import { idl, instructions } from "../support";
import { limits, order, settings, spotMarket } from "./world";

const flags = (account: { isSigner?: boolean; isWritable?: boolean }) =>
  `${account.isSigner ? "s" : "-"}${account.isWritable ? "w" : "-"}`;

describe("the client's instruction builders", () => {
  it("name every account, in the program's order and with its flags, and carry the program's discriminator", () => {
    const key = Keypair.generate().publicKey;
    const keys = [1, 2, 3, 4].map(() => Keypair.generate().publicKey);
    const use = {
      orderKey: key,
      owner: key,
      expiresAt: 1n,
      replacement: key,
      clientOrderId: 1n,
      marketId: 1,
    };
    const sample = order(SIDE.bid, ORDER_TYPE.limit, 100n, 1n);
    const built: Record<string, TransactionInstruction> = {
      initialize_exchange: instructions.initializeExchange(key, settings()),
      update_exchange: instructions.updateExchange(key, settings()),
      set_paused: instructions.setPaused(key, true),
      propose_admin: instructions.proposeAdmin(key, null),
      accept_admin: instructions.acceptAdmin(key),
      register_token: instructions.registerToken(key, 0, key, "sealed"),
      delegate_exchange: instructions.delegateExchange(key, key),
      undelegate_exchange: instructions.undelegateExchange(key),
      withdraw_exchange: instructions.withdrawExchange(key, 1n),
      create_ledger: instructions.createLedger(key),
      finalize_ledger: instructions.finalizeLedger(key),
      create_market: instructions.createMarket(key, 1, spotMarket()),
      grow_account: instructions.growAccount(key, 0, 0, key, 1),
      finalize_market: instructions.finalizeMarket(key, 1),
      update_market: instructions.updateMarket(key, 1, limits()),
      open_trader: instructions.openTrader(key, key, keys),
      set_order_keys: instructions.setOrderKeys(key, keys),
      close_trader: instructions.closeTrader(key),
      deposit: instructions.deposit(key, key, key, key, { spot: 1 }, 1n),
      withdraw: instructions.withdraw(key, key, key, { collateral: true }, 1n),
      place_order: instructions.placeOrder(use, sample),
      cancel_order: instructions.cancelOrder(use, 1n),
      cancel_all: instructions.cancelAll(use, 1),
      sync_view: instructions.syncView(use),
      liquidate: instructions.liquidate(use, 1, 1n, 1n),
      publish_price: instructions.publishPrice(key, 1, 1n, 1n),
      reset_price: instructions.resetPrice(key, 1, 1n, 1n),
      update_funding: instructions.updateFunding(1),
      schedule_funding: instructions.scheduleFunding(key, 1, 1n, 1n, 1n),
      cover_shortfall: instructions.coverShortfall(1, 2),
      reconcile_shortfall: instructions.reconcileShortfall([]),
      transfer_between_balances: instructions.transferBetweenBalances(
        use,
        true,
        0,
        1n,
      ),
      resume_market: instructions.resumeMarket(key, 1),
      move_fees_to_insurance: instructions.moveFeesToInsurance(key, 1n),
      collect_fees: instructions.collectFees(key, key, key, { spot: 1 }, 1n),
      restrict_market: instructions.restrictMarket(
        key,
        1,
        MARKET_STATUS.paused,
      ),
      fund_insurance: instructions.fundInsurance(key, key, key, 1n),
      close_unused_trader: instructions.closeUnusedTrader(key, key),
    };
    // The rollup's delegation program calls `process_undelegation`; no client builds it.
    const declared = idl.instructions.filter(
      (instruction) => instruction.name !== "process_undelegation",
    );
    expect(Object.keys(built).sort()).to.deep.equal(
      declared.map((instruction) => instruction.name).sort(),
    );
    for (const instruction of declared) {
      const ours = built[instruction.name];
      expect(
        Array.from(ours.data.subarray(0, 8)),
        instruction.name,
      ).to.deep.equal(instruction.discriminator);
      expect(ours.keys.map(flags), instruction.name).to.deep.equal(
        instruction.accounts.map((account) =>
          flags({ isSigner: account.signer, isWritable: account.writable }),
        ),
      );
    }
  });
});

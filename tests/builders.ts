/**
 * One instruction of every kind the client builds, from fixed keys and
 * arguments, so their accounts and bytes can be compared with the program's
 * interface file and with a recorded snapshot. No network is involved.
 */
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import {
  Instructions,
  MARKET_KIND,
  MARKET_STATUS,
  ORDER_TYPE,
  SIDE,
  type MarketLimits,
} from "../sdk/dist/index.js";

const key = (fill: number) => new PublicKey(new Uint8Array(32).fill(fill));

const limits: MarketLimits = {
  minSize: 1n,
  minNotional: 1_000_000n,
  bandBps: 400,
  imBps: 1_000,
  mmBps: 500,
  takerFeeBps: 5,
  liqPenaltyBps: 100,
  fundingCapBps: 10,
  maxMoveBps: 250,
  maxOpenOrders: 32,
  maxPriceAge: 3_600n,
  fundingInterval: 2n,
  minPublishGap: 1,
  maxAgeLiquidation: 3_600n,
  openInterestCap: 1_000_000n,
  liqBufferBps: 100,
  liqInsuranceShareBps: 0,
  feeInsuranceShareBps: 0,
  settleWindow: 900n,
  positionCap: 200_000n,
};

/** Every instruction the client builds, by the program's name for it. */
export function builtInstructions(
  instructions: Instructions,
): Record<string, TransactionInstruction> {
  const admin = key(1);
  const other = key(2);
  const keys = [3, 4, 5, 6].map(key);
  const token = { mint: key(7), custodyNonce: 1n };
  const feedId = new Uint8Array(32).fill(14);
  const settings = {
    gate: key(8),
    oracle: key(9),
    maxSteps: 16,
    collateralToken: 0,
    maxSeatsPerDay: 1_000,
    minSeatDeposit: 0n,
  };
  const use = {
    orderKey: key(10),
    owner: key(11),
    expiresAt: 1n,
    replacement: key(12),
    clientOrderId: 1n,
    marketId: 1,
  };
  const spotMarket = {
    kind: MARKET_KIND.spot,
    baseSymbol: "NSOL",
    quoteSymbol: "NUSD",
    baseToken: 1,
    quoteToken: 0,
    tick: 100n,
    baseLot: 1_000_000n,
    capacity: 1024,
    limits,
    priceSource: {
      feedId,
      expo: -8,
      maxConfBps: 100,
      baseDecimals: 9,
      quoteDecimals: 6,
    },
  };
  const sample = {
    side: SIDE.bid,
    orderType: ORDER_TYPE.limit,
    price: 100n,
    size: 1n,
    secret: new Uint8Array(16).fill(13),
    reduceOnly: false,
    expiry: 0n,
  };
  return {
    initialize_exchange: instructions.initializeExchange(admin, settings),
    update_exchange: instructions.updateExchange(admin, settings),
    set_paused: instructions.setPaused(admin, true),
    propose_admin: instructions.proposeAdmin(admin, null),
    accept_admin: instructions.acceptAdmin(admin),
    register_token: instructions.registerToken(admin, 0, token, "sealed"),
    delegate_exchange: instructions.delegateExchange(admin, other),
    undelegate_exchange: instructions.undelegateExchange(admin),
    withdraw_exchange: instructions.withdrawExchange(admin, 1n),
    create_ledger: instructions.createLedger(admin),
    finalize_ledger: instructions.finalizeLedger(admin),
    create_market: instructions.createMarket(admin, 1, spotMarket),
    grow_account: instructions.growAccount(admin, 0, 0, other, 1),
    finalize_market: instructions.finalizeMarket(admin, 1),
    update_market: instructions.updateMarket(admin, 1, limits),
    open_trader: instructions.openTrader(admin, other, keys),
    open_trader_signed: instructions.openTraderSigned(admin, other, keys, 1n),
    set_order_keys: instructions.setOrderKeys(admin, keys),
    set_order_keys_signed: instructions.setOrderKeysSigned(admin, keys, 0, 1n),
    close_trader: instructions.closeTrader(admin),
    deposit: instructions.deposit(admin, other, token, other, { spot: 1 }, 1n),
    withdraw: instructions.withdraw(
      admin,
      other,
      token,
      { collateral: true },
      1n,
    ),
    withdraw_by_key: instructions.withdrawByKey(
      admin,
      other,
      key(12),
      1n,
      other,
      token,
      { collateral: true },
      1n,
    ),
    place_order: instructions.placeOrder(use, sample),
    cancel_order: instructions.cancelOrder(use, 1n),
    cancel_all: instructions.cancelAll(use, 1),
    sync_view: instructions.syncView(use),
    liquidate: instructions.liquidate(use, 1, 1n, 1n),
    extend_compute: instructions.extendCompute(),
    publish_price: instructions.publishPrice(admin, 1, 1n, 1n),
    reset_price: instructions.resetPrice(admin, 1, 1n, 1n),
    sync_price: instructions.syncPrice(1, other),
    sync_quote: instructions.syncQuote(other),
    set_price_source: instructions.setPriceSource(admin, 1, feedId, -8),
    set_quote_source: instructions.setQuoteSource(admin, {
      feedId,
      expo: -8,
      maxConfBps: 100,
      depegBps: 100,
      maxAge: 180n,
    }),
    update_funding: instructions.updateFunding(1),
    schedule_funding: instructions.scheduleFunding(admin, 1, 1n, 1n, 1n),
    cover_shortfall: instructions.coverShortfall(1, 2),
    reconcile_shortfall: instructions.reconcileShortfall([]),
    transfer_between_balances: instructions.transferBetweenBalances(
      use,
      true,
      0,
      1n,
    ),
    resume_market: instructions.resumeMarket(admin, 1, []),
    move_fees_to_insurance: instructions.moveFeesToInsurance(admin, 1n),
    collect_fees: instructions.collectFees(
      admin,
      other,
      token,
      { spot: 1 },
      1n,
      [],
    ),
    restrict_market: instructions.restrictMarket(
      admin,
      1,
      MARKET_STATUS.paused,
    ),
    fund_insurance: instructions.fundInsurance(admin, other, token, 1n),
    close_unused_trader: instructions.closeUnusedTrader(admin, other),
    set_market_access: instructions.setMarketAccess(admin, 1, {
      makersListed: true,
      takersListed: false,
    }),
    set_seat_access: instructions.setSeatAccess(
      admin,
      other,
      { makerMarkets: 2n, takerMarkets: 3n, blocked: true },
      [],
    ),
    extend_ledger: instructions.extendLedger(admin, 33),
    migrate_exchange: instructions.migrateExchange(admin),
    liquidate_range: instructions.liquidateRange(use, {
      start: 2,
      count: 256,
      size: 1n,
      worstPrice: 1n,
      maxTakeovers: 4,
    }),
    cover_shortfall_range: instructions.coverShortfallRange(1, 2, 256),
    release_empty_seats: instructions.releaseEmptySeats(admin, 2, 2048),
    create_relayout_ledger: instructions.createRelayoutLedger(admin),
    relayout_seats: instructions.relayoutSeats(admin, 256),
    finish_relayout: instructions.finishRelayout(admin),
  };
}

/** Each instruction's accounts, as `<address> <signer><writable>`, and its data in hex. */
export function snapshot(built: Record<string, TransactionInstruction>) {
  return Object.fromEntries(
    Object.entries(built).map(([name, instruction]) => [
      name,
      {
        keys: instruction.keys.map(
          (account) =>
            `${account.pubkey.toBase58()} ${account.isSigner ? "s" : "-"}${account.isWritable ? "w" : "-"}`,
        ),
        data: instruction.data.toString("hex"),
      },
    ]),
  );
}

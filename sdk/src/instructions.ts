import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  DELEGATION_PROGRAM_ID,
  EPHEMERAL_VAULT_ID,
  MAGIC_CONTEXT_ID,
  MAGIC_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationMetadataPdaFromDelegatedAccount,
  delegationRecordPdaFromDelegatedAccount,
  permissionPdaFromAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { Addresses } from "./addresses.js";
import { instructionData, Writer } from "./bytes.js";
import {
  DEFAULT_MAX_SEATS_PER_DAY,
  MARKET_STATUS,
  PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "./constants.js";

export type ExchangeSettings = {
  gate: PublicKey;
  oracle: PublicKey;
  maxSteps: number;
  /** Fixed when the exchange is created. `updateExchange` cannot change it. */
  collateralToken: number;
  /**
   * The most seats `open_trader` opens in one UTC day of the rollup clock,
   * which bounds what a stolen gate key can spend. Defaults to
   * `DEFAULT_MAX_SEATS_PER_DAY`.
   */
  maxSeatsPerDay?: number;
};

/** What `updateExchange` changes: everything but the collateral token. */
export type ExchangeUpdate = Omit<ExchangeSettings, "collateralToken"> & {
  /**
   * @deprecated Not sent. The collateral token is fixed for life and the
   * program's `update_exchange` has no field for it.
   */
  collateralToken?: number;
};

export type MarketLimits = {
  minSize: bigint;
  minNotional: bigint;
  bandBps: number;
  imBps: number;
  mmBps: number;
  takerFeeBps: number;
  liqPenaltyBps: number;
  fundingCapBps: number;
  maxMoveBps: number;
  maxOpenOrders: number;
  maxPriceAge: bigint;
  fundingInterval: bigint;
  /**
   * @deprecated Not sent. A market is created active; `restrictMarket` pauses
   * it or makes it reduce-only, and `resumeMarket` is the one way back.
   * Anything but active here is refused by the builder.
   */
  status?: number;
  /** RULES 9: seconds that must pass between two publishes. Defaults to 1. */
  minPublishGap?: number;
  /** RULES 9: the longer staleness limit liquidation uses. Defaults to `maxPriceAge`. */
  maxAgeLiquidation?: bigint;
  /** RULES 12: the most lots held long on the market. Defaults to 2^62 lots, no cap in practice. */
  openInterestCap?: bigint;
  /** RULES 8: how far above maintenance a liquidation brings the target. Defaults to 100 bps. */
  liqBufferBps?: number;
  /** RULES 8: the share of the penalty that goes to insurance. Defaults to none. */
  liqInsuranceShareBps?: number;
  /** RULES 12a: the share of taker fees that goes to insurance. Defaults to none. */
  feeInsuranceShareBps?: number;
};

const NO_OPEN_INTEREST_CAP = 1n << 62n;

export type MarketSettings = {
  kind: number;
  baseSymbol: string;
  quoteSymbol: string;
  baseToken: number;
  quoteToken: number;
  tick: bigint;
  baseLot: bigint;
  capacity: number;
  limits: MarketLimits;
};

export type AssetKind = { collateral: true } | { spot: number };

export type OrderInput = {
  side: number;
  orderType: number;
  price: bigint;
  size: bigint;
  secret: Uint8Array;
  reduceOnly: boolean;
  /** RULES 4: when a resting remainder stops being valid, unix seconds; 0 or absent for never. */
  expiry?: bigint;
};

/** What every instruction signed by an order key carries first. */
export type OrderKeyCall = {
  orderKey: PublicKey;
  owner: PublicKey;
  expiresAt: bigint;
  replacement: PublicKey;
  clientOrderId: bigint;
  marketId: number;
  /** Other perp markets the trader may hold a position on, as `Addresses.riskAccounts`. */
  riskMarkets?: number[];
};

type Meta = { pubkey: PublicKey; isSigner: boolean; isWritable: boolean };

const meta = (
  pubkey: PublicKey,
  isSigner: boolean,
  isWritable: boolean,
): Meta => ({
  pubkey,
  isSigner,
  isWritable,
});
const signer = (pubkey: PublicKey) => meta(pubkey, true, false);
const payer = (pubkey: PublicKey) => meta(pubkey, true, true);
const writable = (pubkey: PublicKey) => meta(pubkey, false, true);
const readonly = (pubkey: PublicKey) => meta(pubkey, false, false);

function exchangeSettings(writer: Writer, settings: ExchangeSettings): Writer {
  return writer
    .pubkey(settings.gate)
    .pubkey(settings.oracle)
    .u8(settings.maxSteps)
    .u8(settings.collateralToken)
    .u32(settings.maxSeatsPerDay ?? DEFAULT_MAX_SEATS_PER_DAY);
}

function exchangeUpdate(writer: Writer, settings: ExchangeUpdate): Writer {
  return writer
    .pubkey(settings.gate)
    .pubkey(settings.oracle)
    .u8(settings.maxSteps)
    .u32(settings.maxSeatsPerDay ?? DEFAULT_MAX_SEATS_PER_DAY);
}

function marketLimits(writer: Writer, limits: MarketLimits): Writer {
  if ((limits.status ?? MARKET_STATUS.active) !== MARKET_STATUS.active) {
    throw new Error(
      "a market's status is not a limit: use restrictMarket and resumeMarket",
    );
  }
  return writer
    .u64(limits.minSize)
    .u64(limits.minNotional)
    .u16(limits.bandBps)
    .u16(limits.imBps)
    .u16(limits.mmBps)
    .u16(limits.takerFeeBps)
    .u16(limits.liqPenaltyBps)
    .u16(limits.fundingCapBps)
    .u16(limits.maxMoveBps)
    .u16(limits.maxOpenOrders)
    .i64(limits.maxPriceAge)
    .i64(limits.fundingInterval)
    .u16(limits.minPublishGap ?? 1)
    .i64(limits.maxAgeLiquidation ?? limits.maxPriceAge)
    .u64(limits.openInterestCap ?? NO_OPEN_INTEREST_CAP)
    .u16(limits.liqBufferBps ?? 100)
    .u16(limits.liqInsuranceShareBps ?? 0)
    .u16(limits.feeInsuranceShareBps ?? 0);
}

function assetKind(writer: Writer, asset: AssetKind): Writer {
  if ("collateral" in asset) return writer.u8(0);
  return writer.u8(1).u8(asset.spot);
}

function orderKeyCall(writer: Writer, call: OrderKeyCall): Writer {
  return writer
    .i64(call.expiresAt)
    .pubkey(call.replacement)
    .u64(call.clientOrderId)
    .u8(call.marketId);
}

/** Builds every instruction of the program, with the accounts in the program's order. */
export class Instructions {
  readonly addresses: Addresses;

  constructor(readonly programId: PublicKey = PROGRAM_ID) {
    this.addresses = new Addresses(programId);
  }

  private instruction(keys: Meta[], data: Buffer): TransactionInstruction {
    return new TransactionInstruction({
      programId: this.programId,
      keys,
      data,
    });
  }

  private administer(admin: PublicKey): Meta[] {
    return [signer(admin), writable(this.addresses.exchange)];
  }

  private riskMetas(marketIds: number[] | undefined, active?: number): Meta[] {
    return (marketIds ?? [])
      .filter((id) => id !== active)
      .flatMap((id) => this.addresses.riskAccounts(id).map(readonly));
  }

  initializeExchange(admin: PublicKey, settings: ExchangeSettings) {
    return this.instruction(
      [
        payer(admin),
        writable(this.addresses.exchange),
        readonly(this.programId),
        readonly(this.addresses.programData),
        readonly(SystemProgram.programId),
      ],
      exchangeSettings(
        instructionData("initialize_exchange"),
        settings,
      ).build(),
    );
  }

  /** Changes the gate, the oracle, the step limit and the daily seat cap. */
  updateExchange(admin: PublicKey, settings: ExchangeUpdate) {
    return this.instruction(
      this.administer(admin),
      exchangeUpdate(instructionData("update_exchange"), settings).build(),
    );
  }

  setPaused(admin: PublicKey, paused: boolean) {
    return this.instruction(
      this.administer(admin),
      instructionData("set_paused").bool(paused).build(),
    );
  }

  proposeAdmin(admin: PublicKey, nominee: PublicKey | null) {
    return this.instruction(
      this.administer(admin),
      instructionData("propose_admin").option(nominee).build(),
    );
  }

  acceptAdmin(nominee: PublicKey) {
    return this.instruction(
      [signer(nominee), writable(this.addresses.exchange)],
      instructionData("accept_admin").build(),
    );
  }

  /**
   * Refused unless the custody balance of `mint` has a private permission
   * that nobody reads through; its address is `Addresses.custodyPermission`.
   */
  registerToken(admin: PublicKey, index: number, mint: PublicKey) {
    return this.instruction(
      [
        ...this.administer(admin),
        readonly(this.addresses.custodyAuthority),
        readonly(this.addresses.custody(mint)),
        readonly(this.addresses.custodyPermission(mint)),
      ],
      instructionData("register_token").u8(index).pubkey(mint).build(),
    );
  }

  delegateExchange(admin: PublicKey, validator: PublicKey) {
    const exchange = this.addresses.exchange;
    return this.instruction(
      [
        payer(admin),
        writable(
          delegateBufferPdaFromDelegatedAccountAndOwnerProgram(
            exchange,
            this.programId,
          ),
        ),
        writable(delegationRecordPdaFromDelegatedAccount(exchange)),
        writable(delegationMetadataPdaFromDelegatedAccount(exchange)),
        writable(exchange),
        readonly(this.programId),
        readonly(DELEGATION_PROGRAM_ID),
        readonly(SystemProgram.programId),
      ],
      instructionData("delegate_exchange").pubkey(validator).build(),
    );
  }

  undelegateExchange(admin: PublicKey) {
    return this.instruction(
      [
        payer(admin),
        writable(this.addresses.exchange),
        readonly(MAGIC_PROGRAM_ID),
        writable(MAGIC_CONTEXT_ID),
      ],
      instructionData("undelegate_exchange").build(),
    );
  }

  withdrawExchange(admin: PublicKey, lamports: bigint) {
    return this.instruction(
      [payer(admin), writable(this.addresses.exchange)],
      instructionData("withdraw_exchange").u64(lamports).build(),
    );
  }

  private rollupPrograms(): Meta[] {
    return [
      readonly(PERMISSION_PROGRAM_ID),
      writable(EPHEMERAL_VAULT_ID),
      readonly(MAGIC_PROGRAM_ID),
    ];
  }

  createLedger(admin: PublicKey) {
    const ledger = this.addresses.ledger;
    return this.instruction(
      [
        ...this.administer(admin),
        writable(ledger),
        writable(this.addresses.stats),
        writable(permissionPdaFromAccount(ledger)),
        ...this.rollupPrograms(),
      ],
      instructionData("create_ledger").build(),
    );
  }

  finalizeLedger(admin: PublicKey) {
    return this.instruction(
      [
        signer(admin),
        readonly(this.addresses.exchange),
        writable(this.addresses.ledger),
        writable(this.addresses.stats),
      ],
      instructionData("finalize_ledger").build(),
    );
  }

  createMarket(admin: PublicKey, marketId: number, settings: MarketSettings) {
    const book = this.addresses.book(marketId);
    const data = instructionData("create_market")
      .u8(marketId)
      .u8(settings.kind)
      .fixed(settings.baseSymbol, 8)
      .fixed(settings.quoteSymbol, 8)
      .u8(settings.baseToken)
      .u8(settings.quoteToken)
      .u64(settings.tick)
      .u64(settings.baseLot)
      .u16(settings.capacity);
    return this.instruction(
      [
        ...this.administer(admin),
        writable(this.addresses.market(marketId)),
        writable(book),
        writable(this.addresses.tape(marketId)),
        writable(this.addresses.priceFeed(marketId)),
        writable(permissionPdaFromAccount(book)),
        ...this.rollupPrograms(),
      ],
      marketLimits(data, settings.limits).build(),
    );
  }

  growAccount(
    admin: PublicKey,
    kind: number,
    marketId: number,
    target: PublicKey,
    newLen: number,
  ) {
    return this.instruction(
      [
        ...this.administer(admin),
        writable(target),
        writable(EPHEMERAL_VAULT_ID),
        readonly(MAGIC_PROGRAM_ID),
      ],
      instructionData("grow_account").u8(kind).u8(marketId).u32(newLen).build(),
    );
  }

  finalizeMarket(admin: PublicKey, marketId: number) {
    return this.instruction(
      [
        signer(admin),
        writable(this.addresses.exchange),
        writable(this.addresses.market(marketId)),
        writable(this.addresses.book(marketId)),
        writable(this.addresses.tape(marketId)),
        writable(this.addresses.priceFeed(marketId)),
      ],
      instructionData("finalize_market").u8(marketId).build(),
    );
  }

  updateMarket(admin: PublicKey, marketId: number, limits: MarketLimits) {
    return this.instruction(
      [
        signer(admin),
        readonly(this.addresses.exchange),
        writable(this.addresses.market(marketId)),
      ],
      marketLimits(
        instructionData("update_market").u8(marketId),
        limits,
      ).build(),
    );
  }

  /**
   * Pauses a market or makes it reduce-only (`MARKET_STATUS.paused` or
   * `MARKET_STATUS.reduceOnly`). Active is refused: `resumeMarket` is the
   * one way back.
   */
  restrictMarket(admin: PublicKey, marketId: number, status: number) {
    return this.instruction(
      [
        signer(admin),
        readonly(this.addresses.exchange),
        writable(this.addresses.market(marketId)),
      ],
      instructionData("restrict_market").u8(marketId).u8(status).build(),
    );
  }

  openTrader(gate: PublicKey, owner: PublicKey, orderKeys: PublicKey[]) {
    const view = this.addresses.view(owner);
    const data = instructionData("open_trader");
    for (const key of orderKeys) data.pubkey(key);
    return this.instruction(
      [
        signer(gate),
        signer(owner),
        writable(this.addresses.exchange),
        writable(this.addresses.ledger),
        writable(view),
        writable(permissionPdaFromAccount(view)),
        ...this.rollupPrograms(),
      ],
      data.build(),
    );
  }

  setOrderKeys(owner: PublicKey, orderKeys: PublicKey[]) {
    const data = instructionData("set_order_keys");
    for (const key of orderKeys) data.pubkey(key);
    return this.instruction(
      [signer(owner), writable(this.addresses.view(owner))],
      data.build(),
    );
  }

  closeTrader(owner: PublicKey) {
    const view = this.addresses.view(owner);
    return this.instruction(
      [
        signer(owner),
        writable(this.addresses.exchange),
        writable(this.addresses.ledger),
        writable(view),
        writable(permissionPdaFromAccount(view)),
        ...this.rollupPrograms(),
      ],
      instructionData("close_trader").build(),
    );
  }

  /**
   * The admin closes the seat and the view of `owner`, with the rent back to
   * the exchange. Refused unless the seat was never used since it was opened.
   */
  closeUnusedTrader(admin: PublicKey, owner: PublicKey) {
    const view = this.addresses.view(owner);
    return this.instruction(
      [
        ...this.administer(admin),
        writable(this.addresses.ledger),
        writable(view),
        writable(permissionPdaFromAccount(view)),
        ...this.rollupPrograms(),
      ],
      instructionData("close_unused_trader").pubkey(owner).build(),
    );
  }

  /**
   * The admin adds `amount` of the collateral token (`mint`) to the insurance
   * seat, out of the admin's own token account `from`.
   */
  fundInsurance(
    admin: PublicKey,
    from: PublicKey,
    mint: PublicKey,
    amount: bigint,
  ) {
    return this.instruction(
      [
        signer(admin),
        readonly(this.addresses.exchange),
        writable(this.addresses.ledger),
        readonly(this.addresses.custodyAuthority),
        writable(this.addresses.custody(mint)),
        writable(from),
        readonly(TOKEN_PROGRAM_ID),
      ],
      instructionData("fund_insurance").u64(amount).build(),
    );
  }

  /**
   * Credits the seat of `owner`, out of the depositor's token account `from`.
   * The beneficiary is named by its owner key; nobody needs its seat number.
   * It works in the same transaction as the `openTrader` that creates the seat.
   */
  deposit(
    depositor: PublicKey,
    from: PublicKey,
    mint: PublicKey,
    owner: PublicKey,
    asset: AssetKind,
    amount: bigint,
  ) {
    return this.instruction(
      [
        signer(depositor),
        readonly(this.addresses.exchange),
        writable(this.addresses.ledger),
        readonly(this.addresses.view(owner)),
        readonly(this.addresses.custodyAuthority),
        writable(this.addresses.custody(mint)),
        writable(from),
        readonly(TOKEN_PROGRAM_ID),
      ],
      assetKind(instructionData("deposit"), asset).u64(amount).build(),
    );
  }

  withdraw(
    owner: PublicKey,
    to: PublicKey,
    mint: PublicKey,
    asset: AssetKind,
    amount: bigint,
    riskMarkets: number[] = [],
  ) {
    return this.instruction(
      [
        signer(owner),
        readonly(this.addresses.exchange),
        writable(this.addresses.ledger),
        writable(this.addresses.view(owner)),
        readonly(this.addresses.custodyAuthority),
        writable(this.addresses.custody(mint)),
        writable(to),
        readonly(TOKEN_PROGRAM_ID),
        ...this.riskMetas(riskMarkets),
      ],
      assetKind(instructionData("withdraw"), asset).u64(amount).build(),
    );
  }

  private tradeMetas(call: OrderKeyCall): Meta[] {
    return [
      signer(call.orderKey),
      writable(this.addresses.view(call.owner)),
      readonly(this.addresses.exchange),
      writable(this.addresses.ledger),
      writable(this.addresses.market(call.marketId)),
      writable(this.addresses.book(call.marketId)),
      readonly(this.addresses.priceFeed(call.marketId)),
    ];
  }

  placeOrder(call: OrderKeyCall, order: OrderInput) {
    const data = orderKeyCall(instructionData("place_order"), call)
      .u8(order.side)
      .u8(order.orderType)
      .u64(order.price)
      .u64(order.size)
      .fixed(order.secret, 16)
      .bool(order.reduceOnly)
      .i64(order.expiry ?? 0n);
    return this.instruction(
      [
        ...this.tradeMetas(call),
        writable(this.addresses.tape(call.marketId)),
        writable(this.addresses.stats),
        ...this.riskMetas(call.riskMarkets, call.marketId),
      ],
      data.build(),
    );
  }

  cancelOrder(call: OrderKeyCall, orderSeq: bigint) {
    return this.instruction(
      this.tradeMetas(call),
      orderKeyCall(instructionData("cancel_order"), call).u64(orderSeq).build(),
    );
  }

  cancelAll(call: OrderKeyCall, maxCancels: number) {
    return this.instruction(
      this.tradeMetas(call),
      orderKeyCall(instructionData("cancel_all"), call).u32(maxCancels).build(),
    );
  }

  syncView(call: OrderKeyCall) {
    return this.instruction(
      this.tradeMetas(call),
      orderKeyCall(instructionData("sync_view"), call).build(),
    );
  }

  liquidate(
    call: OrderKeyCall,
    target: number,
    size: bigint,
    worstPrice: bigint,
  ) {
    return this.instruction(
      [
        ...this.tradeMetas(call),
        writable(this.addresses.stats),
        ...this.riskMetas(call.riskMarkets, call.marketId),
      ],
      orderKeyCall(instructionData("liquidate"), call)
        .u32(target)
        .u64(size)
        .u64(worstPrice)
        .build(),
    );
  }

  publishPrice(
    oracle: PublicKey,
    marketId: number,
    price: bigint,
    publishTime: bigint,
  ) {
    return this.instruction(
      [
        signer(oracle),
        readonly(this.addresses.exchange),
        readonly(this.addresses.market(marketId)),
        writable(this.addresses.priceFeed(marketId)),
      ],
      instructionData("publish_price")
        .u8(marketId)
        .u64(price)
        .i64(publishTime)
        .build(),
    );
  }

  coverShortfall(marketId: number, seat: number) {
    return this.instruction(
      [
        readonly(this.addresses.exchange),
        writable(this.addresses.ledger),
        writable(this.addresses.market(marketId)),
      ],
      instructionData("cover_shortfall").u8(marketId).u32(seat).build(),
    );
  }

  /** `perpMarketIds` must be every perp market the exchange has, in rising order. */
  reconcileShortfall(perpMarketIds: number[]) {
    return this.instruction(
      [
        readonly(this.addresses.exchange),
        writable(this.addresses.ledger),
        ...perpMarketIds.map((id) => writable(this.addresses.market(id))),
      ],
      instructionData("reconcile_shortfall").build(),
    );
  }

  /**
   * Moves `amount` of the collateral token between the trader's perpetuals
   * collateral and their spot balance of the same mint (`spotToken` is that
   * mint's token index). The debited side passes the withdrawal checks.
   */
  transferBetweenBalances(
    call: Omit<OrderKeyCall, "marketId"> & { marketId?: number },
    toCollateral: boolean,
    spotToken: number,
    amount: bigint,
  ) {
    return this.instruction(
      [
        signer(call.orderKey),
        writable(this.addresses.view(call.owner)),
        readonly(this.addresses.exchange),
        writable(this.addresses.ledger),
        ...this.riskMetas(call.riskMarkets),
      ],
      instructionData("transfer_between_balances")
        .i64(call.expiresAt)
        .pubkey(call.replacement)
        .u64(call.clientOrderId)
        .bool(toCollateral)
        .u8(spotToken)
        .u64(amount)
        .build(),
    );
  }

  resumeMarket(admin: PublicKey, marketId: number) {
    return this.instruction(
      [
        signer(admin),
        readonly(this.addresses.exchange),
        writable(this.addresses.market(marketId)),
      ],
      instructionData("resume_market").u8(marketId).build(),
    );
  }

  moveFeesToInsurance(admin: PublicKey, amount: bigint) {
    return this.instruction(
      [
        signer(admin),
        readonly(this.addresses.exchange),
        writable(this.addresses.ledger),
      ],
      instructionData("move_fees_to_insurance").u64(amount).build(),
    );
  }

  collectFees(
    admin: PublicKey,
    to: PublicKey,
    mint: PublicKey,
    asset: AssetKind,
    amount: bigint,
  ) {
    return this.instruction(
      [
        signer(admin),
        readonly(this.addresses.exchange),
        writable(this.addresses.ledger),
        readonly(this.addresses.custodyAuthority),
        writable(this.addresses.custody(mint)),
        writable(to),
        readonly(TOKEN_PROGRAM_ID),
      ],
      assetKind(instructionData("collect_fees"), asset).u64(amount).build(),
    );
  }

  resetPrice(
    admin: PublicKey,
    marketId: number,
    price: bigint,
    publishTime: bigint,
  ) {
    return this.instruction(
      [
        signer(admin),
        readonly(this.addresses.exchange),
        writable(this.addresses.market(marketId)),
        writable(this.addresses.priceFeed(marketId)),
      ],
      instructionData("reset_price")
        .u8(marketId)
        .u64(price)
        .i64(publishTime)
        .build(),
    );
  }

  updateFunding(marketId: number) {
    return this.instruction(
      [
        readonly(this.addresses.exchange),
        writable(this.addresses.market(marketId)),
        writable(this.addresses.book(marketId)),
        readonly(this.addresses.priceFeed(marketId)),
      ],
      instructionData("update_funding").u8(marketId).build(),
    );
  }

  scheduleFunding(
    admin: PublicKey,
    marketId: number,
    taskId: bigint,
    intervalMs: bigint,
    iterations: bigint,
  ) {
    return this.instruction(
      [
        payer(admin),
        readonly(this.addresses.exchange),
        writable(this.addresses.market(marketId)),
        writable(this.addresses.book(marketId)),
        readonly(this.addresses.priceFeed(marketId)),
        readonly(MAGIC_PROGRAM_ID),
      ],
      instructionData("schedule_funding")
        .u8(marketId)
        .i64(taskId)
        .i64(intervalMs)
        .i64(iterations)
        .build(),
    );
  }
}

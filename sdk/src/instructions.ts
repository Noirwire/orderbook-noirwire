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
import { CUSTODY_VISIBILITIES, type CustodyVisibility } from "./accounts.js";
import { Addresses, type CustodyToken } from "./addresses.js";
import { instructionData, Writer } from "./bytes.js";
import {
  DEFAULT_MAX_SEATS_PER_DAY,
  MARKET_STATUS,
  PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "./constants.js";
import { SECRET_LEN, SYMBOL_LEN } from "./internal/sizes.js";

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

/** What `updateExchange` changes: everything but the collateral token, which is fixed for life. */
export type ExchangeUpdate = Omit<ExchangeSettings, "collateralToken">;

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
  /** RULES 12: the most lots held long on the market. Defaults to 2^24 lots, the highest cap the engine accepts. */
  openInterestCap?: bigint;
  /** RULES 8: how far above maintenance a liquidation brings the target. Defaults to 100 bps. */
  liqBufferBps?: number;
  /** RULES 8: the share of the penalty that goes to insurance. Defaults to none. */
  liqInsuranceShareBps?: number;
  /** RULES 12a: the share of taker fees that goes to insurance. Defaults to none. */
  feeInsuranceShareBps?: number;
  /** RULES 9: seconds a settled gap keeps collateral from leaving any seat. Defaults to 900. */
  settleWindow?: bigint;
  /**
   * RULES 3 and 6: the largest position, long or short in lots, an order may
   * reach and a fill may build on one seat. Required, with no default: an
   * update that left it out would otherwise lift a cap the admin had set.
   */
  positionCap: bigint;
};

const MAX_OPEN_INTEREST_CAP = 1n << 24n;
const DEFAULT_SETTLE_WINDOW = 900n;

/**
 * RULES 9: the Pyth feed a market reads, fixed when it is created. The price
 * is `price * 10^expo` USD per whole base token; `baseDecimals` and
 * `quoteDecimals` turn it into quote atoms per lot.
 */
export type PriceSourceSettings = {
  /** 32 bytes. All zero binds nothing, which only a test network's build accepts. */
  feedId: Uint8Array;
  expo: number;
  /** An observation whose confidence is wider than this share of its price is refused. */
  maxConfBps: number;
  baseDecimals: number;
  quoteDecimals: number;
};

/** A test network's market, bound to no source and priced by the oracle key. */
export const UNBOUND_PRICE_SOURCE: PriceSourceSettings = {
  feedId: new Uint8Array(32),
  expo: 0,
  maxConfBps: 100,
  baseDecimals: 0,
  quoteDecimals: 0,
};

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
  /** Defaults to `UNBOUND_PRICE_SOURCE`, which the mainnet build refuses. */
  priceSource?: PriceSourceSettings;
};

/** RULES 9a: the USDC guard's source and limits. */
export type QuoteSettings = {
  feedId: Uint8Array;
  expo: number;
  maxConfBps: number;
  /** How far from one dollar, in bps, USDC may be before perps turn reduce-only. */
  depegBps: number;
  /** Seconds one healthy observation keeps the guard passing. */
  maxAge: bigint;
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
  /**
   * Every perp market the exchange has, as `Addresses.riskAccounts`. Every
   * order-key instruction names them, whichever market it is for, so that no
   * public account's signature list tells one kind from another; `place_order`
   * on a perp market, `liquidate` and `transfer_between_balances` refuse
   * without them.
   */
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
/** An account the program keeps sealed, followed by its permission. */
const sealed = (account: PublicKey): Meta[] => [
  writable(account),
  writable(permissionPdaFromAccount(account)),
];

/** The data of `publish_price` and `reset_price`, which carry the same fields. */
function pricePoint(
  name: "publish_price" | "reset_price",
  marketId: number,
  price: bigint,
  publishTime: bigint,
): Buffer {
  return instructionData(name).u8(marketId).u64(price).i64(publishTime).build();
}

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
    .u64(limits.openInterestCap ?? MAX_OPEN_INTEREST_CAP)
    .u16(limits.liqBufferBps ?? 100)
    .u16(limits.liqInsuranceShareBps ?? 0)
    .u16(limits.feeInsuranceShareBps ?? 0)
    .i64(limits.settleWindow ?? DEFAULT_SETTLE_WINDOW)
    .u64(limits.positionCap);
}

function priceSource(writer: Writer, source: PriceSourceSettings): Writer {
  return writer
    .fixed(source.feedId, 32)
    .i32(source.expo)
    .u16(source.maxConfBps)
    .u8(source.baseDecimals)
    .u8(source.quoteDecimals);
}

function assetKind(writer: Writer, asset: AssetKind): Writer {
  if ("collateral" in asset) return writer.u8(0);
  return writer.u8(1).u8(asset.spot);
}

function keySwap(
  writer: Writer,
  call: Pick<OrderKeyCall, "expiresAt" | "replacement" | "clientOrderId">,
): Writer {
  return writer
    .i64(call.expiresAt)
    .pubkey(call.replacement)
    .u64(call.clientOrderId);
}

function orderKeyCall(writer: Writer, call: OrderKeyCall): Writer {
  return keySwap(writer, call).u8(call.marketId);
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

  private administerMarket(admin: PublicKey, marketId: number): Meta[] {
    return [
      signer(admin),
      readonly(this.addresses.exchange),
      writable(this.addresses.market(marketId)),
    ];
  }

  /** The admin moving `token` between custody and `tokenAccount`, against the ledger. */
  private administerCustody(
    admin: PublicKey,
    token: CustodyToken,
    tokenAccount: PublicKey,
  ): Meta[] {
    return [
      signer(admin),
      readonly(this.addresses.exchange),
      writable(this.addresses.ledger),
      ...this.custodyLeg(token, tokenAccount),
    ];
  }

  /** `token`'s custody authority and custody, the other side of the movement, and the token program. */
  private custodyLeg(token: CustodyToken, tokenAccount: PublicKey): Meta[] {
    return [
      readonly(this.addresses.custodyAuthority(token.custodyNonce)),
      writable(this.addresses.custody(token)),
      writable(tokenAccount),
      readonly(TOKEN_PROGRAM_ID),
    ];
  }

  /** What `update_funding` names, which `schedule_funding` names again for the task. */
  private fundingMetas(marketId: number): Meta[] {
    return [
      readonly(this.addresses.exchange),
      writable(this.addresses.market(marketId)),
      writable(this.addresses.book(marketId)),
      readonly(this.addresses.priceFeed(marketId)),
    ];
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
   * Records `token.mint` with the custody of `token.custodyNonce`, which must
   * already be in the rollup. `sealed` is refused unless that custody balance
   * has a private permission that nobody reads through; `public` is refused
   * if it has any permission. The address looked at is
   * `Addresses.custodyPermission`. The nonce and the choice are recorded with
   * the token and never change.
   */
  registerToken(
    admin: PublicKey,
    index: number,
    token: CustodyToken,
    visibility: CustodyVisibility,
  ) {
    return this.instruction(
      [
        ...this.administer(admin),
        readonly(this.addresses.custodyAuthority(token.custodyNonce)),
        readonly(this.addresses.custody(token)),
        readonly(this.addresses.custodyPermission(token)),
      ],
      instructionData("register_token")
        .u8(index)
        .pubkey(token.mint)
        .u64(token.custodyNonce)
        .u8(CUSTODY_VISIBILITIES.indexOf(visibility))
        .build(),
    );
  }

  /**
   * Sets the most the custody account of the token at `index` may hold after
   * a trader's deposit, in atoms, for every index kept in that account. A
   * registered token starts at zero, which takes no deposit. The admin's
   * `fundInsurance` is not held to it.
   */
  setCustodyCap(admin: PublicKey, index: number, cap: bigint) {
    return this.instruction(
      this.administer(admin),
      instructionData("set_custody_cap").u8(index).u64(cap).build(),
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
      .fixed(settings.baseSymbol, SYMBOL_LEN)
      .fixed(settings.quoteSymbol, SYMBOL_LEN)
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
      priceSource(
        marketLimits(data, settings.limits),
        settings.priceSource ?? UNBOUND_PRICE_SOURCE,
      ).build(),
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
      this.administerMarket(admin, marketId),
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
      this.administerMarket(admin, marketId),
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
        ...sealed(view),
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
    return this.instruction(
      [
        signer(owner),
        writable(this.addresses.exchange),
        writable(this.addresses.ledger),
        ...sealed(this.addresses.view(owner)),
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
    return this.instruction(
      [
        ...this.administer(admin),
        writable(this.addresses.ledger),
        ...sealed(this.addresses.view(owner)),
        ...this.rollupPrograms(),
      ],
      instructionData("close_unused_trader").pubkey(owner).build(),
    );
  }

  /**
   * The admin adds `amount` of the collateral token (`token`) to the insurance
   * seat, out of the admin's own token account `from`.
   */
  fundInsurance(
    admin: PublicKey,
    from: PublicKey,
    token: CustodyToken,
    amount: bigint,
  ) {
    return this.instruction(
      this.administerCustody(admin, token, from),
      instructionData("fund_insurance").u64(amount).build(),
    );
  }

  /**
   * Credits the seat of `owner`, out of the depositor's token account `from`,
   * into the custody of `token` (a registered `TokenInfo` is one).
   * The beneficiary is named by its owner key, never by a seat number. It works in the same transaction as the `openTrader` that creates the seat.
   */
  deposit(
    depositor: PublicKey,
    from: PublicKey,
    token: CustodyToken,
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
        ...this.custodyLeg(token, from),
      ],
      assetKind(instructionData("deposit"), asset).u64(amount).build(),
    );
  }

  withdraw(
    owner: PublicKey,
    to: PublicKey,
    token: CustodyToken,
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
        ...this.custodyLeg(token, to),
        ...this.riskMetas(riskMarkets),
      ],
      assetKind(instructionData("withdraw"), asset).u64(amount).build(),
    );
  }

  /** The accounts of every order-key instruction, the same for each. */
  private orderKeyMetas(call: OrderKeyCall): Meta[] {
    return [
      signer(call.orderKey),
      writable(this.addresses.view(call.owner)),
      readonly(this.addresses.exchange),
      writable(this.addresses.ledger),
      writable(this.addresses.market(call.marketId)),
      writable(this.addresses.book(call.marketId)),
      readonly(this.addresses.priceFeed(call.marketId)),
      writable(this.addresses.tape(call.marketId)),
      writable(this.addresses.stats),
      ...this.riskMetas(call.riskMarkets, call.marketId),
    ];
  }

  placeOrder(call: OrderKeyCall, order: OrderInput) {
    const data = orderKeyCall(instructionData("place_order"), call)
      .u8(order.side)
      .u8(order.orderType)
      .u64(order.price)
      .u64(order.size)
      .fixed(order.secret, SECRET_LEN)
      .bool(order.reduceOnly)
      .i64(order.expiry ?? 0n);
    return this.instruction(this.orderKeyMetas(call), data.build());
  }

  cancelOrder(call: OrderKeyCall, orderSeq: bigint) {
    return this.instruction(
      this.orderKeyMetas(call),
      orderKeyCall(instructionData("cancel_order"), call).u64(orderSeq).build(),
    );
  }

  cancelAll(call: OrderKeyCall, maxCancels: number) {
    return this.instruction(
      this.orderKeyMetas(call),
      orderKeyCall(instructionData("cancel_all"), call).u32(maxCancels).build(),
    );
  }

  syncView(call: OrderKeyCall) {
    return this.instruction(
      this.orderKeyMetas(call),
      orderKeyCall(instructionData("sync_view"), call).build(),
    );
  }

  /**
   * Does nothing. Sent after an order-key instruction, it doubles the compute
   * the transaction gets, to 400,000 units, without naming the compute budget
   * program, which would set the transaction apart.
   */
  extendCompute() {
    return this.instruction([], instructionData("extend_compute").build());
  }

  liquidate(
    call: OrderKeyCall,
    target: number,
    size: bigint,
    worstPrice: bigint,
  ) {
    return this.instruction(
      this.orderKeyMetas(call),
      orderKeyCall(instructionData("liquidate"), call)
        .u32(target)
        .u64(size)
        .u64(worstPrice)
        .build(),
    );
  }

  /**
   * A test network's build only, for a market bound to no price source: the
   * oracle key publishes its next mark, within the move limit of the last. The
   * mainnet build has no such instruction. Refused on a feed that has never had
   * a price: its first is the admin's `resetPrice`, which leaves the market
   * reduce-only until `resumeMarket`.
   */
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
      pricePoint("publish_price", marketId, price, publishTime),
    );
  }

  /**
   * RULES 9: anyone may hand a market its bound Pyth account, `priceUpdate`
   * (`PriceFeed.binding.account`, or `pythPriceAccount` of its feed id). Send
   * it in a transaction of its own: it is never part of an order-key
   * transaction, whose accounts stay the same for every instruction. The first
   * sync of a market that has never had a price leaves it reduce-only until
   * `resumeMarket`.
   */
  syncPrice(marketId: number, priceUpdate: PublicKey) {
    return this.instruction(
      [
        writable(this.addresses.market(marketId)),
        writable(this.addresses.priceFeed(marketId)),
        readonly(priceUpdate),
      ],
      instructionData("sync_price").u8(marketId).build(),
    );
  }

  /** RULES 9a: anyone may hand the USDC guard its bound Pyth account, `Exchange.quote.account`. */
  syncQuote(priceUpdate: PublicKey) {
    return this.instruction(
      [writable(this.addresses.exchange), readonly(priceUpdate)],
      instructionData("sync_quote").build(),
    );
  }

  /**
   * RULES 9: rebinds a market to another feed, refused unless it is paused with
   * no position and no order. Its mark starts again from the next `syncPrice`,
   * and the market stays paused until `resumeMarket`.
   */
  setPriceSource(
    admin: PublicKey,
    marketId: number,
    feedId: Uint8Array,
    expo: number,
  ) {
    return this.instruction(
      [
        signer(admin),
        readonly(this.addresses.exchange),
        writable(this.addresses.market(marketId)),
        writable(this.addresses.book(marketId)),
        writable(this.addresses.priceFeed(marketId)),
      ],
      instructionData("set_price_source")
        .u8(marketId)
        .fixed(feedId, 32)
        .i32(expo)
        .build(),
    );
  }

  /** RULES 9a: sets the USDC guard's source and limits; it fails closed until the next `syncQuote`. */
  setQuoteSource(admin: PublicKey, settings: QuoteSettings) {
    return this.instruction(
      this.administer(admin),
      instructionData("set_quote_source")
        .fixed(settings.feedId, 32)
        .i32(settings.expo)
        .u16(settings.maxConfBps)
        .u16(settings.depegBps)
        .i64(settings.maxAge)
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
   * mint's token index). The debited side passes the withdrawal checks. It
   * names `call.marketId` like any order-key instruction, and changes nothing
   * on that market.
   */
  transferBetweenBalances(
    call: OrderKeyCall,
    toCollateral: boolean,
    spotToken: number,
    amount: bigint,
  ) {
    return this.instruction(
      this.orderKeyMetas(call),
      orderKeyCall(instructionData("transfer_between_balances"), call)
        .bool(toCollateral)
        .u8(spotToken)
        .u64(amount)
        .build(),
    );
  }

  /**
   * Returns `marketId` to active status. `perpMarketIds` must be every perp
   * market the exchange has, in rising order, `marketId` included when it is
   * one. Refused while any of them records a shortfall, and while `marketId`'s
   * price source is not healthy.
   */
  resumeMarket(admin: PublicKey, marketId: number, perpMarketIds: number[]) {
    return this.instruction(
      [
        ...this.administerMarket(admin, marketId),
        ...perpMarketIds.map((id) => readonly(this.addresses.market(id))),
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

  /**
   * Pays fees out of the fee seat and the custody of `token` to `to`, which
   * may not be a custody account. `perpMarketIds` must be every perp market
   * the exchange has, in rising order. Collateral is refused while any of
   * them records a shortfall.
   */
  collectFees(
    admin: PublicKey,
    to: PublicKey,
    token: CustodyToken,
    asset: AssetKind,
    amount: bigint,
    perpMarketIds: number[],
  ) {
    return this.instruction(
      [
        ...this.administerCustody(admin, token, to),
        ...perpMarketIds.map((id) => readonly(this.addresses.market(id))),
      ],
      assetKind(instructionData("collect_fees"), asset).u64(amount).build(),
    );
  }

  /** A test network's build only, for a market bound to no price source. */
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
      pricePoint("reset_price", marketId, price, publishTime),
    );
  }

  updateFunding(marketId: number) {
    return this.instruction(
      this.fundingMetas(marketId),
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
        ...this.fundingMetas(marketId),
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

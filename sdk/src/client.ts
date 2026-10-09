import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  decodePriceFeed,
  decodeStats,
  decodeTape,
  decodeView,
  type OrderResult,
  type PriceFeed,
  type Stats,
  type Tape,
  type View,
} from "./accounts.js";
import { Addresses } from "./addresses.js";
import { MAX_EXPIRY_AHEAD, PROGRAM_ID } from "./constants.js";
import {
  Instructions,
  type OrderInput,
  type OrderKeyCall,
} from "./instructions.js";
import { OrderKeyManager, type OrderKeyUse } from "./orderKeys.js";
import { randomSecret } from "./receipts.js";

export type Unsubscribe = () => Promise<void>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A signed transaction, ready to send as many times as needed. */
export type Signed = { raw: Buffer; signature: string };

export async function signed(
  connection: Connection,
  instructions: TransactionInstruction[],
  feePayer: Keypair,
  signers: Keypair[] = [],
): Promise<Signed> {
  const latest = await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({
    feePayer: feePayer.publicKey,
    ...latest,
  }).add(...instructions);
  transaction.sign(feePayer, ...signers);
  const signature = transaction.signature;
  if (!signature) throw new Error("the transaction was not signed");
  return {
    raw: transaction.serialize(),
    signature: Buffer.from(signature).toString("base64"),
  };
}

/** Sends a transaction and waits for its status, for everything but orders. */
export async function sendAndConfirm(
  connection: Connection,
  instructions: TransactionInstruction[],
  feePayer: Keypair,
  signers: Keypair[] = [],
  timeoutMs = 60_000,
): Promise<string> {
  const { raw } = await signed(connection, instructions, feePayer, signers);
  const signature = await connection.sendRawTransaction(raw, {
    skipPreflight: true,
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value } = await connection.getSignatureStatus(signature);
    if (value && value.confirmationStatus !== "processed") {
      if (value.err) {
        const landed = await connection.getTransaction(signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
        throw new Error(
          `${JSON.stringify(value.err)}\n${(landed?.meta?.logMessages ?? []).join("\n")}`,
        );
      }
      return signature;
    }
    await sleep(100);
  }
  throw new Error(
    `transaction ${signature} was not confirmed in ${timeoutMs} ms`,
  );
}

export type PlaceOrderOptions = {
  /** Seconds the order stays sendable for. The program refuses more than 60. */
  expirySeconds?: number;
  /** How often the view is read while waiting for the result. */
  pollMs?: number;
  /** How long to wait for the result before sending the same transaction again. */
  resendMs?: number;
  clientOrderId?: bigint;
  secret?: Uint8Array;
  /** Other perp markets the trader holds positions on, for the margin check. */
  riskMarkets?: number[];
  /** The clock the expiry is measured against, in unix seconds. */
  now?: () => number;
};

export type Placed =
  | { outcome: "placed"; result: OrderResult; secret: Uint8Array; view: View }
  | {
      outcome: "expired";
      clientOrderId: bigint;
      secret: Uint8Array;
      view: View;
    };

/**
 * A trader's client: builds, signs and confirms from the view. `connection`
 * sends to the rollup; `reader` is a connection that may read this trader's
 * view, that is a private connection signed in as the owner.
 */
export class TraderClient {
  readonly instructions: Instructions;
  readonly addresses: Addresses;

  constructor(
    readonly connection: Connection,
    readonly reader: Connection,
    readonly owner: PublicKey,
    readonly keys: OrderKeyManager,
    programId: PublicKey = PROGRAM_ID,
  ) {
    this.instructions = new Instructions(programId);
    this.addresses = this.instructions.addresses;
  }

  async view(): Promise<View> {
    const account = await this.reader.getAccountInfo(
      this.addresses.view(this.owner),
    );
    if (!account)
      throw new Error("the view is not readable by this connection");
    return decodeView(account.data);
  }

  private call(
    use: OrderKeyUse,
    marketId: number,
    clientOrderId: bigint,
    expiresAt: bigint,
    riskMarkets?: number[],
  ): OrderKeyCall {
    return {
      orderKey: use.keypair.publicKey,
      owner: this.owner,
      expiresAt,
      replacement: use.replacement.publicKey,
      clientOrderId,
      marketId,
      riskMarkets,
    };
  }

  /**
   * Places an order and confirms it from the view's result ring. While no
   * result for the client order id shows, the same signed transaction is sent
   * again every `resendMs`, until the expiry; after that, with still no result,
   * the order is reported expired and its key is still live.
   */
  async placeOrder(
    marketId: number,
    order: Omit<OrderInput, "secret" | "expiry"> & {
      secret?: Uint8Array;
      /** When a resting remainder stops being valid, unix seconds; none by default. */
      expiry?: bigint;
    },
    options: PlaceOrderOptions = {},
  ): Promise<Placed> {
    const expirySeconds = Math.min(
      options.expirySeconds ?? 5,
      MAX_EXPIRY_AHEAD,
    );
    const now = options.now ?? (() => Math.floor(Date.now() / 1000));
    const expiresAt = BigInt(now() + expirySeconds);
    const clientOrderId = options.clientOrderId ?? randomClientOrderId();
    const secret = options.secret ?? order.secret ?? randomSecret();
    const use = this.keys.take();
    const instruction = this.instructions.placeOrder(
      this.call(use, marketId, clientOrderId, expiresAt, options.riskMarkets),
      { ...order, secret, expiry: order.expiry ?? 0n },
    );
    const { raw } = await signed(this.connection, [instruction], use.keypair);
    const pollMs = options.pollMs ?? 50;
    const resendMs = options.resendMs ?? 1_000;

    let lastSent = 0;
    for (;;) {
      if (now() <= Number(expiresAt) && Date.now() - lastSent >= resendMs) {
        await this.connection
          .sendRawTransaction(raw, { skipPreflight: true })
          .catch(() => {});
        lastSent = Date.now();
      }
      const view = await this.view();
      const result = view.results.find(
        (entry) => entry.clientOrderId === clientOrderId,
      );
      if (result) {
        this.keys.confirm(use);
        return { outcome: "placed", result, secret, view };
      }
      if (now() > Number(expiresAt) + 1) {
        this.keys.release(use);
        this.keys.resync(view);
        return { outcome: "expired", clientOrderId, secret, view };
      }
      await sleep(pollMs);
    }
  }

  private async sendKeyed(
    use: OrderKeyUse,
    instruction: TransactionInstruction,
    clientOrderId: bigint,
    expiresAt: bigint,
    pollMs = 50,
  ): Promise<OrderResult | null> {
    const { raw } = await signed(this.connection, [instruction], use.keypair);
    await this.connection.sendRawTransaction(raw, { skipPreflight: true });
    for (;;) {
      const view = await this.view();
      const result = view.results.find(
        (entry) => entry.clientOrderId === clientOrderId,
      );
      if (result) {
        this.keys.confirm(use);
        return result;
      }
      if (Math.floor(Date.now() / 1000) > Number(expiresAt) + 1) {
        this.keys.release(use);
        this.keys.resync(view);
        return null;
      }
      await sleep(pollMs);
    }
  }

  private expiry(seconds = 5): bigint {
    return BigInt(
      Math.floor(Date.now() / 1000) + Math.min(seconds, MAX_EXPIRY_AHEAD),
    );
  }

  async cancelOrder(
    marketId: number,
    orderSeq: bigint,
    expirySeconds?: number,
  ) {
    const use = this.keys.take();
    const clientOrderId = randomClientOrderId();
    const expiresAt = this.expiry(expirySeconds);
    return this.sendKeyed(
      use,
      this.instructions.cancelOrder(
        this.call(use, marketId, clientOrderId, expiresAt),
        orderSeq,
      ),
      clientOrderId,
      expiresAt,
    );
  }

  async cancelAll(marketId: number, maxCancels = 32, expirySeconds?: number) {
    const use = this.keys.take();
    const clientOrderId = randomClientOrderId();
    const expiresAt = this.expiry(expirySeconds);
    return this.sendKeyed(
      use,
      this.instructions.cancelAll(
        this.call(use, marketId, clientOrderId, expiresAt),
        maxCancels,
      ),
      clientOrderId,
      expiresAt,
    );
  }

  /**
   * Moves collateral-token value between the perpetuals collateral and the
   * spot balance of the same mint, no tokens moving. `riskMarkets` must name
   * every perp market the exchange has.
   */
  async transferBetweenBalances(
    toCollateral: boolean,
    spotToken: number,
    amount: bigint,
    riskMarkets: number[] = [],
    expirySeconds?: number,
  ) {
    const use = this.keys.take();
    const clientOrderId = randomClientOrderId();
    const expiresAt = this.expiry(expirySeconds);
    return this.sendKeyed(
      use,
      this.instructions.transferBetweenBalances(
        this.call(use, 0, clientOrderId, expiresAt, riskMarkets),
        toCollateral,
        spotToken,
        amount,
      ),
      clientOrderId,
      expiresAt,
    );
  }

  async syncView(marketId: number, expirySeconds?: number) {
    const use = this.keys.take();
    const clientOrderId = randomClientOrderId();
    const expiresAt = this.expiry(expirySeconds);
    return this.sendKeyed(
      use,
      this.instructions.syncView(
        this.call(use, marketId, clientOrderId, expiresAt),
      ),
      clientOrderId,
      expiresAt,
    );
  }

  /**
   * RULES 8: tried blind against seat `target`. `worstPrice` is the worst
   * liquidation price accepted: the highest when buying a long target's
   * position, the lowest when selling into a short one's.
   */
  async liquidate(
    marketId: number,
    target: number,
    size: bigint,
    worstPrice: bigint,
    riskMarkets: number[] = [],
    expirySeconds?: number,
  ) {
    const use = this.keys.take();
    const clientOrderId = randomClientOrderId();
    const expiresAt = this.expiry(expirySeconds);
    return this.sendKeyed(
      use,
      this.instructions.liquidate(
        this.call(use, marketId, clientOrderId, expiresAt, riskMarkets),
        target,
        size,
        worstPrice,
      ),
      clientOrderId,
      expiresAt,
    );
  }

  subscribeView(onChange: (view: View) => void): Unsubscribe {
    return subscribe(
      this.reader,
      this.addresses.view(this.owner),
      decodeView,
      onChange,
    );
  }
}

export function randomClientOrderId(): bigint {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return new DataView(bytes.buffer).getBigUint64(0, true);
}

function subscribe<T>(
  connection: Connection,
  address: PublicKey,
  decode: (data: Uint8Array) => T,
  onChange: (value: T) => void,
): Unsubscribe {
  const id = connection.onAccountChange(
    address,
    (account) => onChange(decode(account.data)),
    { commitment: "confirmed" },
  );
  return () => connection.removeAccountChangeListener(id);
}

/** Public reads and subscriptions, for any connection to the rollup or the filter. */
export class MarketReader {
  readonly addresses: Addresses;

  constructor(
    readonly connection: Connection,
    programId: PublicKey = PROGRAM_ID,
  ) {
    this.addresses = new Addresses(programId);
  }

  private async read<T>(
    address: PublicKey,
    decode: (data: Uint8Array) => T,
  ): Promise<T> {
    const account = await this.connection.getAccountInfo(address);
    if (!account) throw new Error(`${address.toBase58()} is not readable here`);
    return decode(account.data);
  }

  tape(marketId: number): Promise<Tape> {
    return this.read(this.addresses.tape(marketId), decodeTape);
  }

  priceFeed(marketId: number): Promise<PriceFeed> {
    return this.read(this.addresses.priceFeed(marketId), decodePriceFeed);
  }

  stats(): Promise<Stats> {
    return this.read(this.addresses.stats, decodeStats);
  }

  subscribeTape(marketId: number, onChange: (tape: Tape) => void): Unsubscribe {
    return subscribe(
      this.connection,
      this.addresses.tape(marketId),
      decodeTape,
      onChange,
    );
  }

  subscribePriceFeed(
    marketId: number,
    onChange: (feed: PriceFeed) => void,
  ): Unsubscribe {
    return subscribe(
      this.connection,
      this.addresses.priceFeed(marketId),
      decodePriceFeed,
      onChange,
    );
  }

  subscribeStats(onChange: (stats: Stats) => void): Unsubscribe {
    return subscribe(
      this.connection,
      this.addresses.stats,
      decodeStats,
      onChange,
    );
  }
}

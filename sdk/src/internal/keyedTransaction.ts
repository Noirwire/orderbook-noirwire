import type {
  Connection,
  Keypair,
  TransactionInstruction,
} from "@solana/web3.js";
import { signed } from "../transactions.js";
import type { BlockhashCache } from "./blockhashes.js";

const refusedForItsBlockhash = (error: unknown) =>
  /blockhash not found/i.test(error instanceof Error ? error.message : "");

/**
 * One order-key instruction, with its compute request when it has one, as a
 * signed transaction, sent with preflight skipped: the private endpoint
 * refuses simulation of what it would refuse to send.
 */
export class KeyedTransaction {
  private constructor(
    private readonly connection: Connection,
    private readonly blockhashes: BlockhashCache,
    private readonly instructions: TransactionInstruction[],
    private readonly orderKey: Keypair,
    private raw: Buffer,
  ) {}

  /** Signed with the kept blockhash, so signing asks the network for nothing. */
  static async signedWith(
    connection: Connection,
    blockhashes: BlockhashCache,
    instructions: TransactionInstruction[],
    orderKey: Keypair,
  ): Promise<KeyedTransaction> {
    const { raw } = await signed(
      connection,
      instructions,
      orderKey,
      [],
      await blockhashes.current(),
    );
    return new KeyedTransaction(
      connection,
      blockhashes,
      instructions,
      orderKey,
      raw,
    );
  }

  /** Sends the bytes as they were last signed. The program runs them once. */
  resend(): Promise<string> {
    return this.connection.sendRawTransaction(this.raw, {
      skipPreflight: true,
    });
  }

  /** Sends, and signs and sends once more if the network has forgotten the kept blockhash. */
  send(): Promise<string> {
    return this.resend().catch(async (error) => {
      if (!refusedForItsBlockhash(error)) throw error;
      const { raw } = await signed(
        this.connection,
        this.instructions,
        this.orderKey,
        [],
        await this.blockhashes.refresh(),
      );
      this.raw = raw;
      return this.resend();
    });
  }
}

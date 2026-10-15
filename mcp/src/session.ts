import { Connection, PublicKey, type Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import {
  Addresses,
  OrderKeyManager,
  TraderClient,
  decodeExchange,
  decodeView,
  privateConnection,
  type View,
} from "@noirwire/orderbook";
import { tokenSlots, type TokenSlot } from "./account.js";
import type { Config } from "./config.js";
import { fetchDeployment, type Deployment } from "./deployment.js";
import { deriveOrderSeed } from "./keys.js";
import { assertDevnetGenesis } from "./network.js";
import { messageOf, worthRetrying } from "./outcomes.js";
import { loadCheckpoint, saveCheckpoint } from "./storage.js";

/** A signed-in trader: the owner, a client holding its order keys, and what the deployment says. */
export type Session = {
  owner: Keypair;
  client: TraderClient;
  deployment: Deployment;
  tokens: TokenSlot[];
  /** Keeps the order keys' position on disk for the next session. */
  saveCheckpoint(): void;
  close(): void;
};

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** The order keys the view holds, from the saved checkpoint, else by search; fresh keys when there is no view. */
function orderKeysFor(
  seed: Uint8Array,
  view: View | null,
  checkpointPath: string,
): OrderKeyManager {
  if (!view) return OrderKeyManager.fresh(seed);
  const checkpoint = loadCheckpoint(checkpointPath);
  if (checkpoint) {
    try {
      return OrderKeyManager.restore(seed, view, checkpoint);
    } catch {
      log(
        "the saved order key checkpoint no longer matches the account; searching instead",
      );
    }
  }
  return OrderKeyManager.fromView(seed, view);
}

/**
 * Fetches the deployment (refusing anything but a test network), signs in
 * to its rollup as the owner, recovers the order keys and waits until the
 * client is ready. The signed-in connection both sends and reads.
 */
export async function buildSession(
  config: Config,
  owner: Keypair,
): Promise<Session> {
  const deployment = await fetchDeployment(config.simUrl);
  assertDevnetGenesis(
    await new Connection(deployment.solanaRpcUrl).getGenesisHash(),
  );
  const seed = deriveOrderSeed(owner);
  const programId = new PublicKey(deployment.programId);

  const reader = await privateConnection(
    deployment.rollupRpcUrl,
    owner.publicKey,
    async (message) => nacl.sign.detached(message, owner.secretKey),
  );

  const viewAccount = await reader.getAccountInfo(
    new Addresses(programId).view(owner.publicKey),
  );
  const view = viewAccount ? decodeView(viewAccount.data) : null;
  const keys = orderKeysFor(seed, view, config.checkpointPath);

  const client = new TraderClient(
    reader,
    reader,
    owner.publicKey,
    keys,
    programId,
  );
  await client.ready();

  const exchange = await new Connection(
    deployment.rollupRpcUrl,
    "confirmed",
  ).getAccountInfo(new PublicKey(deployment.exchange));
  if (!exchange)
    throw new Error("the exchange account is not readable on the rollup");
  const tokens = tokenSlots(
    decodeExchange(exchange.data).tokens.map((token) => token.mint.toBase58()),
    deployment,
  );

  return {
    owner,
    client,
    deployment,
    tokens,
    saveCheckpoint: () =>
      saveCheckpoint(config.checkpointPath, keys.checkpoint),
    close: () => client.close(),
  };
}

/**
 * Builds the session on first use and keeps it. Calls run one at a time, so
 * a rebuild can never happen while another keyed call holds an order key.
 *
 * A session that fails to build is built once more. A call that has started
 * is never repeated, because its instruction may already have run; only a
 * call that says it is safe to repeat (`repeatable`: a read, or a copy of
 * the seat into the view) is tried again on a rebuilt session, once.
 *
 * The order keys' checkpoint is saved after every call. A save that fails
 * never fails the call: it is logged and kept as a warning for the tool's
 * answer.
 */
export class SessionHost {
  private current?: Promise<Session>;
  private tail: Promise<unknown> = Promise.resolve();
  private warnings: string[] = [];

  constructor(private readonly build: () => Promise<Session>) {}

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => {});
    return result;
  }

  private open(): Promise<Session> {
    this.current ??= this.build();
    this.current.catch(() => {
      this.current = undefined;
    });
    return this.current;
  }

  private replace(): Promise<Session> {
    this.close();
    return this.open();
  }

  private async attempt<T>(
    session: Session,
    call: (session: Session) => Promise<T>,
  ): Promise<T> {
    try {
      return await call(session);
    } finally {
      try {
        session.saveCheckpoint();
      } catch (error) {
        const detail = messageOf(error);
        log(`could not save the order key checkpoint: ${detail}`);
        this.warnings.push(
          `The order key checkpoint could not be saved (${detail}). The account still works; the next start searches for the keys instead.`,
        );
      }
    }
  }

  /** Ends the current session and builds a new one, as after the account was opened. */
  rebuild(): Promise<Session> {
    return this.exclusive(() => this.replace());
  }

  run<T>(
    call: (session: Session) => Promise<T>,
    options: { repeatable?: boolean } = {},
  ): Promise<T> {
    return this.exclusive(async () => {
      let session: Session;
      try {
        session = await this.open();
      } catch (error) {
        if (!worthRetrying(error)) throw error;
        session = await this.replace();
      }
      try {
        return await this.attempt(session, call);
      } catch (error) {
        if (!options.repeatable || !worthRetrying(error)) throw error;
        return this.attempt(await this.replace(), call);
      }
    });
  }

  /** The warnings gathered since they were last taken. */
  takeWarnings(): string[] {
    const taken = this.warnings;
    this.warnings = [];
    return taken;
  }

  close(): void {
    const ending = this.current;
    this.current = undefined;
    void ending?.then((session) => session.close()).catch(() => {});
  }
}

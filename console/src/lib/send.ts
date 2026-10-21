import {
  Connection,
  Transaction,
  type PublicKey,
  type TransactionInstruction,
} from "@solana/web3.js";
import { privateConnection, type SignMessage } from "@noirwire/orderbook";
import { stillTheNetwork, type Expected } from "./identity";

export type Signer = {
  publicKey: PublicKey;
  signTransaction: (transaction: Transaction) => Promise<Transaction>;
  signMessage?: SignMessage;
};

/**
 * Why `signed` is not the transaction that was reviewed, or null when it is:
 * the same message byte for byte (the one instruction, its accounts, the fee
 * payer and the blockhash), and a valid signature of the fee payer over it.
 * A wallet that adds a compute budget, a priority fee or a guard instruction
 * of its own changes the message, and nothing is sent.
 */
export function signedDiffers(
  reviewed: Uint8Array,
  feePayer: PublicKey,
  signed: Transaction,
): string | null {
  if (!signed.feePayer?.equals(feePayer)) {
    return `the wallet made ${signed.feePayer?.toBase58() ?? "no key"} the fee payer, not ${feePayer.toBase58()}`;
  }
  if (!Buffer.from(signed.serializeMessage()).equals(Buffer.from(reviewed))) {
    return "the wallet changed the transaction it was given: an instruction, an account or the blockhash is not what was reviewed";
  }
  if (!signed.verifySignatures(true)) {
    return "the wallet's signature does not verify over the reviewed transaction";
  }
  return null;
}

const signedIn = new Map<string, Promise<Connection>>();

/**
 * The connection a send goes through. A private endpoint takes a
 * transaction only from a signed-in caller, so there the wallet signs the
 * endpoint's challenge once per session, as the ops scripts sign in their
 * keys; any other endpoint needs no sign-in.
 */
export function sendingConnection(
  url: string,
  privateUrl: string,
  signer: Signer,
): Promise<Connection> {
  if (url !== privateUrl)
    return Promise.resolve(new Connection(url, "confirmed"));
  const { signMessage } = signer;
  if (!signMessage) {
    return Promise.reject(
      new Error(
        "This wallet cannot sign a message, which the private endpoint's sign-in needs.",
      ),
    );
  }
  const key = `${url} ${signer.publicKey.toBase58()}`;
  const known = signedIn.get(key);
  if (known) return known;
  const connection = privateConnection(
    url,
    signer.publicKey,
    signMessage,
  ).catch((error: Error) => {
    signedIn.delete(key);
    throw error;
  });
  signedIn.set(key, connection);
  return connection;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Signs `instruction` with the wallet as fee payer and sends it, then waits
 * for its status the way the client's `sendAndConfirm` does: asked less and
 * less often, down to once a second. Right before the wallet signs, the
 * network is read again (`stillTheNetwork`); what the wallet hands back is
 * sent only when it is the reviewed transaction (`signedDiffers`). Resolves
 * to the signature, or throws with the program's logs.
 */
export async function sendSigned(
  connection: Connection,
  instruction: TransactionInstruction,
  signer: Signer,
  expected: Expected,
  timeoutMs = 60_000,
): Promise<string> {
  const latest = await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({
    feePayer: signer.publicKey,
    ...latest,
  }).add(instruction);
  const reviewed = transaction.serializeMessage();
  await stillTheNetwork(expected);
  const signed = await signer.signTransaction(transaction);
  const differs = signedDiffers(reviewed, signer.publicKey, signed);
  if (differs) throw new Error(`${differs}. Nothing was sent.`);
  const signature = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: true,
  });
  const deadline = Date.now() + timeoutMs;
  let pollMs = 100;
  while (Date.now() < deadline) {
    const { value } = await connection.getSignatureStatus(signature);
    if (value && value.confirmationStatus !== "processed") {
      if (!value.err) return signature;
      const landed = await connection
        .getTransaction(signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        })
        .catch(() => null);
      const logs = landed?.meta?.logMessages ?? [];
      throw new Error(`${JSON.stringify(value.err)}\n${logs.join("\n")}`);
    }
    await sleep(pollMs);
    pollMs = Math.min(1_000, pollMs * 1.5);
  }
  throw new Error(
    `transaction ${signature} was not confirmed in ${timeoutMs} ms`,
  );
}

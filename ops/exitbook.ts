/**
 * The record of an exit in progress, kept with the keys, so a send whose
 * answer was lost is never followed by a second one for the same tokens.
 *
 * An exit moves tokens in two places that cannot be made one transaction: the
 * seat's withdrawal into the owner's token account in the rollup, and the
 * shuttle (or the withdrawal of a balance handed back) on Solana. Either send
 * can land while the answer is lost, and a run that then builds another
 * withdrawal pays out twice, from the seat or from a rollup balance that held
 * more than the amount asked. So each send is written down before it is
 * broadcast, and a later run reconciles what was written against the chain
 * before it builds anything: the rollup balance for the seat's withdrawal, the
 * signature's status on Solana, derived locally from the signed transaction,
 * for the Solana send.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import type { Connection, PublicKey } from "@solana/web3.js";
import { pendingVerdict, type SentRecord } from "./launch";

/** One transaction signed for Solana that moves the tokens, as it was written before it was broadcast. */
export type SolanaSend = {
  /** The transaction's own first signature, derived from the signed bytes. */
  signature: string;
  /** After this block height the transaction can no longer land. */
  lastValidBlockHeight: number;
  /** Which step it is: `shuttle` or `withdraw`. */
  step: string;
  at: string;
  /** The owner's token account on Solana before it, and what it was to move, in atoms as decimal text. */
  before: string;
  moved: string;
  /** Set once any read saw it as processed: it is then never dropped on a later missing status. */
  everProcessed?: boolean;
};

/** The seat's withdrawal into the rollup, recorded before it was sent. */
export type SeatSend = SentRecord & {
  /** The owner's token account in the rollup before it, in atoms as decimal text. */
  before: string;
};

export type ExitOperation = {
  id: string;
  owner: string;
  /** The amount asked for, in atoms as decimal text, and the method. */
  atoms: string;
  method: string;
  seat?: SeatSend;
  solana: SolanaSend[];
};

/** Where an owner's exit is recorded, under the keys folder. */
export const exitBookPath = (
  keysDir: string,
  network: string,
  owner: PublicKey,
) => join(keysDir, `${network}-exit-${owner.toBase58()}.json`);

export function readExit(path: string): ExitOperation | null {
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as ExitOperation)
    : null;
}

/** Writes the record beside the path and renames it, so a crash never leaves half a file. */
export function writeExit(path: string, operation: ExitOperation): void {
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.partial`;
  writeFileSync(partial, `${JSON.stringify(operation, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(partial, path);
}

export function clearExit(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

/** Whether the operation has sent anything that may have moved tokens. */
const sentSomething = (operation: ExitOperation) =>
  operation.seat !== undefined || operation.solana.length > 0;

/**
 * The operation to carry on: the one recorded for this owner when it asked for
 * the same amount by the same method, a new one when none was recorded or the
 * recorded one sent nothing, and a refusal when an unfinished one asked for
 * something else, since carrying on with different figures would hide what
 * the first sent.
 */
export function exitOperation(
  recorded: ExitOperation | null,
  asked: { id: string; owner: string; atoms: bigint; method: string },
): ExitOperation {
  if (recorded && sentSomething(recorded)) {
    if (
      recorded.atoms !== asked.atoms.toString() ||
      recorded.method !== asked.method
    ) {
      throw new Error(
        `An earlier exit of this owner (operation ${recorded.id}) asked for ${recorded.atoms} atoms by ${recorded.method} and sent something that may have landed. ` +
          "Finish it first: run this again with that amount and method. If the chain shows it all done, delete its record file, which the exit prints the path of. Nothing was sent.",
      );
    }
    return recorded;
  }
  return {
    id: asked.id,
    owner: asked.owner,
    atoms: asked.atoms.toString(),
    method: asked.method,
    solana: [],
  };
}

/**
 * What to do about the seat's withdrawal given the record and the owner's
 * token account in the rollup now: `send` it, take it as `landed` and go on, or
 * `ask`. A pending record whose send was answered by a lost response is
 * judged by the rollup: the balance rose by the amount, so it landed. If it
 * did not, it may not have yet, so the operator answers
 * `EXIT_SENT=landed:<id>` or `lost:<id>` after looking, like every send that
 * moves money.
 */
export function seatVerdict(
  seat: SeatSend | undefined,
  atoms: bigint,
  rollupNow: bigint,
  answer: string | undefined,
): "send" | "landed" | "ask" {
  if (!seat) return "send";
  if (seat.state === "landed") return "landed";
  if (rollupNow >= BigInt(seat.before) + atoms) return "landed";
  const verdict = pendingVerdict(seat, answer);
  return verdict === "done" ? "landed" : verdict;
}

/** The refusal for a seat withdrawal that may have landed and cannot be shown to have. */
export function seatPendingRefusal(seat: SeatSend, rollupNow: bigint): string {
  const id = seat.id ?? seat.at;
  return (
    `The seat's withdrawal was sent at ${seat.at} and its outcome is not known (record ${id}): the owner's token account in the rollup holds ${rollupNow} atoms, ` +
    `${seat.before} before it. A second withdrawal could pay the amount out twice. Look at the owner's balance in the rollup again in a minute and at the signatures it printed; ` +
    `then run again with EXIT_SENT=landed:${id} if it landed or EXIT_SENT=lost:${id} if it did not. Nothing was sent.`
  );
}

/** How a Solana send stands. */
export type SolanaVerdict = "landed" | "failed" | "safe" | "wait";

/**
 * Where a transaction written down before its broadcast stands: `landed`,
 * `failed` (it ran and was refused, so it moved nothing), `safe` (it is not
 * there and its blockhash has expired, so it can never be included) or `wait`
 * (it may still land). A send seen as `processed` without an error is marked
 * `everProcessed` (on the record the caller passes, which the caller must
 * save) and is never dropped on its own afterwards, whatever a later read
 * says, since a lagging node may answer null for an execution another node
 * saw: it waits until it is confirmed or the operator answers
 * `EXIT_SENT=landed:<signature>`. No answer releases it for a second send.
 * Only the first three allow a run to go on; a read that fails throws, and
 * nothing is sent on a guess.
 */
export async function solanaVerdict(
  connection: Pick<Connection, "getSignatureStatus" | "getBlockHeight">,
  send: Pick<
    SolanaSend,
    "signature" | "lastValidBlockHeight" | "everProcessed"
  >,
  answer?: string,
): Promise<SolanaVerdict> {
  const { value } = await connection.getSignatureStatus(send.signature, {
    searchTransactionHistory: true,
  });
  if (value) {
    if (value.err) return "failed";
    if (value.confirmationStatus !== "processed") return "landed";
    send.everProcessed = true;
  }
  if (send.everProcessed) {
    return answer === `landed:${send.signature}` ? "landed" : "wait";
  }
  const height = await connection.getBlockHeight("confirmed");
  return height > send.lastValidBlockHeight ? "safe" : "wait";
}

/** The refusal for a Solana send that may still land. */
export function solanaPendingRefusal(send: SolanaSend, height: number): string {
  if (send.everProcessed) {
    return (
      `The ${send.step} transaction ${send.signature} was broadcast at ${send.at} and was seen as processed, not confirmed, so it may still confirm even once its blockhash has expired (block height ${send.lastValidBlockHeight}, ${height} now). ` +
      `Look at the signature on an explorer and at the owner's balances. If it landed, run again with EXIT_SENT=landed:${send.signature}. If it is gone for good (finalized chain without it, balances unchanged), delete the exit record file by hand: no answer releases it. Nothing was sent.`
    );
  }
  return (
    `The ${send.step} transaction ${send.signature} was broadcast at ${send.at}, is not on Solana yet and can still land until block height ${send.lastValidBlockHeight} (it is ${height} now). ` +
    "Building another could send the tokens twice. Wait until the height has passed, then run this again: it will find the transaction landed or expired. Nothing was sent."
  );
}

import {
  Keypair,
  PublicKey,
  type Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { Instructions, bytesEqual } from "@noirwire/orderbook";

/** The funding transaction is not the one the service promised, so it was not signed. */
export class FundingRefused extends Error {
  constructor(reason: string) {
    super(`Refused to sign the funding transaction: ${reason}`);
    this.name = "FundingRefused";
  }
}

const U64_BYTES = 8;
/** Positions in a deposit's accounts that name the token's custody authority, its custody account and the depositor's token account. */
const DEPOSIT_CUSTODY_AUTHORITY = 4;
const DEPOSIT_CUSTODY = 5;
const DEPOSIT_SOURCE = 6;

function sameAccounts(
  actual: TransactionInstruction,
  expected: TransactionInstruction,
  skip: number[],
): boolean {
  return (
    actual.keys.length === expected.keys.length &&
    actual.keys.every(
      (key, at) =>
        skip.includes(at) || key.pubkey.equals(expected.keys[at].pubkey),
    )
  );
}

/**
 * Checks, before the owner signs, that a transaction from the service does
 * only what funding promises: the service pays the fee, `open_trader` opens
 * the owner's account with exactly the order keys that were sent, and a
 * deposit into that account's collateral follows. Both instructions belong
 * to the order book program, the owner signs only `open_trader`, and
 * nothing else is in the transaction: no transfer, nothing that moves the
 * owner's funds.
 */
export function verifyFundingTransaction(
  transaction: Transaction,
  expected: { owner: PublicKey; orderKeys: PublicKey[]; programId: PublicKey },
): void {
  const { owner, orderKeys, programId } = expected;
  const { feePayer, instructions } = transaction;
  if (!feePayer) throw new FundingRefused("it names no fee payer");
  if (feePayer.equals(owner)) {
    throw new FundingRefused("it makes the owner pay the fee");
  }
  if (instructions.length !== 2) {
    throw new FundingRefused(
      `it has ${instructions.length} instructions, not the two that funding needs`,
    );
  }
  if (!instructions.every((each) => each.programId.equals(programId))) {
    throw new FundingRefused(
      "an instruction targets a program other than the order book",
    );
  }

  const [open, deposit] = instructions;
  const builder = new Instructions(programId);
  const wantedOpen = builder.openTrader(feePayer, owner, orderKeys);
  if (
    !sameAccounts(open, wantedOpen, []) ||
    !bytesEqual(open.data, wantedOpen.data)
  ) {
    throw new FundingRefused(
      "the first instruction is not open_trader for this owner with these order keys",
    );
  }

  const wantedDeposit = builder.deposit(
    deposit.keys[0]?.pubkey ?? feePayer,
    deposit.keys[DEPOSIT_SOURCE]?.pubkey ?? feePayer,
    { mint: Keypair.generate().publicKey, custodyNonce: 0n },
    owner,
    { collateral: true },
    0n,
  );
  const prefix = (data: Uint8Array) =>
    data.subarray(0, data.length - U64_BYTES);
  if (
    !sameAccounts(deposit, wantedDeposit, [
      0,
      DEPOSIT_CUSTODY_AUTHORITY,
      DEPOSIT_CUSTODY,
      DEPOSIT_SOURCE,
    ]) ||
    deposit.data.length !== wantedDeposit.data.length ||
    !bytesEqual(prefix(deposit.data), prefix(wantedDeposit.data))
  ) {
    throw new FundingRefused(
      "the second instruction is not a deposit into this owner's collateral",
    );
  }
  const message = transaction.compileMessage();
  const signers = message.accountKeys
    .slice(0, message.header.numRequiredSignatures)
    .map((key) => key.toBase58());
  const allowed = new Set(
    [feePayer, deposit.keys[0].pubkey, owner].map((key) => key.toBase58()),
  );
  if (
    signers.length !== allowed.size ||
    !signers.every((signer) => allowed.has(signer))
  ) {
    throw new FundingRefused(
      "it needs signatures from keys other than the service's and the owner's",
    );
  }
  if (deposit.keys.some((key) => key.pubkey.equals(owner))) {
    throw new FundingRefused("the deposit involves the owner's own key");
  }
}

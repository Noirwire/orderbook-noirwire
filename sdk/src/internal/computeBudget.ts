import {
  ComputeBudgetProgram,
  type TransactionInstruction,
} from "@solana/web3.js";

/** The most compute one transaction may ask for. */
export const MAX_COMPUTE_UNITS = 1_400_000;

/**
 * `instruction` followed by a request for the most compute, for an instruction
 * whose work grows with the book. The request names no account to sign, so the
 * signers stay those of `instruction`.
 */
export function withMostCompute(
  instruction: TransactionInstruction,
): TransactionInstruction[] {
  return [
    instruction,
    ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_COMPUTE_UNITS }),
  ];
}

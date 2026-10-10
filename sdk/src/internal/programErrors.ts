/** Codes from the program's error list, as a failed transaction reports them. */
export const PROGRAM_ERROR = {
  alreadyReady: 6120,
  invalidGrowth: 6122,
  expired: 6133,
  expiryTooFar: 6134,
} as const;

/** The program's error number in the status of a failed transaction, when it has one. */
export function programErrorCode(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const { InstructionError: failed } = err as { InstructionError?: unknown };
  const detail: unknown = Array.isArray(failed) ? failed[1] : undefined;
  if (typeof detail !== "object" || detail === null) return null;
  const { Custom: code } = detail as { Custom?: unknown };
  return typeof code === "number" ? code : null;
}

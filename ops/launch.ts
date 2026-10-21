/**
 * What the ops scripts decide around the launch, apart from the network so it
 * can be checked without one: whether a send that may have landed is sent
 * again, when the smoke may run and raise a cap, and the whole tokens a
 * variable names. The launch steps, the market check and the mark check are
 * the client's operator functions, re-exported here for the scripts.
 */
import type { Profile } from "../sdk/dist/operator/index.js";

export {
  gapBps,
  launchReferenceSources,
  launchSteps,
  quoteBoundAsLaunched,
  resumeVerdict,
  settingsDiffer,
  type LaunchObserved,
  type LaunchStep,
} from "../sdk/dist/operator/index.js";

/**
 * A send that moves money or cannot be repeated safely, recorded before it is
 * sent and again once it landed, so a run that stops in between leaves it
 * pending instead of forgotten.
 */
export type SentRecord = { state: "pending" | "landed"; at: string };

/**
 * What to do about a recorded send, given the operator's answer for a pending
 * one (`landed` or `lost`): send it, take it as done, or stop and ask.
 */
export function pendingVerdict(
  record: SentRecord | undefined,
  answer: string | undefined,
): "send" | "done" | "ask" {
  if (!record) return "send";
  if (record.state === "landed" || answer === "landed") return "done";
  return answer === "lost" ? "send" : "ask";
}

/**
 * Whether a failed send's error says the network ran it and refused it, so
 * it changed nothing. A timeout or a dropped connection says nothing of the
 * kind: that transaction may still land.
 */
export const refusedOnChain = (message: string) => /^[{"]/.test(message);

/**
 * Why the smoke may not run, or null. On mainnet it deposits the admin's
 * USDC into two seats and trades them against each other on the public tape,
 * so it asks for its own yes beyond the one that reaches mainnet.
 */
export function smokeRefusal(
  mainnet: boolean,
  confirmed: boolean,
): string | null {
  if (!mainnet || confirmed) return null;
  return (
    "On mainnet the smoke deposits real USDC of the admin's into two seats and trades them " +
    "against each other on the public tape: run it again with MAINNET_SMOKE=yes. Nothing was sent."
  );
}

/**
 * Whether the smoke raises a custody cap that refused its deposit: on a
 * rehearsal, never on mainnet, where a cap goes up only by the operator's
 * decision.
 */
export const smokeRaisesCap = (on: { profile: Profile; mainnet: boolean }) =>
  on.profile === "mainnet" && !on.mainnet;

/** `amount` whole tokens, from a variable, in atoms of a token of `decimals`; null when it is not set. */
export function atomsOf(
  amount: string | undefined,
  decimals: number,
): bigint | null {
  if (amount === undefined || amount === "") return null;
  if (!/^\d+$/.test(amount)) {
    throw new Error(`${amount} is not a whole number of tokens`);
  }
  return BigInt(amount) * 10n ** BigInt(decimals);
}

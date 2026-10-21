/**
 * The launch steps as the console shows them. What the launch is and how it
 * decides (its market and settings, the order of the steps, which are left,
 * and the check before `resume_market`) is the ops scripts' own code,
 * imported from `ops/profiles.ts` and `ops/launch.ts`, so the console and
 * `make rehearsal-setup` decide with the same functions.
 */
import type { MarketParams, SourceBinding } from "@noirwire/orderbook";
import {
  LAUNCH_STEPS,
  launchSteps,
  settingsDiffer,
  type LaunchObserved,
  type LaunchStep,
} from "@ops/launch";
import { MAINNET_MARKET, MAINNET_MAX_SEATS_PER_DAY } from "@ops/profiles";

/** Every way `found` differs from the launch's market, or that it is missing. Empty when it is that market. */
export function launchMarketDiffers(
  found: { params: MarketParams; binding: SourceBinding | null } | null,
): string[] {
  const { symbol, settings } = MAINNET_MARKET;
  if (!found) return [`${symbol} is not set up`];
  if (!found.binding) return [`${symbol} has no price feed`];
  return settingsDiffer(
    { params: found.params, binding: found.binding },
    settings,
  );
}

/**
 * The check before `resume_market` as the console's server answers it,
 * numbers as decimal text, with the network, program and genesis it was made
 * on, which the page compares with its own before it builds the instruction.
 */
export type ResumeCheckAnswer = {
  network: string | null;
  programId: string | null;
  genesis: string | null;
  resume: boolean;
  why: string | null;
  mark: string | null;
  reference: string | null;
  gapBps: string | null;
  sources: string[];
  covered: string | null;
  openInterestCap: string | null;
};

/** What the chain shows of one step: done, pending, or kept where the public cannot read it. */
export type StepState = "done" | "pending" | "not public";

export type StepRow = {
  step: LaunchStep;
  title: string;
  state: StepState;
  detail: string;
  /** The command that takes a pending step, with the variables it reads. */
  command: string | null;
};

const TITLES: Record<LaunchStep, string> = {
  seatsPerDay: `Daily seat cap of ${MAINNET_MAX_SEATS_PER_DAY}`,
  quoteToken: "Quote token registered, custody cap 0",
  ledger: "Ledger and stats",
  market: "SOL-PERP created, bound to Pyth SOL/USD",
  quoteSource: "USDC guard bound to Pyth USDC/USD",
  syncQuote: "USDC guard's first observation",
  syncPrice: "SOL-PERP's first mark",
  funding: "Funding scheduled",
  adminFunds: "Admin's USDC moved into the rollup",
  insurance: "Insurance funded",
  custodyCap: "First custody cap",
  keeper: "Liquidation keeper's seat, funded",
  checkMark: "Mark checked against the reference price",
  resume: "SOL-PERP resumed",
};

/**
 * What the public accounts cannot show, and why. The setup itself knows: it
 * records each one-shot send with the keys, and takes such a step only when
 * it is not done.
 */
const NOT_PUBLIC: Partial<Record<LaunchStep, string>> = {
  funding:
    "The funding task lives in the rollup's scheduler; the setup records its task id in the deployment description and skips the step once it is there.",
  adminFunds:
    "What insurance and the keeper's seat still need is in the sealed ledger; the setup reads it as the admin and the keeper.",
  insurance:
    "The insurance seat is in the sealed ledger; the setup records the amount it sent and never sends it twice.",
  keeper:
    "The keeper's view is private to the keeper; the setup reads it with the keeper's key and tops the seat up to KEEPER_DEPOSIT whole USDC when given one.",
};

/** The variables a pending step's command reads, beside the setup target. */
const VARIABLES: Partial<Record<LaunchStep, string>> = {
  custodyCap: "CUSTODY_CAP=<whole USDC>",
  resume: "RESUME_MARKET=yes",
};

/**
 * Every launch step, in order, as the chain shows it, with the command for
 * each pending one. A step the public cannot read gets no command of its own:
 * the setup takes it, with the variables beside it, when it is not done.
 */
export function launchRows(
  observed: Omit<LaunchObserved, "resumeConfirmed">,
  details: Partial<Record<LaunchStep, string>>,
  setup: string,
): StepRow[] {
  const pending = new Set(launchSteps({ ...observed, resumeConfirmed: true }));
  return LAUNCH_STEPS.map((step) => {
    const hidden = NOT_PUBLIC[step];
    const state: StepState = !pending.has(step)
      ? "done"
      : hidden
        ? "not public"
        : "pending";
    const variables = VARIABLES[step];
    return {
      step,
      title: TITLES[step],
      state,
      detail: state === "not public" ? (hidden ?? "") : (details[step] ?? ""),
      command:
        state !== "pending"
          ? null
          : variables
            ? `${setup} ${variables}`
            : setup,
    };
  });
}

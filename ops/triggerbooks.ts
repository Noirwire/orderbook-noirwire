/**
 * What the trigger-books command decides, apart from the network so it can be
 * checked without one: whether it was asked to send, what a market's trigger
 * book is in from the program's own refusal, and which markets it sets up.
 */
import { DRY_RUN_LINE, applyRequested } from "./administering";
import { errorCode } from "./upkeep";

export type TriggerBookRequest = {
  /** The operator asked to send it (`APPLY=yes`); without it the command only shows the plan. */
  apply: boolean;
};

/** Whether the run sends: only `APPLY=yes`. Anything else that is set is refused rather than read as a dry run. */
export function triggerBookRequest(settings: {
  APPLY?: string;
}): TriggerBookRequest {
  return { apply: applyRequested(settings) };
}

/**
 * Where a market's trigger book stands. `missing` has no account, `partial`
 * has one that is not yet its full size, `grown` is full size and waits to be
 * finalised, and `ready` is finalised.
 */
export type TriggerBookState = "missing" | "partial" | "grown" | "ready";

const ACCOUNT_MISSING = 6114;
const WRONG_OWNER = 6115;
const WRONG_SIZE = 6118;
const ALREADY_READY = 6120;

const PLAN: Record<TriggerBookState, string> = {
  missing: "missing: it will be created, grown and finalised",
  partial: "partly grown: it will be grown to its full size and finalised",
  grown: "full size and not finalised: it will be finalised",
  ready: "ready",
};

/**
 * The state a trigger book is in, from what `finalize_trigger_book` would
 * fail with when simulated, or null when it would succeed. The book is sealed,
 * so its bytes cannot be read: the program's refusals say where it stands. An
 * account that is not there is not owned by the program, one that is there and
 * not its full size for the ledger's seats has the wrong size, a finalised one
 * is already ready, and one that succeeds is full size and still unfinalised.
 * An account at the book's address that another program owns cannot be
 * created over, so it stops the run. Any other refusal is thrown, so an
 * answer this command does not know stops it rather than being read as a
 * state.
 */
export function triggerBookStateOf(
  refusal: string | null,
  marketId: number,
): TriggerBookState {
  if (refusal === null) return "grown";
  const code = errorCode(refusal);
  if (code === ALREADY_READY) return "ready";
  if (code === WRONG_SIZE) return "partial";
  if (code === ACCOUNT_MISSING) return "missing";
  if (code === WRONG_OWNER) {
    throw new Error(
      `Market ${marketId}'s trigger book address holds an account owned by another program, so a trigger book cannot be created there. Nothing was sent.`,
    );
  }
  throw new Error(
    `finalize_trigger_book would fail with ${refusal}, which this command does not know how to read. Nothing was sent.`,
  );
}

export type TriggerBookRun = {
  /** The perp markets the exchange has. */
  marketIds: number[];
  /** Where one market's trigger book stands now. */
  stateOf: (marketId: number) => Promise<TriggerBookState>;
  /** Creates, grows and finalises one market's trigger book. */
  setUp: (marketId: number) => Promise<void>;
  apply: boolean;
  say: (label: string, value: string) => void;
};

/**
 * Shows each market's trigger book and, with `apply`, sets up those that are
 * not ready, then reads every one of them again and throws if any is still
 * not ready. Returns the markets it sent for, none when everything was ready
 * or the run was a dry run.
 */
export async function runTriggerBooks(run: TriggerBookRun): Promise<number[]> {
  const states = new Map<number, TriggerBookState>();
  for (const id of run.marketIds) {
    const state = await run.stateOf(id);
    states.set(id, state);
    run.say(`market ${id} trigger book`, PLAN[state]);
  }
  const pending = run.marketIds.filter((id) => states.get(id) !== "ready");
  if (pending.length === 0) {
    run.say("trigger books", "all ready. Nothing to send.");
    return [];
  }
  if (!run.apply) {
    run.say("trigger books", DRY_RUN_LINE);
    return [];
  }
  for (const id of pending) {
    await run.setUp(id);
  }
  const notReady: string[] = [];
  for (const id of pending) {
    const state = await run.stateOf(id);
    if (state === "ready") {
      run.say(`market ${id} trigger book`, "ready");
    } else {
      notReady.push(`market ${id} is ${state}`);
    }
  }
  if (notReady.length > 0) {
    throw new Error(
      `A trigger book is still not ready after it was set up: ${notReady.join("; ")}. Run the command again; it repeats only what is left.`,
    );
  }
  return pending;
}

/**
 * What the ops scripts decide around the launch, apart from the network so it
 * can be checked without one: whether a send that may have landed is sent
 * again, when the smoke may run, and the whole tokens a variable names. The launch steps, the market check and the mark check are
 * the client's operator functions, re-exported here for the scripts.
 */
import { type PublicKey } from "@solana/web3.js";
import {
  QUOTE_DECIMALS,
  ownerKey,
  resumeVerdict,
  type Profile,
  type ResumeCheck,
} from "../sdk/dist/operator/index.js";
import type { DeploymentDescription } from "./deployment";
import { CUSTODY_CAP_REACHED, NO_SEAT, wholeTokens } from "./funding";
import { errorCode } from "./upkeep";

export {
  gapBps,
  launchReferenceSources,
  launchSteps,
  leftAsFound,
  quoteBoundAsLaunched,
  restorableStep,
  resumeVerdict,
  settingsDiffer,
  type LaunchObserved,
  type LaunchStep,
  type RestorableStep,
} from "../sdk/dist/operator/index.js";

/**
 * A send that moves money or cannot be repeated safely, recorded before it is
 * sent and again once it landed, so a run that stops in between leaves it
 * pending instead of forgotten. `id` names this one record, so an answer
 * about it cannot be taken for an answer about the next.
 */
export type SentRecord = {
  state: "pending" | "landed";
  at: string;
  id?: string;
  /**
   * The quote atoms the send puts in, as decimal text. The keeper's deposit
   * step: the total its seat has been deposited once this send landed, so a
   * run that stopped after it landed can tell a top-up that went through from
   * one still to make. The insurance step: the atoms funded, which the
   * launch's caps are sized from, so a lost or foreign description cannot
   * make a later run size them from a default.
   */
  total?: string;
};

/** The name an answer gives a record: its id, or its time for a record written before records had one. */
export const recordId = (record: SentRecord) => record.id ?? record.at;

/**
 * What to do about a recorded send, given the operator's answer for a pending
 * one, `landed:<id>` or `lost:<id>` naming that very record: send it, take it
 * as done, or stop and ask. An answer that names no record, or another one,
 * is no answer: a `lost` kept in a shell or recalled from its history must
 * not send again after the next send that may have landed.
 */
export function pendingVerdict(
  record: SentRecord | undefined,
  answer: string | undefined,
): "send" | "done" | "ask" {
  if (!record) return "send";
  if (record.state === "landed") return "done";
  const id = recordId(record);
  if (answer === `landed:${id}`) return "done";
  return answer === `lost:${id}` ? "send" : "ask";
}

/**
 * Why `fund_insurance` must not be sent, or null: the public custody balance
 * at the quote index already holds at least the insurance this step sends,
 * which before launch only an earlier `fund_insurance` can explain. `held` is
 * null when custody is sealed and nothing public shows it, and `"unreadable"`
 * when it is public but the rollup does not serve it, which this cannot
 * judge (`insuranceFirstSendRefusal` does). An operator who knows better
 * answers `held:<atoms>` with the balance this names, so the answer stops
 * counting once the balance moves.
 */
export function insuranceHeldRefusal(
  held: CustodyHeld,
  amount: bigint,
  answer: string | undefined,
  variable: string,
): string | null {
  if (
    held === null ||
    held === "unreadable" ||
    held < amount ||
    answer === `held:${held}`
  ) {
    return null;
  }
  return (
    `The quote token's public custody already holds ${held} atoms, at least the ${amount} this step sends: ` +
    "insurance was most likely funded already, by a send that landed after all or by a run from another copy of the keys. " +
    `Look up the admin's transactions; if it was not, run again with ${variable}=held:${held}. Nothing was sent.`
  );
}

/**
 * Why the first `fund_insurance` must not be sent yet, or null. Where the
 * rollup does not serve public custody (the hosted one does not), nothing
 * can show that insurance was funded already, and a run from another copy of
 * the keys leaves no record here. With no send recorded with these keys and
 * none in the description, the operator answers `INSURANCE_FIRST_SEND=yes`
 * once, saying that no copy of these keys has funded insurance, since
 * insurance sent twice stays in the insurance seat for good.
 */
export function insuranceFirstSendRefusal(
  held: CustodyHeld,
  recorded: boolean,
  answer: string | undefined,
): string | null {
  if (held !== "unreadable" || recorded || answer === "yes") return null;
  return (
    "The rollup does not serve the custody token account, so nothing here can show whether insurance was funded already, " +
    "and no send of it is recorded with these keys or in the description. Insurance sent twice stays in the insurance seat for good. " +
    "Look up the admin's transactions on Solana and in the admin console: if no copy of these keys has funded insurance, " +
    "run again with INSURANCE_FIRST_SEND=yes on this one run, and take it out of the line afterwards. Nothing was sent."
  );
}

/**
 * The keeper's deposit the operator gave (`KEEPER_DEPOSIT`), which the mainnet
 * profile cannot do without: a market opened over a keeper seat with nothing in
 * it finds every liquidatable seat and cannot take one.
 */
export function requiredKeeperDeposit(deposit: bigint | null): bigint {
  if (deposit !== null && deposit > 0n) return deposit;
  throw new Error(
    "KEEPER_DEPOSIT is not set. The launch funds the liquidation keeper's seat, and a keeper with no collateral cannot take over a liquidatable seat: " +
      "give the whole USDC to put in it, such as KEEPER_DEPOSIT=200, and run again. Nothing was sent.",
  );
}

/**
 * Why the keeper's deposit this run names cannot stand, or null. The
 * deployment records the atoms it deposited, and `KEEPER_DEPOSIT` is the total
 * the keeper's seat is to have been given: a higher figure is a top-up of the
 * difference (`keeperShortfall`), the same figure is nothing to do, and a
 * lower one is refused, since this run takes nothing back out and would read
 * it as a deposit that was not made. `recorded` is the recorded figure as
 * decimal text, if there is one.
 */
export function keeperDepositRefusal(
  recorded: string | undefined,
  wanted: bigint,
): string | null {
  if (recorded === undefined || BigInt(recorded) <= wanted) return null;
  const atoms = 10n ** BigInt(QUOTE_DECIMALS);
  return (
    `This deployment deposited ${BigInt(recorded) / atoms} USDC into the keeper's seat, more than the KEEPER_DEPOSIT=${wanted / atoms} this run names. ` +
    `KEEPER_DEPOSIT is the total the seat is given and this run never takes any back: run with KEEPER_DEPOSIT=${BigInt(recorded) / atoms}, or more to add the difference. Nothing was sent.`
  );
}

/**
 * The atoms the keeper's seat still lacks. Once the deployment records a
 * deposit that is the difference to `wanted`, none when it is already at or
 * above it; before one, `wanted` less what the keeper's view `held`, which
 * lags the seat and so shows less than it holds, never more.
 */
export function keeperShortfall(
  recorded: string | undefined,
  wanted: bigint,
  held: bigint,
): bigint {
  const have = recorded === undefined ? held : BigInt(recorded);
  return have < wanted ? wanted - have : 0n;
}

/**
 * The keeper's deposit as the deployment should record it: the recorded
 * figure, or the total a landed deposit record stands for when that is more.
 * A deposit that landed but whose run stopped before the description was
 * written is thereby found again, so the next run does not top the seat up
 * twice. A landed record from before records carried a total stands for
 * `wanted`, and only while nothing is recorded.
 */
export function keeperDepositedAs(
  recorded: string | undefined,
  record: SentRecord | undefined,
  wanted: bigint,
): string | undefined {
  const kept = recorded === undefined ? undefined : BigInt(recorded);
  if (record?.state !== "landed") return kept?.toString();
  const total =
    record.total !== undefined
      ? BigInt(record.total)
      : kept === undefined
        ? wanted
        : undefined;
  if (total === undefined) return kept?.toString();
  return (kept !== undefined && kept > total ? kept : total).toString();
}

/**
 * The most the insurance seat can hold, in atoms. Its collateral is sealed,
 * but public custody holds every seat's collateral, so insurance is never
 * more than custody holds beyond the keeper's deposit, and before any trade
 * never more than was funded. Custody moves only on a deposit or a withdrawal,
 * so it shows tokens that left the exchange and cannot show a deficit
 * insurance paid to another seat. `held` is null where custody is sealed.
 * `stated` is what the operator read from the console (`INSURANCE_HELD`): it
 * can only lower the figure, never raise it.
 */
export function insuranceAtMost(
  funded: bigint,
  held: bigint | null,
  keeperDeposited: bigint,
  stated: bigint | null = null,
): bigint {
  const beyondKeeper =
    held === null
      ? funded
      : held > keeperDeposited
        ? held - keeperDeposited
        : 0n;
  const known = beyondKeeper < funded ? beyondKeeper : funded;
  return stated !== null && stated < known ? stated : known;
}

/**
 * What public custody showed: its balance, null where custody is sealed, or
 * `"unreadable"` where it is public but the rollup did not serve its token
 * account. Unreadable is not empty: it must never be sized as 0.
 */
export type CustodyHeld = bigint | null | "unreadable";

/**
 * The keeper's deposit as the insurance sizing counts it: the recorded
 * figure, or the collateral its view shows where nothing is recorded (a seat
 * funded before the deployment kept records).
 */
export const keeperDepositFor = (
  recorded: string | undefined,
  collateral: bigint | null,
): bigint => (recorded !== undefined ? BigInt(recorded) : (collateral ?? 0n));

/**
 * What custody holds, in words for the operator: unreadable is "not readable
 * here", never "0 atoms held", since not served and empty are different facts.
 */
export function custodyText(held: CustodyHeld): string {
  if (held === null) return "sealed, so not shown";
  if (held === "unreadable") return "not readable here";
  return `${held} atoms held`;
}

/** The refusal to size a cover from custody nobody can read, thrown apart from other errors so a run that opens nothing can go on. */
export class UnreadableInsurance extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnreadableInsurance";
  }
}

/**
 * The least collateral the keeper's seat must show before the market opens:
 * the margin one takeover of a seat at the position cap needs at the market's
 * initial margin, `position_cap` lots at the mark times `im_bps`, rounded up.
 * It is sized from that, not from the recorded `KEEPER_DEPOSIT`, because the
 * deposit is a figure chosen at launch while every takeover that loses money
 * shrinks the collateral for good: the question before opening is whether the
 * seat can carry the biggest takeover the position cap allows now.
 */
export function keeperCollateralFloor(
  positionCap: bigint,
  mark: bigint,
  imBps: number,
): bigint {
  return (positionCap * mark * BigInt(imBps) + 9_999n) / 10_000n;
}

/**
 * Why the keeper's collateral, as its view showed after the run watched it
 * write, is too little to carry a takeover at the position cap, or null. Null
 * too where the seat was not read (`collateral` null), which the keeper checks
 * report on their own.
 */
export function keeperFloorRefusal(seen: {
  collateral: bigint | null;
  positionCap: bigint;
  mark: bigint;
  imBps: number;
}): string | null {
  if (seen.collateral === null) return null;
  const floor = keeperCollateralFloor(seen.positionCap, seen.mark, seen.imBps);
  if (seen.collateral >= floor) return null;
  return (
    `the keeper's seat holds ${seen.collateral} atoms of collateral, under the ${floor} atoms that taking over one seat at the position cap needs as margin ` +
    `(${seen.positionCap} lots at a mark of ${seen.mark}, initial margin ${seen.imBps} bps): ` +
    "deposit more (raise KEEPER_DEPOSIT on setup while the admin key is here, or run the keeper-deposit target from any funded wallet), " +
    "wait for the keeper's next sweep, and run this again"
  );
}

/** Why no cover can be sized while custody is unreadable and the operator gave no figure. */
export const CUSTODY_UNREADABLE_REFUSAL =
  "The hosted rollup does not serve the custody token account, so what the exchange holds cannot be read here, " +
  "and no resume is safe on a number nobody can read. " +
  "Read the insurance the exchange holds from the admin console and run again with INSURANCE_HELD=<whole USDC>, " +
  "for example INSURANCE_HELD=3000. Nothing was sent.";

/**
 * The insurance a mark's cover is sized from, with what to tell the operator
 * about it. Readable or sealed custody sizes it by `insuranceAtMost`. Where
 * custody is unreadable only the operator's figure from the console can stand
 * in: the cover is sized from the lesser of the insurance funded and that
 * figure, with a caveat that custody could not be read, and without a figure
 * the sizing is refused. `stated` still can only lower the result.
 */
export function insuranceSizing(
  funded: bigint,
  held: CustodyHeld,
  keeperDeposited: bigint,
  stated: bigint | null,
): { atMost: bigint; notes: string[] } {
  const notes: string[] = [];
  const whole = (atoms: bigint) => atoms / 10n ** BigInt(QUOTE_DECIMALS);
  if (held === "unreadable") {
    if (stated === null)
      throw new UnreadableInsurance(CUSTODY_UNREADABLE_REFUSAL);
    const atMost = insuranceAtMost(funded, null, keeperDeposited, stated);
    notes.push(
      `CAVEAT: custody could not be read on this rollup, so the cover is sized from INSURANCE_HELD=${whole(stated)} USDC, as the operator read it from the console, ` +
        `and the ${funded} atoms funded, whichever is less (${atMost} atoms).`,
    );
    return { atMost, notes };
  }
  const atMost = insuranceAtMost(funded, held, keeperDeposited, stated);
  const fromCustody = insuranceAtMost(funded, held, keeperDeposited);
  if (fromCustody < funded) {
    notes.push(
      `Public custody holds ${held} atoms, ${fromCustody} beyond the keeper's seat, less than the ${funded} of insurance funded: ` +
        `tokens have left the exchange since, or never arrived. The cover is sized from ${fromCustody}.`,
    );
  }
  if (stated !== null && stated < fromCustody) {
    notes.push(
      `INSURANCE_HELD=${whole(stated)} USDC is below what the tooling can bound (${fromCustody} atoms): the cover is sized from ${stated}.`,
    );
  } else if (stated !== null) {
    notes.push(
      `INSURANCE_HELD names ${stated} atoms, not below the ${fromCustody} the tooling already bounds: it can only lower the figure, so it changes nothing.`,
    );
  }
  return { atMost, notes };
}

/** What the operator asked for: a deposit into the keeper's seat, from a funded wallet that is not the admin's. */
export type KeeperTopUp = {
  keyFile: string;
  /** Whole quote tokens. */
  tokens: bigint;
  /** The keeper's public key, when it was given; otherwise the one of the key kept for it. */
  keeper: PublicKey | null;
};

/** A top-up of the keeper's seat, refused unless the wallet's key file and the amount are plainly given. */
export function keeperTopUpRequest(
  settings: Record<string, string | undefined>,
): KeeperTopUp {
  const { KEYFILE: keyFile, KEEPER: keeper } = settings;
  if (keyFile === undefined || keyFile === "") {
    throw new Error(
      "Set KEYFILE to the file the funded wallet's key is kept in: the wallet that holds the USDC to deposit, not the admin's. Nothing was sent.",
    );
  }
  return {
    keyFile,
    tokens: wholeTokens(settings.AMOUNT),
    keeper: keeper ? ownerKey("KEEPER", keeper) : null,
  };
}

/**
 * Whose seat a top-up goes to: the keeper's public key as `given`, or the one
 * of the key `kept` for it on this machine, which must be the same when both
 * are there. A deposit to a mistyped address would fund a stranger's seat if
 * it had one, so the address is never taken from anywhere else.
 */
export function keeperSeatOwner(
  given: PublicKey | null,
  kept: PublicKey | null,
  keyFile: string,
): PublicKey {
  if (given && kept && !given.equals(kept)) {
    throw new Error(
      `KEEPER is ${given.toBase58()}, but the key kept for the keeper at ${keyFile} is ${kept.toBase58()}: one of them is not the keeper's. Nothing was sent.`,
    );
  }
  const owner = given ?? kept;
  if (!owner) {
    throw new Error(
      `The keeper's key is not on this machine (${keyFile}): give KEEPER the keeper's public key, which \`solana-keygen pubkey\` prints for the keeper's key file on the server. Nothing was sent.`,
    );
  }
  return owner;
}

/** What a failed deposit into the keeper's seat means, in the operator's terms; the error itself when the program's code is not one it knows. */
export function keeperDepositFailure(
  message: string,
  keeper: PublicKey,
): Error {
  const code = errorCode(message);
  if (code === CUSTODY_CAP_REACHED) {
    return new Error(
      "The exchange cannot hold more of this token. Nothing was deposited; the USDC moved into the rollup stays in the wallet's balance there, and the next run uses it.",
    );
  }
  if (code === NO_SEAT) {
    return new Error(
      `${keeper.toBase58()} has no open seat on this exchange: check the address, which is the keeper's own public key. ` +
        "Nothing was deposited; the USDC moved into the rollup stays in the wallet's balance there, and the next run uses it.",
    );
  }
  return new Error(`The deposit was refused: ${message}`);
}

/**
 * The description with `added` atoms more in the keeper's recorded deposit, so
 * later checks size the insurance from what custody holds beyond the keeper's
 * real figure. Null when the description is not of this program or records no
 * keeper deposit, which a launch that has not funded the keeper does not.
 */
export function withKeeperTopUp(
  description: DeploymentDescription | null,
  programId: string,
  added: bigint,
): DeploymentDescription | null {
  if (
    !description ||
    description.programId !== programId ||
    description.keeperDeposited === undefined
  ) {
    return null;
  }
  return {
    ...description,
    keeperDeposited: (BigInt(description.keeperDeposited) + added).toString(),
  };
}

/** What the mark check found, for `markcheckSays`: the checks' inputs, or why they could not be read. */
export type MarkcheckFound = { check: ResumeCheck } | { unreadable: string };

/**
 * The plain answer of the mark check: whether a resume from the console is
 * safe by what was read just now, and if not, why. It decides nothing and
 * sends nothing; the resume stays the admin's to give.
 */
export function markcheckSays(found: MarkcheckFound): string {
  if ("unreadable" in found) {
    return `A resume is NOT safe to give: the mark could not be checked (${found.unreadable}). Fix that and run this again.`;
  }
  const verdict = resumeVerdict({ ...found.check, confirmed: true });
  return verdict.resume
    ? "A resume is safe by these checks: the mark is close to the reference, insurance covers the open interest cap, the admin is not the upgrade authority and the keeper is funded and running. Read the exchanges again just before you give it."
    : `A resume is NOT safe to give: ${verdict.why}.`;
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

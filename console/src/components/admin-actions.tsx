"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";
import {
  Connection,
  PublicKey,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  Instructions,
  MARKET_STATUS,
  MAX_MARKETS,
  associatedTokenAddress,
  decodeExchange,
  type Exchange,
} from "@noirwire/orderbook";
import { useAccess } from "./access";
import { useConsoleWallet } from "./wallet";
import type { AdminFacts } from "@/lib/admin-facts";
import { decodeInstruction, type Decoded } from "@/lib/decode";
import { stillTheNetwork, type Expected } from "@/lib/identity";
import type { ResumeCheckAnswer } from "@/lib/launch";
import { chainOf } from "@/lib/networks";
import { sendSigned, sendingConnection, type Signer } from "@/lib/send";

/** Where an instruction is sent: the rollup endpoint, or the deposit endpoint for what names custody. */
type Endpoint = "rollup" | "deposit";

type Planned = {
  title: string;
  endpoint: Endpoint;
  instruction: TransactionInstruction;
  decoded: Decoded;
  genesis: string;
};

const FIRST_FUNDING_TASK_ID = 1_000;
const FUNDING_RUNS = "1000000000";

const urlOf = (network: AdminFacts["network"], endpoint: Endpoint) =>
  endpoint === "rollup" ? network.rollupUrl : network.depositUrl;

const expectedOf = (
  network: AdminFacts["network"],
  endpoint: Endpoint,
): Expected => ({
  solanaUrl: network.solanaUrl,
  genesis: network.genesis,
  url: urlOf(network, endpoint),
  validator: network.validator,
});

/** The perp markets of `exchange`, by rising id, as `resume_market` takes them. */
const perpMarketIdsOf = ({ perpMarkets }: Exchange) =>
  Array.from({ length: MAX_MARKETS }, (_, id) => id).filter(
    (id) => (perpMarkets >> id) & 1,
  );

/** `amount` whole tokens in atoms of a token of `decimals`, as the ops scripts take CUSTODY_CAP. */
function atomsOf(amount: string, decimals: number | null): bigint {
  if (decimals === null)
    throw new Error("the token's decimals could not be read");
  if (!/^\d+$/.test(amount.trim())) {
    throw new Error(`${amount || "nothing"} is not a whole number of tokens`);
  }
  return BigInt(amount.trim()) * 10n ** BigInt(decimals);
}

function wholeNumber(text: string, what: string): bigint {
  if (!/^\d+$/.test(text.trim()))
    throw new Error(`${what} is not a whole number`);
  return BigInt(text.trim());
}

const Card = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="card">
    <h2>{title}</h2>
    {children}
  </div>
);

function Review({
  planned,
  facts,
  signer,
  onClose,
}: {
  planned: Planned;
  facts: AdminFacts;
  signer: Signer | null;
  onClose: (sent: boolean) => void;
}) {
  const { network } = facts;
  const url = urlOf(network, planned.endpoint);
  const [typed, setTyped] = useState("");
  const [progress, setProgress] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const named = !network.mainnet || typed.trim() === network.programId;
  const busy = progress !== null;

  async function send() {
    if (!signer) return;
    setFailure(null);
    const expected = expectedOf(network, planned.endpoint);
    try {
      setProgress("Reading the genesis and the rollup's identity again");
      await stillTheNetwork(expected);
      setProgress(
        url === network.privateUrl
          ? "Signing in to the private endpoint"
          : "Connecting",
      );
      const connection = await sendingConnection(
        url,
        network.privateUrl,
        signer,
      );
      setProgress(
        "Reading the network again, then waiting for the wallet and for confirmation",
      );
      setSignature(
        await sendSigned(connection, planned.instruction, signer, expected),
      );
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setProgress(null);
    }
  }

  return (
    <section className="review" aria-label="Review before signing">
      <h2>{planned.title}: review before signing</h2>
      <dl className="facts">
        <dt>Network</dt>
        <dd>{network.label}</dd>
        <dt>Genesis</dt>
        <dd>
          {planned.genesis}, read from {network.solanaUrl} when this review
          opened and matching networks.json; read again right before the wallet
          signs
        </dd>
        <dt>Program</dt>
        <dd>{planned.decoded.programId}</dd>
        <dt>Sent to</dt>
        <dd>
          {url} (
          {planned.endpoint === "rollup"
            ? "rollup endpoint"
            : "deposit endpoint"}
          )
        </dd>
        <dt>Rollup run by</dt>
        <dd>
          {network.validator}, the identity {url} answered with when this review
          opened, as networks.json names it; asked again right before the wallet
          signs
        </dd>
        <dt>Fee payer</dt>
        <dd>
          {signer?.publicKey.toBase58() ?? "no wallet"}; the wallet must hand
          back this transaction unchanged, or nothing is sent
        </dd>
        <dt>Instruction</dt>
        <dd>{planned.decoded.name}</dd>
        {planned.decoded.fields.map(([label, value]) => (
          <div key={label} style={{ display: "contents" }}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Account</th>
              <th>Signer</th>
              <th>Writable</th>
            </tr>
          </thead>
          <tbody>
            {planned.decoded.accounts.map((account, at) => (
              <tr key={`${account.address}-${at}`}>
                <td className="mono">{at}</td>
                <td className="mono addr">{account.address}</td>
                <td className="mono">{account.signer ? "yes" : ""}</td>
                <td className="mono">{account.writable ? "yes" : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hex">data {planned.decoded.dataHex}</p>
      {network.mainnet && !signature && (
        <label className="field">
          <span className="label">
            This is mainnet: type the program id to go ahead
          </span>
          <input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        </label>
      )}
      {failure && <p className="error">{failure}</p>}
      {signature && <p className="success">Landed: {signature}</p>}
      {progress && <p className="dim">{progress}</p>}
      <div className="row">
        {!signature && (
          <button
            type="button"
            className="primary"
            disabled={!signer || !named || busy}
            onClick={send}
          >
            Sign and send
          </button>
        )}
        <button
          type="button"
          className="quiet"
          disabled={busy}
          onClick={() => onClose(signature !== null)}
        >
          {signature ? "Done" : "Cancel"}
        </button>
      </div>
    </section>
  );
}

export function AdminActions({ facts }: { facts: AdminFacts }) {
  const router = useRouter();
  const wallet = useConsoleWallet();
  const { role } = useAccess();
  const programId = useMemo(
    () => new PublicKey(facts.network.programId),
    [facts.network.programId],
  );
  const instructions = useMemo(() => new Instructions(programId), [programId]);
  const [planned, setPlanned] = useState<Planned | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const [seats, setSeats] = useState(String(facts.maxSeatsPerDay));
  const [marketId, setMarketId] = useState(facts.markets[0]?.id ?? 0);
  const [status, setStatus] = useState<number>(MARKET_STATUS.paused);
  const [checkedOtherSource, setCheckedOtherSource] = useState(false);
  const [resumeCheck, setResumeCheck] = useState<ResumeCheckAnswer | null>(
    null,
  );
  const perps = facts.markets.filter((market) => market.perp);
  const [fundingMarket, setFundingMarket] = useState(perps[0]?.id ?? 0);
  const fundingDefaults = perps.find((market) => market.id === fundingMarket);
  const [taskId, setTaskId] = useState(
    String(FIRST_FUNDING_TASK_ID + fundingMarket),
  );
  const [intervalSeconds, setIntervalSeconds] = useState(
    fundingDefaults?.fundingInterval ?? "60",
  );
  const [runs, setRuns] = useState(FUNDING_RUNS);
  const [capToken, setCapToken] = useState(facts.tokens[0]?.index ?? 0);
  const [cap, setCap] = useState("");
  const [insurance, setInsurance] = useState("");
  const [nominee, setNominee] = useState("");

  const { signTransaction, signMessage } = wallet;
  const chain = chainOf(facts.network.genesis);
  const signer: Signer | null =
    wallet.publicKey && signTransaction
      ? {
          publicKey: wallet.publicKey,
          signTransaction: (transaction) => signTransaction(transaction, chain),
          signMessage: signMessage ?? undefined,
        }
      : null;

  /** The exchange as the rollup holds it now, read for the values an instruction carries over. */
  async function exchangeNow(): Promise<Exchange> {
    const account = await new Connection(
      facts.network.rollupUrl,
      "confirmed",
    ).getAccountInfo(instructions.addresses.exchange);
    if (!account) throw new Error("The exchange is not in the rollup.");
    return decodeExchange(account.data);
  }

  async function plan(
    title: string,
    endpoint: Endpoint,
    build: (
      key: PublicKey,
    ) => TransactionInstruction | Promise<TransactionInstruction>,
  ) {
    setProblem(null);
    try {
      if (!wallet.publicKey)
        throw new Error("Connect the admin's wallet first.");
      await stillTheNetwork(expectedOf(facts.network, endpoint));
      const instruction = await build(wallet.publicKey);
      const decoded = decodeInstruction(instruction, programId);
      setPlanned({
        title,
        endpoint,
        instruction,
        decoded,
        genesis: facts.network.genesis,
      });
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  }

  async function checkResume() {
    setChecking(true);
    setResumeCheck(null);
    setProblem(null);
    try {
      const { name, programId: id, genesis } = facts.network;
      const query = new URLSearchParams({
        network: name,
        programId: id,
        market: String(marketId),
        confirmed: checkedOtherSource ? "yes" : "no",
      });
      const answer = await fetch(`/api/resume-check?${query}`, {
        cache: "no-store",
      });
      const result = (await answer.json()) as ResumeCheckAnswer;
      setResumeCheck(result);
      if (!result.resume) return;
      if (
        result.network !== name ||
        result.programId !== id ||
        result.genesis !== genesis
      ) {
        throw new Error(
          `The check answered for ${result.network} (program ${result.programId}, genesis ${result.genesis}), not ${name} (program ${id}, genesis ${genesis}). Nothing was built.`,
        );
      }
      await plan("Resume market", "rollup", async (admin) =>
        instructions.resumeMarket(
          admin,
          marketId,
          perpMarketIdsOf(await exchangeNow()),
        ),
      );
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setChecking(false);
    }
  }

  if (facts.buildRefusal) {
    return (
      <section className="notice danger">
        <h2>Actions are refused on {facts.network.label}</h2>
        <p>
          On the launch profile the program on chain must be the checked build,
          as the setup requires: {facts.buildRefusal}.
        </p>
      </section>
    );
  }

  const isAdmin = role === "admin";
  const selectedActive =
    facts.markets.find((market) => market.id === marketId)?.status ===
    MARKET_STATUS.active;
  const collateral = facts.tokens.find(
    ({ index }) => index === facts.collateralToken,
  );
  const capTokenFacts = facts.tokens.find(({ index }) => index === capToken);

  return (
    <>
      {planned && (
        <Review
          key={planned.decoded.dataHex}
          planned={planned}
          facts={facts}
          signer={signer}
          onClose={(sent) => {
            setPlanned(null);
            if (sent) router.refresh();
          }}
        />
      )}
      {problem && (
        <p className="error" style={{ marginBottom: 16 }}>
          {problem}
        </p>
      )}
      <div className="cards">
        {role === "nominee" && (
          <Card title="Accept the admin role">
            <p>
              This wallet is the exchange&apos;s pending admin. Accepting moves
              the role to it, and the old admin keeps nothing.
            </p>
            <div className="row">
              <button
                type="button"
                className="primary"
                onClick={() =>
                  plan("Accept admin", "rollup", (key) =>
                    instructions.acceptAdmin(key),
                  )
                }
              >
                Review accept_admin
              </button>
            </div>
          </Card>
        )}
        {isAdmin && (
          <>
            <Card
              title={facts.paused ? "Exchange is paused" : "Exchange is open"}
            >
              <p>
                A paused exchange refuses every instruction but the
                admin&apos;s; nothing is cancelled or moved.
              </p>
              <div className="row">
                <button
                  type="button"
                  className="primary"
                  onClick={() =>
                    plan(
                      facts.paused ? "Resume exchange" : "Pause exchange",
                      "rollup",
                      (admin) => instructions.setPaused(admin, !facts.paused),
                    )
                  }
                >
                  {facts.paused ? "Review resume" : "Review pause"}
                </button>
              </div>
            </Card>

            <Card title="Market status">
              <p>
                Paused or reduce-only through restrict_market. Active only
                through resume_market, for the launch&apos;s market alone and
                only while it is not active, after the server compares it with
                the launch&apos;s settings and checks the mark against the
                median of Coinbase, Kraken and Bitstamp (and Pyth Pro when it
                has a token), refused beyond 1%, as the launch does.
              </p>
              <div className="row">
                <select
                  value={marketId}
                  onChange={(event) => {
                    const id = Number(event.target.value);
                    setMarketId(id);
                    setResumeCheck(null);
                    if (
                      status === MARKET_STATUS.active &&
                      facts.markets.find((market) => market.id === id)
                        ?.status === MARKET_STATUS.active
                    ) {
                      setStatus(MARKET_STATUS.paused);
                    }
                  }}
                  aria-label="Market"
                >
                  {facts.markets.map((market) => (
                    <option key={market.id} value={market.id}>
                      {market.id}: {market.name}
                    </option>
                  ))}
                </select>
                <select
                  value={status}
                  onChange={(event) => {
                    setStatus(Number(event.target.value));
                    setResumeCheck(null);
                  }}
                  aria-label="Status"
                >
                  {!selectedActive && (
                    <option value={MARKET_STATUS.active}>active</option>
                  )}
                  <option value={MARKET_STATUS.reduceOnly}>reduce-only</option>
                  <option value={MARKET_STATUS.paused}>paused</option>
                </select>
              </div>
              {status === MARKET_STATUS.active ? (
                <>
                  <label className="row">
                    <input
                      type="checkbox"
                      checked={checkedOtherSource}
                      onChange={(event) =>
                        setCheckedOtherSource(event.target.checked)
                      }
                    />
                    <span className="dim">
                      I checked the mark against another source
                    </span>
                  </label>
                  <div className="row">
                    <button
                      type="button"
                      className="primary"
                      disabled={checking || facts.markets.length === 0}
                      onClick={checkResume}
                    >
                      {checking
                        ? "Checking"
                        : "Check mark, then review resume_market"}
                    </button>
                  </div>
                  {resumeCheck && (
                    <dl className="facts">
                      <dt>Mark</dt>
                      <dd>{resumeCheck.mark ?? "none"}</dd>
                      <dt>Reference</dt>
                      <dd>{resumeCheck.reference ?? "none"}</dd>
                      <dt>Gap</dt>
                      <dd>
                        {resumeCheck.gapBps
                          ? `${resumeCheck.gapBps} bps`
                          : "none"}
                      </dd>
                      <dt>Covered</dt>
                      <dd>
                        {resumeCheck.covered ?? "?"} of{" "}
                        {resumeCheck.openInterestCap ?? "?"} lots
                      </dd>
                      <dt>Sources</dt>
                      <dd>{resumeCheck.sources.join("; ") || "none"}</dd>
                      <dt>Verdict</dt>
                      <dd className={resumeCheck.resume ? "success" : "error"}>
                        {resumeCheck.resume
                          ? "resume"
                          : `refused: ${resumeCheck.why}`}
                      </dd>
                    </dl>
                  )}
                </>
              ) : (
                <div className="row">
                  <button
                    type="button"
                    className="primary"
                    disabled={facts.markets.length === 0}
                    onClick={() =>
                      plan("Restrict market", "rollup", (admin) =>
                        instructions.restrictMarket(admin, marketId, status),
                      )
                    }
                  >
                    Review restrict_market
                  </button>
                </div>
              )}
            </Card>

            <Card title="Sync prices">
              <p>
                Hands a market or the USDC guard its bound Pyth account. Anyone
                may send it; the crank does every round.
              </p>
              <div className="row">
                {facts.markets
                  .filter((market) => market.pythAccount)
                  .map((market) => (
                    <button
                      key={market.id}
                      type="button"
                      className="quiet"
                      onClick={() =>
                        plan(`Sync ${market.name}`, "rollup", () =>
                          instructions.syncPrice(
                            market.id,
                            new PublicKey(market.pythAccount!),
                          ),
                        )
                      }
                    >
                      sync_price {market.name}
                    </button>
                  ))}
                {facts.quoteAccount && (
                  <button
                    type="button"
                    className="quiet"
                    onClick={() =>
                      plan("Sync the USDC guard", "rollup", () =>
                        instructions.syncQuote(
                          new PublicKey(facts.quoteAccount!),
                        ),
                      )
                    }
                  >
                    sync_quote
                  </button>
                )}
              </div>
            </Card>

            <Card title="Seats per day">
              <p>
                The most seats open_trader opens in one UTC day; it bounds what
                a stolen gate key can spend. Gate, oracle and max steps stay as
                the rollup holds them when the review opens, read again then.
              </p>
              <div className="row">
                <input
                  value={seats}
                  onChange={(event) => setSeats(event.target.value)}
                  inputMode="numeric"
                  aria-label="Seats per day"
                  size={8}
                />
                <button
                  type="button"
                  className="primary"
                  onClick={() =>
                    plan("Seats per day", "rollup", async (admin) => {
                      const maxSeatsPerDay = Number(
                        wholeNumber(seats, "The seat cap"),
                      );
                      const { gate, oracle, maxSteps } = await exchangeNow();
                      return instructions.updateExchange(admin, {
                        gate,
                        oracle,
                        maxSteps,
                        maxSeatsPerDay,
                      });
                    })
                  }
                >
                  Review update_exchange
                </button>
              </div>
            </Card>

            <Card title="Custody cap">
              <p>
                The most a token&apos;s custody may hold after a trader&apos;s
                deposit, in whole tokens. It can stop deposits, never a
                withdrawal.
              </p>
              <div className="row">
                <select
                  value={capToken}
                  onChange={(event) => setCapToken(Number(event.target.value))}
                  aria-label="Token"
                >
                  {facts.tokens.map((token) => (
                    <option key={token.index} value={token.index}>
                      {token.index}: {token.mint.slice(0, 6)}…
                    </option>
                  ))}
                </select>
                <input
                  value={cap}
                  onChange={(event) => setCap(event.target.value)}
                  inputMode="numeric"
                  placeholder="whole tokens"
                  aria-label="Cap in whole tokens"
                  size={12}
                />
                <button
                  type="button"
                  className="primary"
                  disabled={!capTokenFacts}
                  onClick={() =>
                    plan("Custody cap", "deposit", (admin) =>
                      instructions.setCustodyCap(
                        admin,
                        capToken,
                        atomsOf(cap, capTokenFacts?.decimals ?? null),
                      ),
                    )
                  }
                >
                  Review set_custody_cap
                </button>
              </div>
            </Card>

            <Card title="Fund insurance">
              <p>
                Moves the admin&apos;s own collateral token, held in the rollup,
                into the insurance seat. Not held to the custody cap. Send it
                once per amount you mean: a second send adds again.
              </p>
              <div className="row">
                <input
                  value={insurance}
                  onChange={(event) => setInsurance(event.target.value)}
                  inputMode="numeric"
                  placeholder="whole tokens"
                  aria-label="Insurance in whole tokens"
                  size={12}
                />
                <button
                  type="button"
                  className="primary"
                  disabled={!collateral}
                  onClick={() =>
                    plan("Fund insurance", "deposit", (admin) => {
                      if (!collateral)
                        throw new Error(
                          "the collateral token is not registered",
                        );
                      const mint = new PublicKey(collateral.mint);
                      return instructions.fundInsurance(
                        admin,
                        associatedTokenAddress(admin, mint),
                        { mint, custodyNonce: BigInt(collateral.custodyNonce) },
                        atomsOf(insurance, collateral.decimals),
                      );
                    })
                  }
                >
                  Review fund_insurance
                </button>
              </div>
            </Card>

            <Card title="Schedule funding">
              <p>
                Starts the rollup&apos;s funding task for a perp market. The
                launch sends it once per program: scheduling again starts a
                second task.
              </p>
              <div className="row">
                <select
                  value={fundingMarket}
                  onChange={(event) => {
                    const id = Number(event.target.value);
                    setFundingMarket(id);
                    setTaskId(String(FIRST_FUNDING_TASK_ID + id));
                    setIntervalSeconds(
                      perps.find((market) => market.id === id)
                        ?.fundingInterval ?? "60",
                    );
                  }}
                  aria-label="Perp market"
                >
                  {perps.map((market) => (
                    <option key={market.id} value={market.id}>
                      {market.id}: {market.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="row">
                <label className="field">
                  <span className="label">Task id</span>
                  <input
                    value={taskId}
                    onChange={(event) => setTaskId(event.target.value)}
                    size={8}
                  />
                </label>
                <label className="field">
                  <span className="label">Every, seconds</span>
                  <input
                    value={intervalSeconds}
                    onChange={(event) => setIntervalSeconds(event.target.value)}
                    size={6}
                  />
                </label>
                <label className="field">
                  <span className="label">Runs</span>
                  <input
                    value={runs}
                    onChange={(event) => setRuns(event.target.value)}
                    size={12}
                  />
                </label>
              </div>
              <div className="row">
                <button
                  type="button"
                  className="primary"
                  disabled={perps.length === 0}
                  onClick={() =>
                    plan("Schedule funding", "rollup", (admin) =>
                      instructions.scheduleFunding(
                        admin,
                        fundingMarket,
                        wholeNumber(taskId, "The task id"),
                        wholeNumber(intervalSeconds, "The interval") * 1_000n,
                        wholeNumber(runs, "The run count"),
                      ),
                    )
                  }
                >
                  Review schedule_funding
                </button>
              </div>
            </Card>

            <Card title="Hand over the admin role">
              <p>
                Proposes a nominee, who then accepts with their own wallet.
                Leave it empty to withdraw a nomination. Pending now:{" "}
                {facts.pendingAdmin ?? "none"}.
              </p>
              <div className="row">
                <input
                  value={nominee}
                  onChange={(event) => setNominee(event.target.value)}
                  placeholder="nominee public key"
                  aria-label="Nominee"
                  style={{ flex: 1 }}
                />
                <button
                  type="button"
                  className="primary"
                  onClick={() =>
                    plan("Propose admin", "rollup", (admin) =>
                      instructions.proposeAdmin(
                        admin,
                        nominee.trim() ? new PublicKey(nominee.trim()) : null,
                      ),
                    )
                  }
                >
                  Review propose_admin
                </button>
              </div>
            </Card>
          </>
        )}
      </div>
    </>
  );
}

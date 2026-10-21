import { QUOTE_STATE } from "@noirwire/orderbook";
import { gatherQuotes, referenceOf, referenceSources } from "@ops/prices";
import { Gate } from "@/components/access";
import { Facts, Heading, Stat, StateMark, ageTone } from "@/components/bits";
import type { PythRead } from "@/lib/chain";
import { age, bps, decimal, grouped, nameIn, utc } from "@/lib/format";
import { freshFetch } from "@/lib/reference";
import { selected } from "@/lib/selected";

/** One whole SOL in micro dollars: the reference in USD per SOL with six decimals. */
const ONE_SOL = { baseLot: 1_000_000_000n, baseDecimals: 9, quoteDecimals: 6 };

function PythRow({
  name,
  read,
  clock,
  maxAge,
  usable,
}: {
  name: string;
  read: PythRead;
  clock: number;
  maxAge: bigint;
  usable: bigint;
}) {
  const cell = (seconds: number | null) =>
    seconds === null ? (
      <span className="faint">unreadable</span>
    ) : (
      <StateMark tone={ageTone(seconds, maxAge, usable)}>
        {age(seconds)}
      </StateMark>
    );
  return (
    <tr>
      <td>{name}</td>
      <td className="mono addr">{read.account}</td>
      <td className="num">
        {cell(read.solana ? clock - read.solana.publishTime : null)}
      </td>
      <td className="num">
        {cell(read.rollup ? clock - read.rollup.publishTime : null)}
      </td>
      <td className="num">{maxAge.toString()} s</td>
    </tr>
  );
}

export default async function PricesPage() {
  const { state } = await selected();
  if (!state) return null;
  const { exchange, clock } = state;
  const quote = exchange?.quote;
  const bound = quote && state.guardPyth !== null;
  const passes =
    !!quote &&
    quote.state === QUOTE_STATE.healthy &&
    BigInt(clock) <= quote.okUntil;
  const gathered = await gatherQuotes(
    referenceSources(ONE_SOL, undefined, freshFetch),
  );
  let median: bigint | null = null;
  let why: string | null = null;
  try {
    median = referenceOf(gathered.quotes);
  } catch (error) {
    why = error instanceof Error ? error.message : String(error);
  }
  const usd = (atoms: bigint) => `$${decimal(atoms, 6, 4)}`;
  return (
    <Gate need="stats">
      <Heading
        title="Prices"
        lead="The USDC guard every perp depends on, the age of each Pyth account the program reads, and the public exchange prices a first mark is checked against."
      />
      <section>
        <h2>USDC guard</h2>
        <div className="stats">
          <Stat
            label="Guard"
            value={
              !bound ? (
                <StateMark tone="neutral">unbound</StateMark>
              ) : passes ? (
                <StateMark tone="ok">passing</StateMark>
              ) : (
                <StateMark tone="danger">not passing</StateMark>
              )
            }
            sub={
              quote ? `state ${nameIn(QUOTE_STATE, quote.state)}` : undefined
            }
          />
          <Stat
            label="USDC/USD"
            value={
              quote && bound ? decimal(quote.price, -quote.expo, 6) : "none"
            }
            sub={quote && bound ? `conf ${grouped(quote.conf)}` : undefined}
          />
          <Stat
            label="Observation age"
            value={
              quote && bound && quote.publishTime > 0n ? (
                <StateMark
                  tone={ageTone(
                    clock - Number(quote.publishTime),
                    quote.maxAge,
                    quote.maxAge,
                  )}
                >
                  {age(clock - Number(quote.publishTime))}
                </StateMark>
              ) : (
                "none"
              )
            }
            sub={quote ? `max ${quote.maxAge} s` : undefined}
          />
          <Stat
            label="Passes for"
            value={
              quote && quote.okUntil > BigInt(clock)
                ? age(Number(quote.okUntil) - clock)
                : "0 s"
            }
            sub={quote ? `until ${utc(quote.okUntil)}` : undefined}
          />
        </div>
        {quote && bound && (
          <div className="panel" style={{ marginTop: 16 }}>
            <Facts
              rows={[
                ["Pyth account", quote.account.toBase58()],
                [
                  "Limits",
                  `depeg ${bps(quote.depegBps)} from a dollar, max conf ${bps(quote.maxConfBps)}, expo ${quote.expo}`,
                ],
                ["Published", utc(quote.publishTime)],
              ]}
            />
          </div>
        )}
      </section>
      <section>
        <h2>Pyth accounts</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Read by</th>
                <th>Account</th>
                <th className="num">Age on Solana</th>
                <th className="num">Age in the rollup</th>
                <th className="num">Max age</th>
              </tr>
            </thead>
            <tbody>
              {state.markets
                .filter((view) => view.pyth)
                .map((view) => (
                  <PythRow
                    key={view.id}
                    name={`${view.market.baseSymbol}/${view.market.quoteSymbol}, market ${view.id}`}
                    read={view.pyth!}
                    clock={clock}
                    maxAge={view.market.params.maxPriceAge}
                    usable={view.market.params.maxAgeLiquidation}
                  />
                ))}
              {quote && state.guardPyth && (
                <PythRow
                  name="USDC guard"
                  read={state.guardPyth}
                  clock={clock}
                  maxAge={quote.maxAge}
                  usable={quote.maxAge}
                />
              )}
              {!state.guardPyth && !state.markets.some((view) => view.pyth) && (
                <tr>
                  <td colSpan={5} className="dim">
                    Nothing on this exchange is bound to Pyth.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="faint" style={{ marginTop: 8 }}>
          Ages are counted from each observation&apos;s publish time to the
          rollup clock.
        </p>
      </section>
      <section>
        <h2>Reference price, SOL/USD</h2>
        <div className="stats">
          <Stat
            label="Median"
            value={median !== null ? usd(median) : "none"}
            sub={why ?? `of ${gathered.quotes.length} sources`}
          />
          {gathered.quotes.map(({ name, atoms }) => (
            <Stat key={name} label={name} value={usd(atoms)} sub="last trade" />
          ))}
          {gathered.skipped.map(({ name, why: skipped }) => (
            <Stat key={name} label={name} value="skipped" sub={skipped} />
          ))}
        </div>
      </section>
    </Gate>
  );
}

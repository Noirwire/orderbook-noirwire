import { PublicKey } from "@solana/web3.js";
import { MARKET_STATUS, QUOTE_STATE, type Exchange } from "@noirwire/orderbook";
import { Gate } from "@/components/access";
import { Heading, StateMark, type Tone } from "@/components/bits";
import { decimal, nameIn } from "@/lib/format";
import {
  MAINNET_MARKET,
  MAINNET_MAX_SEATS_PER_DAY,
  MAINNET_QUOTE_INDEX,
  MAINNET_QUOTE_SOURCE,
  launchMarketDiffers,
  launchRows,
  type StepState,
} from "@/lib/launch";
import { selected } from "@/lib/selected";

const TONE: Record<StepState, Tone> = {
  done: "ok",
  pending: "warn",
  "not public": "neutral",
};

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** Whether the USDC guard is bound to the launch's source and limits. */
const quoteBoundAsLaunched = ({ quote }: Exchange) =>
  hex(quote.feedId) === MAINNET_QUOTE_SOURCE.feedId &&
  quote.expo === MAINNET_QUOTE_SOURCE.expo &&
  quote.maxConfBps === MAINNET_QUOTE_SOURCE.maxConfBps &&
  quote.depegBps === MAINNET_QUOTE_SOURCE.depegBps &&
  quote.maxAge === MAINNET_QUOTE_SOURCE.maxAge;

export default async function LaunchPage() {
  const { checked, state } = await selected();
  if (!state) return null;
  const { network } = checked;
  if (network.profile !== "mainnet") {
    return (
      <Gate need="stats">
        <Heading
          title="Launch"
          lead={`${network.label} runs the test networks' profile, set up by ${network.setup}. The launch steps are the mainnet profile's: pick the devnet rehearsal or mainnet.`}
        />
      </Gate>
    );
  }
  const { exchange } = state;
  const quoteToken = exchange?.tokens[MAINNET_QUOTE_INDEX];
  const registered = !!quoteToken && !quoteToken.mint.equals(PublicKey.default);
  const tokenDecimals =
    state.tokens.find(({ index }) => index === MAINNET_QUOTE_INDEX)?.decimals ??
    6;
  const market = state.markets.find(({ id }) => id === MAINNET_MARKET.id);
  const differ = launchMarketDiffers(
    market
      ? { params: market.market.params, binding: market.feed?.binding ?? null }
      : null,
  );
  const marked = (market?.feed?.price ?? 0n) > 0n;
  const active = market?.market.params.status === MARKET_STATUS.active;
  const quoteRead =
    !!exchange &&
    (exchange.quote.state === QUOTE_STATE.depegged ||
      exchange.quote.okUntil > 0n);
  const rows = launchRows(
    {
      seatsPerDay: exchange?.maxSeatsPerDay === MAINNET_MAX_SEATS_PER_DAY,
      quoteToken: registered,
      ledger: state.statsReady,
      market: differ.length === 0,
      quoteSource: !!exchange && quoteBoundAsLaunched(exchange),
      quoteRead,
      marked,
      active,
      funding: false,
      insurance: false,
      custodyCap: registered && quoteToken.custodyCap > 0n,
      keeper: false,
    },
    {
      seatsPerDay: exchange
        ? `${exchange.maxSeatsPerDay} a day now`
        : "the exchange is not in the rollup",
      quoteToken: registered
        ? `${quoteToken.mint.toBase58()}, ${quoteToken.custodyVisibility} custody`
        : "nothing registered at index 0",
      ledger: state.statsReady ? "stats are finalised" : "no stats account",
      market:
        differ.length === 0
          ? `${market?.market.baseSymbol}/${market?.market.quoteSymbol}, settings, limits and feed as the launch sets them`
          : `not the launch's market: ${differ.join("; ")}`,
      quoteSource: exchange
        ? exchange.quote.account.equals(PublicKey.default)
          ? "unbound"
          : `bound to ${exchange.quote.account.toBase58()}`
        : "",
      syncQuote: exchange
        ? `guard ${nameIn(QUOTE_STATE, exchange.quote.state)}`
        : "",
      syncPrice: marked ? `mark ${market?.feed?.price}` : "no mark yet",
      custodyCap: registered
        ? `cap ${decimal(quoteToken.custodyCap, tokenDecimals)} whole tokens`
        : "",
      checkMark: market
        ? `status ${nameIn(MARKET_STATUS, market.market.params.status)}; the setup prints the mark beside the reference median`
        : "",
      resume: market
        ? `status ${nameIn(MARKET_STATUS, market.market.params.status)}`
        : "",
    },
    network.setup,
  );
  const count = (state: StepState) =>
    rows.filter((row) => row.state === state).length;
  const pending = count("pending");
  const hidden = count("not public");
  const summary = [
    pending === 0
      ? "Every step the public accounts show is done."
      : `${pending} pending.`,
    hidden > 0 ? `${hidden} cannot be read from public accounts.` : "",
  ].join(" ");
  return (
    <Gate need="stats">
      <Heading
        title="Launch"
        lead={`The mainnet profile's steps, in the order ${network.setup} takes them, read from the chain. ${summary} Read only: a pending step is taken by the command beside it, and the program deploy stays on the command line.`}
      />
      <ol className="steps">
        {rows.map((row, at) => (
          <li key={row.step}>
            <span className="index">{at + 1}</span>
            <span>{row.title}</span>
            <StateMark tone={TONE[row.state]}>{row.state}</StateMark>
            {row.detail && <span className="more">{row.detail}</span>}
            {row.command && <code>{row.command}</code>}
          </li>
        ))}
      </ol>
      <p className="faint" style={{ marginTop: 12 }}>
        The setup reads the network again before each step, so running it for a
        step another run finished does nothing.
      </p>
    </Gate>
  );
}

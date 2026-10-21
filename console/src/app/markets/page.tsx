import { PublicKey } from "@solana/web3.js";
import {
  INCIDENT_REASON,
  MARKET_KIND,
  MARKET_STATUS,
  ORACLE_HEALTH,
} from "@noirwire/orderbook";
import { gapBps, LAUNCH_LOT, RESUME_GAP_BPS } from "@ops/launch";
import { Gate } from "@/components/access";
import {
  Facts,
  Heading,
  Stat,
  StateMark,
  ageTone,
  type Tone,
} from "@/components/bits";
import type { ChainState, MarketState } from "@/lib/chain";
import {
  age,
  bps,
  decimal,
  grouped,
  nameIn,
  percentOfBps,
  perWholeBase,
  utc,
} from "@/lib/format";
import { launchMarketDiffers } from "@/lib/launch";
import { MAINNET_GENESIS, type Network } from "@/lib/networks";
import { isLaunchMarket, launchReference, lotOf } from "@/lib/reference";
import { selected } from "@/lib/selected";

const STATUS_TONE: Record<number, Tone> = {
  [MARKET_STATUS.active]: "ok",
  [MARKET_STATUS.reduceOnly]: "warn",
  [MARKET_STATUS.paused]: "danger",
};

const HEALTH_TONE: Record<number, Tone> = {
  [ORACLE_HEALTH.healthy]: "ok",
  [ORACLE_HEALTH.dislocated]: "danger",
  [ORACLE_HEALTH.settling]: "warn",
};

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

function quoteDecimals(state: ChainState, view: MarketState): number | null {
  const lot = lotOf(view);
  if (lot) return lot.quoteDecimals;
  return (
    state.tokens.find(({ index }) => index === view.market.params.quoteToken)
      ?.decimals ?? null
  );
}

async function MarketSection({
  network,
  genesis,
  state,
  view,
}: {
  network: Network;
  genesis: string;
  state: ChainState;
  view: MarketState;
}) {
  const { market, feed, pyth, id } = view;
  const { params } = market;
  const lot = lotOf(view);
  const quote = quoteDecimals(state, view);
  const launch = isLaunchMarket(network, view);
  const reference = launch
    ? await launchReference(genesis === MAINNET_GENESIS)
    : null;
  const differ = launch
    ? launchMarketDiffers({ params, binding: feed?.binding ?? null })
    : [];
  const referenceText = (atoms: bigint) =>
    `${perWholeBase(atoms, LAUNCH_LOT)} ${market.quoteSymbol}`;
  const markAge = feed ? state.clock - Number(feed.publishTime) : null;
  const pythAge = pyth?.rollup ? state.clock - pyth.rollup.publishTime : null;
  const bound = feed && !feed.binding.account.equals(PublicKey.default);
  const kind = params.kind === MARKET_KIND.perp ? "perp" : "spot";
  const markText = (atoms: bigint) =>
    lot
      ? `${perWholeBase(atoms, lot)} ${market.quoteSymbol}`
      : `${grouped(atoms)} atoms/lot`;
  const gap =
    reference?.median && feed && feed.price > 0n
      ? gapBps(feed.price, reference.median)
      : null;
  return (
    <section>
      <h2>
        {market.baseSymbol}/{market.quoteSymbol} {kind}, market {id}{" "}
        <StateMark tone={STATUS_TONE[params.status] ?? "neutral"}>
          {nameIn(MARKET_STATUS, params.status)}
        </StateMark>
      </h2>
      <div className="stats">
        <Stat
          label="Mark"
          value={feed && feed.price > 0n ? markText(feed.price) : "none"}
          sub={
            feed && feed.price > 0n
              ? `${grouped(feed.price)} quote atoms per lot`
              : "no first mark yet"
          }
        />
        <Stat
          label="Mark age"
          value={
            markAge === null || !feed || feed.publishTime === 0n ? (
              "none"
            ) : (
              <StateMark
                tone={ageTone(
                  markAge,
                  params.maxPriceAge,
                  params.maxAgeLiquidation,
                )}
              >
                {age(markAge)}
              </StateMark>
            )
          }
          sub={`max ${params.maxPriceAge} s, liquidation ${params.maxAgeLiquidation} s`}
        />
        <Stat
          label="Price source"
          value={
            <StateMark tone={HEALTH_TONE[params.oracleHealth] ?? "neutral"}>
              {nameIn(ORACLE_HEALTH, params.oracleHealth)}
            </StateMark>
          }
          sub={
            pythAge === null
              ? bound
                ? "Pyth account unreadable"
                : "bound to no source"
              : `Pyth ${age(pythAge)} old in the rollup`
          }
        />
        <Stat
          label="Open interest"
          value={`${grouped(view.openInterest)} lots`}
          sub={`cap ${grouped(params.openInterestCap)} lots`}
        />
        <Stat
          label="Volume"
          value={
            quote === null
              ? grouped(view.volume)
              : `${decimal(view.volume, quote, 2)} ${market.quoteSymbol}`
          }
          sub="lifetime notional"
        />
        <Stat
          label="Reference"
          value={
            reference?.median
              ? referenceText(reference.median)
              : reference
                ? "none"
                : "not priced"
          }
          sub={
            differ.length > 0 ? (
              <StateMark tone="danger">not the launch&apos;s market</StateMark>
            ) : gap !== null ? (
              <StateMark tone={gap <= RESUME_GAP_BPS ? "ok" : "danger"}>
                mark {gap.toString()} bps away
              </StateMark>
            ) : reference ? (
              (reference.why ?? "")
            ) : (
              "taken for the launch's market only"
            )
          }
        />
      </div>
      <div className="panel" style={{ marginTop: 16 }}>
        <Facts
          rows={[
            [
              "Caps",
              `open interest ${grouped(params.openInterestCap)} lots, position ${grouped(params.positionCap)} lots, ${params.maxOpenOrders} open orders per seat`,
            ],
            [
              "Fees",
              `taker ${bps(params.takerFeeBps)}, ${percentOfBps(params.feeInsuranceShareBps)} of fees to insurance`,
            ],
            [
              "Liquidation",
              `penalty ${bps(params.liqPenaltyBps)}, ${percentOfBps(params.liqInsuranceShareBps)} to insurance, buffer ${bps(params.liqBufferBps)}`,
            ],
            [
              "Funding",
              kind === "perp"
                ? `every ${params.fundingInterval} s, capped at ${bps(params.fundingCapBps)} per 8 h`
                : "spot, none",
            ],
            [
              "Margin",
              `initial ${bps(params.imBps)}, maintenance ${bps(params.mmBps)}`,
            ],
            [
              "Price limits",
              `band ${bps(params.bandBps)}, move ${bps(params.maxMoveBps)}, settle window ${params.settleWindow} s, min gap ${params.minPublishGap} s`,
            ],
            [
              "Lot and tick",
              `${grouped(params.baseLot)} base atoms per lot, tick ${grouped(params.tick)} quote atoms per lot, min size ${grouped(params.minSize)} lots`,
            ],
            ["Uncovered shortfall", grouped(params.uncoveredShortfall)],
            ...(bound && feed
              ? ([
                  ["Pyth account", feed.binding.account.toBase58()],
                  [
                    "Feed",
                    `${hex(feed.binding.feedId)}, expo ${feed.binding.expo}, max conf ${bps(feed.binding.maxConfBps)}`,
                  ],
                  [
                    "Last observation",
                    `${grouped(feed.source.rawPrice)} conf ${grouped(feed.source.conf)}, published ${utc(feed.source.publishTime)}, read ${utc(feed.source.observedAt)}`,
                  ],
                  [
                    "Pyth on Solana",
                    pyth?.solana
                      ? `published ${utc(pyth.solana.publishTime)}, ${age(state.clock - pyth.solana.publishTime)} before the rollup clock`
                      : "unreadable",
                  ],
                ] as [string, string][])
              : []),
            [
              "Last incident",
              feed && feed.incident.reason !== 0
                ? `${nameIn(INCIDENT_REASON, feed.incident.reason)} since ${utc(feed.incident.since)}, gap ${bps(feed.incident.gapBps)}${feed.incident.settleUntil > 0n ? `, settles until ${utc(feed.incident.settleUntil)}` : ""}`
                : "none",
            ],
            ...(launch
              ? ([
                  [
                    "Launch settings",
                    differ.length > 0
                      ? differ.join("; ")
                      : "settings, limits and feed as the launch sets them",
                  ],
                ] as [string, string][])
              : []),
            ...(reference
              ? ([
                  [
                    "Reference sources",
                    [
                      ...reference.quotes.map(
                        ({ name, atoms, note }) =>
                          `${name} ${referenceText(atoms)}${note ? ` (${note})` : ""}`,
                      ),
                      ...reference.skipped.map(
                        ({ name, why }) => `${name} skipped: ${why}`,
                      ),
                    ].join("; "),
                  ],
                ] as [string, string][])
              : []),
          ]}
        />
      </div>
    </section>
  );
}

export default async function MarketsPage() {
  const { checked, state } = await selected();
  if (!state) return null;
  return (
    <Gate need="stats">
      <Heading
        title="Markets"
        lead="Each market's status, mark and price source, from the public market, price feed and stats accounts. The launch's market is compared with the launch's settings, and its reference is the median of Coinbase, Kraken and Bitstamp (and Pyth Pro when the server has a token), priced in the launch's own lot: the same check the launch makes before a market opens."
      />
      {state.markets.length === 0 && (
        <p className="dim">No market is set up on this exchange.</p>
      )}
      {state.markets.map((view) => (
        <MarketSection
          key={view.id}
          network={checked.network}
          genesis={checked.genesis}
          state={state}
          view={view}
        />
      ))}
    </Gate>
  );
}

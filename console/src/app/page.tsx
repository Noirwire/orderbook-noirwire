import { Gate } from "@/components/access";
import { Facts, Heading, Stat, StateMark } from "@/components/bits";
import { grouped, utc } from "@/lib/format";
import { MAINNET_GENESIS } from "@/lib/networks";
import { selected } from "@/lib/selected";

export default async function ExchangePage() {
  const { checked, state } = await selected();
  if (!state) return null;
  const { exchange, stats } = state;
  if (!exchange) {
    return (
      <Gate need="stats">
        <Heading
          title="Exchange"
          lead={`No exchange in the rollup at ${state.exchangeAddress}. ${checked.network.setup} sets it up.`}
        />
      </Gate>
    );
  }
  const admin = exchange.admin.toBase58();
  const adminUpgrades = state.upgradeAuthority === admin;
  const onMainnet = checked.genesis === MAINNET_GENESIS;
  return (
    <Gate need="stats">
      <Heading
        title="Exchange"
        lead="The exchange account as the rollup holds it, and the lifetime counters. Everything here is public; the ledger of seats is sealed and never read."
      />
      <section>
        <div className="stats">
          <Stat
            label="Trading"
            value={
              exchange.paused ? (
                <StateMark tone="danger">paused</StateMark>
              ) : (
                <StateMark tone="ok">open</StateMark>
              )
            }
            sub="set_paused stops every instruction but the admin's"
          />
          <Stat
            label="Seats today"
            value={`${exchange.seatsOpened} / ${exchange.maxSeatsPerDay}`}
            sub={`UTC day ${exchange.seatsDay}`}
          />
          <Stat
            label="Orders"
            value={stats ? grouped(stats.orders) : "none"}
            sub="lifetime"
          />
          <Stat
            label="Fills"
            value={stats ? grouped(stats.fills) : "none"}
            sub="lifetime"
          />
          <Stat
            label="Rollup clock"
            value={utc(state.clock).slice(11)}
            sub={`${utc(state.clock).slice(0, 10)}, UTC`}
          />
        </div>
      </section>
      <section className="panel">
        <h2>Keys and settings</h2>
        <Facts
          rows={[
            ["Exchange", state.exchangeAddress],
            [
              "On Solana",
              state.onSolana
                ? `${grouped(state.onSolana.lamports)} lamports, ${state.onSolana.delegated ? "delegated to the rollup" : "not delegated"}`
                : "absent",
            ],
            ["Admin", admin],
            ["Pending admin", exchange.pendingAdmin?.toBase58() ?? "none"],
            [
              "Upgrade authority",
              <>
                {state.upgradeAuthority ?? "none"}
                {adminUpgrades && (
                  <>
                    {" "}
                    <StateMark tone={onMainnet ? "danger" : "warn"}>
                      the admin too
                      {onMainnet
                        ? ": SECURITY.md never allows it with real money"
                        : ""}
                    </StateMark>
                  </>
                )}
              </>,
            ],
            ["Gate", exchange.gate.toBase58()],
            ["Oracle", exchange.oracle.toBase58()],
            ["Max steps", String(exchange.maxSteps)],
            ["Collateral token", `index ${exchange.collateralToken}`],
            [
              "Perp markets",
              state.perpMarketIds.length > 0
                ? state.perpMarketIds.join(", ")
                : "none",
            ],
            [
              "Ledger",
              state.statsReady
                ? "created and finalised; sealed, nobody reads it"
                : "not created",
            ],
          ]}
        />
      </section>
    </Gate>
  );
}

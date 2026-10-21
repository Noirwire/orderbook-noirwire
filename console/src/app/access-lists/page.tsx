import { MARKET_KIND, MARKET_STATUS } from "@noirwire/orderbook";
import { switchesOf } from "@ops/accessing";
import { Gate } from "@/components/access";
import { AccessActions, type AccessMarket } from "@/components/access-actions";
import { Heading, StateMark } from "@/components/bits";
import { networkFacts } from "@/lib/admin-facts";
import { launchBuildRefusal } from "@/lib/build";
import { nameIn } from "@/lib/format";
import { selected } from "@/lib/selected";

const LEAD =
  "Each perp market's maker list and taker list, read from its public market account. A list switched on lets only the seats listed for that market make, or take, there; both start off, so every seat may make and take.";

const Switch = ({ on }: { on: boolean }) => (
  <StateMark tone={on ? "ok" : "neutral"}>{on ? "on" : "off"}</StateMark>
);

export default async function AccessListsPage() {
  const { checked, state } = await selected();
  if (!state) return null;
  const { network, genesis } = checked;
  const { exchange } = state;
  if (!exchange) {
    return (
      <Gate need="stats">
        <Heading
          title="Access lists"
          lead={`No exchange in the rollup yet. ${network.setup} sets it up.`}
        />
      </Gate>
    );
  }
  const perps = state.markets.filter(
    ({ market }) => market.params.kind === MARKET_KIND.perp,
  );
  const markets: AccessMarket[] = perps.map(({ id, market }) => ({
    id,
    name: `${market.baseSymbol}/${market.quoteSymbol}`,
    ...switchesOf(market.params.access),
  }));
  return (
    <Gate need="stats">
      <Heading title="Access lists" lead={LEAD} />
      <section>
        <h2>Switches</h2>
        {perps.length === 0 ? (
          <p className="dim">The exchange has no perp market.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Market</th>
                  <th>Status</th>
                  <th>Maker list</th>
                  <th>Taker list</th>
                </tr>
              </thead>
              <tbody>
                {perps.map(({ id, market }) => {
                  const switches = switchesOf(market.params.access);
                  return (
                    <tr key={id}>
                      <td>
                        {id}: {market.baseSymbol}/{market.quoteSymbol}
                      </td>
                      <td className="mono">
                        {nameIn(MARKET_STATUS, market.params.status)}
                      </td>
                      <td>
                        <Switch on={switches.makersListed} />
                      </td>
                      <td>
                        <Switch on={switches.takersListed} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="notice">
        <h2>A seat&apos;s lists are sealed</h2>
        <p>
          Which seats are listed or blocked sits in the sealed ledger: nobody
          can read it back, the admin included, so this page shows the public
          switches only. Keep your own signed record of what you set; a listed
          seat confirms its own flags in its view after a sync.
        </p>
      </section>
      <AccessActions
        facts={{
          network: networkFacts(network, genesis),
          buildRefusal: await launchBuildRefusal(network, genesis),
          markets,
        }}
      />
    </Gate>
  );
}

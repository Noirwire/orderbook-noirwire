import { PublicKey } from "@solana/web3.js";
import { Addresses } from "@noirwire/orderbook";
import { Gate } from "@/components/access";
import { Heading, StateMark } from "@/components/bits";
import { decimal, grouped } from "@/lib/format";
import { selected } from "@/lib/selected";

const amount = (atoms: bigint, decimals: number | null) =>
  decimals === null ? grouped(atoms) : decimal(atoms, decimals, 6);

export default async function CustodyPage() {
  const { checked, state } = await selected();
  if (!state) return null;
  const addresses = new Addresses(new PublicKey(checked.network.programId));
  return (
    <Gate need="stats">
      <Heading
        title="Custody"
        lead="Each registered token, its custody cap, and, where custody is public, what custody holds. A sealed custody balance is private to the program and is not shown."
      />
      {state.tokens.length === 0 ? (
        <p className="dim">No token is registered.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Index</th>
                <th>Mint</th>
                <th>Custody</th>
                <th>Visibility</th>
                <th className="num">Cap</th>
                <th className="num">In the rollup</th>
                <th className="num">Of the cap</th>
                <th className="num">On Solana</th>
              </tr>
            </thead>
            <tbody>
              {state.tokens.map(
                ({ index, token, decimals, onSolana, inRollup }) => {
                  const used =
                    inRollup !== null && token.custodyCap > 0n
                      ? `${decimal((inRollup * 10_000n) / token.custodyCap, 2)}%`
                      : "";
                  return (
                    <tr key={index}>
                      <td className="mono">
                        {index}
                        {state.exchange?.collateralToken === index
                          ? " collateral"
                          : ""}
                      </td>
                      <td className="mono addr">
                        {token.mint.toBase58()}
                        <div className="faint">
                          {decimals === null
                            ? "decimals unread"
                            : `${decimals} decimals`}
                        </div>
                      </td>
                      <td className="mono addr">
                        {token.custody.toBase58()}
                        <div className="faint">
                          balance {addresses.custodyBalance(token).toBase58()}
                        </div>
                      </td>
                      <td>
                        <StateMark
                          tone={
                            token.custodyVisibility === "public" ? "warn" : "ok"
                          }
                        >
                          {token.custodyVisibility}
                        </StateMark>
                      </td>
                      <td className="num">
                        {token.custodyCap === 0n
                          ? "0, takes no deposit"
                          : amount(token.custodyCap, decimals)}
                      </td>
                      <td className="num">
                        {inRollup === null ? (
                          <span className="faint">
                            {token.custodyVisibility === "sealed"
                              ? "sealed"
                              : "not served"}
                          </span>
                        ) : (
                          amount(inRollup, decimals)
                        )}
                      </td>
                      <td className="num">{used}</td>
                      <td className="num">
                        {onSolana === null
                          ? "absent"
                          : amount(onSolana, decimals)}
                      </td>
                    </tr>
                  );
                },
              )}
            </tbody>
          </table>
        </div>
      )}
      <p className="faint" style={{ marginTop: 12 }}>
        &quot;In the rollup&quot; is the custody token account as the rollup
        endpoint serves it. A hosted endpoint may serve no token account that a
        program address owns, even for public custody; it then reads &quot;not
        served&quot; rather than a number the console cannot vouch for.
      </p>
      <p className="faint" style={{ marginTop: 8 }}>
        The cap holds a trader&apos;s deposit to the custody total; the
        admin&apos;s fund_insurance is not held to it, so insurance near the cap
        leaves less room for traders (RULES 11).
      </p>
    </Gate>
  );
}

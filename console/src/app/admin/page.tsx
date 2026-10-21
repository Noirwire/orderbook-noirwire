import { PublicKey } from "@solana/web3.js";
import { MARKET_KIND } from "@noirwire/orderbook";
import { Gate } from "@/components/access";
import { AdminActions } from "@/components/admin-actions";
import { Heading } from "@/components/bits";
import { networkFacts, type AdminFacts } from "@/lib/admin-facts";
import { launchBuildRefusal } from "@/lib/build";
import { selected } from "@/lib/selected";

export default async function AdminPage() {
  const { checked, state } = await selected();
  if (!state) return null;
  const { network, genesis } = checked;
  const { exchange } = state;
  if (!exchange) {
    return (
      <Gate need="admin">
        <Heading
          title="Actions"
          lead={`No exchange in the rollup yet. ${network.setup} sets it up.`}
        />
      </Gate>
    );
  }
  const facts: AdminFacts = {
    network: networkFacts(network, genesis),
    buildRefusal: await launchBuildRefusal(network, genesis),
    admin: exchange.admin.toBase58(),
    pendingAdmin: exchange.pendingAdmin?.toBase58() ?? null,
    paused: exchange.paused,
    gate: exchange.gate.toBase58(),
    oracle: exchange.oracle.toBase58(),
    maxSteps: exchange.maxSteps,
    maxSeatsPerDay: exchange.maxSeatsPerDay,
    collateralToken: exchange.collateralToken,
    tokens: state.tokens.map(({ index, token, decimals }) => ({
      index,
      mint: token.mint.toBase58(),
      custodyNonce: token.custodyNonce.toString(),
      visibility: token.custodyVisibility,
      cap: token.custodyCap.toString(),
      decimals,
    })),
    markets: state.markets.map(({ id, market, feed }) => ({
      id,
      name: `${market.baseSymbol}/${market.quoteSymbol}`,
      perp: market.params.kind === MARKET_KIND.perp,
      status: market.params.status,
      pythAccount:
        feed && !feed.binding.account.equals(PublicKey.default)
          ? feed.binding.account.toBase58()
          : null,
      fundingInterval: market.params.fundingInterval.toString(),
    })),
    quoteAccount: exchange.quote.account.equals(PublicKey.default)
      ? null
      : exchange.quote.account.toBase58(),
  };
  return (
    <Gate need="admin">
      <Heading
        title="Actions"
        lead="The admin's instructions, each built by the client's own Instructions and shown decoded, with the network, its genesis and the rollup's validator, before the wallet signs. Instructions that run in the rollup go to the rollup endpoint; set_custody_cap and fund_insurance go to the deposit endpoint, as the ops scripts send them."
      />
      <AdminActions facts={facts} />
    </Gate>
  );
}

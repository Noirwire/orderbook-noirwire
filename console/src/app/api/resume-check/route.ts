import { NextResponse, type NextRequest } from "next/server";
import { MARKET_STATUS } from "@noirwire/orderbook";
import { chainState, checkedNetwork } from "@/lib/chain";
import {
  gapBps,
  launchMarketDiffers,
  MAINNET_INSURANCE,
  MAINNET_MARKET,
  MAINNET_SIZING,
  openInterestCapFor,
  resumeVerdict,
  type ResumeCheckAnswer,
} from "@/lib/launch";
import { MAINNET_GENESIS } from "@/lib/networks";
import { launchReference } from "@/lib/reference";

export const dynamic = "force-dynamic";

type On = Pick<ResumeCheckAnswer, "network" | "programId" | "genesis">;

const NOWHERE: On = { network: null, programId: null, genesis: null };

const refused = (on: On, why: string, rest: Partial<ResumeCheckAnswer> = {}) =>
  NextResponse.json<ResumeCheckAnswer>({
    ...on,
    resume: false,
    why,
    mark: null,
    reference: null,
    gapBps: null,
    sources: [],
    covered: null,
    openInterestCap: null,
    ...rest,
  });

/**
 * The check the launch makes before `resume_market`, made fresh on the
 * network the page names, never the one the picker points at now: refused
 * unless that network's genesis and rollup check out and its program is the
 * one the page holds; then the launch's market only, with the launch's
 * settings, limits and feed, not active yet; its mark against the median of
 * the public exchanges (and Pyth Pro when the server has a token), priced in
 * the launch's own lot and refused beyond 1%; insurance against the open
 * interest cap; and on mainnet an admin that is not also the upgrade
 * authority. The answer names the network, program and genesis it was made
 * on.
 */
export async function GET(request: NextRequest) {
  const asked = request.nextUrl.searchParams;
  const name = asked.get("network") ?? "";
  const programId = asked.get("programId") ?? "";
  const checked = await checkedNetwork(name);
  const { network } = checked;
  if (network.name !== name || network.programId !== programId) {
    return refused(
      NOWHERE,
      `the page asked about ${name || "no network"} with program ${programId || "none"}, which networks.json does not name together: reload the page`,
    );
  }
  if (!checked.ok) return refused(NOWHERE, checked.why);
  const on: On = {
    network: network.name,
    programId: network.programId,
    genesis: checked.genesis,
  };
  if (network.profile !== "mainnet") {
    return refused(
      on,
      `${network.label} runs the test networks' profile; the console resumes only the launch profile's market`,
    );
  }
  const id = Number(asked.get("market"));
  const { symbol } = MAINNET_MARKET;
  if (id !== MAINNET_MARKET.id) {
    return refused(
      on,
      `the console resumes only ${symbol}, market ${MAINNET_MARKET.id}, the one market the launch opens`,
    );
  }
  const state = await chainState(network).catch((error: Error) => error);
  if (state instanceof Error) {
    return refused(on, `the chain could not be read: ${state.message}`);
  }
  const view = state.markets.find((each) => each.id === id);
  if (!view) return refused(on, `${symbol} is not set up`);
  const { params } = view.market;
  if (params.status === MARKET_STATUS.active) {
    return refused(
      on,
      `${symbol} is already active: there is nothing to resume`,
    );
  }
  const differ = launchMarketDiffers({
    params,
    binding: view.feed?.binding ?? null,
  });
  if (differ.length > 0) {
    return refused(
      on,
      `${symbol} is not the market the launch sets up: ${differ.join("; ")}`,
    );
  }
  const mark = view.feed?.price ?? 0n;
  const reference = await launchReference(checked.genesis === MAINNET_GENESIS);
  const sources = [
    ...reference.quotes.map(
      ({ name: source, atoms, note }) =>
        `${source} ${atoms}${note ? ` (${note})` : ""}`,
    ),
    ...reference.skipped.map(
      ({ name: source, why }) => `${source} skipped: ${why}`,
    ),
  ];
  if (reference.median === null) {
    return refused(on, `no reference price: ${reference.why}`, {
      mark: mark.toString(),
      sources,
    });
  }
  const covered =
    mark > 0n
      ? openInterestCapFor(
          MAINNET_INSURANCE,
          mark,
          MAINNET_SIZING.gapBps,
          BigInt(params.liqPenaltyBps),
        )
      : 0n;
  const admin = state.exchange?.admin.toBase58() ?? null;
  const verdict = resumeVerdict({
    mark,
    reference: reference.median,
    confirmed: asked.get("confirmed") === "yes",
    covered,
    openInterestCap: params.openInterestCap,
    adminUpgrades:
      checked.genesis === MAINNET_GENESIS &&
      admin !== null &&
      state.upgradeAuthority === admin,
  });
  return NextResponse.json<ResumeCheckAnswer>({
    ...on,
    resume: verdict.resume,
    why: verdict.resume ? null : verdict.why,
    mark: mark.toString(),
    reference: reference.median.toString(),
    gapBps: mark > 0n ? gapBps(mark, reference.median).toString() : null,
    sources,
    covered: covered.toString(),
    openInterestCap: params.openInterestCap.toString(),
  });
}

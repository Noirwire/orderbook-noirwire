import { cache } from "react";
import { Connection, PublicKey, type AccountInfo } from "@solana/web3.js";
import {
  Addresses,
  MAX_MARKETS,
  UPGRADEABLE_LOADER_ID,
  clockOf,
  decodeExchange,
  decodeHeader,
  decodeMarket,
  decodePriceFeed,
  decodeStats,
  type Exchange,
  type Market,
  type PriceFeed,
  type Stats,
  type TokenInfo,
} from "@noirwire/orderbook";
import { rollupDiffers } from "./identity";
import {
  configGap,
  networkNamed,
  rollupEndpoints,
  type Network,
} from "./networks";
import { observationIn, type Observation } from "./pyth";

const DELEGATION_PROGRAM = new PublicKey(
  "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh",
);
const READ_TIMEOUT_MS = 15_000;
const MINT_DECIMALS_AT = 44;
const TOKEN_AMOUNT_AT = 64;
const PROGRAM_DATA_HEADER = 45;
const HAS_AUTHORITY_AT = 12;
const AUTHORITY_AT = 13;

type Account = AccountInfo<Buffer> | null;

const connection = (url: string) =>
  new Connection(url, {
    commitment: "confirmed",
    fetch: (input, init) =>
      fetch(input, {
        ...init,
        cache: "no-store",
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      }),
  });

export type Checked =
  | { ok: true; network: Network; genesis: string }
  | { ok: false; network: Network; genesis: string | null; why: string };

/**
 * The network, refused before anything is read from it unless its Solana's
 * genesis is the one `networks.json` names for it and every rollup endpoint
 * is run by the validator it names.
 */
export const checkedNetwork = cache(
  async (name: string | undefined): Promise<Checked> => {
    const network = networkNamed(name);
    const gap = configGap(network);
    if (gap) return { ok: false, network, genesis: null, why: gap };
    const genesis = await connection(network.solanaUrl)
      .getGenesisHash()
      .catch((error: Error) => error);
    if (genesis instanceof Error) {
      return {
        ok: false,
        network,
        genesis: null,
        why: `${network.solanaUrl} did not give its genesis hash: ${genesis.message}`,
      };
    }
    if (!network.genesis) {
      return {
        ok: false,
        network,
        genesis,
        why: `networks.json names no genesis for ${network.label}. This RPC's is ${genesis}; write it there once you know it is the network you mean.`,
      };
    }
    if (genesis !== network.genesis) {
      return {
        ok: false,
        network,
        genesis,
        why: `${network.solanaUrl} is not ${network.label}: its genesis is ${genesis}, not ${network.genesis}.`,
      };
    }
    const differ = (
      await Promise.all(
        rollupEndpoints(network).map((url) =>
          rollupDiffers(url, network.validator),
        ),
      )
    ).filter((why) => why !== null);
    if (differ.length > 0) {
      return {
        ok: false,
        network,
        genesis,
        why: `${differ.join(" ")} networks.json names ${network.validator} as ${network.label}'s rollup.`,
      };
    }
    return { ok: true, network, genesis };
  },
);

/** A Pyth account's newest observation as Solana and as the rollup's clone of it hold it. */
export type PythRead = {
  account: string;
  solana: Observation | null;
  rollup: Observation | null;
};

export type MarketState = {
  id: number;
  market: Market;
  feed: PriceFeed | null;
  pyth: PythRead | null;
  volume: bigint;
  openInterest: bigint;
};

export type TokenState = {
  index: number;
  token: TokenInfo;
  decimals: number | null;
  /** The custody token account on Solana, in atoms. */
  onSolana: bigint | null;
  /**
   * The custody token account inside the rollup, in atoms, as the endpoint
   * serves it: read only for public custody, and null where the endpoint
   * does not serve it.
   */
  inRollup: bigint | null;
};

export type ChainState = {
  programId: string;
  exchangeAddress: string;
  clock: number;
  exchange: Exchange | null;
  onSolana: { lamports: number; delegated: boolean } | null;
  upgradeAuthority: string | null;
  statsReady: boolean;
  stats: Stats | null;
  markets: MarketState[];
  perpMarketIds: number[];
  guardPyth: PythRead | null;
  tokens: TokenState[];
};

const ready = (account: Account) =>
  account !== null && decodeHeader(account.data).ready;

const amountIn = (account: Account) =>
  account && account.data.length >= TOKEN_AMOUNT_AT + 8
    ? account.data.readBigUInt64LE(TOKEN_AMOUNT_AT)
    : null;

function upgradeAuthorityIn(account: Account): string | null {
  if (!account || account.data.length < PROGRAM_DATA_HEADER) return null;
  return account.data[HAS_AUTHORITY_AT] === 1
    ? new PublicKey(
        account.data.subarray(AUTHORITY_AT, PROGRAM_DATA_HEADER),
      ).toBase58()
    : null;
}

async function pythReads(
  solana: Connection,
  rollup: Connection,
  accounts: PublicKey[],
): Promise<PythRead[]> {
  if (accounts.length === 0) return [];
  const [onSolana, inRollup] = await Promise.all([
    solana.getMultipleAccountsInfo(accounts),
    rollup.getMultipleAccountsInfo(accounts),
  ]);
  return accounts.map((account, at) => ({
    account: account.toBase58(),
    solana: onSolana[at] ? observationIn(onSolana[at].data) : null,
    rollup: inRollup[at] ? observationIn(inRollup[at].data) : null,
  }));
}

/**
 * Everything public the console shows of one deployment, read in a few
 * batched requests. It never asks for the ledger, a book or a view: those
 * are sealed, and the console shows nothing of them to anyone.
 */
export const chainState = cache(
  async (network: Network): Promise<ChainState> => {
    const programId = new PublicKey(network.programId);
    const addresses = new Addresses(programId);
    const solana = connection(network.solanaUrl);
    const rollup = connection(network.rollupUrl);
    const marketIds = Array.from({ length: MAX_MARKETS }, (_, id) => id);
    const [rollupAccounts, solanaAccounts, clock] = await Promise.all([
      rollup.getMultipleAccountsInfo([
        addresses.exchange,
        addresses.stats,
        ...marketIds.map((id) => addresses.market(id)),
        ...marketIds.map((id) => addresses.priceFeed(id)),
      ]),
      solana.getMultipleAccountsInfo(
        [addresses.exchange, addresses.programData],
        {
          dataSlice: { offset: 0, length: PROGRAM_DATA_HEADER },
        },
      ),
      clockOf(rollup),
    ]);
    const [exchangeAccount, statsAccount] = rollupAccounts;
    const marketAccounts = rollupAccounts.slice(2, 2 + MAX_MARKETS);
    const feedAccounts = rollupAccounts.slice(2 + MAX_MARKETS);
    const [exchangeOnSolana, programData] = solanaAccounts;
    const exchange = exchangeAccount
      ? decodeExchange(exchangeAccount.data)
      : null;
    const statsReady = ready(statsAccount);
    const stats =
      statsReady && statsAccount ? decodeStats(statsAccount.data) : null;

    const present = marketIds.filter((id) => ready(marketAccounts[id]));
    const feeds = new Map(
      present
        .filter((id) => ready(feedAccounts[id]))
        .map((id) => [id, decodePriceFeed(feedAccounts[id]!.data)] as const),
    );
    const bound = present.filter(
      (id) =>
        feeds.get(id) &&
        !feeds.get(id)!.binding.account.equals(PublicKey.default),
    );
    const guardAccount =
      exchange && !exchange.quote.account.equals(PublicKey.default)
        ? exchange.quote.account
        : null;
    const pyth = await pythReads(solana, rollup, [
      ...bound.map((id) => feeds.get(id)!.binding.account),
      ...(guardAccount ? [guardAccount] : []),
    ]);
    const markets = present.map((id) => {
      const at = bound.indexOf(id);
      return {
        id,
        market: decodeMarket(marketAccounts[id]!.data),
        feed: feeds.get(id) ?? null,
        pyth: at >= 0 ? pyth[at] : null,
        volume: stats?.volume[id] ?? 0n,
        openInterest: stats?.openInterest[id] ?? 0n,
      };
    });

    const registered = (exchange?.tokens ?? [])
      .map((token, index) => ({ token, index }))
      .filter(({ token }) => !token.mint.equals(PublicKey.default));
    const custodyAccounts = registered.map(({ token }) =>
      addresses.custody(token),
    );
    const [mints, custodies, balances] = await Promise.all([
      solana.getMultipleAccountsInfo(registered.map(({ token }) => token.mint)),
      solana.getMultipleAccountsInfo(custodyAccounts),
      rollup.getMultipleAccountsInfo(custodyAccounts),
    ]);
    const tokens = registered.map(({ token, index }, at) => ({
      index,
      token,
      decimals: mints[at]?.data[MINT_DECIMALS_AT] ?? null,
      onSolana: amountIn(custodies[at]),
      inRollup:
        token.custodyVisibility === "public" ? amountIn(balances[at]) : null,
    }));

    return {
      programId: programId.toBase58(),
      exchangeAddress: addresses.exchange.toBase58(),
      clock,
      exchange,
      onSolana: exchangeOnSolana
        ? {
            lamports: exchangeOnSolana.lamports,
            delegated: exchangeOnSolana.owner.equals(DELEGATION_PROGRAM),
          }
        : null,
      upgradeAuthority:
        programData?.owner.equals(UPGRADEABLE_LOADER_ID) === true
          ? upgradeAuthorityIn(programData)
          : null,
      statsReady,
      stats,
      markets,
      perpMarketIds: marketIds.filter(
        (id) => exchange && (exchange.perpMarkets >> id) & 1,
      ),
      guardPyth: guardAccount ? pyth[pyth.length - 1] : null,
      tokens,
    };
  },
);

"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { Instructions, type Exchange } from "@noirwire/orderbook";
import {
  SEAT_ACCESS_COMPUTE_UNITS,
  marketBits,
  ownerKey,
  perpMarketId,
  seatAccessInstructions,
  switchesText,
} from "@ops/accessing";
import { useAccess } from "./access";
import {
  Card,
  Review,
  planned as plannedOn,
  reasonOf,
  useSigner,
  type Planned,
} from "./review";
import { useConsoleWallet } from "./wallet";
import type { NetworkFacts } from "@/lib/admin-facts";
import { exchangeNow, perpMarketIdsOf } from "@/lib/rollup";

/** One perp market's public switches, as the server read them. */
export type AccessMarket = {
  id: number;
  name: string;
  makersListed: boolean;
  takersListed: boolean;
};

export type AccessFacts = {
  network: NetworkFacts;
  /** On the launch profile or mainnet, why the program there is not the checked build; null when it is or elsewhere. */
  buildRefusal: string | null;
  markets: AccessMarket[];
};

const REVIEW_ID = "access-actions";

/** The ids of a seat list as the ops command takes them: `none`, or the ids joined by commas. */
const listText = (ids: number[]) => (ids.length > 0 ? ids.join(",") : "none");

const toggled = (ids: number[], id: number, on: boolean) =>
  on
    ? [...ids.filter((each) => each !== id), id].sort((a, b) => a - b)
    : ids.filter((each) => each !== id);

function MarketSwitches({
  market,
  onReview,
}: {
  market: AccessMarket;
  onReview: (makersListed: boolean, takersListed: boolean) => void;
}) {
  const [makers, setMakers] = useState(market.makersListed);
  const [takers, setTakers] = useState(market.takersListed);
  const unchanged =
    makers === market.makersListed && takers === market.takersListed;
  return (
    <Card title={`Market ${market.id}: ${market.name}`}>
      <p>
        Now {switchesText(market)}. A list switched on lets only the seats
        listed for this market make, or take, here.
      </p>
      <label className="check">
        <input
          type="checkbox"
          checked={makers}
          onChange={(event) => setMakers(event.target.checked)}
        />
        <span>Maker list on</span>
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={takers}
          onChange={(event) => setTakers(event.target.checked)}
        />
        <span>Taker list on</span>
      </label>
      {makers && !market.makersListed && (
        <p className="warn-text">
          Only over an empty book, with its maker already listed: unlisted
          orders on a live book stay until takers clear them.
        </p>
      )}
      <div className="row">
        <button
          type="button"
          className="primary"
          disabled={unchanged}
          onClick={() => onReview(makers, takers)}
        >
          Review set_market_access
        </button>
      </div>
    </Card>
  );
}

function MarketPicks({
  label,
  markets,
  picked,
  onChange,
}: {
  label: string;
  markets: AccessMarket[];
  picked: number[];
  onChange: (ids: number[]) => void;
}) {
  return (
    <fieldset className="picks">
      <legend className="label">{label}</legend>
      {markets.map((market) => (
        <label key={market.id} className="check">
          <input
            type="checkbox"
            checked={picked.includes(market.id)}
            onChange={(event) =>
              onChange(toggled(picked, market.id, event.target.checked))
            }
          />
          <span>
            {market.id}: {market.name}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/**
 * The admin's access list instructions (RULES 3a), built with the client
 * exactly as `ops/accessing.ts` builds them and sent to the rollup endpoint,
 * where `make <network>-access` sends them. Rendered for the exchange's admin
 * alone; everyone else sees the switches only.
 */
export function AccessActions({ facts }: { facts: AccessFacts }) {
  const router = useRouter();
  const wallet = useConsoleWallet();
  const { role } = useAccess();
  const signer = useSigner(facts.network.genesis);
  const programId = useMemo(
    () => new PublicKey(facts.network.programId),
    [facts.network.programId],
  );
  const instructions = useMemo(() => new Instructions(programId), [programId]);
  const [planned, setPlanned] = useState<Planned | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [owner, setOwner] = useState("");
  const [makerMarkets, setMakerMarkets] = useState<number[]>([]);
  const [takerMarkets, setTakerMarkets] = useState<number[]>([]);
  const [blocked, setBlocked] = useState(false);

  if (role !== "admin") return null;

  if (facts.buildRefusal) {
    return (
      <section className="notice danger">
        <h2>Actions are refused on {facts.network.label}</h2>
        <p>
          On the launch profile the program on chain must be the checked build,
          as the access command requires: {facts.buildRefusal}.
        </p>
      </section>
    );
  }

  /** The exchange read again, refused unless the wallet is still its admin, as the access command refuses. */
  async function exchangeAsAdmin(admin: PublicKey): Promise<Exchange> {
    const exchange = await exchangeNow(
      facts.network.rollupUrl,
      instructions.addresses,
    );
    if (!exchange.admin.equals(admin)) {
      throw new Error(
        `The exchange's admin is ${exchange.admin.toBase58()}, not ${admin.toBase58()}. Nothing was built.`,
      );
    }
    return exchange;
  }

  async function plan(
    title: string,
    build: (
      admin: PublicKey,
    ) => Promise<TransactionInstruction | TransactionInstruction[]>,
  ) {
    setProblem(null);
    try {
      setPlanned(
        await plannedOn(
          facts.network,
          wallet.publicKey,
          title,
          "rollup",
          build,
          programId,
        ),
      );
      requestAnimationFrame(() =>
        document
          .getElementById(REVIEW_ID)
          ?.scrollIntoView({ behavior: "smooth", block: "start" }),
      );
    } catch (error) {
      setProblem(reasonOf(error));
    }
  }

  const reviewMarket = (
    market: AccessMarket,
    makersListed: boolean,
    takersListed: boolean,
  ) =>
    plan(`Market ${market.id} access`, async (admin) => {
      const perpIds = perpMarketIdsOf(await exchangeAsAdmin(admin));
      const marketId = perpMarketId("The market", String(market.id), perpIds);
      return instructions.setMarketAccess(admin, marketId, {
        makersListed,
        takersListed,
      });
    });

  const reviewSeat = () =>
    plan("Seat access", async (admin) => {
      const perpIds = perpMarketIdsOf(await exchangeAsAdmin(admin));
      return seatAccessInstructions(
        instructions,
        admin,
        ownerKey("The seat owner", owner.trim()),
        {
          makerMarkets: marketBits(
            "Maker markets",
            listText(makerMarkets),
            perpIds,
          ),
          takerMarkets: marketBits(
            "Taker markets",
            listText(takerMarkets),
            perpIds,
          ),
          blocked,
        },
        perpIds,
      );
    });

  return (
    <div className="access-actions" id={REVIEW_ID}>
      {planned && (
        <Review
          key={planned.decoded.map(({ dataHex }) => dataHex).join(" ")}
          planned={planned}
          network={facts.network}
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

      <section>
        <h2>Operator rules</h2>
        <ul className="rules">
          <li>
            Switch a maker list on over an empty book: list the maker with
            set_seat_access first, and switch the list on before resume_market
            opens a new market. Over a live book the unlisted orders stay until
            takers clear them, and fill again at their old prices if the list is
            switched off.
          </li>
          <li>
            Have a seat send cancel_all on every market before unblocking it or
            listing it as a maker: a block or a list leaves its resting orders
            on the book, and they fill at their old prices once it may make
            there again. Without its cooperation, unblock it with its maker
            markets cleared, which cancels its orders there, and set them in a
            second call. Clearing cancels only where a maker bit was set: on a
            market where it never was, set the bit and then clear it before
            listing the seat for real. The lists name perp markets only, so a
            blocked seat&apos;s spot orders come back with the unblock, and only
            its own cancel removes them. When the books are full, clear bits on
            one market per call: the compute unit limit may not cover several
            full books, and a call that runs out changes nothing.
          </li>
          <li>
            A lone listed maker&apos;s inventory on a market can be rebuilt by
            anyone from the tape and the public open interest; the same holds
            for a lone listed taker. Maker privacy holds only once several
            makers are listed: tell a market maker so before listing it.
          </li>
          <li>
            Check that the seat is open first. A set_seat_access naming an owner
            with no open seat fails with SeatNotOpen (6011), and the
            exchange&apos;s public signature list shows that it failed.
          </li>
        </ul>
      </section>

      <section>
        <h2>Market switches</h2>
        {facts.markets.length === 0 ? (
          <p className="dim">The exchange has no perp market.</p>
        ) : (
          <div className="cards">
            {facts.markets.map((market) => (
              <MarketSwitches
                key={`${market.id}-${market.makersListed}-${market.takersListed}`}
                market={market}
                onReview={(makers, takers) =>
                  reviewMarket(market, makers, takers)
                }
              />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2>A seat&apos;s lists</h2>
        <div className="cards">
          <Card title="Set a seat's lists and block">
            <p>
              Sets the seat&apos;s maker markets, taker markets and block all at
              once, replacing what it had. Clearing a maker market cancels the
              seat&apos;s resting orders there, but only where its maker bit was
              set; a bit that was never set cancels nothing until it is set and
              cleared again. Spot orders are never cancelled here: only the
              seat&apos;s own cancel removes them. Sent with a compute unit
              limit of {SEAT_ACCESS_COMPUTE_UNITS.toLocaleString("en-US")} on
              every call, with the book of every perp market, as the access
              command sends it; when the books are full, clear one market per
              call, since a call that runs out changes nothing and must be sent
              again.
            </p>
            <label className="field">
              <span className="label">Seat owner</span>
              <input
                value={owner}
                onChange={(event) => setOwner(event.target.value)}
                placeholder="the owner's public key"
                aria-label="Seat owner"
              />
            </label>
            {facts.markets.length > 0 && (
              <div className="pick-grid">
                <MarketPicks
                  label="Maker on"
                  markets={facts.markets}
                  picked={makerMarkets}
                  onChange={setMakerMarkets}
                />
                <MarketPicks
                  label="Taker on"
                  markets={facts.markets}
                  picked={takerMarkets}
                  onChange={setTakerMarkets}
                />
              </div>
            )}
            <label className="check">
              <input
                type="checkbox"
                checked={blocked}
                onChange={(event) => setBlocked(event.target.checked)}
              />
              <span>
                Blocked: reduce-only on every market, spot included; it can
                still cancel, withdraw and close
              </span>
            </label>
            <div className="row">
              <button
                type="button"
                className="primary"
                disabled={owner.trim() === ""}
                onClick={reviewSeat}
              >
                Review set_seat_access
              </button>
            </div>
          </Card>
        </div>
      </section>
    </div>
  );
}

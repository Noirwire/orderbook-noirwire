# Order book console

A private Next.js site the operator runs on his own machine to watch and administer one deployment of the order book program. It is not deployed anywhere and stores no key: every instruction is signed by the connected wallet.

```sh
make console-dev    # build the client, then run the console on http://127.0.0.1:3100
make console        # build the client, then a production build of the console
```

Inside `console/`: `npm run dev`, `npm run start`, `npm run build`, `npm run lint`, `npm run typecheck` (the client in `sdk/dist` must be built first; the Makefile targets do that). `dev` and `start` listen on 127.0.0.1 only, so no other machine on the network reaches the site. `make check`, and so CI, runs the console's type check and lint, and CI builds it.

Set `PYTH_PRO_TOKEN` in the environment the console's server runs in to add Pyth Pro to the reference a first mark is checked against, as the ops scripts do; without it the reference is the three public exchanges alone. The token goes to Pyth Pro only and is never shown. `PYTH_PRO_URL` points a test network at another Pyth Pro; on mainnet anything but Pyth's own is refused.

## Networks

`networks.json` names every network the console can be pointed at, and the picker in the header switches between them. Each has:

| Field                  | What it is                                                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `solanaUrl`, `genesis` | The Solana RPC and the genesis hash it must answer with. Nothing is read or shown until it does; an empty `genesis` shows nothing either. |
| `programId`            | The program the exchange runs on.                                                                                                         |
| `rollupUrl`            | Where the public accounts are read and the admin's rollup instructions are sent, as `ROLLUP_URL` in the Makefile.                         |
| `depositUrl`           | Where `set_custody_cap` and `fund_insurance` are sent, as `DEPOSIT_URL`.                                                                  |
| `privateUrl`           | A send to this address signs in first: the wallet signs the endpoint's challenge once per session, as the ops scripts sign in their keys. |
| `validator`            | The identity `rollupUrl` and `depositUrl` must answer `getIdentity` with, as `VALIDATOR`. Checked with the genesis on every page load.    |
| `profile`              | `mainnet` for the launch profile (the devnet rehearsal and mainnet), `test` for the test networks' exchange.                              |
| `strangers`            | What a wallet that is neither the admin nor a viewer sees: `stats`, or `none`.                                                            |
| `setup`                | The command the Launch page names for a pending step.                                                                                     |

`viewers` lists the public keys that see the stats pages on every network.

The local network's genesis changes with every `make up`, so its entry ships empty: the console then shows the RPC's genesis, to be written into `networks.json` once it is the network meant. Mainnet's rollup endpoint, its validator and the program id are chosen at launch and ship empty too.

## Who sees what

- **Admin**: the wallet the exchange records as its admin, read from the chain. Sees everything, including the Actions page.
- **Pending admin**: sees the Actions page with one action, `accept_admin`.
- **Viewer**: a key on the viewer list. Sees the stats pages only; no action is rendered.
- **Anyone else**: the stats pages where the network's `strangers` is `stats`. Where it is `none` the browser shows them nothing, but see below.

The roles are a convenience, not a security boundary. The browser works out the role from the connected wallet, which proves nothing to the server, and the server renders every page into the HTML and data it sends; the gate only hides them from view. So `strangers: "none"` keeps a page off the screen, not out of the response: anyone who can reach the site can read the stats in it. That is acceptable only because every number comes from public accounts that anyone can read from the same endpoints, so nothing secret is in it. The real authority is the program's own check that the admin signed: an admin instruction sent by any other key is refused on chain whatever this site renders. The site listens on 127.0.0.1 only; keep it on the operator's own machine.

## Pages

- **Exchange**: pause state, seats opened today against the daily cap, the lifetime order and fill counters, the admin, pending admin, upgrade authority, gate and oracle, and whether the ledger exists. The ledger itself is sealed and never read.
- **Markets**: per market, its status, mark and the mark's age, the price source's health and the Pyth account's age, open interest against its cap, volume, the caps, fees, liquidation, funding and margin settings, the last observation and incident. For the launch's market, SOL-PERP on the launch profile, also its settings compared with the launch's, and the reference price, priced in the launch's own lot, with the mark's distance from it.
- **Prices**: the USDC guard's state, price, age and how long it still passes; every Pyth account the program reads with its age on Solana and in the rollup; the SOL/USD reference from Coinbase, Kraken and Bitstamp and its median.
- **Custody**: every registered token with its custody cap and visibility, and for public custody the custody token account's balance in the rollup, where the endpoint serves it, and on Solana. A sealed custody balance is not shown. The hosted devnet endpoint serves no token account that a program address owns, so on the rehearsal the rollup column reads "not served".
- **Launch**: the mainnet profile's launch steps in order, each done, pending or not readable from public accounts (insurance, the keeper's seat and the funding task live where the public cannot read them), with the setup command for each pending step. The market step is done only when market 0 has the launch's settings, limits and Pyth feed, compared field by field as the setup compares them. Read only; the program deploy stays on the command line.
- **Actions**: the admin's instructions (below).
- **Access lists**: each perp market's maker list and taker list switches, read from its public market account. A seat's lists and block flag are sealed in the ledger and cannot be read back by anyone, the admin included, so the page never shows them. The admin also sees the operator rules of `SECURITY.md` and the two access actions (below); everyone else sees the switches only.

Nothing from the sealed ledger, a book or a trader's view is read, for anyone.

## Actions

Each action builds its instruction with the client's `Instructions`, so there is no second implementation of any of them. When the review opens, the console reads the genesis and the rollup's identity again, decodes the instruction from its own bytes (name, every field, every account with its signer and writable flags, and the data) and shows it with the network, its genesis, the validator, the program, the fee payer and the endpoint it goes to. Values an instruction carries over from the chain (the gate, oracle and max steps of `update_exchange`, the perp markets of `resume_market`) are read from the rollup then, not when the page loaded. When the operator signs, the console reads the genesis and the identity of the endpoint once more, right before the wallet is asked, and sends what the wallet returns only if it is the reviewed transaction byte for byte with a valid signature of the reviewed fee payer: a wallet that adds a compute budget, a priority fee or a guard instruction of its own gets nothing sent. On mainnet the operator types the program id to go ahead. On the launch profile (the devnet rehearsal and mainnet) every action is refused unless the program on chain is, byte for byte, the build `make check-mainnet DECLARED_ID=<id>` left under `target/mainnet/<id>`, as the setup requires.

| Action                                | Instruction                                | Sent to          |
| ------------------------------------- | ------------------------------------------ | ---------------- |
| Pause or resume the exchange          | `set_paused`                               | rollup           |
| Pause a market or make it reduce-only | `restrict_market`                          | rollup           |
| Make a market active                  | `resume_market`, after the check below     | rollup           |
| Sync a market or the USDC guard       | `sync_price`, `sync_quote`                 | rollup           |
| Seats per day                         | `update_exchange`, gate and oracle as kept | rollup           |
| Schedule funding                      | `schedule_funding`                         | rollup           |
| Propose or accept a new admin         | `propose_admin`, `accept_admin`            | rollup           |
| Custody cap                           | `set_custody_cap`                          | deposit endpoint |
| Fund insurance                        | `fund_insurance`, from the admin's balance | deposit endpoint |
| A perp market's list switches         | `set_market_access`                        | rollup           |
| A seat's lists and block              | `set_seat_access`, after a compute limit   | rollup           |

The two access actions are built as `make <network>-access` builds them, with the same code (`ops/accessing.ts`): the market and the seat's market lists are checked against the exchange's perp markets read from the rollup when the review opens, and `set_seat_access` names the book of every perp market in rising order and goes in one transaction behind a compute unit limit of 1,400,000, on every call. Both are refused unless the wallet is still the exchange's admin then.

## Shared with the ops scripts

The console decides as the ops scripts do by importing their code, not a copy of it (`@ops/*` in `tsconfig.json` is `../ops/*`): the launch's market, limits and price sources (`ops/profiles.ts`), the launch steps, the market comparison, the USDC guard check, the reference sources and the check before `resume_market` (`ops/launch.ts`), the Pyth account and reference price reading (`ops/prices.ts`), the build check (`ops/program.ts`) and the access instructions (`ops/accessing.ts`). Each of those modules only computes: none reads a file, a key or the environment of the ops scripts when imported.

`resume_market` is built only after the same check the launch makes, on the network, program and genesis the page was loaded for (the page sends them, the server checks that network afresh and refuses unless they match, and the page compares the ones the answer names before it builds anything, so a network switched in another tab cannot lend its check to this one). Only the launch's market is resumed, only on the launch profile, and only while it is not already active. It must have the launch's settings, limits and Pyth feed, decimals included, as `launchedMarket` in the setup requires. Then its mark is checked against the median of Coinbase, Kraken and Bitstamp's SOL/USD last trades, with Pyth Pro added when the server has `PYTH_PRO_TOKEN`, priced in the launch's own lot rather than the decimals the market was bound with, so a decimal slip shows as a gap. It is refused beyond 1% (or when fewer than two sources answer, or the middle two disagree by more than 1%). Insurance must cover the open interest cap across the planned gap, on mainnet the admin must not be the upgrade authority, and the operator confirms that he checked the mark against another source.

`schedule_funding` and `fund_insurance` are not idempotent: a second send starts a second task or adds again. The launch sends each once per program and records it; check the Launch page and the deployment description before sending either here.

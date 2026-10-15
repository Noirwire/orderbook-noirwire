# @noirwire/orderbook-mcp

An MCP server that lets an AI agent (Claude Desktop, Claude Code, Cursor, any MCP client) trade on NoirWire's private order book.

**Devnet only. Test money only.** The server trades on the Solana devnet test network, with a free test grant that has no real value. Before it signs in or signs anything it checks the deployment: the network must be `devnet`, the program must be the NoirWire order book, and the Solana chain behind it must have devnet's genesis hash. Anything else is refused. It also checks the funding transaction the service hands it (the service pays the fee, `open_trader` plus a deposit into the collateral, nothing else) before the owner key signs it.

Orders rest and match inside a private rollup. Nobody but the program can read the book or another trader's account; the agent trades through its own signed-in connection, with one-time order keys.

## Install and run

Once published:

```
npx @noirwire/orderbook-mcp
```

From this repository:

```
make mcp
node mcp/dist/index.js
```

### Claude Code

```
claude mcp add noirwire -- npx -y @noirwire/orderbook-mcp
```

### Claude Desktop and other clients

Add the server to the client's MCP configuration:

```json
{
  "mcpServers": {
    "noirwire": {
      "command": "npx",
      "args": ["-y", "@noirwire/orderbook-mcp"]
    }
  }
}
```

Node 24 or newer is required. The server talks MCP over stdio and logs only to stderr.

## Configuration

Environment variables only.

| Variable           | Default                                          | What it is                                                                                             |
| ------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `NOIRWIRE_SIM_URL` | `https://sim-noirwire-production.up.railway.app` | The public simulation service: market data, the deployment description and the test grant.             |
| `NOIRWIRE_KEYPAIR` | `~/.config/noirwire/devnet-trader.json`          | A Solana CLI keypair file (a JSON array of 64 numbers): the trader. Created with mode 0600 if missing. |

The trader's one-time order keys are derived from the keypair. Their position in that derivation is saved beside it, in `<keypair path>.checkpoint.json`. It holds no secret. The derivation is the trading terminal's, so the same keypair is the same trader in the terminal and here.

The keypair is a devnet key. Do not point `NOIRWIRE_KEYPAIR` at a key that holds real funds.

One server process owns a keypair at a time, held by a lock file named after the trader's public key (`~/.config/noirwire/locks/<public key>.lock`, holding the process id), so a copy or link of the same keypair shares the lock. A second process on the same trader refuses to start and says so; give it its own keypair with `NOIRWIRE_KEYPAIR`. A lock left by a process that is gone is taken over.

## Tools

Every amount, price and size, in and out, is a decimal string.

| Tool               | What it does                                                                                                                                                                                                                                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_markets`      | The public markets: id, kind, base and quote, mark price, 24h change and volume, open interest, tick size, lot size, maximum leverage.                                                                                                                                                                                      |
| `get_trades`       | Recent public fills on a market (`market`, `limit` up to 100).                                                                                                                                                                                                                                                              |
| `get_candles`      | Price candles (`market`, `interval` of `1m`, `5m`, `15m` or `1h`, `limit` up to 500).                                                                                                                                                                                                                                       |
| `get_account`      | The trader's address, collateral, spot balances, perp positions and open orders. Open orders cover one market: the `market` named, else the first.                                                                                                                                                                          |
| `fund_account`     | Opens the trader's account and deposits the test grant into the perpetuals collateral. Spot buys spend the spot balance, so move nUSD there with `transfer_balance` first. Says so when the account is already funded, or why the service cannot grant it right now.                                                        |
| `place_order`      | `market`, `side`, `type` (`limit`, `market`, `post_only`, `ioc`), `size`, `price`, `reduce_only`. Reports filled, rested (with the id to cancel by), cancelled remainder or refused, with the filled size, average price and fee. A market order's price is its worst acceptable price; left out, it is 1% beyond the mark. |
| `transfer_balance` | `direction` (`to_spot` or `to_collateral`) and `amount` of nUSD: moves value between the perpetuals collateral and the spot balance, no tokens leaving the account. Needed before a spot buy.                                                                                                                               |
| `cancel_order`     | Cancels one resting order by `market` and `order_id`.                                                                                                                                                                                                                                                                       |
| `cancel_all`       | Cancels every resting order the trader has in a market.                                                                                                                                                                                                                                                                     |
| `check_privacy`    | Reads the trader's account and the market's order book from the rollup with no sign-in, as a stranger would, and reports that each came back empty.                                                                                                                                                                         |

A size must be a whole number of lots and a price a multiple of the market's tick; `get_markets` gives both. Anything else is refused before it is sent, with the reason.

## What stays private, what is public

| Hidden                                                         | Public                                                                 |
| -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Every resting order: price, size, side, owner                  | Each market's settings                                                 |
| Book depth                                                     | The tape: price, size, time and two one-off receipts per fill          |
| Every trader's balances, positions and open orders             | The price feed (mark price)                                            |
| The content of every trading transaction: accounts, data, logs | Counters: orders, fills, volume (liquidations excluded), open interest |
| Which trader sent which order                                  | That some transaction touched the program, when, and whether it failed |

The secrecy is enforced by the rollup's query filter, not by the program: on a hosted private validator that is the operator's promise and its sealed hardware. Trades are visible, and so is timing. One-time order keys remove the reusable key that would otherwise tie a trader's orders together; they do not make a trader unlinkable. [docs/DESIGN.md](../docs/DESIGN.md) section 1 has the full account, and the [root README](../README.md) says what the program guarantees and what it does not. The program has not had a third-party audit.

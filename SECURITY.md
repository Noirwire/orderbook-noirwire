# Security

This program runs a private order book for spot and perpetual markets on a private rollup. It keeps every trader's tokens in custody accounts it alone can pay out of, and every trader's balances, positions and resting orders in accounts nobody but the program can read. If you find a way to move tokens you did not deposit, to trade or cancel for a seat you do not own, to read a ledger, a book or another trader's view, or to make the custody balance disagree with the sum of the seats, please tell us privately before telling anyone else.

## Reporting a vulnerability

Email **ph1l1ph@proton.me**.

Include what you found, how to reproduce it, and what an attacker gains. A proof of concept helps. Please do not open a public issue, and do not test against seats, markets or custody accounts that are not yours.

You will get an acknowledgement, and we will keep you informed while we work on a fix. We will credit you when the fix ships unless you would rather we did not.

## What matters most

- Anything that pays tokens out of custody other than `withdraw` signed by the seat's owner, to the owner's own token account, within margin.
- Anything that credits a seat without the same instruction moving the tokens into custody.
- Anything that lets a key other than one of a view's four order keys place, cancel or liquidate for that seat, or lets an order key withdraw, close or replace keys.
- Anything that lets a reader who is not the owner read a view, or anyone at all read the ledger or a book, through the private endpoint.
- Anything that moves a price other than the oracle authority within the move limit, or the admin's reset.
- Anything that lets someone other than the upgrade authority set up the exchange, or someone other than the admin change its settings, add markets, pause, or move the exchange.

## What a leaked order key can do

A trader's view holds four order keys. Each trading instruction is signed by one of them and names the key that replaces it, so a key is used once and an observer cannot link two orders. The flip side: whoever holds one live order key holds, until the owner notices, one of the trader's four trading seats.

With one leaked order key an attacker can:

- Place one order for the trader, at any price inside the market's band around the mark, for as much as the seat's balance or margin allows. On a market where the attacker also has a seat, that is a way to trade with the victim at a price up to the band away from the mark, which is a transfer of value from the victim to the attacker.
- Cancel one of the trader's orders, or all of them on a market.
- Liquidate another trader using the victim's seat as the liquidator, within the victim's margin.
- Move the trader's funds between their own spot balance and their own perpetuals collateral, within the withdrawal checks. Nothing leaves the seat or custody, but collateral moved to spot no longer backs a position, and spot funds moved to collateral can be put at risk by an order.
- Name the replacement key. The attacker names a key they hold, so the leaked key becomes a leaked slot that stays theirs for as long as they keep replacing it.

What an attacker with an order key cannot do:

- Withdraw. `withdraw` is signed by the owner, and the view's address is derived from the owner that signs, so no order key can reach it.
- Close the seat, or replace the four keys. Both are owner-only the same way.
- Read the view, the ledger or a book. Order keys are not members of any permission. The attacker learns the outcome of their order only by its public effects, such as a fill on the tape.
- Act outside the expiry window of the instruction they sign, or more than once with the same key: the key is replaced when the instruction succeeds.

The way back is `set_order_keys`, signed by the owner: it replaces all four keys at once and the attacker's slot is gone. The exposure is therefore bounded by the band, by the seat's balance, and by how long the owner takes to notice. An order key is not a wallet key: keep it on the trading device, derive the next one from the seed the client documents, and never reuse one.

## What this program does not guarantee

- Confidentiality of reads is the rollup's query filter. The program attaches the permissions; the rollup enforces them. The rollup's own port serves everything to anyone who can reach it, and on a hosted validator that port is the operator's promise.
- Ordering. The operator orders transactions and can delay or drop them. An order can execute long after it was sent; the expiry on every trading instruction is the limit on that.
- The price. One oracle key writes the mark within a move limit. That is a test-network arrangement.
- Anything outside the rollup. Withdrawal back to Solana is not part of this program.

The same contact is embedded in the deployed program as a `security.txt` section, readable with [query-security-txt](https://github.com/neodyme-labs/solana-security-txt).

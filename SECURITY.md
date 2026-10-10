# Security

This program runs a private order book for spot and perpetual markets on a private rollup. It keeps every trader's tokens in custody accounts it alone can pay out of, and every trader's balances, positions and resting orders in accounts nobody but the program can read. If you find a way to move tokens you did not deposit, to trade or cancel for a seat you do not own, to read a ledger, a book or another trader's view, or to make the custody balance disagree with the sum of the seats, please tell us privately before telling anyone else.

## Reporting a vulnerability

Email **ph1l1ph@proton.me**.

Include what you found, how to reproduce it, and what an attacker gains. A proof of concept helps. Please do not open a public issue, and do not test against seats, markets or custody accounts that are not yours.

You will get an acknowledgement, and we will keep you informed while we work on a fix. We will credit you when the fix ships unless you would rather we did not.

## What matters most

- Anything that pays tokens out of custody other than `withdraw` signed by the seat's owner, to the owner's own token account, within margin, or `collect_fees` signed by the admin, for no more than the fee seat holds of that token.
- Anything that pays a balance out of a custody account other than the one its token was registered with. The collateral token is fixed when the exchange is created, a token's mint and custody account are fixed when it is registered, and a market's tokens are fixed when it is created.
- Anything that credits a seat without the same instruction moving the tokens into custody.
- Anything that lets a key other than one of a view's four order keys place, cancel or liquidate for that seat, or lets an order key withdraw, close or replace keys.
- Anything that lets a reader who is not the owner read a view, or anyone at all read the ledger or a book, through the private endpoint.
- Anything that moves a price other than the oracle authority within the move limit, or the admin's reset.
- Anything that returns a market to active status other than `resume_market`, which refuses while the market has a recorded shortfall.
- Anything that lets someone other than the upgrade authority set up the exchange, or someone other than the admin change its settings, add markets, pause, or move the exchange.

## What a leaked order key can do

A trader's view holds four order keys. Each trading instruction is signed by one of them and names the key that replaces it. "Used once" is a statement about linkability: no two instructions carry the same signer, so an observer cannot link them. It is not a limit on a thief. Whoever holds one live order key names the next key, so a leaked key stays usable, one instruction after another, until the owner replaces all four keys with `set_order_keys`. Nothing expires it and nothing else revokes it.

With one leaked order key an attacker can, for as long as that lasts:

- Place orders for the trader, one per instruction and as many instructions as they like, each at any price inside the market's band around the mark, for as much as the seat's balance or margin allows. On a market where the attacker also has a seat, that is a way to trade with the victim at a price up to the band away from the mark, again and again, which is a transfer of value from the victim to the attacker.
- Cancel the trader's orders, one by one or all of them on a market.
- Liquidate other traders using the victim's seat as the liquidator, within the victim's margin.
- Move the trader's funds between their own spot balance and their own perpetuals collateral, within the withdrawal checks. Nothing leaves the seat or custody, but collateral moved to spot no longer backs a position, and spot funds moved to collateral can be put at risk by an order.
- Name the replacement key each time. The attacker names a key they hold, so the leaked key is a leaked slot that stays theirs.

What an attacker with an order key cannot do:

- Withdraw. `withdraw` is signed by the owner, and the view's address is derived from the owner that signs, so no order key can reach it.
- Close the seat, or replace the four keys. Both are owner-only the same way.
- Read the view, the ledger or a book. Order keys are not members of any permission. The attacker learns the outcome of their order only by its public effects, such as a fill on the tape.
- Use the same key twice. That limits nothing: the key they named in its place is theirs too.

The way back is `set_order_keys`, signed by the owner: it replaces all four keys at once and the attacker's slot is gone. The exposure is bounded by the band, by the seat's balance and margin, and by how long the owner takes to notice, and by nothing else. An order key is not a wallet key: keep it on the trading device, derive the next one from the seed the client documents, and never reuse one.

## What the expiry bounds

Every order-key instruction carries `expires_at`. The program refuses it once the rollup's clock is past that time, or when that time is more than 60 seconds ahead of the rollup's clock. That bounds when an instruction may execute. It says nothing about when it was signed: a signed instruction is valid for whatever window it names, and anyone holding the signed bytes can submit them inside that window. The operator, who orders transactions, can hold one until the last second of it.

## What each privileged key can do

**The gate key** co-signs `open_trader`, and nothing else. Stolen, together with owner keys the thief makes up, it opens seats: each costs the exchange the rent of a view and its permission and takes one of the 2,048 places in the table. The exchange opens no more seats in one UTC day of the rollup's clock than its `max_seats_per_day` setting, and the counted day only moves forward, so a clock that steps back to an earlier day does not start a new count. The loss per day is bounded by that number, and the admin closes seats that were never used with `close_unused_trader`, which returns their rent and their place. A seat that ever took a deposit, an order or a transfer is no longer the admin's to close. The gate key cannot move tokens, trade, read anything, or change a setting. The admin replaces it with `update_exchange`.

**The oracle key** writes the mark price of every market, each new price within `max_move_bps` of the last and no sooner than `min_publish_gap` seconds after it. Stolen, it walks the mark step by step in any direction. That makes healthy positions liquidatable and unhealthy ones safe, moves the band orders are accepted in, moves funding, and lets its holder profit as a trader or a liquidator at the expense of others, up to everything the seats hold as collateral. By not publishing it stops orders that increase exposure and withdrawals by position holders. It cannot pay tokens out of custody, change a setting, or read anything private. The admin replaces it with `update_exchange`; `reset_price` then puts the market in reduce-only status, or leaves it paused if it was.

**The admin key** changes the gate, the oracle, the step limit and the daily seat cap; registers tokens; creates markets and changes their limits within the bounds of `RULES.md` section 12; pauses the exchange; pauses a market or makes it reduce-only; resets a price to any value, which has every effect a stolen oracle key has without the move limit; collects everything in the fee seat; moves perp fees to the insurance seat and funds it; closes seats that were never used; schedules funding; moves the exchange between Solana and the rollup, and takes the exchange's own lamports on Solana down to its rent. It cannot pay a trader's balance out of custody, cannot change which custody account a balance is paid from, cannot return a market to active while it has a recorded shortfall, and cannot read the ledger, a book or a view through the private endpoint. Through a price reset and its own seat it can still take traders' collateral by liquidation, so it is trusted with the perpetual markets' money. The role moves in two steps and the old admin keeps nothing.

**The program's upgrade authority** can replace the program, and a replaced program can do anything with every account this one owns, custody included. It is part of the custody trust model whatever the rest of this page says. It is a different thing from the exchange's admin: the upgrade authority sets up the exchange and becomes its first admin, and after that changing one does not change the other. Handing the admin role to a new key leaves the upgrade authority where it was, and moving the upgrade authority leaves the admin where it was.

## What an observer can learn

The ledger, the books and the views are private. A custody balance is private when its token was registered sealed: `register_token` then refuses a custody balance that has no private permission, or one that a member can read through. These are not private, and each is a signal:

- **A token registered with public custody.** The admin chooses sealed or public when a token is registered, the exchange records the choice and it never changes. Public custody shows anyone that token's total in custody, and so the size and time of every deposit and withdrawal as the total changes. A depositor's or withdrawer's own token balance is shown too when that account is public, which a deposit or withdrawal through a private endpoint requires, and that ties the amount to that wallet. It does not show resting orders, book depth, seat balances or positions. The endpoint serves no transaction contents, so it does not show which seat was credited or debited either, and anyone can deposit for anyone. Devnet uses public custody because MagicBlock's hosted endpoint refuses a transaction of any program other than the token programs that names a private token balance; the evidence is the table in `spike/devnet/README.md`.

- **Anyone can deposit for anyone.** A deposit names its beneficiary by the address of the beneficiary's view, which anyone derives from the owner's key, so a third party can deposit into any open seat without knowing its number. A seat that holds anything cannot be closed, so an unwanted deposit blocks `close_trader` until the owner withdraws it, and it ends the admin's right to close the seat as unused.
- **`cover_shortfall`** is callable by anyone for any seat and changes nothing when the seat does not qualify, so the call itself reveals nothing. When it does pay, the market's recorded shortfall, which is public, falls by the amount, and that tells an observer that the named seat was flat with negative collateral and how much it was covered for. A market going reduce-only with a recorded shortfall is public the same way.
- **Open interest** per market is public. It moves with fills, and it moves on a liquidation whenever the liquidator's own position offsets what it takes over. A liquidation adds nothing to the public volume and fill counters and prints nothing on the tape, but a change of open interest with no fill on the tape tells an observer that a liquidation happened on that market and for how many lots net.
- **Liquidation attempts.** A liquidator learns from a successful liquidation that the target was below maintenance margin, and which way it was positioned. The three outcomes with nothing to liquidate (no such seat, no position, not below maintenance) and a liquidation price beyond the liquidator's worst price are recorded in the liquidator's view as one value with every number zero, so an attempt cannot be used to find out whether a seat exists or holds a position. Two outcomes stay distinct. "Stale price" is decided before the target is looked at. "Liquidator margin insufficient" only happens when the target was liquidatable, so it does reveal that; this is accepted, since the same liquidator with more margin would have learned it by liquidating. The compute a transaction used is not equalised between those outcomes; whether the private endpoint shows it to the liquidator has not been measured.

## What this program does not guarantee

- Confidentiality of reads is the rollup's query filter. The program attaches the permissions; the rollup enforces them. The rollup's own port serves everything to anyone who can reach it, and on a hosted validator that port is the operator's promise.
- A custody permission against a change of the programs that guard it. The program checks the permission when the token is registered and not again. That is enough as those programs stand, because every way to change it needs the signature of the custody authority, which is an address of this program that signs one thing only, an SPL Token transfer out of custody:
  - The token program's `ResetEphemeralAtaPermission` and `UndelegateEphemeralAtaPermission` both require a signer equal to the balance's owner (`IncorrectAuthority` and `InvalidAccountData` otherwise). Creating the permission is open to anyone, but only with no read flags, and it does nothing when the permission exists.
  - The permission program's own update takes the signature of a member with the authority flag or of the guarded balance. The only member the token program ever writes is the balance's owner, and the balance is an address of the token program, which signs for it only in the instructions above.
  - This program has no instruction that signs as the custody authority towards either program, so nobody can loosen a custody permission, the admin included.

  This was read from the interface in `ephemeral-rollups-sdk` 0.17.3 and the token program's published source, not from the deployed bytes. Both programs are upgradeable by their own authority, and an upgrade could change the rule; the program would not notice.

- A private endpoint takes no transaction of this program that names a private token balance. The local filter (query-filtering-service 0.1.3) refuses it whoever sends it and whatever flags its permission gives the sender; a plain SPL transfer that names the same balance passes. The hosted devnet endpoint (magicblock-core 1.0.0, measured 2026-10-09) does the same, for the balance's own owner too, and also when the permission exists on Solana without being delegated; it accepts the SPL Token and Associated Token programs, and this program when every token balance it names is public. With sealed custody, `register_token`, `deposit`, `withdraw`, `collect_fees` and `fund_insurance` therefore go to the rollup's own port (`DEPOSIT_URL` in the Makefile, `depositUrl` in the deployment description), which only the local network has. Through a hosted endpoint they need a public custody balance and a public depositor or recipient balance, which is why devnet's tokens are registered public. That is the endpoint's rule, not a property of the program.
- A public custody against a permission attached later. `register_token` checks once that a public custody balance has no permission. The token program lets any payer create a permission for any balance: simulated on Solana devnet on 2026-10-10, a stranger's `createEataPermission` for a delegated public custody balance of an unsignable owner succeeded, at the stranger's cost of the permission's rent. A permission that exists, delegated or not, makes the hosted endpoint refuse this program's transactions that name the balance. So a stranger can probably stop deposits, withdrawals and fee collection of a public-custody token through the hosted endpoint, and the recorded visibility would then no longer describe the balance. It was not carried out against a registered custody. Tokens could not be taken this way; they could be stuck until the endpoint or the token program changes.
- Ordering. The operator orders transactions and can delay or drop them. An order can execute any time before its expiry.
- The price. One oracle key writes the mark within a move limit. That is a test-network arrangement.
- Anything outside the rollup. Withdrawal back to Solana is not part of this program.

The same contact is embedded in the deployed program as a `security.txt` section, readable with [query-security-txt](https://github.com/neodyme-labs/solana-security-txt).

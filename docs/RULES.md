# NoirWire order book: trading rules

The exact rules the program enforces. Every rule here has a test. Where this file and
the code disagree, one of them is a bug.

All quantities are integers. Intermediate products use 128-bit integers. Every
operation is checked, and an overflow fails the instruction and changes nothing, with
these exceptions:

- Where an error would reveal the book or another trader's seat, an overflow is an
  outcome like any other refusal there. A fill that does not fit the maker's balances
  counts as the maker failing its fill check, and one that does not fit the taker's,
  its fee, or the fee or insurance seat's balance as the taker failing (section 4).
  Arithmetic that does not fit in a liquidation, once the target has been looked at,
  ends as a "nothing to liquidate" or "liquidator margin insufficient" status (section
  8).
- Funding's totals and index skip what does not fit (section 7).
- The public statistics in `Stats` (the order count, the fill count and each market's
  volume) and the filled notional and fee that an order result reports to its sender
  stop at their largest value, because no money depends on them and a report must
  never fail a trade. Open interest is not a statistic and stays checked: the engine
  keeps it in the book, and `Stats` publishes the book's figure.
- A market's recorded uncovered shortfall stops at its largest value, 2^64 - 1 quote
  atoms, rather than fail a liquidation. While it is above zero, withdrawals stay
  stopped (section 6); it could understate a debt only beyond that amount.

## 1. Units

| Name       | Meaning                                                                   |
| ---------- | ------------------------------------------------------------------------- |
| quote atom | smallest unit of the quote token (nUSD has 6 decimals)                    |
| base atom  | smallest unit of the base token                                           |
| lot        | `base_lot` base atoms, set per market                                     |
| size       | a whole number of lots, greater than zero                                 |
| price      | quote atoms per lot, a multiple of the market's `tick`, greater than zero |
| notional   | `price * size`, in quote atoms                                            |
| bps        | one hundredth of one percent; ratios are stored in bps                    |

Fees and penalties round up against the payer, except that a liquidation penalty
capped by what the target can pay rounds down (section 8). Nothing else rounds: every
other formula below is exact in integers.

## 2. Order types

Every order has a side, a size, a price and a 16-byte secret chosen by the client.
A market order's price is its worst acceptable price.

| Type                | Matches                                                                              | Remainder         |
| ------------------- | ------------------------------------------------------------------------------------ | ----------------- |
| Limit               | while the best opposite price is at or better than its price                         | rests on the book |
| Post only           | never; if it would match at all the whole order is refused as an outcome (section 3) | rests on the book |
| Immediate or cancel | as Limit                                                                             | cancelled         |
| Market              | as Limit, against its worst price                                                    | cancelled         |

Flags: `reduce_only` (perps only): the order may only shrink the trader's position; its
size is capped to the position at placement and again at each fill, and it never rests.

## 3. Acceptance checks, in order

A check that depends only on public settings, the mark price and the trader's own state
fails the instruction with an error. A check that depends on the contents of the book
never fails the instruction: the instruction succeeds, changes nothing else, and records
the outcome where only the trader can read it. Otherwise anyone could learn what is in
the book by reading the public error of an order sent, or only simulated. The
book-dependent outcomes are: a post-only order that would match, and an order that
would rest on a full side (checks marked _outcome_ below). A seat that sends real
orders still reads its own outcomes, and from post-only ones it can learn the best
price of each side inside the crossing band (`DESIGN.md` section 1).

An order is refused, changing nothing, if any check fails:

0. The instruction's expiry time has not passed, and is at most 60 seconds ahead of
   the rollup's clock when it executes. Every order-key instruction carries one. The
   program cannot see when an instruction was signed, so the bound is on execution: a
   signed instruction may run at any moment up to the expiry it names. The rollup can
   execute a transaction long after it was sent; an order must not fill at a price its
   sender chose for a moment long past.
1. Exchange and market are not paused. A market in reduce-only status accepts only
   reduce-only orders (section 2), and cancels.
2. Size is at least the market's minimum; price is on the tick; notional at the order
   price is at least the market's minimum notional.
3. Price is within the market's bands around the mark price. Two bands apply to every
   type. The crossing band (`band_bps`): a bid may be at most that far above the mark,
   an ask at most that far below it. It is smaller than the gap between initial and
   maintenance margin, so a fill at the edge cannot consume a trader's margin. The
   outer band (50%): no order may be further from the mark than that in either
   direction. It bounds how far an order may sit; what stops far-away or expired
   orders from holding a full side is the eviction of check 8. A market whose feed
   has never had a price has no mark, and every order on it is refused (section 9).
4. The price feed is fresh, unless the order is reduce-only. A reduce-only order is
   judged as if it filled in full. While that cannot raise the seat's worst-case size
   on the market (section 6), it skips this check and the margin check. It can raise
   it when the seat has resting orders on the order's own side that its position
   covered: once the position is gone they stand alone. Then the order needs a fresh
   feed here and on every market where the seat holds a position, and initial margin
   as in check 6, so a stale feed refuses it. Cancelling those orders first lets it
   through.
5. The trader has fewer than the per-trader open order limit on this market, if any
   part of the order could rest.
6. Spot: the trader's available balance covers the lock (section 5), and, for a bid
   that is not post-only on a market with a taker fee, one quote atom per step of the
   step limit on top (`MAX_STEPS`, section 4). Each fill rounds its own fee up, so a
   bid that takes in `n` fills can pay up to `n` atoms more than the one rounding in
   its lock. Those atoms are not locked; they only have to be there, so that a
   shortfall never shows up as an error that depends on how the book splits the fills.
   Perps: the margin check passes (section 6), except for a reduce-only order as in
   check 4.
7. _Outcome._ A post-only order that would match at all is refused whole.
8. _Outcome._ If a remainder would rest and that side of the book is full, it evicts
   one order and rests in its place. That is the side's lowest-priority expired
   order, wherever it sits, whatever the new price; with none expired, it is the
   side's lowest-priority order (the worst price, and the newest at that price), and
   only when the new price is strictly better than that order's. An expired order
   can never fill, so it would otherwise hold its place until matching reached it.
   The evicted order is cancelled as in section 5, whoever owns it: what it locked
   returns to `available`, and a perp order's lots stop counting toward initial
   margin. Nothing public records it: no fill, no tape entry, no counter. Its owner
   sees it gone from its own view, as with an order matching cancels. At most one
   order is evicted per order. Otherwise the remainder is cancelled. Fills made
   before that point stand either way. An order resting at the worst price of a full
   side can be evicted again and again by strictly better orders that are then
   cancelled; that is the price of a full side, and no funds are at risk.

An immediate-or-cancel or market order that finds nothing to match succeeds with a
filled size of zero. That is also an outcome, never an error.

## 4. Matching

- Priority is best price first, then lowest sequence number. The program assigns the
  sequence number when it accepts an order. Sequence follows the order in which the
  rollup executed transactions; the rollup's operator decides that order.
- A fill executes at the resting order's price. Any improvement goes to the taker.
- If the next resting order belongs to the taker, that resting order is cancelled and
  matching continues. This counts as one step toward the step limit.
- One `place_order` performs at most `MAX_STEPS` fills and self-cancels. If the limit
  is reached while the order could still match, the remainder is cancelled, whatever
  the order type, and the result says so. It never rests a crossing order.
- Before each perp fill the engine checks both sides as they would be after it, at the
  current mark (section 6, "Fill checks"). A resting order that fails is cancelled and
  matching continues; this counts as one step. If the taker fails, matching stops and
  the remainder is cancelled. Both are outcomes, never errors.
- A resting order that now breaches the crossing band around the current mark is
  cancelled when matching reaches it, not filled. So is a resting order whose own
  expiry time has passed. Each counts as one step.
- A resting order may carry an expiry time of its own (optional, set at placement). A
  market maker that loses its connection cannot cancel, and nobody else can see its
  quotes; the expiry removes them.
- Each fill gets the market's next fill sequence number and is appended to the tape.

## 5. Spot money

A seat holds, per token, two disjoint amounts: `available` and `locked`.

- Bid: lock `price * size` plus the taker fee on that amount, rounded up. Ask: lock
  `size` lots. A bid that can take must also hold, unlocked, one atom per step for the
  rounding of each fill's fee (section 3, check 6).
- Fill, buyer side: `locked` quote falls by the amount reserved for the filled size;
  the buyer pays `fill_price * fill_size`; the difference returns to `available`; base
  `available` rises by the filled lots.
- Fill, seller side: `locked` base falls by the filled lots; quote `available` rises by
  `fill_price * fill_size`.
- The taker pays `taker_fee_bps` of the fill's notional in quote, rounded up. Makers
  pay nothing. A spot fee goes wholly to the fee seat, whatever the market's
  `fee_insurance_share_bps`: the insurance seat pays only from collateral (section 8),
  so a spot token balance in it could never cover anything.
- A perp fee is taken from collateral. Of each, `fee_insurance_share_bps` goes to the
  insurance seat and the rest to the fee seat, so insurance grows with trading and does
  not wait for an admin.
- Cancel or end of an order: whatever it still has locked returns to `available`.

## 6. Perpetuals money

One cross-margin account per trader. Per market a seat holds `base` (signed lots),
`quote` (signed quote atoms) and `funding_checkpoint`. A fill of `s` lots at price `p`:
buyer `base += s`, `quote -= p*s`; seller `base -= s`, `quote += p*s`. The taker's fee
is taken from collateral. When `base` returns to zero, `quote` is added to collateral
and reset to zero. There is no division anywhere in this accounting.

Collateral for perpetuals and the quote balance used for spot trading are two separate
balances of the same token, as on other venues that keep a spot wallet beside a
perpetuals account. A trader moves funds between them with one instruction, which
applies the withdrawal checks to the side being debited. No token leaves custody.

- **Equity** = collateral + sum over markets of (`base * mark + quote`), after funding
  is settled.
- **Worst-case size** on a market = max(`max(0, base + open bids)`,
  `max(0, -base + open asks)`), in lots.
- **Initial margin** = sum over markets of worst-case size `* mark * im_bps`.
- **Maintenance margin** = sum over markets of `|base| * mark * mm_bps`.
- An order is accepted only if, counting it as resting in full and reserving its
  taker fee, equity is at least initial margin.
- A withdrawal is accepted only if collateral covers it and equity after it is at
  least initial margin.
- While any market has a recorded uncovered shortfall, collateral withdrawals are
  refused for everyone, and the admin cannot collect the fee seat's collateral
  (section 12a). Otherwise the first to withdraw would be paid in full and the last
  would carry the whole loss. Spot balances, the collateral token's included, stay
  withdrawable: they are not claims on the perp pool, and collateral cannot move into
  them while the shortfall is recorded.

**Fill checks.** A fill happens at the resting order's price, which can differ from the
mark by up to the band. So acceptance at the mark is not enough. For each side of a
proposed fill, with that side's equity and margins recomputed as if the fill had
happened:

- if the fill increases that side's position size: equity must be at least initial
  margin for the taker, and at least the midpoint of initial and maintenance margin
  for the maker;
- if it does not increase it: either initial margin holds afterwards, or the fill must
  not make the account riskier: maintenance margin must not rise and the ratio of
  equity to maintenance margin must not fall (compared by cross-multiplication); an
  account left with no position on any market needs only equity that is not negative,
  so a trader can always close completely;
- in every case: equity must not be negative.

A market also has an open interest cap. A fill that would raise total long size above
it is treated like a failed taker check: matching stops and the remainder is cancelled.

No fill can therefore leave a seat owing more than it has. Only a move of the mark can
do that, and that is what liquidation and the insurance seat are for.

## 7. Funding

Each perp market has a cumulative index `F` (signed quote atoms per lot), a carry (a
fraction of one atom per lot, kept in 1/65536 units, below one atom in magnitude), a
last update time, and two totals since that time: the premium sum `P` and the counted
size `V`.

**Rate.**

- Funding is quoted per `FUNDING_PERIOD` = 8 hours (28,800 s), a program constant.
- `funding_cap_bps` is the most funding can charge in one period.
- One interval charges `funding_interval / FUNDING_PERIOD` of the period's rate. So a
  market's interval changes how often funding is paid, not how much.

**What a fill records.**

- A fill made by `place_order` on a perp market while the market's price feed is fresh
  adds `size` to `V` and `size * clamp(price - mark, -c, +c)` to `P`.
  - `mark` is the mark in force when it filled.
  - `c = price * funding_cap_bps / 10000`, rounded down.
- A fill at its own mark records zero premium, whatever the mark does afterwards.
- Fills at a stale mark, liquidation takeovers and resting quotes record nothing.
- If adding a fill's totals would not fit, the order's fills record nothing; `P` and
  `V` always move together.

**When `update_funding` acts.**

- Anyone may call `update_funding`. It fails only when the market is not a perp, or
  when the exchange or the market is paused.
- It does nothing and succeeds in these cases:
  - `funding_interval` has not passed since the last update;
  - the mark is 0;
  - the mark is stale.
- Otherwise it applies exactly one interval, clears `P` and `V`, and sets the last
  update time to now. Missed intervals are not caught up.
- Because a stale price no longer makes it fail, the built-in scheduler can call it.

**Step.**

- With `OI` the open interest at the update and `K = FUNDING_FEE_MARGIN = 4`, the step
  per lot is

  `P * funding_interval * taker_fee_bps / max(V * taker_fee_bps * FUNDING_PERIOD, K * OI * funding_cap_bps * funding_interval)`

  rounded toward zero in 1/65536 of an atom. It is 0 when both terms of the `max` are 0.
- It is then clamped to `+-mark * funding_cap_bps * funding_interval / (10000 *
  FUNDING_PERIOD)` at the current mark.
- Read plainly: the step is the size-weighted premium of the interval's fills, scaled
  to one interval. It is scaled down further when fewer than `K * OI * funding_cap_bps
  * funding_interval / (taker_fee_bps * FUNDING_PERIOD)` lots traded. The scaling is
  proportional, with no threshold to step over.

**Carry.**

- The carry is added to the step.
- `F` moves by the whole atoms, rounded toward zero, and the remainder becomes the new
  carry.
- An interval whose arithmetic does not fit moves neither `F` nor the carry, but still
  clears `P` and `V`.

**What moving funding costs.**

- In any interval, the clamped step before rounding, times `OI`, is at most one
  quarter of the taker fees paid on that interval's fills.
- Adding fills to an interval, including fills that dilute someone else's premium,
  changes the step times `OI` by at most `(1 + r) / 4` of the taker fees on the added
  fills, where `r` is the highest fill price in the interval over the lowest added one.
  When the fills are priced alike that is one half; fills sit within the crossing band
  of the mark, so `r` stays close to 1.
- Whoever receives funding holds at most `OI` lots. So trading to move funding loses
  about half of what it costs or more, whatever the open interest, band, cap, honest
  volume or number of seats.
- This requires `taker_fee_bps > 0` on every perp market and no maker rebate. A rebate
  or fee discount must be subtracted from `taker_fee_bps` in this rule and in section
  12.

**Settlement.**

- Whenever a seat's position on a market is touched (fill, liquidation, withdrawal,
  margin check), it first pays `base * (F - funding_checkpoint)` out of `quote` and
  sets its checkpoint to `F`. Longs pay when `F` rose.
- Because total long equals total short and `F` is an integer, funding sums to zero
  exactly. The carry belongs to no seat.

## 8. Liquidation

A trader is liquidatable when their equity is below maintenance margin and the price
feed of the market being liquidated is fresh. Positions on other markets are valued at
their last published price, fresh or not, so one stale feed cannot shield a trader
from liquidation elsewhere.

The liquidator is held to more, because a liquidation adds to its exposure: every
market where it holds a position must have a feed no older than that market's
`max_age_liquidation`. Otherwise the attempt ends as "stale price", like a stale feed
on the market being liquidated, before the target is looked at. A price that stopped
could otherwise hide that the liquidator cannot carry what it takes over.

No trader can read the ledger, so a liquidator cannot see who is unhealthy. `liquidate`
names a seat by number and is tried blind. Whether the target existed, had a position
or was healthy must not be visible to the public: those cases succeed, change nothing,
and the result is written where only the liquidator can read it. That includes the
liquidator lacking the margin to take the position, which only happens when the target
was liquidatable. An error can come only from who the caller is, a pause, or invalid
arguments.

1. If the target holds no position on that market, or its equity is at least
   maintenance margin, it stops. Open orders weigh only on initial margin, so this test
   does not depend on them.
2. If the liquidation price of step 3 is worse for the liquidator than the worst
   acceptable price it states, it stops, and that is recorded like any other "nothing
   to liquidate" case.
3. Otherwise `liquidate` cancels every open order of the target on that market, and
   the liquidator takes over part of the position at the liquidation price:
   mark less the penalty when the target is long, mark plus the penalty when the
   target is short. The size is the smallest of: the requested size, the position, and
   the size that brings the target back to maintenance margin plus a buffer
   (`liq_buffer_bps`), counting each lot's full penalty, `liq_penalty_bps` of the mark
   rounded up to a whole atom. If what would remain is below the market's minimum
   size, the whole position is taken. The penalty per lot is that full penalty, but
   never more than the target can pay: its equity at the mark before the takeover,
   divided by the size taken and rounded down, and zero when that equity is not
   positive. A target bankrupt at those prices is therefore taken over at the mark and
   earns its liquidator nothing; a target that keeps part of its position can always pay the
   full penalty, so the cap changes only a takeover of the whole position or of less
   than the size that restores margin.
3a. The penalty is split: `liq_insurance_share_bps` of it, rounded down, goes to the
   insurance seat, the rest to the liquidator. When the insurance seat is not open or
   could not take the credit, the liquidator keeps all of it.
4. The liquidator must meet initial margin afterwards, or it stops as "liquidator
   margin insufficient". Whenever `liquidate` stops, at this step or an earlier one,
   nothing changes: the cancellations of step 3 happen only together with the
   takeover.
5. If the target ends with no position and negative equity, the shortfall is paid from
   the insurance seat. If insurance cannot cover it, the market goes to reduce-only
   status and the uncovered amount is recorded on the market. Because of the cap in
   step 3, a target with a shortfall paid no penalty in this liquidation, so the
   insurance seat pays the target's deficit at the mark and not a liquidator's bonus.
   Otherwise a seat of the same owner could take a position that went bankrupt after a
   price gap and be paid a bonus out of insurance. The cap does not stop the deficit
   itself: a position left unliquidated past bankruptcy costs insurance its deficit,
   and whoever held the other side of the losing trades, a second seat of the same
   owner included, keeps the matching gain. How far that can go is bounded by the move
   limit of sections 9 and 12, the open interest cap and the insurance balance
   (`SECURITY.md`). The cap is also computed at the prices this liquidation uses, with
   other markets at their last price, fresh or stale: a target that pays a full
   penalty here and later goes bankrupt on another market, for example when a stale
   feed catches up, leaves insurance a deficit that penalty made larger.
6. `cover_shortfall` may be called by anyone for a seat that has no position on any
   market and negative collateral, naming a market: the insurance seat pays what it
   can, never more than that market has recorded, and that market's recorded amount
   falls by the same. A change in a market's recorded amount is public.
7. `reconcile_shortfall` may be called by anyone: if debtors have repaid by deposit,
   the recorded amounts are lowered, market 0 first, until together they equal what
   flat seats still owe. It never raises one.
8. A recorded amount says on which market a debt was recorded, not whose debt it is:
   a cover may name any market that has a record, and a reconcile lowers whichever
   comes first. Only their sum is a fact about what flat seats owe (section 13.9b),
   so every rule reads the sum. Withdrawals stop while any market has a record
   (section 6), and the admin may return a market to normal status, which is
   possible only through `resume_market`, only while no market has one. So no
   market is resumed while any debtor still owes, and once every debtor has repaid
   and a reconcile has run, every market can be resumed.

## 9. Price feed

- `publish_price` is signed by the oracle authority. Publish time must be later than
  the previous one by at least `min_publish_gap` seconds and must not be in the future.
  The feed also records the rollup time at which each price was accepted, and a new
  price is accepted only `min_publish_gap` seconds of rollup time after the last one,
  whatever its publish time says. Prices stamped in the past cannot be stacked into
  one transaction or one slot.
- A price of zero or above `MAX_PRICE` (section 12) is rejected, published or reset.
- A price that differs from the previous one by more than `max_move_bps` is rejected.
  Together with the gap this bounds how fast the mark can move: at most one
  `max_move_bps` step per `min_publish_gap` seconds of rollup time. After an outage the
  oracle needs several gaps to catch the mark up with the market; the admin's reset is
  the fast path.
- A feed that has never had a price takes none from `publish_price`, since there is
  no previous price to bound it by: a first price could be anything up to `MAX_PRICE`,
  a decimal slip a thousand times off included. Its first price is the admin's reset,
  below, which leaves the market in reduce-only status, so a market opens only when
  the admin resumes it on a price the admin set. Before that first price the market
  has no mark and accepts no order (section 3, check 3). From then on every price the
  oracle publishes is within the move limit of the one before.
- The admin can reset a feed with a separate instruction. It skips the move limit and
  the gap, but not `MAX_PRICE`. Its publish time must not be in the future, and it
  counts as an accepted price for the next gap. A publish time in the past is allowed,
  so the admin can mark a feed stale on purpose. A reset puts the market in
  reduce-only status until the admin returns it to normal with `resume_market`
  (section 8, step 8). A paused market stays paused.
- A feed older than the market's `max_age` is stale. Staleness blocks orders that
  increase exposure and withdrawals by a trader who has a perp position. A transfer
  between a trader's spot and collateral balances debits like a withdrawal (section
  6), so it is blocked the same way, in either direction. It never blocks cancels,
  deposits, or a reduce-only order that cannot raise the seat's worst-case size
  (section 3, check 4): a trader on a stale feed adds collateral by depositing it, and
  closes a position whose resting orders on the same side would outlast it by
  cancelling those first.
- Liquidation uses a longer limit, `max_age_liquidation`: the moment a feed falters is
  the moment liquidations matter most. The limit applies to the market being
  liquidated and to every market where the liquidator holds a position (section 8).
- One key writing the mark is a test-network arrangement. Real money needs a feed whose
  signature the program verifies.

## 10. Fill receipts

A fill on the public tape carries a maker receipt and a taker receipt, each 8 bytes:
the first 8 bytes of `sha256(order secret || fill sequence || role byte)`. A client
recomputes them for its own open orders to recognise its fills. Two fills of the same
order carry unrelated receipts, so the tape does not link them.

The tape still shows each fill's price, size and time. Unusual sizes and timing can be
correlated by an observer. Read against the public open interest, which moves once per
order by the net of that order's fills, an order with one fill also shows whether its
two anonymous counterparties were opening or closing, and a lower bound on what they
held (`SECURITY.md`, open interest). The claim this design supports is: resting
orders, depth, balances and positions are private, in the sense that no one can read
who holds what. It does not claim that trades are invisible.

Funding (section 7) reveals only a statistic of fills, which already appear on the
tape, and the open interest, which is public. It reads no resting order, so it reveals
no depth.

## 11. Custody

Deposits and withdrawals move tokens and change seat balances in the same instruction,
so a credit without a transfer is impossible. For every custody account, at all times,
summing over every seat, the fee and insurance seats included:

`custody balance = spot + perp + outside`

- `spot`: `available + locked` of every token kept in that account. A mint registered
  at several indices keeps one custody account (`DESIGN.md` section 6), so its
  balances at each index add up here.
- `perp`: for the collateral's custody account only, collateral plus, for every perp
  position, `quote` less the funding it has not settled yet, `base * (F -
  funding_checkpoint)` (section 7). Zero for every other account. Stored `quote`
  alone does not add up while some seats have settled funding and others have not.
- `outside`: tokens that reached the account other than through this program: a plain
  token transfer into it, which the token program allows anyone, or a balance it held
  before its token was first registered, which registration does not check. They
  belong to no seat and no instruction pays them out.

Whether a token's custody balance is sealed or public is fixed when it is registered and
changes nothing in this rule.

## 12. Limits and settings

Per market: `min_size`, `min_notional`, `band_bps`, book capacity per side, open orders
per trader. Global: seat count, `MAX_STEPS`. A full seat table rejects; it never
evicts. A full side of a book evicts an expired order for any order that would rest,
and otherwise rejects an order unless its price is strictly better than the side's
worst resting order, which it then evicts (section 3, check 8).
A seat's balance of any token is capped well below the integer limit, so
a credit can never overflow.

A market's settings are refused unless all of these hold: `0 < mm_bps < im_bps <=
10000`; `liq_penalty_bps + taker_fee_bps < mm_bps`; `0 < band_bps <= im_bps - mm_bps`;
`max_move_bps < mm_bps - liq_penalty_bps`, so one price update cannot take a healthy
account past insolvency, and since updates are at least `min_publish_gap` seconds of
rollup time apart, a liquidator can act between any two of them; `funding_cap_bps <= im_bps - mm_bps`; `taker_fee_bps <= 100`;
both insurance shares at most 10000; `max_age <= max_age_liquidation`; tick, lot,
minimum size, funding interval, publish gap, open interest cap and both price ages
greater than zero; `open_interest_cap <= MAX_OPEN_INTEREST_CAP`.

**Price and size bounds.** No feed accepts a price above `MAX_PRICE` = 2^35 quote atoms
per lot, about 34,000 nUSD at 6 decimals (section 9; an asset dearer than that per lot
takes a smaller lot), and no market an `open_interest_cap` above
`MAX_OPEN_INTEREST_CAP` = 2^24 lots, about 16.8 million. A position is at most its
market's open interest, so a seat holding the cap on all 8 markets, valued at
`MAX_PRICE`, holds 8 * 2^24 * 2^35 = 2^62 of notional: exactly `BALANCE_CAP`, the most
a token balance may hold. Deposits, fees, penalties and insurance keep collateral
within `BALANCE_CAP` in either direction; realised profit is booked without that
check, so a winner's collateral can end above it, and a withdrawal brings it back
under. From that, the widest arithmetic fits with room:

- Maintenance margin times 10,000 (sections 6 and 8) is below 2^62 * 10,000 < 2^76.
- Initial margin times 10,000 also counts resting orders, which the cap does not
  bound. The position is below 2^63 lots and the open orders and the order being
  checked are each below 2^64, so the worst-case size is below 2^66 and the total
  below 2^66 * 2^35 * 2^14 * 8 = 2^118, 2^9 inside the signed 128-bit limit.
- Equity counts `base * mark` below 2^59 per market, and the liquidation size of
  section 8.3 works on margins and equity of that size.
- The liquidation price, the mark plus at most a whole mark of penalty
  (`liq_penalty_bps < mm_bps <= 10000`), is below 2^36.
- Funding's clamp, `mark * funding_cap_bps * funding_interval * 65536`, is below 2^35 *
  2^14 * 2^15 * 2^16 = 2^80.

One product is outside these bounds: the cross-multiplication of equity and
maintenance margin that compares an account's ratios (section 6, "Fill checks") for a
fill that reduces a position held below initial margin. It fits whenever equity is
below 2^51 atoms, about 2.2 billion nUSD. Above that the fill can be refused as a
failed check, never wrongly passed; a fill that leaves the account with no position
on any market and liquidation do not use it.

These bounds hold each product at one moment, not sums that grow over time. Funding
settled into a position's `quote` grows for as long as the position stays open: at
`MAX_PRICE`, the full cap and the program's highest funding cap of 100 bps paid in one
direction, it outgrows 64 bits after roughly a year and a half without a close, and
every instruction that settles that seat's funding then fails. At the settings in
`ops/deployment.ts` the same takes about 100,000 years.

A perp market must also satisfy:

- `taker_fee_bps >= 1` when `funding_cap_bps > 0`, since the fee is what moving
  funding costs (section 7);
- `funding_interval <= FUNDING_PERIOD`;
- `funding_cap_bps * funding_interval + max_move_bps * FUNDING_PERIOD < (mm_bps -
  liq_penalty_bps) * FUNDING_PERIOD`, so one interval's funding at the cap plus one
  price update cannot take a healthy account past insolvency. With a cap of 0 this is
  the rule above.

`funding_cap_bps` is per `FUNDING_PERIOD`, so `funding_cap_bps <= im_bps - mm_bps`
means that at the cap funding needs at least one full period to move a position from
initial to maintenance margin.

On top of these, the program refuses a market whose `funding_cap_bps` is above 100
(per period), whose `max_age` or `max_age_liquidation` is above one day, or whose
funding interval is above seven days, so no clock setting can be set to never or
forever.

## 12a. The fee seat and the insurance seat

They are seats no key can sign for. They cannot place orders, be liquidators or
withdraw through the ordinary instructions. Fees leave only through an admin
instruction that moves an amount from the fee seat to the insurance seat or pays it
out of custody. The payout names every perp market, and while any of them has a
recorded uncovered shortfall it refuses collateral: the fee seat's collateral can then
only move to the insurance seat, toward the deficit. Spot fees stay collectable. The insurance seat pays only through liquidation and `cover_shortfall`, and is funded only by its share of fees and penalties and by the admin's `fund_insurance`. Ordinary deposits into either seat are refused.

## 12b. Known gaps before real money

Not built, on purpose, and stated so nobody assumes otherwise:

- A last step for bad debt that insurance cannot cover (established venues either
  spread it over all positions through the funding index or close opposite positions
  at the bankruptcy price). Here the amount is recorded, the market goes reduce-only
  and withdrawals stop until it is covered.
- A backstop for bankrupt positions. Their liquidator gets the position at the mark
  and no bonus (section 8), so nothing but a free fill at the mark pays anyone to take
  one, and the deficit grows while the mark keeps moving. Established venues hand such
  positions to the insurance fund or a liquidity pool of their own. Until one exists,
  the stand-in is a liquidator the operator runs itself (`SECURITY.md`, "Running a
  small mainnet market").
- A limit on how fast profit from a moving mark can be withdrawn.
- Margin that grows with position size.
- Funding has residual limits (section 7):
  - it is weak in thin markets, where the crossing band does the anchoring;
  - it can be pushed toward zero by inflating open interest with a hedged pair, bounded
    by `open_interest_cap`, and that never flips its sign;
  - it has no external index premium yet;
  - a nudge into liquidation is still possible, at about twice the cost of its effect.
- A price feed with a confidence value and a signature the program verifies.

## 13. Invariants the test suite asserts after every instruction

1. Custody equals `spot + perp` of section 11, per token. The suite moves tokens only
   through instructions, so nothing arrives from outside.
2. A failed instruction changes no balance, lock, order or counter.
3. Only a seat's owner can withdraw from it or close it, and only one of the four
   order keys the owner set on its view can trade, cancel, liquidate, sync or move
   funds between its balances with it. The program recovers the owner from the view
   the signing key belongs to, and the engine refuses any seat that owner does not
   own.
4. Every fill respects price and time priority, tick, lot, limit price and the step limit.
5. Spot: no fill, cancel or fee creates or destroys tokens; every lock is released once.
6. Perps: total long equals total short on every market.
7. Perps: the sum over seats of collateral plus every position's `quote` less its
   unsettled funding, `base * (F - funding_checkpoint)`, changes only by deposits,
   withdrawals and transfers between balances, and by nothing else (fees, penalties
   and funding move between seats).
8. Funding is applied once per interval and once per seat checkpoint.
8a. Funding's two cost bounds (section 7) hold for every interval: the clamped step
   times open interest is at most a quarter of the interval's taker fees, and added
   fills change it by at most `(1 + r) / 4` of their own fees. The carry is exact:
   `F * 65536 + carry` equals the sum of the clamped steps since the market began.
9. Liquidation happens only below maintenance margin with a fresh price, by a
   liquidator whose own positions are all on feeds fresh enough to liquidate, moves the
   right side and size, and follows the shortfall order above. Its price is at most
   the full penalty from the mark, and is the mark whenever insurance pays or a
   shortfall is recorded.
9a. No fill makes a seat's equity negative, and no fill that grows a position leaves
   its side below the margin section 6 requires.
9b. Solvency: what seats with no position owe (negative collateral) never exceeds
   the recorded shortfall. A seat with an open position can be under water only
   because the mark moved, and liquidation is the remedy.
9c. The fee seat and the insurance seat never have negative collateral, a position,
   an open order or a lock (section 12a).
10. A caller who is not a member cannot read the ledger, a book, or another trader's view.

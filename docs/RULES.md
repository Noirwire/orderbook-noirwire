# NoirWire order book: trading rules

The exact rules the program enforces. Every rule here has a test. Where this file and
the code disagree, one of them is a bug.

All quantities are integers. Intermediate products use 128-bit integers. Every
operation is checked; an overflow fails the instruction and changes nothing.

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

Fees and penalties round up against the payer. Nothing else rounds: every other
formula below is exact in integers.

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
the book by sending, or only simulating, orders and reading the public error. The
book-dependent outcomes are: a post-only order that would match, and an order that
would rest on a full side (checks marked _outcome_ below).

An order is refused, changing nothing, if any check fails:

0. The order's expiry time has not passed. Every order carries one, at most 60 seconds
   after it was signed. The rollup can execute a transaction long after it was sent;
   an order must not fill at a price its sender chose for an earlier moment.
1. Exchange and market are not paused. A market in reduce-only status accepts only
   orders that shrink a position, and cancels.
2. Size is at least the market's minimum; price is on the tick; notional at the order
   price is at least the market's minimum notional.
3. Price is within the market's bands around the mark price. Two bands apply to every
   type. The crossing band (`band_bps`): a bid may be at most that far above the mark,
   an ask at most that far below it. It is smaller than the gap between initial and
   maintenance margin, so a fill at the edge cannot consume a trader's margin. The
   outer band (50%): no order may be further from the mark than that in either
   direction, which stops far-away orders from occupying the book.
4. The price feed is fresh, unless the order only shrinks a perp position.
5. The trader has fewer than the per-trader open order limit on this market, if any
   part of the order could rest.
6. Spot: the trader's available balance covers the lock (section 5).
   Perps: the margin check passes (section 6).
7. _Outcome._ A post-only order that would match at all is refused whole.
8. _Outcome._ If a remainder would rest and that side of the book is full, the
   remainder is cancelled. Fills made before that point stand. Nothing is evicted.

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

- Bid: lock `price * size` plus the taker fee on that amount. Ask: lock `size` lots.
- Fill, buyer side: `locked` quote falls by the amount reserved for the filled size;
  the buyer pays `fill_price * fill_size`; the difference returns to `available`; base
  `available` rises by the filled lots.
- Fill, seller side: `locked` base falls by the filled lots; quote `available` rises by
  `fill_price * fill_size`.
- The taker pays `taker_fee_bps` of the fill's notional in quote, rounded up. Of each
  fee, `fee_insurance_share_bps` goes to the insurance seat and the rest to the fee
  seat, so insurance grows with trading and does not wait for an admin. Makers pay
  nothing. The same split applies to perp fees.
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
  refused for everyone. Otherwise the first to withdraw would be paid in full and the
  last would carry the whole loss.

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

Each perp market has a cumulative index `F` (signed quote atoms per lot) and a last
update time.

- On the hosted test network the built-in scheduler stops calling an instruction after
  one failed run, and `update_funding` fails while the price is stale. So funding is
  advanced by the price service, which calls it once per interval; the scheduler is not
  relied on.
- `update_funding` may be called by anyone. It does nothing unless `funding_interval`
  has passed. It applies exactly one interval and sets the last update time to now.
  Missed intervals are not caught up.
- Premium = `(traded - mark) / mark` in bps, where `traded` is the size-weighted
  average price of the fills on this market since the last update, or the mark itself
  when there were none. Resting quotes that never trade do not move funding; moving it
  costs taker fees. Rate = premium clamped to `+-funding_cap_bps`.
  `F += mark * rate / 10000`, rounded toward zero.
- Whenever a seat's position on a market is touched (fill, liquidation, withdrawal,
  margin check), it first pays `base * (F - funding_checkpoint)` out of `quote` and
  sets its checkpoint to `F`. Longs pay when `F` rose.
- Because total long equals total short, funding sums to zero exactly.

## 8. Liquidation

A trader is liquidatable when their equity is below maintenance margin and the price
feed of the market being liquidated is fresh. Positions on other markets are valued at
their last published price, fresh or not, so one stale feed cannot shield a trader
from liquidation elsewhere.

Nobody can read the ledger, so a liquidator cannot see who is unhealthy. `liquidate`
names a seat by number and is tried blind. Whether the target existed, had a position
or was healthy must not be visible to the public: those cases succeed, change nothing,
and the result is written where only the liquidator can read it. That includes the
liquidator lacking the margin to take the position, which only happens when the target
was liquidatable. An error can come only from who the caller is, a pause, or invalid
arguments.

1. `liquidate` first cancels every open order of the target on that market.
2. If equity is now at least maintenance margin, it stops.
3. Otherwise the liquidator takes over part of the position at the liquidation price:
   mark less `liq_penalty_bps` when the target is long, mark plus `liq_penalty_bps`
   when the target is short. The size is the smallest of: the requested size, the
   position, and the size that brings the target back to maintenance margin plus a
   buffer (`liq_buffer_bps`). If what would remain is below the market's minimum
   size, the whole position is taken. The liquidator states a worst acceptable price;
   if the liquidation price is worse for the liquidator, nothing happens, and it is recorded like any other "nothing to liquidate" case.
3a. The penalty is split: `liq_insurance_share_bps` of it goes to the insurance seat,
   the rest to the liquidator.
4. The liquidator must meet initial margin afterwards.
5. If the target ends with no position and negative equity, the shortfall is paid from
   the insurance seat. If insurance cannot cover it, the market goes to reduce-only
   status and the uncovered amount is recorded on the market.
6. `cover_shortfall` may be called by anyone for a seat that has no position on any
   market and negative collateral: the insurance seat pays what it can, and the
   market's recorded amount falls by the same. When a market's recorded amount is
   zero the admin may return it to normal status, which is possible only through `resume_market`. A change in a market's recorded amount is public.
7. `reconcile_shortfall` may be called by anyone: if debtors have repaid by deposit,
   the recorded amounts are lowered to what flat seats still owe. It never raises one.

## 9. Price feed

- `publish_price` is signed by the oracle authority. Publish time must be later than
  the previous one by at least `min_publish_gap` seconds and must not be in the future.
- A price that differs from the previous one by more than `max_move_bps` is rejected.
  Together with the gap this bounds how fast the mark can move.
- The admin can reset a feed with a separate instruction. A reset puts the market in
  reduce-only status until the admin returns it to normal. A paused market stays
  paused.
- A feed older than the market's `max_age` is stale. Staleness blocks orders that
  increase exposure and withdrawals by a trader who has a perp position. It never
  blocks cancels or orders that only shrink a position.
- Liquidation uses a longer limit, `max_age_liquidation`: the moment a feed falters is
  the moment liquidations matter most.
- One key writing the mark is a test-network arrangement. Real money needs a feed whose
  signature the program verifies.

## 10. Fill receipts

A fill on the public tape carries a maker receipt and a taker receipt, each 8 bytes:
the first 8 bytes of `sha256(order secret || fill sequence || role byte)`. A client
recomputes them for its own open orders to recognise its fills. Two fills of the same
order carry unrelated receipts, so the tape does not link them.

The tape still shows each fill's price, size and time. Unusual sizes and timing can be
correlated by an observer. The claim this design supports is: resting orders, depth,
balances and positions are private. It does not claim that trades are invisible.

## 11. Custody

Deposits and withdrawals move tokens and change seat balances in the same instruction,
so a credit without a transfer is impossible. For every token, at all times:

`custody balance = sum of all seats' available + locked, including the fee and insurance seats`

Whether a token's custody balance is sealed or public is fixed when it is registered and
changes nothing in this rule.

## 12. Limits and settings

Per market: `min_size`, `min_notional`, `band_bps`, book capacity per side, open orders
per trader. Global: seat count, `MAX_STEPS`. A full seat table or book rejects; it
never evicts. A seat's balance of any token is capped well below the integer limit, so
a credit can never overflow.

A market's settings are refused unless all of these hold: `0 < mm_bps < im_bps <=
10000`; `liq_penalty_bps + taker_fee_bps < mm_bps`; `0 < band_bps <= im_bps - mm_bps`;
`max_move_bps < mm_bps - liq_penalty_bps`, so one price update cannot take a healthy
account past insolvency; `funding_cap_bps <= im_bps - mm_bps`; `taker_fee_bps <= 100`;
both insurance shares at most 10000; `max_age <= max_age_liquidation`; tick, lot,
minimum size, funding interval, publish gap, open interest cap and both price ages
greater than zero.

## 12a. The fee seat and the insurance seat

They are seats no key can sign for. They cannot place orders, be liquidators or
withdraw through the ordinary instructions. Fees leave only through an admin
instruction that moves an amount from the fee seat to the insurance seat or pays it
out of custody. The insurance seat pays only through liquidation and `cover_shortfall`, and is funded only by its share of fees and penalties and by the admin's `fund_insurance`. Ordinary deposits into either seat are refused.

## 12b. Known gaps before real money

Not built, on purpose, and stated so nobody assumes otherwise:

- A last step for bad debt that insurance cannot cover (established venues either
  spread it over all positions through the funding index or close opposite positions
  at the bankruptcy price). Here the amount is recorded, the market goes reduce-only
  and withdrawals stop until it is covered.
- A limit on how fast profit from a moving mark can be withdrawn.
- Margin that grows with position size, and funding sampled several times per interval.
- A price feed with a confidence value and a signature the program verifies.

## 13. Invariants the test suite asserts after every instruction

1. Custody equals the sum of seat balances, per token.
2. A failed instruction changes no balance, lock, order or counter.
3. Only a seat's owner can trade, cancel, withdraw or close it.
4. Every fill respects price and time priority, tick, lot, limit price and the step limit.
5. Spot: no fill, cancel or fee creates or destroys tokens; every lock is released once.
6. Perps: total long equals total short on every market.
7. Perps: the sum over seats of collateral plus `quote` changes only by deposits,
   withdrawals and nothing else (fees and penalties move between seats).
8. Funding is applied once per interval and once per seat checkpoint.
9. Liquidation happens only below maintenance margin with a fresh price, moves the
   right side and size, and follows the shortfall order above.
9a. No fill makes a seat's equity negative, and no fill that grows a position leaves
   its side below the margin section 6 requires.
9b. Solvency: what seats with no position owe (negative collateral) never exceeds
   the recorded shortfall. A seat with an open position can be under water only
   because the mark moved, and liquidation is the remedy.
10. A caller who is not a member cannot read the ledger, a book, or another trader's view.

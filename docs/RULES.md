# NoirWire order book: trading rules

The exact rules the program enforces. Every rule here has a test. Where this file and
the code disagree, one of them is a bug.

All quantities are integers. Intermediate products use 128-bit integers. Every
operation is checked; an overflow fails the instruction and changes nothing.

## 1. Units

| Name | Meaning |
| --- | --- |
| quote atom | smallest unit of the quote token (nUSD has 6 decimals) |
| base atom | smallest unit of the base token |
| lot | `base_lot` base atoms, set per market |
| size | a whole number of lots, greater than zero |
| price | quote atoms per lot, a multiple of the market's `tick`, greater than zero |
| notional | `price * size`, in quote atoms |
| bps | one hundredth of one percent; ratios are stored in bps |

Fees and penalties round up against the payer. Nothing else rounds: every other
formula below is exact in integers.

## 2. Order types

Every order has a side, a size, a price and a 16-byte secret chosen by the client.
A market order's price is its worst acceptable price.

| Type | Matches | Remainder |
| --- | --- | --- |
| Limit | while the best opposite price is at or better than its price | rests on the book |
| Post only | never; if it would match at all the whole order is refused as an outcome (section 3) | rests on the book |
| Immediate or cancel | as Limit | cancelled |
| Market | as Limit, against its worst price | cancelled |

Flags: `reduce_only` (perps only): the order may only shrink the trader's position; its
size is capped to the position at placement and again at each fill, and it never rests.

## 3. Acceptance checks, in order

A check that depends only on public settings, the mark price and the trader's own state
fails the instruction with an error. A check that depends on the contents of the book
never fails the instruction: the instruction succeeds, changes nothing else, and records
the outcome where only the trader can read it. Otherwise anyone could learn what is in
the book by sending, or only simulating, orders and reading the public error. The
book-dependent outcomes are: a post-only order that would match, and an order that
would rest on a full side (checks marked *outcome* below).

An order is refused, changing nothing, if any check fails:

1. Exchange and market are not paused. A market in reduce-only status accepts only
   orders that shrink a position, and cancels.
2. Size is at least the market's minimum; price is on the tick; notional at the order
   price is at least the market's minimum notional.
3. Price is within the market's band around the mark price (`band_bps`). This applies
   to every type. It stops far-away orders from occupying the book.
4. The price feed is fresh, unless the order only shrinks a perp position.
5. The trader has fewer than the per-trader open order limit on this market, if any
   part of the order could rest.
6. Spot: the trader's available balance covers the lock (section 5).
   Perps: the margin check passes (section 6).
7. *Outcome.* A post-only order that would match at all is refused whole.
8. *Outcome.* If a remainder would rest and that side of the book is full, the
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
- A resting maker order is filled without re-checking the maker's margin; it was
  reserved at placement.
- Each fill gets the market's next fill sequence number and is appended to the tape.

## 5. Spot money

A seat holds, per token, two disjoint amounts: `available` and `locked`.

- Bid: lock `price * size` plus the taker fee on that amount. Ask: lock `size` lots.
- Fill, buyer side: `locked` quote falls by the amount reserved for the filled size;
  the buyer pays `fill_price * fill_size`; the difference returns to `available`; base
  `available` rises by the filled lots.
- Fill, seller side: `locked` base falls by the filled lots; quote `available` rises by
  `fill_price * fill_size`.
- The taker pays `taker_fee_bps` of the fill's notional in quote, rounded up, to the
  fee seat. Makers pay nothing.
- Cancel or end of an order: whatever it still has locked returns to `available`.

## 6. Perpetuals money

One cross-margin account per trader. Per market a seat holds `base` (signed lots),
`quote` (signed quote atoms) and `funding_checkpoint`. A fill of `s` lots at price `p`:
buyer `base += s`, `quote -= p*s`; seller `base -= s`, `quote += p*s`. The taker's fee
is taken from collateral. When `base` returns to zero, `quote` is added to collateral
and reset to zero. There is no division anywhere in this accounting.

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

## 7. Funding

Each perp market has a cumulative index `F` (signed quote atoms per lot) and a last
update time.

- `update_funding` may be called by anyone. It does nothing unless `funding_interval`
  has passed. It applies exactly one interval and sets the last update time to now.
  Missed intervals are not caught up.
- Premium = `(mid - mark) / mark` in bps, where `mid` is the average of the best bid
  and best ask, or zero when either side is empty. Rate = premium clamped to
  `+-funding_cap_bps`. `F += mark * rate / 10000`, rounded toward zero.
- Whenever a seat's position on a market is touched (fill, liquidation, withdrawal,
  margin check), it first pays `base * (F - funding_checkpoint)` out of `quote` and
  sets its checkpoint to `F`. Longs pay when `F` rose.
- Because total long equals total short, funding sums to zero exactly.

## 8. Liquidation

A trader is liquidatable when their equity is below maintenance margin and the price
feed is fresh.

1. `liquidate` first cancels every open order of the target on that market.
2. If equity is now at least maintenance margin, it stops.
3. Otherwise the liquidator takes over up to the requested size of the position at the
   liquidation price: mark less `liq_penalty_bps` when the target is long, mark plus
   `liq_penalty_bps` when the target is short. The size is capped to the position.
4. The liquidator must meet initial margin afterwards.
5. If the target ends with no position and negative equity, the shortfall is paid from
   the insurance seat. If insurance cannot cover it, the market goes to reduce-only
   status and the uncovered amount is recorded on the market for the admin to resolve.

## 9. Price feed

- `publish_price` is signed by the oracle authority. Publish time must not go backwards.
- A price that differs from the previous one by more than `max_move_bps` is rejected.
  The admin can reset a feed with a separate instruction.
- A feed older than the market's `max_age` is stale. Staleness blocks orders that
  increase exposure, liquidations, and withdrawals by a trader who has a perp position.
  It never blocks cancels or orders that only shrink a position.
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

## 12. Limits

Per market: `min_size`, `min_notional`, `band_bps`, book capacity per side, open orders
per trader. Global: seat count, `MAX_STEPS`. A full seat table or book rejects; it
never evicts.

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
10. A caller who is not a member cannot read the ledger, a book, or another trader's view.

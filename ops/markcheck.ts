/**
 * The mark check, on its own: it reads, prints and refuses nothing, and needs
 * no admin key, so it works after the admin role went to a hardware wallet,
 * when a resume is given from the console and setup cannot run.
 *
 * It prints the market's status, the mark beside the median of the public
 * exchanges' prices (and Pyth Pro's, given a token), the mark's age against
 * the market's max price age, the USDC guard's state, the market's price
 * health and every recorded shortfall, what insurance covers at that mark
 * against the open interest cap, who the upgrade authority is, and the
 * liquidation keeper's seat, funding and liveness (it watches the keeper's
 * view for a write, as long as a running keeper can go between two: give it
 * the keeper's `KEEPER_EVERY`). A resume is not safe while the mark is older
 * than the market's max price age, the guard is not passing, the market is not
 * healthy, a shortfall is recorded, or the keeper's collateral is under what
 * one takeover of a seat at the position cap needs as margin. Then it says
 * plainly whether a resume is safe by what it read. It decides nothing and
 * sends nothing: `ops/markchecking.ts` holds the work, and a test runs it
 * against connections that throw on every signing or sending call.
 *
 * `INSURANCE_HELD` (whole USDC, read from the console) can only lower the
 * insurance the cover is sized from. Where the rollup does not serve the
 * custody token account (the hosted one does not) it is also required: with
 * no figure the verdict is that a resume is not safe, and says why. The keeper's key must be on this machine
 * (`<network>-keeper.json`) to read its seat; without it the answer is that
 * the keeper cannot be confirmed, which is a no.
 *
 * The Makefile is the way in (`make rehearsal-markcheck`,
 * `make mainnet-markcheck`).
 */
import { run } from "./deployment";
import { markchecked } from "./markchecking";

run(markchecked);

//! Audit, matching: book capacity. RULES 3.3 says the outer band "stops far-away
//! orders from occupying the book". This test fills one side of a perp book with
//! orders at the outer band edge, using only public instructions and the limits of
//! `ops/deployment.ts`, and shows an honest bid near the mark can no longer rest.

mod common;

use common::*;
use noirwire_orderbook_engine::*;

const SOL: u64 = DEPLOYED_MARK;
const CAPACITY: usize = 1_024;
const PER_SEAT: usize = 32;
/// Exactly 50% below the mark: the outer band allows the edge itself.
const FAR_BID: u64 = 75_000;
/// The smallest size whose notional at `FAR_BID` meets `min_notional`.
const FAR_LOTS: u64 = 14;
/// Initial margin for 32 such bids, counted at the mark, plus the fee reserve.
const SQUATTER_COLLATERAL: u64 = 32 * 14 * SOL / 10 + 525;

#[test]
fn audit_matching_a_full_side_of_far_bids_shuts_out_every_honest_bid_for_good() {
    let mut w = World::new(2 + CAPACITY / PER_SEAT + 2, CAPACITY);
    w.max_steps = 32;
    let m = w.add_market(deployed_perp(0));
    w.set_price(m, SOL);

    let mut spent = 0u64;
    for _ in 0..CAPACITY / PER_SEAT {
        let squatter = w.open();
        w.deposit(squatter, Asset::Collateral, SQUATTER_COLLATERAL)
            .unwrap();
        spent += SQUATTER_COLLATERAL;
        for _ in 0..PER_SEAT {
            let outcome = w
                .place(m, squatter, limit(Side::Bid, FAR_BID, FAR_LOTS))
                .unwrap();
            assert_eq!(outcome.status, PlaceStatus::Rested);
        }
    }
    assert_eq!(w.markets[m].resting(Side::Bid).len(), CAPACITY);

    let seller = w.open();
    w.deposit(seller, Asset::Collateral, 1_000_000_000).unwrap();
    let lowest_ask_the_band_allows = SOL - SOL * 400 / 10_000;
    let sweep = w
        .place(m, seller, ioc(Side::Ask, lowest_ask_the_band_allows, 10))
        .unwrap();
    assert_eq!(sweep.filled, 0, "no taker can reach the far bids");

    w.now += 86_400;
    w.set_price(m, SOL);
    assert_eq!(w.markets[m].resting(Side::Bid).len(), CAPACITY);

    let maker = w.open();
    w.deposit(maker, Asset::Collateral, 1_000_000_000).unwrap();
    let near_the_mark = SOL - 1_500;
    let honest = w
        .place(m, maker, limit(Side::Bid, near_the_mark, 10))
        .unwrap();

    assert_eq!(
        honest.status,
        PlaceStatus::Rested,
        "RULES 3.3: the outer band is meant to stop far-away orders from occupying the \
         book, yet {} seats holding {} quote atoms of collateral in total ({} nUSD) filled \
         all {} bid slots at half the mark; a day later a bid 1% under the mark is still \
         refused as {:?}, no taker can reach the squatters, and nothing lets the admin evict them",
        CAPACITY / PER_SEAT,
        spent,
        spent / 1_000_000,
        CAPACITY,
        honest.status,
    );
}

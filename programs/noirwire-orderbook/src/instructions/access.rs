use anchor_lang::prelude::*;
use core::cell::RefMut;
use noirwire_orderbook_engine::{
    set_market_access as engine_set_market_access, set_seat_access as engine_set_seat_access,
    take_seat, PerpBook, SeatAccess,
};

use crate::errors::{engine, OrderbookError};
use crate::instructions::setup::UpdateMarket;
use crate::loader::{load_ledger_mut, load_market_mut, load_mut, Scope};
use crate::state::{
    BookData, Exchange, MarketData, ViewData, EXCHANGE_SEED, LEDGER_SEED, VIEW_SEED,
};
use crate::view::{is_seated, record_seat, trader};

/// RULES 3a: switches a perp market's maker list and taker list on or off, at
/// any status and any source health, effective from this transaction. The
/// switches are public. A spot market's stay off.
pub fn set_market_access(
    ctx: Context<UpdateMarket>,
    market_id: u8,
    makers_listed: bool,
    takers_listed: bool,
) -> Result<()> {
    let mut market = load_mut::<MarketData>(&ctx.accounts.market, Scope::Market(market_id))?;
    engine_set_market_access(&mut market.params, makers_listed, takers_listed).map_err(engine)
}

/// The accounts of `move_fees_to_insurance`, with the same flags, and the owner's view.
/// The remaining accounts are the book of every perp market the exchange has, by
/// rising id, whichever seat and market the call is about, so the accounts
/// it names never tell one seat or one market from another.
#[derive(Accounts)]
#[instruction(owner: Pubkey)]
pub struct SetSeatAccess<'info> {
    pub admin: Signer<'info>,
    #[account(
        seeds = [EXCHANGE_SEED],
        bump = exchange.bump,
        has_one = admin @ OrderbookError::NotAdmin
    )]
    pub exchange: Account<'info, Exchange>,
    /// CHECK: Checked by the loader against its seeds, tag, size and readiness.
    #[account(mut, seeds = [LEDGER_SEED], bump)]
    pub ledger: UncheckedAccount<'info>,
    /// CHECK: The owner's view, checked by the loader against its seeds, tag, size and
    /// readiness. It records the seat this call finds or takes.
    #[account(mut, seeds = [VIEW_SEED, owner.as_ref()], bump)]
    pub view: UncheckedAccount<'info>,
}

/// The remaining accounts as the book of every perp market the exchange has,
/// by rising id, each checked like any book. A book left out, repeated, out of
/// order or of a market that is not a perp is refused, and so is one whose own
/// market id is not the one its address and header give, since the engine
/// takes a book's market from inside it.
fn every_perp_book<'a>(
    exchange: &Exchange,
    remaining: &'a [AccountInfo<'_>],
) -> Result<Vec<RefMut<'a, BookData>>> {
    let mut loaded = Vec::with_capacity(remaining.len());
    let mut seen: u8 = 0;
    for account in remaining {
        let (market_id, book) = load_market_mut::<BookData>(account)?;
        require!(
            book.book.header.market_id == market_id,
            OrderbookError::MarketMismatch
        );
        let bit = 1u8
            .checked_shl(u32::from(market_id))
            .ok_or(OrderbookError::MalformedRemainingAccounts)?;
        let rising = seen.checked_shr(u32::from(market_id)) == Some(0);
        require!(
            rising && exchange.perp_markets & bit != 0,
            OrderbookError::MalformedRemainingAccounts
        );
        seen |= bit;
        loaded.push(book);
    }
    require!(
        seen == exchange.perp_markets,
        OrderbookError::MarketDataMissing
    );
    Ok(loaded)
}

/// RULES 3a and 12: sets the maker list, the taker list and the block flag of the
/// open trader seat that `owner` holds, all three at once and absolutely, so
/// an identical call changes nothing. Clearing a maker bit cancels that seat's
/// resting orders on that market in the same instruction. The lists name perp
/// markets only. The seat is the one the owner's view records, found by index; an
/// owner whose view holds none gets one from the free list when anything is set
/// (`SeatTableFull` when none is free), and nothing happens when nothing is.
///
/// Security: `owner` travels in the instruction data alone. The accounts are
/// the admin, the exchange, the ledger, the owner's view and every perp market's
/// book, the same for every call.
pub fn set_seat_access(
    ctx: Context<SetSeatAccess>,
    owner: Pubkey,
    maker_markets: u64,
    taker_markets: u64,
    blocked: bool,
) -> Result<()> {
    let accounts = &ctx.accounts;
    let perp_markets = accounts.exchange.perp_markets;
    require!(
        (maker_markets | taker_markets) & !u64::from(perp_markets) == 0,
        OrderbookError::InvalidSettings
    );
    let mut books = every_perp_book(&accounts.exchange, ctx.remaining_accounts)?;
    let mut perp_books: Vec<PerpBook<'_>> = books
        .iter_mut()
        .map(|data| {
            let book = &mut data.book;
            PerpBook {
                book: &mut book.header,
                bids: &mut book.bids,
                asks: &mut book.asks,
            }
        })
        .collect();
    let mut view = load_mut::<ViewData>(&accounts.view, Scope::Owner(&owner))?;
    require!(view.owner == owner.to_bytes(), OrderbookError::NotViewOwner);
    let mut ledger = load_ledger_mut(&accounts.ledger)?;
    let access = SeatAccess {
        maker_markets,
        taker_markets,
        blocked,
    };
    if !is_seated(&view, &ledger.seats) {
        if maker_markets == 0 && taker_markets == 0 && !blocked {
            return Ok(());
        }
        let mut seats = ledger.engine();
        let index = take_seat(&mut seats, &view.owner).map_err(engine)?;
        let seat = *seats
            .seats
            .get(index as usize)
            .ok_or(OrderbookError::SeatOutOfRange)?;
        record_seat(&mut view, index, &seat);
    }
    let mut seats = ledger.engine();
    engine_set_seat_access(&mut seats, &mut perp_books, trader(&view), access).map_err(engine)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{
        Header, QuoteGuard, RollupAccount, TokenInfo, HEADER_LEN, MAX_MARKETS, READY, TOKENS,
    };

    /// One account as the runtime hands it to the program.
    struct Stored {
        key: Pubkey,
        owner: Pubkey,
        lamports: u64,
        data: Vec<u64>,
        writable: bool,
    }

    impl Stored {
        fn info(&mut self) -> AccountInfo<'_> {
            let Stored {
                key,
                owner,
                lamports,
                data,
                writable,
            } = self;
            AccountInfo::new(
                key,
                false,
                *writable,
                lamports,
                bytemuck::cast_slice_mut(data),
                owner,
                false,
            )
        }
    }

    /// A ready book of market `market_id` at its address.
    fn book(market_id: u8) -> Stored {
        book_holding(market_id, market_id)
    }

    /// A ready book at the address and header of market `market_id` whose own
    /// market id is `holds`.
    fn book_holding(market_id: u8, holds: u8) -> Stored {
        let (key, bump) = Pubkey::find_program_address(&[BookData::SEED, &[market_id]], &crate::ID);
        let mut stored = Stored {
            key,
            owner: crate::ID,
            lamports: 0,
            data: vec![0; BookData::LEN / 8],
            writable: true,
        };
        let header = Header {
            tag: BookData::TAG,
            ready: READY,
            market_id,
            bump,
            _padding: [0; 5],
        };
        let bytes = bytemuck::cast_slice_mut::<u64, u8>(&mut stored.data);
        bytes[..HEADER_LEN].copy_from_slice(bytemuck::bytes_of(&header));
        bytemuck::from_bytes_mut::<BookData>(&mut bytes[HEADER_LEN..])
            .book
            .header
            .market_id = holds;
        stored
    }

    fn exchange(perp_markets: u8) -> Exchange {
        Exchange {
            bump: 0,
            admin: Pubkey::new_unique(),
            pending_admin: None,
            gate: Pubkey::new_unique(),
            oracle: Pubkey::new_unique(),
            paused: false,
            max_steps: 1,
            collateral_token: 0,
            tokens: [TokenInfo::default(); TOKENS],
            perp_markets,
            max_seats_per_day: 1,
            seats_day: 0,
            seats_opened: 0,
            public_custody: 0,
            quote: QuoteGuard::unbound(),
            seat_capacity: 0,
            layout: 0,
            min_seat_deposit: 0,
            relayout_next: 0,
            _reserved: [0; 12],
        }
    }

    fn loaded(perp_markets: u8, mut books: Vec<Stored>) -> Result<usize> {
        let infos: Vec<AccountInfo> = books.iter_mut().map(Stored::info).collect();
        every_perp_book(&exchange(perp_markets), &infos).map(|loaded| loaded.len())
    }

    #[test]
    fn the_books_of_every_perp_market_in_rising_order_are_accepted() {
        assert_eq!(loaded(0, vec![]).unwrap(), 0);
        assert_eq!(loaded(0b0110, vec![book(1), book(2)]).unwrap(), 2);
        let every = (0..MAX_MARKETS as u8).map(book).collect();
        assert_eq!(loaded(0xFF, every).unwrap(), MAX_MARKETS);
    }

    #[test]
    fn a_missing_repeated_reordered_spot_or_mismatched_book_is_refused() {
        let missing = error!(OrderbookError::MarketDataMissing);
        let malformed = error!(OrderbookError::MalformedRemainingAccounts);
        assert_eq!(loaded(0b0110, vec![book(1)]).unwrap_err(), missing);
        assert_eq!(loaded(0b0110, vec![]).unwrap_err(), missing);
        assert_eq!(
            loaded(0b0110, vec![book(2), book(1)]).unwrap_err(),
            malformed
        );
        assert_eq!(
            loaded(0b0110, vec![book(1), book(1), book(2)]).unwrap_err(),
            malformed
        );
        assert_eq!(
            loaded(0b0110, vec![book(0), book(1), book(2)]).unwrap_err(),
            malformed,
            "market 0 is not a perp"
        );
        let mismatch = error!(OrderbookError::MarketMismatch);
        assert_eq!(
            loaded(0b0011, vec![book(0), book_holding(1, 0)]).unwrap_err(),
            mismatch,
            "market 1's account holding market 0's book"
        );
        assert_eq!(
            loaded(0b0010, vec![book_holding(1, 2)]).unwrap_err(),
            mismatch
        );
        let mut read_only = book(1);
        read_only.writable = false;
        assert_eq!(
            loaded(0b0010, vec![read_only]).unwrap_err(),
            error!(ErrorCode::ConstraintMut)
        );
    }
}

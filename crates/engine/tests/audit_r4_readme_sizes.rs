use core::mem::size_of;
use noirwire_orderbook_engine::{Book, Ledger};

const HEADER_LEN: usize = 16;
const GROWTH_STEP: usize = 10_240;
const GROWS_PER_TRANSACTION: usize = 30;

fn rent(len: usize) -> usize {
    (len + 60) * 32
}

fn grows(len: usize) -> usize {
    (len - len.min(GROWTH_STEP)).div_ceil(GROWTH_STEP)
}

#[test]
fn readme_book_and_ledger_figures_against_the_code() {
    let book = HEADER_LEN + size_of::<Book>();
    let ledger = HEADER_LEN + size_of::<Ledger>();
    println!("book {book} rent {} grows {}", rent(book), grows(book));
    println!(
        "ledger {ledger} rent {} grows {} txs {}",
        rent(ledger),
        grows(ledger),
        grows(ledger).div_ceil(GROWS_PER_TRANSACTION)
    );
    assert_eq!(book, 131_160);
    assert_ne!(book, 114_768);
    assert_eq!(rent(book), 4_199_040);
    assert_eq!(grows(book), 12);
    assert_eq!(ledger, 622_640);
    assert_eq!(rent(ledger), 19_926_400);
    assert_eq!(grows(ledger), 60);
    assert_eq!(grows(28_712), 2);
}

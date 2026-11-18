use anchor_lang::prelude::*;
use noirwire_orderbook_engine::{EngineError, TriggerError};

/// Clients match these by name or by number, so a code is never reused or
/// renumbered. Codes 1 to 99 (6001 to 6099 on the wire) are the engine's own,
/// one to one; this program's begin at 100.
#[error_code]
pub enum OrderbookError {
    #[msg("Arithmetic overflow")]
    MathOverflow = 1,
    #[msg("The engine found its state inconsistent")]
    InvariantBroken = 2,
    #[msg("The market settings cannot be run on")]
    InvalidMarketParams = 3,
    #[msg("The book does not belong to this market")]
    MarketMismatch = 4,
    #[msg("The journal cannot hold another seat")]
    JournalFull = 5,
    #[msg("The step limit is above what one order may perform")]
    StepLimitTooLarge = 6,

    #[msg("No seat at that index")]
    SeatOutOfRange = 10,
    #[msg("That seat is not open")]
    SeatNotOpen = 11,
    #[msg("The seat belongs to another key")]
    NotSeatOwner = 12,
    #[msg("Every seat is taken")]
    SeatTableFull = 13,
    #[msg("This key already holds a seat")]
    SeatAlreadyOpen = 14,
    #[msg("The seat still holds a balance, a position or an open order")]
    SeatNotEmpty = 15,
    #[msg("That seat is reserved")]
    ReservedSeat = 16,
    #[msg("That seat is not a reserved seat")]
    NotReservedSeat = 17,

    #[msg("No such token")]
    InvalidToken = 20,
    #[msg("The amount is zero")]
    ZeroAmount = 21,
    #[msg("The available balance does not cover it")]
    InsufficientBalance = 22,
    #[msg("The collateral does not cover it")]
    InsufficientCollateral = 23,
    #[msg("Equity would fall below initial margin")]
    InsufficientMargin = 24,
    #[msg("The balance would exceed the cap")]
    BalanceCapExceeded = 25,

    #[msg("The exchange is paused")]
    ExchangePaused = 30,
    #[msg("The market is paused")]
    MarketPaused = 31,
    #[msg("The market accepts only orders that shrink a position")]
    MarketReduceOnly = 32,
    #[msg("Those order flags cannot be combined")]
    InvalidOrderFlags = 33,
    #[msg("The size is below the market's minimum")]
    SizeTooSmall = 34,
    #[msg("The price is not on the tick")]
    PriceOffTick = 35,
    #[msg("The notional is below the market's minimum")]
    NotionalTooSmall = 36,
    #[msg("The price is outside the band around the mark")]
    PriceOutsideBand = 37,
    #[msg("The price feed is stale")]
    StalePrice = 38,
    #[msg("No price has been published")]
    PriceUnavailable = 39,
    #[msg("The open order limit on this market is reached")]
    TooManyOpenOrders = 40,
    #[msg("A reduce-only order would increase the position")]
    ReduceOnlyWouldIncrease = 43,
    #[msg("Risk data for a market the seat holds a position on is missing")]
    MarketDataMissing = 44,
    #[msg("The fee seat is not open")]
    FeeSeatNotOpen = 45,
    #[msg("The order's own expiry has already passed")]
    OrderExpired = 46,
    #[msg("The insurance seat is not open")]
    InsuranceSeatNotOpen = 47,
    #[msg("The order could take the position past the market's position cap")]
    PositionCapExceeded = 48,

    #[msg("No such order")]
    OrderNotFound = 50,

    #[msg("Not a perpetual market")]
    NotPerpMarket = 60,
    #[msg("The target is not liquidatable")]
    NotLiquidatable = 61,
    #[msg("A seat cannot liquidate itself")]
    SelfLiquidation = 62,
    #[msg("The target holds no position on this market")]
    NoPosition = 63,
    #[msg("A market still has a recorded shortfall")]
    ShortfallOutstanding = 64,

    #[msg("The publish time went backwards")]
    PriceTimeWentBackwards = 70,
    #[msg("The price moved more than the market allows in one update")]
    PriceMoveTooLarge = 71,
    #[msg("The price is zero")]
    ZeroPrice = 72,
    #[msg("The price was published too soon after the previous one")]
    PricePublishedTooSoon = 73,
    #[msg("The publish time is in the future")]
    PriceFromTheFuture = 74,
    #[msg("The price is above the highest the engine accepts")]
    PriceTooHigh = 75,
    #[msg("The feed has never had a price; its first is the admin's reset")]
    FeedNotSeeded = 76,
    #[msg("The market's price source is dislocated from its mark")]
    OracleDislocated = 77,
    #[msg("A price incident is open on a perp market")]
    OracleIncident = 78,
    #[msg("The source's price is older than the market allows")]
    PriceTooOld = 79,
    #[msg("The USDC guard is depegged or stale, so perps take reduce-only orders only")]
    QuoteGuardTripped = 81,

    #[msg("The seat is blocked: it may cancel, reduce, move funds and close, nothing else")]
    SeatBlocked = 90,
    #[msg("This market takes resting orders only from seats listed as its makers")]
    MakerNotListed = 91,
    #[msg("This market takes orders that match only from seats listed as its takers")]
    TakerNotListed = 92,
    #[msg("The seat already holds positions or orders on four other markets")]
    SlotsFull = 93,

    #[msg("Only the program's upgrade authority may set up the exchange")]
    NotUpgradeAuthority = 100,
    #[msg("Only the exchange's admin may do this")]
    NotAdmin = 101,
    #[msg("Only the key the admin nominated may accept the role")]
    NotNominee = 102,
    #[msg("The gate key did not sign")]
    GateMissing = 103,
    #[msg("Only the oracle authority may publish a price")]
    NotOracle = 104,
    #[msg("The settings are outside the fixed bounds")]
    InvalidSettings = 105,
    #[msg("The exchange must keep its own rent")]
    BelowRent = 106,
    #[msg("No token is registered at that index")]
    UnknownToken = 107,
    #[msg("The token account is not the one the exchange keeps in custody")]
    WrongCustody = 108,
    #[msg("The token account is not of the expected mint")]
    WrongMint = 109,
    #[msg("The token account is not owned by the expected key")]
    WrongTokenAccountOwner = 110,
    #[msg("The token program is not the SPL Token program")]
    WrongTokenProgram = 111,
    #[msg("The token account is not initialised")]
    TokenAccountUninitialised = 112,
    #[msg("The account already exists")]
    AccountExists = 113,
    #[msg("The account does not exist")]
    AccountMissing = 114,
    #[msg("The account is not owned by this program")]
    WrongOwner = 115,
    #[msg("The account was not derived from the expected seeds")]
    WrongDerivation = 116,
    #[msg("The account is not the kind this instruction expects")]
    WrongKind = 117,
    #[msg("The account does not have its full size")]
    WrongSize = 118,
    #[msg("The account is not ready for use")]
    NotReady = 119,
    #[msg("The account is already finalised")]
    AlreadyReady = 120,
    #[msg("The account belongs to another market")]
    WrongMarket = 121,
    #[msg("The growth step is zero, too large, or past the full size")]
    InvalidGrowth = 122,
    #[msg("The signer is not one of the view's order keys")]
    NotOrderKey = 123,
    #[msg("The replacement order key is unusable")]
    InvalidOrderKey = 124,
    #[msg("The view belongs to another owner")]
    NotViewOwner = 125,
    #[msg("A market with that id already exists")]
    MarketExists = 126,
    #[msg("The market's book capacity is zero or above the book's size")]
    InvalidCapacity = 127,
    #[msg("Remaining accounts must come in groups of market, book and price feed")]
    MalformedRemainingAccounts = 128,
    #[msg("The same market was supplied twice")]
    DuplicateMarket = 129,
    #[msg("The tape or stats account cannot hold the fill")]
    CounterOverflow = 130,
    #[msg("The account data is not aligned for zero-copy access")]
    Unaligned = 131,
    #[msg("The scheduler task settings are unusable")]
    InvalidSchedule = 132,
    #[msg("The instruction's expiry time has passed")]
    Expired = 133,
    #[msg("The instruction's expiry time is more than 60 seconds ahead")]
    ExpiryTooFar = 134,
    #[msg("A market returns to active only through resume_market")]
    ResumeOnly = 135,
    #[msg("The custody account has no private permission that nobody can read through")]
    CustodyNotPrivate = 136,
    #[msg("The exchange has opened its daily limit of new seats")]
    DailySeatLimitReached = 137,
    #[msg("The seat has been used since it was opened")]
    SeatUsed = 138,
    #[msg("The custody balance has a permission, so it cannot be registered public")]
    CustodyNotPublic = 139,
    #[msg("A payout cannot go into a custody account")]
    PayoutIntoCustody = 140,
    #[msg("The price account is not the one the source is bound to")]
    WrongPriceAccount = 141,
    #[msg("The price account is not owned by the price oracle program")]
    WrongPriceAccountOwner = 142,
    #[msg("The price account does not have a price update's size")]
    WrongPriceAccountSize = 143,
    #[msg("The price account is not a price update")]
    WrongPriceAccountKind = 144,
    #[msg("The price update is not fully verified")]
    PriceNotFullyVerified = 145,
    #[msg("The price update is for another feed")]
    WrongPriceFeed = 146,
    #[msg("The price update's exponent is not the bound one")]
    WrongPriceExponent = 147,
    #[msg("A market bound to a price source takes no published price")]
    PriceSourceBound = 148,
    #[msg("The price source changes only while the market is paused")]
    PriceSourceInUse = 149,
    #[msg("The token's total in the exchange would exceed the maximum the exchange can hold")]
    CustodyCapReached = 150,
    #[msg("The owner proof does not match this action")]
    InvalidOwnerProof = 151,
    #[msg("The owner action counter does not match")]
    WrongOwnerNonce = 152,
    #[msg("The owner action expires more than 120 seconds ahead")]
    OwnerExpiryTooFar = 153,
    #[msg("The withdrawal destination is not the owner's associated token account")]
    WrongWithdrawDestination = 154,
    #[msg("This view holds no seat: a deposit takes one")]
    NotSeated = 155,
    #[msg("A deposit that takes a seat must be collateral of at least the exchange's minimum")]
    SeatDepositTooSmall = 156,
    #[msg("The ledger would grow past the most seats an account can hold")]
    LedgerTooLarge = 159,
    #[msg("The trigger book is malformed or disagrees with itself")]
    TriggerBookInvalid = 163,
    #[msg("The seat's index is past the capacity of the market's trigger book")]
    TriggerBookTooSmall = 164,
    #[msg("The seat's slot for this market has ended too many positions to take a trigger")]
    TriggerSlotRetired = 165,
    #[msg("The trigger's size is below the market's minimum order")]
    TriggerSizeBelowMinimum = 166,
    #[msg("The trigger or worst price is zero, off the tick or too high")]
    TriggerPriceInvalid = 167,
    #[msg("The trigger would fire at once at the current mark")]
    TriggerWouldFireImmediately = 168,
    #[msg("The worst price is on the wrong side of the trigger price")]
    TriggerWorstPriceInvalid = 169,
    #[msg("The trigger's size is zero or larger than the position")]
    TriggerSizeInvalid = 170,
    #[msg("The trigger's expiry is in the past")]
    TriggerExpiryInvalid = 171,
    #[msg("The take-profit and the stop-loss would sit on the wrong sides of each other")]
    TriggerPairCrossed = 172,
    #[msg("The trigger kind is not a take-profit or a stop-loss")]
    TriggerKindInvalid = 173,
}

/// Maps each engine error onto the program error of the same name, and fails
/// the build unless the two carry the same code.
macro_rules! engine_errors {
    ($($name:ident),+ $(,)?) => {
        impl From<EngineError> for OrderbookError {
            fn from(error: EngineError) -> Self {
                match error {
                    $(EngineError::$name => OrderbookError::$name,)+
                }
            }
        }

        $(const _: () = assert!(OrderbookError::$name as u32 == EngineError::$name as u32);)+
    };
}

engine_errors!(
    MathOverflow,
    InvariantBroken,
    InvalidMarketParams,
    MarketMismatch,
    JournalFull,
    StepLimitTooLarge,
    SeatOutOfRange,
    SeatNotOpen,
    NotSeatOwner,
    SeatTableFull,
    SeatAlreadyOpen,
    SeatNotEmpty,
    ReservedSeat,
    NotReservedSeat,
    InvalidToken,
    ZeroAmount,
    InsufficientBalance,
    InsufficientCollateral,
    InsufficientMargin,
    BalanceCapExceeded,
    ExchangePaused,
    MarketPaused,
    MarketReduceOnly,
    InvalidOrderFlags,
    SizeTooSmall,
    PriceOffTick,
    NotionalTooSmall,
    PriceOutsideBand,
    StalePrice,
    PriceUnavailable,
    TooManyOpenOrders,
    ReduceOnlyWouldIncrease,
    MarketDataMissing,
    FeeSeatNotOpen,
    OrderExpired,
    InsuranceSeatNotOpen,
    PositionCapExceeded,
    OrderNotFound,
    NotPerpMarket,
    NotLiquidatable,
    SelfLiquidation,
    NoPosition,
    ShortfallOutstanding,
    PriceTimeWentBackwards,
    PriceMoveTooLarge,
    ZeroPrice,
    PricePublishedTooSoon,
    PriceFromTheFuture,
    PriceTooHigh,
    FeedNotSeeded,
    OracleDislocated,
    OracleIncident,
    PriceTooOld,
    QuoteGuardTripped,
    SeatBlocked,
    MakerNotListed,
    TakerNotListed,
    SlotsFull,
);

/// Lifts an engine refusal into this program's error space without losing the code.
pub fn engine(error: EngineError) -> Error {
    OrderbookError::from(error).into()
}

/// The program error of each trigger refusal. Exhaustive, so a new engine variant
/// stops the build until it has a code.
pub fn trigger_code(error: TriggerError) -> OrderbookError {
    match error {
        TriggerError::BadLayout
        | TriggerError::Corrupt
        | TriggerError::SlotNotEmpty
        | TriggerError::RecordsRemain => OrderbookError::TriggerBookInvalid,
        TriggerError::SeatOutOfRange => OrderbookError::TriggerBookTooSmall,
        TriggerError::SeatNotOpen => OrderbookError::SeatNotOpen,
        TriggerError::NotSeatOwner => OrderbookError::NotSeatOwner,
        TriggerError::NotPerpMarket => OrderbookError::NotPerpMarket,
        TriggerError::MarketMismatch => OrderbookError::MarketMismatch,
        TriggerError::NoPosition => OrderbookError::NoPosition,
        TriggerError::SlotRetired => OrderbookError::TriggerSlotRetired,
        TriggerError::SizeBelowMinimum => OrderbookError::TriggerSizeBelowMinimum,
        TriggerError::FillExceedsSize | TriggerError::InvalidSize => {
            OrderbookError::TriggerSizeInvalid
        }
        TriggerError::MarkNotFresh => OrderbookError::StalePrice,
        TriggerError::InvalidPrice => OrderbookError::TriggerPriceInvalid,
        TriggerError::WouldFireImmediately => OrderbookError::TriggerWouldFireImmediately,
        TriggerError::InvalidWorstPrice => OrderbookError::TriggerWorstPriceInvalid,
        TriggerError::InvalidExpiry => OrderbookError::TriggerExpiryInvalid,
        TriggerError::CrossedPair => OrderbookError::TriggerPairCrossed,
        TriggerError::Engine(error) => OrderbookError::from(error),
    }
}

/// Lifts a trigger refusal into this program's error space.
pub fn trigger(error: TriggerError) -> Error {
    trigger_code(error).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_trigger_refusal_has_a_program_code_and_the_new_ones_keep_their_numbers() {
        let all = [
            TriggerError::BadLayout,
            TriggerError::Corrupt,
            TriggerError::SeatOutOfRange,
            TriggerError::SeatNotOpen,
            TriggerError::NotSeatOwner,
            TriggerError::NotPerpMarket,
            TriggerError::MarketMismatch,
            TriggerError::NoPosition,
            TriggerError::SlotRetired,
            TriggerError::SizeBelowMinimum,
            TriggerError::FillExceedsSize,
            TriggerError::SlotNotEmpty,
            TriggerError::RecordsRemain,
            TriggerError::MarkNotFresh,
            TriggerError::InvalidPrice,
            TriggerError::WouldFireImmediately,
            TriggerError::InvalidWorstPrice,
            TriggerError::InvalidSize,
            TriggerError::InvalidExpiry,
            TriggerError::CrossedPair,
            TriggerError::Engine(EngineError::MathOverflow),
        ];
        for error in all {
            assert!(trigger_code(error) as u32 >= 1, "{error:?}");
        }
        let numbered = [
            (OrderbookError::TriggerBookInvalid, 163),
            (OrderbookError::TriggerBookTooSmall, 164),
            (OrderbookError::TriggerSlotRetired, 165),
            (OrderbookError::TriggerSizeBelowMinimum, 166),
            (OrderbookError::TriggerPriceInvalid, 167),
            (OrderbookError::TriggerWouldFireImmediately, 168),
            (OrderbookError::TriggerWorstPriceInvalid, 169),
            (OrderbookError::TriggerSizeInvalid, 170),
            (OrderbookError::TriggerExpiryInvalid, 171),
            (OrderbookError::TriggerPairCrossed, 172),
            (OrderbookError::TriggerKindInvalid, 173),
        ];
        for (error, number) in numbered {
            assert_eq!(error as u32, number);
        }
        assert_eq!(
            trigger_code(TriggerError::Engine(EngineError::NoPosition)) as u32,
            OrderbookError::NoPosition as u32
        );
    }
}

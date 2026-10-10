use anchor_lang::prelude::*;
use noirwire_orderbook_engine::EngineError;

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
    #[msg("The market still has a recorded shortfall")]
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
}

impl From<EngineError> for OrderbookError {
    fn from(error: EngineError) -> Self {
        match error {
            EngineError::MathOverflow => OrderbookError::MathOverflow,
            EngineError::InvariantBroken => OrderbookError::InvariantBroken,
            EngineError::InvalidMarketParams => OrderbookError::InvalidMarketParams,
            EngineError::MarketMismatch => OrderbookError::MarketMismatch,
            EngineError::JournalFull => OrderbookError::JournalFull,
            EngineError::StepLimitTooLarge => OrderbookError::StepLimitTooLarge,
            EngineError::SeatOutOfRange => OrderbookError::SeatOutOfRange,
            EngineError::SeatNotOpen => OrderbookError::SeatNotOpen,
            EngineError::NotSeatOwner => OrderbookError::NotSeatOwner,
            EngineError::SeatTableFull => OrderbookError::SeatTableFull,
            EngineError::SeatAlreadyOpen => OrderbookError::SeatAlreadyOpen,
            EngineError::SeatNotEmpty => OrderbookError::SeatNotEmpty,
            EngineError::ReservedSeat => OrderbookError::ReservedSeat,
            EngineError::NotReservedSeat => OrderbookError::NotReservedSeat,
            EngineError::InvalidToken => OrderbookError::InvalidToken,
            EngineError::ZeroAmount => OrderbookError::ZeroAmount,
            EngineError::InsufficientBalance => OrderbookError::InsufficientBalance,
            EngineError::InsufficientCollateral => OrderbookError::InsufficientCollateral,
            EngineError::InsufficientMargin => OrderbookError::InsufficientMargin,
            EngineError::BalanceCapExceeded => OrderbookError::BalanceCapExceeded,
            EngineError::ExchangePaused => OrderbookError::ExchangePaused,
            EngineError::MarketPaused => OrderbookError::MarketPaused,
            EngineError::MarketReduceOnly => OrderbookError::MarketReduceOnly,
            EngineError::InvalidOrderFlags => OrderbookError::InvalidOrderFlags,
            EngineError::SizeTooSmall => OrderbookError::SizeTooSmall,
            EngineError::PriceOffTick => OrderbookError::PriceOffTick,
            EngineError::NotionalTooSmall => OrderbookError::NotionalTooSmall,
            EngineError::PriceOutsideBand => OrderbookError::PriceOutsideBand,
            EngineError::StalePrice => OrderbookError::StalePrice,
            EngineError::PriceUnavailable => OrderbookError::PriceUnavailable,
            EngineError::TooManyOpenOrders => OrderbookError::TooManyOpenOrders,
            EngineError::ReduceOnlyWouldIncrease => OrderbookError::ReduceOnlyWouldIncrease,
            EngineError::MarketDataMissing => OrderbookError::MarketDataMissing,
            EngineError::FeeSeatNotOpen => OrderbookError::FeeSeatNotOpen,
            EngineError::OrderExpired => OrderbookError::OrderExpired,
            EngineError::InsuranceSeatNotOpen => OrderbookError::InsuranceSeatNotOpen,
            EngineError::OrderNotFound => OrderbookError::OrderNotFound,
            EngineError::NotPerpMarket => OrderbookError::NotPerpMarket,
            EngineError::NotLiquidatable => OrderbookError::NotLiquidatable,
            EngineError::SelfLiquidation => OrderbookError::SelfLiquidation,
            EngineError::NoPosition => OrderbookError::NoPosition,
            EngineError::ShortfallOutstanding => OrderbookError::ShortfallOutstanding,
            EngineError::PriceTimeWentBackwards => OrderbookError::PriceTimeWentBackwards,
            EngineError::PriceMoveTooLarge => OrderbookError::PriceMoveTooLarge,
            EngineError::ZeroPrice => OrderbookError::ZeroPrice,
            EngineError::PricePublishedTooSoon => OrderbookError::PricePublishedTooSoon,
            EngineError::PriceFromTheFuture => OrderbookError::PriceFromTheFuture,
        }
    }
}

/// Lifts an engine refusal into this program's error space without losing the code.
pub fn engine(error: EngineError) -> Error {
    OrderbookError::from(error).into()
}

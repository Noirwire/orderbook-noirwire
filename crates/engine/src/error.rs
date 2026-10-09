pub type EngineResult<T> = Result<T, EngineError>;

/// Every way a call can be refused. The numeric codes are stable: the wrapping program
/// maps them one to one onto its own error codes, so a code is never reused or renumbered.
///
/// RULES 3: errors are public, so none of them is caused by the contents of a book.
/// What the book decides is reported in `PlaceStatus`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum EngineError {
    MathOverflow = 1,
    InvariantBroken = 2,
    InvalidMarketParams = 3,
    MarketMismatch = 4,
    JournalFull = 5,
    StepLimitTooLarge = 6,

    SeatOutOfRange = 10,
    SeatNotOpen = 11,
    NotSeatOwner = 12,
    SeatTableFull = 13,
    SeatAlreadyOpen = 14,
    SeatNotEmpty = 15,
    ReservedSeat = 16,
    NotReservedSeat = 17,

    InvalidToken = 20,
    ZeroAmount = 21,
    InsufficientBalance = 22,
    InsufficientCollateral = 23,
    InsufficientMargin = 24,
    BalanceCapExceeded = 25,

    ExchangePaused = 30,
    MarketPaused = 31,
    MarketReduceOnly = 32,
    InvalidOrderFlags = 33,
    SizeTooSmall = 34,
    PriceOffTick = 35,
    NotionalTooSmall = 36,
    PriceOutsideBand = 37,
    StalePrice = 38,
    PriceUnavailable = 39,
    TooManyOpenOrders = 40,
    ReduceOnlyWouldIncrease = 43,
    MarketDataMissing = 44,
    FeeSeatNotOpen = 45,
    OrderExpired = 46,
    InsuranceSeatNotOpen = 47,

    OrderNotFound = 50,

    NotPerpMarket = 60,
    NotLiquidatable = 61,
    SelfLiquidation = 62,
    NoPosition = 63,
    ShortfallOutstanding = 64,

    PriceTimeWentBackwards = 70,
    PriceMoveTooLarge = 71,
    ZeroPrice = 72,
    PricePublishedTooSoon = 73,
    PriceFromTheFuture = 74,
}

impl EngineError {
    pub const fn code(self) -> u32 {
        self as u32
    }
}

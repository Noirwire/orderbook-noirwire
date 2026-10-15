/**
 * Human decimals to and from the program's integers. A size is a whole
 * number of lots; a price is quote atoms per lot, on the market's tick.
 * Everything a tool takes or returns is a decimal string with at most six
 * decimals, the scale the public service speaks.
 */

const SCALE_DECIMALS = 6;
const SCALE = 10n ** BigInt(SCALE_DECIMALS);

/** A value the caller gave that the market cannot take. Raised before anything is sent. */
export class InvalidInput extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInput";
  }
}

/** What `GET /v1/deployment` says about one market, as far as units go. */
export type MarketScale = {
  /** Base atoms per lot, as the deployment prints it. */
  lotSize: string;
  baseDecimals: number;
  /** The tick in quote atoms per lot, as the deployment prints it. */
  tick: string;
};

export type MarketUnits = {
  /** Lots in one whole base unit. */
  lotsPerUnit: bigint;
  /** The size of one lot in millionths of a base unit. */
  sizePerLot: bigint;
  /** The tick in quote atoms per lot. */
  tick: bigint;
};

/** A decimal string such as "12.5" in millionths. Refuses signs, exponents and more than six decimals. */
export function parseDecimal(text: string, what: string): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!match) {
    throw new InvalidInput(
      `${what} "${text}" is not a plain decimal number such as 12.5`,
    );
  }
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  if (fraction.length > SCALE_DECIMALS) {
    throw new InvalidInput(
      `${what} "${text}" has more than ${SCALE_DECIMALS} decimals`,
    );
  }
  return (
    BigInt(match[1]) * SCALE + BigInt(fraction.padEnd(SCALE_DECIMALS, "0"))
  );
}

/** `value` counted in units of 10^-`decimals`, as a decimal string without trailing zeros. */
export function formatDecimal(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value)
    .toString()
    .padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** Quote atoms (nUSD, six decimals) as a decimal string. */
export function quoteToDecimal(atoms: bigint): string {
  return formatDecimal(atoms, SCALE_DECIMALS);
}

export function marketUnitsOf(scale: MarketScale): MarketUnits {
  const lot = BigInt(scale.lotSize);
  const atomsPerUnit = 10n ** BigInt(scale.baseDecimals);
  if (lot <= 0n || atomsPerUnit % lot !== 0n) {
    throw new Error(`a lot of ${lot} base atoms does not divide one base unit`);
  }
  const lotsPerUnit = atomsPerUnit / lot;
  if (SCALE % lotsPerUnit !== 0n) {
    throw new Error(`a lot of ${lot} base atoms is finer than six decimals`);
  }
  return {
    lotsPerUnit,
    sizePerLot: SCALE / lotsPerUnit,
    tick: BigInt(scale.tick),
  };
}

/** A size in base units to whole lots. Refuses zero and a size that is not a whole number of lots. */
export function sizeToLots(units: MarketUnits, size: string): bigint {
  const millionths = parseDecimal(size, "size");
  if (millionths === 0n)
    throw new InvalidInput("size must be greater than zero");
  if (millionths % units.sizePerLot !== 0n) {
    throw new InvalidInput(
      `size ${size} is not a whole number of lots; one lot is ${lotsToSize(units, 1n)}`,
    );
  }
  return millionths / units.sizePerLot;
}

export function lotsToSize(units: MarketUnits, lots: bigint): string {
  return formatDecimal(lots * units.sizePerLot, SCALE_DECIMALS);
}

/** A price per base unit to quote atoms per lot. Refuses a price that is zero or off the tick. */
export function priceToChain(units: MarketUnits, price: string): bigint {
  const millionths = parseDecimal(price, "price");
  if (millionths === 0n)
    throw new InvalidInput("price must be greater than zero");
  if (millionths % units.lotsPerUnit !== 0n) {
    throw new InvalidInput(`price ${price} is finer than the market's tick`);
  }
  const atoms = millionths / units.lotsPerUnit;
  if (atoms % units.tick !== 0n) {
    throw new InvalidInput(
      `price ${price} is not a multiple of the tick ${chainToPrice(units, units.tick)}`,
    );
  }
  return atoms;
}

export function chainToPrice(units: MarketUnits, atomsPerLot: bigint): string {
  return formatDecimal(atomsPerLot * units.lotsPerUnit, SCALE_DECIMALS);
}

/**
 * The average price of a fill: quote atoms paid over the base size, as a
 * price per base unit. Null when nothing filled.
 */
export function averagePrice(
  units: MarketUnits,
  notionalAtoms: bigint,
  filledLots: bigint,
): string | null {
  if (filledLots === 0n) return null;
  const filledMillionths = filledLots * units.sizePerLot;
  return formatDecimal(
    (notionalAtoms * SCALE) / filledMillionths,
    SCALE_DECIMALS,
  );
}

/** How far from the mark a market order's worst acceptable price sits, in basis points. */
export const MARKET_ORDER_SLIPPAGE_BPS = 100n;

/**
 * The worst price a market order accepts when the caller names none: the
 * mark moved against the order by `MARKET_ORDER_SLIPPAGE_BPS`, rounded away
 * from the mark onto the tick.
 */
export function worstPriceFromMark(
  units: MarketUnits,
  side: "buy" | "sell",
  mark: string,
): string {
  const markAtoms = parseDecimal(mark, "mark price") / units.lotsPerUnit;
  const moved =
    side === "buy"
      ? markAtoms * (10_000n + MARKET_ORDER_SLIPPAGE_BPS)
      : markAtoms * (10_000n - MARKET_ORDER_SLIPPAGE_BPS);
  const ticks =
    side === "buy"
      ? (moved + 10_000n * units.tick - 1n) / (10_000n * units.tick)
      : moved / (10_000n * units.tick);
  return chainToPrice(units, ticks * units.tick);
}

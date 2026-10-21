/** `value / 10^decimals` as a decimal string with grouped thousands, trailing zeros dropped. */
export function decimal(
  value: bigint,
  decimals: number,
  maxFraction = decimals,
): string {
  const negative = value < 0n;
  const size = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = (size / scale).toLocaleString("en-US");
  const fraction = (size % scale)
    .toString()
    .padStart(decimals, "0")
    .slice(0, maxFraction)
    .replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export const grouped = (value: bigint | number) =>
  BigInt(value).toLocaleString("en-US");

/**
 * A price in quote atoms per lot as quote units per whole base unit:
 * `atoms * 10^baseDecimals / (baseLot * 10^quoteDecimals)`.
 */
export function perWholeBase(
  atoms: bigint,
  lot: { baseLot: bigint; baseDecimals: number; quoteDecimals: number },
  fraction = 4,
): string {
  const scaled =
    (atoms * 10n ** BigInt(lot.baseDecimals + fraction)) /
    (lot.baseLot * 10n ** BigInt(lot.quoteDecimals));
  return decimal(scaled, fraction);
}

/** A number of seconds as the shortest plain reading: 42 s, 7 min, 3 h, 2 d. */
export function age(seconds: number): string {
  if (seconds < 0) return `${seconds} s`;
  if (seconds < 120) return `${seconds} s`;
  if (seconds < 7_200) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 172_800) return `${Math.floor(seconds / 3_600)} h`;
  return `${Math.floor(seconds / 86_400)} d`;
}

export const bps = (value: number | bigint) => `${value} bps`;

export const percentOfBps = (value: number | bigint) =>
  `${decimal(BigInt(value), 2)}%`;

export const short = (key: string) => `${key.slice(0, 4)}…${key.slice(-4)}`;

export function nameIn(codes: Record<string, number>, code: number): string {
  const found = Object.entries(codes).find(([, each]) => each === code);
  return found
    ? found[0].replace(/([A-Z])/g, " $1").toLowerCase()
    : `unknown (${code})`;
}

export const utc = (unixSeconds: bigint | number) =>
  Number(unixSeconds) === 0
    ? "never"
    : new Date(Number(unixSeconds) * 1000).toISOString().replace(".000Z", "Z");

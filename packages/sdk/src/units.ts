import { AgenticCommerceError, invariant } from "./errors.js";

export const STELLAR_ASSET_DECIMALS = 7;
export const I128_MIN = -(1n << 127n);
export const I128_MAX = (1n << 127n) - 1n;

const DECIMAL_PATTERN = /^([+-]?)(\d+)(?:\.(\d+))?$/;

function validateDecimals(decimals: number): void {
  invariant(
    Number.isSafeInteger(decimals) && decimals >= 0 && decimals <= 38,
    "INVALID_ARGUMENT",
    "decimals must be an integer between 0 and 38",
    { decimals },
  );
}

/** Convert a decimal string to an exact integer without using floating point. */
export function parseUnits(
  value: string,
  decimals = STELLAR_ASSET_DECIMALS,
): bigint {
  validateDecimals(decimals);
  const match = DECIMAL_PATTERN.exec(value);
  invariant(match, "INVALID_AMOUNT", "amount must be a plain decimal string", {
    value,
  });

  const sign = match[1]!;
  const whole = match[2]!;
  const fraction = match[3] ?? "";
  invariant(
    fraction.length <= decimals,
    "INVALID_AMOUNT",
    `amount has more than ${decimals} fractional digits`,
    { value, decimals },
  );

  const scale = 10n ** BigInt(decimals);
  const unsigned =
    BigInt(whole) * scale + BigInt(fraction.padEnd(decimals, "0") || "0");
  const amount = sign === "-" ? -unsigned : unsigned;
  assertI128(amount);
  return amount;
}

/** Format an exact integer amount as a canonical decimal string. */
export function formatUnits(
  amount: bigint,
  decimals = STELLAR_ASSET_DECIMALS,
): string {
  validateDecimals(decimals);
  assertI128(amount);

  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const scale = 10n ** BigInt(decimals);
  const whole = absolute / scale;
  const rawFraction = (absolute % scale).toString().padStart(decimals, "0");
  const fraction = rawFraction.replace(/0+$/, "");
  const rendered = fraction.length === 0 ? `${whole}` : `${whole}.${fraction}`;
  return negative ? `-${rendered}` : rendered;
}

export function assertI128(amount: bigint): bigint {
  if (amount < I128_MIN || amount > I128_MAX) {
    throw new AgenticCommerceError(
      "INVALID_AMOUNT",
      "amount does not fit in a Soroban i128",
      { amount: amount.toString() },
    );
  }
  return amount;
}

export function assertPositiveI128(amount: bigint): bigint {
  assertI128(amount);
  invariant(amount > 0n, "INVALID_AMOUNT", "amount must be positive", {
    amount: amount.toString(),
  });
  return amount;
}

import type { Bps, Cents } from '../types';

export const BPS_SCALE = 10_000;

/** Round half away from zero, so -0.5 -> -1 rather than JS's Math.round(-0.5) === -0
 *  and so rounding never has a directional bias that quietly loses cents. */
export function roundCents(value: number): Cents {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/** Apply a basis-point rate to a cent amount. */
export function applyBps(amount: Cents, bps: Bps): Cents {
  return roundCents((amount * bps) / BPS_SCALE);
}

/** What fraction of `total` is `part`, in basis points. 0 when total is 0. */
export function toBps(part: Cents, total: Cents): Bps {
  if (total === 0) return 0;
  return Math.round((part / total) * BPS_SCALE);
}

export function bpsToPercent(bps: Bps): number {
  return bps / 100;
}

export function percentToBps(percent: number): Bps {
  return Math.round(percent * 100);
}

/**
 * Parse user-typed money into cents. Deliberately permissive: accepts
 * "1,234.56", "$12", "12.5", "(4.00)" for negative, and "-4".
 * Returns null when there is no number to find, so callers can show an error
 * rather than silently treating garbage as zero.
 *
 * The digits are read as strings rather than via `Number(x) * 100`. That
 * multiplication is not safe here: "1.005" is stored as 1.00499999999999989,
 * so the float route rounds it down to $1.00 while a person typing it plainly
 * means $1.01.
 */
export function parseMoney(input: string): Cents | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Accounting convention: parentheses mean negative.
  const parenthesised = /^\((.*)\)$/.exec(trimmed);
  const body = parenthesised ? parenthesised[1]! : trimmed;

  const cleaned = body.replace(/[$\s,]/g, '');
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(cleaned);
  if (!match || !/\d/.test(cleaned)) return null;

  const [, sign, whole = '', fraction = ''] = match;

  const wholeCents = Number(whole || '0') * 100;
  if (!Number.isSafeInteger(wholeCents)) return null;

  const centsDigits = fraction.padEnd(2, '0');
  let fractionCents = Number(centsDigits.slice(0, 2));

  // Round on the third decimal place, away from zero.
  if (Number(centsDigits[2] ?? '0') >= 5) fractionCents += 1;

  const magnitude = wholeCents + fractionCents;
  if (!Number.isSafeInteger(magnitude)) return null;

  const negative = sign === '-' || parenthesised !== null;
  return negative ? -magnitude : magnitude;
}

export function formatCents(
  cents: Cents,
  opts: { currency?: string; locale?: string; showCents?: boolean } = {},
): string {
  const { currency = 'USD', locale = 'en-US', showCents = true } = opts;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: showCents ? 2 : 0,
    maximumFractionDigits: showCents ? 2 : 0,
  }).format(cents / 100);
}

/** Compact form for chart axes and tiles: $1.2k, $340k, $1.4M. */
export function formatCentsCompact(cents: Cents, currency = 'USD', locale = 'en-US'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(cents / 100);
}

/** Turn cents into the plain decimal string an <input> should show. */
export function centsToInputValue(cents: Cents): string {
  return (cents / 100).toFixed(2);
}

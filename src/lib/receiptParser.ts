import type { Cents, ParsedReceipt } from '../types';

/**
 * Turning OCR output into a transaction.
 *
 * Receipt OCR is noisy in specific, predictable ways: `O` becomes `0`, `S`
 * becomes `5`, `l` becomes `1`, and column alignment turns into arbitrary
 * whitespace. So the keyword matching below is deliberately fuzzy, and the
 * total is chosen by scoring candidates rather than by trusting the first
 * match. Every field is optional — the UI always shows the parse as a
 * pre-filled suggestion the user can correct, never as a silent commit.
 */

/** Amounts like `12.34`, `1,234.56`, `$8.00`, `8.00-`. Cents are required:
 *  a bare integer on a receipt is far more often a quantity or a phone number. */
const AMOUNT_RE = /(-?)\$?\s?(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})(-?)/g;

/** Fold the digit-for-letter substitutions OCR makes, so keyword tests survive
 *  `T0TAL`, `5UBT0TAL` and friends. */
function normalizeForKeywords(line: string): string {
  return line
    .toLowerCase()
    .replace(/0/g, 'o')
    .replace(/1/g, 'l')
    .replace(/5/g, 's')
    .replace(/8/g, 'b')
    .replace(/\$/g, 's')
    .replace(/[^a-z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsKeyword(line: string, keywords: string[]): boolean {
  const normalized = normalizeForKeywords(line);
  return keywords.some((k) => normalized.includes(k));
}

interface FoundAmount {
  cents: Cents;
  /** Character offset, used to prefer the rightmost amount on a line. */
  index: number;
}

export function findAmounts(line: string): FoundAmount[] {
  const out: FoundAmount[] = [];
  for (const m of line.matchAll(AMOUNT_RE)) {
    const [, leadingSign, whole, fraction, trailingSign] = m;
    const cents = Number(whole!.replace(/,/g, '')) * 100 + Number(fraction!);
    if (!Number.isFinite(cents)) continue;
    const negative = leadingSign === '-' || trailingSign === '-';
    out.push({ cents: negative ? -cents : cents, index: m.index });
  }
  return out;
}

/** The last amount on a line — on a receipt, the price column is on the right. */
function lastAmount(line: string): Cents | undefined {
  const amounts = findAmounts(line);
  return amounts.length > 0 ? amounts[amounts.length - 1]!.cents : undefined;
}

// Ordered strongest-first. A line saying "total" is good; "grand total" or
// "amount due" is better and should win when both appear.
const TOTAL_KEYWORDS: { keywords: string[]; score: number }[] = [
  { keywords: ['grand total', 'amount due', 'balance due', 'total due', 'you pay'], score: 100 },
  { keywords: ['total'], score: 60 },
  { keywords: ['card', 'visa', 'mastercard', 'debit', 'credit', 'amex'], score: 30 },
];

/** Lines that look like a total but aren't the one we want. */
const TOTAL_DISQUALIFIERS = [
  'subtotal',
  'sub total',
  'total tax',
  'tax total',
  'total savings',
  'total saved',
  'total discount',
  'total items',
  'total item',
  'total qty',
  'total quantity',
  'change',
  'cash back',
  'cashback',
  'tender',
  'previous',
  'points',
];

export function extractTotal(lines: string[]): Cents | undefined {
  let best: { cents: Cents; score: number } | undefined;

  lines.forEach((line, i) => {
    if (containsKeyword(line, TOTAL_DISQUALIFIERS)) return;

    const match = TOTAL_KEYWORDS.find((k) => containsKeyword(line, k.keywords));
    if (!match) return;

    // The amount is usually on the keyword's line, but a two-column layout can
    // wrap it onto the next one.
    const cents = lastAmount(line) ?? (i + 1 < lines.length ? lastAmount(lines[i + 1]!) : undefined);
    if (cents === undefined || cents <= 0) return;

    // Later totals beat earlier ones at equal strength: receipts print the
    // final amount at the bottom.
    const score = match.score + i / 1000;
    if (!best || score > best.score) best = { cents, score };
  });

  if (best) return best.cents;

  // No keyword anywhere — fall back to the largest amount on the receipt, which
  // is the total far more often than not.
  const all = lines.flatMap((l) => findAmounts(l)).map((a) => a.cents).filter((c) => c > 0);
  return all.length > 0 ? Math.max(...all) : undefined;
}

export function extractLabeledAmount(lines: string[], keywords: string[]): Cents | undefined {
  for (const line of lines) {
    if (!containsKeyword(line, keywords)) continue;
    const cents = lastAmount(line);
    if (cents !== undefined && cents > 0) return cents;
  }
  return undefined;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function isoDate(year: number, month: number, day: number): string | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  // Reject dates the calendar doesn't have (Feb 30, and so on).
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) {
    return undefined;
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function expandYear(raw: number): number {
  if (raw >= 1000) return raw;
  // Two-digit years on a receipt are this century.
  return raw + 2000;
}

/**
 * Pull a date out of the text.
 *
 * `MM/DD/YYYY` and `DD/MM/YYYY` are genuinely ambiguous for the first twelve
 * days of a month. We assume US order (month first) and only swap when the
 * first field is above 12, which is the best that can be done without knowing
 * where the receipt came from.
 */
export function extractDate(text: string): string | undefined {
  // ISO first — unambiguous, so it wins outright.
  const iso = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (iso) {
    const d = isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    if (d) return d;
  }

  // `12 Mar 2024`, `Mar 12, 2024`
  const named = /([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2,4})/i.exec(text);
  if (named) {
    const month = MONTHS[named[1]!.slice(0, 3).toLowerCase()];
    if (month) {
      const d = isoDate(expandYear(Number(named[3])), month, Number(named[2]));
      if (d) return d;
    }
  }
  const namedDayFirst = /(\d{1,2})\s+([a-z]{3,9})\.?\s+(\d{2,4})/i.exec(text);
  if (namedDayFirst) {
    const month = MONTHS[namedDayFirst[2]!.slice(0, 3).toLowerCase()];
    if (month) {
      const d = isoDate(expandYear(Number(namedDayFirst[3])), month, Number(namedDayFirst[1]));
      if (d) return d;
    }
  }

  // Numeric, separated by `/`, `-` or `.`
  const numeric = /(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/.exec(text);
  if (numeric) {
    const a = Number(numeric[1]);
    const b = Number(numeric[2]);
    const year = expandYear(Number(numeric[3]));
    const [month, day] = a > 12 ? [b, a] : [a, b];
    const d = isoDate(year, month, day);
    if (d) return d;
  }

  return undefined;
}

/** Lines that are structure or boilerplate rather than a merchant name. */
const MERCHANT_NOISE = [
  'receipt', 'invoice', 'welcome', 'thank you', 'thanks', 'customer copy',
  'merchant copy', 'order', 'tel', 'phone', 'fax', 'www', 'http', 'store',
  'register', 'cashier', 'terminal', 'transaction', 'date', 'time',
];

/**
 * Guess the merchant from the top of the receipt: the first line that reads
 * like a name rather than an address, a phone number or a header.
 */
export function extractMerchant(lines: string[]): string | undefined {
  for (const raw of lines.slice(0, 8)) {
    const line = raw.trim();
    if (line.length < 3 || line.length > 40) continue;

    const letters = line.replace(/[^a-z]/gi, '').length;
    if (letters < 3) continue;
    // Mostly digits — a phone number, an address or a barcode.
    if (letters / line.length < 0.5) continue;
    if (findAmounts(line).length > 0) continue;
    if (containsKeyword(line, MERCHANT_NOISE)) continue;
    // Street addresses.
    if (/^\d+\s+\w/.test(line)) continue;
    if (/\b(st|street|ave|avenue|rd|road|blvd|suite|ste|unit)\b\.?$/i.test(line)) continue;

    return line.replace(/\s+/g, ' ');
  }
  return undefined;
}

const LINE_ITEM_EXCLUSIONS = [
  ...TOTAL_DISQUALIFIERS,
  'total', 'tax', 'due', 'card', 'visa', 'mastercard', 'debit', 'credit',
  'amex', 'cash', 'balance', 'auth', 'approved', 'ref', 'account', 'tip',
  'gratuity', 'discount', 'coupon', 'savings',
];

export function extractLineItems(lines: string[]): { description: string; amountCents: Cents }[] {
  const items: { description: string; amountCents: Cents }[] = [];

  for (const line of lines) {
    if (containsKeyword(line, LINE_ITEM_EXCLUSIONS)) continue;

    const amounts = findAmounts(line);
    if (amounts.length === 0) continue;

    const price = amounts[amounts.length - 1]!;
    // Everything left of the price is the description.
    const description = line
      .slice(0, price.index)
      .replace(/[.\s_·-]+$/, '')
      .replace(/^\d+\s*[x@]\s*/i, '') // strip a leading quantity marker
      .trim();

    if (description.replace(/[^a-z]/gi, '').length < 2) continue;
    items.push({ description: description.replace(/\s+/g, ' '), amountCents: price.cents });
  }

  return items;
}

/** Run every extractor over raw OCR text. */
export function parseReceiptText(text: string): ParsedReceipt {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const subtotal = extractLabeledAmount(lines, ['subtotal', 'sub total']);
  const tax = extractLabeledAmount(lines, ['tax', 'vat', 'gst', 'hst']);

  const parsed: ParsedReceipt = {
    lineItems: extractLineItems(lines),
  };

  const merchant = extractMerchant(lines);
  if (merchant) parsed.merchant = merchant;

  const date = extractDate(text);
  if (date) parsed.date = date;

  const total = extractTotal(lines);
  if (total !== undefined) parsed.totalCents = total;

  if (subtotal !== undefined) parsed.subtotalCents = subtotal;
  if (tax !== undefined) parsed.taxCents = tax;

  return parsed;
}

/**
 * Sanity check on a parse, so the UI can flag a suspect total instead of
 * pretending confidence it doesn't have.
 */
export function parseWarnings(parsed: ParsedReceipt): string[] {
  const warnings: string[] = [];
  const { totalCents, subtotalCents, taxCents } = parsed;

  if (totalCents === undefined) {
    warnings.push("Couldn't find a total — enter it by hand.");
  }
  if (totalCents !== undefined && subtotalCents !== undefined && taxCents !== undefined) {
    const drift = Math.abs(subtotalCents + taxCents - totalCents);
    if (drift > 2) {
      warnings.push('Subtotal plus tax does not match the total — check the amount.');
    }
  }
  if (totalCents !== undefined && subtotalCents !== undefined && totalCents < subtotalCents) {
    warnings.push('Total is less than the subtotal — the wrong line may have been read.');
  }
  if (!parsed.merchant) {
    warnings.push("Couldn't read the merchant name.");
  }
  if (!parsed.date) {
    warnings.push("Couldn't read the date — defaulting to today.");
  }
  return warnings;
}

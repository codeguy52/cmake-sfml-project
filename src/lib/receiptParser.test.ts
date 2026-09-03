import { describe, expect, it } from 'vitest';
import {
  extractDate,
  extractLineItems,
  extractMerchant,
  extractTotal,
  findAmounts,
  parseReceiptText,
  parseWarnings,
} from './receiptParser';

describe('findAmounts', () => {
  it('finds currency amounts and ignores bare integers', () => {
    expect(findAmounts('2 @ 3.50   7.00').map((a) => a.cents)).toEqual([350, 700]);
    expect(findAmounts('QTY 4')).toEqual([]);
  });

  it('reads thousands separators and both negative conventions', () => {
    expect(findAmounts('1,234.56').map((a) => a.cents)).toEqual([123456]);
    expect(findAmounts('-5.00').map((a) => a.cents)).toEqual([-500]);
    expect(findAmounts('5.00-').map((a) => a.cents)).toEqual([-500]);
  });
});

describe('extractTotal', () => {
  it('prefers the total over the subtotal', () => {
    const lines = ['SUBTOTAL    18.00', 'TAX          1.44', 'TOTAL       19.44'];
    expect(extractTotal(lines)).toBe(1944);
  });

  it('prefers a stronger keyword over a plain total', () => {
    const lines = ['TOTAL ITEMS   3', 'TOTAL        19.44', 'AMOUNT DUE   21.94'];
    expect(extractTotal(lines)).toBe(2194);
  });

  it('survives OCR turning letters into digits', () => {
    // "T0TAL" with a zero, "5UBT0TAL" with a five.
    const lines = ['5UBT0TAL   18.00', 'T0TAL      19.44'];
    expect(extractTotal(lines)).toBe(1944);
  });

  it('ignores lines that only look like totals', () => {
    const lines = [
      'TOTAL SAVINGS   4.10',
      'TOTAL ITEMS     7',
      'CHANGE          0.56',
      'TOTAL          12.30',
    ];
    expect(extractTotal(lines)).toBe(1230);
  });

  it('takes the amount from the next line in a two-column layout', () => {
    expect(extractTotal(['BALANCE DUE', '42.15'])).toBe(4215);
  });

  it('falls back to the largest amount when no keyword is present', () => {
    expect(extractTotal(['Bread 3.50', 'Cheese 8.25', 'Milk 2.10'])).toBe(825);
  });

  it('takes the rightmost amount on the total line', () => {
    expect(extractTotal(['TOTAL  3 ITEMS      19.44'])).toBe(1944);
  });

  it('returns undefined for text with no amounts at all', () => {
    expect(extractTotal(['THANK YOU', 'COME AGAIN'])).toBeUndefined();
  });
});

describe('extractDate', () => {
  it('prefers an unambiguous ISO date', () => {
    expect(extractDate('Order 2026-03-09 12:45')).toBe('2026-03-09');
  });

  it('reads US-order numeric dates and expands a two-digit year', () => {
    expect(extractDate('03/09/26')).toBe('2026-03-09');
    expect(extractDate('3-9-2026')).toBe('2026-03-09');
  });

  it('swaps the order when the first field cannot be a month', () => {
    expect(extractDate('19/03/2026')).toBe('2026-03-19');
  });

  it('reads month names in either order', () => {
    expect(extractDate('Mar 9, 2026')).toBe('2026-03-09');
    expect(extractDate('9 March 2026')).toBe('2026-03-09');
  });

  it('rejects dates the calendar does not have', () => {
    expect(extractDate('02/30/2026')).toBeUndefined();
    expect(extractDate('13/45/2026')).toBeUndefined();
  });

  it('returns undefined when there is no date', () => {
    expect(extractDate('TOTAL 19.44')).toBeUndefined();
  });
});

describe('extractMerchant', () => {
  it('takes the name from the top and skips the address', () => {
    const lines = ['GREEN GROCER', '123 Market Street', '(555) 010-2000', 'TOTAL 19.44'];
    expect(extractMerchant(lines)).toBe('GREEN GROCER');
  });

  it('skips boilerplate headers', () => {
    const lines = ['*** CUSTOMER COPY ***', 'RECEIPT', 'Blue Bottle Coffee', 'TOTAL 6.25'];
    expect(extractMerchant(lines)).toBe('Blue Bottle Coffee');
  });

  it('returns undefined when nothing reads like a name', () => {
    expect(extractMerchant(['12345', '99.99', '###'])).toBeUndefined();
  });
});

describe('extractLineItems', () => {
  it('pairs descriptions with the price column', () => {
    const lines = [
      'Sourdough loaf        5.50',
      '2 @ Bananas           3.00',
      'SUBTOTAL              8.50',
      'TOTAL                 9.18',
    ];

    expect(extractLineItems(lines)).toEqual([
      { description: 'Sourdough loaf', amountCents: 550 },
      // The leading "2 @" quantity marker is stripped from the description.
      { description: 'Bananas', amountCents: 300 },
    ]);
  });

  it('drops payment and tax lines', () => {
    const lines = ['VISA DEBIT   19.44', 'TAX           1.44', 'AUTH 004512   0.00'];
    expect(extractLineItems(lines)).toEqual([]);
  });
});

describe('parseReceiptText', () => {
  const receipt = `
    GREEN GROCER
    123 Market Street
    Springfield

    03/09/2026  14:32

    Sourdough loaf        5.50
    Bananas               3.00
    Oat milk              4.75

    SUBTOTAL             13.25
    TAX                   1.06
    TOTAL                14.31

    VISA ****4242        14.31
    THANK YOU
  `;

  it('pulls every field out of a realistic receipt', () => {
    const parsed = parseReceiptText(receipt);

    expect(parsed.merchant).toBe('GREEN GROCER');
    expect(parsed.date).toBe('2026-03-09');
    expect(parsed.totalCents).toBe(1431);
    expect(parsed.subtotalCents).toBe(1325);
    expect(parsed.taxCents).toBe(106);
    expect(parsed.lineItems).toHaveLength(3);
  });

  it('reports no warnings when the arithmetic checks out', () => {
    expect(parseWarnings(parseReceiptText(receipt))).toEqual([]);
  });

  it('returns an empty parse for empty input rather than throwing', () => {
    const parsed = parseReceiptText('');
    expect(parsed.lineItems).toEqual([]);
    expect(parsed.totalCents).toBeUndefined();
  });
});

describe('parseWarnings', () => {
  it('flags a total that does not reconcile with subtotal plus tax', () => {
    const warnings = parseWarnings({
      lineItems: [],
      subtotalCents: 1000,
      taxCents: 100,
      totalCents: 5000,
    });
    expect(warnings.some((w) => w.includes('does not match'))).toBe(true);
  });

  it('flags a missing total and a missing date', () => {
    const warnings = parseWarnings({ lineItems: [] });
    expect(warnings.some((w) => w.includes('total'))).toBe(true);
    expect(warnings.some((w) => w.includes('date'))).toBe(true);
  });

  it('flags a total below the subtotal', () => {
    const warnings = parseWarnings({ lineItems: [], subtotalCents: 5000, totalCents: 1000 });
    expect(warnings.some((w) => w.includes('less than the subtotal'))).toBe(true);
  });
});

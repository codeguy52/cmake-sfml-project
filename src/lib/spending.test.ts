import { describe, expect, it } from 'vitest';
import {
  analyzeSpending,
  categoryPatterns,
  completeMonths,
  monthlyHistory,
  pacing,
  spendingTrendBps,
  topMerchants,
  uncategorizedShareBps,
  MIN_MONTHS_FOR_TREND,
} from './spending';
import { resolveBudget } from './budget';
import type { Category, Transaction } from '../types';

const NOW = new Date(2026, 5, 15); // 15 June 2026, a month half elapsed

const category = (id: string, name: string, percent: number): Category => ({
  id,
  name,
  color: '#2a78d6',
  group: 'needs',
  allocation: { mode: 'percent', value: percent * 100 },
  subcategories: [],
});

const tx = (date: string, amountCents: number, categoryId: string | null, merchant = 'Shop'): Transaction => ({
  id: `t-${date}-${amountCents}-${merchant}`,
  date,
  amountCents,
  merchant,
  categoryId,
  subcategoryId: null,
  source: 'manual',
  createdAt: 0,
});

describe('monthly history', () => {
  it('marks the month in progress, which is not comparable to a whole one', () => {
    const history = monthlyHistory([], 6, NOW);
    expect(history).toHaveLength(6);
    expect(history[5]!.month).toBe('2026-06');
    expect(history[5]!.partial).toBe(true);
    expect(history[4]!.partial).toBe(false);
  });

  it('keeps a half-finished month out of the complete set', () => {
    // Averaging a part-month with whole ones manufactures a fall in spending
    // that is only the calendar.
    const history = monthlyHistory(
      [tx('2026-06-02', 10_000, 'a'), tx('2026-05-02', 90_000, 'a')],
      6,
      NOW,
    );
    expect(completeMonths(history).map((m) => m.month)).toEqual(['2026-05']);
  });

  it('totals each month separately', () => {
    const history = monthlyHistory(
      [tx('2026-04-01', 5_000, 'a'), tx('2026-04-20', 7_000, 'a'), tx('2026-05-01', 3_000, 'a')],
      6,
      NOW,
    );
    expect(history.find((m) => m.month === '2026-04')!.spentCents).toBe(12_000);
    expect(history.find((m) => m.month === '2026-05')!.spentCents).toBe(3_000);
  });
});

describe('the direction of travel', () => {
  const months = (amounts: number[]) =>
    monthlyHistory(
      amounts.map((cents, i) => tx(`2026-0${i + 1}-05`, cents, 'a')),
      6,
      NOW,
    );

  it('says nothing without enough complete months', () => {
    expect(spendingTrendBps(months([100_000, 110_000]))).toBeNull();
  });

  it('reports a rise as a positive share', () => {
    // 100,100 then 150,150: a 50% rise between halves.
    const trend = spendingTrendBps(months([100_000, 100_000, 150_000, 150_000]));
    expect(trend).toBe(5_000);
  });

  it('reports a fall as a negative share', () => {
    expect(spendingTrendBps(months([200_000, 200_000, 100_000, 100_000]))).toBe(-5_000);
  });

  it('is flat when spending is steady', () => {
    expect(spendingTrendBps(months([100_000, 100_000, 100_000, 100_000]))).toBe(0);
  });
});

describe('category patterns', () => {
  const categories = [category('food', 'Food', 10)];

  const income = [{ id: 'i', name: 'Pay', kind: 'salary' as const, monthlyCents: 500_000 }];

  it('counts the months a category went over its budget', () => {
    const transactions = [
      tx('2026-03-05', 80_000, 'food'),
      tx('2026-04-05', 90_000, 'food'),
      tx('2026-05-05', 20_000, 'food'),
    ];
    // Budget is 10% of 5,000 = 500 a month; March and April are over.
    const history = monthlyHistory(transactions, 6, NOW);
    const patterns = categoryPatterns(categories, income, transactions, history);
    const food = patterns.find((p) => p.categoryId === 'food')!;
    expect(food.monthsObserved).toBe(3);
    expect(food.monthsOver).toBe(2);
  });

  it('ignores the month in progress', () => {
    const transactions = [tx('2026-06-05', 999_000, 'food'), tx('2026-05-05', 1_000, 'food')];
    const history = monthlyHistory(transactions, 6, NOW);
    const food = categoryPatterns(categories, income, transactions, history).find(
      (p) => p.categoryId === 'food',
    )!;
    expect(food.monthsObserved).toBe(1);
    expect(food.averageCents).toBe(1_000);
  });

  it('returns nothing when there is no complete month at all', () => {
    const transactions = [tx('2026-06-05', 1_000, 'food')];
    expect(
      categoryPatterns(categories, income, transactions, monthlyHistory(transactions, 6, NOW)),
    ).toEqual([]);
  });
});

describe('where the money went', () => {
  it('groups merchants case-insensitively and counts visits', () => {
    const transactions = [
      tx('2026-05-01', 1_000, 'a', 'Coffee Co'),
      tx('2026-05-02', 2_000, 'a', 'coffee co'),
      tx('2026-05-03', 9_000, 'a', 'Rent'),
    ];
    const top = topMerchants(transactions, monthlyHistory(transactions, 6, NOW));
    expect(top[0]!.merchant).toBe('Rent');
    expect(top[1]!.totalCents).toBe(3_000);
    expect(top[1]!.count).toBe(2);
  });

  it('names an empty merchant rather than dropping the spend', () => {
    const transactions = [tx('2026-05-01', 1_000, 'a', '  ')];
    expect(topMerchants(transactions, monthlyHistory(transactions, 6, NOW))[0]!.merchant).toBe(
      'Unnamed',
    );
  });
});

describe('spending with no category', () => {
  it('reports it as a share of everything spent', () => {
    const transactions = [tx('2026-05-01', 25_000, null), tx('2026-05-02', 75_000, 'a')];
    expect(uncategorizedShareBps(transactions, monthlyHistory(transactions, 6, NOW))).toBe(2_500);
  });

  it('is zero when everything is categorised', () => {
    const transactions = [tx('2026-05-02', 75_000, 'a')];
    expect(uncategorizedShareBps(transactions, monthlyHistory(transactions, 6, NOW))).toBe(0);
  });
});

describe('pace through the month', () => {
  const summaryWith = (spent: number, budget: number) =>
    ({ totalSpentCents: spent, totalBudgetedCents: budget }) as ReturnType<typeof resolveBudget>;

  it('compares budget used against the month elapsed', () => {
    // 15 June of 30: half the month gone.
    const p = pacing(summaryWith(80_000, 100_000), NOW)!;
    expect(p.elapsedBps).toBe(5_000);
    expect(p.spentBps).toBe(8_000);
    expect(p.aheadBps).toBe(3_000);
  });

  it('says nothing without a budget to pace against', () => {
    expect(pacing(summaryWith(10_000, 0), NOW)).toBeNull();
  });
});

describe('the findings', () => {
  const income = [{ id: 'i', name: 'Pay', kind: 'salary' as const, monthlyCents: 500_000 }];
  const categories = [category('food', 'Food', 10)];

  const analyse = (transactions: Transaction[]) =>
    analyzeSpending({
      categories,
      incomeSources: income,
      transactions,
      summary: resolveBudget(categories, income, transactions, '2026-06'),
      now: NOW,
    });

  it('admits it has nothing to say yet with one month', () => {
    const { findings } = analyse([tx('2026-05-05', 10_000, 'food')]);
    expect(findings.some((f) => f.id === 'needs-history')).toBe(true);
  });

  it('flags a budget that loses every month as a budget, not a habit', () => {
    const transactions = ['2026-02', '2026-03', '2026-04', '2026-05'].map((m) =>
      tx(`${m}-05`, 90_000, 'food'),
    );
    const finding = analyse(transactions).findings.find((f) => f.id === 'chronic-food');
    expect(finding?.title).toContain('4 of the last 4 months');
    expect(finding?.detail).toContain('never real');
  });

  it('flags a budget nobody uses', () => {
    const transactions = ['2026-02', '2026-03', '2026-04', '2026-05'].map((m) =>
      tx(`${m}-05`, 10_000, 'food'),
    );
    // Budget 50,000 a month, spending 10,000 — a fifth of it.
    expect(analyse(transactions).findings.some((f) => f.id === 'slack-food')).toBe(true);
  });

  it('flags uncategorised spending', () => {
    const transactions = [
      tx('2026-05-01', 50_000, null),
      tx('2026-05-02', 50_000, 'food'),
    ];
    expect(analyse(transactions).findings.some((f) => f.id === 'uncategorized')).toBe(true);
  });

  it('quotes a figure in every finding', () => {
    const transactions = ['2026-02', '2026-03', '2026-04', '2026-05'].map((m) =>
      tx(`${m}-05`, 90_000, 'food'),
    );
    for (const finding of analyse(transactions).findings) {
      expect(finding.title).toMatch(/\d/);
    }
  });

  it('never claims a trend from fewer months than it trusts', () => {
    const transactions = [tx('2026-04-05', 10_000, 'food'), tx('2026-05-05', 90_000, 'food')];
    const { findings, trendBps } = analyse(transactions);
    expect(trendBps).toBeNull();
    expect(findings.some((f) => f.id === 'trend')).toBe(false);
    expect(MIN_MONTHS_FOR_TREND).toBeGreaterThan(2);
  });
});

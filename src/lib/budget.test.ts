import { describe, expect, it } from 'vitest';
import type { Category, IncomeSource, Transaction } from '../types';
import {
  monthlyBudgetedSavings,
  monthlyFundedSpending,
  normalizePercentages,
  resolveBudget,
  spendingByMonth,
} from './budget';

const income: IncomeSource[] = [
  { id: 'i1', name: 'Salary', kind: 'salary', monthlyCents: 500_000 }, // $5,000
];

function category(overrides: Partial<Category> & { id: string }): Category {
  return {
    name: overrides.id,
    color: '#2a78d6',
    group: 'needs',
    allocation: { mode: 'percent', value: 0 },
    subcategories: [],
    ...overrides,
  };
}

describe('resolveBudget', () => {
  it('resolves percentage and fixed categories against the same income', () => {
    const categories = [
      category({ id: 'rent', allocation: { mode: 'fixed', value: 150_000 } }),
      category({ id: 'food', allocation: { mode: 'percent', value: 1200 } }), // 12%
    ];

    const summary = resolveBudget(categories, income, [], '2026-09');

    expect(summary.monthlyIncomeCents).toBe(500_000);
    expect(summary.categories[0]!.budgetCents).toBe(150_000);
    expect(summary.categories[1]!.budgetCents).toBe(60_000); // 12% of $5,000
    expect(summary.totalBudgetedCents).toBe(210_000);
    expect(summary.unallocatedCents).toBe(290_000);
    expect(summary.overAllocated).toBe(false);
  });

  it('resolves subcategory percentages against the parent, not income', () => {
    const categories = [
      category({
        id: 'housing',
        allocation: { mode: 'percent', value: 3000 }, // 30% = $1,500
        subcategories: [
          { id: 's-rent', name: 'Rent', allocation: { mode: 'percent', value: 8000 } }, // 80% of $1,500
          { id: 's-util', name: 'Utilities', allocation: { mode: 'fixed', value: 20_000 } },
        ],
      }),
    ];

    const summary = resolveBudget(categories, income, [], '2026-09');
    const housing = summary.categories[0]!;

    expect(housing.budgetCents).toBe(150_000);
    expect(housing.subcategories[0]!.budgetCents).toBe(120_000); // 80% of the parent
    expect(housing.subcategories[1]!.budgetCents).toBe(20_000);
    expect(housing.unassignedCents).toBe(10_000);
  });

  it('flags subcategories that claim more than their parent holds', () => {
    const categories = [
      category({
        id: 'food',
        allocation: { mode: 'fixed', value: 50_000 },
        subcategories: [
          { id: 's1', name: 'Groceries', allocation: { mode: 'fixed', value: 40_000 } },
          { id: 's2', name: 'Dining', allocation: { mode: 'fixed', value: 30_000 } },
        ],
      }),
    ];

    const summary = resolveBudget(categories, income, [], '2026-09');
    expect(summary.categories[0]!.unassignedCents).toBe(-20_000);
  });

  it('flags an over-allocated budget', () => {
    const categories = [
      category({ id: 'a', allocation: { mode: 'percent', value: 7000 } }),
      category({ id: 'b', allocation: { mode: 'percent', value: 4000 } }),
    ];

    const summary = resolveBudget(categories, income, [], '2026-09');
    expect(summary.overAllocated).toBe(true);
    expect(summary.totalBudgetedCents).toBe(550_000); // 110% of $5,000
    expect(summary.unallocatedCents).toBe(-50_000);
  });

  it('counts only the requested month and splits direct from subcategory spend', () => {
    const categories = [
      category({
        id: 'food',
        allocation: { mode: 'fixed', value: 50_000 },
        subcategories: [{ id: 's1', name: 'Groceries', allocation: { mode: 'percent', value: 10_000 } }],
      }),
    ];

    const transactions: Transaction[] = [
      {
        id: 't1', date: '2026-09-04', amountCents: 8_000, merchant: 'Market',
        categoryId: 'food', subcategoryId: 's1', source: 'manual', createdAt: 1,
      },
      {
        id: 't2', date: '2026-09-11', amountCents: 3_000, merchant: 'Corner shop',
        categoryId: 'food', subcategoryId: null, source: 'manual', createdAt: 2,
      },
      {
        id: 't3', date: '2026-08-30', amountCents: 99_000, merchant: 'Last month',
        categoryId: 'food', subcategoryId: null, source: 'manual', createdAt: 3,
      },
    ];

    const summary = resolveBudget(categories, income, transactions, '2026-09');
    const food = summary.categories[0]!;

    expect(food.spentCents).toBe(11_000);
    expect(food.subcategories[0]!.spentCents).toBe(8_000);
    expect(food.directSpentCents).toBe(3_000);
    expect(food.remainingCents).toBe(39_000);
  });

  it('resolves percentages to zero when there is no income, without dividing by zero', () => {
    const categories = [category({ id: 'a', allocation: { mode: 'percent', value: 5000 } })];
    const summary = resolveBudget(categories, [], [], '2026-09');

    expect(summary.categories[0]!.budgetCents).toBe(0);
    expect(summary.categories[0]!.shareOfIncomeBps).toBe(0);
    expect(summary.overAllocated).toBe(false);
  });

  it('excludes archived categories and subcategories', () => {
    const categories = [
      category({ id: 'live', allocation: { mode: 'fixed', value: 10_000 } }),
      category({ id: 'dead', allocation: { mode: 'fixed', value: 90_000 }, archived: true }),
    ];

    const summary = resolveBudget(categories, income, [], '2026-09');
    expect(summary.categories).toHaveLength(1);
    expect(summary.totalBudgetedCents).toBe(10_000);
  });
});

describe('group rollups', () => {
  const categories = [
    category({ id: 'rent', group: 'needs', allocation: { mode: 'percent', value: 3000 } }),
    category({ id: 'fun', group: 'wants', allocation: { mode: 'percent', value: 2000 } }),
    category({ id: 'invest', group: 'savings', allocation: { mode: 'percent', value: 3000 } }),
  ];

  it('separates spending that FI must fund from money being saved', () => {
    const summary = resolveBudget(categories, income, [], '2026-09');

    // Needs + wants = 50% of $5,000. Savings is deliberately excluded: once
    // you are financially independent you stop saving out of earned income.
    expect(monthlyFundedSpending(summary)).toBe(250_000);
    expect(monthlyBudgetedSavings(summary)).toBe(150_000);
  });
});

describe('normalizePercentages', () => {
  it('scales percentages to fill what fixed amounts leave behind', () => {
    const categories = [
      category({ id: 'rent', allocation: { mode: 'fixed', value: 100_000 } }), // $1,000 of $5,000
      category({ id: 'a', allocation: { mode: 'percent', value: 3000 } }),
      category({ id: 'b', allocation: { mode: 'percent', value: 1000 } }),
    ];

    const result = normalizePercentages(categories, 500_000);

    // $4,000 of $5,000 is left, so 8,000 bp split 3:1.
    expect(result[0]!.allocation).toEqual({ mode: 'fixed', value: 100_000 });
    expect(result[1]!.allocation.value).toBe(6000);
    expect(result[2]!.allocation.value).toBe(2000);
  });

  it('lands on exactly the available basis points despite rounding', () => {
    const categories = [
      category({ id: 'a', allocation: { mode: 'percent', value: 1000 } }),
      category({ id: 'b', allocation: { mode: 'percent', value: 1000 } }),
      category({ id: 'c', allocation: { mode: 'percent', value: 1000 } }),
    ];

    const result = normalizePercentages(categories, 500_000);
    const total = result.reduce((sum, c) => sum + c.allocation.value, 0);
    expect(total).toBe(10_000);
  });

  it('leaves the budget alone when there is nothing to scale', () => {
    const categories = [category({ id: 'a', allocation: { mode: 'fixed', value: 1000 } })];
    expect(normalizePercentages(categories, 500_000)).toBe(categories);
  });
});

describe('spendingByMonth', () => {
  it('buckets into the trailing months, oldest first', () => {
    const transactions: Transaction[] = [
      { id: 't1', date: '2026-09-02', amountCents: 100, merchant: '', categoryId: null, subcategoryId: null, source: 'manual', createdAt: 1 },
      { id: 't2', date: '2026-08-15', amountCents: 200, merchant: '', categoryId: null, subcategoryId: null, source: 'manual', createdAt: 2 },
      { id: 't3', date: '2020-01-01', amountCents: 999, merchant: '', categoryId: null, subcategoryId: null, source: 'manual', createdAt: 3 },
    ];

    const months = spendingByMonth(transactions, 3, new Date(2026, 8, 15));

    expect(months.map((m) => m.month)).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(months.map((m) => m.spentCents)).toEqual([0, 200, 100]);
  });
});

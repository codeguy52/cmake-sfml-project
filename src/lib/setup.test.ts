import { describe, expect, it } from 'vitest';
import { applySavingsTarget, looksUsed, monthlySavings, savingsShareBps, SAVINGS_PRESETS } from './setup';
import { seedAppData } from './seed';
import { resolveBudget } from './budget';
import type { Category } from '../types';

const seeded = (): Category[] => seedAppData().categories;

describe('savings presets', () => {
  it('hits the target share exactly', () => {
    for (const preset of SAVINGS_PRESETS) {
      const applied = applySavingsTarget(seeded(), preset.savingsBps);
      expect(savingsShareBps(applied)).toBe(preset.savingsBps);
    }
  });

  it('still adds up to exactly 100% of income', () => {
    for (const preset of SAVINGS_PRESETS) {
      const applied = applySavingsTarget(seeded(), preset.savingsBps);
      const total = applied.reduce((sum, c) => sum + c.allocation.value, 0);
      // Not 9,999 and not 10,001: a budget that misses by a basis point turns
      // into an unexplained dollar somewhere down the line.
      expect(total).toBe(10_000);
    }
  });

  it('keeps proportions inside each group', () => {
    const before = seeded();
    const after = applySavingsTarget(before, 3_500);

    const ratio = (categories: Category[], a: string, b: string): number => {
      const find = (name: string): number =>
        categories.find((c) => c.name === name)!.allocation.value;
      return find(a) / find(b);
    };

    // Housing was twice Food before; it must still be twice Food after.
    expect(ratio(after, 'Housing', 'Food')).toBeCloseTo(ratio(before, 'Housing', 'Food'), 2);
    expect(ratio(after, 'Investing', 'Cash reserve')).toBeCloseTo(
      ratio(before, 'Investing', 'Cash reserve'),
      2,
    );
  });

  it('leaves fixed-amount categories alone', () => {
    const categories = seeded().map((c) =>
      c.name === 'Housing' ? { ...c, allocation: { mode: 'fixed' as const, value: 180_000 } } : c,
    );
    const after = applySavingsTarget(categories, 3_500);
    const housing = after.find((c) => c.name === 'Housing')!;

    // Rent is a number somebody typed, not a share of anything.
    expect(housing.allocation).toEqual({ mode: 'fixed', value: 180_000 });
  });

  it('produces a budget that resolves without overspending income', () => {
    const income = 500_000;
    const applied = applySavingsTarget(seeded(), 3_500);
    const summary = resolveBudget(
      applied,
      [{ id: 'inc', name: 'Take-home pay', kind: 'salary', monthlyCents: income }],
      [],
      '2026-09',
    );
    expect(summary.totalBudgetedCents).toBeLessThanOrEqual(income);
  });

  it('refuses to leave nothing to live on', () => {
    const applied = applySavingsTarget(seeded(), 12_000);
    expect(savingsShareBps(applied)).toBeLessThanOrEqual(9_500);
  });
});

describe('monthlySavings', () => {
  it('reports the preset in money, rounded to the cent', () => {
    expect(monthlySavings(500_000, 2_000)).toBe(100_000);
    expect(monthlySavings(433_333, 3_500)).toBe(151_667);
  });
});

describe('looksUsed', () => {
  it('is false for a freshly seeded dataset', () => {
    expect(looksUsed(seedAppData())).toBe(false);
  });

  it('is true once there is income, spending or an account', () => {
    expect(looksUsed({ incomeSources: [{ monthlyCents: 1 }] })).toBe(true);
    expect(looksUsed({ transactions: [{}] })).toBe(true);
    expect(looksUsed({ accounts: [{}] })).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import type { InvestmentAccount, Liability, OtherAsset } from '../types';
import {
  computeNetWorth,
  holdingReturnBps,
  holdingValue,
  rebalancePlan,
  summarizePortfolio,
} from './investments';
import { foldToOther } from './palette';

const accounts: InvestmentAccount[] = [
  {
    id: 'a1',
    name: '401(k)',
    kind: '401k',
    taxTreatment: 'pretax',
    monthlyContributionCents: 100_000,
    employerMatchCents: 50_000,
    holdings: [
      {
        id: 'h1', symbol: 'VTI', name: 'Total US', assetClass: 'us_stock',
        shares: 100, priceCents: 25_000, costBasisCents: 2_000_000, expenseRatioBps: 3,
      },
      {
        id: 'h2', symbol: 'BND', name: 'Bonds', assetClass: 'bond',
        shares: 50, priceCents: 7_000, costBasisCents: 400_000, expenseRatioBps: 4,
      },
    ],
  },
  {
    id: 'a2',
    name: 'Brokerage',
    kind: 'taxable',
    taxTreatment: 'taxable',
    monthlyContributionCents: 30_000,
    holdings: [
      {
        id: 'h3', symbol: 'VXUS', name: 'International', assetClass: 'intl_stock',
        shares: 60, priceCents: 6_000, costBasisCents: 300_000, expenseRatioBps: 7,
      },
    ],
  },
];

describe('holding math', () => {
  it('values a holding at shares times price', () => {
    expect(holdingValue(accounts[0]!.holdings[0]!)).toBe(2_500_000); // 100 × $250
  });

  it('rounds fractional shares to whole cents', () => {
    expect(
      holdingValue({
        id: 'x', symbol: 'X', name: '', assetClass: 'us_stock',
        shares: 3.333, priceCents: 1001, costBasisCents: 0,
      }),
    ).toBe(3336); // 3.333 × 1001 = 3336.333
  });

  it('reports return against cost basis, and nothing when there is none', () => {
    expect(holdingReturnBps(accounts[0]!.holdings[0]!)).toBe(2500); // $25k on $20k = +25%
    expect(
      holdingReturnBps({
        id: 'x', symbol: 'X', name: '', assetClass: 'cash',
        shares: 1, priceCents: 100, costBasisCents: 0,
      }),
    ).toBe(0);
  });
});

describe('summarizePortfolio', () => {
  const summary = summarizePortfolio(accounts);

  it('totals value, basis and gain', () => {
    // $25,000 + $3,500 + $3,600
    expect(summary.totalValueCents).toBe(3_210_000);
    expect(summary.totalCostBasisCents).toBe(2_700_000);
    expect(summary.totalGainCents).toBe(510_000);
    expect(summary.totalReturnBps).toBe(1889);
  });

  it('groups by asset class, largest first, with shares summing to 100%', () => {
    expect(summary.byAssetClass[0]!.assetClass).toBe('us_stock');
    const shareTotal = summary.byAssetClass.reduce((sum, c) => sum + c.shareBps, 0);
    expect(shareTotal).toBeGreaterThan(9_990);
    expect(shareTotal).toBeLessThanOrEqual(10_010);
  });

  it('keeps the employer match separate from your own contribution', () => {
    expect(summary.monthlyContributionCents).toBe(130_000);
    expect(summary.monthlyEmployerMatchCents).toBe(50_000);
  });

  it('blends expense ratios by value, not by count', () => {
    // A simple mean would be 4.67 bp; weighting by value gives ~3.5.
    expect(summary.blendedExpenseRatioBps).toBe(4);
    expect(summary.annualFeeDragCents).toBe(1284);
  });

  it('handles an empty portfolio without dividing by zero', () => {
    const empty = summarizePortfolio([]);
    expect(empty.totalValueCents).toBe(0);
    expect(empty.totalReturnBps).toBe(0);
    expect(empty.blendedExpenseRatioBps).toBe(0);
    expect(empty.byAssetClass).toEqual([]);
  });

  it('excludes archived accounts', () => {
    const withArchived = summarizePortfolio([
      ...accounts,
      { ...accounts[1]!, id: 'a3', name: 'Old', archived: true },
    ]);
    expect(withArchived.totalValueCents).toBe(3_210_000);
  });
});

describe('computeNetWorth', () => {
  const otherAssets: OtherAsset[] = [
    { id: 'o1', name: 'House', valueCents: 40_000_000, countTowardFI: false },
    { id: 'o2', name: 'Cash savings', valueCents: 1_000_000, countTowardFI: true },
  ];
  const liabilities: Liability[] = [
    { id: 'l1', name: 'Mortgage', balanceCents: 25_000_000, aprBps: 550, minimumPaymentCents: 180_000 },
  ];

  it('separates the assets that fund FI from the ones that do not', () => {
    const nw = computeNetWorth(accounts, otherAssets, liabilities);

    // Investments plus the cash marked as funding FI — not the house.
    expect(nw.fiAssetsCents).toBe(4_210_000);
    expect(nw.nonFiAssetsCents).toBe(40_000_000);
    expect(nw.totalAssetsCents).toBe(44_210_000);
    expect(nw.netWorthCents).toBe(19_210_000);
  });

  it('can go negative', () => {
    const nw = computeNetWorth([], [], [
      { id: 'l', name: 'Loan', balanceCents: 5_000_000, aprBps: 700, minimumPaymentCents: 0 },
    ]);
    expect(nw.netWorthCents).toBe(-5_000_000);
  });
});

describe('rebalancePlan', () => {
  it('reports overweight as positive drift', () => {
    const summary = summarizePortfolio(accounts);
    const plan = rebalancePlan(summary, { us_stock: 6000, intl_stock: 2000, bond: 2000 });

    const usStock = plan.find((p) => p.assetClass === 'us_stock')!;
    // US stock is ~78% of the portfolio against a 60% target.
    expect(usStock.driftCents).toBeGreaterThan(0);

    const bond = plan.find((p) => p.assetClass === 'bond')!;
    expect(bond.driftCents).toBeLessThan(0);
  });

  it('includes target classes the portfolio does not hold yet', () => {
    const summary = summarizePortfolio(accounts);
    const plan = rebalancePlan(summary, { reit: 1000 });
    const reit = plan.find((p) => p.assetClass === 'reit')!;

    expect(reit.currentBps).toBe(0);
    expect(reit.driftCents).toBeLessThan(0);
  });
});

describe('foldToOther', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({
    id: `c${i}`,
    label: `Category ${i}`,
    valueCents: (12 - i) * 1000,
    color: '#2a78d6',
  }));

  it('caps the series count and folds the tail', () => {
    const folded = foldToOther(items, 7);

    expect(folded).toHaveLength(7);
    expect(folded[6]!.isOther).toBe(true);
    expect(folded[6]!.count).toBe(6);
    // Nothing is lost — the fold preserves the total.
    expect(folded.reduce((sum, s) => sum + s.valueCents, 0)).toBe(
      items.reduce((sum, i) => sum + i.valueCents, 0),
    );
  });

  it('leaves a short list alone and drops empty slices', () => {
    const folded = foldToOther(
      [
        { id: 'a', label: 'A', valueCents: 100, color: '#2a78d6' },
        { id: 'b', label: 'B', valueCents: 0, color: '#eb6834' },
      ],
      7,
    );
    expect(folded).toHaveLength(1);
    expect(folded[0]!.id).toBe('a');
  });

  it('sorts by magnitude so the largest slice leads', () => {
    const folded = foldToOther(
      [
        { id: 'small', label: 'Small', valueCents: 10, color: '#2a78d6' },
        { id: 'big', label: 'Big', valueCents: 900, color: '#eb6834' },
      ],
      7,
    );
    expect(folded[0]!.id).toBe('big');
  });
});

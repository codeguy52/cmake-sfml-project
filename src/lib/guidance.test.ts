import { describe, expect, it } from 'vitest';
import type { FISettings, InvestmentAccount, Liability, OtherAsset } from '../types';
import {
  buildGuidancePlan,
  emergencyCashCents,
  highRateDebts,
  portfolioObservations,
  unclaimedEmployerMatch,
} from './guidance';

const fi: FISettings = {
  safeWithdrawalRateBps: 400,
  expectedReturnBps: 700,
  inflationBps: 300,
  annualSpendingOverrideCents: null,
  currentAge: 30,
  targetRetirementAge: 65,
};

function account(overrides: Partial<InvestmentAccount> & { id: string }): InvestmentAccount {
  return {
    name: overrides.id,
    kind: 'taxable',
    taxTreatment: 'taxable',
    holdings: [],
    monthlyContributionCents: 0,
    ...overrides,
  };
}

const holding = (
  symbol: string,
  assetClass: InvestmentAccount['holdings'][number]['assetClass'],
  valueCents: number,
  expenseRatioBps?: number,
) => ({
  id: `h-${symbol}`,
  symbol,
  name: symbol,
  assetClass,
  shares: 1,
  priceCents: valueCents,
  costBasisCents: valueCents,
  ...(expenseRatioBps !== undefined ? { expenseRatioBps } : {}),
});

describe('emergencyCashCents', () => {
  it('counts whole cash accounts and cash holdings inside investment accounts', () => {
    const accounts = [
      account({ id: 'savings', kind: 'cash', holdings: [holding('CASH', 'cash', 500_000)] }),
      account({
        id: 'brokerage',
        holdings: [holding('VTI', 'us_stock', 1_000_000), holding('SPAXX', 'cash', 200_000)],
      }),
    ];

    expect(emergencyCashCents(accounts, [])).toBe(700_000);
  });

  it('counts a cash-named other asset only when it funds FI', () => {
    const assets: OtherAsset[] = [
      { id: '1', name: 'Emergency fund', valueCents: 300_000, countTowardFI: true },
      { id: '2', name: 'Emergency fund (excluded)', valueCents: 999_000, countTowardFI: false },
      { id: '3', name: 'House', valueCents: 40_000_000, countTowardFI: true },
    ];

    expect(emergencyCashCents([], assets)).toBe(300_000);
  });

  it('excludes archived accounts', () => {
    const accounts = [
      account({ id: 'old', kind: 'cash', archived: true, holdings: [holding('C', 'cash', 900_000)] }),
    ];
    expect(emergencyCashCents(accounts, [])).toBe(0);
  });
});

describe('unclaimedEmployerMatch', () => {
  it('reports the shortfall against a configured match', () => {
    const accounts = [
      account({ id: '401k', kind: '401k', monthlyContributionCents: 20_000, employerMatchCents: 50_000 }),
    ];
    expect(unclaimedEmployerMatch(accounts)).toBe(30_000);
  });

  it('is zero when contributions meet or exceed the match', () => {
    expect(
      unclaimedEmployerMatch([
        account({ id: 'a', monthlyContributionCents: 60_000, employerMatchCents: 50_000 }),
      ]),
    ).toBe(0);
  });

  it('ignores accounts with no match recorded', () => {
    expect(unclaimedEmployerMatch([account({ id: 'a', monthlyContributionCents: 0 })])).toBe(0);
  });
});

describe('highRateDebts', () => {
  const liabilities: Liability[] = [
    { id: '1', name: 'Credit card', balanceCents: 400_000, aprBps: 2400, minimumPaymentCents: 5_000 },
    { id: '2', name: 'Car loan', balanceCents: 1_500_000, aprBps: 500, minimumPaymentCents: 30_000 },
    { id: '3', name: 'Student loan', balanceCents: 800_000, aprBps: 800, minimumPaymentCents: 20_000 },
  ];

  it('keeps only debt above the threshold, worst first', () => {
    const result = highRateDebts(liabilities, 700);
    expect(result.map((l) => l.name)).toEqual(['Credit card', 'Student loan']);
  });

  it('ignores paid-off debt', () => {
    expect(
      highRateDebts([{ id: 'x', name: 'Paid', balanceCents: 0, aprBps: 3000, minimumPaymentCents: 0 }], 700),
    ).toEqual([]);
  });
});

describe('buildGuidancePlan', () => {
  const base = {
    accounts: [] as InvestmentAccount[],
    liabilities: [] as Liability[],
    otherAssets: [] as OtherAsset[],
    fi,
    monthlyNeedsCents: 300_000,
    monthlyWantsCents: 150_000,
    monthlySavingsCents: 200_000,
  };

  it('puts a missing starter fund first', () => {
    const plan = buildGuidancePlan(base);
    expect(plan.currentStepId).toBe('starter-fund');
    expect(plan.starterFundTargetCents).toBe(300_000);
    expect(plan.fullFundTargetCents).toBe(900_000);
  });

  it('moves to the employer match once the starter fund is covered', () => {
    const plan = buildGuidancePlan({
      ...base,
      accounts: [
        account({ id: 'cash', kind: 'cash', holdings: [holding('C', 'cash', 400_000)] }),
        account({
          id: '401k',
          kind: '401k',
          monthlyContributionCents: 10_000,
          employerMatchCents: 40_000,
        }),
      ],
    });

    expect(plan.steps.find((s) => s.id === 'starter-fund')!.status).toBe('done');
    expect(plan.currentStepId).toBe('employer-match');
    expect(plan.unclaimedMatchCents).toBe(30_000);
  });

  it('marks the match step not applicable without a workplace plan', () => {
    const plan = buildGuidancePlan(base);
    expect(plan.steps.find((s) => s.id === 'employer-match')!.status).toBe('not_applicable');
  });

  it('flags debt above the expected return and ignores debt below it', () => {
    const plan = buildGuidancePlan({
      ...base,
      accounts: [account({ id: 'cash', kind: 'cash', holdings: [holding('C', 'cash', 1_000_000)] })],
      liabilities: [
        { id: '1', name: 'Card', balanceCents: 500_000, aprBps: 2200, minimumPaymentCents: 0 },
        { id: '2', name: 'Mortgage', balanceCents: 20_000_000, aprBps: 400, minimumPaymentCents: 0 },
      ],
    });

    const step = plan.steps.find((s) => s.id === 'high-rate-debt')!;
    expect(step.status).toBe('current');
    // Only the card counts; a 4% mortgage is below a 7% expected return.
    expect(plan.highRateDebtCents).toBe(500_000);
    expect(step.detail).toContain('Card');
    expect(step.detail).not.toContain('Mortgage');
  });

  it('reports months of expenses held against needs plus wants', () => {
    const plan = buildGuidancePlan({
      ...base,
      accounts: [account({ id: 'cash', kind: 'cash', holdings: [holding('C', 'cash', 900_000)] })],
    });
    // $9,000 against $4,500 a month of needs+wants.
    expect(plan.monthsOfExpensesHeld).toBeCloseTo(2, 5);
  });

  it('degrades gracefully with no budget rather than dividing by zero', () => {
    const plan = buildGuidancePlan({
      ...base,
      monthlyNeedsCents: 0,
      monthlyWantsCents: 0,
      monthlySavingsCents: 0,
    });

    expect(plan.monthsOfExpensesHeld).toBe(0);
    expect(plan.starterFundTargetCents).toBe(0);
    expect(plan.steps.find((s) => s.id === 'starter-fund')!.detail).toContain('Budget page');
  });

  it('always returns every step so the order stays visible', () => {
    const plan = buildGuidancePlan(base);
    expect(plan.steps.map((s) => s.id)).toEqual([
      'starter-fund',
      'employer-match',
      'high-rate-debt',
      'full-fund',
      'hsa',
      'ira',
      'max-workplace',
      'taxable',
    ]);
  });

  it('never states a contribution limit as fact', () => {
    const plan = buildGuidancePlan({
      ...base,
      accounts: [account({ id: 'ira', kind: 'roth_ira', monthlyContributionCents: 50_000 })],
    });
    const ira = plan.steps.find((s) => s.id === 'ira')!;
    // Limits change annually; a stale figure stated confidently would be worse
    // than none, so the copy defers to the IRS instead.
    expect(ira.detail).toMatch(/limit changes yearly|irs\.gov/i);
    expect(ira.detail).not.toMatch(/\$\d{1,2},\d{3}/);
  });
});

describe('portfolioObservations', () => {
  it('says nothing about an empty portfolio', () => {
    expect(portfolioObservations([], fi, 0, 100_000)).toEqual([]);
  });

  it('escalates a high blended expense ratio and quantifies it', () => {
    const accounts = [account({ id: 'a', holdings: [holding('EXPENSIVE', 'us_stock', 10_000_000, 90)] })];
    const [fees] = portfolioObservations(accounts, fi, 0, 100_000);

    expect(fees!.id).toBe('fees');
    expect(fees!.severity).toBe('serious');
    expect(fees!.detail).toMatch(/30 years/);
  });

  it('treats a cheap portfolio as good news', () => {
    const accounts = [account({ id: 'a', holdings: [holding('VTI', 'us_stock', 10_000_000, 3)] })];
    const [fees] = portfolioObservations(accounts, fi, 0, 100_000);
    expect(fees!.severity).toBe('good');
  });

  it('flags concentration only when there is something to compare against', () => {
    const concentrated = [
      account({
        id: 'a',
        holdings: [holding('VTI', 'us_stock', 9_900_000), holding('BND', 'bond', 100_000)],
      }),
    ];
    expect(portfolioObservations(concentrated, fi, 0, 100_000).some((o) => o.id === 'concentration')).toBe(
      true,
    );

    const single = [account({ id: 'a', holdings: [holding('VTI', 'us_stock', 10_000_000)] })];
    expect(portfolioObservations(single, fi, 0, 100_000).some((o) => o.id === 'concentration')).toBe(
      false,
    );
  });

  it('flags cash drag only when the pile is both large and long', () => {
    const accounts = [
      account({ id: 'a', holdings: [holding('C', 'cash', 5_000_000), holding('VTI', 'us_stock', 5_000_000)] }),
    ];

    // 50 months of spending sitting in cash.
    expect(
      portfolioObservations(accounts, fi, 5_000_000, 100_000).some((o) => o.id === 'cash-drag'),
    ).toBe(true);

    // Same share, but only 2 months of spending — that's an emergency fund.
    expect(
      portfolioObservations(accounts, fi, 5_000_000, 2_500_000).some((o) => o.id === 'cash-drag'),
    ).toBe(false);
  });
});

describe('employer match step', () => {
  const base = {
    accounts: [] as InvestmentAccount[],
    liabilities: [] as Liability[],
    otherAssets: [] as OtherAsset[],
    fi,
    monthlyNeedsCents: 300_000,
    monthlyWantsCents: 150_000,
    monthlySavingsCents: 200_000,
  };

  it('does not report "done" when no match has been recorded at all', () => {
    // A workplace account with contributions but no match figure entered:
    // there is nothing to check, so calling it done would bless the most
    // expensive mistake on the list.
    const plan = buildGuidancePlan({
      ...base,
      accounts: [account({ id: '401k', kind: '401k', monthlyContributionCents: 150_000 })],
    });

    const step = plan.steps.find((s) => s.id === 'employer-match')!;
    expect(step.status).toBe('todo');
    expect(step.detail).toContain('No employer match recorded');
  });

  it('reports done only once a recorded match is fully captured', () => {
    const plan = buildGuidancePlan({
      ...base,
      accounts: [
        account({
          id: '401k',
          kind: '401k',
          monthlyContributionCents: 150_000,
          employerMatchCents: 50_000,
        }),
      ],
    });

    expect(plan.steps.find((s) => s.id === 'employer-match')!.status).toBe('done');
  });
});

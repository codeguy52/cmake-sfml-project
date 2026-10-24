import { describe, expect, it } from 'vitest';
import {
  analyzeAccess,
  analyzeConcentration,
  analyzePortfolio,
  PENALTY_FREE_AGE,
  unknownFeeShareBps,
} from './analysis';
import { summarizePortfolio } from './investments';
import type { FISettings, Holding, InvestmentAccount } from '../types';

const fi = (over: Partial<FISettings> = {}): FISettings => ({
  safeWithdrawalRateBps: 400,
  expectedReturnBps: 700,
  inflationBps: 300,
  annualSpendingOverrideCents: null,
  currentAge: 30,
  targetRetirementAge: 50,
  ...over,
});

const holding = (symbol: string, valueCents: number, over: Partial<Holding> = {}): Holding => ({
  id: `h-${symbol}`,
  symbol,
  name: symbol,
  assetClass: 'us_stock',
  shares: 1,
  priceCents: valueCents,
  costBasisCents: valueCents,
  ...over,
});

const account = (
  name: string,
  kind: InvestmentAccount['kind'],
  holdings: Holding[],
  over: Partial<InvestmentAccount> = {},
): InvestmentAccount => ({
  id: `a-${name}`,
  name,
  kind,
  taxTreatment: kind === 'taxable' || kind === 'cash' ? 'taxable' : 'pretax',
  holdings,
  monthlyContributionCents: 0,
  ...over,
});

describe('reaching money before 59½', () => {
  const spending = 4_000_000; // $40,000 a year

  it('counts the years between retiring and 59½', () => {
    const access = analyzeAccess([], fi({ targetRetirementAge: 50 }), spending);
    expect(access.bridgeYears).toBe(Math.ceil(PENALTY_FREE_AGE - 50));
    expect(access.bridgeNeedCents).toBe(spending * access.bridgeYears);
  });

  it('has no bridge to build when retiring after 59½', () => {
    const access = analyzeAccess([], fi({ targetRetirementAge: 65 }), spending);
    expect(access.bridgeYears).toBe(0);
    expect(access.shortfallCents).toBe(0);
  });

  it('treats taxable and cash as reachable and retirement accounts as not', () => {
    const accounts = [
      account('Brokerage', 'taxable', [holding('VTI', 10_000_00)]),
      account('Savings', 'cash', [holding('$CASH', 5_000_00)]),
      account('401k', '401k', [holding('FXAIX', 80_000_00)]),
      account('Roth', 'roth_ira', [holding('VOO', 20_000_00)]),
    ];
    const access = analyzeAccess(accounts, fi(), spending);
    expect(access.reachableCents).toBe(15_000_00);
    expect(access.lockedCents).toBe(100_000_00);
  });

  it('does not count a Roth balance as reachable', () => {
    // Roth *contributions* are withdrawable, but this app does not track
    // basis apart from growth. Overstating the bridge is the one direction
    // this error must not go.
    const accounts = [account('Roth', 'roth_ira', [holding('VOO', 50_000_00)])];
    expect(analyzeAccess(accounts, fi(), spending).reachableCents).toBe(0);
  });

  it('reports a shortfall when the reachable pot cannot cover the bridge', () => {
    const accounts = [
      account('Brokerage', 'taxable', [holding('VTI', 50_000_00)]),
      account('401k', '401k', [holding('FXAIX', 500_000_00)]),
    ];
    const access = analyzeAccess(accounts, fi({ targetRetirementAge: 45 }), spending);
    // 15 years x $40k = $600k needed, $50k reachable.
    expect(access.bridgeYears).toBe(15);
    expect(access.shortfallCents).toBe(600_000_00 - 50_000_00);
  });

  it('reports no shortfall once the reachable pot covers it', () => {
    const accounts = [account('Brokerage', 'taxable', [holding('VTI', 1_000_000_00)])];
    expect(analyzeAccess(accounts, fi(), spending).shortfallCents).toBe(0);
  });

  it('says nothing about a bridge when no target age is set', () => {
    const access = analyzeAccess([], fi({ targetRetirementAge: null }), spending);
    expect(access.bridgeYears).toBe(0);
  });
});

describe('concentration', () => {
  it('counts the same ticker in two accounts as one bet', () => {
    const accounts = [
      account('401k', '401k', [holding('VTI', 60_000_00)]),
      account('IRA', 'ira', [holding('VTI', 20_000_00)]),
      account('Brokerage', 'taxable', [holding('BND', 20_000_00)]),
    ];
    const c = analyzeConcentration(accounts);
    expect(c.distinctSymbols).toBe(2);
    expect(c.largestLabel).toBe('VTI');
    expect(c.largestShareBps).toBe(8_000);
  });

  it('is zero on an empty portfolio rather than dividing by zero', () => {
    const c = analyzeConcentration([]);
    expect(c.largestShareBps).toBe(0);
    expect(c.distinctSymbols).toBe(0);
  });

  it('adds the five largest together', () => {
    const accounts = [
      account('B', 'taxable', [
        holding('A', 30_00),
        holding('B', 25_00),
        holding('C', 20_00),
        holding('D', 15_00),
        holding('E', 5_00),
        holding('F', 5_00),
      ]),
    ];
    expect(analyzeConcentration(accounts).topFiveShareBps).toBe(9_500);
  });
});

describe('fees that were never recorded', () => {
  it('reports the share with no expense ratio', () => {
    const accounts = [
      account('B', 'taxable', [
        holding('VTI', 75_00, { expenseRatioBps: 3 }),
        holding('MYSTERY', 25_00),
      ]),
    ];
    expect(unknownFeeShareBps(accounts)).toBe(2_500);
  });

  it('is zero when every holding has one', () => {
    const accounts = [account('B', 'taxable', [holding('VTI', 100_00, { expenseRatioBps: 3 })])];
    expect(unknownFeeShareBps(accounts)).toBe(0);
  });
});

describe('findings', () => {
  const analyse = (accounts: InvestmentAccount[], settings = fi(), spending = 4_000_000) =>
    analyzePortfolio(accounts, summarizePortfolio(accounts), settings, spending);

  it('says nothing at all about an empty portfolio', () => {
    expect(analyse([]).findings).toEqual([]);
  });

  it('flags a single position holding a quarter of the portfolio', () => {
    const accounts = [
      account('B', 'taxable', [holding('ACME', 60_000_00), holding('VTI', 40_000_00)]),
    ];
    const finding = analyse(accounts).findings.find((f) => f.id === 'concentration');
    expect(finding?.title).toContain('ACME');
    expect(finding?.title).toContain('60.0%');
  });

  it('leaves a well-spread portfolio alone', () => {
    const accounts = [
      account('B', 'taxable', [
        holding('A', 20_000_00),
        holding('B', 20_000_00),
        holding('C', 20_000_00),
        holding('D', 20_000_00),
        holding('E', 20_000_00),
      ]),
    ];
    expect(analyse(accounts).findings.some((f) => f.id === 'concentration')).toBe(false);
  });

  it('flags cash left sitting in an investment account', () => {
    const accounts = [
      account('B', 'taxable', [
        holding('$CASH', 30_000_00, { assetClass: 'cash' }),
        holding('VTI', 70_000_00),
      ]),
    ];
    expect(analyse(accounts).findings.some((f) => f.id === 'cash')).toBe(true);
  });

  it('puts the worst finding first', () => {
    const accounts = [
      account('401k', '401k', [holding('ACME', 100_000_00, { expenseRatioBps: 120 })]),
    ];
    const { findings } = analyse(accounts, fi({ targetRetirementAge: 45 }));
    expect(findings.length).toBeGreaterThan(1);
    expect(findings[0]!.severity).toBe('serious');
  });

  it('quotes the number that triggered each finding', () => {
    // A finding the reader cannot check is one they have to take on trust.
    const accounts = [
      account('401k', '401k', [holding('ACME', 100_000_00, { expenseRatioBps: 120 })]),
    ];
    for (const finding of analyse(accounts).findings) {
      expect(finding.title).toMatch(/[\d]/);
    }
  });

  it('never tells anyone what to buy', () => {
    const accounts = [
      account('401k', '401k', [holding('ACME', 100_000_00, { expenseRatioBps: 120 })]),
    ];
    const text = analyse(accounts)
      .findings.map((f) => `${f.title} ${f.detail}`)
      .join(' ')
      .toLowerCase();
    for (const word of ['you should buy', 'we recommend', 'switch to', 'sell your']) {
      expect(text).not.toContain(word);
    }
  });
});

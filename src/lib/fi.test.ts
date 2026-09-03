import { describe, expect, it } from 'vitest';
import type { FISettings } from '../types';
import {
  coastFINumber,
  computeFIStatus,
  fiNumber,
  monthlyRate,
  projectToFI,
  realAnnualRate,
  savingsRate,
  withdrawalRateSensitivity,
  yearsToFIFromSavingsRate,
} from './fi';

const settings: FISettings = {
  safeWithdrawalRateBps: 400,
  expectedReturnBps: 700,
  inflationBps: 300,
  annualSpendingOverrideCents: null,
  currentAge: 30,
  targetRetirementAge: 65,
};

describe('realAnnualRate', () => {
  it('discounts the nominal return by inflation rather than subtracting it', () => {
    // (1.07 / 1.03) - 1 = 0.038835..., not 0.04
    expect(realAnnualRate(700, 300)).toBeCloseTo(0.0388349, 6);
  });

  it('is zero when returns only keep pace with inflation', () => {
    expect(realAnnualRate(300, 300)).toBeCloseTo(0, 10);
  });
});

describe('monthlyRate', () => {
  it('compounds to the annual rate over twelve months', () => {
    const rm = monthlyRate(0.07);
    expect(Math.pow(1 + rm, 12) - 1).toBeCloseTo(0.07, 10);
  });

  it('handles a zero rate', () => {
    expect(monthlyRate(0)).toBe(0);
  });
});

describe('fiNumber', () => {
  it('is 25x annual spending at a 4% withdrawal rate', () => {
    expect(fiNumber(4_000_000, 400)).toBe(100_000_000); // $40k/yr -> $1M
  });

  it('is 33.3x at 3%', () => {
    expect(fiNumber(4_000_000, 300)).toBe(133_333_333);
  });

  it('returns zero rather than dividing by zero', () => {
    expect(fiNumber(4_000_000, 0)).toBe(0);
  });
});

describe('projectToFI', () => {
  it('reports zero months when the target is already met', () => {
    const p = projectToFI({
      startingBalanceCents: 100_000_000,
      monthlyContributionCents: 0,
      annualRealRate: 0.04,
      targetCents: 100_000_000,
    });
    expect(p.monthsToFI).toBe(0);
    expect(p.yearsToFI).toBe(0);
  });

  it('matches a closed-form annuity for a simple case', () => {
    // $1,000/month at 6% real for 10 years, contributions at month end.
    const rm = monthlyRate(0.06);
    const expected = 100_000 * ((Math.pow(1 + rm, 120) - 1) / rm);

    const p = projectToFI({
      startingBalanceCents: 0,
      monthlyContributionCents: 100_000,
      annualRealRate: 0.06,
      targetCents: Number.MAX_SAFE_INTEGER,
      horizonMonths: 120,
    });

    const final = p.points[p.points.length - 1]!;
    expect(final.balanceCents).toBeCloseTo(expected, -2);
    expect(final.year).toBe(10);
  });

  it('separates contributions from compounding', () => {
    const p = projectToFI({
      startingBalanceCents: 1_000_000,
      monthlyContributionCents: 100_000,
      annualRealRate: 0.05,
      targetCents: Number.MAX_SAFE_INTEGER,
      horizonMonths: 60,
    });

    const final = p.points[p.points.length - 1]!;
    expect(final.contributedCents).toBe(100_000 * 60);
    // balance = starting + contributions + growth, by construction.
    expect(final.balanceCents).toBe(
      1_000_000 + final.contributedCents + final.growthCents,
    );
    expect(final.growthCents).toBeGreaterThan(0);
  });

  it('never reaches the target with no contributions and no growth', () => {
    const p = projectToFI({
      startingBalanceCents: 10_000,
      monthlyContributionCents: 0,
      annualRealRate: 0,
      targetCents: 100_000_000,
    });
    expect(p.monthsToFI).toBeNull();
    expect(p.yearsToFI).toBeNull();
    expect(p.fiDate).toBeNull();
  });

  it('still reaches a target on contributions alone at a zero real return', () => {
    const p = projectToFI({
      startingBalanceCents: 0,
      monthlyContributionCents: 100_000,
      annualRealRate: 0,
      targetCents: 1_200_000,
    });
    expect(p.monthsToFI).toBe(12);
  });

  it('reports the age at FI when a current age is given', () => {
    const p = projectToFI({
      startingBalanceCents: 0,
      monthlyContributionCents: 100_000,
      annualRealRate: 0,
      targetCents: 1_200_000,
      currentAge: 40,
    });
    expect(p.ageAtFI).toBe(41);
  });
});

describe('coastFINumber', () => {
  it('discounts the target back over the years remaining', () => {
    // $1M in 10 years at 5% real needs ~$613,913 today.
    expect(coastFINumber(100_000_000, 0.05, 10)).toBe(61_391_325);
  });

  it('equals the target when the horizon has run out', () => {
    expect(coastFINumber(100_000_000, 0.05, 0)).toBe(100_000_000);
    expect(coastFINumber(100_000_000, 0.05, -3)).toBe(100_000_000);
  });
});

describe('savingsRate', () => {
  it('measures what is left after needs and wants', () => {
    const r = savingsRate(500_000, 350_000);
    expect(r.savedCents).toBe(150_000);
    expect(r.rateBps).toBe(3000);
  });

  it('goes negative when spending exceeds income', () => {
    expect(savingsRate(100_000, 150_000).rateBps).toBe(-5000);
  });

  it('reports zero rather than dividing by zero income', () => {
    expect(savingsRate(0, 0).rateBps).toBe(0);
  });
});

describe('yearsToFIFromSavingsRate', () => {
  it('is independent of income and falls as the rate rises', () => {
    const at10 = yearsToFIFromSavingsRate(1000, 0.05, 400)!;
    const at50 = yearsToFIFromSavingsRate(5000, 0.05, 400)!;
    const at75 = yearsToFIFromSavingsRate(7500, 0.05, 400)!;

    expect(at10).toBeGreaterThan(at50);
    expect(at50).toBeGreaterThan(at75);
    // The familiar figures: ~50% saved is roughly 17 years, ~75% roughly 7.
    expect(at50).toBeGreaterThan(14);
    expect(at50).toBeLessThan(20);
    expect(at75).toBeLessThan(10);
  });

  it('is immediate at a 100% savings rate and never at 0%', () => {
    expect(yearsToFIFromSavingsRate(10_000, 0.05, 400)).toBe(0);
    expect(yearsToFIFromSavingsRate(0, 0.05, 400)).toBeNull();
  });
});

describe('computeFIStatus', () => {
  it('derives annual spending from the budget by default', () => {
    const status = computeFIStatus({
      settings,
      monthlyFundedSpendingCents: 300_000, // $3,000/mo -> $36,000/yr
      monthlyIncomeCents: 500_000,
      fiAssetsCents: 20_000_000, // $200,000
      monthlyContributionCents: 200_000,
    });

    expect(status.annualSpendingCents).toBe(3_600_000);
    expect(status.fiNumberCents).toBe(90_000_000); // 25x
    expect(status.progressBps).toBe(2222); // 22.22%
    expect(status.savings.rateBps).toBe(4000);
    expect(status.projection.yearsToFI).toBeGreaterThan(0);
  });

  it('honours an explicit spending override', () => {
    const status = computeFIStatus({
      settings: { ...settings, annualSpendingOverrideCents: 6_000_000 },
      monthlyFundedSpendingCents: 300_000,
      monthlyIncomeCents: 500_000,
      fiAssetsCents: 0,
      monthlyContributionCents: 100_000,
    });

    expect(status.annualSpendingCents).toBe(6_000_000);
    expect(status.fiNumberCents).toBe(150_000_000);
  });

  it('reports the share of spending the portfolio already covers', () => {
    const status = computeFIStatus({
      settings,
      monthlyFundedSpendingCents: 300_000,
      monthlyIncomeCents: 500_000,
      fiAssetsCents: 90_000_000, // exactly the FI number
      monthlyContributionCents: 0,
    });

    expect(status.currentMonthlyPassiveIncomeCents).toBe(300_000);
    expect(status.coverageBps).toBe(10_000); // 100% covered
    expect(status.projection.monthsToFI).toBe(0);
  });

  it('marks Coast FI as reached once the portfolio can get there alone', () => {
    const status = computeFIStatus({
      settings,
      monthlyFundedSpendingCents: 300_000,
      monthlyIncomeCents: 500_000,
      fiAssetsCents: 40_000_000,
      monthlyContributionCents: 0,
    });

    // 35 years of ~3.88% real growth on $400k clears a $900k target.
    expect(status.coastFINumberCents).not.toBeNull();
    expect(status.coastFIReached).toBe(true);
  });

  it('leaves Coast FI unavailable when no age is set', () => {
    const status = computeFIStatus({
      settings: { ...settings, currentAge: null },
      monthlyFundedSpendingCents: 300_000,
      monthlyIncomeCents: 500_000,
      fiAssetsCents: 1_000_000,
      monthlyContributionCents: 100_000,
    });

    expect(status.coastFINumberCents).toBeNull();
    expect(status.coastFIReached).toBe(false);
  });
});

describe('withdrawalRateSensitivity', () => {
  it('shows a lower rate as a larger target', () => {
    const rows = withdrawalRateSensitivity(4_000_000, 50_000_000, [300, 400]);
    expect(rows[0]!.fiNumberCents).toBeGreaterThan(rows[1]!.fiNumberCents);
    expect(rows[0]!.progressBps).toBeLessThan(rows[1]!.progressBps);
  });
});

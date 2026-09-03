import type { Cents, FISettings } from '../types';
import { BPS_SCALE, roundCents, toBps } from './money';

/**
 * Financial-independence math.
 *
 * Everything here is expressed in *today's dollars*. Rather than inflating the
 * spending target each year, we deflate the return: a 7% nominal return with 3%
 * inflation is treated as a ~3.88% real return, and the FI number stays put.
 * That keeps every figure on screen comparable to what things cost right now,
 * which is the only frame a person can actually reason about.
 */

const MAX_PROJECTION_MONTHS = 1200; // 100 years — beyond this, call it unreachable.

/** Convert nominal and inflation bp into a single real annual rate. */
export function realAnnualRate(expectedReturnBps: number, inflationBps: number): number {
  const nominal = expectedReturnBps / BPS_SCALE;
  const inflation = inflationBps / BPS_SCALE;
  return (1 + nominal) / (1 + inflation) - 1;
}

/** The equivalent monthly rate for an annual rate, compounded monthly. */
export function monthlyRate(annualRate: number): number {
  if (annualRate <= -1) return -1;
  return Math.pow(1 + annualRate, 1 / 12) - 1;
}

/**
 * The portfolio that sustains `annualSpendingCents` at the configured
 * withdrawal rate. At 4% this is the familiar 25x annual spending.
 */
export function fiNumber(annualSpendingCents: Cents, safeWithdrawalRateBps: number): Cents {
  if (safeWithdrawalRateBps <= 0) return 0;
  return roundCents((annualSpendingCents * BPS_SCALE) / safeWithdrawalRateBps);
}

export interface ProjectionPoint {
  month: number;
  /** Calendar year offset, for axis labels. */
  year: number;
  balanceCents: Cents;
  /** Contributions made so far, excluding the starting balance. */
  contributedCents: Cents;
  /** Balance minus starting balance minus contributions — i.e. compounding. */
  growthCents: Cents;
}

export interface FIProjection {
  points: ProjectionPoint[];
  /** Months until the balance first reaches the target, or null if it never does
   *  within the projection horizon. */
  monthsToFI: number | null;
  yearsToFI: number | null;
  /** Calendar date of FI, or null. */
  fiDate: Date | null;
  /** Age at FI, when a current age is configured. */
  ageAtFI: number | null;
}

/**
 * Project a portfolio forward month by month.
 *
 * Contributions are applied at the end of each month (ordinary annuity), which
 * is the conservative reading and matches how a paycheck deferral actually
 * lands. Iterating rather than using a closed-form annuity keeps zero and
 * negative real returns well-behaved and gives us the series for the chart for
 * free.
 */
export function projectToFI(params: {
  startingBalanceCents: Cents;
  monthlyContributionCents: Cents;
  annualRealRate: number;
  targetCents: Cents;
  horizonMonths?: number;
  currentAge?: number | null;
  startDate?: Date;
}): FIProjection {
  const {
    startingBalanceCents,
    monthlyContributionCents,
    annualRealRate,
    targetCents,
    currentAge = null,
    startDate = new Date(),
  } = params;

  const rm = monthlyRate(annualRealRate);
  const horizon = Math.min(params.horizonMonths ?? MAX_PROJECTION_MONTHS, MAX_PROJECTION_MONTHS);

  let balance = startingBalanceCents;
  let contributed = 0;
  let monthsToFI: number | null = balance >= targetCents && targetCents > 0 ? 0 : null;

  const points: ProjectionPoint[] = [
    {
      month: 0,
      year: 0,
      balanceCents: balance,
      contributedCents: 0,
      growthCents: 0,
    },
  ];

  for (let m = 1; m <= horizon; m++) {
    balance = balance * (1 + rm) + monthlyContributionCents;
    contributed += monthlyContributionCents;

    // Record yearly, so a 50-year projection is 50 points and not 600.
    if (m % 12 === 0) {
      const rounded = roundCents(balance);
      points.push({
        month: m,
        year: m / 12,
        balanceCents: rounded,
        contributedCents: contributed,
        growthCents: rounded - startingBalanceCents - contributed,
      });
    }

    if (monthsToFI === null && targetCents > 0 && balance >= targetCents) {
      monthsToFI = m;
      // Keep projecting to the horizon so the chart still shows the curve
      // past the crossing point.
    }

    // A shrinking balance with no contributions will never reach the target.
    if (balance <= 0 && monthlyContributionCents <= 0) break;
  }

  const fiDate =
    monthsToFI === null
      ? null
      : new Date(startDate.getFullYear(), startDate.getMonth() + monthsToFI, startDate.getDate());

  return {
    points,
    monthsToFI,
    yearsToFI: monthsToFI === null ? null : monthsToFI / 12,
    fiDate,
    ageAtFI:
      monthsToFI === null || currentAge === null
        ? null
        : Math.round((currentAge + monthsToFI / 12) * 10) / 10,
  };
}

/**
 * Coast FI: the balance that, with **no further contributions**, grows to the
 * FI number by the target retirement age. Crossing it means your existing
 * portfolio has already bought that retirement — everything you earn after is
 * only buying an earlier one.
 */
export function coastFINumber(
  targetCents: Cents,
  annualRealRate: number,
  yearsUntilTarget: number,
): Cents | null {
  if (yearsUntilTarget <= 0) return targetCents;
  const growth = Math.pow(1 + annualRealRate, yearsUntilTarget);
  if (!Number.isFinite(growth) || growth <= 0) return null;
  return roundCents(targetCents / growth);
}

export interface SavingsRate {
  /** Income minus needs and wants, over income. Counts unallocated income as saved. */
  rateBps: number;
  savedCents: Cents;
  incomeCents: Cents;
}

export function savingsRate(incomeCents: Cents, fundedSpendingCents: Cents): SavingsRate {
  const saved = incomeCents - fundedSpendingCents;
  return {
    rateBps: toBps(saved, incomeCents),
    savedCents: saved,
    incomeCents,
  };
}

export interface FIStatus {
  annualSpendingCents: Cents;
  fiNumberCents: Cents;
  fiAssetsCents: Cents;
  /** Progress toward the FI number in bp; can exceed 10 000. */
  progressBps: number;
  /** What the current portfolio safely yields per month at the configured SWR. */
  currentMonthlyPassiveIncomeCents: Cents;
  /** Fraction of monthly spending already covered by the portfolio, in bp. */
  coverageBps: number;
  annualRealRate: number;
  coastFINumberCents: Cents | null;
  coastFIReached: boolean;
  projection: FIProjection;
  savings: SavingsRate;
}

/**
 * The single entry point the UI uses: everything about FI status, derived from
 * settings plus the four numbers that actually matter.
 */
export function computeFIStatus(params: {
  settings: FISettings;
  /** Budgeted needs + wants for one month, used when no override is set. */
  monthlyFundedSpendingCents: Cents;
  monthlyIncomeCents: Cents;
  fiAssetsCents: Cents;
  monthlyContributionCents: Cents;
  now?: Date;
}): FIStatus {
  const { settings, monthlyFundedSpendingCents, monthlyIncomeCents, fiAssetsCents } = params;
  const now = params.now ?? new Date();

  const annualSpending =
    settings.annualSpendingOverrideCents ?? monthlyFundedSpendingCents * 12;
  const target = fiNumber(annualSpending, settings.safeWithdrawalRateBps);
  const rate = realAnnualRate(settings.expectedReturnBps, settings.inflationBps);

  const projection = projectToFI({
    startingBalanceCents: fiAssetsCents,
    monthlyContributionCents: params.monthlyContributionCents,
    annualRealRate: rate,
    targetCents: target,
    currentAge: settings.currentAge,
    startDate: now,
  });

  const yearsUntilTarget =
    settings.currentAge !== null && settings.targetRetirementAge !== null
      ? settings.targetRetirementAge - settings.currentAge
      : null;
  const coast =
    yearsUntilTarget === null ? null : coastFINumber(target, rate, yearsUntilTarget);

  const monthlyPassive = roundCents(
    (fiAssetsCents * settings.safeWithdrawalRateBps) / BPS_SCALE / 12,
  );

  return {
    annualSpendingCents: annualSpending,
    fiNumberCents: target,
    fiAssetsCents,
    progressBps: toBps(fiAssetsCents, target),
    currentMonthlyPassiveIncomeCents: monthlyPassive,
    coverageBps: toBps(monthlyPassive, monthlyFundedSpendingCents),
    annualRealRate: rate,
    coastFINumberCents: coast,
    coastFIReached: coast !== null && fiAssetsCents >= coast,
    projection,
    savings: savingsRate(monthlyIncomeCents, monthlyFundedSpendingCents),
  };
}

/**
 * How the FI number moves with the withdrawal rate. Worth showing, because the
 * gap between a 3% and a 4% assumption is years of someone's life.
 */
export function withdrawalRateSensitivity(
  annualSpendingCents: Cents,
  fiAssetsCents: Cents,
  ratesBps: number[] = [300, 350, 400, 450, 500],
): { rateBps: number; fiNumberCents: Cents; progressBps: number }[] {
  return ratesBps.map((rateBps) => {
    const target = fiNumber(annualSpendingCents, rateBps);
    return { rateBps, fiNumberCents: target, progressBps: toBps(fiAssetsCents, target) };
  });
}

/**
 * Years to FI from a savings rate alone, starting from zero — the classic
 * "shockingly simple math" table. Independent of income, which is the point.
 */
export function yearsToFIFromSavingsRate(
  savingsRateBps: number,
  annualRealRate: number,
  safeWithdrawalRateBps: number,
): number | null {
  if (savingsRateBps <= 0) return null;
  if (savingsRateBps >= BPS_SCALE) return 0;

  const savedFraction = savingsRateBps / BPS_SCALE;
  const spendFraction = 1 - savedFraction;
  // Target as a multiple of annual income, then solved by the same monthly
  // iteration used elsewhere so the two never disagree.
  const targetMultiple = (spendFraction * BPS_SCALE) / safeWithdrawalRateBps;

  const rm = monthlyRate(annualRealRate);
  let balance = 0;
  const monthlySave = savedFraction / 12;
  for (let m = 1; m <= MAX_PROJECTION_MONTHS; m++) {
    balance = balance * (1 + rm) + monthlySave;
    if (balance >= targetMultiple) return m / 12;
  }
  return null;
}

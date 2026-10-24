import type { Bps, Cents } from '../types';
import { BPS_SCALE, roundCents } from './money';

/**
 * Earning more over a career, and what it does to financial independence.
 *
 * The projection used to assume you contribute the same amount every month
 * for thirty years, which nobody does. Two things change: raises, which arrive
 * steadily, and job moves, which arrive as steps. Both matter enormously over
 * a long horizon — and so does the part people forget, which is that a raise
 * you spend moves the finish line as well as the runner.
 *
 * That last point is why this models income, contributions *and* spending
 * rather than just letting you type a bigger contribution. If a pay rise lifts
 * your lifestyle, your FI number rises with it: the target is a multiple of
 * what you spend, so spending more permanently means needing more invested,
 * forever. A model that only grew the contributions would flatter every raise.
 */

export interface CareerStep {
  id: string;
  /** Whole years from now when this salary takes effect. */
  atYear: number;
  /** Take-home pay at that point, a year, in today's dollars. */
  annualTakeHomeCents: Cents;
  /** Free text — "senior role", "switch to Acme". */
  label: string;
}

export interface CareerPlan {
  /** Whether to project career growth at all. Off means a flat projection. */
  enabled: boolean;
  /** The raise an employer would quote, before inflation is taken out. */
  nominalRaiseBps: Bps;
  /** Years between those raises. Usually 1; some places move on a longer cycle. */
  raiseEveryYears: number;
  /** Planned moves, each resetting pay to a new level. */
  steps: CareerStep[];
  /**
   * Share of every *extra* take-home dollar that gets invested rather than
   * spent. The rest raises your standard of living — and your FI number.
   */
  marginalSavingsBps: Bps;
}

export const DEFAULT_CAREER: CareerPlan = {
  enabled: false,
  // Roughly what a typical annual review is quoted at. Deliberately modest:
  // this number compounds over decades and optimism here is expensive.
  nominalRaiseBps: 300,
  raiseEveryYears: 1,
  steps: [],
  // Half of each raise invested, half enjoyed. A defensible middle rather
  // than a flattering assumption.
  marginalSavingsBps: 5_000,
};

/**
 * The raise that actually buys anything, once inflation is removed.
 *
 * Everything in this app is in today's dollars, so a 3% raise against 3%
 * inflation is no raise at all. Users think in the number their employer
 * quotes, so the nominal figure is what they type and this is what gets used.
 */
export function realRaiseRate(plan: CareerPlan, inflationBps: Bps): number {
  const nominal = plan.nominalRaiseBps / BPS_SCALE;
  const inflation = inflationBps / BPS_SCALE;
  const perCycle = (1 + nominal) / (1 + inflation) - 1;
  const years = Math.max(1, plan.raiseEveryYears);
  // Spread a multi-year cycle across its years so the curve is smooth rather
  // than a staircase nobody's pay actually follows.
  return Math.pow(1 + perCycle, 1 / years) - 1;
}

/** Steps in order, ignoring any at or before today. */
export function orderedSteps(plan: CareerPlan): CareerStep[] {
  return [...plan.steps].filter((s) => s.atYear > 0).sort((a, b) => a.atYear - b.atYear);
}

/**
 * Take-home pay a given number of years out, in today's dollars.
 *
 * A step resets pay to the level entered for it; raises then compound from
 * that step rather than from today, which is how a promotion actually works.
 */
export function takeHomeAtYear(
  plan: CareerPlan,
  baseAnnualTakeHomeCents: Cents,
  yearsFromNow: number,
  inflationBps: Bps,
): Cents {
  if (!plan.enabled) return baseAnnualTakeHomeCents;

  const rate = realRaiseRate(plan, inflationBps);
  const steps = orderedSteps(plan);

  let anchorYear = 0;
  let anchorPay = baseAnnualTakeHomeCents;
  for (const step of steps) {
    if (step.atYear <= yearsFromNow) {
      anchorYear = step.atYear;
      anchorPay = step.annualTakeHomeCents;
    }
  }

  return roundCents(anchorPay * Math.pow(1 + rate, yearsFromNow - anchorYear));
}

export interface CareerPaths {
  /** Monthly amount invested, at a given month from now. */
  monthlyContributionAt: (month: number) => Cents;
  /** Annual spending, at a given month from now. */
  annualSpendingAt: (month: number) => Cents;
  /** The FI target, which moves with spending. */
  targetAt: (month: number) => Cents;
}

/**
 * Turn a career plan into the three schedules the projection needs.
 *
 * Extra income splits by the marginal savings rate: part raises contributions,
 * the rest raises spending. Spending raises the target, because the target is
 * a multiple of spending. Pay that falls below today's — possible if someone
 * plans a step down — reduces both, symmetrically.
 */
export function careerPaths(params: {
  plan: CareerPlan;
  baseAnnualTakeHomeCents: Cents;
  baseMonthlyContributionCents: Cents;
  baseAnnualSpendingCents: Cents;
  safeWithdrawalRateBps: Bps;
  inflationBps: Bps;
}): CareerPaths {
  const {
    plan,
    baseAnnualTakeHomeCents,
    baseMonthlyContributionCents,
    baseAnnualSpendingCents,
    safeWithdrawalRateBps,
    inflationBps,
  } = params;

  const multiple = safeWithdrawalRateBps > 0 ? BPS_SCALE / safeWithdrawalRateBps : 0;
  const invested = plan.marginalSavingsBps / BPS_SCALE;

  const extraAnnualAt = (month: number): Cents => {
    if (!plan.enabled) return 0;
    const pay = takeHomeAtYear(plan, baseAnnualTakeHomeCents, month / 12, inflationBps);
    return pay - baseAnnualTakeHomeCents;
  };

  const annualSpendingAt = (month: number): Cents => {
    const extra = extraAnnualAt(month);
    return roundCents(baseAnnualSpendingCents + extra * (1 - invested));
  };

  return {
    monthlyContributionAt: (month) =>
      roundCents(baseMonthlyContributionCents + (extraAnnualAt(month) * invested) / 12),
    annualSpendingAt,
    targetAt: (month) => roundCents(annualSpendingAt(month) * multiple),
  };
}

export interface CareerPoint {
  year: number;
  takeHomeCents: Cents;
  annualContributionCents: Cents;
  annualSpendingCents: Cents;
}

/** Year-by-year income, for charting the path the numbers came from. */
export function careerCurve(
  params: Parameters<typeof careerPaths>[0] & { years: number },
): CareerPoint[] {
  const paths = careerPaths(params);
  const points: CareerPoint[] = [];

  for (let year = 0; year <= params.years; year++) {
    const month = year * 12;
    points.push({
      year,
      takeHomeCents: takeHomeAtYear(
        params.plan,
        params.baseAnnualTakeHomeCents,
        year,
        params.inflationBps,
      ),
      annualContributionCents: roundCents(paths.monthlyContributionAt(month) * 12),
      annualSpendingCents: paths.annualSpendingAt(month),
    });
  }

  return points;
}

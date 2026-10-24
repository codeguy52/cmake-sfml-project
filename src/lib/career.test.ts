import { describe, expect, it } from 'vitest';
import {
  careerCurve,
  careerPaths,
  DEFAULT_CAREER,
  orderedSteps,
  realRaiseRate,
  takeHomeAtYear,
  type CareerPlan,
} from './career';
import { projectToFI, realAnnualRate } from './fi';

const plan = (over: Partial<CareerPlan> = {}): CareerPlan => ({
  ...DEFAULT_CAREER,
  enabled: true,
  ...over,
});

const TAKE_HOME = 6_000_000; // $60,000 a year
const SPENDING = 4_000_000; // $40,000 a year
const CONTRIBUTION = 150_000; // $1,500 a month

describe('a raise that beats inflation', () => {
  it('is the nominal raise with inflation taken out', () => {
    // 5% quoted against 3% inflation is not a 5% rise in what you can buy.
    const rate = realRaiseRate(plan({ nominalRaiseBps: 500 }), 300);
    expect(rate).toBeCloseTo(1.05 / 1.03 - 1, 6);
  });

  it('is zero when the raise only matches inflation', () => {
    expect(realRaiseRate(plan({ nominalRaiseBps: 300 }), 300)).toBeCloseTo(0, 9);
  });

  it('is negative when the raise lags inflation', () => {
    expect(realRaiseRate(plan({ nominalRaiseBps: 100 }), 400)).toBeLessThan(0);
  });

  it('spreads a multi-year cycle over its years', () => {
    const everyThree = plan({ nominalRaiseBps: 900, raiseEveryYears: 3 });
    const perYear = realRaiseRate(everyThree, 0);
    // Compounding the annual figure three times returns the cycle's raise.
    expect(Math.pow(1 + perYear, 3) - 1).toBeCloseTo(0.09, 6);
  });
});

describe('pay over time', () => {
  it('is today\'s pay when career growth is switched off', () => {
    const off = plan({ enabled: false, nominalRaiseBps: 1_000 });
    expect(takeHomeAtYear(off, TAKE_HOME, 20, 300)).toBe(TAKE_HOME);
  });

  it('compounds raises from today when there are no steps', () => {
    const p = plan({ nominalRaiseBps: 400 });
    const rate = realRaiseRate(p, 200);
    expect(takeHomeAtYear(p, TAKE_HOME, 10, 200)).toBe(
      Math.round(TAKE_HOME * Math.pow(1 + rate, 10)),
    );
  });

  it('resets pay at a job switch', () => {
    const p = plan({
      nominalRaiseBps: 300,
      steps: [{ id: 's1', atYear: 5, annualTakeHomeCents: 9_000_000, label: 'New job' }],
    });
    expect(takeHomeAtYear(p, TAKE_HOME, 5, 300)).toBe(9_000_000);
  });

  it('compounds raises from the switch, not from today', () => {
    const p = plan({
      nominalRaiseBps: 500,
      steps: [{ id: 's1', atYear: 5, annualTakeHomeCents: 9_000_000, label: 'New job' }],
    });
    const rate = realRaiseRate(p, 0);
    // Two years after the step: the step's salary grown twice, not today's
    // salary grown seven times.
    expect(takeHomeAtYear(p, TAKE_HOME, 7, 0)).toBe(
      Math.round(9_000_000 * Math.pow(1 + rate, 2)),
    );
  });

  it('uses the latest step reached, with several planned', () => {
    const p = plan({
      nominalRaiseBps: 0,
      steps: [
        { id: 'b', atYear: 10, annualTakeHomeCents: 12_000_000, label: 'Second' },
        { id: 'a', atYear: 4, annualTakeHomeCents: 8_000_000, label: 'First' },
      ],
    });
    expect(takeHomeAtYear(p, TAKE_HOME, 2, 0)).toBe(TAKE_HOME);
    expect(takeHomeAtYear(p, TAKE_HOME, 6, 0)).toBe(8_000_000);
    expect(takeHomeAtYear(p, TAKE_HOME, 12, 0)).toBe(12_000_000);
  });

  it('orders steps and ignores any at or before today', () => {
    const p = plan({
      steps: [
        { id: 'b', atYear: 7, annualTakeHomeCents: 1, label: '' },
        { id: 'past', atYear: 0, annualTakeHomeCents: 1, label: '' },
        { id: 'a', atYear: 2, annualTakeHomeCents: 1, label: '' },
      ],
    });
    expect(orderedSteps(p).map((s) => s.atYear)).toEqual([2, 7]);
  });

  it('handles a planned step down in pay', () => {
    const p = plan({
      nominalRaiseBps: 0,
      steps: [{ id: 's', atYear: 3, annualTakeHomeCents: 3_000_000, label: 'Part time' }],
    });
    expect(takeHomeAtYear(p, TAKE_HOME, 4, 0)).toBe(3_000_000);
  });
});

describe('where the extra money goes', () => {
  const build = (marginalSavingsBps: number, over: Partial<CareerPlan> = {}) =>
    careerPaths({
      plan: plan({ nominalRaiseBps: 1_030, marginalSavingsBps, ...over }),
      baseAnnualTakeHomeCents: TAKE_HOME,
      baseMonthlyContributionCents: CONTRIBUTION,
      baseAnnualSpendingCents: SPENDING,
      safeWithdrawalRateBps: 400,
      inflationBps: 300,
    });

  it('invests every extra dollar at 100%, leaving spending flat', () => {
    const paths = build(10_000);
    expect(paths.monthlyContributionAt(12)).toBeGreaterThan(CONTRIBUTION);
    expect(paths.annualSpendingAt(12)).toBe(SPENDING);
    // A target that does not move is the point of not spending the raise.
    expect(paths.targetAt(12)).toBe(SPENDING * 25);
  });

  it('spends every extra dollar at 0%, moving the finish line', () => {
    const paths = build(0);
    expect(paths.monthlyContributionAt(12)).toBe(CONTRIBUTION);
    expect(paths.annualSpendingAt(12)).toBeGreaterThan(SPENDING);
    // The FI number is a multiple of spending, so lifestyle creep pushes it
    // away even while the balance climbs.
    expect(paths.targetAt(12)).toBeGreaterThan(SPENDING * 25);
  });

  it('splits the difference in between', () => {
    const half = build(5_000);
    expect(half.monthlyContributionAt(12)).toBeGreaterThan(CONTRIBUTION);
    expect(half.annualSpendingAt(12)).toBeGreaterThan(SPENDING);
    expect(half.annualSpendingAt(12)).toBeLessThan(build(0).annualSpendingAt(12));
  });

  it('changes nothing at all when the plan is off', () => {
    const paths = careerPaths({
      plan: plan({ enabled: false, nominalRaiseBps: 1_000 }),
      baseAnnualTakeHomeCents: TAKE_HOME,
      baseMonthlyContributionCents: CONTRIBUTION,
      baseAnnualSpendingCents: SPENDING,
      safeWithdrawalRateBps: 400,
      inflationBps: 300,
    });
    expect(paths.monthlyContributionAt(240)).toBe(CONTRIBUTION);
    expect(paths.annualSpendingAt(240)).toBe(SPENDING);
  });
});

describe('what it does to the projection', () => {
  const run = (plan_: CareerPlan) => {
    const paths = careerPaths({
      plan: plan_,
      baseAnnualTakeHomeCents: TAKE_HOME,
      baseMonthlyContributionCents: CONTRIBUTION,
      baseAnnualSpendingCents: SPENDING,
      safeWithdrawalRateBps: 400,
      inflationBps: 300,
    });
    return projectToFI({
      startingBalanceCents: 10_000_000,
      monthlyContributionCents: CONTRIBUTION,
      annualRealRate: realAnnualRate(700, 300),
      targetCents: SPENDING * 25,
      monthlyContributionAt: paths.monthlyContributionAt,
      targetAtMonth: paths.targetAt,
      currentAge: 30,
    });
  };

  it('brings FI closer when raises are invested', () => {
    const flat = run(plan({ enabled: false }));
    const growing = run(plan({ nominalRaiseBps: 800, marginalSavingsBps: 10_000 }));
    expect(growing.monthsToFI).not.toBeNull();
    expect(growing.monthsToFI!).toBeLessThan(flat.monthsToFI!);
  });

  it('pushes FI away — possibly out of reach — when raises are spent', () => {
    // The uncomfortable case, and the whole reason spending is modelled.
    // Spending every raise raises the target by 25x the raise while the
    // balance only grows by what was already being saved, so the finish line
    // can genuinely outrun the runner: `null` here means never, inside the
    // projection horizon, and that is the honest answer rather than a bug.
    const flat = run(plan({ enabled: false }));
    const creeping = run(plan({ nominalRaiseBps: 800, marginalSavingsBps: 0 }));
    expect(flat.monthsToFI).not.toBeNull();
    expect(creeping.monthsToFI === null || creeping.monthsToFI > flat.monthsToFI!).toBe(true);
  });

  it('still reaches FI when only a modest raise is spent', () => {
    // A small amount of lifestyle creep delays FI rather than cancelling it.
    const flat = run(plan({ enabled: false }));
    const mild = run(plan({ nominalRaiseBps: 350, marginalSavingsBps: 0 }));
    expect(mild.monthsToFI).not.toBeNull();
    expect(mild.monthsToFI!).toBeGreaterThan(flat.monthsToFI!);
  });

  it('counts a raise-funded contribution in the contributed total', () => {
    const growing = run(plan({ nominalRaiseBps: 800, marginalSavingsBps: 10_000 }));
    const flat = run(plan({ enabled: false }));
    const at10 = (p: typeof growing) => p.points.find((pt) => pt.year === 10)!;
    expect(at10(growing).contributedCents).toBeGreaterThan(at10(flat).contributedCents);
  });

  it('leaves the flat projection untouched when no schedule is given', () => {
    const withSchedule = run(plan({ enabled: false }));
    const without = projectToFI({
      startingBalanceCents: 10_000_000,
      monthlyContributionCents: CONTRIBUTION,
      annualRealRate: realAnnualRate(700, 300),
      targetCents: SPENDING * 25,
      currentAge: 30,
    });
    expect(withSchedule.monthsToFI).toBe(without.monthsToFI);
  });
});

describe('the curve for the chart', () => {
  it('returns a point per year including today', () => {
    const points = careerCurve({
      plan: plan(),
      baseAnnualTakeHomeCents: TAKE_HOME,
      baseMonthlyContributionCents: CONTRIBUTION,
      baseAnnualSpendingCents: SPENDING,
      safeWithdrawalRateBps: 400,
      inflationBps: 300,
      years: 20,
    });
    expect(points).toHaveLength(21);
    expect(points[0]!.takeHomeCents).toBe(TAKE_HOME);
    expect(points[0]!.annualContributionCents).toBe(CONTRIBUTION * 12);
  });

  it('shows a visible step at a job switch', () => {
    const points = careerCurve({
      plan: plan({
        nominalRaiseBps: 300,
        steps: [{ id: 's', atYear: 5, annualTakeHomeCents: 9_000_000, label: 'New job' }],
      }),
      baseAnnualTakeHomeCents: TAKE_HOME,
      baseMonthlyContributionCents: CONTRIBUTION,
      baseAnnualSpendingCents: SPENDING,
      safeWithdrawalRateBps: 400,
      inflationBps: 300,
      years: 10,
    });
    expect(points[5]!.takeHomeCents).toBeGreaterThan(points[4]!.takeHomeCents * 1.3);
  });
});

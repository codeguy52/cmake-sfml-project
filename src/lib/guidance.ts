import type {
  Cents,
  FISettings,
  InvestmentAccount,
  Liability,
  OtherAsset,
} from '../types';
import { accountValue, activeAccounts, holdingValue, summarizePortfolio } from './investments';
import { BPS_SCALE, bpsToPercent } from './money';

/**
 * Where the next dollar goes.
 *
 * This is the widely-taught "order of operations" for investing, evaluated
 * against the numbers already in the app. It is education, not advice: the
 * ordering is a rule of thumb that holds for most people most of the time, and
 * the UI says so plainly.
 *
 * Two deliberate omissions:
 *
 *  - **No contribution limits are hardcoded.** They change every year, and a
 *    stale number stated confidently in a financial app is worse than no
 *    number. Steps refer to "the annual limit" and point at the IRS.
 *  - **No product or fund is ever named.** The app can say a 0.75% expense
 *    ratio costs you a specific amount per year, because that is arithmetic.
 *    It cannot tell you what to buy instead.
 */

export type StepStatus = 'done' | 'current' | 'todo' | 'not_applicable';

export interface GuidanceStep {
  id: string;
  title: string;
  /** One line on why this sits where it does in the order. */
  why: string;
  status: StepStatus;
  /** What this step looks like for *these* numbers. */
  detail: string;
  /** The amount at stake, when there is a meaningful one. */
  amountCents?: Cents;
}

export interface PortfolioObservation {
  id: string;
  severity: 'good' | 'warning' | 'serious';
  title: string;
  detail: string;
}

export interface GuidancePlan {
  steps: GuidanceStep[];
  /** First step that isn't done — the one to act on. */
  currentStepId: string | null;
  observations: PortfolioObservation[];
  cashCents: Cents;
  monthlyNeedsCents: Cents;
  monthlyEssentialCents: Cents;
  starterFundTargetCents: Cents;
  fullFundTargetCents: Cents;
  monthsOfExpensesHeld: number;
  unclaimedMatchCents: Cents;
  highRateDebtCents: Cents;
}

/** The APR above which paying debt down beats an uncertain market return. */
export function debtThresholdBps(fi: FISettings): number {
  // Compare against the *real* expected return, not the nominal one: debt
  // interest is a guaranteed nominal cost, but so is the erosion of the money
  // that would otherwise be invested, so the honest comparison uses nominal.
  // A small margin keeps genuinely borderline debt out of the "urgent" bucket.
  return fi.expectedReturnBps;
}

/**
 * Cash available as an emergency fund: whole cash/savings accounts, plus any
 * cash-class holding sitting inside an investment account.
 */
export function emergencyCashCents(
  accounts: InvestmentAccount[],
  otherAssets: OtherAsset[],
): Cents {
  let cash = 0;

  for (const account of activeAccounts(accounts)) {
    if (account.kind === 'cash') {
      cash += accountValue(account);
      continue;
    }
    for (const holding of account.holdings) {
      if (holding.assetClass === 'cash') cash += holdingValue(holding);
    }
  }

  // Other assets only count when the user has said they fund FI — a house
  // does not pay for a broken boiler.
  for (const asset of otherAssets) {
    if (asset.countTowardFI && /cash|savings|emergency|fund/i.test(asset.name)) {
      cash += asset.valueCents;
    }
  }

  return cash;
}

export function unclaimedEmployerMatch(accounts: InvestmentAccount[]): Cents {
  // A match that is configured but not being contributed against is the
  // clearest "free money left on the table" signal available here.
  return activeAccounts(accounts).reduce((sum, account) => {
    const match = account.employerMatchCents ?? 0;
    if (match === 0) return sum;
    const shortfall = match - account.monthlyContributionCents;
    return sum + Math.max(0, shortfall);
  }, 0);
}

export function highRateDebts(liabilities: Liability[], thresholdBps: number): Liability[] {
  return liabilities
    .filter((l) => l.balanceCents > 0 && l.aprBps > thresholdBps)
    .sort((a, b) => b.aprBps - a.aprBps);
}

function money(cents: Cents): string {
  // Plain formatting for embedding in sentences; the UI formats display values
  // with the user's locale separately.
  return `$${Math.round(cents / 100).toLocaleString('en-US')}`;
}

export function buildGuidancePlan(params: {
  accounts: InvestmentAccount[];
  liabilities: Liability[];
  otherAssets: OtherAsset[];
  fi: FISettings;
  monthlyNeedsCents: Cents;
  monthlyWantsCents: Cents;
  monthlySavingsCents: Cents;
}): GuidancePlan {
  const {
    accounts,
    liabilities,
    otherAssets,
    fi,
    monthlyNeedsCents,
    monthlyWantsCents,
    monthlySavingsCents,
  } = params;

  const active = activeAccounts(accounts);
  const cash = emergencyCashCents(accounts, otherAssets);
  const essential = monthlyNeedsCents + monthlyWantsCents;

  const starterTarget = monthlyNeedsCents;
  const fullTarget = monthlyNeedsCents * 3;
  const monthsHeld = essential > 0 ? cash / essential : 0;

  const threshold = debtThresholdBps(fi);
  const expensive = highRateDebts(liabilities, threshold);
  const expensiveTotal = expensive.reduce((sum, l) => sum + l.balanceCents, 0);
  const unclaimedMatch = unclaimedEmployerMatch(accounts);

  const hasHsa = active.some((a) => a.kind === 'hsa');
  const hasIra = active.some((a) => a.kind === 'ira' || a.kind === 'roth_ira');
  const hasWorkplace = active.some((a) => ['401k', '403b', 'tsp'].includes(a.kind));
  const hasTaxable = active.some((a) => a.kind === 'taxable');
  const workplaceContribution = active
    .filter((a) => ['401k', '403b', 'tsp'].includes(a.kind))
    .reduce((sum, a) => sum + a.monthlyContributionCents, 0);
  const iraContribution = active
    .filter((a) => a.kind === 'ira' || a.kind === 'roth_ira')
    .reduce((sum, a) => sum + a.monthlyContributionCents, 0);

  const steps: GuidanceStep[] = [];

  steps.push({
    id: 'starter-fund',
    title: 'Hold a starter emergency fund',
    why: 'Without one, the next unexpected bill goes on a credit card and undoes everything after it.',
    status: monthlyNeedsCents === 0 ? 'todo' : cash >= starterTarget ? 'done' : 'current',
    detail:
      monthlyNeedsCents === 0
        ? 'Set your income and needs categories on the Budget page and this fills in.'
        : cash >= starterTarget
          ? `You hold ${money(cash)} in cash — past one month of needs (${money(starterTarget)}).`
          : `You hold ${money(cash)} against a one-month target of ${money(starterTarget)}. ${money(starterTarget - cash)} to go.`,
    ...(cash < starterTarget ? { amountCents: starterTarget - cash } : {}),
  });

  // "No match recorded" is not the same as "no match missed": without the
  // figure entered, this step has nothing to check, and reporting it as done
  // would quietly bless the most expensive mistake on the list.
  const matchRecorded = active.some((a) => (a.employerMatchCents ?? 0) > 0);

  steps.push({
    id: 'employer-match',
    title: 'Contribute enough to get the full employer match',
    why: 'A match is an immediate, guaranteed return on the money — nothing else on this list competes.',
    status: !hasWorkplace
      ? 'not_applicable'
      : !matchRecorded
        ? 'todo'
        : unclaimedMatch > 0
          ? 'current'
          : 'done',
    detail: !hasWorkplace
      ? 'No workplace retirement account recorded. If your employer offers one, this jumps to the top.'
      : !matchRecorded
        ? 'No employer match recorded. If your employer offers one, enter it on the Investments page — an unclaimed match is the most expensive thing on this list to miss.'
        : unclaimedMatch > 0
          ? `You are ${money(unclaimedMatch)} a month short of your recorded match — about ${money(unclaimedMatch * 12)} a year of forgone money.`
          : 'Your contributions meet the employer match you recorded.',
    ...(unclaimedMatch > 0 ? { amountCents: unclaimedMatch } : {}),
  });

  steps.push({
    id: 'high-rate-debt',
    title: 'Clear debt costing more than the market is likely to return',
    why: `Paying off ${bpsToPercent(threshold).toFixed(1)}%+ debt is a guaranteed return at that rate. The market's is neither guaranteed nor that reliable.`,
    status: liabilities.length === 0 ? 'not_applicable' : expensive.length > 0 ? 'current' : 'done',
    detail:
      liabilities.length === 0
        ? 'No debts recorded.'
        : expensive.length > 0
          ? `${expensive.length} debt${expensive.length === 1 ? '' : 's'} above ${bpsToPercent(threshold).toFixed(1)}%: ${expensive
              .map((l) => `${l.name} at ${bpsToPercent(l.aprBps).toFixed(1)}% (${money(l.balanceCents)})`)
              .join(', ')}.`
          : `Nothing you owe costs more than your ${bpsToPercent(fi.expectedReturnBps).toFixed(1)}% expected return.`,
    ...(expensiveTotal > 0 ? { amountCents: expensiveTotal } : {}),
  });

  steps.push({
    id: 'full-fund',
    title: 'Build the emergency fund to three months',
    why: 'Three months of needs is the point where a job loss stops being a financial emergency.',
    status:
      monthlyNeedsCents === 0 ? 'todo' : cash >= fullTarget ? 'done' : cash >= starterTarget ? 'current' : 'todo',
    detail:
      monthlyNeedsCents === 0
        ? 'Needs a budget first.'
        : cash >= fullTarget
          ? `${money(cash)} covers ${monthsHeld.toFixed(1)} months of your spending.`
          : `${money(cash)} of a ${money(fullTarget)} target. Stretch to six months if your income is variable or a single earner supports others.`,
    ...(cash < fullTarget ? { amountCents: fullTarget - cash } : {}),
  });

  steps.push({
    id: 'hsa',
    title: 'Fund an HSA, if you are eligible',
    why: 'The only account taxed nowhere: deductible going in, untaxed growth, tax-free out for medical costs.',
    status: hasHsa ? 'done' : 'todo',
    detail: hasHsa
      ? 'You have an HSA recorded. Invest the balance rather than leaving it in cash if your provider allows it.'
      : 'Requires a high-deductible health plan. If you have one and no HSA, it is usually the best-treated account available.',
  });

  steps.push({
    id: 'ira',
    title: 'Fill an IRA up to the annual limit',
    why: 'Broader investment choice and usually lower fees than a workplace plan.',
    status: hasIra && iraContribution > 0 ? 'done' : hasIra ? 'current' : 'todo',
    detail: hasIra
      ? iraContribution > 0
        ? `You are contributing ${money(iraContribution)} a month. The annual limit changes yearly — check irs.gov before topping up.`
        : 'You have an IRA recorded but no monthly contribution set.'
      : 'No IRA recorded. Roth versus traditional turns on whether your tax rate is higher now or in retirement.',
  });

  steps.push({
    id: 'max-workplace',
    title: 'Increase the workplace plan beyond the match',
    why: 'Past the match it is still tax-advantaged space, just less urgent than the guaranteed money above it.',
    status: !hasWorkplace ? 'todo' : workplaceContribution > 0 ? 'current' : 'todo',
    detail: hasWorkplace
      ? `Currently ${money(workplaceContribution)} a month across your workplace accounts. Check the fees before filling it — a bad plan can be worth less than a taxable account.`
      : 'No workplace plan recorded.',
  });

  steps.push({
    id: 'taxable',
    title: 'Invest the rest in a taxable brokerage',
    why: 'No contribution cap and no withdrawal age, which is what actually funds early retirement.',
    status: hasTaxable ? 'done' : 'todo',
    detail: hasTaxable
      ? 'You have a taxable account — the bridge that covers the years before retirement accounts unlock.'
      : monthlySavingsCents > 0
        ? `Your budget sets aside ${money(monthlySavingsCents)} a month. Anything left after the steps above belongs here.`
        : 'Set a savings allocation on the Budget page to see what is available.',
  });

  const currentStep = steps.find((s) => s.status === 'current');
  const firstTodo = steps.find((s) => s.status === 'todo');

  return {
    steps,
    currentStepId: currentStep?.id ?? firstTodo?.id ?? null,
    observations: portfolioObservations(accounts, fi, cash, essential),
    cashCents: cash,
    monthlyNeedsCents,
    monthlyEssentialCents: essential,
    starterFundTargetCents: starterTarget,
    fullFundTargetCents: fullTarget,
    monthsOfExpensesHeld: monthsHeld,
    unclaimedMatchCents: unclaimedMatch,
    highRateDebtCents: expensiveTotal,
  };
}

/**
 * Checks on the portfolio itself, as distinct from the funding order.
 * Each is arithmetic on the user's own numbers, never a recommendation.
 */
export function portfolioObservations(
  accounts: InvestmentAccount[],
  fi: FISettings,
  cashCents: Cents,
  monthlyEssentialCents: Cents,
): PortfolioObservation[] {
  const portfolio = summarizePortfolio(accounts);
  const observations: PortfolioObservation[] = [];

  if (portfolio.totalValueCents === 0) return observations;

  if (portfolio.blendedExpenseRatioBps > 0) {
    const annual = portfolio.annualFeeDragCents;
    // Compound the drag out 30 years to make it legible: a fee is not an
    // annual cost, it is a compounding one.
    const years = 30;
    const rate = fi.expectedReturnBps / BPS_SCALE;
    const feeRate = portfolio.blendedExpenseRatioBps / BPS_SCALE;
    const withoutFees = portfolio.totalValueCents * Math.pow(1 + rate, years);
    const withFees = portfolio.totalValueCents * Math.pow(1 + rate - feeRate, years);
    const lifetimeCost = Math.round(withoutFees - withFees);

    observations.push({
      id: 'fees',
      severity: portfolio.blendedExpenseRatioBps > 50 ? 'serious' : 'good',
      title: `Blended expense ratio ${bpsToPercent(portfolio.blendedExpenseRatioBps).toFixed(2)}%`,
      detail:
        portfolio.blendedExpenseRatioBps > 50
          ? `About ${money(annual)} a year today, and roughly ${money(lifetimeCost)} of forgone growth over 30 years on the current balance alone. Broad index funds commonly charge under 0.10%.`
          : `About ${money(annual)} a year — low. Fees are the one return factor you control outright.`,
    });
  }

  const largest = portfolio.byAssetClass[0];
  if (largest && largest.shareBps > 9000 && portfolio.byAssetClass.length > 1) {
    observations.push({
      id: 'concentration',
      severity: 'warning',
      title: `${bpsToPercent(largest.shareBps).toFixed(0)}% sits in a single asset class`,
      detail:
        'Concentration raises both the ceiling and the floor. Whether that suits you depends on how many years you have before you need the money.',
    });
  }

  const cashShare = portfolio.totalValueCents > 0 ? cashCents / portfolio.totalValueCents : 0;
  const monthsHeld = monthlyEssentialCents > 0 ? cashCents / monthlyEssentialCents : 0;
  if (cashShare > 0.3 && monthsHeld > 12) {
    observations.push({
      id: 'cash-drag',
      severity: 'warning',
      title: `${(cashShare * 100).toFixed(0)}% of the portfolio is cash`,
      detail: `That is ${monthsHeld.toFixed(0)} months of spending. Beyond an emergency fund, cash reliably loses to inflation.`,
    });
  }

  return observations;
}

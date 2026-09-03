import type {
  AssetClass,
  Cents,
  Holding,
  InvestmentAccount,
  Liability,
  OtherAsset,
  TaxTreatment,
} from '../types';
import { BPS_SCALE, roundCents, toBps } from './money';

/** Market value of a holding. Shares may be fractional; the result is whole cents. */
export function holdingValue(h: Holding): Cents {
  return roundCents(h.shares * h.priceCents);
}

export function holdingGainCents(h: Holding): Cents {
  return holdingValue(h) - h.costBasisCents;
}

/** Unrealized return on a holding in bp. 0 when there's no cost basis to compare. */
export function holdingReturnBps(h: Holding): number {
  if (h.costBasisCents === 0) return 0;
  return toBps(holdingGainCents(h), h.costBasisCents);
}

export function accountValue(a: InvestmentAccount): Cents {
  return a.holdings.reduce((sum, h) => sum + holdingValue(h), 0);
}

export function accountCostBasis(a: InvestmentAccount): Cents {
  return a.holdings.reduce((sum, h) => sum + h.costBasisCents, 0);
}

export function activeAccounts(accounts: InvestmentAccount[]): InvestmentAccount[] {
  return accounts.filter((a) => !a.archived);
}

export interface PortfolioSummary {
  totalValueCents: Cents;
  totalCostBasisCents: Cents;
  totalGainCents: Cents;
  totalReturnBps: number;
  /** Your own contributions per month, excluding employer match. */
  monthlyContributionCents: Cents;
  monthlyEmployerMatchCents: Cents;
  byAssetClass: { assetClass: AssetClass; valueCents: Cents; shareBps: number }[];
  byTaxTreatment: { taxTreatment: TaxTreatment; valueCents: Cents; shareBps: number }[];
  byAccount: { id: string; name: string; valueCents: Cents; gainCents: Cents; shareBps: number }[];
  /** Value-weighted average expense ratio in bp. */
  blendedExpenseRatioBps: number;
  /** Annual cost of that expense ratio, in cents. The number nobody looks at. */
  annualFeeDragCents: Cents;
}

export function summarizePortfolio(accounts: InvestmentAccount[]): PortfolioSummary {
  const active = activeAccounts(accounts);
  const totalValue = active.reduce((sum, a) => sum + accountValue(a), 0);
  const totalCost = active.reduce((sum, a) => sum + accountCostBasis(a), 0);

  const classTotals = new Map<AssetClass, Cents>();
  const taxTotals = new Map<TaxTreatment, Cents>();
  let weightedErNumerator = 0;

  for (const a of active) {
    taxTotals.set(a.taxTreatment, (taxTotals.get(a.taxTreatment) ?? 0) + accountValue(a));
    for (const h of a.holdings) {
      const v = holdingValue(h);
      classTotals.set(h.assetClass, (classTotals.get(h.assetClass) ?? 0) + v);
      weightedErNumerator += v * (h.expenseRatioBps ?? 0);
    }
  }

  const blendedEr = totalValue > 0 ? Math.round(weightedErNumerator / totalValue) : 0;

  return {
    totalValueCents: totalValue,
    totalCostBasisCents: totalCost,
    totalGainCents: totalValue - totalCost,
    totalReturnBps: toBps(totalValue - totalCost, totalCost),
    monthlyContributionCents: active.reduce((sum, a) => sum + a.monthlyContributionCents, 0),
    monthlyEmployerMatchCents: active.reduce((sum, a) => sum + (a.employerMatchCents ?? 0), 0),
    byAssetClass: [...classTotals.entries()]
      .map(([assetClass, valueCents]) => ({
        assetClass,
        valueCents,
        shareBps: toBps(valueCents, totalValue),
      }))
      .sort((a, b) => b.valueCents - a.valueCents),
    byTaxTreatment: [...taxTotals.entries()]
      .map(([taxTreatment, valueCents]) => ({
        taxTreatment,
        valueCents,
        shareBps: toBps(valueCents, totalValue),
      }))
      .sort((a, b) => b.valueCents - a.valueCents),
    byAccount: active
      .map((a) => ({
        id: a.id,
        name: a.name,
        valueCents: accountValue(a),
        gainCents: accountValue(a) - accountCostBasis(a),
        shareBps: toBps(accountValue(a), totalValue),
      }))
      .sort((a, b) => b.valueCents - a.valueCents),
    blendedExpenseRatioBps: blendedEr,
    annualFeeDragCents: roundCents((totalValue * blendedEr) / BPS_SCALE),
  };
}

export interface NetWorth {
  /** Everything that compounds toward FI: investment accounts plus any other
   *  asset explicitly flagged as counting. */
  fiAssetsCents: Cents;
  /** Assets excluded from FI — typically a house or a car. */
  nonFiAssetsCents: Cents;
  totalAssetsCents: Cents;
  totalLiabilitiesCents: Cents;
  netWorthCents: Cents;
}

export function computeNetWorth(
  accounts: InvestmentAccount[],
  otherAssets: OtherAsset[],
  liabilities: Liability[],
): NetWorth {
  const invested = activeAccounts(accounts).reduce((sum, a) => sum + accountValue(a), 0);
  const countedOther = otherAssets
    .filter((a) => a.countTowardFI)
    .reduce((sum, a) => sum + a.valueCents, 0);
  const uncountedOther = otherAssets
    .filter((a) => !a.countTowardFI)
    .reduce((sum, a) => sum + a.valueCents, 0);
  const debt = liabilities.reduce((sum, l) => sum + l.balanceCents, 0);

  const fiAssets = invested + countedOther;
  return {
    fiAssetsCents: fiAssets,
    nonFiAssetsCents: uncountedOther,
    totalAssetsCents: fiAssets + uncountedOther,
    totalLiabilitiesCents: debt,
    netWorthCents: fiAssets + uncountedOther - debt,
  };
}

/**
 * Target weights per asset class and the dollar move needed to hit them.
 * Positive `driftCents` means that class is overweight and should be sold down.
 */
export function rebalancePlan(
  summary: PortfolioSummary,
  targets: Partial<Record<AssetClass, number>>,
): { assetClass: AssetClass; currentBps: number; targetBps: number; driftCents: Cents }[] {
  const total = summary.totalValueCents;
  const classes = new Set<AssetClass>([
    ...summary.byAssetClass.map((c) => c.assetClass),
    ...(Object.keys(targets) as AssetClass[]),
  ]);

  return [...classes]
    .map((assetClass) => {
      const current = summary.byAssetClass.find((c) => c.assetClass === assetClass);
      const currentBps = current?.shareBps ?? 0;
      const targetBps = targets[assetClass] ?? 0;
      const targetValue = roundCents((total * targetBps) / BPS_SCALE);
      return {
        assetClass,
        currentBps,
        targetBps,
        driftCents: (current?.valueCents ?? 0) - targetValue,
      };
    })
    .sort((a, b) => Math.abs(b.driftCents) - Math.abs(a.driftCents));
}

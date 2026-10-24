import type { AccountKind, Cents, FISettings, InvestmentAccount } from '../types';
import { BPS_SCALE, roundCents, toBps } from './money';
import { accountValue, activeAccounts, holdingValue, type PortfolioSummary } from './investments';

/**
 * Analysis of a portfolio that already exists.
 *
 * The invest tab's other half answers "what should I do next" from an order of
 * operations. This answers a different question — "what is actually wrong with
 * what I already hold" — and it can only be answered from the holdings
 * themselves.
 *
 * Everything here is arithmetic on the user's own data, stated as a finding
 * with the number that produced it. None of it names a fund, and none of it
 * says what to buy. The line is the same one the rest of the app holds: it
 * will tell you that 0.68% costs you $312 a year; it will not tell you to sell.
 */

/** The age at which retirement accounts generally open up without a strategy. */
export const PENALTY_FREE_AGE = 59.5;

export type Severity = 'critical' | 'serious' | 'warning' | 'good' | 'neutral';

export interface Finding {
  id: string;
  severity: Severity;
  /** One line, specific, with the number in it. */
  title: string;
  /** Why it matters, and what the number means. Never what to buy. */
  detail: string;
  /** The measured figure, pre-formatted by the caller when it is money. */
  valueLabel?: string;
}

/**
 * Which account kinds hold money you can reach before 59½ without a strategy.
 *
 * Deliberately conservative. A Roth IRA's *contributions* are withdrawable at
 * any time, but this app does not track contribution basis separately from
 * growth, so counting the whole balance as reachable would overstate the
 * bridge — the one direction an error here must not go.
 */
const REACHABLE_KINDS: AccountKind[] = ['taxable', 'cash', 'crypto'];

export interface AccessAnalysis {
  /** The age the user says they are aiming for, or null if they have not said. */
  targetAge: number | null;
  currentAge: number | null;
  /** Years between retiring and 59½. Zero when they retire at or after it. */
  bridgeYears: number;
  /** Money reachable before 59½ without a penalty strategy. */
  reachableCents: Cents;
  /** Money in retirement accounts, which needs a strategy or a wait. */
  lockedCents: Cents;
  reachableShareBps: number;
  /** Annual spending the bridge has to cover, from the FI settings or budget. */
  annualSpendingCents: Cents;
  /** What the bridge needs in total, in today's dollars. */
  bridgeNeedCents: Cents;
  /** Positive means the reachable pot is short of the bridge. */
  shortfallCents: Cents;
}

/**
 * How much of the portfolio can be spent before 59½, and whether it covers the
 * gap between stopping work and that birthday.
 *
 * The standard order of operations assumes you retire at a conventional age,
 * so it fills tax-advantaged accounts first and never asks when you need the
 * money. For anyone aiming earlier that advice is incomplete rather than
 * wrong: the match and the tax break are still worth taking, but something has
 * to fund the years in between.
 */
export function analyzeAccess(
  accounts: InvestmentAccount[],
  fi: FISettings,
  annualSpendingCents: Cents,
): AccessAnalysis {
  const live = activeAccounts(accounts);

  let reachableCents = 0;
  let lockedCents = 0;
  for (const account of live) {
    const value = accountValue(account);
    if (REACHABLE_KINDS.includes(account.kind)) reachableCents += value;
    else lockedCents += value;
  }

  const total = reachableCents + lockedCents;
  const targetAge = fi.targetRetirementAge;
  const bridgeYears =
    targetAge === null ? 0 : Math.max(0, Math.ceil(PENALTY_FREE_AGE - targetAge));
  const bridgeNeedCents = roundCents(annualSpendingCents * bridgeYears);

  return {
    targetAge,
    currentAge: fi.currentAge,
    bridgeYears,
    reachableCents,
    lockedCents,
    reachableShareBps: total > 0 ? toBps(reachableCents, total) : 0,
    annualSpendingCents,
    bridgeNeedCents,
    shortfallCents: Math.max(0, bridgeNeedCents - reachableCents),
  };
}

export interface Concentration {
  /** Largest single holding as a share of the portfolio. */
  largestShareBps: number;
  largestLabel: string;
  largestValueCents: Cents;
  /** The five largest together. */
  topFiveShareBps: number;
  /** Distinct holdings, counting the same ticker in two accounts once. */
  distinctSymbols: number;
}

/**
 * How much of the portfolio rides on one position.
 *
 * Counts a symbol once across accounts, because the same fund held in a 401(k)
 * and an IRA is one bet, not two.
 */
export function analyzeConcentration(accounts: InvestmentAccount[]): Concentration {
  const bySymbol = new Map<string, Cents>();
  for (const account of activeAccounts(accounts)) {
    for (const holding of account.holdings) {
      const key = holding.symbol.toUpperCase() || holding.name.toUpperCase() || 'UNNAMED';
      bySymbol.set(key, (bySymbol.get(key) ?? 0) + holdingValue(holding));
    }
  }

  const sorted = [...bySymbol.entries()].sort((a, b) => b[1] - a[1]);
  const total = sorted.reduce((sum, [, value]) => sum + value, 0);
  const top = sorted[0];
  const topFive = sorted.slice(0, 5).reduce((sum, [, value]) => sum + value, 0);

  return {
    largestShareBps: total > 0 && top ? toBps(top[1], total) : 0,
    largestLabel: top?.[0] ?? '',
    largestValueCents: top?.[1] ?? 0,
    topFiveShareBps: total > 0 ? toBps(topFive, total) : 0,
    distinctSymbols: sorted.length,
  };
}

/** Share of the portfolio whose expense ratio has never been entered. */
export function unknownFeeShareBps(accounts: InvestmentAccount[]): number {
  let unknown = 0;
  let total = 0;
  for (const account of activeAccounts(accounts)) {
    for (const holding of account.holdings) {
      const value = holdingValue(holding);
      total += value;
      if (holding.expenseRatioBps === undefined) unknown += value;
    }
  }
  return total > 0 ? toBps(unknown, total) : 0;
}

function shareBps(summary: PortfolioSummary, assetClass: string): number {
  return summary.byAssetClass.find((c) => c.assetClass === assetClass)?.shareBps ?? 0;
}

export interface AnalysisInput {
  accounts: InvestmentAccount[];
  summary: PortfolioSummary;
  access: AccessAnalysis;
  concentration: Concentration;
  unknownFeesBps: number;
}

/**
 * Turn the measurements into findings, worst first.
 *
 * Thresholds are deliberately round and defensible rather than tuned: a tenth
 * of a portfolio in one position, half a percent in fees, a fifth sitting in
 * cash. Each one states the figure that triggered it so the reader can judge
 * the rule rather than trust it.
 */
export function buildFindings(input: AnalysisInput): Finding[] {
  const { summary, access, concentration, unknownFeesBps } = input;
  const findings: Finding[] = [];
  const total = summary.totalValueCents;
  if (total <= 0) return findings;

  const pct = (bps: number): string => `${(bps / 100).toFixed(1)}%`;

  // --- Access before 59½ ---------------------------------------------------
  if (access.bridgeYears > 0) {
    if (access.shortfallCents > 0) {
      const money = (cents: Cents): string => `$${Math.round(cents / 100).toLocaleString('en-US')}`;
      // The shortfall is about the amount, not the share. Leading with the
      // share reads as a contradiction when the whole portfolio is reachable
      // and simply too small — which is the common case early on.
      const shareClause =
        access.reachableShareBps < 5_000
          ? `Only ${pct(access.reachableShareBps)} of the portfolio is in taxable or cash accounts — the ones with no age condition on them — and the rest is in retirement accounts. `
          : '';

      findings.push({
        id: 'bridge-short',
        severity: 'serious',
        title: `Retiring at ${access.targetAge} needs ${access.bridgeYears} years of spending you can actually reach`,
        detail:
          `At ${money(access.annualSpendingCents)} a year, those years cost ` +
          `${money(access.bridgeNeedCents)}. You have ${money(access.reachableCents)} you could ` +
          `spend without a penalty strategy, leaving ${money(access.shortfallCents)} to find. ` +
          shareClause +
          'This is not a reason to skip the employer match or the tax break — both are still ' +
          'worth taking. It is a reason to know the gap exists, because something has to fund ' +
          'the years between stopping work and 59½.',
        valueLabel: 'shortfall',
      });
    } else {
      findings.push({
        id: 'bridge-covered',
        severity: 'good',
        title: `Your reachable accounts cover the ${access.bridgeYears} years to 59½`,
        detail:
          `${pct(access.reachableShareBps)} of the portfolio is in taxable or cash accounts, ` +
          'enough to cover the bridge at your current spending. Worth re-checking whenever ' +
          'your spending or target age moves.',
      });
    }
  }

  // --- Concentration -------------------------------------------------------
  if (concentration.largestShareBps >= 2_500) {
    findings.push({
      id: 'concentration',
      severity: concentration.largestShareBps >= 5_000 ? 'serious' : 'warning',
      title: `${pct(concentration.largestShareBps)} of the portfolio is in ${concentration.largestLabel}`,
      detail:
        'One position moving on its own news moves this much of your net worth. That is ' +
        'fine if it is a broad index fund, which is thousands of companies in one ticker, ' +
        'and a different thing entirely if it is a single company — including the one that ' +
        'pays you, where your salary and your savings would fall together.',
      valueLabel: concentration.largestLabel,
    });
  }

  // --- Fees ----------------------------------------------------------------
  if (summary.blendedExpenseRatioBps >= 50) {
    findings.push({
      id: 'fees',
      severity: summary.blendedExpenseRatioBps >= 100 ? 'serious' : 'warning',
      title: `Fees cost you about ${(summary.annualFeeDragCents / 100).toFixed(0)} dollars a year`,
      detail:
        `A blended expense ratio of ${pct(summary.blendedExpenseRatioBps)} is charged on the ` +
        'balance every year, in good years and bad, whether or not the fund beats anything. ' +
        'It compounds against you exactly the way returns compound for you.',
    });
  }

  if (unknownFeesBps >= 5_000) {
    findings.push({
      id: 'fees-unknown',
      severity: 'neutral',
      title: `${pct(unknownFeesBps)} of the portfolio has no expense ratio recorded`,
      detail:
        'The fee figure above only covers holdings where you entered one, so it understates ' +
        'the real cost. Expense ratios are on every fund page and take a minute to fill in.',
    });
  }

  // --- Cash ---------------------------------------------------------------
  const cashBps = shareBps(summary, 'cash');
  if (cashBps >= 2_000) {
    findings.push({
      id: 'cash',
      severity: 'warning',
      title: `${pct(cashBps)} of the portfolio is sitting in cash`,
      detail:
        'Cash in an investment account is doing nothing but losing to inflation. An ' +
        'emergency fund is a different thing with a different job — this is the money you ' +
        'already decided to invest, still uninvested.',
    });
  }

  // --- Classification ------------------------------------------------------
  const otherBps = shareBps(summary, 'other');
  if (otherBps >= 500) {
    findings.push({
      id: 'unclassified',
      severity: 'neutral',
      title: `${pct(otherBps)} of the portfolio has no asset class`,
      detail:
        'Linked holdings arrive classified by whatever the brokerage called them, and a ' +
        'starting total typed during setup has no class at all. Every allocation figure on ' +
        'this page is measured against an incomplete picture until these are set.',
    });
  }

  // --- Tax diversification -------------------------------------------------
  const roth = summary.byTaxTreatment.find((t) => t.taxTreatment === 'roth')?.shareBps ?? 0;
  const pretax = summary.byTaxTreatment.find((t) => t.taxTreatment === 'pretax')?.shareBps ?? 0;
  if (total > 0 && roth === 0 && pretax >= 7_500) {
    findings.push({
      id: 'all-pretax',
      severity: 'neutral',
      title: `${pct(pretax)} of the portfolio is pre-tax`,
      detail:
        'Every dollar of it is taxed as income when withdrawn, at whatever the rates are ' +
        'then. Having some money in each tax treatment is what gives you a choice about ' +
        'which pot to draw from in a given year.',
    });
  }

  const order: Severity[] = ['critical', 'serious', 'warning', 'neutral', 'good'];
  return findings.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
}

/** The whole analysis, for a page that wants it in one call. */
export function analyzePortfolio(
  accounts: InvestmentAccount[],
  summary: PortfolioSummary,
  fi: FISettings,
  annualSpendingCents: Cents,
): AnalysisInput & { findings: Finding[] } {
  const access = analyzeAccess(accounts, fi, annualSpendingCents);
  const concentration = analyzeConcentration(accounts);
  const unknownFeesBps = unknownFeeShareBps(accounts);
  const input: AnalysisInput = { accounts, summary, access, concentration, unknownFeesBps };
  return { ...input, findings: buildFindings(input) };
}

/** Share of a value, in basis points, guarding the zero case. */
export function safeShareBps(part: Cents, whole: Cents): number {
  return whole > 0 ? toBps(part, whole) : 0;
}

export { BPS_SCALE };

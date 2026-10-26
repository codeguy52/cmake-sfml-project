import type { Category, Cents, IncomeSource, Transaction } from '../types';
import { monthKey, currentMonthKey, resolveBudget, type BudgetSummary } from './budget';
import { roundCents, toBps } from './money';
import type { Finding, Severity } from './analysis';

/**
 * Analysis of money already spent.
 *
 * The budget pages report: this is what you budgeted, this is what you spent,
 * here is a six-month line. All of it is visible by looking. None of it
 * answers the questions that actually change behaviour — is this month normal,
 * which budgets are fiction, where is the money quietly going, and is a
 * category drifting rather than spiking.
 *
 * Those need several months at once, which is the one thing a single-month
 * view cannot do. Everything here is arithmetic over the transaction history,
 * and every finding carries the figure that produced it so the rule can be
 * judged rather than trusted.
 */

/** Months of history before a trend claim is worth making at all. */
export const MIN_MONTHS_FOR_TREND = 3;

export interface MonthSpend {
  month: string;
  spentCents: Cents;
  /** True for the month in progress, which is not comparable to a whole one. */
  partial: boolean;
}

/**
 * Spending per month, newest last, marking the month still in progress.
 *
 * Comparing a half-finished month against complete ones is the single easiest
 * way to manufacture a false "spending is down" — so the partial month is
 * flagged and excluded from every average below.
 */
export function monthlyHistory(
  transactions: Transaction[],
  count: number,
  now = new Date(),
): MonthSpend[] {
  const thisMonth = currentMonthKey(now);
  const months: MonthSpend[] = [];

  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = currentMonthKey(d);
    months.push({ month: key, spentCents: 0, partial: key === thisMonth });
  }

  const index = new Map(months.map((m, i) => [m.month, i]));
  for (const t of transactions) {
    const i = index.get(monthKey(t.date));
    if (i !== undefined) months[i]!.spentCents += t.amountCents;
  }
  return months;
}

/** Complete months only, oldest first. */
export function completeMonths(history: MonthSpend[]): MonthSpend[] {
  return history.filter((m) => !m.partial && m.spentCents !== 0);
}

export interface CategoryPattern {
  categoryId: string;
  name: string;
  /** Average spend across complete months with any activity. */
  averageCents: Cents;
  budgetCents: Cents;
  /** Complete months in which this category went over budget. */
  monthsOver: number;
  monthsObserved: number;
  /** Average as a share of the budget, in bp. 12 000 = 120% of budget. */
  usageBps: number;
}

/**
 * How each category has behaved over complete months, against its budget.
 *
 * A category over budget once is a month. Over budget most months is a budget
 * that was never real — and the fix for that is editing the number, not trying
 * harder, which is a distinction the single-month view cannot draw.
 */
export function categoryPatterns(
  categories: Category[],
  incomeSources: IncomeSource[],
  transactions: Transaction[],
  months: MonthSpend[],
): CategoryPattern[] {
  const complete = completeMonths(months);
  if (complete.length === 0) return [];

  // Resolve each month once. Doing it inside the category loop would re-run
  // the whole budget for every category in every month.
  const resolved = complete.map((m) => resolveBudget(categories, incomeSources, transactions, m.month));

  const totals = new Map<string, { total: Cents; budget: Cents; observed: number; over: number }>();

  for (const summary of resolved) {
    for (const row of summary.categories) {
      const id = row.category.id;
      const current = totals.get(id) ?? { total: 0, budget: 0, observed: 0, over: 0 };
      current.total += row.spentCents;
      current.budget += row.budgetCents;
      current.observed += 1;
      if (row.budgetCents > 0 && row.spentCents > row.budgetCents) current.over += 1;
      totals.set(id, current);
    }
  }

  const patterns: CategoryPattern[] = [];
  for (const category of categories) {
    const t = totals.get(category.id);
    if (!t || t.observed === 0) continue;

    const averageCents = roundCents(t.total / t.observed);
    const budgetCents = roundCents(t.budget / t.observed);
    patterns.push({
      categoryId: category.id,
      name: category.name,
      averageCents,
      budgetCents,
      monthsOver: t.over,
      monthsObserved: t.observed,
      usageBps: budgetCents > 0 ? toBps(averageCents, budgetCents) : 0,
    });
  }

  return patterns.sort((a, b) => b.averageCents - a.averageCents);
}

/** Direction of travel across complete months, as a share change per month. */
export function spendingTrendBps(months: MonthSpend[]): number | null {
  const complete = completeMonths(months);
  if (complete.length < MIN_MONTHS_FOR_TREND) return null;

  // Compare the first and second halves rather than fitting a line: it is
  // robust to one unusual month and it is explainable in a sentence.
  const half = Math.floor(complete.length / 2);
  const older = complete.slice(0, half);
  const newer = complete.slice(complete.length - half);

  const mean = (xs: MonthSpend[]): number =>
    xs.reduce((sum, m) => sum + m.spentCents, 0) / xs.length;

  const before = mean(older);
  const after = mean(newer);
  if (before <= 0) return null;

  return Math.round(((after - before) / before) * 10_000);
}

export interface MerchantTotal {
  merchant: string;
  totalCents: Cents;
  count: number;
}

/** Where the money went by merchant, across whatever months are given. */
export function topMerchants(
  transactions: Transaction[],
  months: MonthSpend[],
  limit = 5,
): MerchantTotal[] {
  const keys = new Set(months.map((m) => m.month));
  const totals = new Map<string, MerchantTotal>();

  for (const t of transactions) {
    if (!keys.has(monthKey(t.date))) continue;
    const name = t.merchant.trim() || 'Unnamed';
    const key = name.toLowerCase();
    const current = totals.get(key) ?? { merchant: name, totalCents: 0, count: 0 };
    current.totalCents += t.amountCents;
    current.count += 1;
    totals.set(key, current);
  }

  return [...totals.values()].sort((a, b) => b.totalCents - a.totalCents).slice(0, limit);
}

/** Spending with no category, which is spending you cannot steer. */
export function uncategorizedShareBps(transactions: Transaction[], months: MonthSpend[]): number {
  const keys = new Set(months.map((m) => m.month));
  let total = 0;
  let uncategorized = 0;

  for (const t of transactions) {
    if (!keys.has(monthKey(t.date))) continue;
    total += t.amountCents;
    if (t.categoryId === null) uncategorized += t.amountCents;
  }

  return total > 0 ? toBps(uncategorized, total) : 0;
}

/**
 * How far through the month's budget you are against how far through the
 * month you are. Spending 80% of a budget in the first week is a fact worth
 * knowing on the 8th rather than the 30th.
 */
export function pacing(
  summary: BudgetSummary,
  now = new Date(),
): { elapsedBps: number; spentBps: number; aheadBps: number } | null {
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const elapsedBps = Math.round((now.getDate() / daysInMonth) * 10_000);
  if (summary.totalBudgetedCents <= 0) return null;

  const spentBps = toBps(summary.totalSpentCents, summary.totalBudgetedCents);
  return { elapsedBps, spentBps, aheadBps: spentBps - elapsedBps };
}

export interface SpendingAnalysis {
  history: MonthSpend[];
  patterns: CategoryPattern[];
  trendBps: number | null;
  merchants: MerchantTotal[];
  uncategorizedBps: number;
  pacing: ReturnType<typeof pacing>;
  findings: Finding[];
}

function money(cents: Cents): string {
  return `$${Math.round(cents / 100).toLocaleString('en-US')}`;
}

function pct(bps: number): string {
  return `${(bps / 100).toFixed(0)}%`;
}

/**
 * Everything the budget section can say about money already spent.
 *
 * Deliberately quiet early on: with one month of data almost nothing here is
 * knowable, and inventing findings from a single month would teach people to
 * ignore the section before it had anything to say.
 */
export function analyzeSpending(params: {
  categories: Category[];
  incomeSources: IncomeSource[];
  transactions: Transaction[];
  summary: BudgetSummary;
  monthsOfHistory?: number;
  now?: Date;
}): SpendingAnalysis {
  const { categories, incomeSources, transactions, summary } = params;
  const now = params.now ?? new Date();
  const history = monthlyHistory(transactions, params.monthsOfHistory ?? 6, now);
  const complete = completeMonths(history);

  const patterns = categoryPatterns(categories, incomeSources, transactions, history);
  const trendBps = spendingTrendBps(history);
  const merchants = topMerchants(transactions, history);
  const uncategorizedBps = uncategorizedShareBps(transactions, history);
  const pace = pacing(summary, now);

  const findings: Finding[] = [];
  const add = (
    id: string,
    severity: Severity,
    title: string,
    detail: string,
  ): void => void findings.push({ id, severity, title, detail });

  // --- Budgets that were never real ---------------------------------------
  for (const p of patterns) {
    if (p.monthsObserved >= MIN_MONTHS_FOR_TREND && p.monthsOver >= Math.ceil(p.monthsObserved * 0.75)) {
      add(
        `chronic-${p.categoryId}`,
        'serious',
        `${p.name} has gone over budget ${p.monthsOver} of the last ${p.monthsObserved} months`,
        `You budget ${money(p.budgetCents)} and spend ${money(p.averageCents)} — ` +
          `${pct(p.usageBps)} of it, month after month. A category that loses every month is ` +
          'usually a budget that was never real rather than a habit that keeps failing. ' +
          'Raising it to what you actually spend makes every other number on the page honest, ' +
          'even if the total then forces a harder choice elsewhere.',
      );
    }
  }

  // --- Budgets nobody uses -------------------------------------------------
  for (const p of patterns) {
    if (p.monthsObserved >= MIN_MONTHS_FOR_TREND && p.budgetCents > 0 && p.usageBps > 0 && p.usageBps <= 4_000) {
      add(
        `slack-${p.categoryId}`,
        'neutral',
        `${p.name} uses ${pct(p.usageBps)} of its budget`,
        `Budgeted ${money(p.budgetCents)}, averaging ${money(p.averageCents)}. The gap is money ` +
          'the budget has already spoken for and you are not spending — which means it is not ' +
          'available anywhere else either, including savings.',
      );
    }
  }

  // --- Direction of travel -------------------------------------------------
  if (trendBps !== null && Math.abs(trendBps) >= 1_000) {
    const rising = trendBps > 0;
    add(
      'trend',
      rising ? 'warning' : 'good',
      `Spending is ${rising ? 'up' : 'down'} ${pct(Math.abs(trendBps))} against earlier months`,
      `Comparing the most recent complete months against the earlier ones in your history. ` +
        (rising
          ? 'A drift this size rarely comes from one purchase — it is usually several categories ' +
            'moving together, which is why it is easy to miss a month at a time.'
          : 'Worth knowing what caused it, since a fall you cannot explain tends not to last.'),
    );
  }

  // --- Spending you cannot steer ------------------------------------------
  if (uncategorizedBps >= 1_000) {
    add(
      'uncategorized',
      'warning',
      `${pct(uncategorizedBps)} of your spending has no category`,
      'Every budget figure on this page excludes it, so the ones that look fine may not be. ' +
        'Uncategorised spending is also the part you cannot make a decision about, because it ' +
        'has no name.',
    );
  }

  // --- Pace through the month ---------------------------------------------
  if (pace && pace.aheadBps >= 1_500 && pace.elapsedBps <= 8_000) {
    add(
      'pacing',
      'warning',
      `You are ${pct(pace.spentBps)} through the budget and ${pct(pace.elapsedBps)} through the month`,
      'Still time to change the outcome, which is the only reason this is worth saying now ' +
        'rather than in the month-end total.',
    );
  }

  // --- Not enough to say anything -----------------------------------------
  if (complete.length < MIN_MONTHS_FOR_TREND) {
    add(
      'needs-history',
      'neutral',
      `${complete.length} complete month${complete.length === 1 ? '' : 's'} of history so far`,
      `Most of what is worth knowing about spending — which budgets are fiction, what is ` +
        `drifting, what is normal — needs at least ${MIN_MONTHS_FOR_TREND} months to tell from ` +
        'noise. Keep recording and this fills in.',
    );
  }

  const order: Severity[] = ['critical', 'serious', 'warning', 'neutral', 'good'];
  findings.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));

  return { history, patterns, trendBps, merchants, uncategorizedBps, pacing: pace, findings };
}

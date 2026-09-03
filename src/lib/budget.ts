import type {
  Category,
  CategoryGroup,
  Cents,
  IncomeSource,
  Subcategory,
  Transaction,
} from '../types';
import { applyBps, toBps } from './money';

/**
 * Budget resolution.
 *
 * A category claims either a percentage of monthly income or a flat dollar
 * amount; a subcategory claims either a percentage of *its parent's resolved
 * budget* or a flat dollar amount. Mixing the two modes freely is the point —
 * "20% to savings" and "$1,450 rent" are both natural ways to think, and the
 * resolver reconciles them against a single income figure.
 */

export interface ResolvedSubcategory {
  subcategory: Subcategory;
  budgetCents: Cents;
  spentCents: Cents;
  remainingCents: Cents;
  /** Share of the parent category, for display. */
  shareOfParentBps: number;
}

export interface ResolvedCategory {
  category: Category;
  budgetCents: Cents;
  spentCents: Cents;
  remainingCents: Cents;
  shareOfIncomeBps: number;
  subcategories: ResolvedSubcategory[];
  /** Parent budget minus the sum of its subcategory budgets. Negative means the
   *  subcategories claim more than the category holds. */
  unassignedCents: Cents;
  /** Spending in this category with no subcategory selected. */
  directSpentCents: Cents;
}

export interface BudgetSummary {
  monthlyIncomeCents: Cents;
  totalBudgetedCents: Cents;
  /** Income minus everything budgeted. Negative means over-allocated. */
  unallocatedCents: Cents;
  totalSpentCents: Cents;
  categories: ResolvedCategory[];
  byGroup: Record<CategoryGroup, { budgetCents: Cents; spentCents: Cents; shareBps: number }>;
  /** Set when categories claim more than 100% of income. */
  overAllocated: boolean;
}

export function activeCategories(categories: Category[]): Category[] {
  return categories.filter((c) => !c.archived);
}

export function monthlyIncome(sources: IncomeSource[]): Cents {
  return sources.filter((s) => !s.archived).reduce((sum, s) => sum + s.monthlyCents, 0);
}

/** Resolve one allocation against the scope it sits in. */
export function resolveAllocation(
  allocation: { mode: 'percent' | 'fixed'; value: number },
  scopeCents: Cents,
): Cents {
  return allocation.mode === 'fixed' ? allocation.value : applyBps(scopeCents, allocation.value);
}

/** `YYYY-MM` for a transaction date, used to bucket spending into months. */
export function monthKey(isoDate: string): string {
  return isoDate.slice(0, 7);
}

export function currentMonthKey(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/**
 * Resolve the whole budget for one month.
 *
 * `month` is a `YYYY-MM` key; only transactions in that month count as spent.
 */
export function resolveBudget(
  categories: Category[],
  incomeSources: IncomeSource[],
  transactions: Transaction[],
  month: string,
): BudgetSummary {
  const income = monthlyIncome(incomeSources);
  const active = activeCategories(categories);

  const monthTx = transactions.filter((t) => monthKey(t.date) === month);

  // Index spending once rather than filtering per category.
  const spentByCategory = new Map<string, Cents>();
  const spentBySubcategory = new Map<string, Cents>();
  for (const t of monthTx) {
    if (t.categoryId) {
      spentByCategory.set(t.categoryId, (spentByCategory.get(t.categoryId) ?? 0) + t.amountCents);
    }
    if (t.subcategoryId) {
      spentBySubcategory.set(
        t.subcategoryId,
        (spentBySubcategory.get(t.subcategoryId) ?? 0) + t.amountCents,
      );
    }
  }

  const resolved: ResolvedCategory[] = active.map((category) => {
    const budgetCents = resolveAllocation(category.allocation, income);
    const spentCents = spentByCategory.get(category.id) ?? 0;

    const subs = category.subcategories.filter((s) => !s.archived);
    const resolvedSubs: ResolvedSubcategory[] = subs.map((subcategory) => {
      const subBudget = resolveAllocation(subcategory.allocation, budgetCents);
      const subSpent = spentBySubcategory.get(subcategory.id) ?? 0;
      return {
        subcategory,
        budgetCents: subBudget,
        spentCents: subSpent,
        remainingCents: subBudget - subSpent,
        shareOfParentBps: toBps(subBudget, budgetCents),
      };
    });

    const subBudgetTotal = resolvedSubs.reduce((sum, s) => sum + s.budgetCents, 0);
    const subSpentTotal = resolvedSubs.reduce((sum, s) => sum + s.spentCents, 0);

    return {
      category,
      budgetCents,
      spentCents,
      remainingCents: budgetCents - spentCents,
      shareOfIncomeBps: toBps(budgetCents, income),
      subcategories: resolvedSubs,
      unassignedCents: budgetCents - subBudgetTotal,
      directSpentCents: spentCents - subSpentTotal,
    };
  });

  const totalBudgeted = resolved.reduce((sum, r) => sum + r.budgetCents, 0);
  const totalSpent = resolved.reduce((sum, r) => sum + r.spentCents, 0);

  const groups: CategoryGroup[] = ['needs', 'wants', 'savings'];
  const byGroup = {} as BudgetSummary['byGroup'];
  for (const g of groups) {
    const inGroup = resolved.filter((r) => r.category.group === g);
    const budgetCents = inGroup.reduce((sum, r) => sum + r.budgetCents, 0);
    byGroup[g] = {
      budgetCents,
      spentCents: inGroup.reduce((sum, r) => sum + r.spentCents, 0),
      shareBps: toBps(budgetCents, income),
    };
  }

  return {
    monthlyIncomeCents: income,
    totalBudgetedCents: totalBudgeted,
    unallocatedCents: income - totalBudgeted,
    totalSpentCents: totalSpent,
    categories: resolved,
    byGroup,
    overAllocated: totalBudgeted > income,
  };
}

/**
 * Budgeted monthly spending that FI has to fund forever: needs plus wants.
 * Savings-group categories are excluded — once you're financially independent
 * you are no longer saving out of earned income.
 */
export function monthlyFundedSpending(summary: BudgetSummary): Cents {
  return summary.byGroup.needs.budgetCents + summary.byGroup.wants.budgetCents;
}

/** Monthly amount routed to savings-group categories. */
export function monthlyBudgetedSavings(summary: BudgetSummary): Cents {
  return summary.byGroup.savings.budgetCents;
}

/**
 * Actual spending per month over the trailing `count` months, oldest first.
 * Used for the trend chart and as a sanity check against the budget.
 */
export function spendingByMonth(
  transactions: Transaction[],
  count: number,
  now = new Date(),
): { month: string; spentCents: Cents }[] {
  const months: { month: string; spentCents: Cents }[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ month: currentMonthKey(d), spentCents: 0 });
  }
  const index = new Map(months.map((m, i) => [m.month, i]));
  for (const t of transactions) {
    const i = index.get(monthKey(t.date));
    if (i !== undefined) months[i]!.spentCents += t.amountCents;
  }
  return months;
}

/**
 * Rebalance percentage-mode categories so the budget sums to exactly 100% of
 * income, leaving fixed-amount categories untouched. Returns new category
 * objects; the caller decides whether to commit them.
 */
export function normalizePercentages(categories: Category[], income: Cents): Category[] {
  const active = activeCategories(categories);
  const fixedTotal = active
    .filter((c) => c.allocation.mode === 'fixed')
    .reduce((sum, c) => sum + c.allocation.value, 0);

  const percentCats = active.filter((c) => c.allocation.mode === 'percent');
  const currentBps = percentCats.reduce((sum, c) => sum + c.allocation.value, 0);
  if (percentCats.length === 0 || currentBps === 0) return categories;

  const availableBps = Math.max(0, toBps(income - fixedTotal, income));

  // Scale each percentage by the same factor, then push any rounding residue
  // onto the largest line so the total lands exactly on `availableBps`.
  const scaled = percentCats.map((c) => Math.round((c.allocation.value * availableBps) / currentBps));
  const residue = availableBps - scaled.reduce((a, b) => a + b, 0);
  if (scaled.length > 0) {
    let largest = 0;
    for (let i = 1; i < scaled.length; i++) if (scaled[i]! > scaled[largest]!) largest = i;
    scaled[largest]! += residue;
  }

  const newBps = new Map(percentCats.map((c, i) => [c.id, scaled[i]!]));
  return categories.map((c) =>
    newBps.has(c.id) ? { ...c, allocation: { ...c.allocation, value: newBps.get(c.id)! } } : c,
  );
}

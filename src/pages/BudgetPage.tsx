import { useMemo, useState } from 'react';
import type { Allocation, Category, CategoryGroup, IncomeKind } from '../types';
import { useStore } from '../store';
import {
  currentMonthKey,
  monthlyIncome,
  normalizePercentages,
  resolveAllocation,
  resolveBudget,
} from '../lib/budget';
import { bpsToPercent, toBps } from '../lib/money';
import { budgetStatus, CATEGORY_COLOR_CHOICES, foldToOther } from '../lib/palette';
import {
  Callout,
  Card,
  ChartFrame,
  ConfirmButton,
  EmptyState,
  Meter,
  MoneyInput,
  PercentInput,
  StatTile,
  useFormatMoney,
} from '../components/ui';
import { ShareTable, StackedShareBar, useSeriesColor } from '../components/charts';

const GROUP_LABELS: Record<CategoryGroup, string> = {
  needs: 'Need',
  wants: 'Want',
  savings: 'Savings',
};

const INCOME_KINDS: { value: IncomeKind; label: string }[] = [
  { value: 'salary', label: 'Salary' },
  { value: 'self_employment', label: 'Self-employment' },
  { value: 'side', label: 'Side income' },
  { value: 'rental', label: 'Rental' },
  { value: 'other', label: 'Other' },
];

/**
 * The allocation control: one number plus a mode toggle.
 *
 * A category is either a percentage of income or a flat amount, and the toggle
 * converts between the two at the current income rather than resetting to zero
 * — switching "20%" to dollars should hand you the dollar figure that 20%
 * currently means, because that is what the user was already looking at.
 */
function AllocationInput({
  allocation,
  scopeCents,
  onChange,
  label,
}: {
  allocation: Allocation;
  scopeCents: number;
  onChange: (next: Allocation) => void;
  label: string;
}) {
  const toggle = (): void => {
    if (allocation.mode === 'percent') {
      onChange({ mode: 'fixed', value: resolveAllocation(allocation, scopeCents) });
    } else {
      onChange({ mode: 'percent', value: toBps(allocation.value, scopeCents) });
    }
  };

  return (
    <span className="alloc-input">
      {allocation.mode === 'percent' ? (
        <PercentInput
          valueBps={allocation.value}
          ariaLabel={`${label} percentage`}
          onCommit={(bps) => onChange({ mode: 'percent', value: bps })}
        />
      ) : (
        <MoneyInput
          valueCents={allocation.value}
          ariaLabel={`${label} amount`}
          onCommit={(cents) => onChange({ mode: 'fixed', value: cents })}
        />
      )}
      <button
        type="button"
        className="alloc-mode"
        onClick={toggle}
        title={
          allocation.mode === 'percent'
            ? 'Switch to a fixed dollar amount'
            : 'Switch to a percentage'
        }
        aria-label={`${label}: switch to ${allocation.mode === 'percent' ? 'dollars' : 'percent'}`}
      >
        {allocation.mode === 'percent' ? '%' : '$'}
      </button>
    </span>
  );
}

function ColorPicker({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (color: string) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const seriesColor = useSeriesColor();

  return (
    <span style={{ position: 'relative' }}>
      <button
        type="button"
        className="btn btn-icon"
        onClick={() => setOpen((o) => !o)}
        aria-label={`${label} color`}
        style={{ padding: 4 }}
      >
        <span
          className="swatch"
          style={{ background: seriesColor(value), width: 15, height: 15 }}
          aria-hidden="true"
        />
      </button>
      {open && (
        <span
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            zIndex: 20,
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 4,
            padding: 6,
            background: 'var(--surface)',
            border: '1px solid var(--border-strong)',
            borderRadius: 'var(--radius-sm)',
            boxShadow: 'var(--shadow)',
          }}
        >
          {CATEGORY_COLOR_CHOICES.map((c) => (
            <button
              key={c}
              type="button"
              className="btn btn-icon"
              style={{ padding: 3 }}
              aria-label={`Use color ${c}`}
              onClick={() => {
                onChange(c);
                setOpen(false);
              }}
            >
              <span
                className="swatch"
                style={{
                  background: seriesColor(c),
                  width: 17,
                  height: 17,
                  outline: c === value ? '2px solid var(--text-primary)' : 'none',
                  outlineOffset: 1,
                }}
                aria-hidden="true"
              />
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

function CategoryRow({ category, incomeCents }: { category: Category; incomeCents: number }) {
  const [expanded, setExpanded] = useState(false);
  const fmt = useFormatMoney();
  const {
    updateCategory,
    removeCategory,
    moveCategory,
    addSubcategory,
    updateSubcategory,
    removeSubcategory,
  } = useStore();

  const budgetCents = resolveAllocation(category.allocation, incomeCents);
  const subs = category.subcategories;
  const subTotal = subs.reduce((sum, s) => sum + resolveAllocation(s.allocation, budgetCents), 0);
  const unassigned = budgetCents - subTotal;

  return (
    <div className="cat-row">
      <div className="cat-head">
        <span style={{ gridArea: 'swatch', display: 'flex', gap: 2, alignItems: 'center' }}>
          <ColorPicker
            value={category.color}
            label={category.name}
            onChange={(color) => updateCategory(category.id, { color })}
          />
          <button
            type="button"
            className="btn btn-icon"
            onClick={() => setExpanded((e) => !e)}
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Hide' : 'Show'} subcategories of ${category.name}`}
            title={`${subs.length} subcategor${subs.length === 1 ? 'y' : 'ies'}`}
          >
            {expanded ? '▾' : '▸'}
          </button>
        </span>

        <span style={{ gridArea: 'name', minWidth: 0 }}>
          <input
            className="cat-name-input"
            type="text"
            value={category.name}
            aria-label="Category name"
            onChange={(e) => updateCategory(category.id, { name: e.target.value })}
          />
        </span>

        <span style={{ gridArea: 'alloc', display: 'flex', gap: 8, alignItems: 'center' }}>
          <select
            value={category.group}
            aria-label={`${category.name} type`}
            style={{ width: 'auto' }}
            onChange={(e) => updateCategory(category.id, { group: e.target.value as CategoryGroup })}
          >
            {(Object.keys(GROUP_LABELS) as CategoryGroup[]).map((g) => (
              <option key={g} value={g}>
                {GROUP_LABELS[g]}
              </option>
            ))}
          </select>
          <AllocationInput
            allocation={category.allocation}
            scopeCents={incomeCents}
            label={category.name}
            onChange={(allocation) => updateCategory(category.id, { allocation })}
          />
        </span>

        <span className="resolved-amount" style={{ gridArea: 'resolved' }}>
          {fmt(budgetCents)}
          <span className="muted">/mo</span>
        </span>

        <span style={{ gridArea: 'actions', display: 'flex', gap: 0, alignItems: 'center' }}>
          <button
            type="button"
            className="btn btn-icon"
            onClick={() => moveCategory(category.id, -1)}
            aria-label={`Move ${category.name} up`}
          >
            ↑
          </button>
          <button
            type="button"
            className="btn btn-icon"
            onClick={() => moveCategory(category.id, 1)}
            aria-label={`Move ${category.name} down`}
          >
            ↓
          </button>
          <ConfirmButton
            onConfirm={() => removeCategory(category.id)}
            confirmLabel="Delete"
            title={`Delete ${category.name}`}
          >
            ✕
          </ConfirmButton>
        </span>
      </div>

      {expanded && (
        <div className="cat-body">
          {subs.length === 0 ? (
            <p className="muted" style={{ fontSize: 13, margin: '0 0 10px' }}>
              No subcategories. Add one to split this budget further.
            </p>
          ) : (
            <>
              <div
                className="sub-row"
                style={{ fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '0.04em' }}
              >
                <span className="muted">Subcategory</span>
                <span className="muted">Share of {category.name}</span>
                <span className="muted" style={{ textAlign: 'right' }}>
                  Monthly
                </span>
                <span />
              </div>
              {subs.map((sub) => (
                <div className="sub-row" key={sub.id}>
                  <input
                    type="text"
                    value={sub.name}
                    aria-label="Subcategory name"
                    onChange={(e) =>
                      updateSubcategory(category.id, sub.id, { name: e.target.value })
                    }
                  />
                  <AllocationInput
                    allocation={sub.allocation}
                    scopeCents={budgetCents}
                    label={sub.name}
                    onChange={(allocation) =>
                      updateSubcategory(category.id, sub.id, { allocation })
                    }
                  />
                  <span className="resolved-amount">
                    {fmt(resolveAllocation(sub.allocation, budgetCents))}
                  </span>
                  <ConfirmButton
                    onConfirm={() => removeSubcategory(category.id, sub.id)}
                    confirmLabel="Delete"
                    title={`Delete ${sub.name}`}
                  >
                    ✕
                  </ConfirmButton>
                </div>
              ))}
            </>
          )}

          <div className="row-between" style={{ marginTop: 10 }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => addSubcategory(category.id)}
            >
              + Add subcategory
            </button>
            {subs.length > 0 && (
              <span className="mono-num" style={{ fontSize: 12.5 }}>
                {unassigned === 0 ? (
                  <span className="muted">Fully assigned</span>
                ) : unassigned > 0 ? (
                  <span className="secondary">{fmt(unassigned)} unassigned in this category</span>
                ) : (
                  <span style={{ color: 'var(--critical)' }}>
                    ⚠ Subcategories exceed this category by {fmt(-unassigned)}
                  </span>
                )}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function BudgetPage() {
  const data = useStore((s) => s.data);
  const {
    addCategory,
    replaceAll,
    addIncomeSource,
    updateIncomeSource,
    removeIncomeSource,
  } = useStore();
  const fmt = useFormatMoney();
  const seriesColor = useSeriesColor();

  const income = monthlyIncome(data.incomeSources);
  const month = currentMonthKey();
  const summary = useMemo(
    () => resolveBudget(data.categories, data.incomeSources, data.transactions, month),
    [data.categories, data.incomeSources, data.transactions, month],
  );

  const slices = useMemo(
    () =>
      foldToOther(
        summary.categories.map((r) => ({
          id: r.category.id,
          label: r.category.name,
          valueCents: r.budgetCents,
          color: r.category.color,
        })),
      ),
    [summary],
  );

  const percentTotalBps = data.categories
    .filter((c) => !c.archived && c.allocation.mode === 'percent')
    .reduce((sum, c) => sum + c.allocation.value, 0);
  const fixedTotal = data.categories
    .filter((c) => !c.archived && c.allocation.mode === 'fixed')
    .reduce((sum, c) => sum + c.allocation.value, 0);

  return (
    <>
      <header className="page-header">
        <h1 className="page-title">Budget</h1>
        <p className="page-subtitle">
          Give every category a percentage of income or a fixed amount — mix the two freely. Each
          category can be split into subcategories that take a share of their parent.
        </p>
      </header>

      <div className="kpi-row">
        <StatTile label="Monthly income" value={fmt(income)} sub={`${data.incomeSources.length} source${data.incomeSources.length === 1 ? '' : 's'}`} />
        <StatTile
          label="Budgeted"
          value={fmt(summary.totalBudgetedCents)}
          sub={income > 0 ? `${bpsToPercent(toBps(summary.totalBudgetedCents, income)).toFixed(1)}% of income` : 'Set your income first'}
        />
        <StatTile
          label={summary.unallocatedCents < 0 ? 'Over-allocated' : 'Unallocated'}
          value={fmt(Math.abs(summary.unallocatedCents))}
          tone={summary.unallocatedCents < 0 ? 'bad' : summary.unallocatedCents === 0 ? 'good' : undefined}
          sub={
            summary.unallocatedCents < 0
              ? 'Your budget spends more than you earn'
              : summary.unallocatedCents === 0
                ? 'Every dollar has a job'
                : 'Not yet assigned to a category'
          }
        />
        <StatTile
          label="Needs / wants / savings"
          value={
            income > 0
              ? `${bpsToPercent(summary.byGroup.needs.shareBps).toFixed(0)} / ${bpsToPercent(summary.byGroup.wants.shareBps).toFixed(0)} / ${bpsToPercent(summary.byGroup.savings.shareBps).toFixed(0)}`
              : '—'
          }
          sub="Percent of income by type"
        />
      </div>

      <div className="stack">
        {income === 0 && (
          <Callout tone="warning">
            <strong>Add your monthly take-home pay below.</strong> Percentage-based categories
            resolve to zero until there's income to take a percentage of.
          </Callout>
        )}

        {summary.overAllocated && income > 0 && (
          <Callout tone="critical">
            Your categories claim <strong>{fmt(summary.totalBudgetedCents)}</strong> against{' '}
            {fmt(income)} of income — {fmt(-summary.unallocatedCents)} more than you bring in.
            Reduce a category or use <em>Scale percentages to fit</em>.
          </Callout>
        )}

        <Card
          title="Income"
          note="Take-home pay, after tax and payroll deductions. Percentages resolve against this total."
          actions={
            <button type="button" className="btn btn-sm" onClick={() => addIncomeSource()}>
              + Add source
            </button>
          }
        >
          {data.incomeSources.length === 0 ? (
            <EmptyState icon="◎" title="No income sources">
              Add one to start budgeting by percentage.
            </EmptyState>
          ) : (
            <div className="stack-sm">
              {data.incomeSources.map((source) => (
                <div
                  key={source.id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(120px, 1fr) auto auto auto',
                    gap: 9,
                    alignItems: 'center',
                  }}
                >
                  <input
                    type="text"
                    value={source.name}
                    aria-label="Income source name"
                    onChange={(e) => updateIncomeSource(source.id, { name: e.target.value })}
                  />
                  <select
                    value={source.kind}
                    aria-label="Income type"
                    style={{ width: 'auto' }}
                    onChange={(e) =>
                      updateIncomeSource(source.id, { kind: e.target.value as IncomeKind })
                    }
                  >
                    {INCOME_KINDS.map((k) => (
                      <option key={k.value} value={k.value}>
                        {k.label}
                      </option>
                    ))}
                  </select>
                  <span style={{ width: 120 }}>
                    <MoneyInput
                      valueCents={source.monthlyCents}
                      ariaLabel={`${source.name} monthly amount`}
                      onCommit={(monthlyCents) => updateIncomeSource(source.id, { monthlyCents })}
                    />
                  </span>
                  <ConfirmButton
                    onConfirm={() => removeIncomeSource(source.id)}
                    confirmLabel="Remove"
                    title={`Remove ${source.name}`}
                  >
                    ✕
                  </ConfirmButton>
                </div>
              ))}
              <div className="row-between" style={{ borderTop: '1px solid var(--border)', paddingTop: 9 }}>
                <span className="field-label">Total monthly income</span>
                <strong className="mono-num">{fmt(income)}</strong>
              </div>
            </div>
          )}
        </Card>

        <ChartFrame
          title="How your income is allocated"
          note={`${bpsToPercent(percentTotalBps).toFixed(1)}% assigned by percentage${fixedTotal > 0 ? `, plus ${fmt(fixedTotal)} in fixed amounts` : ''}.`}
          table={<ShareTable slices={slices} totalCents={income} valueHeader="Monthly budget" />}
        >
          <StackedShareBar
            slices={slices}
            totalCents={income}
            emptyLabel="Add income and category allocations to see the split."
          />
        </ChartFrame>

        <Card
          title="Categories"
          note="Expand a category to manage its subcategories."
          actions={
            <div className="btn-row">
              {income > 0 && percentTotalBps > 0 && (
                <button
                  type="button"
                  className="btn btn-sm"
                  title="Scale every percentage category proportionally so the budget totals 100% of income, leaving fixed amounts alone"
                  onClick={() =>
                    replaceAll({
                      ...data,
                      categories: normalizePercentages(data.categories, income),
                    })
                  }
                >
                  Scale percentages to fit
                </button>
              )}
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => addCategory({ color: CATEGORY_COLOR_CHOICES[data.categories.length % CATEGORY_COLOR_CHOICES.length]! })}
              >
                + Add category
              </button>
            </div>
          }
        >
          {data.categories.length === 0 ? (
            <EmptyState icon="▤" title="No categories yet">
              Add your first category to start allocating income.
            </EmptyState>
          ) : (
            <div>
              {data.categories.map((category) => (
                <CategoryRow key={category.id} category={category} incomeCents={income} />
              ))}
            </div>
          )}
        </Card>

        <Card
          title="This month against budget"
          note="Spending recorded in the current month, per category."
        >
          {summary.totalSpentCents === 0 ? (
            <EmptyState icon="◔" title="No spending recorded this month">
              Scan a receipt or add a transaction to see it here.
            </EmptyState>
          ) : (
            <div className="stack-sm">
              {summary.categories
                .filter((r) => r.budgetCents > 0 || r.spentCents !== 0)
                .map((r) => {
                  const status = budgetStatus(r.spentCents, r.budgetCents);
                  return (
                    <Meter
                      key={r.category.id}
                      label={
                        <>
                          <span
                            className="swatch"
                            style={{ background: seriesColor(r.category.color) }}
                            aria-hidden="true"
                          />{' '}
                          {r.category.name}
                        </>
                      }
                      valueCents={r.spentCents}
                      limitCents={r.budgetCents}
                      color={seriesColor(r.category.color)}
                      statusColor={status.color}
                      statusLabel={
                        r.spentCents > r.budgetCents && r.budgetCents > 0
                          ? `${status.label} by ${fmt(r.spentCents - r.budgetCents)}`
                          : undefined
                      }
                    />
                  );
                })}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

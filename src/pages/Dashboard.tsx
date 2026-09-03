import { useMemo } from 'react';
import { useStore } from '../store';
import {
  currentMonthKey,
  monthlyBudgetedSavings,
  monthlyFundedSpending,
  resolveBudget,
  spendingByMonth,
} from '../lib/budget';
import { computeFIStatus } from '../lib/fi';
import { computeNetWorth, summarizePortfolio } from '../lib/investments';
import { bpsToPercent } from '../lib/money';
import { budgetStatus, foldToOther } from '../lib/palette';
import {
  Callout,
  Card,
  ChartFrame,
  EmptyState,
  Meter,
  StatTile,
  useFormatMoney,
} from '../components/ui';
import {
  monthLabel,
  MoneyTable,
  ShareTable,
  SpendTrendChart,
  StackedShareBar,
  useSeriesColor,
} from '../components/charts';
import type { View } from '../App';

/**
 * The dashboard answers four questions in order: am I on track this month, how
 * far along am I overall, where is the money going, and what is trending. The
 * headline is FI progress rather than a balance — a balance is a fact, progress
 * is the thing the app is actually for.
 */
export default function Dashboard({ onNavigate }: { onNavigate: (view: View) => void }) {
  const data = useStore((s) => s.data);
  const fmt = useFormatMoney();
  const seriesColor = useSeriesColor();

  const month = currentMonthKey();
  const summary = useMemo(
    () => resolveBudget(data.categories, data.incomeSources, data.transactions, month),
    [data.categories, data.incomeSources, data.transactions, month],
  );
  const portfolio = useMemo(() => summarizePortfolio(data.accounts), [data.accounts]);
  const netWorth = useMemo(
    () => computeNetWorth(data.accounts, data.otherAssets, data.liabilities),
    [data.accounts, data.otherAssets, data.liabilities],
  );

  const fundedSpending = monthlyFundedSpending(summary);
  const contribution =
    monthlyBudgetedSavings(summary) + portfolio.monthlyEmployerMatchCents;

  const status = useMemo(
    () =>
      computeFIStatus({
        settings: data.settings.fi,
        monthlyFundedSpendingCents: fundedSpending,
        monthlyIncomeCents: summary.monthlyIncomeCents,
        fiAssetsCents: netWorth.fiAssetsCents,
        monthlyContributionCents: contribution,
      }),
    [data.settings.fi, fundedSpending, summary.monthlyIncomeCents, netWorth.fiAssetsCents, contribution],
  );

  const trend = useMemo(() => spendingByMonth(data.transactions, 6), [data.transactions]);

  const spentSlices = useMemo(
    () =>
      foldToOther(
        summary.categories.map((r) => ({
          id: r.category.id,
          label: r.category.name,
          valueCents: r.spentCents,
          color: r.category.color,
        })),
      ),
    [summary],
  );

  const recent = useMemo(
    () =>
      [...data.transactions]
        .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt)
        .slice(0, 6),
    [data.transactions],
  );

  const categoryName = useMemo(
    () => new Map(data.categories.map((c) => [c.id, c.name])),
    [data.categories],
  );

  const isFresh = summary.monthlyIncomeCents === 0 && data.transactions.length === 0;
  const overspent = summary.categories.filter(
    (r) => r.budgetCents > 0 && r.spentCents > r.budgetCents,
  );

  return (
    <>
      <header className="page-header">
        <h1 className="page-title">Overview</h1>
        <p className="page-subtitle">
          {new Date().toLocaleDateString(undefined, { month: 'long', year: 'numeric' })} — spending
          against budget, and how far along you are.
        </p>
      </header>

      {isFresh && (
        <div style={{ marginBottom: 18 }}>
          <Callout>
            <strong>Welcome.</strong> Two things make everything else work: your monthly take-home
            pay on the{' '}
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              style={{ padding: '0 3px' }}
              onClick={() => onNavigate('budget')}
            >
              Budget
            </button>{' '}
            page, and your accounts on the{' '}
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              style={{ padding: '0 3px' }}
              onClick={() => onNavigate('investments')}
            >
              Investments
            </button>{' '}
            page. Then scan a receipt and it lands in the right category.
          </Callout>
        </div>
      )}

      <div className="kpi-row">
        <StatTile
          label="Spent this month"
          value={fmt(summary.totalSpentCents)}
          sub={
            summary.totalBudgetedCents > 0
              ? `of ${fmt(summary.totalBudgetedCents)} budgeted`
              : 'No budget set yet'
          }
          tone={summary.totalSpentCents > summary.totalBudgetedCents && summary.totalBudgetedCents > 0 ? 'bad' : undefined}
        />
        <StatTile
          label="Net worth"
          value={fmt(netWorth.netWorthCents, false)}
          sub={
            netWorth.totalLiabilitiesCents > 0
              ? `after ${fmt(netWorth.totalLiabilitiesCents, false)} of debt`
              : `${fmt(portfolio.totalValueCents, false)} invested`
          }
        />
        <StatTile
          label="Savings rate"
          value={
            summary.monthlyIncomeCents > 0 ? `${bpsToPercent(status.savings.rateBps).toFixed(1)}%` : '—'
          }
          tone={status.savings.rateBps >= 2000 ? 'good' : status.savings.rateBps < 0 ? 'bad' : undefined}
          sub={
            summary.monthlyIncomeCents > 0
              ? `${fmt(status.savings.savedCents)} a month not spent`
              : 'Add your income to see this'
          }
        />
        <StatTile
          label="Time to FI"
          value={
            status.fiNumberCents === 0
              ? '—'
              : status.projection.yearsToFI === null
                ? 'Off track'
                : status.projection.yearsToFI === 0
                  ? 'Reached'
                  : `${status.projection.yearsToFI.toFixed(1)} yrs`
          }
          sub={
            status.fiNumberCents === 0
              ? 'Set a budget to compute this'
              : `${bpsToPercent(status.progressBps).toFixed(1)}% of ${fmt(status.fiNumberCents, false)}`
          }
        />
      </div>

      <div className="stack">
        {status.fiNumberCents > 0 && (
          <Card>
            <div className="row-between" style={{ alignItems: 'flex-start', marginBottom: 14 }}>
              <div>
                <div className="stat-label">Progress to financial independence</div>
                <div className="hero-figure">{bpsToPercent(status.progressBps).toFixed(1)}%</div>
                <div className="stat-sub">
                  {fmt(netWorth.fiAssetsCents, false)} of {fmt(status.fiNumberCents, false)} —{' '}
                  {status.currentMonthlyPassiveIncomeCents > 0 ? (
                    <>
                      already covering {bpsToPercent(status.coverageBps).toFixed(0)}% of your monthly
                      spending
                    </>
                  ) : (
                    'add investment accounts to start tracking'
                  )}
                </div>
              </div>
              <button type="button" className="btn btn-sm" onClick={() => onNavigate('fi')}>
                See the projection
              </button>
            </div>
            <Meter
              label=""
              valueCents={netWorth.fiAssetsCents}
              limitCents={status.fiNumberCents}
              color="var(--series-1)"
              right={
                status.projection.fiDate
                  ? `On track for ${status.projection.fiDate.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}`
                  : undefined
              }
            />
          </Card>
        )}

        {overspent.length > 0 && (
          <Callout tone="critical">
            <strong>
              Over budget in {overspent.length} categor{overspent.length === 1 ? 'y' : 'ies'}:
            </strong>{' '}
            {overspent
              .map((r) => `${r.category.name} by ${fmt(r.spentCents - r.budgetCents)}`)
              .join(', ')}
            .
          </Callout>
        )}

        <div className="grid grid-2">
          <Card
            title="This month by category"
            note="Spent against budget."
            actions={
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => onNavigate('budget')}>
                Edit budget
              </button>
            }
          >
            {summary.categories.length === 0 ? (
              <EmptyState icon="▤" title="No categories yet" />
            ) : (
              <div className="stack-sm">
                {summary.categories
                  .filter((r) => r.budgetCents > 0)
                  .slice(0, 8)
                  .map((r) => {
                    const st = budgetStatus(r.spentCents, r.budgetCents);
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
                        statusColor={st.color}
                        statusLabel={
                          r.spentCents > r.budgetCents
                            ? `${st.label} by ${fmt(r.spentCents - r.budgetCents)}`
                            : undefined
                        }
                      />
                    );
                  })}
              </div>
            )}
          </Card>

          <ChartFrame
            title="Where this month went"
            note="Actual spending, by category."
            table={<ShareTable slices={spentSlices} totalCents={summary.totalSpentCents} valueHeader="Spent" />}
          >
            {summary.totalSpentCents === 0 ? (
              <EmptyState icon="◔" title="Nothing recorded yet">
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  style={{ marginTop: 8 }}
                  onClick={() => onNavigate('receipts')}
                >
                  Scan a receipt
                </button>
              </EmptyState>
            ) : (
              <StackedShareBar slices={spentSlices} totalCents={summary.totalSpentCents} />
            )}
          </ChartFrame>
        </div>

        <ChartFrame
          title="Spending over the last six months"
          note="Total recorded spending per month, against your monthly budget."
          table={
            <MoneyTable
              columns={[{ label: 'Month' }, { label: 'Spent', numeric: true }]}
              rows={trend.map((t) => ({
                key: t.month,
                cells: [monthLabel(t.month), fmt(t.spentCents)],
              }))}
              totalRow={['Total', fmt(trend.reduce((sum, t) => sum + t.spentCents, 0))]}
            />
          }
        >
          <SpendTrendChart data={trend} budgetCents={summary.totalBudgetedCents} />
        </ChartFrame>

        <Card
          title="Recent transactions"
          actions={
            <div className="btn-row">
              <button type="button" className="btn btn-sm" onClick={() => onNavigate('transactions')}>
                See all
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => onNavigate('receipts')}
              >
                Scan a receipt
              </button>
            </div>
          }
        >
          {recent.length === 0 ? (
            <EmptyState icon="▢" title="No transactions yet">
              Photograph a receipt and it's read on this device, then filed into a category.
            </EmptyState>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Merchant</th>
                    <th>Category</th>
                    <th className="num">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((t) => (
                    <tr key={t.id}>
                      <td className="secondary mono-num" style={{ whiteSpace: 'nowrap' }}>
                        {t.date}
                      </td>
                      <td>
                        {t.merchant}
                        {t.receiptId && (
                          <span className="badge" style={{ marginLeft: 6 }}>
                            photo
                          </span>
                        )}
                      </td>
                      <td className="secondary">
                        {t.categoryId ? (
                          (categoryName.get(t.categoryId) ?? <span className="muted">Removed</span>)
                        ) : (
                          <span className="muted">Uncategorized</span>
                        )}
                      </td>
                      <td className="num mono-num">{fmt(t.amountCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

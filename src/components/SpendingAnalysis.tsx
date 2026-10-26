import { useState } from 'react';
import type { SpendingAnalysis } from '../lib/spending';
import { MIN_MONTHS_FOR_TREND, completeMonths } from '../lib/spending';
import type { Finding, Severity } from '../lib/analysis';
import { STATUS } from '../lib/palette';
import { bpsToPercent } from '../lib/money';
import { Card, useFormatMoney } from './ui';
import { MoneyTable } from './charts';

/**
 * What the spending history says, as opposed to what the current month shows.
 *
 * The card above this one already answers "what did I spend against budget
 * this month". This answers the questions that need several months at once:
 * which budgets have never once held, which are so loose they are not really
 * budgets, whether the whole thing is drifting, and how much of the spending
 * has no name attached.
 *
 * Same shape as the portfolio findings — headline you can read at a glance,
 * reasoning one tap below — because it is the same job.
 */

const SEVERITY_STYLE: Record<Severity, { color: string; icon: string }> = {
  critical: { color: STATUS.critical, icon: '⚠' },
  serious: { color: STATUS.serious, icon: '!' },
  warning: { color: STATUS.warning, icon: '!' },
  neutral: { color: 'var(--text-muted)', icon: 'ℹ' },
  good: { color: STATUS.good, icon: '✓' },
};

function FindingRow({ finding }: { finding: Finding }) {
  const [open, setOpen] = useState(false);
  const style = SEVERITY_STYLE[finding.severity];

  return (
    <li className="finding">
      <button
        type="button"
        className="finding-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="finding-icon" style={{ color: style.color }} aria-hidden="true">
          {style.icon}
        </span>
        <span className="finding-title">{finding.title}</span>
        <span className="finding-toggle" aria-hidden="true">
          {open ? '−' : '+'}
        </span>
      </button>
      {open && <p className="finding-detail">{finding.detail}</p>}
    </li>
  );
}

export default function SpendingAnalysisCard({ analysis }: { analysis: SpendingAnalysis }) {
  const fmt = useFormatMoney();
  const complete = completeMonths(analysis.history);
  // A category with no spending in any month has nothing to say here; a row of
  // dashes for each one buries the categories that do.
  const used = analysis.patterns.filter((p) => p.averageCents !== 0);
  const untouched = analysis.patterns.length - used.length;

  const note =
    complete.length >= MIN_MONTHS_FOR_TREND
      ? `Across ${complete.length} complete months. The current month is excluded — half a month is not a small month.`
      : 'Builds up as you record more months.';

  return (
    <Card title="What your spending says" note={note}>
      <div className="stack-sm">
        <ul className="finding-list">
          {analysis.findings.map((f) => (
            <FindingRow key={f.id} finding={f} />
          ))}
        </ul>

        {used.length > 0 && complete.length >= 2 && (
          <>
            <h3 className="subhead">Each category, month in and month out</h3>
            <MoneyTable
              columns={[
                { label: 'Category' },
                { label: 'Budget', numeric: true },
                { label: 'Typical', numeric: true },
                { label: 'Of budget', numeric: true },
                { label: 'Over', numeric: true },
              ]}
              rows={used.map((p) => ({
                key: p.categoryId,
                cells: [
                  p.name,
                  p.budgetCents > 0 ? fmt(p.budgetCents, false) : '—',
                  fmt(p.averageCents, false),
                  p.usageBps > 0 ? `${bpsToPercent(p.usageBps).toFixed(0)}%` : '—',
                  `${p.monthsOver}/${p.monthsObserved}`,
                ],
              }))}
            />
            <p className="field-hint" style={{ margin: 0 }}>
              "Typical" is the average across complete months, not this month. "Over" counts the
              months the category finished above its budget.
              {untouched > 0 && (
                <>
                  {' '}
                  {untouched} categor{untouched === 1 ? 'y has' : 'ies have'} no recorded spending
                  at all and {untouched === 1 ? 'is' : 'are'} left out — which is itself worth a
                  look, since {untouched === 1 ? 'its budget is' : 'their budgets are'} still
                  claiming income.
                </>
              )}
            </p>
          </>
        )}

        {analysis.merchants.length > 0 && (
          <>
            <h3 className="subhead">Where it actually went</h3>
            <MoneyTable
              columns={[
                { label: 'Merchant' },
                { label: 'Visits', numeric: true },
                { label: 'Total', numeric: true },
              ]}
              rows={analysis.merchants.map((m) => ({
                key: m.merchant,
                cells: [m.merchant, String(m.count), fmt(m.totalCents, false)],
              }))}
            />
          </>
        )}
      </div>
    </Card>
  );
}

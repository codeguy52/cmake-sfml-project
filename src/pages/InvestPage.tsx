import { useMemo, useState } from 'react';
import { useStore } from '../store';
import { currentMonthKey, resolveBudget } from '../lib/budget';
import { buildGuidancePlan, type GuidanceStep, type StepStatus } from '../lib/guidance';
import { summarizePortfolio } from '../lib/investments';
import { bpsToPercent } from '../lib/money';
import { STATUS } from '../lib/palette';
import {
  Callout,
  Card,
  EmptyState,
  Meter,
  Segmented,
  StatTile,
  useFormatMoney,
} from '../components/ui';
import type { View } from '../App';

/**
 * "How to invest".
 *
 * Two halves that answer different questions: *what should I do next* (the
 * order of operations, computed from the user's own numbers) and *what do
 * these words mean* (reference material).
 *
 * The line this page does not cross: it will tell you that a 0.75% expense
 * ratio costs you a specific number of dollars, because that is arithmetic on
 * your data. It will not tell you what to buy instead.
 */

const STATUS_STYLE: Record<StepStatus, { label: string; color: string; icon: string }> = {
  done: { label: 'Done', color: STATUS.good, icon: '✓' },
  current: { label: 'Do this next', color: STATUS.warning, icon: '→' },
  todo: { label: 'Later', color: 'var(--text-muted)', icon: '·' },
  not_applicable: { label: "Doesn't apply", color: 'var(--text-muted)', icon: '–' },
};

function StepRow({ step, index, isNext }: { step: GuidanceStep; index: number; isNext: boolean }) {
  // Several steps can legitimately be in progress at once, but only one is
  // *next* — showing "Do this next" twice makes the whole list unreadable.
  const style =
    step.status === 'current' && !isNext
      ? { label: 'In progress', color: 'var(--text-secondary)', icon: '·' }
      : STATUS_STYLE[step.status];
  const fmt = useFormatMoney();

  return (
    <li
      style={{
        display: 'grid',
        gridTemplateColumns: 'auto minmax(0, 1fr)',
        gap: 12,
        padding: '13px 0',
        borderTop: '1px solid var(--border)',
        opacity: step.status === 'not_applicable' ? 0.6 : 1,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 26,
          height: 26,
          borderRadius: '50%',
          display: 'grid',
          placeItems: 'center',
          fontSize: 13,
          fontWeight: 700,
          color: step.status === 'done' ? '#fff' : 'var(--text-secondary)',
          background: step.status === 'done' ? STATUS.good : 'var(--surface-sunken)',
          border: isNext ? `2px solid ${STATUS.warning}` : '1px solid var(--border)',
          flexShrink: 0,
        }}
      >
        {step.status === 'done' ? '✓' : index + 1}
      </span>

      <div style={{ minWidth: 0 }}>
        <div className="row-between" style={{ gap: 8, marginBottom: 2 }}>
          <strong style={{ fontSize: 14.5 }}>{step.title}</strong>
          <span className="badge" style={{ color: style.color, borderColor: style.color }}>
            {style.icon} {style.label}
          </span>
        </div>
        <div className="field-hint" style={{ marginBottom: 5 }}>
          {step.why}
        </div>
        <div style={{ fontSize: 13.5 }}>{step.detail}</div>
        {step.amountCents !== undefined && step.amountCents > 0 && step.status === 'current' && (
          <div
            className="mono-num"
            style={{ marginTop: 6, fontSize: 13, fontWeight: 600, color: STATUS.warning }}
          >
            {fmt(step.amountCents)} at stake
          </div>
        )}
      </div>
    </li>
  );
}

function Learn() {
  return (
    <div className="stack">
      <Card title="The short version">
        <p style={{ marginTop: 0 }}>
          Buy broad, low-cost index funds; buy them automatically every month; leave them alone for
          decades. Almost everything else in investing is a variation on that sentence, an attempt
          to sell you something, or both.
        </p>
        <p style={{ marginBottom: 0 }}>
          The three things that actually move the outcome, roughly in order of how much control you
          have over them: <strong>how much you invest</strong>, <strong>how long you leave it</strong>
          , and <strong>what you pay in fees</strong>. Picking investments comes a distant fourth,
          and picking the <em>moment</em> to invest is mostly noise.
        </p>
      </Card>

      <div className="grid grid-2">
        <Card title="Why index funds">
          <p style={{ marginTop: 0 }}>
            An index fund buys the whole market instead of guessing which parts will win. That
            sounds like settling for average — it isn't, because "average" here means the
            money-weighted return of every professional trying to beat it, before their fees.
          </p>
          <p style={{ marginBottom: 0 }}>
            Over long periods the large majority of actively managed funds underperform their index
            after costs, and the ones that win in one decade are not reliably the ones that win in
            the next. Owning everything sidesteps having to identify them in advance.
          </p>
        </Card>

        <Card title="What fees really cost">
          <p style={{ marginTop: 0 }}>
            An expense ratio is charged on your <em>balance</em>, every year, whether the fund goes
            up or down. It compounds against you exactly as returns compound for you.
          </p>
          <p style={{ marginBottom: 0 }}>
            The difference between 0.05% and 0.75% sounds trivial. On a portfolio held for thirty
            years it routinely costs a fifth of the final balance. This is the one input you can
            change today with certainty — the Investments page shows your blended rate.
          </p>
        </Card>

        <Card title="Accounts before investments">
          <p style={{ marginTop: 0 }}>
            The account type is a tax wrapper; the fund is what goes inside it. Getting the wrapper
            right is usually worth more than getting the fund right.
          </p>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13.5 }}>
            <li>
              <strong>Traditional 401(k)/IRA</strong> — deduct now, pay tax on withdrawal. Better if
              your tax rate is lower in retirement.
            </li>
            <li>
              <strong>Roth</strong> — pay tax now, withdraw tax-free. Better if your rate is higher
              later, which favours the early-career.
            </li>
            <li>
              <strong>HSA</strong> — deductible, grows untaxed, tax-free for medical costs. The only
              triple-advantaged account, if you have a qualifying health plan.
            </li>
            <li>
              <strong>Taxable brokerage</strong> — no perks, no limits, no withdrawal age. This is
              the account that funds retiring early.
            </li>
          </ul>
        </Card>

        <Card title="Risk, honestly">
          <p style={{ marginTop: 0 }}>
            Stocks return more than bonds because they are genuinely worse to hold. A globally
            diversified portfolio has fallen by half and taken years to recover, more than once.
          </p>
          <p style={{ marginBottom: 0 }}>
            The usual heuristic is that money you need within five years does not belong in stocks.
            Beyond that, the right mix is the most aggressive one you will actually hold through a
            crash without selling — an allocation you abandon at the bottom is worse than a
            conservative one you keep.
          </p>
        </Card>
      </div>

      <Card title="Things that reliably go wrong">
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          <li>
            <strong>Waiting for a better entry point.</strong> Time in the market beats timing it;
            the best days cluster next to the worst ones, and missing a handful of them wrecks a
            decade of returns.
          </li>
          <li>
            <strong>Selling during a crash.</strong> This is how a temporary decline becomes a
            permanent loss. A written plan made calmly is protection against your future self.
          </li>
          <li>
            <strong>Leaving contributions in cash.</strong> Money paid into a retirement account
            often sits uninvested until you choose a fund. Check.
          </li>
          <li>
            <strong>Chasing last year's winner.</strong> Past performance is the most heavily
            marketed and least predictive number available.
          </li>
          <li>
            <strong>Anything urgent.</strong> Nothing that compounds over thirty years needs a
            decision this afternoon.
          </li>
        </ul>
      </Card>

      <Callout tone="warning">
        <strong>This is education, not financial advice.</strong> It's general information, and
        general information cannot account for your tax situation, your job security, your health,
        your family, or your temperament. The sequencing below is a widely used rule of thumb, not
        a recommendation tailored to you. For decisions that matter, talk to a fee-only fiduciary
        adviser — one paid by you rather than by commission on what they sell you.
      </Callout>
    </div>
  );
}

export default function InvestPage({ onNavigate }: { onNavigate: (view: View) => void }) {
  const data = useStore((s) => s.data);
  const fmt = useFormatMoney();
  const [tab, setTab] = useState<'plan' | 'learn'>('plan');

  const month = currentMonthKey();
  const summary = useMemo(
    () => resolveBudget(data.categories, data.incomeSources, data.transactions, month),
    [data.categories, data.incomeSources, data.transactions, month],
  );
  const portfolio = useMemo(() => summarizePortfolio(data.accounts), [data.accounts]);

  const plan = useMemo(
    () =>
      buildGuidancePlan({
        accounts: data.accounts,
        liabilities: data.liabilities,
        otherAssets: data.otherAssets,
        fi: data.settings.fi,
        monthlyNeedsCents: summary.byGroup.needs.budgetCents,
        monthlyWantsCents: summary.byGroup.wants.budgetCents,
        monthlySavingsCents: summary.byGroup.savings.budgetCents,
      }),
    [data.accounts, data.liabilities, data.otherAssets, data.settings.fi, summary],
  );

  const hasBudget = summary.monthlyIncomeCents > 0;
  const nextStep = plan.steps.find((s) => s.id === plan.currentStepId);

  return (
    <>
      <header className="page-header">
        <h1 className="page-title">How to invest</h1>
        <p className="page-subtitle">
          The order most people should put money in, checked against your actual numbers — plus
          what the terms mean. General education, not advice tailored to you.
        </p>
      </header>

      <div style={{ marginBottom: 18 }}>
        <Segmented
          ariaLabel="Invest view"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'plan', label: 'Your next step' },
            { value: 'learn', label: 'Learn the basics' },
          ]}
        />
      </div>

      {tab === 'learn' ? (
        <Learn />
      ) : (
        <div className="stack">
          {!hasBudget && (
            <Callout tone="warning">
              <strong>Add your income and budget first.</strong> Several steps below are measured
              against your monthly spending, so they stay blank until the{' '}
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                style={{ padding: '0 3px' }}
                onClick={() => onNavigate('budget')}
              >
                Budget
              </button>{' '}
              page has numbers in it.
            </Callout>
          )}

          <div className="kpi-row">
            <StatTile
              label="Emergency fund"
              value={
                plan.monthlyEssentialCents > 0
                  ? `${plan.monthsOfExpensesHeld.toFixed(1)} mo`
                  : '—'
              }
              tone={plan.monthsOfExpensesHeld >= 3 ? 'good' : undefined}
              sub={`${fmt(plan.cashCents, false)} in cash`}
            />
            <StatTile
              label="Unclaimed match"
              value={fmt(plan.unclaimedMatchCents)}
              tone={plan.unclaimedMatchCents > 0 ? 'bad' : 'good'}
              sub={
                plan.unclaimedMatchCents > 0
                  ? `${fmt(plan.unclaimedMatchCents * 12)} a year forgone`
                  : 'Nothing left on the table'
              }
            />
            <StatTile
              label="Expensive debt"
              value={fmt(plan.highRateDebtCents, false)}
              tone={plan.highRateDebtCents > 0 ? 'bad' : 'good'}
              sub={`Above your ${bpsToPercent(data.settings.fi.expectedReturnBps).toFixed(1)}% expected return`}
            />
            <StatTile
              label="Blended fees"
              value={
                portfolio.totalValueCents > 0
                  ? `${bpsToPercent(portfolio.blendedExpenseRatioBps).toFixed(2)}%`
                  : '—'
              }
              tone={
                portfolio.totalValueCents === 0
                  ? undefined
                  : portfolio.blendedExpenseRatioBps > 50
                    ? 'bad'
                    : 'good'
              }
              sub={
                portfolio.totalValueCents > 0
                  ? `${fmt(portfolio.annualFeeDragCents)} a year`
                  : 'Add holdings to see this'
              }
            />
          </div>

          {nextStep && (
            <Card>
              <div className="stat-label">Your next step</div>
              <div style={{ fontSize: 20, fontWeight: 660, letterSpacing: '-0.01em', margin: '4px 0 6px' }}>
                {nextStep.title}
              </div>
              <div className="secondary" style={{ fontSize: 13.5 }}>
                {nextStep.detail}
              </div>
            </Card>
          )}

          <Card
            title="The order of operations"
            note="A widely used sequence, evaluated against your data. Skip anything that doesn't fit your situation."
          >
            <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {plan.steps.map((step, i) => (
                <StepRow
                  key={step.id}
                  step={step}
                  index={i}
                  isNext={step.id === plan.currentStepId}
                />
              ))}
            </ol>
          </Card>

          {plan.monthlyEssentialCents > 0 && (
            <Card title="Emergency fund progress" note="Measured against one and three months of needs.">
              <div className="stack-sm">
                <Meter
                  label="Starter — one month of needs"
                  valueCents={Math.min(plan.cashCents, plan.starterFundTargetCents)}
                  limitCents={plan.starterFundTargetCents}
                  color="var(--series-3)"
                />
                <Meter
                  label="Full — three months of needs"
                  valueCents={Math.min(plan.cashCents, plan.fullFundTargetCents)}
                  limitCents={plan.fullFundTargetCents}
                  color="var(--series-1)"
                />
              </div>
            </Card>
          )}

          {plan.observations.length > 0 && (
            <Card title="On your portfolio" note="Arithmetic on your own holdings.">
              <div className="stack-sm">
                {plan.observations.map((o) => (
                  <Callout
                    key={o.id}
                    tone={o.severity === 'good' ? 'good' : o.severity === 'serious' ? 'critical' : 'warning'}
                  >
                    <strong>{o.title}</strong>
                    <div style={{ marginTop: 2 }}>{o.detail}</div>
                  </Callout>
                ))}
              </div>
            </Card>
          )}

          {data.accounts.length === 0 && (
            <Card>
              <EmptyState icon="◫" title="No investment accounts yet">
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  style={{ marginTop: 8 }}
                  onClick={() => onNavigate('investments')}
                >
                  Add or link an account
                </button>
              </EmptyState>
            </Card>
          )}

          <Callout tone="warning">
            <strong>Education, not advice.</strong> This sequence is a general rule of thumb applied
            to numbers you entered. It knows nothing about your tax situation, job security, health
            or family. For decisions that matter, talk to a fee-only fiduciary adviser.
          </Callout>
        </div>
      )}
    </>
  );
}

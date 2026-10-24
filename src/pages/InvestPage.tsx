import { useMemo, useState } from 'react';
import { useStore } from '../store';
import { currentMonthKey, monthlyFundedSpending, resolveBudget } from '../lib/budget';
import { buildGuidancePlan, type GuidanceStep, type StepStatus } from '../lib/guidance';
import { summarizePortfolio } from '../lib/investments';
import { analyzePortfolio, PENALTY_FREE_AGE, type Finding, type Severity } from '../lib/analysis';
import { bpsToPercent } from '../lib/money';
import { STATUS } from '../lib/palette';
import { ShareTable, StackedShareBar } from '../components/charts';
import { foldToOther, slotColor } from '../lib/palette';
import {
  Callout,
  Card,
  ChartFrame,
  EmptyState,
  Meter,
  Segmented,
  StatTile,
  useFormatMoney,
} from '../components/ui';
import type { AssetClass, TaxTreatment } from '../types';
import type { View } from '../App';

/**
 * "How to invest".
 *
 * Three questions, in the order someone actually asks them: *what does my
 * portfolio look like*, *what is wrong with it*, and *what do I do next*. The
 * reference material sits underneath, collapsed, because nobody opening this
 * page for the fourth time wants to scroll past an essay on index funds to
 * reach their own numbers.
 *
 * The line this page does not cross: it will tell you that a 0.75% expense
 * ratio costs you a specific number of dollars, or that 40% of your money is
 * in one ticker. It will not tell you what to buy instead.
 */

const SEVERITY_STYLE: Record<Severity, { color: string; icon: string; label: string }> = {
  critical: { color: STATUS.critical, icon: '⚠', label: 'Needs attention' },
  serious: { color: STATUS.serious, icon: '!', label: 'Worth looking at' },
  warning: { color: STATUS.warning, icon: '!', label: 'Worth looking at' },
  neutral: { color: 'var(--text-muted)', icon: 'ℹ', label: 'For information' },
  good: { color: STATUS.good, icon: '✓', label: 'Looking fine' },
};

const STATUS_STYLE: Record<StepStatus, { label: string; color: string; icon: string }> = {
  done: { label: 'Done', color: STATUS.good, icon: '✓' },
  current: { label: 'Do this next', color: STATUS.warning, icon: '→' },
  todo: { label: 'Later', color: 'var(--text-muted)', icon: '·' },
  not_applicable: { label: "Doesn't apply", color: 'var(--text-muted)', icon: '–' },
};

const TAX_LABELS: Record<TaxTreatment, string> = {
  pretax: 'Pre-tax',
  roth: 'Roth',
  taxable: 'Taxable',
  hsa: 'HSA',
};

const ASSET_LABELS: Record<AssetClass, string> = {
  us_stock: 'US stocks',
  intl_stock: 'International stocks',
  bond: 'Bonds',
  reit: 'Real estate',
  cash: 'Cash',
  crypto: 'Crypto',
  other: 'Unclassified',
};

/**
 * A finding, with its reasoning folded away.
 *
 * The headline is the measurement; the explanation is one tap below it. That
 * ordering is the whole point — a wall of text with the number buried in
 * paragraph three is the thing this page replaced.
 */
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
      <span className="sr-only">{style.label}</span>
      {open && <p className="finding-detail">{finding.detail}</p>}
    </li>
  );
}

function StepRow({ step, index, isNext }: { step: GuidanceStep; index: number; isNext: boolean }) {
  // Several steps can legitimately be in progress at once, but only one is
  // *next* — showing "Do this next" twice makes the whole list unreadable.
  const style =
    step.status === 'current' && !isNext
      ? { label: 'In progress', color: 'var(--text-secondary)', icon: '·' }
      : STATUS_STYLE[step.status];
  const fmt = useFormatMoney();
  const [open, setOpen] = useState(isNext);

  return (
    <li className={`step${step.status === 'not_applicable' ? ' is-muted' : ''}`}>
      <button
        type="button"
        className="step-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="step-index" style={{ color: style.color }} aria-hidden="true">
          {style.icon}
        </span>
        <span>
          <span className="step-title">
            {index}. {step.title}
          </span>
          <span className="step-status" style={{ color: style.color }}>
            {style.label}
            {step.amountCents !== undefined && step.amountCents > 0 && (
              <> · {fmt(step.amountCents)}</>
            )}
          </span>
        </span>
        <span className="finding-toggle" aria-hidden="true">
          {open ? '−' : '+'}
        </span>
      </button>
      {open && <p className="step-detail">{step.detail}</p>}
    </li>
  );
}

/** Reference material, collapsed by default. */
function Lesson({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details className="lesson">
      <summary>{title}</summary>
      <div className="lesson-body">{children}</div>
    </details>
  );
}

export default function InvestPage({ onNavigate }: { onNavigate: (view: View) => void }) {
  const data = useStore((s) => s.data);
  const fmt = useFormatMoney();
  const [tab, setTab] = useState<'analysis' | 'plan' | 'learn'>('analysis');

  const month = currentMonthKey();
  const summary = useMemo(
    () => resolveBudget(data.categories, data.incomeSources, data.transactions, month),
    [data.categories, data.incomeSources, data.transactions, month],
  );
  const portfolio = useMemo(() => summarizePortfolio(data.accounts), [data.accounts]);

  const annualSpendingCents =
    data.settings.fi.annualSpendingOverrideCents ?? monthlyFundedSpending(summary) * 12;

  const analysis = useMemo(
    () => analyzePortfolio(data.accounts, portfolio, data.settings.fi, annualSpendingCents),
    [data.accounts, portfolio, data.settings.fi, annualSpendingCents],
  );

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

  const nextStep = plan.steps.find((s) => s.id === plan.currentStepId);
  const { access, concentration } = analysis;
  const hasPortfolio = portfolio.totalValueCents > 0;

  const classSlices = foldToOther(
    portfolio.byAssetClass.map((c, i) => ({
      id: c.assetClass,
      label: ASSET_LABELS[c.assetClass],
      valueCents: c.valueCents,
      color: slotColor(i),
    })),
  );

  const taxSlices = foldToOther(
    portfolio.byTaxTreatment.map((t, i) => ({
      id: t.taxTreatment,
      label: TAX_LABELS[t.taxTreatment],
      valueCents: t.valueCents,
      color: slotColor(i),
    })),
  );

  const accessSlices = foldToOther([
    {
      id: 'reachable',
      label: 'Reachable any time',
      valueCents: access.reachableCents,
      color: 'var(--series-3)',
    },
    {
      id: 'locked',
      label: `Not before ${PENALTY_FREE_AGE}`,
      valueCents: access.lockedCents,
      color: 'var(--series-7)',
    },
  ]);

  return (
    <>
      <header className="page-header">
        <h1 className="page-title">How to invest</h1>
        <p className="page-subtitle">
          What your portfolio looks like, what's worth fixing, and what to do with the next
          dollar — all computed from your own numbers. None of it names a fund to buy.
        </p>
      </header>

      <div style={{ marginBottom: 16 }}>
        <Segmented
          ariaLabel="Section"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'analysis', label: 'Your portfolio' },
            { value: 'plan', label: 'Next step' },
            { value: 'learn', label: 'Learn' },
          ]}
        />
      </div>

      {tab === 'analysis' &&
        (!hasPortfolio ? (
          <Card>
            <EmptyState icon="◫" title="Nothing to analyse yet">
              <p style={{ maxWidth: '56ch', margin: '0 auto 12px' }}>
                Add an account, import a positions file, or link a brokerage — then this page
                measures what you hold: concentration, fees, how much is reachable before{' '}
                {PENALTY_FREE_AGE}, and what isn't classified.
              </p>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => onNavigate('investments')}
              >
                Go to Investments
              </button>
            </EmptyState>
          </Card>
        ) : (
          <div className="stack">
            <div className="kpi-row">
              <StatTile
                label="Portfolio"
                value={fmt(portfolio.totalValueCents, false)}
                sub={`${concentration.distinctSymbols} distinct holding${concentration.distinctSymbols === 1 ? '' : 's'}`}
              />
              <StatTile
                label="Biggest position"
                value={`${bpsToPercent(concentration.largestShareBps).toFixed(0)}%`}
                sub={concentration.largestLabel || '—'}
                tone={concentration.largestShareBps >= 5_000 ? 'bad' : undefined}
              />
              <StatTile
                label="Fees a year"
                value={fmt(portfolio.annualFeeDragCents, false)}
                sub={`${bpsToPercent(portfolio.blendedExpenseRatioBps).toFixed(2)}% blended`}
                tone={portfolio.blendedExpenseRatioBps >= 50 ? 'bad' : undefined}
              />
              <StatTile
                label={`Reachable before ${PENALTY_FREE_AGE}`}
                value={`${bpsToPercent(access.reachableShareBps).toFixed(0)}%`}
                sub={fmt(access.reachableCents, false)}
              />
            </div>

            {analysis.findings.length > 0 && (
              <Card
                title="What stands out"
                note="Measured from your holdings, worst first. Tap one for why it matters."
              >
                <ul className="finding-list">
                  {analysis.findings.map((f) => (
                    <FindingRow key={f.id} finding={f} />
                  ))}
                </ul>
              </Card>
            )}

            {access.bridgeYears > 0 && (
              <Card
                title={`Getting at it before ${PENALTY_FREE_AGE}`}
                note={`Retiring at ${access.targetAge} means ${access.bridgeYears} years before retirement accounts open without a strategy.`}
              >
                <Meter
                  label="Reachable money against the bridge it has to cover"
                  valueCents={access.reachableCents}
                  limitCents={Math.max(access.bridgeNeedCents, 1)}
                  color={access.shortfallCents > 0 ? STATUS.serious : STATUS.good}
                  statusLabel={
                    access.shortfallCents > 0
                      ? `Short by ${fmt(access.shortfallCents, false)}`
                      : 'Covered'
                  }
                  statusColor={access.shortfallCents > 0 ? STATUS.serious : STATUS.good}
                  right={`${fmt(access.reachableCents, false)} of ${fmt(access.bridgeNeedCents, false)}`}
                />

                <div style={{ marginTop: 14 }}>
                  <Lesson title="Why the usual order of operations stops short here">
                    <p>
                      The standard sequence — match, then high-rate debt, then tax-advantaged
                      accounts — assumes you stop working at a conventional age. It never asks
                      when you need the money. Retiring at {access.targetAge} means{' '}
                      {access.bridgeYears} years to fund before{' '}
                      {PENALTY_FREE_AGE}, and only taxable and cash accounts have no age
                      condition on them.
                    </p>
                    <p>
                      That is not an argument against retirement accounts. The employer match is
                      an immediate return nothing else matches, and the tax treatment is still
                      worth having. It is an argument for knowing the size of the gap.
                    </p>
                  </Lesson>

                  <Lesson title="Retirement accounts are less locked than 59½ suggests">
                    <p>
                      Four doors exist, and they are the reason "locked until{' '}
                      {PENALTY_FREE_AGE}" is only roughly true:
                    </p>
                    <ul>
                      <li>
                        <strong>Roth contributions</strong> — the money you put in, as opposed to
                        what it earned, can be withdrawn at any age without tax or penalty. This
                        app counts a Roth as unreachable anyway, because it doesn't track
                        contributions separately from growth, and overstating your bridge is the
                        error that would actually hurt.
                      </li>
                      <li>
                        <strong>Rule of 55</strong> — leave an employer at or after 55 and that
                        employer's plan opens without penalty.
                      </li>
                      <li>
                        <strong>72(t) / SEPP</strong> — a schedule of substantially equal
                        payments, penalty-free, but locked in for years once started.
                      </li>
                      <li>
                        <strong>Roth conversion ladder</strong> — convert pre-tax money to Roth,
                        pay the income tax that year, and withdraw the converted amount after a
                        waiting period. The usual early-retirement bridge.
                      </li>
                    </ul>
                    <p>
                      Each has conditions and tax consequences this app does not model. They are
                      here so the "it's locked until {PENALTY_FREE_AGE}" instinct doesn't quietly
                      shape your decisions when it isn't the whole picture.
                    </p>
                  </Lesson>
                </div>
              </Card>
            )}

            <div className="grid grid-2">
              {accessSlices.length > 0 && (
                <ChartFrame
                  title="When you can spend it"
                  note="Taxable and cash accounts have no age condition."
                  table={
                    <ShareTable
                      slices={accessSlices}
                      totalCents={portfolio.totalValueCents}
                      valueHeader="Value"
                    />
                  }
                >
                  <StackedShareBar
                    slices={accessSlices}
                    totalCents={portfolio.totalValueCents}
                  />
                </ChartFrame>
              )}

              <ChartFrame
                title="How it's taxed"
                note="Having some in each gives you a choice of which pot to draw from."
                table={
                  <ShareTable
                    slices={taxSlices}
                    totalCents={portfolio.totalValueCents}
                    valueHeader="Value"
                  />
                }
              >
                <StackedShareBar slices={taxSlices} totalCents={portfolio.totalValueCents} />
              </ChartFrame>
            </div>

            <ChartFrame
              title="What you own"
              note="Share of the portfolio by asset class."
              table={
                <ShareTable
                  slices={classSlices}
                  totalCents={portfolio.totalValueCents}
                  valueHeader="Value"
                />
              }
            >
              <StackedShareBar slices={classSlices} totalCents={portfolio.totalValueCents} />
            </ChartFrame>
          </div>
        ))}

      {tab === 'plan' && (
        <div className="stack">
          {summary.monthlyIncomeCents === 0 ? (
            <Card>
              <EmptyState icon="▤" title="Set your income first">
                <p style={{ maxWidth: '54ch', margin: '0 auto 12px' }}>
                  Every step below is measured against what you earn and spend. Without that this
                  is just a list of generic advice.
                </p>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => onNavigate('budget')}
                >
                  Go to Budget
                </button>
              </EmptyState>
            </Card>
          ) : (
            <>
              {nextStep && (
                <Callout tone="warning" icon="→">
                  <strong>Next: {nextStep.title}.</strong> {nextStep.detail}
                </Callout>
              )}
              <Card
                title="The order of operations"
                note="The widely-taught sequence, evaluated against your own numbers."
              >
                <ol className="step-list">
                  {plan.steps.map((step, i) => (
                    <StepRow
                      key={step.id}
                      step={step}
                      index={i + 1}
                      isNext={step.id === plan.currentStepId}
                    />
                  ))}
                </ol>
              </Card>
            </>
          )}
        </div>
      )}

      {tab === 'learn' && (
        <div className="stack">
          <Card title="The short version">
            <p style={{ marginTop: 0, marginBottom: 0 }}>
              Buy broad, low-cost index funds; buy them automatically every month; leave them
              alone for decades. The three things that actually move the outcome, in order of how
              much control you have: <strong>how much you invest</strong>,{' '}
              <strong>how long you leave it</strong>, and <strong>what you pay in fees</strong>.
              Picking investments comes a distant fourth; picking the <em>moment</em> is mostly
              noise.
            </p>
          </Card>

          <Card title="The rest, when you want it">
            <Lesson title="Why index funds">
              <p>
                An index fund buys the whole market instead of guessing which parts will win. That
                sounds like settling for average — it isn't, because "average" here means the
                money-weighted return of every professional trying to beat it, before their fees.
              </p>
              <p>
                Over long periods most actively managed funds underperform their index after
                costs, and the winners of one decade are not reliably the winners of the next.
                Owning everything sidesteps having to identify them in advance.
              </p>
            </Lesson>

            <Lesson title="What fees really cost">
              <p>
                An expense ratio is charged on your balance every year, in good years and bad. It
                compounds against you exactly the way returns compound for you, which is why a
                number that looks like a rounding error is not one.
              </p>
              <p>
                The difference between 0.03% and 0.75% on a six-figure balance is thousands of
                dollars a year, for nothing you can observe. Your own blended figure is on the
                Your portfolio tab.
              </p>
            </Lesson>

            <Lesson title="Accounts before investments">
              <p>
                An account is a container with tax rules; an investment is what goes inside it.
                The same index fund behaves differently in a 401(k), a Roth IRA and a taxable
                brokerage, because of when and whether the tax is paid.
              </p>
              <p>
                <strong>Pre-tax</strong> (traditional 401(k)/IRA): deduct now, pay income tax on
                withdrawal. <strong>Roth</strong>: pay tax now, withdraw tax-free later.{' '}
                <strong>Taxable</strong>: no break either way, and no age conditions at all —
                which is what makes it the bridge for anyone retiring early.{' '}
                <strong>HSA</strong>: deductible going in and tax-free out for medical costs.
              </p>
            </Lesson>

            <Lesson title="Risk, honestly">
              <p>
                A portfolio averaging 7% a year still has years down 30%. The average is what
                survives the arithmetic afterwards, not a description of any particular year.
              </p>
              <p>
                The order the years arrive in matters as much as the average, especially right
                after you stop earning — a bad first few years of retirement does lasting damage
                that the same years later would not. The projections in this app assume a smooth
                rate precisely because modelling that honestly is beyond arithmetic.
              </p>
            </Lesson>

            <Lesson title="Things that reliably go wrong">
              <p>
                Selling after a fall and buying back after a recovery. Paying for active
                management that underperforms. Leaving money in cash "until things settle down".
                Holding a large position in your own employer, so that your salary and your
                savings depend on one company.
              </p>
              <p>
                All five are behavioural rather than analytical, which is why automating
                contributions and then not looking is worth more than any fund choice.
              </p>
            </Lesson>
          </Card>

          <Callout>
            This is education, not advice. It applies general rules to numbers you entered, and
            knows nothing about your tax situation, job security, health or family.
          </Callout>
        </div>
      )}
    </>
  );
}

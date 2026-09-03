import { useMemo, useState } from 'react';
import { useStore } from '../store';
import {
  currentMonthKey,
  monthlyBudgetedSavings,
  monthlyFundedSpending,
  resolveBudget,
} from '../lib/budget';
import { computeFIStatus, withdrawalRateSensitivity, yearsToFIFromSavingsRate } from '../lib/fi';
import { computeNetWorth, summarizePortfolio } from '../lib/investments';
import { bpsToPercent } from '../lib/money';
import {
  Callout,
  Card,
  ChartFrame,
  Field,
  Meter,
  MoneyInput,
  PercentInput,
  Segmented,
  StatTile,
  useFormatMoney,
} from '../components/ui';
import { MoneyTable, ProjectionChart } from '../components/charts';

/** Where the projection's monthly contribution comes from. */
type ContributionSource = 'budget' | 'accounts';

export default function FIPage() {
  const data = useStore((s) => s.data);
  const { updateFISettings } = useStore();
  const fmt = useFormatMoney();

  const [contributionSource, setContributionSource] = useState<ContributionSource>('budget');

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
  const budgetedSavings = monthlyBudgetedSavings(summary);

  // Two honest answers to "how much are you investing each month": what the
  // budget says you set aside, and what your accounts say you actually send.
  // They disagree often enough that guessing for the user would be wrong.
  const accountContribution =
    portfolio.monthlyContributionCents + portfolio.monthlyEmployerMatchCents;
  const budgetContribution = budgetedSavings + portfolio.monthlyEmployerMatchCents;
  const monthlyContribution =
    contributionSource === 'budget' ? budgetContribution : accountContribution;

  const status = useMemo(
    () =>
      computeFIStatus({
        settings: data.settings.fi,
        monthlyFundedSpendingCents: fundedSpending,
        monthlyIncomeCents: summary.monthlyIncomeCents,
        fiAssetsCents: netWorth.fiAssetsCents,
        monthlyContributionCents: monthlyContribution,
      }),
    [data.settings.fi, fundedSpending, summary.monthlyIncomeCents, netWorth.fiAssetsCents, monthlyContribution],
  );

  const sensitivity = useMemo(
    () => withdrawalRateSensitivity(status.annualSpendingCents, netWorth.fiAssetsCents),
    [status.annualSpendingCents, netWorth.fiAssetsCents],
  );

  const fi = data.settings.fi;
  const noSpending = status.annualSpendingCents === 0;

  const savingsRateYears = yearsToFIFromSavingsRate(
    status.savings.rateBps,
    status.annualRealRate,
    fi.safeWithdrawalRateBps,
  );

  return (
    <>
      <header className="page-header">
        <h1 className="page-title">Financial independence</h1>
        <p className="page-subtitle">
          The portfolio that covers your spending forever, and how long it takes to get there.
          Everything is in today's dollars — the expected return is discounted by inflation rather
          than inflating the target.
        </p>
      </header>

      {noSpending ? (
        <Callout tone="warning">
          <strong>Set up your budget first.</strong> The FI number is built from what you spend on
          needs and wants, and right now that's zero. Add income and category allocations on the
          Budget page, or set an explicit annual spending figure below.
        </Callout>
      ) : (
        <>
          <div className="kpi-row">
            <StatTile
              label="Your FI number"
              value={fmt(status.fiNumberCents, false)}
              sub={`${(10_000 / fi.safeWithdrawalRateBps).toFixed(0)}× annual spending of ${fmt(status.annualSpendingCents, false)}`}
            />
            <StatTile
              label="Invested toward it"
              value={fmt(netWorth.fiAssetsCents, false)}
              sub={`${bpsToPercent(status.progressBps).toFixed(1)}% of the way there`}
            />
            <StatTile
              label="Time to FI"
              value={
                status.projection.yearsToFI === null
                  ? 'Not on this path'
                  : status.projection.yearsToFI === 0
                    ? 'Already there'
                    : `${status.projection.yearsToFI.toFixed(1)} yrs`
              }
              sub={
                status.projection.fiDate
                  ? `Around ${status.projection.fiDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}${status.projection.ageAtFI !== null ? `, age ${status.projection.ageAtFI}` : ''}`
                  : 'Increase contributions or reduce spending'
              }
            />
            <StatTile
              label="Savings rate"
              value={`${bpsToPercent(status.savings.rateBps).toFixed(1)}%`}
              tone={status.savings.rateBps >= 2000 ? 'good' : undefined}
              sub={
                savingsRateYears !== null
                  ? `From zero, this rate alone reaches FI in ~${savingsRateYears.toFixed(0)} years`
                  : 'Income minus needs and wants'
              }
            />
          </div>

          <div className="stack">
            <Card>
              <Meter
                label={<strong>Progress to financial independence</strong>}
                valueCents={netWorth.fiAssetsCents}
                limitCents={status.fiNumberCents}
                color="var(--series-1)"
                right={
                  <>
                    {fmt(netWorth.fiAssetsCents, false)}{' '}
                    <span className="muted">of {fmt(status.fiNumberCents, false)}</span>
                  </>
                }
              />
              <div className="row-between" style={{ marginTop: 14 }}>
                <div>
                  <div className="stat-label">Passive income today</div>
                  <div className="stat-value">{fmt(status.currentMonthlyPassiveIncomeCents)}/mo</div>
                  <div className="stat-sub">
                    At {bpsToPercent(fi.safeWithdrawalRateBps).toFixed(1)}% withdrawal, covering{' '}
                    <strong>{bpsToPercent(status.coverageBps).toFixed(0)}%</strong> of your{' '}
                    {fmt(fundedSpending)} monthly spending.
                  </div>
                </div>
                {status.coastFINumberCents !== null && (
                  <div>
                    <div className="stat-label">Coast FI number</div>
                    <div className="stat-value">{fmt(status.coastFINumberCents, false)}</div>
                    <div className="stat-sub">
                      {status.coastFIReached ? (
                        <span className="delta-good">
                          ✓ Reached — your portfolio alone gets you there by {fi.targetRetirementAge}
                        </span>
                      ) : (
                        <>
                          {fmt(status.coastFINumberCents - netWorth.fiAssetsCents, false)} more and you
                          could stop contributing entirely
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </Card>

            <ChartFrame
              title="Projection to financial independence"
              note={`Assuming a ${bpsToPercent(fi.expectedReturnBps).toFixed(1)}% nominal return less ${bpsToPercent(fi.inflationBps).toFixed(1)}% inflation — a ${(status.annualRealRate * 100).toFixed(2)}% real return — and ${fmt(monthlyContribution)} invested monthly.`}
              actions={
                <Segmented
                  ariaLabel="Contribution source"
                  value={contributionSource}
                  onChange={setContributionSource}
                  options={[
                    { value: 'budget', label: `Budget ${fmt(budgetContribution, false)}` },
                    { value: 'accounts', label: `Accounts ${fmt(accountContribution, false)}` },
                  ]}
                />
              }
              table={
                <MoneyTable
                  columns={[
                    { label: 'Year' },
                    { label: 'Balance', numeric: true },
                    { label: 'Contributed', numeric: true },
                    { label: 'Growth', numeric: true },
                  ]}
                  rows={status.projection.points
                    .filter((p) => p.year > 0 && p.year % 5 === 0)
                    .slice(0, 12)
                    .map((p) => ({
                      key: String(p.year),
                      cells: [
                        `Year ${p.year}`,
                        fmt(p.balanceCents, false),
                        fmt(p.contributedCents, false),
                        fmt(p.growthCents, false),
                      ],
                    }))}
                />
              }
            >
              {monthlyContribution === 0 && netWorth.fiAssetsCents === 0 ? (
                <p className="muted" style={{ fontSize: 13, margin: 0 }}>
                  Add investment accounts or a savings allocation to see a projection.
                </p>
              ) : (
                <>
                  <ProjectionChart
                    points={status.projection.points}
                    targetCents={status.fiNumberCents}
                    startingBalanceCents={netWorth.fiAssetsCents}
                    monthsToFI={status.projection.monthsToFI}
                  />
                  <div className="chart-legend">
                    <span className="legend-item">
                      <span className="swatch" style={{ background: 'var(--series-7)' }} aria-hidden="true" />
                      Starting balance
                    </span>
                    <span className="legend-item">
                      <span className="swatch" style={{ background: 'var(--series-1)' }} aria-hidden="true" />
                      Contributions
                    </span>
                    <span className="legend-item">
                      <span className="swatch" style={{ background: 'var(--series-3)' }} aria-hidden="true" />
                      Investment growth
                    </span>
                  </div>
                </>
              )}
              {contributionSource === 'budget' && Math.abs(budgetContribution - accountContribution) > 5000 && (
                <p className="field-hint" style={{ marginTop: 10 }}>
                  Your budget sets aside {fmt(budgetContribution)} a month but your accounts are set
                  to receive {fmt(accountContribution)}. The projection uses whichever you pick above.
                </p>
              )}
            </ChartFrame>

            <div className="grid grid-2">
              <Card title="Assumptions" note="Change these and every figure on this page moves.">
                <div className="stack-sm">
                  <div className="form-row">
                    <Field
                      label="Withdrawal rate"
                      hint={`${(10_000 / fi.safeWithdrawalRateBps).toFixed(1)}× annual spending`}
                    >
                      {(id) => (
                        <span className="alloc-input">
                          <PercentInput
                            id={id}
                            valueBps={fi.safeWithdrawalRateBps}
                            max={20}
                            onCommit={(safeWithdrawalRateBps) =>
                              updateFISettings({ safeWithdrawalRateBps })
                            }
                          />
                          <span className="alloc-mode" aria-hidden="true">
                            %
                          </span>
                        </span>
                      )}
                    </Field>
                    <Field label="Expected return" hint="Nominal, before inflation">
                      {(id) => (
                        <span className="alloc-input">
                          <PercentInput
                            id={id}
                            valueBps={fi.expectedReturnBps}
                            max={30}
                            onCommit={(expectedReturnBps) => updateFISettings({ expectedReturnBps })}
                          />
                          <span className="alloc-mode" aria-hidden="true">
                            %
                          </span>
                        </span>
                      )}
                    </Field>
                    <Field label="Inflation" hint="Keeps figures in today's dollars">
                      {(id) => (
                        <span className="alloc-input">
                          <PercentInput
                            id={id}
                            valueBps={fi.inflationBps}
                            max={30}
                            onCommit={(inflationBps) => updateFISettings({ inflationBps })}
                          />
                          <span className="alloc-mode" aria-hidden="true">
                            %
                          </span>
                        </span>
                      )}
                    </Field>
                  </div>

                  <div className="form-row">
                    <Field label="Your age" hint="Optional — enables Coast FI">
                      {(id) => (
                        <input
                          id={id}
                          type="number"
                          min={0}
                          max={120}
                          value={fi.currentAge ?? ''}
                          placeholder="—"
                          onChange={(e) =>
                            updateFISettings({
                              currentAge: e.target.value === '' ? null : Number(e.target.value),
                            })
                          }
                        />
                      )}
                    </Field>
                    <Field label="Target retirement age">
                      {(id) => (
                        <input
                          id={id}
                          type="number"
                          min={0}
                          max={120}
                          value={fi.targetRetirementAge ?? ''}
                          placeholder="—"
                          onChange={(e) =>
                            updateFISettings({
                              targetRetirementAge:
                                e.target.value === '' ? null : Number(e.target.value),
                            })
                          }
                        />
                      )}
                    </Field>
                    <Field
                      label="Annual spending"
                      hint={
                        fi.annualSpendingOverrideCents === null
                          ? `Using your budget: ${fmt(fundedSpending * 12, false)}`
                          : 'Overriding your budget'
                      }
                    >
                      {(id) => (
                        <MoneyInput
                          id={id}
                          valueCents={fi.annualSpendingOverrideCents ?? fundedSpending * 12}
                          onCommit={(cents) =>
                            updateFISettings({ annualSpendingOverrideCents: cents })
                          }
                        />
                      )}
                    </Field>
                  </div>

                  {fi.annualSpendingOverrideCents !== null && (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => updateFISettings({ annualSpendingOverrideCents: null })}
                    >
                      Use my budget instead
                    </button>
                  )}
                </div>
              </Card>

              <Card
                title="How much the withdrawal rate matters"
                note="The same spending, funded at different rates."
              >
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Rate</th>
                        <th className="num">FI number</th>
                        <th className="num">Progress</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sensitivity.map((s) => (
                        <tr
                          key={s.rateBps}
                          style={
                            s.rateBps === fi.safeWithdrawalRateBps
                              ? { background: 'var(--surface-hover)', fontWeight: 600 }
                              : undefined
                          }
                        >
                          <td>
                            {bpsToPercent(s.rateBps).toFixed(1)}%
                            {s.rateBps === fi.safeWithdrawalRateBps && (
                              <span className="badge" style={{ marginLeft: 6 }}>
                                yours
                              </span>
                            )}
                          </td>
                          <td className="num mono-num">{fmt(s.fiNumberCents, false)}</td>
                          <td className="num mono-num">{bpsToPercent(s.progressBps).toFixed(1)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="field-hint" style={{ marginTop: 10 }}>
                  A lower rate is a bigger target and a safer one. 4% comes from a study of 30-year
                  retirements; a retirement lasting 50 years is usually planned nearer 3–3.5%.
                </p>
              </Card>
            </div>

            <Callout>
              These projections assume a single smooth rate of return, steady contributions, and
              spending that never changes. Real markets deliver none of that — a portfolio that
              averages 7% still has years down 30%, and the sequence in which those years arrive
              matters as much as the average. Treat the date as a direction, not a promise.
            </Callout>
          </div>
        </>
      )}
    </>
  );
}

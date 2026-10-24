import { useMemo } from 'react';
import {
  careerCurve,
  orderedSteps,
  realRaiseRate,
  type CareerPlan,
  type CareerStep,
} from '../lib/career';
import { newId } from '../lib/seed';
import { bpsToPercent } from '../lib/money';
import type { Cents } from '../types';
import {
  Callout,
  Card,
  ChartFrame,
  Field,
  MoneyInput,
  PercentInput,
  useFormatMoney,
} from './ui';
import { CareerChart, MoneyTable } from './charts';

/**
 * Career earnings, as an input to the projection.
 *
 * The flat projection assumes you contribute the same amount every month for
 * thirty years. Nobody does: pay rises, and jobs change. This is where that
 * gets said out loud.
 *
 * The control that matters most is the last one — how much of each raise gets
 * invested rather than spent. Spending a raise raises your FI number by about
 * 25x the raise, every year, forever, so the honest model needs that split
 * rather than quietly assuming every pay rise is saved.
 */
export default function CareerPlanner({
  plan,
  onChange,
  baseAnnualTakeHomeCents,
  baseMonthlyContributionCents,
  baseAnnualSpendingCents,
  safeWithdrawalRateBps,
  inflationBps,
  years,
}: {
  plan: CareerPlan;
  onChange: (next: CareerPlan) => void;
  baseAnnualTakeHomeCents: Cents;
  baseMonthlyContributionCents: Cents;
  baseAnnualSpendingCents: Cents;
  safeWithdrawalRateBps: number;
  inflationBps: number;
  years: number;
}) {
  const fmt = useFormatMoney();
  const steps = orderedSteps(plan);

  const curve = useMemo(
    () =>
      careerCurve({
        plan,
        baseAnnualTakeHomeCents,
        baseMonthlyContributionCents,
        baseAnnualSpendingCents,
        safeWithdrawalRateBps,
        inflationBps,
        years: Math.max(5, Math.min(40, Math.round(years))),
      }),
    [
      plan,
      baseAnnualTakeHomeCents,
      baseMonthlyContributionCents,
      baseAnnualSpendingCents,
      safeWithdrawalRateBps,
      inflationBps,
      years,
    ],
  );

  const realRate = realRaiseRate(plan, inflationBps);
  const multiple = safeWithdrawalRateBps > 0 ? 10_000 / safeWithdrawalRateBps : 0;
  // What spending becomes at the far end of the curve, which is the figure
  // that decides the finish line.
  const endSpendingCents = curve.length > 0 ? curve[curve.length - 1]!.annualSpendingCents : 0;
  const update = (patch: Partial<CareerPlan>): void => onChange({ ...plan, ...patch });

  const setStep = (id: string, patch: Partial<CareerStep>): void =>
    update({ steps: plan.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)) });

  const addStep = (): void => {
    const last = steps[steps.length - 1];
    update({
      steps: [
        ...plan.steps,
        {
          id: newId('step'),
          atYear: (last?.atYear ?? 0) + 3,
          annualTakeHomeCents: Math.round((last?.annualTakeHomeCents ?? baseAnnualTakeHomeCents) * 1.2),
          label: 'New role',
        },
      ],
    });
  };

  return (
    <Card
      title="Career and raises"
      note="Your pay will not stay where it is. This is what that does to the date."
      actions={
        <label className="auto-sync-toggle" style={{ marginBottom: 0 }}>
          <input
            type="checkbox"
            checked={plan.enabled}
            onChange={(e) => update({ enabled: e.target.checked })}
          />
          <span>Include career growth</span>
        </label>
      }
    >
      {!plan.enabled ? (
        <p className="field-hint" style={{ margin: 0 }}>
          Off, so the projection assumes today's pay and today's contribution for its whole
          length. Switch it on to model raises and job moves — and what happens to the finish
          line depending on how much of each raise you spend.
        </p>
      ) : (
        <div className="stack-sm">
          <div className="form-row">
            <Field
              label="Typical raise"
              hint={
                realRate > 0
                  ? `${(realRate * 100).toFixed(1)}% above inflation`
                  : 'At or below inflation — no real gain'
              }
            >
              {(id) => (
                <PercentInput
                  id={id}
                  valueBps={plan.nominalRaiseBps}
                  onCommit={(nominalRaiseBps) => update({ nominalRaiseBps })}
                />
              )}
            </Field>

            <Field label="Every (years)" hint="1 for an annual review">
              {(id) => (
                <input
                  id={id}
                  className="input-money"
                  type="number"
                  min={1}
                  max={10}
                  value={plan.raiseEveryYears}
                  onChange={(e) =>
                    update({ raiseEveryYears: Math.max(1, Math.round(Number(e.target.value) || 1)) })
                  }
                />
              )}
            </Field>

            <Field
              label="Of each raise, invested"
              hint="The rest raises your spending — and the FI number with it"
            >
              {(id) => (
                <PercentInput
                  id={id}
                  valueBps={plan.marginalSavingsBps}
                  onCommit={(marginalSavingsBps) => update({ marginalSavingsBps })}
                />
              )}
            </Field>
          </div>

          <p className="field-hint" style={{ margin: 0 }}>
            Raises are entered the way an employer quotes them; inflation is taken out for you,
            since everything on this page is in today's dollars. Salaries below are take-home, in
            today's dollars too.
          </p>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Job or role</th>
                  <th className="num">In (years)</th>
                  <th className="num">Take-home then</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {plan.steps.length === 0 && (
                  <tr>
                    <td colSpan={4} className="muted">
                      No job moves planned. Raises alone still compound.
                    </td>
                  </tr>
                )}
                {plan.steps.map((step) => (
                  <tr key={step.id}>
                    <td>
                      <input
                        type="text"
                        value={step.label}
                        aria-label="Role"
                        onChange={(e) => setStep(step.id, { label: e.target.value })}
                      />
                    </td>
                    <td className="num" style={{ width: 96 }}>
                      <input
                        className="input-money"
                        type="number"
                        min={1}
                        max={40}
                        value={step.atYear}
                        aria-label="Years from now"
                        onChange={(e) =>
                          setStep(step.id, { atYear: Math.max(1, Math.round(Number(e.target.value) || 1)) })
                        }
                      />
                    </td>
                    <td className="num" style={{ width: 140 }}>
                      <MoneyInput
                        valueCents={step.annualTakeHomeCents}
                        ariaLabel="Annual take-home at that point"
                        onCommit={(annualTakeHomeCents) =>
                          setStep(step.id, { annualTakeHomeCents })
                        }
                      />
                    </td>
                    <td className="num">
                      <button
                        type="button"
                        className="btn btn-icon"
                        aria-label={`Remove ${step.label || 'step'}`}
                        onClick={() =>
                          update({ steps: plan.steps.filter((s) => s.id !== step.id) })
                        }
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="btn-row">
            <button type="button" className="btn btn-sm" onClick={addStep}>
              + Add a job move
            </button>
          </div>

          <ChartFrame
            title="What you earn, invest and spend"
            note="Take-home pay against what it turns into, in today's dollars."
            table={
              <MoneyTable
                columns={[
                  { label: 'Year' },
                  { label: 'Take-home', numeric: true },
                  { label: 'Invested', numeric: true },
                  { label: 'Spending', numeric: true },
                ]}
                rows={curve
                  .filter((p) => p.year % 5 === 0)
                  .map((p) => ({
                    key: String(p.year),
                    cells: [
                      p.year === 0 ? 'Now' : `+${p.year}`,
                      fmt(p.takeHomeCents, false),
                      fmt(p.annualContributionCents, false),
                      fmt(p.annualSpendingCents, false),
                    ],
                  }))}
              />
            }
          >
            <CareerChart points={curve} />
          </ChartFrame>

          {plan.marginalSavingsBps < 10_000 && (
            <Callout tone="warning">
              <strong>
                Spending {bpsToPercent(10_000 - plan.marginalSavingsBps).toFixed(0)}% of each
                raise moves your FI number from {fmt(baseAnnualSpendingCents * multiple, false)} to{' '}
                {fmt(endSpendingCents * multiple, false)}.
              </strong>{' '}
              The target is a multiple of what you spend, so at a{' '}
              {(10_000 / safeWithdrawalRateBps).toFixed(0)}× multiple each extra dollar of yearly
              spending adds {(10_000 / safeWithdrawalRateBps).toFixed(0)} dollars to the finish
              line, while the same dollar saved adds one. That is why a raise you absorb into
              your lifestyle can genuinely push FI further away — set this to 100% to model
              investing every raise instead.
            </Callout>
          )}
        </div>
      )}
    </Card>
  );
}

import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { monthlySavings, SAVINGS_PRESETS } from '../lib/setup';
import {
  canPromptInstall,
  installSteps,
  isStandalone,
  promptInstall,
  subscribe,
} from '../lib/install';
import { MoneyInput, useFormatMoney } from './ui';
import type { Cents } from '../types';

/**
 * First-run setup.
 *
 * Two numbers and one choice, in that order, because that is the shortest path
 * from an empty install to a budget and an FI projection that mean something:
 * what you take home, how much of it you keep, and what you have already put
 * away. Everything else in the app is editable later and none of it blocks.
 *
 * Built for a phone held one-handed: one question per screen, large targets, a
 * numeric keypad on every money field, and a way out of every step. Nothing is
 * written until the last screen, so backing out costs nothing.
 */

type Step = 'income' | 'savings' | 'balance' | 'done';

const STEP_ORDER: Step[] = ['income', 'savings', 'balance', 'done'];

export default function FirstRunSetup({ onClose }: { onClose: () => void }) {
  const { completeSetup, dismissSetup } = useStore();
  // Someone re-running setup from Settings already has accounts; asking them
  // for a rough total again would only invite double-counting.
  const hasAccounts = useStore((s) => s.data.accounts.length > 0);
  const fmt = useFormatMoney();

  const [step, setStep] = useState<Step>('income');
  const [income, setIncome] = useState<Cents>(0);
  const [savingsBps, setSavingsBps] = useState(SAVINGS_PRESETS[1]!.savingsBps);
  const [balance, setBalance] = useState<Cents>(0);
  const [contribution, setContribution] = useState<Cents>(0);

  const [installable, setInstallable] = useState(canPromptInstall());
  const [installed, setInstalled] = useState(isStandalone());
  useEffect(() => subscribe(() => setInstallable(canPromptInstall())), []);

  const index = STEP_ORDER.indexOf(step);

  const finish = (): void => {
    completeSetup({
      monthlyIncomeCents: income,
      savingsBps,
      startingBalanceCents: balance,
      monthlyContributionCents: contribution,
    });
  };

  return (
    <div className="setup-backdrop" role="dialog" aria-modal="true" aria-label="Set up your budget">
      <div className="setup-card">
        <div className="setup-progress" aria-hidden="true">
          {STEP_ORDER.map((s, i) => (
            <span key={s} className={`setup-dot${i <= index ? ' is-done' : ''}`} />
          ))}
        </div>

        {step === 'income' && (
          <div className="stack">
            <div>
              <h2 className="setup-title">What do you take home each month?</h2>
              <p className="setup-sub">
                After tax — what actually lands in your account. A rough number is fine; you can
                change it any time.
              </p>
            </div>

            <div className="setup-money">
              <MoneyInput
                valueCents={income}
                onCommit={setIncome}
                ariaLabel="Monthly take-home pay"
                placeholder="0.00"
              />
            </div>

            <div className="setup-actions">
              <button
                type="button"
                className="btn btn-primary btn-lg"
                disabled={income <= 0}
                onClick={() => setStep('savings')}
              >
                Continue
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  dismissSetup();
                  onClose();
                }}
              >
                Skip setup
              </button>
            </div>
          </div>
        )}

        {step === 'savings' && (
          <div className="stack">
            <div>
              <h2 className="setup-title">How much of it do you want to keep?</h2>
              <p className="setup-sub">
                This one number decides when work becomes optional. Pick a starting point — the
                budget adjusts around it, and every category stays editable.
              </p>
            </div>

            <div className="setup-choices">
              {SAVINGS_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={`setup-choice${preset.savingsBps === savingsBps ? ' is-selected' : ''}`}
                  aria-pressed={preset.savingsBps === savingsBps}
                  onClick={() => setSavingsBps(preset.savingsBps)}
                >
                  <span className="setup-choice-head">
                    <strong>{preset.label}</strong>
                    <span className="mono-num">
                      {fmt(monthlySavings(income, preset.savingsBps), false)}/mo
                    </span>
                  </span>
                  <span className="setup-choice-desc">{preset.description}</span>
                </button>
              ))}
            </div>

            <div className="setup-actions">
              <button
                type="button"
                className="btn btn-primary btn-lg"
                onClick={() => {
                  if (hasAccounts) {
                    finish();
                    setStep('done');
                  } else {
                    setStep('balance');
                  }
                }}
              >
                Continue
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setStep('income')}>
                Back
              </button>
            </div>
          </div>
        )}

        {step === 'balance' && (
          <div className="stack">
            <div>
              <h2 className="setup-title">Anything saved already?</h2>
              <p className="setup-sub">
                A rough total across your retirement and investment accounts is enough to project
                from. Leave it blank if you'd rather add accounts properly later.
              </p>
            </div>

            <label className="field">
              <span className="field-label">Total invested so far</span>
              <div className="setup-money setup-money-sm">
                <MoneyInput
                  valueCents={balance}
                  onCommit={setBalance}
                  ariaLabel="Total invested so far"
                />
              </div>
            </label>

            <label className="field">
              <span className="field-label">Adding per month</span>
              <div className="setup-money setup-money-sm">
                <MoneyInput
                  valueCents={contribution}
                  onCommit={setContribution}
                  ariaLabel="Amount invested per month"
                />
              </div>
              <span className="field-hint">
                Including anything that goes into a workplace plan from your pay.
              </span>
            </label>

            <div className="setup-actions">
              <button
                type="button"
                className="btn btn-primary btn-lg"
                onClick={() => {
                  finish();
                  setStep('done');
                }}
              >
                {balance > 0 || contribution > 0 ? 'Finish' : 'Skip this'}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setStep('savings')}>
                Back
              </button>
            </div>
          </div>
        )}

        {step === 'done' && (
          <div className="stack">
            <div>
              <h2 className="setup-title">That's it — you're set up.</h2>
              <p className="setup-sub">
                Your budget is live at {fmt(income, false)} a month with{' '}
                {fmt(monthlySavings(income, savingsBps), false)} going to savings. Scan a receipt to
                start tracking spending, or edit any category on the Budget page.
              </p>
            </div>

            {!installed && (
              <div className="setup-install">
                <strong>Keep it on your home screen</strong>
                <p className="setup-sub" style={{ margin: '4px 0 10px' }}>
                  It then opens like an app, full screen, and works with no signal.
                </p>
                {installable ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => {
                      void promptInstall().then((accepted) => setInstalled(accepted));
                    }}
                  >
                    Add to home screen
                  </button>
                ) : (
                  <p className="setup-steps">{installSteps()}</p>
                )}
              </div>
            )}

            <div className="setup-actions">
              <button
                type="button"
                className="btn btn-primary btn-lg"
                // The data was written on leaving the previous step; this
                // only dismisses the sheet.
                onClick={onClose}
              >
                Start using it
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

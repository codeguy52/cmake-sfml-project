import { useEffect, useRef, useState } from 'react';
import { useStore, flushPendingSave } from '../store';
import {
  bundleFilename,
  downloadBundle,
  downloadCsv,
  exportBundle,
  importBundle,
  ImportError,
  transactionsToCsv,
} from '../lib/backup';
import { requestPersistentStorage, type StorageEstimate } from '../lib/db';
import { Callout, Card, ConfirmButton, EmptyState, Field, Segmented } from '../components/ui';

type ThemePreference = 'system' | 'light' | 'dark';

const THEME_KEY = 'fire-budget:theme';

export function readThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    // Storage blocked; fall back to following the OS.
  }
  return 'system';
}

export function applyTheme(preference: ThemePreference): void {
  if (preference === 'system') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', preference);
  }
  try {
    localStorage.setItem(THEME_KEY, preference);
  } catch {
    // Preference just won't persist.
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'SEK', 'NZD', 'INR'];

export default function SettingsPage() {
  const data = useStore((s) => s.data);
  const { updateSettings, replaceAll, resetEverything } = useStore();

  const [theme, setTheme] = useState<ThemePreference>(readThemePreference);
  const [storage, setStorage] = useState<StorageEstimate | null>(null);
  const [message, setMessage] = useState<{ tone: 'good' | 'critical'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [includeReceipts, setIncludeReceipts] = useState(true);
  const importInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void requestPersistentStorage().then(setStorage);
  }, []);

  const handleExport = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      // Make sure a debounced edit isn't left out of the backup.
      await flushPendingSave();
      const bundle = await exportBundle(data, { includeReceipts });
      downloadBundle(bundle, bundleFilename());
      setMessage({ tone: 'good', text: 'Backup downloaded.' });
    } catch {
      setMessage({ tone: 'critical', text: 'Could not build the backup file.' });
    } finally {
      setBusy(false);
    }
  };

  const handleImport = async (file: File): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const text = await file.text();
      const parsed: unknown = JSON.parse(text);
      const result = await importBundle(parsed, data.settings.currency);
      replaceAll(result.data);
      setMessage({ tone: 'good', text: `Restored ${result.summary}.` });
    } catch (e) {
      setMessage({
        tone: 'critical',
        text:
          e instanceof ImportError
            ? e.message
            : e instanceof SyntaxError
              ? 'That file is not valid JSON.'
              : 'Could not read that backup.',
      });
    } finally {
      setBusy(false);
      if (importInput.current) importInput.current.value = '';
    }
  };

  const usedPercent =
    storage?.usageBytes && storage.quotaBytes
      ? (storage.usageBytes / storage.quotaBytes) * 100
      : null;

  return (
    <>
      <header className="page-header">
        <h1 className="page-title">Settings</h1>
        <p className="page-subtitle">
          Formatting, appearance and backups. All of your data is on this device only.
        </p>
      </header>

      <div className="stack">
        {message && (
          <Callout tone={message.tone}>
            {message.text}{' '}
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setMessage(null)}>
              Dismiss
            </button>
          </Callout>
        )}

        <Card title="Display">
          <div className="form-row">
            <Field label="Currency" hint="Used to format every amount">
              {(id) => (
                <select
                  id={id}
                  value={data.settings.currency}
                  onChange={(e) => updateSettings({ currency: e.target.value })}
                >
                  {CURRENCIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Number format" hint="Affects separators and date order">
              {(id) => (
                <select
                  id={id}
                  value={data.settings.locale}
                  onChange={(e) => updateSettings({ locale: e.target.value })}
                >
                  <option value="en-US">English (US)</option>
                  <option value="en-GB">English (UK)</option>
                  <option value="en-CA">English (Canada)</option>
                  <option value="en-AU">English (Australia)</option>
                  <option value="de-DE">German</option>
                  <option value="fr-FR">French</option>
                  <option value="es-ES">Spanish</option>
                  <option value="ja-JP">Japanese</option>
                </select>
              )}
            </Field>
            <div className="field">
              <span className="field-label">Appearance</span>
              <Segmented
                ariaLabel="Appearance"
                value={theme}
                onChange={(next) => {
                  setTheme(next);
                  applyTheme(next);
                }}
                options={[
                  { value: 'system', label: 'System' },
                  { value: 'light', label: 'Light' },
                  { value: 'dark', label: 'Dark' },
                ]}
              />
            </div>
          </div>
        </Card>

        <Card
          title="Backups"
          note="There is no cloud copy. If you clear this browser's data, an export is the only way back."
        >
          <div className="stack-sm">
            <Callout tone={storage?.persisted ? 'good' : 'warning'}>
              {storage?.persisted ? (
                <>
                  This browser has agreed to keep your data through storage pressure. Export anyway
                  — a persisted database still lives on one device.
                </>
              ) : (
                <>
                  This browser has <strong>not</strong> granted persistent storage, so it may
                  evict your data when space runs low. Export a backup regularly.
                </>
              )}
              {storage?.usageBytes !== null && storage?.usageBytes !== undefined && (
                <div className="field-hint" style={{ marginTop: 4 }}>
                  Using {formatBytes(storage.usageBytes)}
                  {storage.quotaBytes
                    ? ` of about ${formatBytes(storage.quotaBytes)} available${usedPercent !== null ? ` (${usedPercent.toFixed(1)}%)` : ''}`
                    : ''}
                  .
                </div>
              )}
            </Callout>

            <label
              className="field-hint"
              style={{ display: 'flex', gap: 6, alignItems: 'center' }}
            >
              <input
                type="checkbox"
                checked={includeReceipts}
                onChange={(e) => setIncludeReceipts(e.target.checked)}
              />
              Include receipt photos in the backup (much larger file)
            </label>

            <div className="btn-row">
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => void handleExport()}
              >
                Export backup (JSON)
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy || data.transactions.length === 0}
                onClick={() =>
                  downloadCsv(
                    transactionsToCsv(data),
                    `transactions-${new Date().toISOString().slice(0, 10)}.csv`,
                  )
                }
              >
                Export transactions (CSV)
              </button>
              <input
                ref={importInput}
                type="file"
                accept="application/json,.json"
                className="sr-only"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleImport(file);
                }}
              />
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => importInput.current?.click()}
              >
                Restore from backup
              </button>
            </div>
            <p className="field-hint" style={{ margin: 0 }}>
              Restoring <strong>replaces</strong> everything currently in the app. Export first if
              you have anything you want to keep.
            </p>
          </div>
        </Card>

        <Card title="Your data" note="Counts of what's stored on this device.">
          <div className="table-wrap">
            <table>
              <tbody>
                <tr>
                  <td>Categories</td>
                  <td className="num">{data.categories.length}</td>
                </tr>
                <tr>
                  <td>Subcategories</td>
                  <td className="num">
                    {data.categories.reduce((sum, c) => sum + c.subcategories.length, 0)}
                  </td>
                </tr>
                <tr>
                  <td>Transactions</td>
                  <td className="num">{data.transactions.length}</td>
                </tr>
                <tr>
                  <td>Transactions from receipts</td>
                  <td className="num">
                    {data.transactions.filter((t) => t.source === 'receipt').length}
                  </td>
                </tr>
                <tr>
                  <td>Investment accounts</td>
                  <td className="num">{data.accounts.length}</td>
                </tr>
                <tr>
                  <td>Holdings</td>
                  <td className="num">
                    {data.accounts.reduce((sum, a) => sum + a.holdings.length, 0)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Danger zone">
          <div className="row-between">
            <div>
              <div style={{ fontWeight: 600 }}>Delete everything</div>
              <div className="field-hint">
                Erases all budgets, transactions, receipt photos and accounts on this device, and
                starts over with the default categories. This cannot be undone.
              </div>
            </div>
            <ConfirmButton
              className="btn btn-danger"
              confirmLabel="Delete everything"
              onConfirm={() => {
                void resetEverything().then(() =>
                  setMessage({ tone: 'good', text: 'All data deleted.' }),
                );
              }}
            >
              Delete all data
            </ConfirmButton>
          </div>
        </Card>

        <Card title="About">
          <EmptyState icon="◈" title="Offline by design">
            This app makes no network requests except to download the OCR language model on your
            first receipt scan. Your budget, transactions and receipt photos are stored only in this
            browser, on this device.
          </EmptyState>
        </Card>
      </div>
    </>
  );
}

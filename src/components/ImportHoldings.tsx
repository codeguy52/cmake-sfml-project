import { useRef, useState } from 'react';
import { useStore } from '../store';
import {
  baseName,
  ImportError,
  importedValue,
  parseHoldingsFile,
  type ImportedFile,
} from '../lib/linking/importHoldings';
import { lastSyncedAt, linkedAccounts } from '../lib/linking/sync';
import type { SyncSummary } from '../lib/linking/sync';
import { accountValue } from '../lib/investments';
import { Callout, Card, ConfirmButton, Field, useFormatMoney } from './ui';

/**
 * Importing holdings from a brokerage's own export.
 *
 * The path that needs no aggregator, no account, no credentials and no
 * network — and that reaches the institutions aggregators don't, most 401(k)
 * providers among them.
 *
 * Nothing is merged until the user has seen what was read. A parser working
 * across every broker's idea of a CSV will sometimes be wrong, and the failure
 * that matters is the quiet one: a misread column that produces a plausible
 * number. So the review step shows the totals and every warning first, and
 * "Import" is a separate, deliberate press.
 */

function relativeTime(timestamp: number): string {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86_400)} d ago`;
}

export default function ImportHoldings() {
  const data = useStore((s) => s.data);
  const importSnapshots = useStore((s) => s.importSnapshots);
  const unlinkAccountById = useStore((s) => s.unlinkAccountById);
  const fmt = useFormatMoney();

  const fileInput = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<{ file: ImportedFile; name: string } | null>(null);
  const [institution, setInstitution] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SyncSummary | null>(null);

  const imported = linkedAccounts(data.accounts, 'file');
  const importedAt = lastSyncedAt(data.accounts, 'file');

  const reset = (): void => {
    setPending(null);
    setInstitution('');
    if (fileInput.current) fileInput.current.value = '';
  };

  const read = async (file: File): Promise<void> => {
    setError(null);
    setResult(null);
    try {
      const parsed = parseHoldingsFile(file.name, await file.text());
      setPending({ file: parsed, name: file.name });

      // Re-importing next month's export from the same account: whatever the
      // institution was called last time is a far better default than the file
      // name, and saves retyping it every time.
      const known = imported.find((account) =>
        parsed.snapshots.some((s) => s.account.id === account.link!.providerAccountId),
      );
      setInstitution(parsed.snapshots[0]?.account.institution || known?.link?.institution || '');
    } catch (e) {
      reset();
      setError(
        e instanceof ImportError
          ? e.message
          : 'That file could not be read. A CSV or OFX/QFX positions export is what this expects.',
      );
    }
  };

  const confirm = (): void => {
    if (!pending) return;
    // The institution is the one thing a CSV rarely states and the user always
    // knows, so what they type wins over anything read out of the file.
    const typed = institution.trim();
    const snapshots = pending.file.snapshots.map((s) => ({
      ...s,
      account: {
        ...s.account,
        institution: typed || s.account.institution || baseName(pending.name),
      },
    }));

    setResult(importSnapshots(snapshots));
    reset();
  };

  return (
    <Card
      title="Import holdings from a file"
      note={
        importedAt
          ? `Last import ${relativeTime(importedAt)}. Drop in a newer export to refresh.`
          : 'Any brokerage will export your positions as CSV or OFX/QFX. Nothing leaves your device.'
      }
      actions={
        <div className="btn-row">
          <input
            ref={fileInput}
            type="file"
            // Deliberately broad. iOS greys out files whose type it can't
            // match, and a .qfx arriving through Mail or Files is often typed
            // as octet-stream — a picker that won't let you pick your own
            // statement is worse than one that shows too much.
            accept={
              '.csv,.tsv,.txt,.ofx,.qfx,text/csv,text/tab-separated-values,text/plain,' +
              'application/vnd.ms-excel,application/x-ofx,application/octet-stream'
            }
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void read(file);
            }}
          />
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => fileInput.current?.click()}
          >
            Choose a file
          </button>
        </div>
      }
    >
      <div className="stack-sm">
        {error && (
          <Callout tone="critical">
            {error}{' '}
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setError(null)}>
              Dismiss
            </button>
          </Callout>
        )}

        {result && (
          <Callout tone="good">
            Imported {result.updated.length + result.added.length} account
            {result.updated.length + result.added.length === 1 ? '' : 's'},{' '}
            {result.positionCount} position{result.positionCount === 1 ? '' : 's'},{' '}
            {fmt(result.totalValueCents)} total
            {result.added.length > 0 && ` — added ${result.added.join(', ')}`}.{' '}
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setResult(null)}>
              Dismiss
            </button>
          </Callout>
        )}

        {pending && (
          <div className="stack-sm">
            <Callout tone="neutral">
              Read <strong>{pending.file.snapshots.length}</strong> account
              {pending.file.snapshots.length === 1 ? '' : 's'} and{' '}
              <strong>
                {pending.file.snapshots.reduce((n, s) => n + s.positions.length, 0)}
              </strong>{' '}
              positions worth <strong>{fmt(importedValue(pending.file.snapshots))}</strong> from{' '}
              {pending.name}. Nothing has been changed yet.
            </Callout>

            {pending.file.warnings.length > 0 && (
              <Callout tone="warning">
                <strong>Check these before importing:</strong>
                <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
                  {pending.file.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </Callout>
            )}

            {pending.file.errors.length > 0 && (
              <Callout tone="critical">
                <strong>Lines that could not be read:</strong>
                <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
                  {pending.file.errors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </Callout>
            )}

            <Field
              label="Institution"
              hint="Shown against every account from this file. Files rarely say who they came from."
            >
              {(id) => (
                <input
                  id={id}
                  type="text"
                  value={institution}
                  placeholder="Fidelity, Vanguard, Empower…"
                  onChange={(e) => setInstitution(e.target.value)}
                />
              )}
            </Field>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Account</th>
                    <th className="num">Positions</th>
                    <th className="num">Cash</th>
                    <th className="num">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {pending.file.snapshots.map((snapshot) => (
                    <tr key={snapshot.account.id}>
                      <td>{snapshot.account.name}</td>
                      <td className="num mono-num">{snapshot.positions.length}</td>
                      <td className="num mono-num">
                        {snapshot.cashCents ? fmt(snapshot.cashCents) : '—'}
                      </td>
                      <td className="num mono-num">{fmt(snapshot.account.balanceCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="btn-row">
              <button type="button" className="btn btn-sm btn-primary" onClick={confirm}>
                Import {pending.file.snapshots.length} account
                {pending.file.snapshots.length === 1 ? '' : 's'}
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={reset}>
                Cancel
              </button>
            </div>

            {pending.file.skippedRows > 0 && (
              <p className="field-hint" style={{ margin: 0 }}>
                {pending.file.skippedRows} row{pending.file.skippedRows === 1 ? '' : 's'} skipped —
                totals, blank lines and footnotes.
              </p>
            )}
          </div>
        )}

        {!pending && imported.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Institution</th>
                  <th className="num">Value</th>
                  <th>Imported</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {imported.map((account) => (
                  <tr key={account.id}>
                    <td>
                      {account.name}
                      {account.link!.mask && (
                        <span className="muted"> ····{account.link!.mask}</span>
                      )}
                    </td>
                    <td className="secondary">{account.link!.institution}</td>
                    <td className="num mono-num">{fmt(accountValue(account))}</td>
                    <td>
                      {account.link!.lastSyncedAt ? (
                        <span className="secondary" style={{ fontSize: 12.5 }}>
                          {relativeTime(account.link!.lastSyncedAt)}
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="num">
                      <ConfirmButton
                        className="btn btn-sm btn-ghost"
                        confirmLabel="Yes, stop refreshing"
                        onConfirm={() => void unlinkAccountById(account.id, false)}
                      >
                        Stop refreshing
                      </ConfirmButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!pending && (
          <p className="field-hint" style={{ margin: 0 }}>
            Re-importing a file from the same account replaces its holdings and prices, and keeps
            your contribution amounts, account type and any rename. "Stop refreshing" turns the
            account back into ordinary manual entries — nothing is deleted.
          </p>
        )}
      </div>
    </Card>
  );
}

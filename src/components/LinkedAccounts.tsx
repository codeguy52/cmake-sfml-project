import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../store';
import { isLinkingConfigured } from '../lib/linking/client';
import { lastSyncedAt, linkedAccounts } from '../lib/linking/sync';
import type { SyncSummary } from '../lib/linking/sync';
import { Callout, Card, ConfirmButton, EmptyState, useFormatMoney } from './ui';
import { accountValue } from '../lib/investments';
import type { View } from '../App';

/**
 * Brokerage connections.
 *
 * The flow is: register a provider identity → send the user to the
 * aggregator's portal to log into their brokerage → they come back → sync.
 * Their brokerage password is typed at the aggregator and never passes
 * through this app or its backend.
 *
 * A pending connection is flagged in sessionStorage rather than read back off
 * the URL, because providers rewrite query strings on the way back and a hash
 * router makes them harder still to read reliably.
 */

const PENDING_KEY = 'ember:linking-pending';

function relativeTime(timestamp: number): string {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86_400)} d ago`;
}

export default function LinkedAccounts({ onNavigate }: { onNavigate: (view: View) => void }) {
  const data = useStore((s) => s.data);
  const syncing = useStore((s) => s.syncing);
  const { connectBrokerage, syncLinkedAccounts, unlinkAccountById } = useStore();
  const fmt = useFormatMoney();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SyncSummary | null>(null);

  const settings = data.settings.linking;
  const configured = isLinkingConfigured(settings);
  const linked = linkedAccounts(data.accounts);
  const syncedAt = lastSyncedAt(data.accounts);

  const runSync = useCallback(async () => {
    setError(null);
    setResult(null);
    try {
      setResult(await syncLinkedAccounts());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sync failed.');
    }
  }, [syncLinkedAccounts]);

  // Coming back from the provider's portal: sync straight away so the newly
  // connected accounts appear without the user having to press anything.
  useEffect(() => {
    let pending = false;
    try {
      pending = sessionStorage.getItem(PENDING_KEY) === '1';
      if (pending) sessionStorage.removeItem(PENDING_KEY);
    } catch {
      pending = false;
    }
    if (pending && configured) void runSync();
  }, [configured, runSync]);

  const connect = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      // Hash routing means the path is the app root; the provider appends its
      // own parameters after we come back.
      const returnUrl = `${window.location.origin}${window.location.pathname}#/investments`;
      const url = await connectBrokerage(returnUrl);
      try {
        sessionStorage.setItem(PENDING_KEY, '1');
      } catch {
        // Private mode — the user can press Sync manually instead.
      }
      window.location.href = url;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the connection.');
      setBusy(false);
    }
  };

  if (!configured) {
    return (
      <Card
        title="Link a brokerage"
        note="Pull balances and holdings automatically instead of typing them."
      >
        <EmptyState icon="⇄" title="Linking is switched off">
          <p style={{ maxWidth: '62ch', margin: '0 auto 12px' }}>
            Connecting a brokerage needs a small backend of your own to hold the aggregator's API
            keys — they can't ship in the app, because anything in the browser is readable by
            anyone. Until you set one up, add accounts by hand; everything else works the same.
          </p>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => onNavigate('settings')}>
            Set up linking in Settings
          </button>
        </EmptyState>
      </Card>
    );
  }

  return (
    <Card
      title="Linked brokerages"
      note={
        syncedAt
          ? `Last synced ${relativeTime(syncedAt)}.`
          : 'Connect an account to pull holdings automatically.'
      }
      actions={
        <div className="btn-row">
          <button
            type="button"
            className="btn btn-sm"
            disabled={syncing || linked.length === 0}
            onClick={() => void runSync()}
          >
            {syncing ? 'Syncing…' : 'Sync now'}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={busy}
            onClick={() => void connect()}
          >
            {busy ? 'Opening…' : '+ Connect brokerage'}
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
            Synced {result.updated.length + result.added.length} account
            {result.updated.length + result.added.length === 1 ? '' : 's'},{' '}
            {result.positionCount} position{result.positionCount === 1 ? '' : 's'},{' '}
            {fmt(result.totalValueCents)} total
            {result.added.length > 0 && ` — added ${result.added.join(', ')}`}.{' '}
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setResult(null)}>
              Dismiss
            </button>
          </Callout>
        )}

        {linked.length === 0 ? (
          <EmptyState icon="⇄" title="No brokerages connected">
            Connect one and its accounts and holdings appear below, refreshed on every sync.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Institution</th>
                  <th className="num">Value</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {linked.map((account) => {
                  const link = account.link!;
                  return (
                    <tr key={account.id}>
                      <td>
                        {account.name}
                        {link.mask && <span className="muted"> ····{link.mask}</span>}
                      </td>
                      <td className="secondary">{link.institution}</td>
                      <td className="num mono-num">{fmt(accountValue(account))}</td>
                      <td>
                        {link.missingSince ? (
                          <span className="badge" style={{ color: 'var(--critical)' }}>
                            Not returned by provider
                          </span>
                        ) : link.lastError ? (
                          <span className="badge" style={{ color: 'var(--critical)' }} title={link.lastError}>
                            Stale — last sync failed
                          </span>
                        ) : link.lastSyncedAt ? (
                          <span className="secondary" style={{ fontSize: 12.5 }}>
                            {relativeTime(link.lastSyncedAt)}
                          </span>
                        ) : (
                          <span className="muted">Never synced</span>
                        )}
                      </td>
                      <td className="num">
                        <ConfirmButton
                          className="btn btn-sm btn-ghost"
                          // Distinct from the trigger's label: two buttons
                          // reading "Disconnect" makes the confirmation step
                          // ambiguous, especially with several rows on screen.
                          confirmLabel="Yes, disconnect"
                          onConfirm={() => void unlinkAccountById(account.id, true)}
                        >
                          Disconnect
                        </ConfirmButton>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {linked.some((a) => a.link?.missingSince) && (
          <Callout tone="warning">
            An account stopped being returned by the provider — usually a revoked or expired
            connection. Its last known holdings are kept rather than deleted. Reconnect to refresh
            them, or disconnect to keep the figures as manual entries.
          </Callout>
        )}

        <p className="field-hint" style={{ margin: 0 }}>
          Synced accounts have their holdings replaced on every sync. Your contribution amounts,
          account type and any rename are kept. Disconnecting keeps the holdings as manual entries.
        </p>
      </div>
    </Card>
  );
}

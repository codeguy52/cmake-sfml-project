import { useEffect, useRef } from 'react';
import { useStore } from '../store';
import { isLinkingConfigured } from '../lib/linking/client';
import { lastSyncedAt } from '../lib/linking/sync';
import {
  msUntilNextCheck,
  REFRESH_AFTER_MS,
  shouldAutoSync,
  type AutoSyncState,
} from '../lib/linking/autoSync';

/**
 * Keeps linked accounts refreshed without anyone pressing anything.
 *
 * All the judgement lives in `autoSync.ts` as a pure function; this only
 * supplies the current state and the events worth reacting to:
 *
 *   - the app opening
 *   - coming back to the foreground, which on a phone is most of what "opening
 *     it" means, since the tab is never really closed
 *   - the network returning
 *   - a timer, as the fallback for an app left open all day
 *
 * The first three are evidence the data may have moved and bypass the
 * freshness window. The timer isn't, so it doesn't.
 *
 * Every failure is swallowed deliberately. A background refresh that throws a
 * dialog over whatever someone is doing is worse than one that quietly leaves
 * the last known figures on screen with their age attached — which the UI
 * already shows.
 */
export function useAutoSync(): void {
  const settings = useStore((s) => s.data.settings.linking);
  const accounts = useStore((s) => s.data.accounts);
  const syncing = useStore((s) => s.syncing);
  const lastSyncAttemptAt = useStore((s) => s.lastSyncAttemptAt);
  const syncFailures = useStore((s) => s.syncFailures);
  const syncNeedsReconnect = useStore((s) => s.syncNeedsReconnect);
  const syncLinkedAccounts = useStore((s) => s.syncLinkedAccounts);

  // Read through a ref so the event listeners are registered once rather than
  // being torn down and rebuilt on every state change.
  const state: AutoSyncState = {
    enabled: settings.autoSync,
    configured: isLinkingConfigured(settings),
    syncing,
    online: typeof navigator === 'undefined' ? true : navigator.onLine,
    lastSyncedAt: lastSyncedAt(accounts, settings.provider),
    lastAttemptAt: lastSyncAttemptAt,
    consecutiveFailures: syncFailures,
    needsReconnect: syncNeedsReconnect,
  };

  const latest = useRef(state);
  latest.current = state;

  const run = useRef<(force: boolean) => void>(() => {});
  run.current = (force: boolean) => {
    if (!shouldAutoSync(latest.current, Date.now(), { force }).sync) return;
    void syncLinkedAccounts().catch(() => {
      // Recorded in the store and shown against the accounts with its age;
      // never thrown at someone who didn't ask for this sync.
    });
  };

  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') run.current(true);
    };
    const onOnline = (): void => run.current(true);

    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    window.addEventListener('focus', onVisible);

    // On open.
    run.current(true);

    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('focus', onVisible);
    };
  }, []);

  // Switching linking on, or reconnecting, should produce data immediately —
  // nobody who just connected an account expects to press Sync. Tracked as a
  // transition rather than a dependency change, so it fires once on the edge
  // instead of on every re-render that touches these.
  const wasLive = useRef(false);
  useEffect(() => {
    const live = state.configured && state.enabled;
    if (live && !wasLive.current) run.current(true);
    wasLive.current = live;
  }, [state.configured, state.enabled]);

  // The fallback timer for an app left open. Re-armed from the rules rather
  // than on a fixed interval, so a backoff is respected instead of fought.
  useEffect(() => {
    if (!state.configured || !state.enabled) return;

    const delay = Math.min(
      Math.max(msUntilNextCheck(latest.current, Date.now()), 30_000),
      REFRESH_AFTER_MS,
    );
    const timer = setTimeout(() => run.current(false), delay);
    return () => clearTimeout(timer);
    // Re-armed whenever anything that feeds the decision changes.
  }, [
    state.configured,
    state.enabled,
    state.lastSyncedAt,
    state.lastAttemptAt,
    state.consecutiveFailures,
    state.needsReconnect,
    state.syncing,
  ]);
}

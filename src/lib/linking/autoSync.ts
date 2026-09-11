/**
 * When to refresh linked accounts without being asked.
 *
 * A connection that quietly goes stale is worse than no connection at all: the
 * figures still look current, so nobody thinks to check them, and a net worth
 * that's a month out of date is a decision made on fiction. So the app
 * refreshes on its own — on open, when it comes back to the foreground, when
 * the network returns, and on a timer while it's in front of you.
 *
 * The decision is a pure function of state so the rules can be tested without
 * a clock, a network or a browser. Everything that touches those lives in the
 * hook that calls this.
 *
 * Two costs shape the defaults. Brokerages update positions overnight and
 * sometimes intraday, so polling harder than hourly buys nothing real. And an
 * aggregator bills per call or per account, so a refresh nobody asked for is a
 * line on somebody's invoice — restraint here is a feature, not laziness.
 */

/** How old data may get, in the foreground, before it is refreshed. */
export const REFRESH_AFTER_MS = 60 * 60 * 1000;

/** When data is old enough that the UI should say so rather than imply currency. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Backoff after failures, so a backend that is down or a revoked connection is
 * retried occasionally rather than hammered every minute for a day.
 * Capped, because a user who fixes the problem shouldn't wait hours.
 */
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];

export function backoffFor(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  return BACKOFF_MS[Math.min(consecutiveFailures, BACKOFF_MS.length) - 1]!;
}

export interface AutoSyncState {
  /** The user's setting. */
  enabled: boolean;
  /** Whether a backend is configured and usable at all. */
  configured: boolean;
  /** A sync is already running. */
  syncing: boolean;
  /** Browser reports a connection. */
  online: boolean;
  /** Last successful sync, epoch ms, or null if never. */
  lastSyncedAt: number | null;
  /** Last attempt of any kind, successful or not. */
  lastAttemptAt: number | null;
  /** Failures since the last success, for backoff. */
  consecutiveFailures: number;
  /**
   * Set when the provider says the credential is dead. Retrying cannot fix
   * this — only the user reconnecting can — so automatic attempts stop.
   */
  needsReconnect: boolean;
}

export type SyncSkipReason =
  | 'disabled'
  | 'not-configured'
  | 'already-syncing'
  | 'offline'
  | 'needs-reconnect'
  | 'backing-off'
  | 'fresh-enough';

export type AutoSyncDecision = { sync: true } | { sync: false; reason: SyncSkipReason };

/**
 * Whether to start a sync right now.
 *
 * `force` is what a foreground or reconnect event passes: those are real
 * signals that the data may have moved, so they bypass the freshness window —
 * but never the guards that exist to avoid doing harm (offline, already
 * running, dead credential, backing off).
 */
export function shouldAutoSync(
  state: AutoSyncState,
  now: number,
  { force = false }: { force?: boolean } = {},
): AutoSyncDecision {
  if (!state.configured) return { sync: false, reason: 'not-configured' };
  if (!state.enabled) return { sync: false, reason: 'disabled' };
  if (state.syncing) return { sync: false, reason: 'already-syncing' };
  if (!state.online) return { sync: false, reason: 'offline' };
  if (state.needsReconnect) return { sync: false, reason: 'needs-reconnect' };

  if (state.consecutiveFailures > 0 && state.lastAttemptAt !== null) {
    if (now - state.lastAttemptAt < backoffFor(state.consecutiveFailures)) {
      return { sync: false, reason: 'backing-off' };
    }
    // Past the backoff window, a retry is worth it even without a new signal.
    return { sync: true };
  }

  if (force) return { sync: true };

  // Never synced, and nothing has gone wrong: do it.
  if (state.lastSyncedAt === null) return { sync: true };

  if (now - state.lastSyncedAt >= REFRESH_AFTER_MS) return { sync: true };
  return { sync: false, reason: 'fresh-enough' };
}

/** Whether what's on screen is old enough that the UI must say so. */
export function isStale(lastSyncedAt: number | null, now: number): boolean {
  if (lastSyncedAt === null) return false;
  return now - lastSyncedAt >= STALE_AFTER_MS;
}

/**
 * How long until the next check is worth making, for scheduling a timer.
 * Returns the full interval when nothing is known yet rather than zero, so a
 * caller can't spin.
 */
export function msUntilNextCheck(state: AutoSyncState, now: number): number {
  if (state.consecutiveFailures > 0 && state.lastAttemptAt !== null) {
    return Math.max(0, state.lastAttemptAt + backoffFor(state.consecutiveFailures) - now);
  }
  if (state.lastSyncedAt === null) return 0;
  return Math.max(0, state.lastSyncedAt + REFRESH_AFTER_MS - now);
}

import { describe, expect, it } from 'vitest';
import {
  backoffFor,
  isStale,
  msUntilNextCheck,
  REFRESH_AFTER_MS,
  shouldAutoSync,
  STALE_AFTER_MS,
  type AutoSyncState,
} from './autoSync';

const NOW = 1_700_000_000_000;

const ready = (over: Partial<AutoSyncState> = {}): AutoSyncState => ({
  enabled: true,
  configured: true,
  syncing: false,
  online: true,
  lastSyncedAt: NOW - REFRESH_AFTER_MS,
  lastAttemptAt: NOW - REFRESH_AFTER_MS,
  consecutiveFailures: 0,
  needsReconnect: false,
  ...over,
});

describe('when it syncs on its own', () => {
  it('syncs once the data is past the refresh window', () => {
    expect(shouldAutoSync(ready(), NOW)).toEqual({ sync: true });
  });

  it('leaves fresh data alone', () => {
    const state = ready({ lastSyncedAt: NOW - 60_000 });
    expect(shouldAutoSync(state, NOW)).toEqual({ sync: false, reason: 'fresh-enough' });
  });

  it('syncs when it has never synced', () => {
    expect(shouldAutoSync(ready({ lastSyncedAt: null, lastAttemptAt: null }), NOW)).toEqual({
      sync: true,
    });
  });

  it('syncs fresh data when a real signal says it may have moved', () => {
    // Coming back to the foreground, or the network returning, is evidence —
    // a timer firing is not.
    const state = ready({ lastSyncedAt: NOW - 60_000 });
    expect(shouldAutoSync(state, NOW, { force: true })).toEqual({ sync: true });
  });
});

describe('when it refuses', () => {
  it('respects the setting', () => {
    expect(shouldAutoSync(ready({ enabled: false }), NOW)).toEqual({
      sync: false,
      reason: 'disabled',
    });
  });

  it('does nothing without a backend', () => {
    expect(shouldAutoSync(ready({ configured: false }), NOW)).toEqual({
      sync: false,
      reason: 'not-configured',
    });
  });

  it('never runs two syncs at once', () => {
    expect(shouldAutoSync(ready({ syncing: true }), NOW)).toEqual({
      sync: false,
      reason: 'already-syncing',
    });
  });

  it('does not try while offline', () => {
    expect(shouldAutoSync(ready({ online: false }), NOW)).toEqual({
      sync: false,
      reason: 'offline',
    });
  });

  it('stops retrying a credential only the user can fix', () => {
    // Hammering a revoked connection cannot succeed and, with an aggregator
    // that bills per call, is not free either.
    const state = ready({ needsReconnect: true });
    expect(shouldAutoSync(state, NOW, { force: true })).toEqual({
      sync: false,
      reason: 'needs-reconnect',
    });
  });

  it('refuses even a forced sync while offline or mid-sync', () => {
    expect(shouldAutoSync(ready({ online: false }), NOW, { force: true }).sync).toBe(false);
    expect(shouldAutoSync(ready({ syncing: true }), NOW, { force: true }).sync).toBe(false);
  });
});

describe('backing off after failures', () => {
  it('waits longer after each consecutive failure', () => {
    const delays = [1, 2, 3, 4].map(backoffFor);
    expect(delays).toEqual([...delays].sort((a, b) => a - b));
    expect(delays[0]).toBeGreaterThan(0);
  });

  it('caps the wait rather than growing forever', () => {
    // Someone who fixes the problem should not wait a day for the app to notice.
    expect(backoffFor(50)).toBe(backoffFor(4));
    expect(backoffFor(50)).toBeLessThanOrEqual(2 * 60 * 60_000);
  });

  it('holds off inside the backoff window', () => {
    const state = ready({ consecutiveFailures: 2, lastAttemptAt: NOW - 1_000 });
    expect(shouldAutoSync(state, NOW, { force: true })).toEqual({
      sync: false,
      reason: 'backing-off',
    });
  });

  it('retries once the window has passed', () => {
    const state = ready({ consecutiveFailures: 2, lastAttemptAt: NOW - backoffFor(2) });
    expect(shouldAutoSync(state, NOW)).toEqual({ sync: true });
  });

  it('treats no failures as no backoff', () => {
    expect(backoffFor(0)).toBe(0);
  });
});

describe('telling the user when figures are old', () => {
  it('says nothing about data from this morning', () => {
    expect(isStale(NOW - 60 * 60_000, NOW)).toBe(false);
  });

  it('flags data older than a day', () => {
    expect(isStale(NOW - STALE_AFTER_MS, NOW)).toBe(true);
  });

  it('does not call a never-synced account stale', () => {
    // There is nothing to be stale — the UI says "never synced" instead.
    expect(isStale(null, NOW)).toBe(false);
  });
});

describe('scheduling the next check', () => {
  it('waits out the remainder of the refresh window', () => {
    const state = ready({ lastSyncedAt: NOW - 10 * 60_000 });
    expect(msUntilNextCheck(state, NOW)).toBe(REFRESH_AFTER_MS - 10 * 60_000);
  });

  it('waits out the backoff instead when something is failing', () => {
    const state = ready({ consecutiveFailures: 1, lastAttemptAt: NOW });
    expect(msUntilNextCheck(state, NOW)).toBe(backoffFor(1));
  });

  it('is due immediately when nothing has ever synced', () => {
    expect(msUntilNextCheck(ready({ lastSyncedAt: null }), NOW)).toBe(0);
  });

  it('never returns a negative delay', () => {
    const state = ready({ lastSyncedAt: NOW - 10 * REFRESH_AFTER_MS });
    expect(msUntilNextCheck(state, NOW)).toBe(0);
  });
});

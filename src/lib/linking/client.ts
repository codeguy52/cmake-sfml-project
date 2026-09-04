import type { LinkSettings } from '../../types';
import type {
  LinkCredentials,
  LinkError,
  PortalResult,
  RegisterResult,
  RemoteSnapshot,
} from './types';

/**
 * Talks to the small backend the user deploys themselves (see `server/`).
 *
 * The app never holds an aggregator's API keys. Those secrets live only in the
 * backend's environment, because anything shipped to a browser is public —
 * a client-side aggregator key would be readable by anyone who opens devtools
 * and would let them enumerate every connected account.
 *
 * Everything here is a no-op unless a backend URL has been configured, so the
 * default install still makes zero network requests.
 */

const REQUEST_TIMEOUT_MS = 30_000;

function linkError(message: string, status?: number, needsReconnect = false): LinkError {
  const error = new Error(message) as LinkError;
  if (status !== undefined) error.status = status;
  if (needsReconnect) error.needsReconnect = true;
  return error;
}

/** Normalise the configured base URL so a trailing slash can't double up. */
export function normalizeBackendUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

/**
 * Linking is only usable once a backend is configured, consent has been given,
 * and the device holds a provider identity.
 */
export function isLinkingConfigured(settings: LinkSettings): boolean {
  return (
    normalizeBackendUrl(settings.backendUrl).length > 0 && settings.consentedAt !== null
  );
}

export function linkCredentials(settings: LinkSettings): LinkCredentials | null {
  if (!isLinkingConfigured(settings) || !settings.userId || !settings.userSecret) return null;
  return {
    backendUrl: normalizeBackendUrl(settings.backendUrl),
    provider: settings.provider,
    userId: settings.userId,
    userSecret: settings.userSecret,
  };
}

async function post<T>(baseUrl: string, path: string, body: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${normalizeBackendUrl(baseUrl)}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    // An aborted request and a dead backend both land here; distinguish them,
    // because "your backend is down" and "this took too long" need different
    // reactions from the user.
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw linkError('The request timed out. Check that your backend is running.');
    }
    throw linkError(
      'Could not reach your linking backend. Check the URL in Settings and that it is deployed.',
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    // A body is optional on errors, so never let parsing one mask the status.
    let detail = '';
    try {
      const payload = (await response.json()) as { error?: string };
      detail = payload.error ?? '';
    } catch {
      detail = '';
    }

    // 401/403 from the aggregator means the brokerage connection expired.
    const needsReconnect = response.status === 401 || response.status === 403;
    throw linkError(
      detail || `The backend returned ${response.status}.`,
      response.status,
      needsReconnect,
    );
  }

  return (await response.json()) as T;
}

/** Create a provider identity for this device. Called once, then persisted. */
export async function registerUser(backendUrl: string): Promise<RegisterResult> {
  return post<RegisterResult>(backendUrl, '/api/link/register', {});
}

/**
 * Get the URL of the provider's connection portal.
 *
 * The user is sent there to enter their brokerage credentials. Those
 * credentials go to the aggregator and never touch this app or its backend.
 */
export async function createPortalUrl(
  creds: LinkCredentials,
  returnUrl: string,
): Promise<PortalResult> {
  return post<PortalResult>(creds.backendUrl, '/api/link/portal', {
    userId: creds.userId,
    userSecret: creds.userSecret,
    returnUrl,
  });
}

/** Fetch every connected account with its current positions. */
export async function fetchSnapshots(creds: LinkCredentials): Promise<RemoteSnapshot[]> {
  const result = await post<{ snapshots: RemoteSnapshot[] }>(
    creds.backendUrl,
    '/api/link/holdings',
    { userId: creds.userId, userSecret: creds.userSecret },
  );
  return result.snapshots ?? [];
}

/** Revoke one brokerage connection at the provider. */
export async function disconnectAccount(
  creds: LinkCredentials,
  providerAccountId: string,
): Promise<void> {
  await post(creds.backendUrl, '/api/link/disconnect', {
    userId: creds.userId,
    userSecret: creds.userSecret,
    providerAccountId,
  });
}

/** Confirm a backend is reachable and speaks the expected contract. */
export async function checkBackend(backendUrl: string): Promise<{ provider: string; ok: boolean }> {
  return post<{ provider: string; ok: boolean }>(backendUrl, '/api/link/health', {});
}

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, readConfig } from './app.js';

/**
 * The app is a plain function from Request to Response, so these tests need no
 * server, no port and no network — which is the point of the shape.
 *
 * `console.error` is silenced around the cases that deliberately fail, so a
 * green run stays readable.
 */

const ORIGIN = 'http://localhost:5173';

function app(env = {}) {
  return createApp({ PROVIDER: 'mock-personal', ALLOWED_ORIGINS: ORIGIN, ...env });
}

function post(path, body = {}, { origin = ORIGIN, method = 'POST' } = {}) {
  return new Request(`http://backend.test${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: origin },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  });
}

async function quietly(fn) {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

describe('readConfig', () => {
  test('splits and normalises allowed origins', () => {
    const { allowedOrigins } = readConfig({
      ALLOWED_ORIGINS: 'https://a.example/, http://localhost:5173 ,,',
    });
    assert.deepEqual(allowedOrigins, ['https://a.example', 'http://localhost:5173']);
  });

  test('defaults to no allowed origins rather than a wildcard', () => {
    assert.deepEqual(readConfig({}).allowedOrigins, []);
  });

  test('falls back to the real provider when PROVIDER is unset', () => {
    assert.equal(readConfig({}).provider.name, 'snaptrade');
  });

  test('reads the auth mode from the injected environment, not the process', () => {
    assert.equal(readConfig({}).provider.mode, 'personal');
    assert.equal(readConfig({ SNAPTRADE_AUTH_MODE: 'commercial' }).provider.mode, 'commercial');
  });
});

describe('routing', () => {
  test('unknown paths are 404, not 500', async () => {
    const response = await app().handle(post('/api/link/nope'));
    assert.equal(response.status, 404);
  });

  test('GET on a real route is 405', async () => {
    const response = await app().handle(post('/api/link/health', {}, { method: 'GET' }));
    assert.equal(response.status, 405);
  });

  test('a malformed body is a 400, not a crash', async () => {
    const request = new Request('http://backend.test/api/link/health', {
      method: 'POST',
      headers: { Origin: ORIGIN },
      body: '{not json',
    });
    const response = await quietly(() => app().handle(request));
    assert.equal(response.status, 400);
  });

  test('an oversized body is refused', async () => {
    const request = new Request('http://backend.test/api/link/health', {
      method: 'POST',
      headers: { Origin: ORIGIN },
      body: 'x'.repeat(65 * 1024),
    });
    const response = await quietly(() => app().handle(request));
    assert.equal(response.status, 413);
  });
});

describe('CORS', () => {
  test('a preflight from an allowed origin is answered', async () => {
    const response = await app().handle(post('/api/link/health', {}, { method: 'OPTIONS' }));
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
  });

  test('an unlisted origin gets no allow-origin header', async () => {
    const response = await app().handle(
      post('/api/link/health', {}, { origin: 'https://evil.example' }),
    );
    // The request still runs — CORS is the browser's enforcement point — but
    // the browser will refuse to hand the body to the calling page.
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  });

  test('the response varies on origin, so a cache cannot cross-serve it', async () => {
    const response = await app().handle(post('/api/link/health'));
    assert.equal(response.headers.get('vary'), 'Origin');
  });
});

describe('personal mode', () => {
  test('health reports the mode so the app can adapt', async () => {
    const response = await app().handle(post('/api/link/health'));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      provider: 'mock-personal',
      mode: 'personal',
    });
  });

  test('holdings need no user parameters', async () => {
    const response = await app().handle(post('/api/link/holdings'));
    const { snapshots } = await response.json();
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].account.id, 'personal-acct-taxable');
  });

  test('an option position arrives flagged rather than silently valued', async () => {
    const response = await app().handle(post('/api/link/holdings'));
    const { snapshots } = await response.json();
    const option = snapshots[0].positions.find((p) => p.assetClassHint === 'option');
    assert.equal(option.needsReview, true);
    assert.ok(snapshots[0].warnings.some((w) => w.includes('option position')));
  });

  test('foreign cash is reported, never added', async () => {
    const response = await app().handle(post('/api/link/holdings'));
    const { snapshots } = await response.json();
    assert.equal(snapshots[0].cashCents, 6104);
    assert.ok(snapshots[0].warnings.some((w) => w.includes('CAD')));
  });
});

describe('commercial mode', () => {
  const commercial = () => app({ PROVIDER: 'mock' });

  test('holdings without a user are refused', async () => {
    const response = await quietly(() => commercial().handle(post('/api/link/holdings')));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /userId/);
  });

  test('register, connect, sync, disconnect', async () => {
    const backend = commercial();

    const { userId, userSecret } = await (
      await backend.handle(post('/api/link/register'))
    ).json();
    assert.ok(userId && userSecret);

    const portal = await (
      await backend.handle(
        post('/api/link/portal', { userId, userSecret, returnUrl: `${ORIGIN}/settings` }),
      )
    ).json();
    assert.match(portal.redirectUri, /linked=mock/);

    const synced = await (
      await backend.handle(post('/api/link/holdings', { userId, userSecret }))
    ).json();
    assert.equal(synced.snapshots.length, 2);

    const gone = await backend.handle(
      post('/api/link/disconnect', { userId, userSecret, providerAccountId: 'mock-acct-roth' }),
    );
    assert.equal(gone.status, 200);

    const after = await (
      await backend.handle(post('/api/link/holdings', { userId, userSecret }))
    ).json();
    assert.equal(after.snapshots.length, 1);
  });

  test('a stale credential asks for a reconnect rather than failing blankly', async () => {
    const response = await quietly(() =>
      commercial().handle(post('/api/link/holdings', { userId: 'gone', userSecret: 'gone' })),
    );
    assert.equal(response.status, 401);
    assert.equal((await response.json()).needsReconnect, true);
  });

  test('disconnect requires an account to disconnect', async () => {
    const backend = commercial();
    const { userId, userSecret } = await (
      await backend.handle(post('/api/link/register'))
    ).json();
    const response = await quietly(() =>
      backend.handle(post('/api/link/disconnect', { userId, userSecret })),
    );
    assert.equal(response.status, 400);
  });
});

describe('returnUrl', () => {
  test('an off-origin returnUrl is refused — an open redirect here is phishing', async () => {
    const response = await quietly(() =>
      app().handle(post('/api/link/portal', { returnUrl: 'https://evil.example/steal' })),
    );
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /allowed origin/);
  });

  test('a non-URL returnUrl is refused', async () => {
    const response = await quietly(() =>
      app().handle(post('/api/link/portal', { returnUrl: 'javascript:alert(1)' })),
    );
    assert.equal(response.status, 400);
  });

  test('an allowed origin passes, path and query included', async () => {
    const response = await app().handle(
      post('/api/link/portal', { returnUrl: `${ORIGIN}/app/?tab=settings` }),
    );
    assert.equal(response.status, 200);
    const { redirectUri } = await response.json();
    assert.ok(redirectUri.startsWith(`${ORIGIN}/app/?`));
  });
});

describe('error handling', () => {
  test('an unexpected failure never leaks its message to the caller', async () => {
    const backend = app();
    const { provider } = backend.config;
    // The mock is a module singleton, so the swap is undone afterwards rather
    // than left to leak into whatever test runs next.
    const original = provider.check;
    provider.check = async () => {
      throw new Error('consumer key sk_live_12345 rejected');
    };

    try {
      const response = await quietly(() => backend.handle(post('/api/link/health')));
      assert.equal(response.status, 500);
      const body = await response.text();
      assert.equal(JSON.parse(body).error, 'Internal error.');
      assert.ok(!body.includes('sk_live_12345'));
    } finally {
      provider.check = original;
    }
  });
});

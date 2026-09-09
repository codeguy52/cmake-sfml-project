import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';

/**
 * The fetch entry can't be deployed from CI, but the two things most likely to
 * break it silently — a bad import, or configuration not reaching the app —
 * are checkable anywhere `Request` exists.
 */

test('the worker entry serves a request using the bindings it is handed', async () => {
  const request = new Request('http://backend.test/api/link/health', {
    method: 'POST',
    headers: { Origin: 'http://localhost:5173' },
    body: '{}',
  });

  const response = await worker.fetch(request, {
    PROVIDER: 'mock-personal',
    ALLOWED_ORIGINS: 'http://localhost:5173',
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  assert.deepEqual(await response.json(), {
    ok: true,
    provider: 'mock-personal',
    mode: 'personal',
  });
});

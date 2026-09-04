import { createServer } from 'node:http';
import { ProviderError } from './provider.js';
import { mockProvider } from './mock.js';
import { snaptradeProvider } from './snaptrade.js';

/**
 * The linking backend.
 *
 * Small on purpose: it holds the aggregator credentials, exposes five
 * endpoints to the app, and stores nothing. No database, no sessions, no user
 * records — the browser keeps its own provider identity and sends it with each
 * call. That means losing this server loses nothing but connectivity, and it
 * can be redeployed anywhere at any time.
 *
 * Node built-ins only, so `npm install` here is a no-op and it runs on
 * anything with Node 18+.
 */

const PORT = Number(process.env.PORT ?? 8787);

/**
 * Browsers block a page from calling an origin that hasn't opted in, so the
 * app's origin must be listed explicitly. A wildcard would let any site on the
 * internet drive this backend using a stolen userSecret.
 */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim().replace(/\/+$/, ''))
  .filter(Boolean);

const provider = process.env.PROVIDER === 'mock' ? mockProvider : snaptradeProvider;

function corsHeaders(origin) {
  const headers = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  const normalized = (origin ?? '').replace(/\/+$/, '');
  if (normalized && ALLOWED_ORIGINS.includes(normalized)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

function send(res, status, body, origin) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    ...corsHeaders(origin),
  });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    // A linking request is a few hundred bytes; anything larger is a mistake
    // or an attempt to exhaust memory.
    if (size > 64 * 1024) throw new ProviderError('Request body too large.', 413);
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ProviderError('Request body was not valid JSON.', 400);
  }
}

function requireUser(body) {
  const { userId, userSecret } = body;
  if (typeof userId !== 'string' || typeof userSecret !== 'string' || !userId || !userSecret) {
    throw new ProviderError('Missing userId or userSecret.', 400);
  }
  return { userId, userSecret };
}

const routes = {
  '/api/link/health': async () => ({ ok: true, provider: provider.name }),

  '/api/link/register': async () => provider.register(),

  '/api/link/portal': async (body) => {
    const user = requireUser(body);
    if (typeof body.returnUrl !== 'string' || !/^https?:\/\//.test(body.returnUrl)) {
      throw new ProviderError('A valid returnUrl is required.', 400);
    }
    // Only ever send the user back to an origin we recognise — an open
    // redirect here would be a phishing vector wearing your app's name.
    const origin = new URL(body.returnUrl).origin.replace(/\/+$/, '');
    if (ALLOWED_ORIGINS.length > 0 && !ALLOWED_ORIGINS.includes(origin)) {
      throw new ProviderError('returnUrl is not an allowed origin.', 400);
    }
    return provider.portal(user, body.returnUrl);
  },

  '/api/link/holdings': async (body) => {
    const user = requireUser(body);
    return { snapshots: await provider.holdings(user) };
  },

  '/api/link/disconnect': async (body) => {
    const user = requireUser(body);
    if (typeof body.providerAccountId !== 'string' || !body.providerAccountId) {
      throw new ProviderError('providerAccountId is required.', 400);
    }
    await provider.disconnect(user, body.providerAccountId);
    return { ok: true };
  },
};

export const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(origin));
    res.end();
    return;
  }

  const handler = routes[path];
  if (!handler) return send(res, 404, { error: 'Not found.' }, origin);
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' }, origin);

  try {
    const body = await readJson(req);
    send(res, 200, await handler(body), origin);
  } catch (error) {
    const status = error instanceof ProviderError ? error.status : 500;
    // Log server-side, return something safe: upstream errors can carry
    // fragments of credentials or account identifiers.
    console.error(`${path} failed:`, error.message);
    send(
      res,
      status,
      {
        error: error instanceof ProviderError ? error.message : 'Internal error.',
        ...(error?.needsReconnect ? { needsReconnect: true } : {}),
      },
      origin,
    );
  }
});

// Only listen when run directly, so tests can import the server and drive it.
if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  server.listen(PORT, () => {
    console.log(`Linking backend on http://localhost:${PORT} (provider: ${provider.name})`);
    if (ALLOWED_ORIGINS.length === 0) {
      console.warn('ALLOWED_ORIGINS is empty — browser requests will be blocked by CORS.');
    }
  });
}

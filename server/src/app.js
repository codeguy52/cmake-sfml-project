import { ProviderError } from './provider.js';
import { mockPersonalProvider, mockProvider } from './mock.js';
import { createSnaptradeProvider } from './snaptrade.js';

/**
 * The linking backend, as a plain `Request -> Response` function.
 *
 * Written against the web fetch API rather than `node:http` so the same
 * routing runs unchanged on Node, Deno Deploy, Cloudflare Workers and Vercel.
 * Each platform gets a thin entry file that supplies its own config and
 * adapts its own server primitives; nothing in here knows which one it is on.
 *
 * It stores nothing — no database, no sessions, no user records. Losing this
 * service loses nothing but connectivity.
 *
 * Config is injected rather than read from `process.env` at module load,
 * because Workers hand environment values to the request handler instead of
 * exposing a global, and because a pure function is far easier to test.
 */

const PROVIDERS = {
  mock: mockProvider,
  'mock-personal': mockPersonalProvider,
};

/**
 * Normalise whatever an environment looks like into the settings the app
 * needs. Accepts a plain object, so `process.env`, `Deno.env.toObject()` and
 * a Workers `env` binding all work.
 */
export function readConfig(env = {}) {
  return {
    provider: PROVIDERS[env.PROVIDER ?? ''] ?? createSnaptradeProvider(env),
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim().replace(/\/+$/, ''))
      .filter(Boolean),
  };
}

/**
 * Browsers block a page from calling an origin that hasn't opted in, so the
 * app's origin must be listed explicitly. A wildcard would let any site on the
 * internet drive this backend with a stolen credential.
 */
function corsHeaders(origin, allowedOrigins) {
  const headers = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  const normalized = (origin ?? '').replace(/\/+$/, '');
  if (normalized && allowedOrigins.includes(normalized)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

function json(status, body, origin, allowedOrigins) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin, allowedOrigins) },
  });
}

async function readJson(request) {
  const text = await request.text();
  // A linking request is a few hundred bytes; anything larger is a mistake or
  // an attempt to exhaust memory.
  if (text.length > 64 * 1024) throw new ProviderError('Request body too large.', 413);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError('Request body was not valid JSON.', 400);
  }
}

/**
 * A personal API key is itself the identity, so there are no user parameters
 * to validate. Only commercial mode has a user to require.
 */
function requireUser(body, provider) {
  if ((provider.mode ?? 'personal') === 'personal') return {};

  const { userId, userSecret } = body;
  if (typeof userId !== 'string' || typeof userSecret !== 'string' || !userId || !userSecret) {
    throw new ProviderError('Missing userId or userSecret.', 400);
  }
  return { userId, userSecret };
}

function buildRoutes(config) {
  const { provider, allowedOrigins } = config;

  return {
    /**
     * Health also exercises the credentials, so a wrong key fails here with a
     * clear message rather than surfacing later as an empty sync.
     */
    '/api/link/health': async () => {
      const mode = provider.mode ?? 'personal';
      if (typeof provider.check === 'function') await provider.check();
      return { ok: true, provider: provider.name, mode };
    },

    '/api/link/register': async () => provider.register(),

    '/api/link/portal': async (body) => {
      const user = requireUser(body, provider);
      if (typeof body.returnUrl !== 'string' || !/^https?:\/\//.test(body.returnUrl)) {
        throw new ProviderError('A valid returnUrl is required.', 400);
      }
      // Only ever send the user back to an origin we recognise — an open
      // redirect here would be a phishing vector wearing your app's name.
      const origin = new URL(body.returnUrl).origin.replace(/\/+$/, '');
      if (allowedOrigins.length > 0 && !allowedOrigins.includes(origin)) {
        throw new ProviderError('returnUrl is not an allowed origin.', 400);
      }
      return provider.portal(user, body.returnUrl);
    },

    '/api/link/holdings': async (body) => ({
      snapshots: await provider.holdings(requireUser(body, provider)),
    }),

    '/api/link/disconnect': async (body) => {
      const user = requireUser(body, provider);
      if (typeof body.providerAccountId !== 'string' || !body.providerAccountId) {
        throw new ProviderError('providerAccountId is required.', 400);
      }
      await provider.disconnect(user, body.providerAccountId);
      return { ok: true };
    },
  };
}

/** Build a handler bound to one configuration. */
export function createApp(env = {}) {
  const config = readConfig(env);
  const routes = buildRoutes(config);
  const { allowedOrigins } = config;

  return {
    config,

    async handle(request) {
      const origin = request.headers.get('origin');
      const path = new URL(request.url).pathname;

      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders(origin, allowedOrigins) });
      }

      const handler = routes[path];
      if (!handler) return json(404, { error: 'Not found.' }, origin, allowedOrigins);
      if (request.method !== 'POST') {
        return json(405, { error: 'Use POST.' }, origin, allowedOrigins);
      }

      try {
        const body = await readJson(request);
        return json(200, await handler(body), origin, allowedOrigins);
      } catch (error) {
        const status = error instanceof ProviderError ? error.status : 500;
        // Log server-side, return something safe: upstream errors can carry
        // fragments of credentials or account identifiers.
        console.error(`${path} failed:`, error?.message);
        return json(
          status,
          {
            error: error instanceof ProviderError ? error.message : 'Internal error.',
            ...(error?.needsReconnect ? { needsReconnect: true } : {}),
          },
          origin,
          allowedOrigins,
        );
      }
    },
  };
}

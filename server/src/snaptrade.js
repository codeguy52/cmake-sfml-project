import { createHmac } from 'node:crypto';
import { ProviderError, toCents } from './provider.js';

/**
 * SnapTrade provider.
 *
 * ⚠️ WRITTEN FROM THE PUBLISHED API SPEC AND NOT YET EXERCISED AGAINST THE
 * LIVE SERVICE. It was authored in an environment with no outbound access to
 * SnapTrade, so treat the request signing in `sign()` and the response field
 * names in the mappers below as the first things to verify once you have keys.
 * Run `npm run check -- --live` (see README) before trusting a sync.
 *
 * SnapTrade was chosen over Plaid Investments because it is built specifically
 * for brokerage positions — holdings, units and cost basis are first-class,
 * where Plaid treats investments as an add-on tier.
 *
 * Credentials live only in this process's environment. They are never sent to
 * the browser, because anything the browser holds is readable by anyone with
 * devtools, and these keys can enumerate every connected account.
 */

const BASE_URL = 'https://api.snaptrade.com/api/v1';

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new ProviderError(
      `${name} is not set. Add it to the backend's environment before linking.`,
      500,
    );
  }
  return value;
}

/**
 * SnapTrade signs each request with an HMAC over the path, sorted query and
 * body. The signature is base64 of SHA-256 keyed by the consumer key.
 */
function sign({ path, query, content }) {
  const consumerKey = requireEnv('SNAPTRADE_CONSUMER_KEY');

  // The query must be serialised in sorted key order or the signature will
  // not match what the server recomputes.
  const sortedQuery = Object.keys(query)
    .sort()
    .map((key) => `${key}=${encodeURIComponent(query[key])}`)
    .join('&');

  const payload = JSON.stringify({
    content: content ?? null,
    path,
    query: sortedQuery,
  });

  return createHmac('sha256', consumerKey).update(payload).digest('base64');
}

async function call(method, path, { query = {}, body = null } = {}) {
  const clientId = requireEnv('SNAPTRADE_CLIENT_ID');
  const timestamp = Math.floor(Date.now() / 1000).toString();

  const fullQuery = { ...query, clientId, timestamp };
  const signature = sign({ path: `/api/v1${path}`, query: fullQuery, content: body });

  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(fullQuery)) {
    url.searchParams.set(key, String(value));
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Signature: signature,
      },
      body: body === null ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    throw new ProviderError(`Could not reach SnapTrade: ${cause.message}`, 502);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    // 401/403 here usually means the brokerage connection was revoked by the
    // user or expired, which the app surfaces as "reconnect", not "broken".
    const needsReconnect = response.status === 401 || response.status === 403;
    throw new ProviderError(
      `SnapTrade returned ${response.status}: ${text.slice(0, 300)}`,
      response.status,
      needsReconnect,
    );
  }

  if (response.status === 204) return null;
  return response.json();
}

/** SnapTrade nests values inconsistently; read the first key that exists. */
function pick(object, ...keys) {
  for (const key of keys) {
    const value = key.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), object);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function mapAccount(raw) {
  const institution =
    pick(raw, 'institution_name', 'brokerage.name', 'brokerage_authorization.brokerage.name') ??
    'Brokerage';
  const number = pick(raw, 'number', 'account_number');

  return {
    id: String(pick(raw, 'id', 'account_id')),
    name: String(pick(raw, 'name', 'account_name') ?? 'Account'),
    institution: String(institution),
    ...(number ? { mask: String(number).slice(-4) } : {}),
    typeHint: [pick(raw, 'meta.type', 'raw_type', 'account_type'), pick(raw, 'name')]
      .filter(Boolean)
      .join(' '),
    balanceCents: toCents(pick(raw, 'balance.total.amount', 'balance.total', 'total_value.value')),
    currency: String(pick(raw, 'balance.total.currency', 'currency.code') ?? 'USD'),
  };
}

function mapPosition(raw) {
  const symbol =
    pick(
      raw,
      'symbol.symbol.raw_symbol',
      'symbol.symbol.symbol',
      'symbol.raw_symbol',
      'symbol.symbol',
      'symbol',
    ) ?? 'UNKNOWN';

  const price = pick(raw, 'price', 'symbol.price', 'last_price');
  const units = Number(pick(raw, 'units', 'quantity', 'fractional_units') ?? 0);
  const averagePrice = pick(raw, 'average_purchase_price', 'cost_basis.average');

  const position = {
    symbol: String(symbol).toUpperCase(),
    units,
    priceCents: toCents(price),
    currency: String(pick(raw, 'currency.code', 'symbol.currency.code') ?? 'USD'),
  };

  const description = pick(raw, 'symbol.symbol.description', 'symbol.description', 'description');
  if (description) position.description = String(description);

  const typeHint = pick(
    raw,
    'symbol.symbol.type.description',
    'symbol.type.description',
    'symbol.type.code',
  );
  if (typeHint) position.assetClassHint = String(typeHint);

  // Cost basis is reported per share; the app stores it as a total.
  if (averagePrice !== undefined && Number.isFinite(units)) {
    position.costBasisCents = toCents(Number(averagePrice) * units);
  }

  return position;
}

/** @type {import('./provider.js').Provider} */
export const snaptradeProvider = {
  name: 'snaptrade',

  async register() {
    // A random id keeps one browser's connections separate from another's;
    // SnapTrade returns the secret that authorises later reads.
    const userId = `ember-${crypto.randomUUID()}`;
    const result = await call('POST', '/snapTrade/registerUser', {
      body: { userId },
    });
    return {
      userId: String(result.userId ?? userId),
      userSecret: String(result.userSecret),
    };
  },

  async portal({ userId, userSecret }, returnUrl) {
    const result = await call('POST', '/snapTrade/login', {
      query: { userId, userSecret },
      body: {
        // Where SnapTrade sends the browser once the brokerage login is done.
        customRedirect: returnUrl,
        connectionType: 'read',
      },
    });

    const redirectUri = pick(result, 'redirectURI', 'redirect_uri', 'redirectUri');
    if (!redirectUri) {
      throw new ProviderError('SnapTrade did not return a connection URL.', 502);
    }
    return { redirectUri: String(redirectUri) };
  },

  async holdings({ userId, userSecret }) {
    const accounts = await call('GET', '/accounts', { query: { userId, userSecret } });
    if (!Array.isArray(accounts)) return [];

    const snapshots = [];
    for (const rawAccount of accounts) {
      const account = mapAccount(rawAccount);

      const positions = await call('GET', `/accounts/${account.id}/positions`, {
        query: { userId, userSecret },
      });

      const balances = await call('GET', `/accounts/${account.id}/balances`, {
        query: { userId, userSecret },
      }).catch(() => null);

      const cashCents = Array.isArray(balances)
        ? balances.reduce((sum, b) => sum + toCents(pick(b, 'cash', 'buying_power')), 0)
        : 0;

      snapshots.push({
        account,
        positions: Array.isArray(positions) ? positions.map(mapPosition) : [],
        ...(cashCents !== 0 ? { cashCents } : {}),
      });
    }

    return snapshots;
  },

  async disconnect({ userId, userSecret }, providerAccountId) {
    // Authorisations are what actually get revoked; an account id maps to one.
    const accounts = await call('GET', '/accounts', { query: { userId, userSecret } });
    const match = (Array.isArray(accounts) ? accounts : []).find(
      (a) => String(pick(a, 'id', 'account_id')) === providerAccountId,
    );

    const authorizationId = match
      ? pick(match, 'brokerage_authorization.id', 'brokerage_authorization')
      : undefined;

    if (!authorizationId) {
      throw new ProviderError('Could not find the connection for that account.', 404);
    }

    await call('DELETE', `/authorizations/${authorizationId}`, {
      query: { userId, userSecret },
    });
  },
};

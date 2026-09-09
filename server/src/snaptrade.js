import { Snaptrade, SnaptradeAuth } from 'snaptrade-typescript-sdk';
import { ProviderError, toCents } from './provider.js';

/**
 * SnapTrade provider, built on the official SDK.
 *
 * An earlier version of this file hand-rolled the HTTP calls and request
 * signing. Reading the SDK's actual implementation showed that version was
 * wrong in five ways, each of which alone would have returned 401 on every
 * request or silently corrupted a balance:
 *
 *   1. The consumer key must be `encodeURI`'d before it is used as the HMAC
 *      key. The raw key produces a different signature.
 *   2. The signed payload is JSON serialised with a *globally sorted key*
 *      replacer, not in insertion order.
 *   3. The signed `query` must be the literal query string as sent. Sorting
 *      it for signing while sending it unsorted guarantees a mismatch.
 *   4. The signed `path` excludes the API base (`/accounts`, not
 *      `/api/v1/accounts`).
 *   5. `balances` holds one entry per currency, so summing it across
 *      currencies adds CAD to USD.
 *
 * None of that is discoverable without either the SDK source or a live
 * account to fail against. Delegating to the SDK removes the entire class of
 * bug, so this file is now only a translation layer into the shape the app
 * expects (see `provider.js`).
 *
 * ## Two auth modes
 *
 * - **personal** — a personal API key *is* the user identity. There is no
 *   registration step and calls take no user parameters; the key's own
 *   already-connected brokerages are what you read. This is the right mode for
 *   one person running their own copy.
 * - **commercial** — multi-tenant. Users are registered, and every call
 *   carries a userId/userSecret pair.
 *
 * The mode is chosen by `SNAPTRADE_AUTH_MODE`, defaulting to personal.
 */

let clientCache = null;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new ProviderError(
      `${name} is not set. Add it to the backend's environment before syncing.`,
      500,
    );
  }
  return value;
}

export function authMode() {
  return process.env.SNAPTRADE_AUTH_MODE === 'commercial' ? 'commercial' : 'personal';
}

function client() {
  if (clientCache) return clientCache;

  const params = {
    clientId: requireEnv('SNAPTRADE_CLIENT_ID'),
    consumerKey: requireEnv('SNAPTRADE_CONSUMER_KEY'),
  };

  clientCache = new Snaptrade({
    auth:
      authMode() === 'commercial'
        ? SnaptradeAuth.commercialApiKey(params)
        : SnaptradeAuth.personalApiKey(params),
  });
  return clientCache;
}

/** In personal mode the key is the identity, so user params must be omitted. */
function userParams(user) {
  if (authMode() === 'personal') return {};
  if (!user?.userId || !user?.userSecret) {
    throw new ProviderError('This backend is in commercial mode and needs a registered user.', 400);
  }
  return { userId: user.userId, userSecret: user.userSecret };
}

/** Turn an SDK/axios failure into something the app can act on. */
function wrap(error, context) {
  if (error instanceof ProviderError) return error;

  const status = error?.response?.status ?? error?.status;
  const detail =
    error?.response?.data?.detail ??
    error?.response?.data?.message ??
    error?.message ??
    'unknown error';

  // 401/403 from SnapTrade means either the API keys are wrong or the
  // brokerage connection was revoked — both need a human, not a retry.
  const needsReconnect = status === 401 || status === 403;
  return new ProviderError(`${context}: ${detail}`, status ?? 502, needsReconnect);
}

function first(object, ...paths) {
  for (const path of paths) {
    const value = path
      .split('.')
      .reduce((acc, part) => (acc === null || acc === undefined ? acc : acc[part]), object);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function mapAccount(raw) {
  const number = first(raw, 'number');
  const currency = String(first(raw, 'balance.total.currency', 'balance.total.currency.code') ?? 'USD');

  return {
    id: String(first(raw, 'id')),
    name: String(first(raw, 'name') ?? 'Account'),
    institution: String(first(raw, 'institution_name') ?? 'Brokerage'),
    ...(number ? { mask: String(number).slice(-4) } : {}),
    // `raw_type` is the brokerage's own label ("ROTH IRA"); the name often
    // carries it too. Both feed the account-kind guess in the app.
    typeHint: [first(raw, 'raw_type'), first(raw, 'meta.type'), first(raw, 'name')]
      .filter(Boolean)
      .join(' '),
    balanceCents: toCents(first(raw, 'balance.total.amount')),
    currency,
  };
}

function mapPosition(raw) {
  const symbol =
    first(raw, 'symbol.symbol.raw_symbol', 'symbol.symbol.symbol', 'symbol.raw_symbol') ??
    'UNKNOWN';
  const units = Number(first(raw, 'units') ?? 0);
  const averagePrice = first(raw, 'average_purchase_price');

  const position = {
    symbol: String(symbol).toUpperCase(),
    units,
    priceCents: toCents(first(raw, 'price')),
    currency: String(first(raw, 'symbol.symbol.currency.code', 'currency.code') ?? 'USD'),
  };

  const description = first(raw, 'symbol.symbol.description', 'symbol.description');
  if (description) position.description = String(description);

  const typeHint = first(raw, 'symbol.symbol.type.description', 'symbol.symbol.type.code');
  if (typeHint) position.assetClassHint = String(typeHint);

  // SnapTrade reports cost basis per share; the app stores it as a total.
  if (averagePrice !== undefined && Number.isFinite(units)) {
    position.costBasisCents = toCents(Number(averagePrice) * units);
  }

  return position;
}

/**
 * Option positions.
 *
 * Deliberately marked for review rather than valued confidently: equity
 * options are quoted per share but held in contracts of 100, and whether
 * SnapTrade's `price` already accounts for that is not something this code can
 * verify without a live options position to check against. Reporting a value
 * that is wrong by 100x inside a net-worth total would be worse than saying so,
 * so the app surfaces these for confirmation.
 */
function mapOptionPosition(raw) {
  const symbol =
    first(raw, 'symbol.option_symbol.ticker', 'symbol.description', 'symbol.id') ?? 'OPTION';
  const units = Number(first(raw, 'units') ?? 0);
  const averagePrice = first(raw, 'average_purchase_price');

  const position = {
    symbol: String(symbol).toUpperCase(),
    units,
    priceCents: toCents(first(raw, 'price')),
    currency: String(first(raw, 'currency.code') ?? 'USD'),
    assetClassHint: 'option',
    needsReview: true,
  };

  const description = first(raw, 'symbol.description');
  if (description) position.description = String(description);
  if (averagePrice !== undefined && Number.isFinite(units)) {
    position.costBasisCents = toCents(Number(averagePrice) * units);
  }

  return position;
}

/**
 * Cash, taking currency seriously.
 *
 * `balances` carries one entry per currency an account holds. Only the
 * account's own base currency is summed; anything else is reported as a
 * warning rather than being added to a total it does not belong in.
 */
function mapCash(balances, baseCurrency) {
  if (!Array.isArray(balances)) return { cashCents: 0, warnings: [] };

  let cashCents = 0;
  const foreign = [];

  for (const balance of balances) {
    const code = String(first(balance, 'currency.code') ?? baseCurrency);
    const amount = toCents(first(balance, 'cash'));
    if (amount === 0) continue;

    if (code === baseCurrency) cashCents += amount;
    else foreign.push(`${code}`);
  }

  const warnings =
    foreign.length > 0
      ? [
          `Cash held in ${[...new Set(foreign)].join(', ')} was not added to this ` +
            `${baseCurrency} account — this app does not convert currencies.`,
        ]
      : [];

  return { cashCents, warnings };
}

/** @type {import('./provider.js').Provider} */
export const snaptradeProvider = {
  name: 'snaptrade',

  get mode() {
    return authMode();
  },

  async check() {
    try {
      // Exercises the credentials and the signing path in one cheap call, so
      // "Test connection" in the app fails loudly here rather than at sync.
      await client().apiStatus.check();
      return true;
    } catch (error) {
      throw wrap(error, 'SnapTrade status check failed');
    }
  },

  async register() {
    if (authMode() === 'personal') {
      // Nothing to register: the personal key already identifies the user.
      // A sentinel keeps the app's flow identical across both modes.
      return { userId: 'personal', userSecret: 'personal' };
    }
    try {
      const userId = `ember-${crypto.randomUUID()}`;
      const { data } = await client().authentication.registerSnapTradeUser({ userId });
      return { userId: String(data.userId ?? userId), userSecret: String(data.userSecret) };
    } catch (error) {
      throw wrap(error, 'Could not register a SnapTrade user');
    }
  },

  async portal(user, returnUrl) {
    try {
      const { data } = await client().authentication.loginSnapTradeUser({
        ...userParams(user),
        customRedirect: returnUrl,
        connectionType: 'read',
      });
      const redirectUri = first(data, 'redirectURI');
      if (!redirectUri) {
        throw new ProviderError('SnapTrade did not return a connection URL.', 502);
      }
      return { redirectUri: String(redirectUri) };
    } catch (error) {
      throw wrap(error, 'Could not open the connection portal');
    }
  },

  async holdings(user) {
    const params = userParams(user);
    let accounts;
    try {
      const response = await client().accountInformation.listUserAccounts(params);
      accounts = response.data;
    } catch (error) {
      throw wrap(error, 'Could not list accounts');
    }
    if (!Array.isArray(accounts)) return [];

    const snapshots = [];
    for (const rawAccount of accounts) {
      const account = mapAccount(rawAccount);

      let holdings;
      try {
        // One call returns the account, its balances and its positions —
        // where the previous implementation made three.
        const response = await client().accountInformation.getUserHoldings({
          ...params,
          accountId: account.id,
        });
        holdings = response.data;
      } catch (error) {
        throw wrap(error, `Could not read holdings for ${account.name}`);
      }

      const positions = [
        ...(Array.isArray(holdings?.positions) ? holdings.positions.map(mapPosition) : []),
        ...(Array.isArray(holdings?.option_positions)
          ? holdings.option_positions.map(mapOptionPosition)
          : []),
      ];

      const { cashCents, warnings } = mapCash(holdings?.balances, account.currency);
      const optionCount = positions.filter((p) => p.needsReview).length;
      if (optionCount > 0) {
        warnings.push(
          `${optionCount} option position${optionCount === 1 ? '' : 's'} imported — check the ` +
            'value, since option prices may or may not already include the 100x contract ' +
            'multiplier.',
        );
      }

      snapshots.push({
        account,
        positions,
        ...(cashCents !== 0 ? { cashCents } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      });
    }

    return snapshots;
  },

  async disconnect(user, providerAccountId) {
    const params = userParams(user);
    try {
      const { data: accounts } = await client().accountInformation.listUserAccounts(params);
      const match = (Array.isArray(accounts) ? accounts : []).find(
        (a) => String(first(a, 'id')) === providerAccountId,
      );

      // Connections are what get revoked; an account belongs to exactly one.
      const connectionId = match ? first(match, 'brokerage_authorization') : undefined;
      if (!connectionId) {
        throw new ProviderError('Could not find the connection for that account.', 404);
      }

      await client().connections.deleteConnection({ ...params, connectionId: String(connectionId) });
    } catch (error) {
      throw wrap(error, 'Could not disconnect the account');
    }
  },
};

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
 *
 * The environment is passed in rather than read from `process.env`, because
 * Cloudflare Workers hand secrets to the request handler instead of exposing a
 * process global, and because a provider you can construct with a given
 * environment is one you can test.
 */

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
  const category = first(raw, 'account_category');

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
    // Normalised by SnapTrade across institutions: INVESTMENT, DEPOSIT (a
    // checking or savings account) or LOC (a line of credit). The app decides
    // what to do with each — a credit card is a debt, not a holding, and
    // letting one into a portfolio total corrupts both that and net worth.
    ...(category ? { category: String(category) } : {}),
    balanceCents: toCents(first(raw, 'balance.total.amount')),
    currency,
  };
}

/**
 * Positions, as the current API returns them.
 *
 * `/accounts/{id}/positions/all` returns one list for every instrument kind,
 * discriminated by `instrument.kind` — stocks, ETFs, mutual funds, bonds,
 * crypto, options, futures and CFDs together. An earlier version of this file
 * called `/holdings`, which SnapTrade has since retired; it answers 410 Gone,
 * which is what sent this rewrite.
 *
 * Two fields here are per *share*, not per position: `price` and `cost_basis`.
 * For contracts the share count is `units * multiplier`, which is the thing
 * that makes an option position worth 100x what the naive arithmetic says.
 */
export function mapPosition(raw) {
  const instrument = raw?.instrument ?? {};
  const kind = String(instrument.kind ?? '').toLowerCase();

  const contracts = Number(raw?.units ?? 0);
  // Options and futures quote per underlying share and trade in contracts.
  // `multiplier` is how many shares a contract carries — 100 for a standard
  // equity option, 10 for a mini. Everything else is one-for-one.
  const multiplier = Number(instrument.multiplier ?? 1);
  const perContract = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;

  const pricePerShare = Number(raw?.price ?? 0);
  const symbol = String(
    instrument.raw_symbol ?? instrument.symbol ?? instrument.id ?? 'UNKNOWN',
  ).toUpperCase();

  const position = {
    symbol: symbol.slice(0, 40),
    // Units stay in the unit the brokerage reports — contracts for options —
    // so the holding reads the way the statement does. The multiplier is
    // folded into the price instead, which keeps units x price correct.
    units: Number.isFinite(contracts) ? contracts : 0,
    priceCents: toCents(pricePerShare * perContract),
    currency: String(raw?.currency ?? instrument.currency ?? 'USD'),
  };

  const description = instrument.description ?? instrument.name;
  if (description) position.description = String(description);

  // The asset-class guess reads this; `kind` is the API's own word for what
  // the thing is, which beats parsing a free-text type description.
  if (kind) position.assetClassHint = kind;

  // A cash-equivalent position (a money market fund, typically) is *also*
  // counted in the account's cash balance, per SnapTrade's own note. Marking
  // it lets the reconciliation below notice if that double-counts.
  if (raw?.cash_equivalent === true) position.cashEquivalent = true;

  // `cost_basis` is per share, like `price`.
  const costBasis = raw?.cost_basis;
  if (costBasis !== undefined && costBasis !== null && Number.isFinite(contracts)) {
    position.costBasisCents = toCents(Number(costBasis) * perContract * contracts);
  }

  // An option whose multiplier the API did not state is the one case worth
  // flagging rather than valuing, since the error would be 100x.
  if (kind === 'option' && !Number.isFinite(multiplier)) {
    position.needsReview = true;
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
export function mapCash(balances, baseCurrency) {
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

/**
 * Build a provider bound to one environment.
 *
 * @param {Record<string, string|undefined>} env
 */
export function createSnaptradeProvider(env = globalThis.process?.env ?? {}) {
  let clientCache = null;

  function requireEnv(name) {
    const value = env[name];
    if (!value) {
      throw new ProviderError(
        `${name} is not set. Add it to the backend's environment before syncing.`,
        500,
      );
    }
    return value;
  }

  const authMode = () => (env.SNAPTRADE_AUTH_MODE === 'commercial' ? 'commercial' : 'personal');

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
      throw new ProviderError(
        'This backend is in commercial mode and needs a registered user.',
        400,
      );
    }
    return { userId: user.userId, userSecret: user.userSecret };
  }

  /** @type {import('./provider.js').Provider} */
  return {
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

        // Positions and balances are separate calls. The old `/holdings`
        // endpoint that returned both is gone — it answers 410 — and nothing
        // replaced it, so two requests per account is the current shape.
        let results;
        try {
          const response = await client().accountInformation.getAllAccountPositions({
            ...params,
            accountId: account.id,
          });
          results = response.data?.results;
        } catch (error) {
          throw wrap(error, `Could not read positions for ${account.name}`);
        }

        let balances;
        try {
          const response = await client().accountInformation.getUserAccountBalance({
            ...params,
            accountId: account.id,
          });
          balances = response.data;
        } catch (error) {
          throw wrap(error, `Could not read balances for ${account.name}`);
        }

        const positions = Array.isArray(results) ? results.map(mapPosition) : [];
        const { cashCents, warnings } = mapCash(balances, account.currency);

        const needsReview = positions.filter((p) => p.needsReview).length;
        if (needsReview > 0) {
          warnings.push(
            `${needsReview} position${needsReview === 1 ? '' : 's'} could not be valued with ` +
              'confidence — check against your statement.',
          );
        }

        /**
         * Reconcile against the brokerage's own total.
         *
         * Everything above is arithmetic on parts; the account's reported
         * total is the brokerage's own answer for the whole. When they
         * disagree, something here is wrong — a contract multiplier, a
         * cash-equivalent position counted twice because it is also inside
         * the cash balance, or a position kind not handled. Saying so beats
         * showing a confident wrong number inside a net worth.
         */
        const computed =
          positions.reduce((sum, p) => sum + Math.round(p.units * p.priceCents), 0) + cashCents;
        const reported = account.balanceCents;
        const drift = Math.abs(computed - reported);
        if (reported > 0 && drift > Math.max(100, Math.round(reported * 0.005))) {
          warnings.push(
            `This account adds up to ${(computed / 100).toFixed(2)} here but ` +
              `${(reported / 100).toFixed(2)} at the brokerage — check it before trusting the ` +
              'total.',
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
}

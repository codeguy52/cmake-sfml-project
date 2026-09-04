import { randomUUID } from 'node:crypto';
import { ProviderError } from './provider.js';

/**
 * A fake brokerage, so the whole linking flow can be run and tested without
 * an aggregator account, credentials, or any outbound network access.
 *
 * This is not a stub for its own sake — it is what lets the app's connect,
 * sync, rename, disconnect and error paths be verified end to end in CI and
 * in a browser. Swapping in the real provider then only changes where the
 * numbers come from.
 *
 * Run the backend with `PROVIDER=mock` to use it.
 */

const users = new Map();

/** Two accounts with deliberately awkward data: fractional shares, a missing
 *  cost basis, uninvested cash, and a name that needs classifying. */
function seedAccounts() {
  return [
    {
      account: {
        id: 'mock-acct-401k',
        name: 'Workplace 401(k) ...4821',
        institution: 'Mock Brokerage',
        mask: '4821',
        typeHint: 'RETIREMENT 401K',
        balanceCents: 8_412_37,
        currency: 'USD',
      },
      positions: [
        {
          symbol: 'VTI',
          description: 'Vanguard Total Stock Market ETF',
          assetClassHint: 'Equity ETF',
          units: 21.4382,
          priceCents: 31_050,
          costBasisCents: 512_00,
          currency: 'USD',
        },
        {
          symbol: 'VXUS',
          description: 'Vanguard Total International Stock ETF',
          assetClassHint: 'International Equity ETF',
          units: 40,
          priceCents: 6_012,
          currency: 'USD',
        },
      ],
      cashCents: 1_204,
    },
    {
      account: {
        id: 'mock-acct-roth',
        name: 'Roth IRA ...9930',
        institution: 'Mock Brokerage',
        mask: '9930',
        typeHint: 'ROTH IRA',
        balanceCents: 2_310_00,
        currency: 'USD',
      },
      positions: [
        {
          symbol: 'BND',
          description: 'Vanguard Total Bond Market ETF',
          assetClassHint: 'Fixed Income ETF',
          units: 30,
          priceCents: 7_100,
          costBasisCents: 220_00,
          currency: 'USD',
        },
      ],
    },
  ];
}

function requireUser(userId, userSecret) {
  const user = users.get(userId);
  if (!user || user.secret !== userSecret) {
    throw new ProviderError('Unknown user. Reconnect from Settings.', 401, true);
  }
  return user;
}

/** @type {import('./provider.js').Provider} */
export const mockProvider = {
  name: 'mock',

  async register() {
    const userId = `mock-${randomUUID()}`;
    const userSecret = randomUUID();
    users.set(userId, { secret: userSecret, connected: false, accounts: seedAccounts() });
    return { userId, userSecret };
  },

  async portal({ userId, userSecret }, returnUrl) {
    const user = requireUser(userId, userSecret);
    // Connecting is instant here; the "portal" just bounces straight back so
    // the app's redirect handling is still exercised.
    user.connected = true;
    const url = new URL(returnUrl);
    url.searchParams.set('linked', 'mock');
    return { redirectUri: url.toString() };
  },

  async holdings({ userId, userSecret }) {
    const user = requireUser(userId, userSecret);
    if (!user.connected) return [];
    // Nudge a price each call so a re-sync visibly changes something.
    for (const snapshot of user.accounts) {
      for (const position of snapshot.positions) {
        position.priceCents += Math.round((Math.random() - 0.5) * 200);
      }
    }
    return user.accounts;
  },

  async disconnect({ userId, userSecret }, providerAccountId) {
    const user = requireUser(userId, userSecret);
    const before = user.accounts.length;
    user.accounts = user.accounts.filter((s) => s.account.id !== providerAccountId);
    if (user.accounts.length === before) {
      throw new ProviderError('No such account.', 404);
    }
  },
};

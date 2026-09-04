/**
 * The provider interface the app's backend is written against.
 *
 * Everything the browser sees is defined here, not by the aggregator. That
 * boundary is the point: swapping SnapTrade for Plaid, or running against the
 * mock, is a change in this directory and never in the app.
 *
 * @typedef {Object} RemoteAccount
 * @property {string} id
 * @property {string} name
 * @property {string} institution
 * @property {string} [mask]
 * @property {string} [typeHint]
 * @property {number} balanceCents
 * @property {string} currency
 *
 * @typedef {Object} RemotePosition
 * @property {string} symbol
 * @property {string} [description]
 * @property {string} [assetClassHint]
 * @property {number} units
 * @property {number} priceCents
 * @property {number} [costBasisCents]
 * @property {string} currency
 *
 * @typedef {Object} RemoteSnapshot
 * @property {RemoteAccount} account
 * @property {RemotePosition[]} positions
 * @property {number} [cashCents]
 *
 * @typedef {Object} Provider
 * @property {string} name
 * @property {() => Promise<{userId: string, userSecret: string}>} register
 * @property {(user: {userId: string, userSecret: string}, returnUrl: string) => Promise<{redirectUri: string}>} portal
 * @property {(user: {userId: string, userSecret: string}) => Promise<RemoteSnapshot[]>} holdings
 * @property {(user: {userId: string, userSecret: string}, providerAccountId: string) => Promise<void>} disconnect
 */

/** Dollars (or any major unit) to integer cents, matching the app's convention. */
export function toCents(amount) {
  if (amount === null || amount === undefined) return 0;
  const value = typeof amount === 'string' ? Number(amount) : amount;
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100);
}

export class ProviderError extends Error {
  constructor(message, status = 502, needsReconnect = false) {
    super(message);
    this.status = status;
    this.needsReconnect = needsReconnect;
  }
}

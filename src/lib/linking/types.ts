import type { AssetClass, Cents, LinkProvider } from '../../types';

/**
 * The shape the app expects back from the linking backend.
 *
 * Deliberately provider-neutral: the backend translates whatever SnapTrade,
 * Plaid or anything else returns into these, so swapping aggregators is a
 * change in `server/` and never in the app. Every money field is already in
 * integer cents by the time it crosses this boundary, matching the rest of the
 * codebase.
 */

export interface RemoteAccount {
  /** The provider's stable id for the account. Syncs match on this. */
  id: string;
  /** Account name as the institution reports it, e.g. "Roth IRA ...4821". */
  name: string;
  institution: string;
  /** Last four of the account number, when available. */
  mask?: string;
  /** The provider's account-type string, mapped to our kinds best-effort. */
  typeHint?: string;
  /** Total account value including any uninvested cash. */
  balanceCents: Cents;
  currency: string;
}

export interface RemotePosition {
  symbol: string;
  description?: string;
  /** Provider's asset-class string, if it gives one. */
  assetClassHint?: string;
  /** Share count. Fractional shares are normal. */
  units: number;
  priceCents: Cents;
  /** Total cost basis when the provider reports it. */
  costBasisCents?: Cents;
  currency: string;
}

export interface RemoteSnapshot {
  account: RemoteAccount;
  positions: RemotePosition[];
  /** Uninvested cash, held as a synthetic position so it isn't lost. */
  cashCents?: Cents;
}

/** Registration response — the identity the device keeps for later calls. */
export interface RegisterResult {
  userId: string;
  userSecret: string;
}

/** A connection portal the user is sent to in order to log into a brokerage. */
export interface PortalResult {
  redirectUri: string;
}

export interface LinkError extends Error {
  /** HTTP status when the failure came from the backend. */
  status?: number;
  /** True when the credentials are stale and the user must reconnect. */
  needsReconnect?: boolean;
}

/** Everything the client needs to talk to a configured backend. */
export interface LinkCredentials {
  backendUrl: string;
  provider: LinkProvider;
  userId: string;
  userSecret: string;
}

/**
 * Map a provider's free-form asset-class or symbol hint onto our fixed set.
 *
 * Providers disagree wildly here, so this is a best guess that the user can
 * always correct — it feeds a display grouping, not any money arithmetic.
 */
export function mapAssetClass(hint: string | undefined, symbol: string): AssetClass {
  const text = `${hint ?? ''} ${symbol}`.toLowerCase();

  if (/crypto|bitcoin|btc|ethereum|eth\b/.test(text)) return 'crypto';
  if (/bond|treasury|fixed.?income|agg\b|bnd\b|tlt\b|govt/.test(text)) return 'bond';
  if (/reit|real.?estate|vnq\b/.test(text)) return 'reit';
  if (/cash|money.?market|sweep|settlement/.test(text)) return 'cash';
  if (/international|intl|ex.?us|emerging|developed|vxus\b|vea\b|vwo\b|ixus\b/.test(text)) {
    return 'intl_stock';
  }
  if (/equity|stock|etf|fund|index|vti\b|voo\b|spy\b|vtsax\b/.test(text)) return 'us_stock';

  return 'other';
}

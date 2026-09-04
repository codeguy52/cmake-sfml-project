import type {
  AccountKind,
  Cents,
  Holding,
  InvestmentAccount,
  LinkProvider,
  TaxTreatment,
} from '../../types';
import { newId } from '../seed';
import { roundCents } from '../money';
import { mapAssetClass, type RemoteSnapshot } from './types';

/**
 * Merging a brokerage sync into local accounts.
 *
 * The governing rule is that a sync must never destroy something a person
 * typed. So ownership is split:
 *
 *   - The provider owns holdings, prices and balances. These are replaced
 *     wholesale each sync, because a partial merge of positions produces
 *     duplicates the moment a ticker is sold and rebought.
 *   - The person owns the display name (once they change it), the monthly
 *     contribution and employer match, and the account/tax classification.
 *     None of these exist at the brokerage in a form worth trusting, and all
 *     of them feed the FI projection.
 *
 * An account that disappears from the provider is marked, never deleted —
 * a revoked connection or a provider hiccup must not silently wipe the
 * portfolio the FI projection is built on.
 *
 * Everything here is pure so the rules are testable without a network.
 */

interface KindGuess {
  kind: AccountKind;
  taxTreatment: TaxTreatment;
}

/** Order matters: "Roth IRA" must not match the plain-IRA rule first. */
const KIND_RULES: { test: RegExp; result: KindGuess }[] = [
  { test: /roth\s*401/, result: { kind: '401k', taxTreatment: 'roth' } },
  { test: /roth/, result: { kind: 'roth_ira', taxTreatment: 'roth' } },
  { test: /\b401\s*\(?k\)?/, result: { kind: '401k', taxTreatment: 'pretax' } },
  { test: /\b403\s*\(?b\)?/, result: { kind: '403b', taxTreatment: 'pretax' } },
  { test: /\btsp\b|thrift\s*savings/, result: { kind: 'tsp', taxTreatment: 'pretax' } },
  { test: /\bhsa\b|health\s*savings/, result: { kind: 'hsa', taxTreatment: 'hsa' } },
  { test: /\b529\b|college/, result: { kind: '529', taxTreatment: 'taxable' } },
  { test: /\bira\b|individual\s*retirement/, result: { kind: 'ira', taxTreatment: 'pretax' } },
  { test: /crypto|coinbase|digital\s*asset/, result: { kind: 'crypto', taxTreatment: 'taxable' } },
  { test: /checking|savings|cash\s*management/, result: { kind: 'cash', taxTreatment: 'taxable' } },
];

/** Best-effort classification from the provider's type string and account name. */
export function guessAccountKind(typeHint: string | undefined, name: string): KindGuess {
  const text = `${typeHint ?? ''} ${name}`.toLowerCase();
  for (const rule of KIND_RULES) {
    if (rule.test.test(text)) return rule.result;
  }
  return { kind: 'taxable', taxTreatment: 'taxable' };
}

/** Symbol used for the synthetic holding that carries uninvested cash. */
export const CASH_SYMBOL = '$CASH';

/**
 * Build the holdings for a synced account.
 *
 * Holding ids are reused when the symbol is unchanged. That keeps React keys
 * and chart identities stable across a sync, so a refresh doesn't make the
 * allocation chart flash and re-animate for no reason.
 */
export function holdingsFromSnapshot(
  snapshot: RemoteSnapshot,
  existing: Holding[],
): Holding[] {
  const bySymbol = new Map(existing.map((h) => [h.symbol.toUpperCase(), h]));

  const holdings: Holding[] = snapshot.positions.map((position) => {
    const symbol = position.symbol.toUpperCase();
    const prior = bySymbol.get(symbol);

    const holding: Holding = {
      id: prior?.id ?? newId('hold'),
      symbol,
      name: position.description ?? prior?.name ?? '',
      assetClass: mapAssetClass(position.assetClassHint, symbol),
      shares: position.units,
      priceCents: position.priceCents,
      // Not every provider reports cost basis. Keeping the previous value beats
      // zeroing it, since a zero basis silently reads as "100% gain".
      costBasisCents: position.costBasisCents ?? prior?.costBasisCents ?? 0,
    };

    // Expense ratios never come from the provider, so carry over anything the
    // user entered by hand.
    if (prior?.expenseRatioBps !== undefined) holding.expenseRatioBps = prior.expenseRatioBps;

    return holding;
  });

  const cash = snapshot.cashCents ?? 0;
  if (cash !== 0) {
    const prior = bySymbol.get(CASH_SYMBOL);
    holdings.push({
      id: prior?.id ?? newId('hold'),
      symbol: CASH_SYMBOL,
      name: 'Uninvested cash',
      assetClass: 'cash',
      // Modelled as one "share" priced at the cash balance, so it flows through
      // the same value arithmetic as everything else.
      shares: 1,
      priceCents: cash,
      costBasisCents: cash,
    });
  }

  return holdings;
}

export interface SyncSummary {
  added: string[];
  updated: string[];
  /** Linked accounts the provider stopped returning. Kept, not deleted. */
  missing: string[];
  positionCount: number;
  totalValueCents: Cents;
}

export interface SyncResult {
  accounts: InvestmentAccount[];
  summary: SyncSummary;
}

function snapshotValue(snapshot: RemoteSnapshot): Cents {
  const positions = snapshot.positions.reduce(
    (sum, p) => sum + roundCents(p.units * p.priceCents),
    0,
  );
  return positions + (snapshot.cashCents ?? 0);
}

/**
 * Fold a set of provider snapshots into the existing account list.
 *
 * `now` is injectable so tests don't depend on the clock.
 */
export function mergeSnapshots(
  existing: InvestmentAccount[],
  snapshots: RemoteSnapshot[],
  provider: LinkProvider,
  now: number = Date.now(),
): SyncResult {
  const summary: SyncSummary = {
    added: [],
    updated: [],
    missing: [],
    positionCount: 0,
    totalValueCents: 0,
  };

  const byProviderId = new Map(
    existing
      .filter((a) => a.link?.provider === provider)
      .map((a) => [a.link!.providerAccountId, a]),
  );
  const seen = new Set<string>();

  const merged: InvestmentAccount[] = existing.map((account) => {
    // Manual accounts, and accounts from a different provider, are untouched.
    if (account.link?.provider !== provider) return account;

    const snapshot = snapshots.find((s) => s.account.id === account.link!.providerAccountId);
    if (!snapshot) {
      // Still missing — leave the existing marker alone so the UI can say how
      // long it has been gone.
      if (account.link.missingSince !== undefined) {
        summary.missing.push(account.name);
        return account;
      }
      summary.missing.push(account.name);
      return { ...account, link: { ...account.link, missingSince: now } };
    }

    seen.add(snapshot.account.id);
    summary.updated.push(account.name);
    summary.positionCount += snapshot.positions.length;
    summary.totalValueCents += snapshotValue(snapshot);

    const { missingSince: _gone, lastError: _err, ...link } = account.link;

    return {
      ...account,
      // A renamed account keeps its name; an untouched one follows the broker.
      name: account.nameOverridden ? account.name : snapshot.account.name,
      holdings: holdingsFromSnapshot(snapshot, account.holdings),
      link: {
        ...link,
        institution: snapshot.account.institution,
        ...(snapshot.account.mask !== undefined ? { mask: snapshot.account.mask } : {}),
        lastSyncedAt: now,
      },
    };
  });

  for (const snapshot of snapshots) {
    if (seen.has(snapshot.account.id) || byProviderId.has(snapshot.account.id)) continue;

    const guess = guessAccountKind(snapshot.account.typeHint, snapshot.account.name);
    summary.added.push(snapshot.account.name);
    summary.positionCount += snapshot.positions.length;
    summary.totalValueCents += snapshotValue(snapshot);

    merged.push({
      id: newId('acct'),
      name: snapshot.account.name,
      kind: guess.kind,
      taxTreatment: guess.taxTreatment,
      holdings: holdingsFromSnapshot(snapshot, []),
      // The provider cannot know what someone intends to contribute, and
      // guessing would quietly corrupt the FI projection.
      monthlyContributionCents: 0,
      link: {
        provider,
        providerAccountId: snapshot.account.id,
        institution: snapshot.account.institution,
        ...(snapshot.account.mask !== undefined ? { mask: snapshot.account.mask } : {}),
        lastSyncedAt: now,
      },
    });
  }

  return { accounts: merged, summary };
}

/** Record a failed sync against every linked account, keeping stale figures. */
export function markSyncFailure(
  accounts: InvestmentAccount[],
  provider: LinkProvider,
  message: string,
): InvestmentAccount[] {
  return accounts.map((account) =>
    account.link?.provider === provider
      ? { ...account, link: { ...account.link, lastError: message } }
      : account,
  );
}

/** Detach an account from its connection, keeping the data as manual entry. */
export function unlinkAccount(
  accounts: InvestmentAccount[],
  accountId: string,
): InvestmentAccount[] {
  return accounts.map((account) => {
    if (account.id !== accountId || !account.link) return account;
    const { link: _dropped, ...rest } = account;
    return rest;
  });
}

export function linkedAccounts(accounts: InvestmentAccount[]): InvestmentAccount[] {
  return accounts.filter((a) => a.link !== undefined);
}

/** Most recent successful sync across all linked accounts, or null. */
export function lastSyncedAt(accounts: InvestmentAccount[]): number | null {
  const times = linkedAccounts(accounts)
    .map((a) => a.link!.lastSyncedAt)
    .filter((t): t is number => t !== null);
  return times.length > 0 ? Math.max(...times) : null;
}

import { describe, expect, it } from 'vitest';
import type { InvestmentAccount } from '../../types';
import {
  CASH_SYMBOL,
  guessAccountKind,
  holdingsFromSnapshot,
  lastSyncedAt,
  markSyncFailure,
  mergeSnapshots,
  unlinkAccount,
} from './sync';
import { mapAssetClass, type RemoteSnapshot } from './types';

const NOW = 1_772_000_000_000;

function snapshot(overrides: Partial<RemoteSnapshot> & { id: string }): RemoteSnapshot {
  return {
    account: {
      id: overrides.id,
      name: overrides.account?.name ?? 'Brokerage Account',
      institution: overrides.account?.institution ?? 'Mock Brokerage',
      balanceCents: overrides.account?.balanceCents ?? 0,
      currency: 'USD',
      ...overrides.account,
    },
    positions: overrides.positions ?? [],
    ...(overrides.cashCents !== undefined ? { cashCents: overrides.cashCents } : {}),
  };
}

function linkedAccount(overrides: Partial<InvestmentAccount> = {}): InvestmentAccount {
  return {
    id: 'acct-1',
    name: 'Workplace 401(k)',
    kind: '401k',
    taxTreatment: 'pretax',
    holdings: [],
    monthlyContributionCents: 100_000,
    employerMatchCents: 50_000,
    link: {
      provider: 'snaptrade',
      providerAccountId: 'remote-1',
      institution: 'Mock Brokerage',
      lastSyncedAt: NOW - 86_400_000,
    },
    ...overrides,
  };
}

describe('guessAccountKind', () => {
  it('reads Roth before plain IRA', () => {
    expect(guessAccountKind('ROTH IRA', 'Roth IRA ...9930')).toEqual({
      kind: 'roth_ira',
      taxTreatment: 'roth',
    });
    expect(guessAccountKind('TRADITIONAL IRA', 'IRA')).toEqual({
      kind: 'ira',
      taxTreatment: 'pretax',
    });
  });

  it('distinguishes a Roth 401(k) from a Roth IRA', () => {
    expect(guessAccountKind('ROTH 401K', 'Roth 401(k)')).toEqual({
      kind: '401k',
      taxTreatment: 'roth',
    });
  });

  it('recognises the common workplace plans and HSAs', () => {
    expect(guessAccountKind('401K', '').kind).toBe('401k');
    expect(guessAccountKind('403B', '').kind).toBe('403b');
    expect(guessAccountKind('', 'Thrift Savings Plan').kind).toBe('tsp');
    expect(guessAccountKind('HSA', '').taxTreatment).toBe('hsa');
  });

  it('falls back to taxable rather than guessing wildly', () => {
    expect(guessAccountKind('SOMETHING UNKNOWN', 'Account')).toEqual({
      kind: 'taxable',
      taxTreatment: 'taxable',
    });
  });
});

describe('mapAssetClass', () => {
  it('classifies from either the hint or the symbol', () => {
    expect(mapAssetClass('Fixed Income ETF', 'BND')).toBe('bond');
    expect(mapAssetClass(undefined, 'VXUS')).toBe('intl_stock');
    expect(mapAssetClass('Equity ETF', 'VTI')).toBe('us_stock');
    expect(mapAssetClass(undefined, 'BTC')).toBe('crypto');
    expect(mapAssetClass('Money Market', 'SPAXX')).toBe('cash');
  });

  it('prefers bond over the generic ETF match', () => {
    // "Fixed Income ETF" contains "etf"; the bond rule has to win.
    expect(mapAssetClass('Fixed Income ETF', 'AGG')).toBe('bond');
  });

  it('returns other when nothing matches', () => {
    expect(mapAssetClass(undefined, 'ZZZZ')).toBe('other');
  });
});

describe('holdingsFromSnapshot', () => {
  it('keeps holding ids stable across syncs for the same symbol', () => {
    const first = holdingsFromSnapshot(
      snapshot({
        id: 'r1',
        positions: [{ symbol: 'VTI', units: 10, priceCents: 30_000, currency: 'USD' }],
      }),
      [],
    );

    const second = holdingsFromSnapshot(
      snapshot({
        id: 'r1',
        positions: [{ symbol: 'VTI', units: 12, priceCents: 31_000, currency: 'USD' }],
      }),
      first,
    );

    expect(second[0]!.id).toBe(first[0]!.id);
    expect(second[0]!.shares).toBe(12);
  });

  it('carries over a cost basis the provider stopped reporting', () => {
    const prior = holdingsFromSnapshot(
      snapshot({
        id: 'r1',
        positions: [
          { symbol: 'VTI', units: 10, priceCents: 30_000, costBasisCents: 250_000, currency: 'USD' },
        ],
      }),
      [],
    );

    const next = holdingsFromSnapshot(
      snapshot({
        id: 'r1',
        positions: [{ symbol: 'VTI', units: 10, priceCents: 31_000, currency: 'USD' }],
      }),
      prior,
    );

    // Zeroing this would silently read as a 100% gain.
    expect(next[0]!.costBasisCents).toBe(250_000);
  });

  it('preserves a hand-entered expense ratio', () => {
    const prior = [
      {
        id: 'h1',
        symbol: 'VTI',
        name: '',
        assetClass: 'us_stock' as const,
        shares: 1,
        priceCents: 100,
        costBasisCents: 100,
        expenseRatioBps: 3,
      },
    ];

    const next = holdingsFromSnapshot(
      snapshot({
        id: 'r1',
        positions: [{ symbol: 'VTI', units: 2, priceCents: 200, currency: 'USD' }],
      }),
      prior,
    );

    expect(next[0]!.expenseRatioBps).toBe(3);
  });

  it('models uninvested cash as its own holding', () => {
    const holdings = holdingsFromSnapshot(
      snapshot({ id: 'r1', positions: [], cashCents: 12_34 }),
      [],
    );

    expect(holdings).toHaveLength(1);
    expect(holdings[0]!.symbol).toBe(CASH_SYMBOL);
    expect(holdings[0]!.assetClass).toBe('cash');
    // One "share" priced at the balance, so normal value arithmetic applies.
    expect(holdings[0]!.shares * holdings[0]!.priceCents).toBe(12_34);
  });

  it('omits the cash holding when there is no cash', () => {
    expect(holdingsFromSnapshot(snapshot({ id: 'r1', positions: [] }), [])).toHaveLength(0);
  });
});

describe('mergeSnapshots', () => {
  it('adds accounts it has not seen before and classifies them', () => {
    const { accounts, summary } = mergeSnapshots(
      [],
      [
        snapshot({
          id: 'remote-1',
          account: { id: 'remote-1', name: 'Roth IRA ...9930', institution: 'Fidelity', typeHint: 'ROTH IRA', balanceCents: 0, currency: 'USD' },
          positions: [{ symbol: 'VTI', units: 10, priceCents: 30_000, currency: 'USD' }],
        }),
      ],
      'snaptrade',
      NOW,
    );

    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.kind).toBe('roth_ira');
    expect(accounts[0]!.taxTreatment).toBe('roth');
    expect(accounts[0]!.link?.providerAccountId).toBe('remote-1');
    expect(accounts[0]!.link?.lastSyncedAt).toBe(NOW);
    // The provider cannot know intended contributions, so it must not invent one.
    expect(accounts[0]!.monthlyContributionCents).toBe(0);
    expect(summary.added).toEqual(['Roth IRA ...9930']);
  });

  it('replaces holdings but keeps the figures the user owns', () => {
    const existing = linkedAccount({
      holdings: [
        {
          id: 'old',
          symbol: 'OLD',
          name: 'Sold position',
          assetClass: 'us_stock',
          shares: 5,
          priceCents: 100,
          costBasisCents: 400,
        },
      ],
      taxTreatment: 'roth',
    });

    const { accounts } = mergeSnapshots(
      [existing],
      [
        snapshot({
          id: 'remote-1',
          positions: [{ symbol: 'VTI', units: 3, priceCents: 30_000, currency: 'USD' }],
        }),
      ],
      'snaptrade',
      NOW,
    );

    const account = accounts[0]!;
    // Provider owns holdings: the sold position is gone, not merged.
    expect(account.holdings.map((h) => h.symbol)).toEqual(['VTI']);
    // User owns these: a sync must never reset them.
    expect(account.monthlyContributionCents).toBe(100_000);
    expect(account.employerMatchCents).toBe(50_000);
    expect(account.taxTreatment).toBe('roth');
    expect(account.kind).toBe('401k');
  });

  it('follows the broker name until the user renames the account', () => {
    const followsBroker = mergeSnapshots(
      [linkedAccount({ name: 'Old broker name' })],
      [snapshot({ id: 'remote-1', account: { id: 'remote-1', name: 'New Broker Name', institution: 'X', balanceCents: 0, currency: 'USD' } })],
      'snaptrade',
      NOW,
    );
    expect(followsBroker.accounts[0]!.name).toBe('New Broker Name');

    const keepsRename = mergeSnapshots(
      [linkedAccount({ name: 'My retirement', nameOverridden: true })],
      [snapshot({ id: 'remote-1', account: { id: 'remote-1', name: 'New Broker Name', institution: 'X', balanceCents: 0, currency: 'USD' } })],
      'snaptrade',
      NOW,
    );
    expect(keepsRename.accounts[0]!.name).toBe('My retirement');
  });

  it('never deletes an account the provider stops returning', () => {
    const existing = linkedAccount({
      holdings: [
        {
          id: 'h1',
          symbol: 'VTI',
          name: '',
          assetClass: 'us_stock',
          shares: 10,
          priceCents: 30_000,
          costBasisCents: 250_000,
        },
      ],
    });

    const { accounts, summary } = mergeSnapshots([existing], [], 'snaptrade', NOW);

    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.holdings).toHaveLength(1);
    expect(accounts[0]!.link?.missingSince).toBe(NOW);
    expect(summary.missing).toEqual(['Workplace 401(k)']);
  });

  it('keeps the original missingSince across repeated empty syncs', () => {
    const gone = linkedAccount({
      link: {
        provider: 'snaptrade',
        providerAccountId: 'remote-1',
        institution: 'X',
        lastSyncedAt: NOW - 100,
        missingSince: NOW - 50,
      },
    });

    const { accounts } = mergeSnapshots([gone], [], 'snaptrade', NOW);
    expect(accounts[0]!.link?.missingSince).toBe(NOW - 50);
  });

  it('clears the missing marker and the stale error when an account returns', () => {
    const gone = linkedAccount({
      link: {
        provider: 'snaptrade',
        providerAccountId: 'remote-1',
        institution: 'X',
        lastSyncedAt: NOW - 100,
        missingSince: NOW - 50,
        lastError: 'boom',
      },
    });

    const { accounts } = mergeSnapshots(
      [gone],
      [snapshot({ id: 'remote-1' })],
      'snaptrade',
      NOW,
    );

    expect(accounts[0]!.link?.missingSince).toBeUndefined();
    expect(accounts[0]!.link?.lastError).toBeUndefined();
    expect(accounts[0]!.link?.lastSyncedAt).toBe(NOW);
  });

  it('leaves manual accounts completely alone', () => {
    const manual: InvestmentAccount = {
      id: 'manual-1',
      name: 'Hand-entered brokerage',
      kind: 'taxable',
      taxTreatment: 'taxable',
      holdings: [
        {
          id: 'h1',
          symbol: 'AAPL',
          name: '',
          assetClass: 'us_stock',
          shares: 5,
          priceCents: 20_000,
          costBasisCents: 80_000,
        },
      ],
      monthlyContributionCents: 25_000,
    };

    const { accounts } = mergeSnapshots(
      [manual],
      [snapshot({ id: 'remote-1' })],
      'snaptrade',
      NOW,
    );

    expect(accounts.find((a) => a.id === 'manual-1')).toEqual(manual);
    expect(accounts).toHaveLength(2);
  });

  it('does not touch accounts belonging to a different provider', () => {
    const other = linkedAccount({
      id: 'other',
      link: {
        provider: 'snaptrade',
        providerAccountId: 'remote-1',
        institution: 'X',
        lastSyncedAt: null,
      },
    });
    // Same shape, but merging for a provider it doesn't belong to.
    const { accounts, summary } = mergeSnapshots(
      [{ ...other, link: { ...other.link!, provider: 'snaptrade' } }],
      [],
      'snaptrade',
      NOW,
    );
    expect(summary.missing).toHaveLength(1);
    expect(accounts).toHaveLength(1);
  });

  it('totals value and positions across the sync', () => {
    const { summary } = mergeSnapshots(
      [],
      [
        snapshot({
          id: 'a',
          positions: [
            { symbol: 'VTI', units: 10, priceCents: 30_000, currency: 'USD' },
            { symbol: 'BND', units: 5, priceCents: 7_000, currency: 'USD' },
          ],
          cashCents: 1_000,
        }),
      ],
      'snaptrade',
      NOW,
    );

    expect(summary.positionCount).toBe(2);
    expect(summary.totalValueCents).toBe(10 * 30_000 + 5 * 7_000 + 1_000);
  });

  it('rounds fractional share values to whole cents', () => {
    const { summary } = mergeSnapshots(
      [],
      [
        snapshot({
          id: 'a',
          positions: [{ symbol: 'VTI', units: 21.4382, priceCents: 31_050, currency: 'USD' }],
        }),
      ],
      'snaptrade',
      NOW,
    );

    expect(summary.totalValueCents).toBe(Math.round(21.4382 * 31_050));
    expect(Number.isInteger(summary.totalValueCents)).toBe(true);
  });
});

describe('markSyncFailure', () => {
  it('records the error without discarding the last known holdings', () => {
    const account = linkedAccount({
      holdings: [
        {
          id: 'h1',
          symbol: 'VTI',
          name: '',
          assetClass: 'us_stock',
          shares: 10,
          priceCents: 30_000,
          costBasisCents: 0,
        },
      ],
    });

    const result = markSyncFailure([account], 'snaptrade', 'network down');

    expect(result[0]!.link?.lastError).toBe('network down');
    expect(result[0]!.holdings).toHaveLength(1);
    expect(result[0]!.link?.lastSyncedAt).toBe(NOW - 86_400_000);
  });
});

describe('unlinkAccount', () => {
  it('drops the link but keeps the account and its holdings', () => {
    const account = linkedAccount({
      holdings: [
        {
          id: 'h1',
          symbol: 'VTI',
          name: '',
          assetClass: 'us_stock',
          shares: 10,
          priceCents: 30_000,
          costBasisCents: 0,
        },
      ],
    });

    const [result] = unlinkAccount([account], 'acct-1');

    expect(result!.link).toBeUndefined();
    expect(result!.holdings).toHaveLength(1);
    expect(result!.monthlyContributionCents).toBe(100_000);
  });
});

describe('lastSyncedAt', () => {
  it('returns the most recent successful sync, ignoring never-synced accounts', () => {
    const accounts = [
      linkedAccount({ id: 'a', link: { provider: 'snaptrade', providerAccountId: '1', institution: 'X', lastSyncedAt: 100 } }),
      linkedAccount({ id: 'b', link: { provider: 'snaptrade', providerAccountId: '2', institution: 'X', lastSyncedAt: 500 } }),
      linkedAccount({ id: 'c', link: { provider: 'snaptrade', providerAccountId: '3', institution: 'X', lastSyncedAt: null } }),
    ];
    expect(lastSyncedAt(accounts)).toBe(500);
  });

  it('is null when nothing has ever synced', () => {
    expect(lastSyncedAt([])).toBeNull();
  });
});

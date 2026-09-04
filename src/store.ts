import { create } from 'zustand';
import type {
  AppData,
  AppSettings,
  Category,
  FISettings,
  Holding,
  IncomeSource,
  InvestmentAccount,
  Liability,
  LinkSettings,
  OtherAsset,
  Subcategory,
  Transaction,
} from './types';
import { deleteReceipt, loadAppData, resetAll, saveAppData } from './lib/db';
import { newId, seedAppData } from './lib/seed';
import {
  createPortalUrl,
  disconnectAccount,
  isLinkingConfigured,
  linkCredentials,
  registerUser,
} from './lib/linking/client';
import {
  markSyncFailure,
  mergeSnapshots,
  unlinkAccount,
  type SyncSummary,
} from './lib/linking/sync';
import { fetchSnapshots } from './lib/linking/client';

/**
 * Application state.
 *
 * The whole dataset is one immutable object; every action returns a new one and
 * schedules a debounced write to IndexedDB. Debouncing matters because the
 * inputs in this app are live — dragging a percentage slider fires an action
 * per frame, and each write serializes the full dataset.
 */

const SAVE_DEBOUNCE_MS = 400;

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingData: AppData | null = null;

function schedulePersist(data: AppData, onError: (message: string) => void): void {
  pendingData = data;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const toSave = pendingData;
    pendingData = null;
    if (!toSave) return;
    saveAppData(toSave).catch(() => {
      onError('Could not save to this device. Export a backup before closing the tab.');
    });
  }, SAVE_DEBOUNCE_MS);
}

/** Force any queued write to complete — used on tab hide and before export. */
export async function flushPendingSave(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (pendingData) {
    const toSave = pendingData;
    pendingData = null;
    await saveAppData(toSave);
  }
}

export interface StoreState {
  data: AppData;
  loading: boolean;
  error: string | null;

  load: () => Promise<void>;
  setError: (message: string | null) => void;

  // Income
  addIncomeSource: (partial?: Partial<IncomeSource>) => string;
  updateIncomeSource: (id: string, patch: Partial<IncomeSource>) => void;
  removeIncomeSource: (id: string) => void;

  // Categories
  addCategory: (partial?: Partial<Category>) => string;
  updateCategory: (id: string, patch: Partial<Category>) => void;
  removeCategory: (id: string) => void;
  moveCategory: (id: string, direction: -1 | 1) => void;

  // Subcategories
  addSubcategory: (categoryId: string, partial?: Partial<Subcategory>) => string;
  updateSubcategory: (categoryId: string, subId: string, patch: Partial<Subcategory>) => void;
  removeSubcategory: (categoryId: string, subId: string) => void;

  // Transactions
  addTransaction: (partial: Partial<Transaction>) => string;
  updateTransaction: (id: string, patch: Partial<Transaction>) => void;
  removeTransaction: (id: string) => Promise<void>;

  // Investments
  addAccount: (partial?: Partial<InvestmentAccount>) => string;
  updateAccount: (id: string, patch: Partial<InvestmentAccount>) => void;
  removeAccount: (id: string) => void;
  addHolding: (accountId: string, partial?: Partial<Holding>) => string;
  updateHolding: (accountId: string, holdingId: string, patch: Partial<Holding>) => void;
  removeHolding: (accountId: string, holdingId: string) => void;

  // Net worth extras
  addOtherAsset: (partial?: Partial<OtherAsset>) => string;
  updateOtherAsset: (id: string, patch: Partial<OtherAsset>) => void;
  removeOtherAsset: (id: string) => void;
  addLiability: (partial?: Partial<Liability>) => string;
  updateLiability: (id: string, patch: Partial<Liability>) => void;
  removeLiability: (id: string) => void;

  // Brokerage linking
  updateLinkSettings: (patch: Partial<LinkSettings>) => void;
  connectBrokerage: (returnUrl: string) => Promise<string>;
  syncLinkedAccounts: () => Promise<SyncSummary>;
  unlinkAccountById: (accountId: string, revokeAtProvider: boolean) => Promise<void>;
  syncing: boolean;

  // Settings & whole-dataset operations
  updateSettings: (patch: Partial<AppSettings>) => void;
  updateFISettings: (patch: Partial<FISettings>) => void;
  replaceAll: (data: AppData) => void;
  resetEverything: () => Promise<void>;
}

export const useStore = create<StoreState>((set, get) => {
  /** Apply a pure update to `data` and schedule persistence. */
  const mutate = (fn: (data: AppData) => AppData): void => {
    const next = fn(get().data);
    set({ data: next });
    schedulePersist(next, (message) => set({ error: message }));
  };

  const mapCategory = (
    data: AppData,
    id: string,
    fn: (c: Category) => Category,
  ): AppData => ({
    ...data,
    categories: data.categories.map((c) => (c.id === id ? fn(c) : c)),
  });

  const mapAccount = (
    data: AppData,
    id: string,
    fn: (a: InvestmentAccount) => InvestmentAccount,
  ): AppData => ({
    ...data,
    accounts: data.accounts.map((a) => (a.id === id ? fn(a) : a)),
  });

  return {
    data: seedAppData(),
    loading: true,
    error: null,
    syncing: false,

    load: async () => {
      try {
        const data = await loadAppData();
        set({ data, loading: false, error: null });
      } catch {
        set({
          loading: false,
          error:
            'Could not open local storage. Private browsing or blocked site data will prevent saving.',
        });
      }
    },

    setError: (message) => set({ error: message }),

    addIncomeSource: (partial = {}) => {
      const id = newId('inc');
      mutate((data) => ({
        ...data,
        incomeSources: [
          ...data.incomeSources,
          { id, name: 'New income', kind: 'salary', monthlyCents: 0, ...partial },
        ],
      }));
      return id;
    },

    updateIncomeSource: (id, patch) =>
      mutate((data) => ({
        ...data,
        incomeSources: data.incomeSources.map((s) => (s.id === id ? { ...s, ...patch } : s)),
      })),

    removeIncomeSource: (id) =>
      mutate((data) => ({
        ...data,
        incomeSources: data.incomeSources.filter((s) => s.id !== id),
      })),

    addCategory: (partial = {}) => {
      const id = newId('cat');
      mutate((data) => ({
        ...data,
        categories: [
          ...data.categories,
          {
            id,
            name: 'New category',
            color: '#2a78d6',
            group: 'needs',
            allocation: { mode: 'percent', value: 0 },
            subcategories: [],
            ...partial,
          },
        ],
      }));
      return id;
    },

    updateCategory: (id, patch) => mutate((data) => mapCategory(data, id, (c) => ({ ...c, ...patch }))),

    /**
     * Delete a category and orphan its transactions rather than deleting them.
     * Losing spending history because a budget line was renamed away would be
     * indefensible; the transactions show as uncategorized and can be reassigned.
     */
    removeCategory: (id) =>
      mutate((data) => {
        const category = data.categories.find((c) => c.id === id);
        const subIds = new Set(category?.subcategories.map((s) => s.id) ?? []);
        return {
          ...data,
          categories: data.categories.filter((c) => c.id !== id),
          transactions: data.transactions.map((t) =>
            t.categoryId === id || (t.subcategoryId && subIds.has(t.subcategoryId))
              ? { ...t, categoryId: null, subcategoryId: null }
              : t,
          ),
        };
      }),

    moveCategory: (id, direction) =>
      mutate((data) => {
        const index = data.categories.findIndex((c) => c.id === id);
        const target = index + direction;
        if (index < 0 || target < 0 || target >= data.categories.length) return data;
        const categories = [...data.categories];
        const [moved] = categories.splice(index, 1);
        categories.splice(target, 0, moved!);
        return { ...data, categories };
      }),

    addSubcategory: (categoryId, partial = {}) => {
      const id = newId('sub');
      mutate((data) =>
        mapCategory(data, categoryId, (c) => ({
          ...c,
          subcategories: [
            ...c.subcategories,
            { id, name: 'New subcategory', allocation: { mode: 'percent', value: 0 }, ...partial },
          ],
        })),
      );
      return id;
    },

    updateSubcategory: (categoryId, subId, patch) =>
      mutate((data) =>
        mapCategory(data, categoryId, (c) => ({
          ...c,
          subcategories: c.subcategories.map((s) => (s.id === subId ? { ...s, ...patch } : s)),
        })),
      ),

    removeSubcategory: (categoryId, subId) =>
      mutate((data) => ({
        ...mapCategory(data, categoryId, (c) => ({
          ...c,
          subcategories: c.subcategories.filter((s) => s.id !== subId),
        })),
        // Keep the transactions, but detach them from the deleted subcategory —
        // they stay counted against the parent category.
        transactions: data.transactions.map((t) =>
          t.subcategoryId === subId ? { ...t, subcategoryId: null } : t,
        ),
      })),

    addTransaction: (partial) => {
      const id = newId('txn');
      mutate((data) => ({
        ...data,
        transactions: [
          ...data.transactions,
          {
            id,
            date: new Date().toISOString().slice(0, 10),
            amountCents: 0,
            merchant: '',
            categoryId: null,
            subcategoryId: null,
            source: 'manual',
            createdAt: Date.now(),
            ...partial,
          },
        ],
      }));
      return id;
    },

    updateTransaction: (id, patch) =>
      mutate((data) => ({
        ...data,
        transactions: data.transactions.map((t) => (t.id === id ? { ...t, ...patch } : t)),
      })),

    removeTransaction: async (id) => {
      const transaction = get().data.transactions.find((t) => t.id === id);
      mutate((data) => ({
        ...data,
        transactions: data.transactions.filter((t) => t.id !== id),
      }));
      // The photo is only meaningful as evidence for the transaction it backs.
      if (transaction?.receiptId) {
        await deleteReceipt(transaction.receiptId).catch(() => undefined);
      }
    },

    addAccount: (partial = {}) => {
      const id = newId('acct');
      mutate((data) => ({
        ...data,
        accounts: [
          ...data.accounts,
          {
            id,
            name: 'New account',
            kind: 'taxable',
            taxTreatment: 'taxable',
            holdings: [],
            monthlyContributionCents: 0,
            ...partial,
          },
        ],
      }));
      return id;
    },

    updateAccount: (id, patch) => mutate((data) => mapAccount(data, id, (a) => ({ ...a, ...patch }))),

    removeAccount: (id) =>
      mutate((data) => ({ ...data, accounts: data.accounts.filter((a) => a.id !== id) })),

    addHolding: (accountId, partial = {}) => {
      const id = newId('hold');
      mutate((data) =>
        mapAccount(data, accountId, (a) => ({
          ...a,
          holdings: [
            ...a.holdings,
            {
              id,
              symbol: '',
              name: '',
              assetClass: 'us_stock',
              shares: 0,
              costBasisCents: 0,
              priceCents: 0,
              ...partial,
            },
          ],
        })),
      );
      return id;
    },

    updateHolding: (accountId, holdingId, patch) =>
      mutate((data) =>
        mapAccount(data, accountId, (a) => ({
          ...a,
          holdings: a.holdings.map((h) => (h.id === holdingId ? { ...h, ...patch } : h)),
        })),
      ),

    removeHolding: (accountId, holdingId) =>
      mutate((data) =>
        mapAccount(data, accountId, (a) => ({
          ...a,
          holdings: a.holdings.filter((h) => h.id !== holdingId),
        })),
      ),

    addOtherAsset: (partial = {}) => {
      const id = newId('asset');
      mutate((data) => ({
        ...data,
        otherAssets: [
          ...data.otherAssets,
          { id, name: 'New asset', valueCents: 0, countTowardFI: false, ...partial },
        ],
      }));
      return id;
    },

    updateOtherAsset: (id, patch) =>
      mutate((data) => ({
        ...data,
        otherAssets: data.otherAssets.map((a) => (a.id === id ? { ...a, ...patch } : a)),
      })),

    removeOtherAsset: (id) =>
      mutate((data) => ({ ...data, otherAssets: data.otherAssets.filter((a) => a.id !== id) })),

    addLiability: (partial = {}) => {
      const id = newId('liab');
      mutate((data) => ({
        ...data,
        liabilities: [
          ...data.liabilities,
          { id, name: 'New debt', balanceCents: 0, aprBps: 0, minimumPaymentCents: 0, ...partial },
        ],
      }));
      return id;
    },

    updateLiability: (id, patch) =>
      mutate((data) => ({
        ...data,
        liabilities: data.liabilities.map((l) => (l.id === id ? { ...l, ...patch } : l)),
      })),

    removeLiability: (id) =>
      mutate((data) => ({ ...data, liabilities: data.liabilities.filter((l) => l.id !== id) })),

    updateLinkSettings: (patch) =>
      mutate((data) => ({
        ...data,
        settings: { ...data.settings, linking: { ...data.settings.linking, ...patch } },
      })),

    /**
     * Start a brokerage connection.
     *
     * Registers a provider identity on first use, then returns the portal URL
     * for the caller to navigate to. The user's brokerage credentials are
     * entered at the aggregator and never reach this app or its backend.
     */
    connectBrokerage: async (returnUrl) => {
      const settings = get().data.settings.linking;
      if (!isLinkingConfigured(settings)) {
        throw new Error('Set a backend URL and accept the linking notice in Settings first.');
      }

      let { userId, userSecret } = settings;
      if (!userId || !userSecret) {
        const registered = await registerUser(settings.backendUrl);
        userId = registered.userId;
        userSecret = registered.userSecret;
        // Persist immediately and synchronously — losing this identity after
        // the provider has issued it strands the connection at their end.
        const next = {
          ...get().data,
          settings: {
            ...get().data.settings,
            linking: { ...settings, userId, userSecret },
          },
        };
        set({ data: next });
        await saveAppData(next);
      }

      const creds = linkCredentials(get().data.settings.linking);
      if (!creds) throw new Error('Linking is not configured.');

      const { redirectUri } = await createPortalUrl(creds, returnUrl);
      return redirectUri;
    },

    /**
     * Pull current holdings for every connected account and merge them in.
     *
     * A failed sync records the error against the linked accounts rather than
     * clearing them, so the UI can show the last known figures and say plainly
     * that they are stale.
     */
    syncLinkedAccounts: async () => {
      const creds = linkCredentials(get().data.settings.linking);
      if (!creds) throw new Error('Linking is not configured.');

      set({ syncing: true });
      try {
        const snapshots = await fetchSnapshots(creds);
        const result = mergeSnapshots(get().data.accounts, snapshots, creds.provider);
        mutate((data) => ({ ...data, accounts: result.accounts }));
        return result.summary;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Sync failed.';
        mutate((data) => ({
          ...data,
          accounts: markSyncFailure(data.accounts, creds.provider, message),
        }));
        throw error;
      } finally {
        set({ syncing: false });
      }
    },

    /**
     * Detach an account from its connection. The holdings stay as ordinary
     * manual entries — disconnecting is not a request to delete a portfolio.
     */
    unlinkAccountById: async (accountId, revokeAtProvider) => {
      const account = get().data.accounts.find((a) => a.id === accountId);
      const creds = linkCredentials(get().data.settings.linking);

      if (revokeAtProvider && account?.link && creds) {
        // Revoking can fail (already revoked, provider down); the local
        // unlink should still go through so the user isn't stuck.
        await disconnectAccount(creds, account.link.providerAccountId).catch(() => undefined);
      }

      mutate((data) => ({ ...data, accounts: unlinkAccount(data.accounts, accountId) }));
    },

    updateSettings: (patch) =>
      mutate((data) => ({ ...data, settings: { ...data.settings, ...patch } })),

    updateFISettings: (patch) =>
      mutate((data) => ({
        ...data,
        settings: { ...data.settings, fi: { ...data.settings.fi, ...patch } },
      })),

    replaceAll: (data) => {
      set({ data, error: null });
      schedulePersist(data, (message) => set({ error: message }));
    },

    resetEverything: async () => {
      const seeded = await resetAll();
      set({ data: seeded, error: null });
    },
  };
});

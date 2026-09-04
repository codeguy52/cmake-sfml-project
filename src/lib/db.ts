import { openDB, type IDBPDatabase } from 'idb';
import type { AppData, Receipt } from '../types';
import { seedAppData, SCHEMA_VERSION } from './seed';

/**
 * Persistence.
 *
 * Everything lives in IndexedDB on the device. There is no server, no account
 * and no network call anywhere in this app — which for a file containing
 * someone's complete financial position is a feature, not a limitation. The
 * cost is that a cleared browser profile takes the data with it, so
 * `exportBundle` exists and the UI nags about backups.
 *
 * Two stores:
 *  - `app` holds the entire non-image dataset as one record. A single record
 *    means every save is atomic and the in-memory store can stay a plain
 *    object. It rewrites the whole dataset on each save, which is why saves are
 *    debounced; at personal scale (thousands of transactions, a few hundred KB)
 *    that is far cheaper than the complexity of normalized stores.
 *  - `receipts` holds photos as Blobs, keyed by id, so a 200 KB image is never
 *    dragged along by an unrelated budget edit.
 */

const DB_NAME = 'fire-budget';
const DB_VERSION = 1;
const APP_STORE = 'app';
const RECEIPT_STORE = 'receipts';
const APP_KEY = 'data';

type Schema = {
  [APP_STORE]: { key: string; value: AppData };
  [RECEIPT_STORE]: { key: string; value: Receipt };
};

let dbPromise: Promise<IDBPDatabase<Schema>> | null = null;

function getDB(): Promise<IDBPDatabase<Schema>> {
  if (!dbPromise) {
    dbPromise = openDB<Schema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(APP_STORE)) {
          db.createObjectStore(APP_STORE);
        }
        if (!db.objectStoreNames.contains(RECEIPT_STORE)) {
          db.createObjectStore(RECEIPT_STORE, { keyPath: 'id' });
        }
      },
      blocked() {
        console.warn('Another tab is holding an older version of the database open.');
      },
    });
  }
  return dbPromise;
}

/**
 * Bring a stored dataset up to the current schema.
 *
 * Runs on load and on import. Kept explicit and additive so a backup written by
 * an older build still opens — the alternative is a silent crash on a field
 * that didn't exist yet.
 */
export function migrate(data: AppData): AppData {
  const seeded = seedAppData();
  const migrated: AppData = {
    ...data,
    settings: {
      ...seeded.settings,
      ...data.settings,
      fi: { ...seeded.settings.fi, ...data.settings?.fi },
      // Schema 2 added linking. A version-1 dataset has no `linking` block, so
      // the seeded default (backend URL empty, i.e. linking off) fills in and
      // the app keeps behaving exactly as it did before the upgrade.
      linking: { ...seeded.settings.linking, ...data.settings?.linking },
      schemaVersion: SCHEMA_VERSION,
    },
    categories: (data.categories ?? []).map((c) => ({
      ...c,
      subcategories: c.subcategories ?? [],
    })),
    incomeSources: data.incomeSources ?? [],
    transactions: data.transactions ?? [],
    accounts: (data.accounts ?? []).map((a) => ({ ...a, holdings: a.holdings ?? [] })),
    otherAssets: data.otherAssets ?? [],
    liabilities: data.liabilities ?? [],
  };
  return migrated;
}

export async function loadAppData(): Promise<AppData> {
  const db = await getDB();
  const stored = await db.get(APP_STORE, APP_KEY);
  if (!stored) {
    const seeded = seedAppData();
    await db.put(APP_STORE, seeded, APP_KEY);
    return seeded;
  }
  return migrate(stored);
}

export async function saveAppData(data: AppData): Promise<void> {
  const db = await getDB();
  await db.put(APP_STORE, data, APP_KEY);
}

export async function putReceipt(receipt: Receipt): Promise<void> {
  const db = await getDB();
  await db.put(RECEIPT_STORE, receipt);
}

export async function getAllReceipts(): Promise<Receipt[]> {
  const db = await getDB();
  return db.getAll(RECEIPT_STORE);
}

export async function deleteReceipt(id: string): Promise<void> {
  const db = await getDB();
  await db.delete(RECEIPT_STORE, id);
}

/** Wipe everything and return a fresh seeded dataset. */
export async function resetAll(): Promise<AppData> {
  const db = await getDB();
  await db.clear(RECEIPT_STORE);
  const seeded = seedAppData();
  await db.put(APP_STORE, seeded, APP_KEY);
  return seeded;
}

export interface StorageEstimate {
  usageBytes: number | null;
  quotaBytes: number | null;
  /** Whether the browser has agreed not to evict this origin under pressure. */
  persisted: boolean;
}

/**
 * Ask the browser to keep this origin's data through storage pressure, and
 * report usage. Worth surfacing: on a phone, "best-effort" storage can be
 * evicted, and the honest response is to tell the user to export a backup.
 */
export async function requestPersistentStorage(): Promise<StorageEstimate> {
  let persisted = false;
  let usageBytes: number | null = null;
  let quotaBytes: number | null = null;

  try {
    if (navigator.storage?.persisted) {
      persisted = await navigator.storage.persisted();
      if (!persisted && navigator.storage.persist) {
        persisted = await navigator.storage.persist();
      }
    }
    if (navigator.storage?.estimate) {
      const estimate = await navigator.storage.estimate();
      usageBytes = estimate.usage ?? null;
      quotaBytes = estimate.quota ?? null;
    }
  } catch {
    // Storage API unavailable — fall through with what we have.
  }

  return { usageBytes, quotaBytes, persisted };
}

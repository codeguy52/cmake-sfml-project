import type { AppData, ExportBundle, Receipt } from '../types';
import { getAllReceipts, migrate, putReceipt } from './db';
import { formatCents } from './money';
import { SCHEMA_VERSION } from './seed';

export const APP_VERSION = '0.1.0';

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read the receipt image.'));
    reader.readAsDataURL(blob);
  });
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl);
  return response.blob();
}

/**
 * Build a complete, self-contained backup.
 *
 * Receipt photos are inlined as data URLs so the export is one file the user
 * can email to themselves or drop in a drive folder, with nothing left behind
 * in the browser. That makes the file large — including images is optional for
 * exactly that reason.
 */
export async function exportBundle(
  data: AppData,
  options: { includeReceipts?: boolean; includeLinkCredentials?: boolean } = {},
): Promise<ExportBundle> {
  const { includeReceipts = true, includeLinkCredentials = false } = options;

  const bundle: ExportBundle = {
    ...data,
    settings: {
      ...data.settings,
      linking: includeLinkCredentials
        ? data.settings.linking
        : // The provider secret can read every connected account. A backup
          // file gets emailed and dropped in cloud folders in a way the
          // browser's database does not, so the credential stays behind and
          // the restoring device reconnects instead.
          { ...data.settings.linking, userId: null, userSecret: null },
    },
    exportedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
  };

  if (includeReceipts) {
    const receipts = await getAllReceipts();
    bundle.receipts = await Promise.all(
      receipts.map(async (r) => {
        const entry: NonNullable<ExportBundle['receipts']>[number] = {
          id: r.id,
          mimeType: r.mimeType,
          capturedAt: r.capturedAt,
          dataUrl: await blobToDataUrl(r.blob),
        };
        if (r.ocrText !== undefined) entry.ocrText = r.ocrText;
        if (r.ocrConfidence !== undefined) entry.ocrConfidence = r.ocrConfidence;
        if (r.parsed !== undefined) entry.parsed = r.parsed;
        if (r.transactionId !== undefined) entry.transactionId = r.transactionId;
        return entry;
      }),
    );
  }

  return bundle;
}

export function bundleFilename(now = new Date()): string {
  const stamp = now.toISOString().slice(0, 10);
  return `fire-budget-backup-${stamp}.json`;
}

export function downloadBundle(bundle: ExportBundle, filename = bundleFilename()): void {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export class ImportError extends Error {}

/**
 * Validate an untrusted JSON file well enough to refuse it cleanly.
 *
 * This is a file the user picked off their own disk, so the risk isn't attack,
 * it's a wrong or truncated file silently replacing real data. Anything that
 * isn't recognizably a bundle gets rejected before the store is touched.
 */
export function validateBundle(input: unknown): ExportBundle {
  if (typeof input !== 'object' || input === null) {
    throw new ImportError('That file does not contain a backup.');
  }
  const candidate = input as Partial<ExportBundle>;

  const required: (keyof ExportBundle)[] = ['categories', 'transactions', 'settings'];
  for (const key of required) {
    if (candidate[key] === undefined) {
      throw new ImportError(`That backup is missing its "${String(key)}" section.`);
    }
  }
  if (!Array.isArray(candidate.categories) || !Array.isArray(candidate.transactions)) {
    throw new ImportError('That backup is malformed — categories or transactions are not lists.');
  }

  const version = candidate.settings?.schemaVersion;
  if (typeof version === 'number' && version > SCHEMA_VERSION) {
    throw new ImportError(
      `That backup was written by a newer version of the app (schema ${version}, this build reads ${SCHEMA_VERSION}). Update before importing.`,
    );
  }

  return candidate as ExportBundle;
}

export interface ImportResult {
  data: AppData;
  receiptsRestored: number;
  summary: string;
}

/**
 * Restore a bundle. Replaces the dataset wholesale rather than merging —
 * merging two budgets without a stable identity scheme produces duplicates,
 * and a restore is what the user asked for.
 */
export async function importBundle(raw: unknown, currency = 'USD'): Promise<ImportResult> {
  const bundle = validateBundle(raw);

  const { receipts, exportedAt: _exportedAt, appVersion: _appVersion, ...appData } = bundle;
  const data = migrate(appData as AppData);

  let receiptsRestored = 0;
  if (Array.isArray(receipts)) {
    for (const r of receipts) {
      try {
        const blob = await dataUrlToBlob(r.dataUrl);
        const receipt: Receipt = {
          id: r.id,
          blob,
          mimeType: r.mimeType,
          capturedAt: r.capturedAt,
        };
        if (r.ocrText !== undefined) receipt.ocrText = r.ocrText;
        if (r.ocrConfidence !== undefined) receipt.ocrConfidence = r.ocrConfidence;
        if (r.parsed !== undefined) receipt.parsed = r.parsed;
        if (r.transactionId !== undefined) receipt.transactionId = r.transactionId;
        await putReceipt(receipt);
        receiptsRestored++;
      } catch {
        // One unreadable image shouldn't abort a restore of everything else.
      }
    }
  }

  const spend = data.transactions.reduce((sum, t) => sum + t.amountCents, 0);
  const summary = [
    `${data.categories.length} categories`,
    `${data.transactions.length} transactions (${formatCents(spend, { currency })})`,
    `${data.accounts.length} investment accounts`,
    `${receiptsRestored} receipt photos`,
  ].join(', ');

  return { data, receiptsRestored, summary };
}

/** Transactions as CSV, for a spreadsheet or a tax preparer. */
export function transactionsToCsv(data: AppData): string {
  const catName = new Map(data.categories.map((c) => [c.id, c.name]));
  const subName = new Map(
    data.categories.flatMap((c) => c.subcategories.map((s) => [s.id, s.name] as const)),
  );

  const escape = (value: string): string =>
    /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

  const rows = [
    ['Date', 'Merchant', 'Category', 'Subcategory', 'Amount', 'Note', 'Source'],
    ...[...data.transactions]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((t) => [
        t.date,
        t.merchant,
        t.categoryId ? (catName.get(t.categoryId) ?? '') : '',
        t.subcategoryId ? (subName.get(t.subcategoryId) ?? '') : '',
        (t.amountCents / 100).toFixed(2),
        t.note ?? '',
        t.source,
      ]),
  ];

  return rows.map((r) => r.map((cell) => escape(String(cell))).join(',')).join('\n');
}

export function downloadCsv(csv: string, filename: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

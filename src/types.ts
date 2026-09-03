/**
 * Domain model.
 *
 * Two conventions hold everywhere in this codebase:
 *  - Money is an integer number of cents. Never a float dollar amount.
 *  - Percentages are integer basis points (bp), where 10_000 bp = 100%.
 * Both exist so that repeated arithmetic can't accumulate binary-float drift
 * in numbers the user is going to reconcile against a bank statement.
 */

export type Cents = number;
export type Bps = number;

/** How a budget line claims its share of the scope above it. */
export type AllocationMode = 'percent' | 'fixed';

export interface Allocation {
  mode: AllocationMode;
  /** Basis points of the parent scope when mode is 'percent', cents when 'fixed'. */
  value: number;
}

/**
 * Coarse buckets used for 50/30/20-style rollups and, importantly, for the FI
 * math: only `needs` and `wants` count as spending you must fund forever.
 * `savings` is the part of income that buys your freedom instead.
 */
export type CategoryGroup = 'needs' | 'wants' | 'savings';

export interface Subcategory {
  id: string;
  name: string;
  /** Relative to the parent category's resolved budget. */
  allocation: Allocation;
  archived?: boolean;
}

export interface Category {
  id: string;
  name: string;
  color: string;
  group: CategoryGroup;
  /** Relative to total monthly income. */
  allocation: Allocation;
  subcategories: Subcategory[];
  archived?: boolean;
}

export type IncomeKind = 'salary' | 'self_employment' | 'side' | 'rental' | 'other';

export interface IncomeSource {
  id: string;
  name: string;
  kind: IncomeKind;
  /** Take-home pay per month. Budget percentages resolve against the sum of these. */
  monthlyCents: Cents;
  archived?: boolean;
}

export interface Transaction {
  id: string;
  /** ISO calendar date, `YYYY-MM-DD`. Local wall-clock, not a UTC instant. */
  date: string;
  /** Positive is money out. A refund or returned item is negative. */
  amountCents: Cents;
  merchant: string;
  categoryId: string | null;
  subcategoryId: string | null;
  note?: string;
  /** Links to a `Receipt` record holding the photo. */
  receiptId?: string;
  source: 'manual' | 'receipt';
  createdAt: number;
}

export interface ParsedReceipt {
  merchant?: string;
  /** `YYYY-MM-DD` */
  date?: string;
  totalCents?: Cents;
  subtotalCents?: Cents;
  taxCents?: Cents;
  lineItems: { description: string; amountCents: Cents }[];
}

export interface Receipt {
  id: string;
  /** The photo itself, kept in IndexedDB rather than as a base64 string. */
  blob: Blob;
  mimeType: string;
  capturedAt: number;
  ocrText?: string;
  /** Mean per-word confidence from Tesseract, 0-100. */
  ocrConfidence?: number;
  parsed?: ParsedReceipt;
  transactionId?: string;
}

export type AssetClass =
  | 'us_stock'
  | 'intl_stock'
  | 'bond'
  | 'reit'
  | 'cash'
  | 'crypto'
  | 'other';

export type TaxTreatment = 'pretax' | 'roth' | 'taxable' | 'hsa';

export type AccountKind =
  | '401k'
  | '403b'
  | 'tsp'
  | 'ira'
  | 'roth_ira'
  | 'hsa'
  | 'taxable'
  | 'cash'
  | '529'
  | 'crypto'
  | 'other';

export interface Holding {
  id: string;
  symbol: string;
  name: string;
  assetClass: AssetClass;
  shares: number;
  /** What you paid in total, for unrealized gain/loss. */
  costBasisCents: Cents;
  /** Per-share price. Entered by hand — this app makes no network calls. */
  priceCents: Cents;
  /** Fund expense ratio in bp, e.g. 3 = 0.03%. Used for the drag estimate. */
  expenseRatioBps?: Bps;
}

export interface InvestmentAccount {
  id: string;
  name: string;
  kind: AccountKind;
  taxTreatment: TaxTreatment;
  holdings: Holding[];
  /** Your own contribution per month. */
  monthlyContributionCents: Cents;
  /** Employer match per month, if any. Counts toward FI, not toward your savings rate denominator. */
  employerMatchCents?: Cents;
  archived?: boolean;
}

/** Non-investment assets: a house, a car, anything that isn't funding retirement. */
export interface OtherAsset {
  id: string;
  name: string;
  valueCents: Cents;
  /** Excluded from FI assets by default — you can't eat your house. */
  countTowardFI: boolean;
}

export interface Liability {
  id: string;
  name: string;
  balanceCents: Cents;
  aprBps: Bps;
  minimumPaymentCents: Cents;
}

export interface FISettings {
  /** Withdrawal rate for the FI target. 400 bp = 4% = the 25x rule. */
  safeWithdrawalRateBps: Bps;
  /** Expected long-run nominal return on invested assets. */
  expectedReturnBps: Bps;
  /** Expected inflation. Combined with the above into a real return so all
   *  projections stay in today's dollars. */
  inflationBps: Bps;
  /** Annual spending to fund in retirement. Null derives it from the budget. */
  annualSpendingOverrideCents: Cents | null;
  currentAge: number | null;
  /** Target age for the Coast FI calculation. */
  targetRetirementAge: number | null;
}

export interface AppSettings {
  currency: string;
  locale: string;
  fi: FISettings;
  /** Schema version, so an imported backup from an older build can be migrated. */
  schemaVersion: number;
}

export interface AppData {
  settings: AppSettings;
  categories: Category[];
  incomeSources: IncomeSource[];
  transactions: Transaction[];
  accounts: InvestmentAccount[];
  otherAssets: OtherAsset[];
  liabilities: Liability[];
}

/** Shape of the JSON backup file. Receipt images are base64 here. */
export interface ExportBundle extends AppData {
  exportedAt: string;
  appVersion: string;
  receipts?: {
    id: string;
    mimeType: string;
    capturedAt: number;
    dataUrl: string;
    ocrText?: string;
    ocrConfidence?: number;
    parsed?: ParsedReceipt;
    transactionId?: string;
  }[];
}

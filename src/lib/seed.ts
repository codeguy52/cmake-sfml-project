import type { AppData, AppSettings, Category } from '../types';
import { slotColor } from './palette';

export const SCHEMA_VERSION = 1;

export function newId(prefix = 'id'): string {
  // crypto.randomUUID needs a secure context; the fallback keeps a plain
  // file:// or http:// open of the built app working.
  const uuid =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${uuid}`;
}

export const DEFAULT_SETTINGS: AppSettings = {
  currency: 'USD',
  locale: 'en-US',
  schemaVersion: SCHEMA_VERSION,
  fi: {
    safeWithdrawalRateBps: 400, // the 4% rule
    expectedReturnBps: 700,
    inflationBps: 300,
    annualSpendingOverrideCents: null,
    currentAge: null,
    targetRetirementAge: 65,
  },
};

/**
 * A starting budget shaped roughly like 50/30/20, with the percentages that
 * make that split real. Everything here is meant to be edited — it exists so
 * the app has something to show on first run instead of an empty screen.
 */
function seedCategories(): Category[] {
  // Colors are assigned by hand rather than by index so the savings
  // categories don't land on the palette's red slot, which reads as a warning
  // next to a status color and is the wrong signal for money going right.
  const spec: {
    name: string;
    group: Category['group'];
    percent: number;
    colorSlot: number;
    subs: { name: string; percentOfParent: number }[];
  }[] = [
    {
      name: 'Housing',
      colorSlot: 0,
      group: 'needs',
      percent: 28,
      subs: [
        { name: 'Rent / mortgage', percentOfParent: 80 },
        { name: 'Utilities', percentOfParent: 14 },
        { name: 'Maintenance', percentOfParent: 6 },
      ],
    },
    {
      name: 'Food',
      colorSlot: 1,
      group: 'needs',
      percent: 12,
      subs: [
        { name: 'Groceries', percentOfParent: 75 },
        { name: 'Household supplies', percentOfParent: 25 },
      ],
    },
    {
      name: 'Transport',
      colorSlot: 2,
      group: 'needs',
      percent: 8,
      subs: [
        { name: 'Fuel / transit', percentOfParent: 50 },
        { name: 'Insurance', percentOfParent: 30 },
        { name: 'Repairs', percentOfParent: 20 },
      ],
    },
    {
      name: 'Health',
      colorSlot: 3,
      group: 'needs',
      percent: 6,
      subs: [
        { name: 'Premiums', percentOfParent: 60 },
        { name: 'Prescriptions & visits', percentOfParent: 40 },
      ],
    },
    {
      name: 'Lifestyle',
      colorSlot: 4,
      group: 'wants',
      percent: 14,
      subs: [
        { name: 'Dining out', percentOfParent: 40 },
        { name: 'Entertainment', percentOfParent: 25 },
        { name: 'Shopping', percentOfParent: 25 },
        { name: 'Travel', percentOfParent: 10 },
      ],
    },
    {
      name: 'Personal',
      colorSlot: 7,
      group: 'wants',
      percent: 5,
      subs: [
        { name: 'Subscriptions', percentOfParent: 40 },
        { name: 'Fitness', percentOfParent: 30 },
        { name: 'Gifts', percentOfParent: 30 },
      ],
    },
    {
      name: 'Investing',
      colorSlot: 5,
      group: 'savings',
      percent: 22,
      subs: [
        { name: 'Retirement accounts', percentOfParent: 70 },
        { name: 'Taxable brokerage', percentOfParent: 30 },
      ],
    },
    {
      name: 'Cash reserve',
      colorSlot: 6,
      group: 'savings',
      percent: 5,
      subs: [{ name: 'Emergency fund', percentOfParent: 100 }],
    },
  ];

  return spec.map((s) => ({
    id: newId('cat'),
    name: s.name,
    color: slotColor(s.colorSlot),
    group: s.group,
    allocation: { mode: 'percent' as const, value: s.percent * 100 },
    subcategories: s.subs.map((sub) => ({
      id: newId('sub'),
      name: sub.name,
      allocation: { mode: 'percent' as const, value: sub.percentOfParent * 100 },
    })),
  }));
}

/** First-run state: a usable budget skeleton, no invented income or holdings. */
export function seedAppData(): AppData {
  return {
    settings: DEFAULT_SETTINGS,
    categories: seedCategories(),
    incomeSources: [
      {
        id: newId('inc'),
        name: 'Take-home pay',
        kind: 'salary',
        monthlyCents: 0,
      },
    ],
    transactions: [],
    accounts: [],
    otherAssets: [],
    liabilities: [],
  };
}

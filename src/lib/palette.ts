import type { Cents } from '../types';

/**
 * Chart and category colors.
 *
 * These are the eight validated categorical slots, in the order that clears the
 * CVD and normal-vision separation gates for adjacent pairs. The order is the
 * safety mechanism, not decoration — do not reorder, and do not add a ninth
 * hue. Series past the token ceiling fold into "Other" via `foldToOther`.
 *
 * Three of the light slots sit below 3:1 against the light surface, so every
 * chart in this app ships visible labels and a table view as the documented
 * relief.
 */

export interface SeriesColor {
  light: string;
  dark: string;
}

export const CATEGORICAL: SeriesColor[] = [
  { light: '#2a78d6', dark: '#3987e5' }, // blue
  { light: '#eb6834', dark: '#d95926' }, // orange
  { light: '#1baf7a', dark: '#199e70' }, // aqua
  { light: '#eda100', dark: '#c98500' }, // yellow
  { light: '#e87ba4', dark: '#d55181' }, // magenta
  { light: '#008300', dark: '#008300' }, // green
  { light: '#4a3aa7', dark: '#9085e9' }, // violet
  { light: '#e34948', dark: '#e66767' }, // red
];

/** Reserved state colors. Never reused as a series hue, always with a label. */
export const STATUS = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
} as const;

/** Neutral for the folded "Other" bucket and de-emphasized marks. */
export const NEUTRAL = { light: '#898781', dark: '#898781' };

/** The palette offered in the category color picker, as light-mode hexes. */
export const CATEGORY_COLOR_CHOICES = CATEGORICAL.map((c) => c.light);

/** Map a stored light-mode hex to its dark-mode step. */
export function darkStepFor(lightHex: string): string {
  const match = CATEGORICAL.find((c) => c.light.toLowerCase() === lightHex.toLowerCase());
  return match?.dark ?? lightHex;
}

/** Assign a slot deterministically from an index — used only for seed data. */
export function slotColor(index: number): string {
  return CATEGORICAL[index % CATEGORICAL.length]!.light;
}

/** The categorical token ceiling. Past this, the tail folds into "Other". */
export const SERIES_CEILING = 7;

export interface FoldedSlice {
  id: string;
  label: string;
  valueCents: Cents;
  color: string;
  /** True for the synthetic "Other" bucket. */
  isOther: boolean;
  /** How many original items this slice stands for. */
  count: number;
}

/**
 * Sort by magnitude and fold everything past `max` into a single neutral
 * "Other" slice.
 *
 * Folding is the sanctioned answer to too many series; generating more hues is
 * not. Colors travel with the entity, so the categories that survive the fold
 * keep the color they had — changing the item count never repaints them.
 */
export function foldToOther(
  items: { id: string; label: string; valueCents: Cents; color: string }[],
  max = SERIES_CEILING,
): FoldedSlice[] {
  const sorted = [...items]
    .filter((i) => i.valueCents !== 0)
    .sort((a, b) => Math.abs(b.valueCents) - Math.abs(a.valueCents));

  if (sorted.length <= max) {
    return sorted.map((i) => ({ ...i, isOther: false, count: 1 }));
  }

  const kept = sorted.slice(0, max - 1).map((i) => ({ ...i, isOther: false, count: 1 }));
  const tail = sorted.slice(max - 1);

  return [
    ...kept,
    {
      id: '__other__',
      label: `Other (${tail.length})`,
      valueCents: tail.reduce((sum, i) => sum + i.valueCents, 0),
      color: NEUTRAL.light,
      isOther: true,
      count: tail.length,
    },
  ];
}

/**
 * Status color for a budget line's health. Always paired with a label in the
 * UI, never left to carry the meaning on its own.
 */
export function budgetStatus(
  spentCents: Cents,
  budgetCents: Cents,
): { level: keyof typeof STATUS; color: string; label: string } {
  if (budgetCents <= 0) {
    return { level: 'warning', color: STATUS.warning, label: 'No budget set' };
  }
  const ratio = spentCents / budgetCents;
  if (ratio > 1) return { level: 'critical', color: STATUS.critical, label: 'Over budget' };
  if (ratio > 0.9) return { level: 'serious', color: STATUS.serious, label: 'Nearly spent' };
  if (ratio > 0.75) return { level: 'warning', color: STATUS.warning, label: 'On pace' };
  return { level: 'good', color: STATUS.good, label: 'Within budget' };
}

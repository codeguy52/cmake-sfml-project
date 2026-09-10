import type { Bps, Category, Cents } from '../types';
import { activeCategories } from './budget';

/**
 * First-run setup.
 *
 * The app ships with a working budget so nothing is ever a blank screen, but
 * a starting budget somebody else wrote is only useful once it reflects two
 * things they know: what they earn, and how much of it they intend to keep.
 * Everything here supports asking those two questions and nothing more —
 * a setup that takes longer than a few minutes on a phone doesn't get done.
 */

export interface SavingsPreset {
  id: string;
  label: string;
  /** What choosing this means, in words rather than percentages. */
  description: string;
  savingsBps: Bps;
}

/**
 * Three starting points, not a spectrum.
 *
 * The savings rate is the one number that decides when work becomes optional,
 * so it is the one thing worth choosing deliberately on day one. Every other
 * category is scaled around it and can be edited afterwards.
 */
export const SAVINGS_PRESETS: SavingsPreset[] = [
  {
    id: 'starting',
    label: 'Getting started',
    description: 'Build the habit first. Around a tenth of your pay goes to savings.',
    savingsBps: 1_000,
  },
  {
    id: 'balanced',
    label: 'Balanced',
    description: 'The common rule of thumb — roughly half needs, a third wants, a fifth saved.',
    savingsBps: 2_000,
  },
  {
    id: 'aggressive',
    label: 'Financial independence',
    description: 'Save a third or more, which is what pulls retirement decades earlier.',
    savingsBps: 3_500,
  },
];

/** Share of income currently allocated to savings-group categories. */
export function savingsShareBps(categories: Category[]): Bps {
  return activeCategories(categories)
    .filter((c) => c.group === 'savings' && c.allocation.mode === 'percent')
    .reduce((sum, c) => sum + c.allocation.value, 0);
}

/**
 * Scale one group to a target share and the rest to what's left.
 *
 * Proportions inside each group are preserved, so a budget someone has already
 * shaped survives changing their savings rate. Rounding residue is pushed onto
 * the largest line in the group, which keeps the total at exactly 100% — the
 * same trick `normalizePercentages` uses, and for the same reason: a budget
 * that sums to 99.98% is a bug someone has to hunt down later.
 *
 * Fixed-amount categories are left alone. They are a dollar figure someone
 * typed, and silently turning rent into a percentage would be indefensible.
 */
export function applySavingsTarget(categories: Category[], targetBps: Bps): Category[] {
  const clamped = Math.max(0, Math.min(9_500, Math.round(targetBps)));

  const percentIds = new Set(
    activeCategories(categories)
      .filter((c) => c.allocation.mode === 'percent')
      .map((c) => c.id),
  );

  const savings = categories.filter((c) => percentIds.has(c.id) && c.group === 'savings');
  const rest = categories.filter((c) => percentIds.has(c.id) && c.group !== 'savings');
  if (savings.length === 0 || rest.length === 0) return categories;

  const scaled = new Map<string, Bps>([
    ...scaleGroup(savings, clamped),
    ...scaleGroup(rest, 10_000 - clamped),
  ]);

  return categories.map((c) =>
    scaled.has(c.id) ? { ...c, allocation: { ...c.allocation, value: scaled.get(c.id)! } } : c,
  );
}

function scaleGroup(group: Category[], targetBps: Bps): [string, Bps][] {
  const current = group.reduce((sum, c) => sum + c.allocation.value, 0);

  // A group with nothing in it yet gets the target split evenly, because
  // scaling zero by any factor is still zero.
  const values =
    current === 0
      ? group.map(() => Math.floor(targetBps / group.length))
      : group.map((c) => Math.round((c.allocation.value * targetBps) / current));

  const residue = targetBps - values.reduce((a, b) => a + b, 0);
  let largest = 0;
  for (let i = 1; i < values.length; i += 1) if (values[i]! > values[largest]!) largest = i;
  values[largest]! += residue;

  return group.map((c, i) => [c.id, values[i]!]);
}

/** What a preset works out to in real money, for showing on the choice itself. */
export function monthlySavings(incomeCents: Cents, savingsBps: Bps): Cents {
  return Math.round((incomeCents * savingsBps) / 10_000);
}

/**
 * Whether a stored dataset has been used, for deciding whether to offer setup.
 *
 * Existing installs must never be dropped back into a wizard, so anything with
 * income, spending or accounts on it counts as already set up.
 */
export function looksUsed(data: {
  incomeSources?: { monthlyCents: Cents }[];
  transactions?: unknown[];
  accounts?: unknown[];
}): boolean {
  const earning = (data.incomeSources ?? []).some((s) => s.monthlyCents > 0);
  return earning || (data.transactions ?? []).length > 0 || (data.accounts ?? []).length > 0;
}

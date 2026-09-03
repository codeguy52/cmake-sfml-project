import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { Cents } from '../types';
import { darkStepFor, NEUTRAL, type FoldedSlice } from '../lib/palette';
import { formatCentsCompact } from '../lib/money';
import { useFormatMoney } from './ui';
import { useStore } from '../store';

/**
 * Chart layer.
 *
 * Form follows the data's job, not variety: ratios against a limit are meters
 * (in `ui.tsx`), part-to-whole is a horizontal stacked bar, trend is a line,
 * and the FI projection is a stacked area splitting contributions from
 * compounding. There is no pie chart and no dual-axis chart anywhere in this
 * app, both deliberately.
 *
 * Series colors are emitted as `var(--series-n)` so light and dark steps swap
 * in CSS rather than being recomputed in JS. Category-owned colors are stored
 * as light-mode hex and mapped to their dark step by `useSeriesColor`.
 */

/** Tracks the effective color scheme, including the in-app theme override. */
export function useIsDark(): boolean {
  const [isDark, setIsDark] = useState(() => {
    if (typeof window === 'undefined') return false;
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'dark') return true;
    if (attr === 'light') return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const recompute = (): void => {
      const attr = document.documentElement.getAttribute('data-theme');
      setIsDark(attr === 'dark' ? true : attr === 'light' ? false : media.matches);
    };
    media.addEventListener('change', recompute);
    const observer = new MutationObserver(recompute);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      media.removeEventListener('change', recompute);
      observer.disconnect();
    };
  }, []);

  return isDark;
}

/** Map a stored light-mode series hex to the step for the active mode. */
export function useSeriesColor(): (lightHex: string) => string {
  const isDark = useIsDark();
  return useMemo(() => (lightHex: string) => (isDark ? darkStepFor(lightHex) : lightHex), [isDark]);
}

function useCompact(): (cents: Cents) => string {
  const { currency, locale } = useStore((s) => s.data.settings);
  return useMemo(() => (cents: Cents) => formatCentsCompact(cents, currency, locale), [currency, locale]);
}

interface TooltipEntry {
  name?: string | number;
  value?: number | string;
  color?: string;
  dataKey?: string | number;
  payload?: Record<string, unknown>;
}

/** Shared tooltip body: title plus one row per series, values right-aligned. */
function MoneyTooltip({
  active,
  payload,
  label,
  labelFormatter,
  total,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string | number;
  labelFormatter?: (label: string | number | undefined) => string;
  total?: boolean;
}) {
  const fmt = useFormatMoney();
  if (!active || !payload || payload.length === 0) return null;

  const rows = payload.filter((p) => typeof p.value === 'number');
  const sum = rows.reduce((acc, p) => acc + (p.value as number), 0);

  return (
    <div className="tooltip">
      <div className="tooltip-title">{labelFormatter ? labelFormatter(label) : String(label ?? '')}</div>
      {rows.map((p) => (
        <div className="tooltip-row" key={String(p.dataKey ?? p.name)}>
          <span>
            <span className="swatch" style={{ background: p.color }} aria-hidden="true" />{' '}
            {String(p.name ?? p.dataKey)}
          </span>
          <strong>{fmt(p.value as number)}</strong>
        </div>
      ))}
      {total && rows.length > 1 && (
        <div className="tooltip-row" style={{ marginTop: 4, paddingTop: 4, borderTop: '1px solid var(--border)' }}>
          <span>Total</span>
          <strong>{fmt(sum)}</strong>
        </div>
      )}
    </div>
  );
}

/**
 * Part-to-whole as a horizontal 100% stacked bar.
 *
 * Hand-built rather than a charting-library stack so the 2px surface gap
 * between segments and the direct labels behave exactly as specified. Segments
 * wide enough to hold text are labeled in place; the rest rely on the legend
 * and the hover tooltip.
 */
export function StackedShareBar({
  slices,
  totalCents,
  emptyLabel = 'Nothing allocated yet',
}: {
  slices: FoldedSlice[];
  totalCents: Cents;
  emptyLabel?: string;
}) {
  const fmt = useFormatMoney();
  const seriesColor = useSeriesColor();
  const [hovered, setHovered] = useState<string | null>(null);

  const positive = slices.filter((s) => s.valueCents > 0);
  const sum = positive.reduce((acc, s) => acc + s.valueCents, 0);
  const denominator = Math.max(totalCents, sum);

  if (denominator <= 0 || positive.length === 0) {
    return <p className="muted" style={{ fontSize: 13, margin: 0 }}>{emptyLabel}</p>;
  }

  const remainder = Math.max(0, totalCents - sum);

  return (
    <div>
      <div className="stack-bar">
        {positive.map((s) => {
          const pct = (s.valueCents / denominator) * 100;
          const color = s.isOther ? NEUTRAL.light : seriesColor(s.color);
          return (
            <div
              key={s.id}
              className="stack-seg"
              style={{
                width: `${pct}%`,
                background: color,
                opacity: hovered && hovered !== s.id ? 0.45 : 1,
              }}
              onMouseEnter={() => setHovered(s.id)}
              onMouseLeave={() => setHovered(null)}
              title={`${s.label}: ${fmt(s.valueCents)} (${pct.toFixed(1)}%)`}
            />
          );
        })}
        {remainder > 0 && (
          <div
            className="stack-seg"
            style={{
              width: `${(remainder / denominator) * 100}%`,
              background: 'var(--surface-sunken)',
              boxShadow: 'inset 0 0 0 1px var(--border)',
            }}
            title={`Unallocated: ${fmt(remainder)}`}
          />
        )}
      </div>

      <div className="chart-legend">
        {positive.map((s) => (
          <span className="legend-item" key={s.id}>
            <span
              className="swatch"
              style={{ background: s.isOther ? NEUTRAL.light : seriesColor(s.color) }}
              aria-hidden="true"
            />
            {s.label}{' '}
            <span className="muted mono-num">
              {((s.valueCents / denominator) * 100).toFixed(0)}%
            </span>
          </span>
        ))}
        {remainder > 0 && (
          <span className="legend-item">
            <span
              className="swatch"
              style={{ background: 'var(--surface-sunken)', boxShadow: 'inset 0 0 0 1px var(--axis)' }}
              aria-hidden="true"
            />
            Unallocated <span className="muted mono-num">{fmt(remainder)}</span>
          </span>
        )}
      </div>
    </div>
  );
}

/** The table view for a share bar. */
export function ShareTable({
  slices,
  totalCents,
  valueHeader = 'Amount',
}: {
  slices: FoldedSlice[];
  totalCents: Cents;
  valueHeader?: string;
}) {
  const fmt = useFormatMoney();
  const seriesColor = useSeriesColor();
  const sum = slices.reduce((acc, s) => acc + s.valueCents, 0);
  const denominator = Math.max(totalCents, sum);

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Category</th>
            <th className="num">{valueHeader}</th>
            <th className="num">Share</th>
          </tr>
        </thead>
        <tbody>
          {slices.map((s) => (
            <tr key={s.id}>
              <td>
                <span
                  className="swatch"
                  style={{ background: s.isOther ? NEUTRAL.light : seriesColor(s.color) }}
                  aria-hidden="true"
                />{' '}
                {s.label}
              </td>
              <td className="num">{fmt(s.valueCents)}</td>
              <td className="num">
                {denominator > 0 ? `${((s.valueCents / denominator) * 100).toFixed(1)}%` : '—'}
              </td>
            </tr>
          ))}
          <tr className="total-row">
            <td>Total</td>
            <td className="num">{fmt(sum)}</td>
            <td className="num">
              {denominator > 0 ? `${((sum / denominator) * 100).toFixed(1)}%` : '—'}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** Trend over time. One series, so no legend — the card title names it. */
export function SpendTrendChart({
  data,
  budgetCents,
}: {
  data: { month: string; spentCents: Cents }[];
  budgetCents?: Cents;
}) {
  const compact = useCompact();

  const points = data.map((d) => ({
    month: d.month,
    label: monthLabel(d.month),
    spent: d.spentCents,
  }));

  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={points} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} />
        <YAxis
          tickFormatter={(v: number) => compact(v)}
          tickLine={false}
          axisLine={false}
          width={56}
        />
        <Tooltip content={<MoneyTooltip />} />
        {budgetCents !== undefined && budgetCents > 0 && (
          <ReferenceLine
            y={budgetCents}
            stroke="var(--axis)"
            strokeDasharray="4 4"
            label={{
              value: `Budget ${compact(budgetCents)}`,
              position: 'insideTopRight',
              fill: 'var(--text-muted)',
              fontSize: 11,
            }}
          />
        )}
        <Line
          type="monotone"
          dataKey="spent"
          name="Spent"
          stroke="var(--series-1)"
          strokeWidth={2}
          dot={{ r: 3, strokeWidth: 0, fill: 'var(--series-1)' }}
          activeDot={{ r: 5, stroke: 'var(--surface)', strokeWidth: 2 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function monthLabel(monthKey: string): string {
  const [year, month] = monthKey.split('-');
  const date = new Date(Number(year), Number(month) - 1, 1);
  return date.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
}

/**
 * The FI projection: a stacked area separating what you put in from what
 * compounding added, with the FI number as a reference line.
 *
 * Stacking is the point — the moment the growth band overtakes the contribution
 * band is the moment the portfolio is doing more work than the paycheck, and
 * that crossover is the single most motivating thing in the whole app.
 */
export function ProjectionChart({
  points,
  targetCents,
  startingBalanceCents,
  monthsToFI,
}: {
  points: { year: number; balanceCents: Cents; contributedCents: Cents; growthCents: Cents }[];
  targetCents: Cents;
  startingBalanceCents: Cents;
  monthsToFI: number | null;
}) {
  const compact = useCompact();

  // Show a decade past FI, or 40 years when FI never arrives — a 100-year axis
  // makes the interesting part unreadable.
  const horizonYears = monthsToFI === null ? 40 : Math.min(60, Math.ceil(monthsToFI / 12) + 10);
  const data = points
    .filter((p) => p.year <= horizonYears)
    .map((p) => ({
      year: p.year,
      starting: startingBalanceCents,
      contributed: p.contributedCents,
      growth: Math.max(0, p.growthCents),
    }));

  // Label roughly eight ticks whatever the horizon — a tick per year turns the
  // axis into a smear of text at 30+ years.
  const tickStep = Math.max(1, Math.ceil(horizonYears / 8));
  const ticks = data.map((d) => d.year).filter((y) => y % tickStep === 0);

  return (
    <ResponsiveContainer width="100%" height={280}>
      <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="year"
          ticks={ticks}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: number) => `${v}y`}
        />
        <YAxis tickFormatter={(v: number) => compact(v)} tickLine={false} axisLine={false} width={56} />
        <Tooltip
          content={<MoneyTooltip total labelFormatter={(l) => `Year ${l}`} />}
        />
        <ReferenceLine
          y={targetCents}
          stroke="var(--text-primary)"
          strokeDasharray="5 4"
          strokeOpacity={0.6}
          label={{
            value: `FI number ${compact(targetCents)}`,
            position: 'insideTopLeft',
            fill: 'var(--text-secondary)',
            fontSize: 11,
          }}
        />
        {monthsToFI !== null && (
          <ReferenceLine
            x={Math.round(monthsToFI / 12)}
            stroke="var(--good)"
            strokeWidth={2}
            label={{
              value: 'FI',
              position: 'top',
              fill: 'var(--good-text)',
              fontSize: 11,
              fontWeight: 700,
            }}
          />
        )}
        <Area
          type="monotone"
          dataKey="starting"
          stackId="1"
          name="Starting balance"
          stroke="var(--series-7)"
          fill="var(--series-7)"
          fillOpacity={0.85}
          strokeWidth={0}
        />
        <Area
          type="monotone"
          dataKey="contributed"
          stackId="1"
          name="Contributions"
          stroke="var(--series-1)"
          fill="var(--series-1)"
          fillOpacity={0.85}
          strokeWidth={0}
        />
        <Area
          type="monotone"
          dataKey="growth"
          stackId="1"
          name="Investment growth"
          stroke="var(--series-3)"
          fill="var(--series-3)"
          fillOpacity={0.85}
          strokeWidth={0}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/**
 * Drift from a target allocation: a diverging bar around zero, which is the
 * form for above/below a baseline. Overweight and underweight get the two
 * diverging poles, never a rainbow.
 */
export function DriftChart({
  rows,
  labelFor,
}: {
  rows: { assetClass: string; driftCents: Cents; currentBps: number; targetBps: number }[];
  labelFor: (key: string) => string;
}) {
  const compact = useCompact();
  const data = rows.map((r) => ({ ...r, label: labelFor(r.assetClass), drift: r.driftCents }));

  return (
    <ResponsiveContainer width="100%" height={Math.max(160, data.length * 40 + 40)}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 20, bottom: 4, left: 8 }}>
        <CartesianGrid horizontal={false} />
        <XAxis
          type="number"
          tickFormatter={(v: number) => compact(v)}
          tickLine={false}
          axisLine={false}
        />
        <YAxis type="category" dataKey="label" width={104} tickLine={false} axisLine={false} />
        <Tooltip content={<MoneyTooltip />} />
        <ReferenceLine x={0} stroke="var(--axis)" />
        <Bar dataKey="drift" name="Drift from target" radius={[4, 4, 4, 4]} barSize={16}>
          {data.map((row) => (
            <Cell
              key={row.assetClass}
              // Diverging pair: blue for overweight, red for underweight.
              fill={row.driftCents >= 0 ? 'var(--series-1)' : 'var(--series-8)'}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Net worth composition: one horizontal stacked bar of assets minus debt. */
export function NetWorthBars({
  rows,
}: {
  rows: { label: string; valueCents: Cents; color: string }[];
}) {
  const compact = useCompact();
  const data = rows.map((r) => ({ ...r, value: r.valueCents }));

  return (
    <ResponsiveContainer width="100%" height={Math.max(140, data.length * 42 + 30)}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 60, bottom: 4, left: 8 }}>
        <CartesianGrid horizontal={false} />
        <XAxis
          type="number"
          tickFormatter={(v: number) => compact(v)}
          tickLine={false}
          axisLine={false}
        />
        <YAxis type="category" dataKey="label" width={112} tickLine={false} axisLine={false} />
        <Tooltip content={<MoneyTooltip />} />
        <ReferenceLine x={0} stroke="var(--axis)" />
        <Bar dataKey="value" name="Value" radius={[4, 4, 4, 4]} barSize={18}>
          {data.map((row) => (
            <Cell key={row.label} fill={row.color} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Simple two-column money table, used as several charts' table view. */
export function MoneyTable({
  rows,
  columns,
  totalRow,
}: {
  rows: { key: string; cells: ReactNode[] }[];
  columns: { label: string; numeric?: boolean }[];
  totalRow?: ReactNode[];
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.label} className={c.numeric ? 'num' : undefined}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              {r.cells.map((cell, i) => (
                <td key={i} className={columns[i]?.numeric ? 'num' : undefined}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
          {totalRow && (
            <tr className="total-row">
              {totalRow.map((cell, i) => (
                <td key={i} className={columns[i]?.numeric ? 'num' : undefined}>
                  {cell}
                </td>
              ))}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

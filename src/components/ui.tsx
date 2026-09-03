import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react';
import type { Bps, Cents } from '../types';
import { bpsToPercent, centsToInputValue, formatCents, parseMoney, percentToBps } from '../lib/money';
import { useStore } from '../store';

/** Currency and locale come from settings, so every amount formats identically. */
export function useFormatMoney(): (cents: Cents, showCents?: boolean) => string {
  const { currency, locale } = useStore((s) => s.data.settings);
  return useMemo(
    () => (cents: Cents, showCents = true) => formatCents(cents, { currency, locale, showCents }),
    [currency, locale],
  );
}

export function Card({
  title,
  note,
  actions,
  children,
  as: Tag = 'section',
}: {
  title?: string;
  note?: string;
  actions?: ReactNode;
  children: ReactNode;
  as?: 'section' | 'div';
}) {
  return (
    <Tag className="card">
      {(title || actions) && (
        <div className="card-header">
          <div>
            {title && <h2 className="card-title">{title}</h2>}
            {note && <p className="card-note">{note}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </Tag>
  );
}

export function StatTile({
  label,
  value,
  sub,
  tone,
  hero,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'good' | 'bad';
  hero?: boolean;
}) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div
        className={[
          hero ? 'hero-figure' : 'stat-value',
          tone === 'good' ? 'delta-good' : tone === 'bad' ? 'delta-bad' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {value}
      </div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {children(id)}
      {error ? (
        <span className="field-error">{error}</span>
      ) : (
        hint && <span className="field-hint">{hint}</span>
      )}
    </div>
  );
}

/**
 * Money input.
 *
 * Holds the user's raw keystrokes locally so a partially typed "12." isn't
 * reformatted out from under the cursor, and only commits when the text parses.
 * Committing on every keystroke is what makes naive money inputs impossible to
 * type into.
 */
export function MoneyInput({
  valueCents,
  onCommit,
  id,
  placeholder,
  allowNegative = false,
  ariaLabel,
}: {
  valueCents: Cents;
  onCommit: (cents: Cents) => void;
  id?: string;
  placeholder?: string;
  allowNegative?: boolean;
  ariaLabel?: string;
}) {
  const [text, setText] = useState(() => centsToInputValue(valueCents));
  const [focused, setFocused] = useState(false);
  const [invalid, setInvalid] = useState(false);

  // Track external changes, but never while the user is mid-edit.
  useEffect(() => {
    if (!focused) {
      setText(centsToInputValue(valueCents));
      setInvalid(false);
    }
  }, [valueCents, focused]);

  const handleChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const next = e.target.value;
    setText(next);
    const parsed = parseMoney(next);
    if (parsed === null) {
      setInvalid(next.trim().length > 0);
      return;
    }
    setInvalid(false);
    onCommit(allowNegative ? parsed : Math.abs(parsed));
  };

  return (
    <input
      id={id}
      className="input-money"
      type="text"
      inputMode="decimal"
      value={text}
      placeholder={placeholder ?? '0.00'}
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        const parsed = parseMoney(text);
        // Snap back to the last good value rather than leaving junk on screen.
        setText(centsToInputValue(parsed === null ? valueCents : allowNegative ? parsed : Math.abs(parsed)));
        setInvalid(false);
      }}
      onChange={handleChange}
    />
  );
}

/** Percent input over a basis-point value. Same mid-edit handling as money. */
export function PercentInput({
  valueBps,
  onCommit,
  id,
  ariaLabel,
  max = 100,
}: {
  valueBps: Bps;
  onCommit: (bps: Bps) => void;
  id?: string;
  ariaLabel?: string;
  max?: number;
}) {
  const [text, setText] = useState(() => String(bpsToPercent(valueBps)));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setText(String(bpsToPercent(valueBps)));
  }, [valueBps, focused]);

  return (
    <input
      id={id}
      className="input-money"
      type="text"
      inputMode="decimal"
      value={text}
      aria-label={ariaLabel}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        setText(String(bpsToPercent(valueBps)));
      }}
      onChange={(e) => {
        const next = e.target.value;
        setText(next);
        const parsed = Number(next.replace(/[%\s]/g, ''));
        if (Number.isFinite(parsed)) {
          onCommit(percentToBps(Math.max(0, Math.min(max, parsed))));
        }
      }}
    />
  );
}

/**
 * A ratio against a limit — the right form for "spent vs budgeted", per the
 * form heuristic. The fill is clipped at 100% and an over-budget bar switches
 * to the critical color *and* carries a label, so the color never has to carry
 * the meaning alone.
 */
export function Meter({
  label,
  valueCents,
  limitCents,
  color,
  statusLabel,
  statusColor,
  right,
}: {
  label: ReactNode;
  valueCents: Cents;
  limitCents: Cents;
  color: string;
  statusLabel?: string;
  statusColor?: string;
  right?: ReactNode;
}) {
  const ratio = limitCents > 0 ? valueCents / limitCents : 0;
  const over = ratio > 1;
  const pct = Math.max(0, Math.min(100, ratio * 100));
  const fmt = useFormatMoney();

  return (
    <div className="meter">
      <div className="meter-head">
        <span>{label}</span>
        <span className="mono-num secondary">
          {right ?? (
            <>
              {fmt(valueCents)} <span className="muted">of {fmt(limitCents)}</span>
            </>
          )}
        </span>
      </div>
      <div
        className="meter-track"
        role="meter"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={typeof label === 'string' ? label : undefined}
      >
        <div
          className="meter-fill"
          style={{ width: `${over ? 100 : pct}%`, background: over ? statusColor ?? color : color }}
        />
        {over && <div className="meter-limit" style={{ left: `${100 / ratio}%` }} />}
      </div>
      {statusLabel && (
        <div className="field-hint" style={{ marginTop: 4, color: statusColor }}>
          {statusLabel}
        </div>
      )}
    </div>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Callout({
  tone = 'neutral',
  icon,
  children,
}: {
  tone?: 'neutral' | 'good' | 'warning' | 'critical';
  icon?: string;
  children: ReactNode;
}) {
  const defaultIcon = { neutral: 'ℹ', good: '✓', warning: '!', critical: '⚠' }[tone];
  return (
    <div className={`callout${tone === 'neutral' ? '' : ` callout-${tone}`}`}>
      <span className="callout-icon" aria-hidden="true">
        {icon ?? defaultIcon}
      </span>
      <div>{children}</div>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  children,
}: {
  icon: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon" aria-hidden="true">
        {icon}
      </div>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{title}</div>
      {children && <div style={{ fontSize: 13 }}>{children}</div>}
    </div>
  );
}

/**
 * Destructive action with inline confirmation.
 *
 * Deleting a category or an account discards data the user typed, so the click
 * has to be deliberate. Inline two-step rather than a modal: it keeps the row
 * context visible, which is what tells the user *what* they are deleting.
 */
export function ConfirmButton({
  onConfirm,
  children,
  confirmLabel = 'Confirm',
  title,
  className = 'btn btn-icon',
}: {
  onConfirm: () => void;
  children: ReactNode;
  confirmLabel?: string;
  title?: string;
  className?: string;
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  if (armed) {
    return (
      <span className="btn-row" style={{ gap: 4 }}>
        <button
          type="button"
          className="btn btn-sm btn-danger"
          onClick={() => {
            setArmed(false);
            onConfirm();
          }}
        >
          {confirmLabel}
        </button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setArmed(false)}>
          Cancel
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      className={className}
      title={title}
      onClick={() => {
        setArmed(true);
        // Disarm on its own, so a stray click doesn't stay dangerous.
        timer.current = setTimeout(() => setArmed(false), 6000);
      }}
    >
      {children}
    </button>
  );
}

/**
 * Toggles between a chart and its underlying table.
 *
 * Present on every chart in the app. Three of the light-mode series colors sit
 * below 3:1 against the surface, and the palette's relief rule for that is
 * visible labels or a table view — so the table isn't a nicety here, it's the
 * accessibility contract.
 */
export function ChartFrame({
  title,
  note,
  children,
  table,
  actions,
}: {
  title: string;
  note?: string;
  children: ReactNode;
  table: ReactNode;
  actions?: ReactNode;
}) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  return (
    <Card
      title={title}
      note={note}
      actions={
        <div className="btn-row">
          {actions}
          <Segmented
            ariaLabel={`${title} view`}
            value={view}
            onChange={setView}
            options={[
              { value: 'chart', label: 'Chart' },
              { value: 'table', label: 'Table' },
            ]}
          />
        </div>
      }
    >
      {view === 'chart' ? <div className="chart-frame">{children}</div> : table}
    </Card>
  );
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="chart-legend">
      {items.map((i) => (
        <span className="legend-item" key={i.label}>
          <span className="swatch" style={{ background: i.color }} aria-hidden="true" />
          {i.label}
        </span>
      ))}
    </div>
  );
}

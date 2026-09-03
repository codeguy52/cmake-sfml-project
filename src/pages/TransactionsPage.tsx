import { useMemo, useState } from 'react';
import type { Transaction } from '../types';
import { useStore } from '../store';
import { currentMonthKey, monthKey } from '../lib/budget';
import { Card, ConfirmButton, EmptyState, Field, MoneyInput, useFormatMoney } from '../components/ui';
import { useSeriesColor } from '../components/charts';

/** Distinct `YYYY-MM` keys present in the data, newest first, plus this month. */
function availableMonths(transactions: Transaction[]): string[] {
  const set = new Set(transactions.map((t) => monthKey(t.date)));
  set.add(currentMonthKey());
  return [...set].sort((a, b) => b.localeCompare(a));
}

function formatMonth(key: string): string {
  const [year, month] = key.split('-');
  return new Date(Number(year), Number(month) - 1, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });
}

export default function TransactionsPage() {
  const data = useStore((s) => s.data);
  const { addTransaction, updateTransaction, removeTransaction } = useStore();
  const fmt = useFormatMoney();
  const seriesColor = useSeriesColor();

  const [month, setMonth] = useState(currentMonthKey());
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('');
  const [adding, setAdding] = useState(false);

  const [newTxn, setNewTxn] = useState({
    date: new Date().toISOString().slice(0, 10),
    merchant: '',
    amountCents: 0,
    categoryId: '',
    subcategoryId: '',
    note: '',
  });

  const months = useMemo(() => availableMonths(data.transactions), [data.transactions]);

  const categoryName = useMemo(
    () => new Map(data.categories.map((c) => [c.id, c])),
    [data.categories],
  );
  const subName = useMemo(
    () =>
      new Map(
        data.categories.flatMap((c) => c.subcategories.map((s) => [s.id, s.name] as const)),
      ),
    [data.categories],
  );

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return data.transactions
      .filter((t) => (month === 'all' ? true : monthKey(t.date) === month))
      .filter((t) => (categoryFilter ? t.categoryId === categoryFilter : true))
      .filter((t) =>
        needle
          ? t.merchant.toLowerCase().includes(needle) || (t.note ?? '').toLowerCase().includes(needle)
          : true,
      )
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
  }, [data.transactions, month, categoryFilter, search]);

  const total = filtered.reduce((sum, t) => sum + t.amountCents, 0);

  const newTxnCategory = data.categories.find((c) => c.id === newTxn.categoryId);

  const submitNew = (): void => {
    addTransaction({
      date: newTxn.date,
      merchant: newTxn.merchant.trim() || 'Unknown merchant',
      amountCents: newTxn.amountCents,
      categoryId: newTxn.categoryId || null,
      subcategoryId: newTxn.subcategoryId || null,
      note: newTxn.note.trim() || undefined,
      source: 'manual',
    });
    setNewTxn({
      date: newTxn.date,
      merchant: '',
      amountCents: 0,
      categoryId: newTxn.categoryId,
      subcategoryId: '',
      note: '',
    });
    setAdding(false);
  };

  return (
    <>
      <header className="page-header">
        <h1 className="page-title">Transactions</h1>
        <p className="page-subtitle">
          Everything you've recorded, by hand or from a receipt. Amounts are money out; enter a
          refund as a negative amount.
        </p>
      </header>

      <div className="stack">
        <Card>
          <div className="form-row">
            <Field label="Month">
              {(id) => (
                <select id={id} value={month} onChange={(e) => setMonth(e.target.value)}>
                  <option value="all">All time</option>
                  {months.map((m) => (
                    <option key={m} value={m}>
                      {formatMonth(m)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Category">
              {(id) => (
                <select
                  id={id}
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value)}
                >
                  <option value="">All categories</option>
                  {data.categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Search">
              {(id) => (
                <input
                  id={id}
                  type="search"
                  value={search}
                  placeholder="Merchant or note"
                  onChange={(e) => setSearch(e.target.value)}
                />
              )}
            </Field>
            <div style={{ display: 'flex', alignItems: 'flex-end' }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setAdding((a) => !a)}
                aria-expanded={adding}
              >
                {adding ? 'Cancel' : '+ Add transaction'}
              </button>
            </div>
          </div>

          {adding && (
            <div
              style={{
                marginTop: 14,
                paddingTop: 14,
                borderTop: '1px solid var(--border)',
              }}
            >
              <div className="form-row">
                <Field label="Date">
                  {(id) => (
                    <input
                      id={id}
                      type="date"
                      value={newTxn.date}
                      onChange={(e) => setNewTxn({ ...newTxn, date: e.target.value })}
                    />
                  )}
                </Field>
                <Field label="Merchant">
                  {(id) => (
                    <input
                      id={id}
                      type="text"
                      value={newTxn.merchant}
                      placeholder="Where you spent it"
                      onChange={(e) => setNewTxn({ ...newTxn, merchant: e.target.value })}
                    />
                  )}
                </Field>
                <Field label="Amount" hint="Negative for a refund">
                  {(id) => (
                    <MoneyInput
                      id={id}
                      valueCents={newTxn.amountCents}
                      allowNegative
                      onCommit={(amountCents) => setNewTxn({ ...newTxn, amountCents })}
                    />
                  )}
                </Field>
                <Field label="Category">
                  {(id) => (
                    <select
                      id={id}
                      value={newTxn.categoryId}
                      onChange={(e) =>
                        setNewTxn({ ...newTxn, categoryId: e.target.value, subcategoryId: '' })
                      }
                    >
                      <option value="">Uncategorized</option>
                      {data.categories
                        .filter((c) => !c.archived)
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                    </select>
                  )}
                </Field>
                <Field label="Subcategory">
                  {(id) => (
                    <select
                      id={id}
                      value={newTxn.subcategoryId}
                      disabled={!newTxnCategory || newTxnCategory.subcategories.length === 0}
                      onChange={(e) => setNewTxn({ ...newTxn, subcategoryId: e.target.value })}
                    >
                      <option value="">
                        {newTxnCategory?.subcategories.length ? 'None' : 'No subcategories'}
                      </option>
                      {newTxnCategory?.subcategories.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
              </div>
              <div className="btn-row" style={{ marginTop: 12 }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={newTxn.amountCents === 0}
                  onClick={submitNew}
                >
                  Save
                </button>
                {newTxn.amountCents === 0 && (
                  <span className="field-hint">Enter an amount to save.</span>
                )}
              </div>
            </div>
          )}
        </Card>

        <Card
          title={month === 'all' ? 'All transactions' : formatMonth(month)}
          note={`${filtered.length} transaction${filtered.length === 1 ? '' : 's'}, ${fmt(total)} total`}
        >
          {filtered.length === 0 ? (
            <EmptyState icon="▤" title="Nothing here">
              {data.transactions.length === 0
                ? 'Scan a receipt or add a transaction to get started.'
                : 'No transactions match these filters.'}
            </EmptyState>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Merchant</th>
                    <th>Category</th>
                    <th className="num">Amount</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((t) => {
                    const category = t.categoryId ? categoryName.get(t.categoryId) : undefined;
                    return (
                      <tr key={t.id}>
                        <td className="secondary mono-num" style={{ whiteSpace: 'nowrap' }}>
                          {t.date}
                        </td>
                        <td>
                          {t.merchant}
                          {t.receiptId && (
                            <span className="badge" style={{ marginLeft: 6 }} title="Has a receipt photo">
                              photo
                            </span>
                          )}
                          {t.note && (
                            <div className="field-hint" style={{ marginTop: 1 }}>
                              {t.note}
                            </div>
                          )}
                        </td>
                        <td>
                          <select
                            value={t.categoryId ?? ''}
                            aria-label={`Category for ${t.merchant}`}
                            style={{ padding: '3px 6px', fontSize: 13 }}
                            onChange={(e) =>
                              updateTransaction(t.id, {
                                categoryId: e.target.value || null,
                                subcategoryId: null,
                              })
                            }
                          >
                            <option value="">Uncategorized</option>
                            {data.categories.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                          {category && category.subcategories.length > 0 && (
                            <select
                              value={t.subcategoryId ?? ''}
                              aria-label={`Subcategory for ${t.merchant}`}
                              style={{ padding: '3px 6px', fontSize: 13, marginTop: 3 }}
                              onChange={(e) =>
                                updateTransaction(t.id, { subcategoryId: e.target.value || null })
                              }
                            >
                              <option value="">
                                {t.subcategoryId && !subName.has(t.subcategoryId) ? 'Removed' : 'None'}
                              </option>
                              {category.subcategories.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.name}
                                </option>
                              ))}
                            </select>
                          )}
                          {category && (
                            <span
                              className="swatch"
                              style={{ background: seriesColor(category.color), marginLeft: 6 }}
                              aria-hidden="true"
                            />
                          )}
                        </td>
                        <td className="num" style={{ width: 120 }}>
                          <MoneyInput
                            valueCents={t.amountCents}
                            allowNegative
                            ariaLabel={`Amount for ${t.merchant}`}
                            onCommit={(amountCents) => updateTransaction(t.id, { amountCents })}
                          />
                        </td>
                        <td className="num">
                          <ConfirmButton
                            className="btn btn-sm btn-ghost"
                            confirmLabel="Delete"
                            onConfirm={() => void removeTransaction(t.id)}
                          >
                            ✕
                          </ConfirmButton>
                        </td>
                      </tr>
                    );
                  })}
                  <tr className="total-row">
                    <td colSpan={3}>Total</td>
                    <td className="num">{fmt(total)}</td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

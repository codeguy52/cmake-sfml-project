import { useMemo, useState } from 'react';
import type { AccountKind, AssetClass, InvestmentAccount, TaxTreatment } from '../types';
import { useStore } from '../store';
import {
  accountCostBasis,
  accountValue,
  computeNetWorth,
  holdingReturnBps,
  holdingValue,
  rebalancePlan,
  summarizePortfolio,
} from '../lib/investments';
import { bpsToPercent, percentToBps } from '../lib/money';
import { foldToOther, slotColor, STATUS } from '../lib/palette';
import {
  Callout,
  Card,
  ChartFrame,
  ConfirmButton,
  EmptyState,
  Field,
  MoneyInput,
  PercentInput,
  StatTile,
  useFormatMoney,
} from '../components/ui';
import { DriftChart, MoneyTable, NetWorthBars, ShareTable, StackedShareBar } from '../components/charts';
import LinkedAccounts from '../components/LinkedAccounts';
import type { View } from '../App';

const ASSET_CLASS_LABELS: Record<AssetClass, string> = {
  us_stock: 'US stocks',
  intl_stock: 'International stocks',
  bond: 'Bonds',
  reit: 'Real estate',
  cash: 'Cash',
  crypto: 'Crypto',
  other: 'Other',
};

const ASSET_CLASS_ORDER: AssetClass[] = [
  'us_stock',
  'intl_stock',
  'bond',
  'reit',
  'cash',
  'crypto',
  'other',
];

const TAX_LABELS: Record<TaxTreatment, string> = {
  pretax: 'Pre-tax',
  roth: 'Roth',
  taxable: 'Taxable',
  hsa: 'HSA',
};

const ACCOUNT_KINDS: { value: AccountKind; label: string; tax: TaxTreatment }[] = [
  { value: '401k', label: '401(k)', tax: 'pretax' },
  { value: '403b', label: '403(b)', tax: 'pretax' },
  { value: 'tsp', label: 'TSP', tax: 'pretax' },
  { value: 'ira', label: 'Traditional IRA', tax: 'pretax' },
  { value: 'roth_ira', label: 'Roth IRA', tax: 'roth' },
  { value: 'hsa', label: 'HSA', tax: 'hsa' },
  { value: 'taxable', label: 'Taxable brokerage', tax: 'taxable' },
  { value: 'cash', label: 'Cash / savings', tax: 'taxable' },
  { value: '529', label: '529 plan', tax: 'taxable' },
  { value: 'crypto', label: 'Crypto', tax: 'taxable' },
  { value: 'other', label: 'Other', tax: 'taxable' },
];

/** A default target mix, editable per class. Sums are the user's problem to
 *  balance — the drift chart shows them when it doesn't reach 100%. */
const DEFAULT_TARGETS: Partial<Record<AssetClass, number>> = {
  us_stock: 6000,
  intl_stock: 2000,
  bond: 1500,
  reit: 500,
};

function AccountCard({ account }: { account: InvestmentAccount }) {
  const [expanded, setExpanded] = useState(false);
  const fmt = useFormatMoney();
  const { updateAccount, removeAccount, addHolding, updateHolding, removeHolding } = useStore();

  const value = accountValue(account);
  const basis = accountCostBasis(account);
  const gain = value - basis;

  return (
    <div className="cat-row">
      <div
        className="cat-head"
        style={{ gridTemplateColumns: 'minmax(120px, 1.4fr) auto auto auto auto' }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <input
            type="text"
            className="cat-name-input"
            value={account.name}
            aria-label="Account name"
            onChange={(e) =>
              updateAccount(account.id, {
                name: e.target.value,
                // Once renamed, a sync stops overwriting the name with
                // whatever the brokerage calls the account.
                ...(account.link ? { nameOverridden: true } : {}),
              })
            }
          />
          {account.link && (
            <span
              className="badge"
              title={`Linked to ${account.link.institution}. Holdings are replaced on each sync.`}
            >
              ⇄ linked
            </span>
          )}
        </span>
        <select
          value={account.kind}
          aria-label="Account type"
          style={{ width: 'auto' }}
          onChange={(e) => {
            const kind = e.target.value as AccountKind;
            const preset = ACCOUNT_KINDS.find((k) => k.value === kind);
            // Tax treatment follows from the account type; the user can still
            // override it below for anything unusual.
            updateAccount(account.id, { kind, taxTreatment: preset?.tax ?? account.taxTreatment });
          }}
        >
          {ACCOUNT_KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
        <span className="resolved-amount">
          <strong>{fmt(value)}</strong>
          {basis > 0 && (
            <div
              className="field-hint"
              style={{ color: gain >= 0 ? 'var(--good-text)' : 'var(--critical)' }}
            >
              {gain >= 0 ? '+' : '−'}
              {fmt(Math.abs(gain))}
            </div>
          )}
        </span>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
        >
          {account.holdings.length} holding{account.holdings.length === 1 ? '' : 's'}
        </button>
        <ConfirmButton
          onConfirm={() => removeAccount(account.id)}
          confirmLabel="Delete"
          title={`Delete ${account.name}`}
        >
          ✕
        </ConfirmButton>
      </div>

      {expanded && (
        <div className="cat-body">
          <div className="form-row" style={{ marginBottom: 12 }}>
            <Field label="Your monthly contribution">
              {(id) => (
                <MoneyInput
                  id={id}
                  valueCents={account.monthlyContributionCents}
                  onCommit={(monthlyContributionCents) =>
                    updateAccount(account.id, { monthlyContributionCents })
                  }
                />
              )}
            </Field>
            <Field label="Employer match / month" hint="Counts toward FI, not your savings rate">
              {(id) => (
                <MoneyInput
                  id={id}
                  valueCents={account.employerMatchCents ?? 0}
                  onCommit={(employerMatchCents) =>
                    updateAccount(account.id, { employerMatchCents })
                  }
                />
              )}
            </Field>
            <Field label="Tax treatment">
              {(id) => (
                <select
                  id={id}
                  value={account.taxTreatment}
                  onChange={(e) =>
                    updateAccount(account.id, { taxTreatment: e.target.value as TaxTreatment })
                  }
                >
                  {(Object.keys(TAX_LABELS) as TaxTreatment[]).map((t) => (
                    <option key={t} value={t}>
                      {TAX_LABELS[t]}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>

          {account.link && (
            <p className="field-hint" style={{ margin: '0 0 10px' }}>
              Holdings below come from {account.link.institution} and are replaced on each sync —
              edits to them will not survive. The contribution, match and tax treatment above are
              yours and are always kept.
            </p>
          )}

          {account.holdings.length === 0 ? (
            <p className="muted" style={{ fontSize: 13, margin: '0 0 10px' }}>
              No holdings yet. Add one, or just record the account's total value as a single
              placeholder holding.
            </p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Asset class</th>
                    <th className="num">Shares</th>
                    <th className="num">Price</th>
                    <th className="num">Cost basis</th>
                    <th className="num">Value</th>
                    <th className="num">Return</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {account.holdings.map((h) => {
                    const returnBps = holdingReturnBps(h);
                    return (
                      <tr key={h.id}>
                        <td style={{ minWidth: 96 }}>
                          <input
                            type="text"
                            value={h.symbol}
                            placeholder="VTI"
                            aria-label="Symbol"
                            style={{ textTransform: 'uppercase' }}
                            onChange={(e) =>
                              updateHolding(account.id, h.id, { symbol: e.target.value.toUpperCase() })
                            }
                          />
                        </td>
                        <td>
                          <select
                            value={h.assetClass}
                            aria-label="Asset class"
                            style={{ padding: '3px 6px', fontSize: 13 }}
                            onChange={(e) =>
                              updateHolding(account.id, h.id, {
                                assetClass: e.target.value as AssetClass,
                              })
                            }
                          >
                            {ASSET_CLASS_ORDER.map((c) => (
                              <option key={c} value={c}>
                                {ASSET_CLASS_LABELS[c]}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="num" style={{ width: 92 }}>
                          <input
                            className="input-money"
                            type="text"
                            inputMode="decimal"
                            value={h.shares}
                            aria-label="Shares"
                            onChange={(e) => {
                              const shares = Number(e.target.value);
                              if (Number.isFinite(shares)) {
                                updateHolding(account.id, h.id, { shares });
                              }
                            }}
                          />
                        </td>
                        <td className="num" style={{ width: 104 }}>
                          <MoneyInput
                            valueCents={h.priceCents}
                            ariaLabel="Price per share"
                            onCommit={(priceCents) => updateHolding(account.id, h.id, { priceCents })}
                          />
                        </td>
                        <td className="num" style={{ width: 112 }}>
                          <MoneyInput
                            valueCents={h.costBasisCents}
                            ariaLabel="Total cost basis"
                            onCommit={(costBasisCents) =>
                              updateHolding(account.id, h.id, { costBasisCents })
                            }
                          />
                        </td>
                        <td className="num mono-num">{fmt(holdingValue(h))}</td>
                        <td
                          className="num mono-num"
                          style={{
                            color:
                              h.costBasisCents === 0
                                ? 'var(--text-muted)'
                                : returnBps >= 0
                                  ? 'var(--good-text)'
                                  : 'var(--critical)',
                          }}
                        >
                          {h.costBasisCents === 0
                            ? '—'
                            : `${returnBps >= 0 ? '+' : ''}${bpsToPercent(returnBps).toFixed(1)}%`}
                        </td>
                        <td className="num">
                          <ConfirmButton
                            className="btn btn-sm btn-ghost"
                            confirmLabel="Delete"
                            onConfirm={() => removeHolding(account.id, h.id)}
                          >
                            ✕
                          </ConfirmButton>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <button
            type="button"
            className="btn btn-sm"
            style={{ marginTop: 10 }}
            onClick={() => addHolding(account.id)}
          >
            + Add holding
          </button>
        </div>
      )}
    </div>
  );
}

export default function InvestmentsPage({ onNavigate }: { onNavigate: (view: View) => void }) {
  const data = useStore((s) => s.data);
  const {
    addAccount,
    addOtherAsset,
    updateOtherAsset,
    removeOtherAsset,
    addLiability,
    updateLiability,
    removeLiability,
  } = useStore();
  const fmt = useFormatMoney();

  const [targets, setTargets] = useState<Partial<Record<AssetClass, number>>>(DEFAULT_TARGETS);

  const portfolio = useMemo(() => summarizePortfolio(data.accounts), [data.accounts]);
  const netWorth = useMemo(
    () => computeNetWorth(data.accounts, data.otherAssets, data.liabilities),
    [data.accounts, data.otherAssets, data.liabilities],
  );

  const classSlices = useMemo(
    () =>
      foldToOther(
        portfolio.byAssetClass.map((c, i) => ({
          id: c.assetClass,
          label: ASSET_CLASS_LABELS[c.assetClass],
          valueCents: c.valueCents,
          color: slotColor(ASSET_CLASS_ORDER.indexOf(c.assetClass) >= 0 ? ASSET_CLASS_ORDER.indexOf(c.assetClass) : i),
        })),
      ),
    [portfolio],
  );

  const accountSlices = useMemo(
    () =>
      foldToOther(
        portfolio.byAccount.map((a, i) => ({
          id: a.id,
          label: a.name,
          valueCents: a.valueCents,
          color: slotColor(i),
        })),
      ),
    [portfolio],
  );

  const drift = useMemo(() => rebalancePlan(portfolio, targets), [portfolio, targets]);
  const targetTotalBps = Object.values(targets).reduce((sum, v) => sum + (v ?? 0), 0);

  const netWorthRows = [
    { label: 'Investments', valueCents: portfolio.totalValueCents, color: 'var(--series-1)' },
    ...(netWorth.nonFiAssetsCents > 0
      ? [{ label: 'Other assets', valueCents: netWorth.nonFiAssetsCents, color: 'var(--series-7)' }]
      : []),
    ...(netWorth.totalLiabilitiesCents > 0
      ? [{ label: 'Debt', valueCents: -netWorth.totalLiabilitiesCents, color: 'var(--series-8)' }]
      : []),
  ];

  return (
    <>
      <header className="page-header">
        <h1 className="page-title">Investments</h1>
        <p className="page-subtitle">
          Accounts, holdings and net worth. Prices are entered by hand — this app makes no network
          calls, so nothing here is quoted live.
        </p>
      </header>

      <div className="kpi-row">
        <StatTile label="Portfolio value" value={fmt(portfolio.totalValueCents)} sub={`${data.accounts.length} account${data.accounts.length === 1 ? '' : 's'}`} />
        <StatTile
          label="Unrealized gain"
          value={`${portfolio.totalGainCents >= 0 ? '+' : '−'}${fmt(Math.abs(portfolio.totalGainCents))}`}
          tone={portfolio.totalGainCents >= 0 ? 'good' : 'bad'}
          sub={
            portfolio.totalCostBasisCents > 0
              ? `${bpsToPercent(portfolio.totalReturnBps).toFixed(1)}% on cost basis`
              : 'Enter a cost basis to track return'
          }
        />
        <StatTile
          label="Net worth"
          value={fmt(netWorth.netWorthCents)}
          sub={`${fmt(netWorth.totalAssetsCents)} assets − ${fmt(netWorth.totalLiabilitiesCents)} debt`}
        />
        <StatTile
          label="Monthly investing"
          value={fmt(portfolio.monthlyContributionCents + portfolio.monthlyEmployerMatchCents)}
          sub={
            portfolio.monthlyEmployerMatchCents > 0
              ? `Includes ${fmt(portfolio.monthlyEmployerMatchCents)} employer match`
              : 'Across all accounts'
          }
        />
      </div>

      <div className="stack">
        <LinkedAccounts onNavigate={onNavigate} />

        {portfolio.blendedExpenseRatioBps > 0 && (
          <Callout tone={portfolio.blendedExpenseRatioBps > 50 ? 'warning' : 'neutral'}>
            Blended expense ratio{' '}
            <strong>{bpsToPercent(portfolio.blendedExpenseRatioBps).toFixed(2)}%</strong> — about{' '}
            <strong>{fmt(portfolio.annualFeeDragCents)}</strong> a year at today's balance.
            {portfolio.blendedExpenseRatioBps > 50 &&
              ' Above roughly 0.50% it is worth checking whether a cheaper index fund holds the same thing.'}
          </Callout>
        )}

        <Card
          title="Accounts"
          actions={
            <button type="button" className="btn btn-sm btn-primary" onClick={() => addAccount()}>
              + Add account
            </button>
          }
        >
          {data.accounts.length === 0 ? (
            <EmptyState icon="◫" title="No accounts yet">
              Add a 401(k), IRA or brokerage account to track your portfolio and drive the FI
              projection.
            </EmptyState>
          ) : (
            <div>
              {data.accounts.map((account) => (
                <AccountCard key={account.id} account={account} />
              ))}
            </div>
          )}
        </Card>

        {portfolio.totalValueCents > 0 && (
          <div className="grid grid-2">
            <ChartFrame
              title="Asset allocation"
              note="Share of the portfolio by asset class."
              table={<ShareTable slices={classSlices} totalCents={portfolio.totalValueCents} valueHeader="Value" />}
            >
              <StackedShareBar slices={classSlices} totalCents={portfolio.totalValueCents} />
            </ChartFrame>

            <ChartFrame
              title="Where it's held"
              note="Share of the portfolio by account."
              table={<ShareTable slices={accountSlices} totalCents={portfolio.totalValueCents} valueHeader="Value" />}
            >
              <StackedShareBar slices={accountSlices} totalCents={portfolio.totalValueCents} />
            </ChartFrame>
          </div>
        )}

        {portfolio.totalValueCents > 0 && (
          <ChartFrame
            title="Drift from your target mix"
            note={
              targetTotalBps === 10_000
                ? 'Positive means overweight — sell down or direct new money elsewhere.'
                : `Your targets add up to ${bpsToPercent(targetTotalBps).toFixed(1)}%, not 100%. Adjust them below.`
            }
            table={
              <MoneyTable
                columns={[
                  { label: 'Asset class' },
                  { label: 'Current', numeric: true },
                  { label: 'Target', numeric: true },
                  { label: 'Drift', numeric: true },
                ]}
                rows={drift.map((d) => ({
                  key: d.assetClass,
                  cells: [
                    ASSET_CLASS_LABELS[d.assetClass as AssetClass] ?? d.assetClass,
                    `${bpsToPercent(d.currentBps).toFixed(1)}%`,
                    `${bpsToPercent(d.targetBps).toFixed(1)}%`,
                    `${d.driftCents >= 0 ? '+' : '−'}${fmt(Math.abs(d.driftCents))}`,
                  ],
                }))}
              />
            }
          >
            <DriftChart
              rows={drift}
              labelFor={(key) => ASSET_CLASS_LABELS[key as AssetClass] ?? key}
            />
            <div
              className="form-row"
              style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}
            >
              {ASSET_CLASS_ORDER.map((c) => (
                <Field key={c} label={ASSET_CLASS_LABELS[c]}>
                  {(id) => (
                    <PercentInput
                      id={id}
                      valueBps={targets[c] ?? 0}
                      onCommit={(bps) => setTargets((t) => ({ ...t, [c]: bps }))}
                    />
                  )}
                </Field>
              ))}
            </div>
          </ChartFrame>
        )}

        <div className="grid grid-2">
          <Card
            title="Other assets"
            note="A house, a car, anything outside your investment accounts."
            actions={
              <button type="button" className="btn btn-sm" onClick={() => addOtherAsset()}>
                + Add
              </button>
            }
          >
            {data.otherAssets.length === 0 ? (
              <EmptyState icon="⌂" title="None recorded">
                Optional — these count toward net worth but not toward FI unless you say so.
              </EmptyState>
            ) : (
              <div className="stack-sm">
                {data.otherAssets.map((asset) => (
                  <div
                    key={asset.id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'minmax(90px, 1fr) 118px auto auto',
                      gap: 9,
                      alignItems: 'center',
                    }}
                  >
                    <input
                      type="text"
                      value={asset.name}
                      aria-label="Asset name"
                      onChange={(e) => updateOtherAsset(asset.id, { name: e.target.value })}
                    />
                    <MoneyInput
                      valueCents={asset.valueCents}
                      ariaLabel={`${asset.name} value`}
                      onCommit={(valueCents) => updateOtherAsset(asset.id, { valueCents })}
                    />
                    <label
                      className="field-hint"
                      style={{ display: 'flex', gap: 4, alignItems: 'center', whiteSpace: 'nowrap' }}
                      title="Include this asset in the portfolio that funds financial independence"
                    >
                      <input
                        type="checkbox"
                        checked={asset.countTowardFI}
                        onChange={(e) =>
                          updateOtherAsset(asset.id, { countTowardFI: e.target.checked })
                        }
                      />
                      Funds FI
                    </label>
                    <ConfirmButton
                      onConfirm={() => removeOtherAsset(asset.id)}
                      confirmLabel="Remove"
                    >
                      ✕
                    </ConfirmButton>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card
            title="Debts"
            note="Balances reduce net worth. High-rate debt usually beats investing."
            actions={
              <button type="button" className="btn btn-sm" onClick={() => addLiability()}>
                + Add
              </button>
            }
          >
            {data.liabilities.length === 0 ? (
              <EmptyState icon="⊖" title="No debt recorded">
                Nothing to subtract.
              </EmptyState>
            ) : (
              <div className="stack-sm">
                {data.liabilities.map((liability) => (
                  <div
                    key={liability.id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'minmax(90px, 1fr) 118px 76px auto',
                      gap: 9,
                      alignItems: 'center',
                    }}
                  >
                    <input
                      type="text"
                      value={liability.name}
                      aria-label="Debt name"
                      onChange={(e) => updateLiability(liability.id, { name: e.target.value })}
                    />
                    <MoneyInput
                      valueCents={liability.balanceCents}
                      ariaLabel={`${liability.name} balance`}
                      onCommit={(balanceCents) => updateLiability(liability.id, { balanceCents })}
                    />
                    <span className="alloc-input">
                      <PercentInput
                        valueBps={liability.aprBps}
                        max={100}
                        ariaLabel={`${liability.name} interest rate`}
                        onCommit={(aprBps) => updateLiability(liability.id, { aprBps })}
                      />
                      <span className="alloc-mode" aria-hidden="true">
                        %
                      </span>
                    </span>
                    <ConfirmButton
                      onConfirm={() => removeLiability(liability.id)}
                      confirmLabel="Remove"
                    >
                      ✕
                    </ConfirmButton>
                  </div>
                ))}
                {data.liabilities.some((l) => l.aprBps > percentToBps(6)) && (
                  <Callout tone="warning">
                    Some of this debt costs more than a portfolio is likely to earn. Paying it down
                    is usually the better return.
                  </Callout>
                )}
              </div>
            )}
          </Card>
        </div>

        {netWorthRows.length > 0 && netWorth.totalAssetsCents > 0 && (
          <ChartFrame
            title="Net worth composition"
            note={`Net worth ${fmt(netWorth.netWorthCents)}.`}
            table={
              <MoneyTable
                columns={[{ label: 'Component' }, { label: 'Amount', numeric: true }]}
                rows={netWorthRows.map((r) => ({
                  key: r.label,
                  cells: [r.label, fmt(r.valueCents)],
                }))}
                totalRow={['Net worth', fmt(netWorth.netWorthCents)]}
              />
            }
          >
            <NetWorthBars rows={netWorthRows} />
            {netWorth.fiAssetsCents < portfolio.totalValueCents && (
              <p className="field-hint" style={{ marginTop: 8 }}>
                Assets marked <em>Funds FI</em> are the only ones the FI projection compounds.
              </p>
            )}
          </ChartFrame>
        )}

        <Callout>
          <span style={{ color: STATUS.warning }}>Not investment advice.</span> These are your own
          numbers and your own assumptions, arithmetic applied to them. Expected returns are
          guesses, and real markets do not deliver a smooth annual percentage.
        </Callout>
      </div>
    </>
  );
}

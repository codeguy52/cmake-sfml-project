import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mapCash, mapPosition } from './snaptrade.js';

/**
 * The money-critical translation: SnapTrade's position shape into ours.
 *
 * The case that matters most is the contract multiplier. An equity option is
 * quoted per underlying share and held in contracts of 100, so getting this
 * wrong misstates the position — and the net worth built on it — by 100x in
 * one direction or the other. The fixtures below are shaped like the API's
 * documented response, with every number a string, as it actually sends them.
 */

describe('ordinary positions', () => {
  const vti = {
    instrument: {
      kind: 'etf',
      id: 'abc',
      symbol: 'VTI',
      raw_symbol: 'VTI',
      description: 'Vanguard Total Stock Market ETF',
      currency: 'USD',
    },
    units: '21.438',
    price: '310.50',
    cost_basis: '238.82',
    currency: 'USD',
  };

  test('reads units, price and symbol', () => {
    const position = mapPosition(vti);
    assert.equal(position.symbol, 'VTI');
    assert.equal(position.units, 21.438);
    assert.equal(position.priceCents, 31_050);
    assert.equal(position.currency, 'USD');
  });

  test('turns a per-share cost basis into a position total', () => {
    // 238.82 a share across 21.438 shares.
    assert.equal(mapPosition(vti).costBasisCents, toCents(238.82 * 21.438));
  });

  test('carries the instrument kind through as the asset-class hint', () => {
    assert.equal(mapPosition(vti).assetClassHint, 'etf');
  });

  test('keeps fractional units rather than rounding to whole shares', () => {
    assert.equal(mapPosition({ ...vti, units: '0.0137' }).units, 0.0137);
  });

  test('prefers the raw symbol, which is what a statement shows', () => {
    const position = mapPosition({
      ...vti,
      instrument: { ...vti.instrument, symbol: 'VTI.US', raw_symbol: 'VTI' },
    });
    assert.equal(position.symbol, 'VTI');
  });
});

describe('option contracts', () => {
  const call = {
    instrument: {
      kind: 'option',
      id: 'opt',
      symbol: 'AAPL  260116C00250000',
      description: 'AAPL Jan 16 2026 250 Call',
      option_type: 'CALL',
      strike_price: '250.00',
      expiration_date: '2026-01-16',
      // Standard equity option: 100 underlying shares per contract.
      multiplier: '100',
    },
    units: '2',
    price: '4.15',
    cost_basis: '3.80',
    currency: 'USD',
  };

  test('values a contract at price x multiplier, not price', () => {
    const position = mapPosition(call);
    // $4.15 a share x 100 shares a contract = $415 a contract.
    assert.equal(position.priceCents, 41_500);
    assert.equal(position.units, 2);
    // Two contracts are worth $830, not $8.30.
    assert.equal(Math.round(position.units * position.priceCents), 83_000);
  });

  test('applies the multiplier to cost basis too', () => {
    // $3.80 a share x 100 x 2 contracts = $760.
    assert.equal(mapPosition(call).costBasisCents, 76_000);
  });

  test('honours a mini option multiplier instead of assuming 100', () => {
    const mini = { ...call, instrument: { ...call.instrument, multiplier: '10' } };
    assert.equal(mapPosition(mini).priceCents, 4_150);
  });

  test('keeps units in contracts, as the statement reports them', () => {
    // Folding the multiplier into units would make the holding read "200
    // contracts" against a statement that says 2.
    assert.equal(mapPosition(call).units, 2);
  });

  test('flags an option whose multiplier is unusable rather than guessing', () => {
    const vague = { ...call, instrument: { ...call.instrument, multiplier: 'unknown' } };
    const position = mapPosition(vague);
    assert.equal(position.needsReview, true);
    // Falls back to 1x, which understates rather than inflating by 100x.
    assert.equal(position.priceCents, 415);
  });
});

describe('what it does with odd data', () => {
  test('a missing multiplier on a non-option is simply one-for-one', () => {
    const stock = {
      instrument: { kind: 'stock', symbol: 'F', description: 'Ford' },
      units: '100',
      price: '11.20',
    };
    const position = mapPosition(stock);
    assert.equal(position.priceCents, 1_120);
    assert.equal(position.needsReview, undefined);
  });

  test('marks a cash-equivalent position, which the cash balance also counts', () => {
    const mmf = {
      instrument: { kind: 'mutualfund', symbol: 'SPAXX', description: 'Fidelity Government MMF' },
      units: '1204',
      price: '1.00',
      cash_equivalent: true,
    };
    assert.equal(mapPosition(mmf).cashEquivalent, true);
  });

  test('survives a position with no price or units', () => {
    const position = mapPosition({ instrument: { kind: 'other', symbol: 'MYSTERY' } });
    assert.equal(position.units, 0);
    assert.equal(position.priceCents, 0);
    assert.equal(position.symbol, 'MYSTERY');
  });

  test('falls back to the instrument id when there is no symbol', () => {
    assert.equal(mapPosition({ instrument: { kind: 'other', id: 'xyz' } }).symbol, 'XYZ');
  });

  test('omits cost basis entirely when the brokerage does not report it', () => {
    const position = mapPosition({
      instrument: { kind: 'etf', symbol: 'VXUS' },
      units: '40',
      price: '60.12',
    });
    // Zero would read as a 100% gain on the whole position.
    assert.equal(position.costBasisCents, undefined);
  });
});

describe('cash balances', () => {
  test('sums only the account currency', () => {
    const { cashCents, warnings } = mapCash(
      [
        { currency: { code: 'USD' }, cash: '1204.00' },
        { currency: { code: 'CAD' }, cash: '500.00' },
      ],
      'USD',
    );
    assert.equal(cashCents, 120_400);
    assert.ok(warnings.some((w) => w.includes('CAD')));
  });

  test('says nothing when every balance is in the account currency', () => {
    const { cashCents, warnings } = mapCash([{ currency: { code: 'USD' }, cash: '10.00' }], 'USD');
    assert.equal(cashCents, 1_000);
    assert.deepEqual(warnings, []);
  });

  test('treats a missing balance list as no cash, not as an error', () => {
    assert.deepEqual(mapCash(undefined, 'USD'), { cashCents: 0, warnings: [] });
  });
});

/** Mirrors `toCents` so the expectations above read as money, not arithmetic. */
function toCents(amount) {
  return Math.round(amount * 100);
}

import { describe, expect, it } from 'vitest';
import { applyBps, parseMoney, roundCents, toBps } from './money';

describe('roundCents', () => {
  it('rounds half away from zero in both directions', () => {
    expect(roundCents(0.5)).toBe(1);
    expect(roundCents(-0.5)).toBe(-1);
    expect(roundCents(1.5)).toBe(2);
    expect(roundCents(-1.5)).toBe(-2);
  });
});

describe('applyBps', () => {
  it('applies a percentage without float drift', () => {
    expect(applyBps(100_00, 2000)).toBe(2000); // 20% of $100 is $20
    expect(applyBps(333_33, 3333)).toBe(11110);
  });

  it('is exact for the classic 0.1 + 0.2 case', () => {
    // 10% of $0.30 must be 3 cents, not 2.9999999999999996.
    expect(applyBps(30, 1000)).toBe(3);
  });
});

describe('toBps', () => {
  it('returns zero rather than dividing by zero', () => {
    expect(toBps(500, 0)).toBe(0);
  });

  it('round-trips a percentage', () => {
    expect(toBps(2500, 10_000)).toBe(2500); // $25 of $100 is 25%
  });
});

describe('parseMoney', () => {
  it('accepts the shapes people actually type', () => {
    expect(parseMoney('12')).toBe(1200);
    expect(parseMoney('12.5')).toBe(1250);
    expect(parseMoney('12.34')).toBe(1234);
    expect(parseMoney('$1,234.56')).toBe(123456);
    expect(parseMoney('  8.00  ')).toBe(800);
    expect(parseMoney('-4')).toBe(-400);
    expect(parseMoney('(4.00)')).toBe(-400);
  });

  it('rejects input with no number instead of returning zero', () => {
    expect(parseMoney('')).toBeNull();
    expect(parseMoney('abc')).toBeNull();
    expect(parseMoney('$')).toBeNull();
    expect(parseMoney('.')).toBeNull();
  });

  it('rounds sub-cent input to the nearest cent', () => {
    expect(parseMoney('1.005')).toBe(101);
    expect(parseMoney('1.004')).toBe(100);
  });
});

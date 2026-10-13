import { describe, expect, it } from 'vitest';
import { ImportError, importedValue, parseHoldingsFile } from './importHoldings';
import { mergeSnapshots } from './sync';
import type { InvestmentAccount } from '../../types';

/**
 * The sample files below are shaped like the real exports: preamble lines,
 * dollar signs, "n/a" cells, total rows, disclaimer footers and a second table
 * in the same file. Those are the things that break a naive parser, and each
 * one breaks it by producing a plausible wrong number rather than an error.
 */

const FIDELITY = `Account Number,Account Name,Symbol,Description,Quantity,Last Price,Last Price Change,Current Value,Cost Basis Total
X12345678,Individual,VTI,VANGUARD TOTAL STOCK MARKET ETF,21.438,$310.50,+$1.20,"$6,656.50","$5,120.00"
X12345678,Individual,SPAXX,FIDELITY GOVERNMENT MONEY MARKET,1204.00,$1.00,n/a,"$1,204.00",n/a
Z98765432,401(k),FXAIX,FIDELITY 500 INDEX FUND,84.2107,$182.44,-$0.31,"$15,363.20",n/a

"Brokerage services are provided by Fidelity Brokerage Services LLC."
"Date downloaded 09/09/2026"
`;

const SCHWAB = `"Positions for account Individual ...1102 as of 09/09/2026"

"Symbol","Description","Qty (Quantity)","Price","Mkt Val (Market Value)","Cost Basis"
"VOO","VANGUARD S&P 500 ETF","8.125","$512.40","$4,163.25","$3,800.00"
"AAPL 01/16/2026 250.00 C","CALL APPLE INC $250 EXP 01/16/26","2","$4.15","$830.00","--"
"Cash & Cash Investments","--","--","--","$61.04","--"
"Account Total","","","","$5,054.29",""
`;

const VANGUARD_TWO_TABLES = `Account Number,Investment Name,Symbol,Shares,Share Price,Total Value
12345,Vanguard Total Bond Market Index,BND,30,71.00,2130.00

Account Number,Trade Date,Symbol,Transaction Type,Shares,Share Price,Principal Amount
12345,09/01/2026,BND,Buy,10,71.00,-710.00
`;

const QFX = `OFXHEADER:100
DATA:OFXSGML

<OFX>
<INVSTMTMSGSRSV1><INVSTMTTRNRS><INVSTMTRS>
<INVACCTFROM><BROKERID>fidelity.com<ACCTID>X12345678</INVACCTFROM>
<INVPOSLIST>
<POSSTOCK><INVPOS><SECID><UNIQUEID>922908769<UNIQUEIDTYPE>CUSIP</SECID>
<HELDINACCT>CASH<POSTYPE>LONG<UNITS>21.438<UNITPRICE>310.50<MKTVAL>6656.50
</INVPOS></POSSTOCK>
<POSMF><INVPOS><SECID><UNIQUEID>315911750<UNIQUEIDTYPE>CUSIP</SECID>
<HELDINACCT>CASH<POSTYPE>LONG<UNITS>84.2107<UNITPRICE>182.44<MKTVAL>15363.20
</INVPOS></POSMF>
</INVPOSLIST>
<INVBAL><AVAILCASH>1204.00<MARGINBALANCE>0<SHORTBALANCE>0</INVBAL>
</INVSTMTRS></INVSTMTTRNRS></INVSTMTMSGSRSV1>
<SECLISTMSGSRSV1><SECLIST>
<STOCKINFO><SECINFO><SECID><UNIQUEID>922908769<UNIQUEIDTYPE>CUSIP</SECID>
<SECNAME>VANGUARD TOTAL STOCK MARKET ETF<TICKER>VTI</SECINFO></STOCKINFO>
<MFINFO><SECINFO><SECID><UNIQUEID>315911750<UNIQUEIDTYPE>CUSIP</SECID>
<SECNAME>FIDELITY 500 INDEX FUND<TICKER>FXAIX</SECINFO></MFINFO>
</SECLIST></SECLISTMSGSRSV1>
</OFX>
`;

describe('CSV imports', () => {
  it('splits one file into an account per account number', () => {
    const { snapshots } = parseHoldingsFile('Portfolio_Positions.csv', FIDELITY);
    expect(snapshots.map((s) => s.account.name)).toEqual(['Individual', '401(k)']);
  });

  it('identifies accounts by number, not by name, so a rename still matches', () => {
    const { snapshots } = parseHoldingsFile('Portfolio_Positions.csv', FIDELITY);
    expect(snapshots.map((s) => s.account.id)).toEqual(['x12345678', 'z98765432']);
  });

  it('leaves the institution for the user to name', () => {
    // A CSV almost never says who it came from, and the file name is a guess.
    const { snapshots } = parseHoldingsFile('Portfolio_Positions.csv', FIDELITY);
    expect(snapshots[0]!.account.institution).toBe('');
  });

  it('reads money with dollar signs and thousands separators as exact cents', () => {
    const { snapshots } = parseHoldingsFile('Portfolio_Positions.csv', FIDELITY);
    const vti = snapshots[0]!.positions[0]!;
    expect(vti.symbol).toBe('VTI');
    expect(vti.priceCents).toBe(31_050);
    expect(vti.units).toBeCloseTo(21.438, 4);
    expect(vti.costBasisCents).toBe(512_000);
  });

  it('treats "n/a" as absent rather than zero', () => {
    const { snapshots } = parseHoldingsFile('Portfolio_Positions.csv', FIDELITY);
    const fxaix = snapshots[1]!.positions[0]!;
    // A zero cost basis would read as a 100% gain on the whole position.
    expect(fxaix.costBasisCents).toBeUndefined();
  });

  it('ignores the disclaimer footer without counting it as data', () => {
    const { snapshots, errors } = parseHoldingsFile('Portfolio_Positions.csv', FIDELITY);
    expect(errors).toEqual([]);
    expect(snapshots.flatMap((s) => s.positions)).toHaveLength(3);
  });

  it('handles a preamble line above the header', () => {
    const { snapshots } = parseHoldingsFile('positions.csv', SCHWAB);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.positions[0]!.symbol).toBe('VOO');
  });

  it('keeps a description containing a comma in one cell', () => {
    const csv = 'Symbol,Description,Quantity,Price\nBRK.B,"BERKSHIRE HATHAWAY, INC CLASS B",3,412.10\n';
    const { snapshots } = parseHoldingsFile('positions.csv', csv);
    const position = snapshots[0]!.positions[0]!;
    expect(position.description).toBe('BERKSHIRE HATHAWAY, INC CLASS B');
    expect(position.units).toBe(3);
    expect(position.priceCents).toBe(41_210);
  });

  it('moves untickered cash into the account balance instead of inventing a holding', () => {
    const { snapshots } = parseHoldingsFile('positions.csv', SCHWAB);
    expect(snapshots[0]!.cashCents).toBe(61_04);
    expect(snapshots[0]!.positions.map((p) => p.symbol)).not.toContain('CASH & CASH INVESTMENTS');
  });

  it('drops the account total row rather than importing it as a position', () => {
    const { snapshots } = parseHoldingsFile('positions.csv', SCHWAB);
    expect(snapshots[0]!.positions.map((p) => p.symbol)).not.toContain('ACCOUNT TOTAL');
  });

  it('flags a position whose stated value disagrees with shares × price', () => {
    // The option is quoted per share but held in contracts of 100, so the
    // file's own value is 100x the arithmetic. Guessing which is right is
    // exactly what this must not do.
    const { snapshots, warnings } = parseHoldingsFile('positions.csv', SCHWAB);
    const option = snapshots[0]!.positions.find((p) => p.symbol.startsWith('AAPL'))!;
    expect(option.needsReview).toBe(true);
    expect(warnings.some((w) => w.includes('check it'))).toBe(true);
  });

  it('derives a price when the file gives only a market value', () => {
    const csv = 'Symbol,Description,Shares,Current Value\nVTI,Vanguard Total Stock,10,3105.00\n';
    const { snapshots } = parseHoldingsFile('positions.csv', csv);
    expect(snapshots[0]!.positions[0]!.priceCents).toBe(31_050);
  });

  it('imports a balance-only row as a lump sum and says so', () => {
    const csv = 'Investment Name,Symbol,Shares,Current Value\nStable Value Fund,SVF,,"12,000.00"\n';
    const { snapshots, warnings } = parseHoldingsFile('401k.csv', csv);
    const position = snapshots[0]!.positions[0]!;
    expect(position.units).toBe(1);
    expect(position.priceCents).toBe(1_200_000);
    expect(warnings.some((w) => w.includes('lump sum'))).toBe(true);
  });

  it('imports only the first table and reports the rest', () => {
    const { snapshots, warnings } = parseHoldingsFile('vanguard.csv', VANGUARD_TWO_TABLES);
    expect(snapshots[0]!.positions).toHaveLength(1);
    expect(snapshots[0]!.positions[0]!.symbol).toBe('BND');
    expect(warnings.some((w) => w.includes('further table'))).toBe(true);
  });

  it('reads tab-delimited exports', () => {
    const tsv = 'Symbol\tDescription\tQuantity\tPrice\nVTI\tVanguard Total Stock\t5\t310.50\n';
    const { snapshots } = parseHoldingsFile('positions.tsv', tsv);
    expect(snapshots[0]!.positions[0]!.priceCents).toBe(31_050);
  });

  it('names the account after the file when the export has no account column', () => {
    const csv = 'Symbol,Quantity,Price\nVTI,5,310.50\n';
    const { snapshots } = parseHoldingsFile('My_Roth_IRA.csv', csv);
    expect(snapshots[0]!.account.name).toBe('My Roth IRA');
  });
});

describe('refusing what it cannot read', () => {
  it('rejects an empty file', () => {
    expect(() => parseHoldingsFile('empty.csv', '   ')).toThrow(ImportError);
  });

  it('rejects a file with no holdings table', () => {
    const csv = 'Date,Merchant,Amount\n09/01/2026,Coffee,4.50\n';
    expect(() => parseHoldingsFile('transactions.csv', csv)).toThrow(/holdings table/i);
  });

  it('never reports success with nothing imported', () => {
    const csv = 'Symbol,Quantity,Price\nTotal,,\n';
    expect(() => parseHoldingsFile('positions.csv', csv)).toThrow(ImportError);
  });
});

describe('OFX and QFX', () => {
  it('resolves tickers through the security list', () => {
    const { snapshots, format } = parseHoldingsFile('download.qfx', QFX);
    expect(format).toBe('ofx');
    expect(snapshots[0]!.positions.map((p) => p.symbol)).toEqual(['VTI', 'FXAIX']);
  });

  it('reads units, price and cash', () => {
    const { snapshots } = parseHoldingsFile('download.qfx', QFX);
    const [vti] = snapshots[0]!.positions;
    expect(vti!.units).toBeCloseTo(21.438, 4);
    expect(vti!.priceCents).toBe(31_050);
    expect(snapshots[0]!.cashCents).toBe(120_400);
  });

  it('carries the institution and the last four of the account', () => {
    const { snapshots } = parseHoldingsFile('download.qfx', QFX);
    expect(snapshots[0]!.account.institution).toBe('fidelity.com');
    expect(snapshots[0]!.account.mask).toBe('5678');
  });

  it('rejects an OFX file with no investment statement', () => {
    expect(() => parseHoldingsFile('bank.ofx', '<OFX><BANKMSGSRSV1></BANKMSGSRSV1></OFX>')).toThrow(
      ImportError,
    );
  });
});

describe('what an import is worth', () => {
  it('totals positions and cash in whole cents', () => {
    const { snapshots } = parseHoldingsFile('Portfolio_Positions.csv', FIDELITY);
    const total = importedValue(snapshots);
    expect(Number.isInteger(total)).toBe(true);
    // 21.438 × $310.50, the money-market fund at $1.00, and 84.2107 × $182.44
    // — each rounded to a cent at the position, not at the end.
    expect(total).toBe(665_650 + 120_400 + 1_536_340);
  });
});

describe('merging an import', () => {
  const existing = (): InvestmentAccount[] => [
    {
      id: 'acct-1',
      name: 'My Roth',
      kind: 'roth_ira',
      taxTreatment: 'roth',
      monthlyContributionCents: 50_000,
      holdings: [],
      link: {
        provider: 'file',
        providerAccountId: 'other-broker.csv',
        institution: 'Other broker',
        lastSyncedAt: 1,
      },
    },
  ];

  it('leaves accounts from a different file untouched', () => {
    const { snapshots } = parseHoldingsFile('vanguard.csv', VANGUARD_TWO_TABLES);
    const { accounts, summary } = mergeSnapshots(existing(), snapshots, 'file', 1000, {
      markMissing: false,
    });

    // One file is never evidence that another file's account is gone.
    expect(summary.missing).toEqual([]);
    expect(accounts[0]!.link!.missingSince).toBeUndefined();
    expect(accounts).toHaveLength(2);
  });

  it('keeps what the user owns when re-importing the same file', () => {
    const first = parseHoldingsFile('vanguard.csv', VANGUARD_TWO_TABLES).snapshots;
    const afterFirst = mergeSnapshots([], first, 'file', 1000, { markMissing: false }).accounts;

    const renamed = afterFirst.map((a) => ({
      ...a,
      name: 'Rollover IRA',
      nameOverridden: true,
      monthlyContributionCents: 60_000,
    }));

    const second = mergeSnapshots(renamed, first, 'file', 2000, { markMissing: false });
    const account = second.accounts[0]!;
    expect(account.name).toBe('Rollover IRA');
    expect(account.monthlyContributionCents).toBe(60_000);
    expect(account.link!.lastSyncedAt).toBe(2000);
  });
});

import { parseMoney, roundCents } from '../money';
import type { Cents } from '../../types';
import type { RemotePosition, RemoteSnapshot } from './types';

/**
 * Reading holdings out of a brokerage's own export.
 *
 * Every brokerage will hand you a positions file — CSV from the website, or
 * OFX/QFX from the "download to Quicken" button. That covers institutions no
 * aggregator reaches, most 401(k) providers among them, and it costs nothing,
 * needs no account, sends nothing anywhere and works on a plane.
 *
 * The output is `RemoteSnapshot[]` — the same shape the linking backend
 * returns — so an import goes through the identical merge rules as a live
 * sync: the file owns holdings and prices, the person owns contributions,
 * classification and any rename.
 *
 * The parsing is deliberately suspicious. Broker exports carry preamble
 * lines, disclaimer footers, total rows, several tables in one file, and
 * money formatted five different ways. Anything this cannot read confidently
 * is reported rather than guessed at, because a silently dropped position
 * understates a net worth and a silently misread one corrupts it.
 */

export interface ImportedFile {
  snapshots: RemoteSnapshot[];
  format: 'csv' | 'ofx';
  /** Things read, but worth a human look before trusting. */
  warnings: string[];
  /** Rows or sections that could not be read at all. */
  errors: string[];
  /** Data rows recognised as not being positions (totals, footers, blanks). */
  skippedRows: number;
}

export class ImportError extends Error {}

const CASH_HINT = /\bcash\b|money\s*market|sweep|settlement\s*fund/i;
const TOTAL_ROW = /^(account\s+)?(grand\s+)?totals?\b|^pending\s+activity|^subtotal/i;

/** Cells brokers use for "nothing here". */
const EMPTY_CELL = /^(|-+|n\/?a|--|not applicable|—)$/i;

function isEmptyCell(value: string | undefined): boolean {
  return value === undefined || EMPTY_CELL.test(value.trim());
}

/** Column synonyms, in the order brokers actually name them. */
const COLUMNS = {
  symbol: ['symbol', 'ticker', 'symbol/cusip', 'investment symbol', 'fund symbol', 'security id'],
  description: [
    'description',
    'security description',
    'security name',
    'investment name',
    'fund name',
    'name',
    'security',
    'investment',
  ],
  quantity: ['quantity', 'shares', 'units', 'share quantity', 'quantity owned', 'no of shares'],
  price: [
    'last price',
    'share price',
    'price per share',
    'current price',
    'closing price',
    'market price',
    'price',
    'last',
  ],
  value: [
    'current value',
    'market value',
    'total value',
    'position value',
    'ending value',
    'value',
    'market value $',
  ],
  costBasis: ['cost basis total', 'cost basis', 'total cost', 'purchase cost', 'cost'],
  // The number identifies the account across re-imports; the name is what a
  // person recognises. Kept apart so a file with both uses each for its job.
  account: ['account number', 'account #', 'account'],
  accountName: ['account name', 'registration', 'account description'],
  type: ['security type', 'asset class', 'investment type', 'type', 'category'],
} as const;

type ColumnName = keyof typeof COLUMNS;

/** Header cells vary in case, punctuation and stray currency marks. */
function normalizeHeader(cell: string): string {
  return cell
    .toLowerCase()
    .replace(/[($)#]/g, ' ')
    .replace(/[._/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Split one line of delimited text.
 *
 * Hand-rolled rather than regex-split because broker descriptions contain
 * commas inside quotes ("VANGUARD, INC") often enough that a naive split
 * shifts every column after it — the kind of error that produces plausible
 * wrong numbers rather than an obvious failure.
 */
function splitLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;

    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') quoted = true;
    else if (char === delimiter) {
      cells.push(cell.trim());
      cell = '';
    } else cell += char;
  }

  cells.push(cell.trim());
  return cells;
}

function chooseDelimiter(lines: string[]): string {
  const sample = lines.slice(0, 40).join('\n');
  const tabs = (sample.match(/\t/g) ?? []).length;
  const commas = (sample.match(/,/g) ?? []).length;
  const semis = (sample.match(/;/g) ?? []).length;
  if (tabs > commas && tabs > semis) return '\t';
  if (semis > commas) return ';';
  return ',';
}

/** Map header cells onto the columns we understand. */
function mapColumns(header: string[]): Partial<Record<ColumnName, number>> {
  const normalized = header.map(normalizeHeader);
  const found: Partial<Record<ColumnName, number>> = {};

  for (const [name, synonyms] of Object.entries(COLUMNS) as [ColumnName, readonly string[]][]) {
    // Exact matches first: "price" must not claim the "last price" column when
    // both exist, and "cost" must not swallow "cost basis".
    let index = normalized.findIndex((cell) => synonyms.includes(cell));
    if (index === -1) {
      index = normalized.findIndex((cell) =>
        synonyms.some((synonym) => cell.includes(synonym) && cell.length <= synonym.length + 12),
      );
    }
    if (index !== -1 && !Object.values(found).includes(index)) found[name] = index;
  }

  return found;
}

/** A row is a position row if it can yield a holding at all. */
function isPositionHeader(columns: Partial<Record<ColumnName, number>>): boolean {
  const hasIdentity = columns.symbol !== undefined || columns.description !== undefined;
  const hasNumbers = columns.quantity !== undefined && (columns.price !== undefined || columns.value !== undefined);
  return hasIdentity && hasNumbers;
}

/** Share counts, which are fractional far more often than people expect. */
function parseUnits(raw: string | undefined): number | null {
  if (isEmptyCell(raw)) return null;
  const cleaned = raw!.trim().replace(/[,\s]/g, '');
  const negated = /^\((.*)\)$/.exec(cleaned);
  const value = Number(negated ? `-${negated[1]}` : cleaned);
  return Number.isFinite(value) ? value : null;
}

function parseCents(raw: string | undefined): Cents | null {
  if (isEmptyCell(raw)) return null;
  return parseMoney(raw!);
}

interface RowContext {
  warnings: string[];
  label: string;
}

/**
 * Turn one row into a position.
 *
 * Price and market value are cross-checked whenever the file gives both: they
 * disagree when a price carries more precision than whole cents, and — the
 * case actually worth catching — when the row is an option quoted per share
 * but held in contracts of 100. Either way the position is flagged rather
 * than quietly folded into a total.
 */
function positionFromRow(
  cells: string[],
  columns: Partial<Record<ColumnName, number>>,
  { warnings, label }: RowContext,
): RemotePosition | null {
  const cell = (name: ColumnName): string | undefined =>
    columns[name] === undefined ? undefined : cells[columns[name]!];

  const symbolRaw = (cell('symbol') ?? '').trim();
  const description = (cell('description') ?? '').trim();
  if (TOTAL_ROW.test(symbolRaw) || TOTAL_ROW.test(description)) return null;

  const units = parseUnits(cell('quantity'));
  const priceCents = parseCents(cell('price'));
  const valueCents = parseCents(cell('value'));

  if (units === null && valueCents === null) return null;
  if (!symbolRaw && !description) return null;

  const symbol = (symbolRaw || description).toUpperCase().slice(0, 40);

  // No share count but a value: the row is a lump sum (many 401(k) exports
  // report only a balance). Model it as a single unit priced at the balance,
  // which is exactly how uninvested cash is already handled.
  if (units === null || units === 0) {
    if (valueCents === null || valueCents === 0) return null;
    warnings.push(`${label}: ${symbol} has no share count — imported as a lump sum.`);
    return {
      symbol,
      ...(description ? { description } : {}),
      ...(cell('type') ? { assetClassHint: cell('type')! } : {}),
      units: 1,
      priceCents: valueCents,
      currency: 'USD',
    };
  }

  let price = priceCents;
  if (price === null) {
    if (valueCents === null) return null;
    price = roundCents(valueCents / units);
    if (price === 0 && valueCents !== 0) {
      warnings.push(
        `${label}: ${symbol} is priced below a cent per share, so its value cannot be ` +
          'represented exactly — check this position.',
      );
    }
  }

  const position: RemotePosition = {
    symbol,
    ...(description ? { description } : {}),
    ...(cell('type') ? { assetClassHint: cell('type')! } : {}),
    units,
    priceCents: price,
    currency: 'USD',
  };

  const costBasis = parseCents(cell('costBasis'));
  if (costBasis !== null) position.costBasisCents = costBasis;

  if (valueCents !== null) {
    const implied = roundCents(units * price);
    const drift = Math.abs(implied - valueCents);
    // A cent per share is ordinary rounding. Beyond that the file is saying
    // something this row's price does not explain.
    const tolerance = Math.max(2, Math.ceil(Math.abs(units)));
    if (drift > tolerance) {
      position.needsReview = true;
      warnings.push(
        `${label}: ${symbol} is listed at ${(valueCents / 100).toFixed(2)} but its shares × ` +
          `price come to ${(implied / 100).toFixed(2)} — check it (option contracts of 100 are ` +
          'the usual cause).',
      );
    }
  }

  return position;
}

interface AccountBucket {
  key: string;
  name: string;
  positions: RemotePosition[];
  cashCents: Cents;
  warnings: string[];
}

/** Group rows by their account column, or into one bucket when there isn't one. */
function bucketFor(
  buckets: Map<string, AccountBucket>,
  key: string,
  name: string,
): AccountBucket {
  const existing = buckets.get(key);
  if (existing) return existing;
  const bucket: AccountBucket = { key, name, positions: [], cashCents: 0, warnings: [] };
  buckets.set(key, bucket);
  return bucket;
}

function parseCsv(text: string, fallbackName: string): ImportedFile {
  const lines = text.split(/\r\n|\r|\n/);
  const delimiter = chooseDelimiter(lines);

  let headerIndex = -1;
  let columns: Partial<Record<ColumnName, number>> = {};

  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i]!.trim()) continue;
    const candidate = mapColumns(splitLine(lines[i]!, delimiter));
    if (isPositionHeader(candidate)) {
      headerIndex = i;
      columns = candidate;
      break;
    }
  }

  if (headerIndex === -1) {
    throw new ImportError(
      'No holdings table found in this file. It needs a header row naming at least a symbol ' +
        'or description, a quantity, and a price or value.',
    );
  }

  const buckets = new Map<string, AccountBucket>();
  const warnings: string[] = [];
  const errors: string[] = [];
  let skippedRows = 0;
  let ended = false;
  let laterSections = 0;

  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const line = lines[i]!;

    if (!line.trim()) {
      // A blank line ends the table. Brokers put disclaimers, and sometimes a
      // second table entirely, below it.
      if (buckets.size > 0) ended = true;
      continue;
    }

    if (ended) {
      const candidate = mapColumns(splitLine(line, delimiter));
      if (isPositionHeader(candidate)) laterSections += 1;
      continue;
    }

    const cells = splitLine(line, delimiter);
    // A short row is a footnote, not data.
    if (cells.length < Math.max(2, Object.keys(columns).length - 2)) {
      skippedRows += 1;
      continue;
    }

    const cellAt = (name: ColumnName): string =>
      columns[name] === undefined ? '' : (cells[columns[name]!] ?? '').trim();

    // Identity comes from the account number where there is one, so next
    // month's export lands on the same account even if it has been renamed.
    const key = (cellAt('account') || fallbackName).toLowerCase();
    const displayName = cellAt('accountName') || cellAt('account') || fallbackName;
    const bucket = bucketFor(buckets, key, displayName);

    let position: RemotePosition | null;
    try {
      position = positionFromRow(cells, columns, { warnings: bucket.warnings, label: bucket.name });
    } catch {
      errors.push(`Could not read line ${i + 1}: ${line.slice(0, 80)}`);
      continue;
    }

    if (!position) {
      skippedRows += 1;
      continue;
    }

    // Cash without a ticker belongs in the account's cash balance rather than
    // masquerading as a holding called "CASH & CASH INVESTMENTS".
    const looksLikeCash = CASH_HINT.test(position.symbol) && !/^[A-Z]{1,5}$/.test(position.symbol);
    if (looksLikeCash) {
      bucket.cashCents += roundCents(position.units * position.priceCents);
      continue;
    }

    bucket.positions.push(position);
  }

  if (laterSections > 0) {
    warnings.push(
      `${laterSections} further table${laterSections === 1 ? '' : 's'} in this file ` +
        'were ignored — only the first holdings table is imported.',
    );
  }

  return {
    // A CSV almost never names the institution it came from, and the file name
    // is a poor guess. Left blank for the user to fill in on review.
    snapshots: snapshotsFrom(buckets, ''),
    format: 'csv',
    warnings: [...warnings, ...[...buckets.values()].flatMap((b) => b.warnings)],
    errors,
    skippedRows,
  };
}

function snapshotsFrom(buckets: Map<string, AccountBucket>, institution: string): RemoteSnapshot[] {
  return [...buckets.values()]
    .filter((bucket) => bucket.positions.length > 0 || bucket.cashCents !== 0)
    .map((bucket) => {
      const positions = bucket.positions.reduce(
        (sum, p) => sum + roundCents(p.units * p.priceCents),
        0,
      );
      return {
        account: {
          id: bucket.key,
          name: bucket.name,
          institution,
          balanceCents: positions + bucket.cashCents,
          currency: 'USD',
        },
        positions: bucket.positions,
        ...(bucket.cashCents !== 0 ? { cashCents: bucket.cashCents } : {}),
      };
    });
}

/** Pull the first value of an OFX element. Works for both SGML and XML forms. */
function ofxValue(block: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i').exec(block);
  return match?.[1]?.trim() || undefined;
}

function ofxBlocks(text: string, tag: string): string[] {
  const blocks: string[] = [];
  const open = new RegExp(`<${tag}>`, 'gi');
  let match: RegExpExecArray | null;

  while ((match = open.exec(text)) !== null) {
    const start = match.index + match[0].length;
    const close = new RegExp(`</${tag}>`, 'i').exec(text.slice(start));
    blocks.push(close ? text.slice(start, start + close.index) : text.slice(start));
  }

  return blocks;
}

/**
 * OFX/QFX — the format behind every "download to Quicken" button.
 *
 * Positions reference securities by id, with the tickers listed separately, so
 * the security list is read first and used as a lookup. OFX 1.x is SGML with
 * unclosed tags, which is why values are read per-element rather than by
 * parsing a document tree.
 */
function parseOfx(text: string, fallbackName: string): ImportedFile {
  const securities = new Map<string, { ticker?: string; name?: string }>();
  for (const block of ofxBlocks(text, '\\w*SECINFO')) {
    const id = ofxValue(block, 'UNIQUEID');
    if (!id) continue;
    securities.set(id, { ticker: ofxValue(block, 'TICKER'), name: ofxValue(block, 'SECNAME') });
  }

  const warnings: string[] = [];
  const snapshots: RemoteSnapshot[] = [];
  let skippedRows = 0;

  const statements = ofxBlocks(text, 'INVSTMTRS');
  if (statements.length === 0) {
    throw new ImportError('This OFX file has no investment statement in it.');
  }

  for (const statement of statements) {
    const accountId = ofxValue(statement, 'ACCTID') ?? fallbackName;
    const institution = ofxValue(statement, 'BROKERID') ?? fallbackName;
    const positions: RemotePosition[] = [];

    for (const list of ofxBlocks(statement, 'INVPOSLIST')) {
      for (const holding of ofxBlocks(list, 'INVPOS')) {
        const id = ofxValue(holding, 'UNIQUEID');
        const units = Number(ofxValue(holding, 'UNITS') ?? '');
        const price = parseMoney(ofxValue(holding, 'UNITPRICE') ?? '');

        if (!id || !Number.isFinite(units) || price === null) {
          skippedRows += 1;
          continue;
        }

        const security = securities.get(id);
        const symbol = (security?.ticker ?? security?.name ?? id).toUpperCase().slice(0, 40);
        const marketValue = parseMoney(ofxValue(holding, 'MKTVAL') ?? '');

        const position: RemotePosition = {
          symbol,
          ...(security?.name ? { description: security.name } : {}),
          units,
          priceCents: price,
          currency: ofxValue(holding, 'CURSYM') ?? 'USD',
        };

        if (marketValue !== null) {
          const drift = Math.abs(roundCents(units * price) - marketValue);
          if (drift > Math.max(2, Math.ceil(Math.abs(units)))) {
            position.needsReview = true;
            warnings.push(
              `${accountId}: ${symbol} is listed at ${(marketValue / 100).toFixed(2)} but its ` +
                'shares × price do not agree — check it.',
            );
          }
        }

        positions.push(position);
      }
    }

    const cash = parseMoney(ofxValue(statement, 'AVAILCASH') ?? '') ?? 0;
    if (positions.length === 0 && cash === 0) continue;

    const positionValue = positions.reduce((sum, p) => sum + roundCents(p.units * p.priceCents), 0);
    snapshots.push({
      account: {
        id: accountId,
        name: `${institution} ${accountId.slice(-4)}`.trim(),
        institution,
        ...(accountId.length >= 4 ? { mask: accountId.slice(-4) } : {}),
        balanceCents: positionValue + cash,
        currency: 'USD',
      },
      positions,
      ...(cash !== 0 ? { cashCents: cash } : {}),
    });
  }

  return { snapshots, format: 'ofx', warnings, errors: [], skippedRows };
}

/** A file name makes a better default account name than "Imported". */
export function baseName(fileName: string): string {
  const withoutPath = fileName.split(/[\\/]/).pop() ?? fileName;
  const withoutExtension = withoutPath.replace(/\.[a-z0-9]+$/i, '');
  return withoutExtension.replace(/[_-]+/g, ' ').trim() || 'Imported account';
}

/**
 * Read a brokerage export.
 *
 * Throws `ImportError` with something a person can act on when the file isn't
 * one — an unreadable file must never come back as an empty, successful import.
 */
export function parseHoldingsFile(fileName: string, text: string): ImportedFile {
  if (!text.trim()) throw new ImportError('That file is empty.');

  const looksOfx = /<OFX>/i.test(text) || /OFXHEADER/i.test(text);
  const result = looksOfx ? parseOfx(text, baseName(fileName)) : parseCsv(text, baseName(fileName));

  if (result.snapshots.length === 0) {
    throw new ImportError(
      'No positions could be read from this file. If it is a transaction history rather than a ' +
        'positions export, try the holdings download instead.',
    );
  }

  return result;
}

/** Total value of everything an import would bring in, for the review screen. */
export function importedValue(snapshots: RemoteSnapshot[]): Cents {
  return snapshots.reduce(
    (sum, snapshot) =>
      sum +
      snapshot.positions.reduce((s, p) => s + roundCents(p.units * p.priceCents), 0) +
      (snapshot.cashCents ?? 0),
    0,
  );
}

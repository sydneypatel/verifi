import type { Quarter } from '../../types';
import type { ReleaseReader, ReleaseReading } from '../../llm/types';
import { SecClient, filingUrl, type FilingFile } from './client';
import type { FigureMetric } from '../../types';
import { DAY, toTime, type Series, type SeriesPeriod } from './series';

// Companies announce earnings in a press release (Form 8-K, Item 2.02, Exhibit 99.1)
// weeks before the 10-Q or 10-K that carries the structured numbers. Until that
// filing lands, the newest quarter exists only in the release. This file finds
// the release, has the LLM read three figures from it, and then checks in code
// that every figure is printed in the release, so a misread number is dropped
// instead of shown.

export interface EarningsRelease {
  accession: string;
  filed: string;
  /** The exhibit the figures were read from. */
  url: string;
  /** End of the quarter the release reports. */
  periodEnd: string;
  fiscalYear: number | null;
  fiscalQuarter: Quarter | null;
  revenue: { current: number; prior: number | null } | null;
  netIncome: { current: number; prior: number | null } | null;
  eps: { current: number; prior: number | null } | null;
}

export interface EarningsReleases {
  /** The latest earnings release filed after `after` (an ISO date), or null. Never throws. */
  latest(cik: number, after: string): Promise<EarningsRelease | null>;
}

const MAX_RELEASE_CHARS = 80_000;
const TTL_MS = 6 * 60 * 60 * 1000;

// ---------- HTML to text ----------

const ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', mdash: '—', ndash: '–', minus: '−', dollar: '$',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/** Press releases are HTML tables. Keep one table row per line, cells separated by spaces. */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(text)
    .replace(/[ \t   ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

// ---------- Verifying what the LLM read ----------

/** Whitespace, curly quotes and dash styles differ between the HTML and the model's copy. */
function squash(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/[\s ]+/g, '');
}

/** Every number printed in a snippet, signed: "(1,234)" and "-1,234" are negative. */
export function numbersIn(snippet: string): number[] {
  const out: number[] = [];
  for (const m of snippet.matchAll(/(\()?\s*([-−–])?\s*\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*(\))?/g)) {
    const value = Number(`${m[3]!.replace(/,/g, '')}${m[4] ?? ''}`);
    if (!Number.isFinite(value)) continue;
    const negative = (m[1] && m[5]) || m[2];
    out.push(negative ? -value : value);
  }
  return out;
}

const SCALES = [1, 1e3, 1e6, 1e9];

/** Is `value` (full dollars) one of the numbers in the snippet, at some table scale? */
export function printedIn(value: number, snippet: string, perShare: boolean): boolean {
  const loss = /\bloss/i.test(snippet);
  return numbersIn(snippet).some((n) => {
    // A loss can be printed as a plain number in a "Net loss" row.
    const signOk = Math.sign(n) === Math.sign(value) || (value < 0 && n > 0 && loss) || value === 0;
    if (!signOk) return false;
    const scales = perShare ? [1] : SCALES;
    return scales.some((k) => Math.abs(Math.abs(n) * k - Math.abs(value)) <= (perShare ? 0.005 : Math.abs(value) * 0.006));
  });
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** "October 26, 2025" -> "2025-10-26". Null for anything else. */
export function parseLongDate(text: string): string | null {
  const m = text.trim().match(/^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (!m) return null;
  const month = MONTHS.findIndex((name) => name.startsWith(m[1]!.toLowerCase()) && m[1]!.length >= 3);
  if (month === -1) return null;
  const day = Number(m[2]);
  if (day < 1 || day > 31) return null;
  return `${m[3]}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Keep only what the release actually prints. A figure survives when its quote
 * is copied from the release and the quote contains the figure. The period end
 * survives when its date words are in the release.
 */
export function verifyReading(text: string, reading: ReleaseReading): Omit<EarningsRelease, 'accession' | 'filed' | 'url'> | null {
  const haystack = squash(text);
  const quoted = (quote: string | null | undefined) => {
    const q = squash(quote ?? '');
    return q.length >= 6 && haystack.includes(q);
  };

  const dateText = reading.periodEndText ?? '';
  const periodEnd = parseLongDate(dateText);
  if (!periodEnd || !quoted(dateText)) return null;

  const figure = (f: ReleaseReading['revenue'], perShare: boolean) => {
    if (!f || typeof f.current !== 'number' || !Number.isFinite(f.current) || !quoted(f.quote)) return null;
    if (!printedIn(f.current, f.quote, perShare)) return null;
    const prior = typeof f.prior === 'number' && Number.isFinite(f.prior) && printedIn(f.prior, f.quote, perShare) ? f.prior : null;
    return { current: f.current, prior };
  };

  const revenue = figure(reading.revenue, false);
  const netIncome = figure(reading.netIncome, false);
  const eps = figure(reading.eps, true);
  if (!revenue && !netIncome && !eps) return null;

  const fq = reading.fiscalQuarter;
  return {
    periodEnd,
    fiscalYear: typeof reading.fiscalYear === 'number' && reading.fiscalYear >= 1990 && reading.fiscalYear <= 2100 ? reading.fiscalYear : null,
    fiscalQuarter: fq === 1 || fq === 2 || fq === 3 || fq === 4 ? fq : null,
    revenue,
    netIncome,
    eps,
  };
}

// ---------- Finding the release ----------

/** Exhibit 99.1 goes by many file names: ex99-1.htm, ex991.htm, a8-kex991q3.htm, exhibit991.htm, dex991.htm. */
export function pickExhibit(files: FilingFile[]): string | null {
  const docs = files.map((f) => f.name).filter((n) => /\.(htm|html|txt)$/i.test(n) && !/index/i.test(n));
  const ex99 = docs.filter((n) => /(ex|exh|exhibit)[-_.]?99/i.test(n));
  const first = ex99.find((n) => /99[-_.]?0?1(?!\d)/i.test(n)) ?? ex99.find((n) => !/99[-_.]?0?[2-9]/i.test(n)) ?? ex99[0];
  return first ?? null;
}

export function createEarningsReleases({ sec, reader }: { sec: SecClient; reader: ReleaseReader }): EarningsReleases {
  // Two caches: which 8-K is the latest release (per company), and what it says (per filing).
  // The second is only filled when a release is newer than the 10-Q or 10-K on file.
  const latestMeta = new Map<number, { at: number; value: Promise<{ accession: string; filed: string } | null> }>();
  const readings = new Map<string, { at: number; value: Promise<EarningsRelease | null> }>();

  const remember = <K, V>(map: Map<K, { at: number; value: Promise<V> }>, key: K, make: () => Promise<V>): Promise<V> => {
    const hit = map.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    const value = make();
    map.set(key, { at: Date.now(), value });
    value.catch(() => map.delete(key));
    if (map.size > 100) map.delete(map.keys().next().value!);
    return value;
  };

  async function findLatest(cik: number): Promise<{ accession: string; filed: string } | null> {
    const recent = (await sec.getSubmissions(cik))?.filings?.recent;
    if (!recent) return null;
    // Newest first. The first 8-K with Item 2.02 ("Results of Operations") is the latest release.
    const i = recent.form.findIndex(
      (form, k) => form === '8-K' && (recent.items?.[k] ?? '').split(',').map((item) => item.trim()).includes('2.02'),
    );
    return i === -1 ? null : { accession: recent.accessionNumber[i]!, filed: recent.filingDate[i]! };
  }

  async function readRelease(cik: number, accession: string, filed: string): Promise<EarningsRelease | null> {
    const exhibit = pickExhibit(await sec.getFilingFiles(cik, accession));
    if (!exhibit) return null;
    const url = `${filingUrl(cik, accession)}${exhibit}`;
    const raw = await sec.getDocument(url);
    if (!raw) return null;

    const text = (/<[a-z][\s\S]*>/i.test(raw) ? htmlToText(raw) : raw).slice(0, MAX_RELEASE_CHARS);
    const reading = await reader.read(text);
    const verified = reading ? verifyReading(text, reading) : null;
    return verified ? { ...verified, accession, filed, url } : null;
  }

  return {
    async latest(cik, after) {
      // A missing or unreadable release never fails a check: the filings still answer.
      try {
        const meta = await remember(latestMeta, cik, () => findLatest(cik));
        // Already covered by a 10-Q or 10-K, whose structured data is better.
        if (!meta || meta.filed <= after) return null;
        const release = await remember(readings, meta.accession, () => readRelease(cik, meta.accession, meta.filed));
        // A release about a quarter older than what is on file adds nothing.
        if (!release || (after && toTime(release.periodEnd) <= toTime(after) - 150 * DAY)) return null;
        return release;
      } catch (error) {
        console.error('Earnings release lookup failed', error);
        return null;
      }
    },
  };
}

// ---------- Merging into a series ----------

const iso = (time: number) => new Date(time).toISOString().slice(0, 10);

/**
 * Put the release's quarter at the front of a filed series, when it is newer
 * than anything filed. Also adds the year-earlier quarter from the release if
 * the filings lack it, so growth can still be worked out.
 */
export function withRelease(series: Series, release: EarningsRelease | null | undefined, metric: FigureMetric): Series {
  // Releases are read for revenue and net income only.
  const figure = metric === 'revenue' ? release?.revenue : metric === 'net_income' ? release?.netIncome : null;
  if (!release || !figure) return series;

  const end = toTime(release.periodEnd);
  const newestFiled = series.quarters[0];
  if (newestFiled && end - toTime(newestFiled.end) < 45 * DAY) return series;

  // The quarter starts the day after the previous one ended, if that is on file.
  const previous = series.quarters.find((q) => {
    const gap = (end - toTime(q.end)) / DAY;
    return gap >= 80 && gap <= 100;
  });
  const start = previous ? iso(toTime(previous.end) + DAY) : iso(end - 90 * DAY);

  const base = { kind: 'quarter' as const, derived: false, accession: release.accession, form: '8-K', filed: release.filed, url: release.url };
  const current: SeriesPeriod = { ...base, start, end: release.periodEnd, value: figure.current, fiscalYear: release.fiscalYear, fiscalQuarter: release.fiscalQuarter };

  const quarters = [current, ...series.quarters];
  const yearAgoEnd = end - 365 * DAY;
  const hasYearAgo = series.quarters.some((q) => Math.abs(toTime(q.end) - yearAgoEnd) <= 20 * DAY);
  if (!hasYearAgo && figure.prior !== null) {
    quarters.push({
      ...base,
      start: iso(toTime(start) - 365 * DAY),
      end: iso(yearAgoEnd),
      value: figure.prior,
      fiscalYear: release.fiscalYear ? release.fiscalYear - 1 : null,
      fiscalQuarter: release.fiscalQuarter,
    });
    quarters.sort((a, b) => (a.end < b.end ? 1 : a.end > b.end ? -1 : 0));
  }
  return { ...series, quarters };
}

/** The date of the newest 10-Q or 10-K behind a series. Releases filed before it are already covered. */
export function newestFiling(series: Series): string {
  return [...series.quarters, ...series.years].reduce((max, p) => (p.form !== '8-K' && p.filed > max ? p.filed : max), '');
}

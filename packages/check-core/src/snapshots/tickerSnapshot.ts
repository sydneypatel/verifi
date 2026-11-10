import type { FinnhubClient } from '../sources/finnhub/client';
import { SecClient, filingUrl } from '../sources/sec/client';

// The daily card for a followed ticker: today's price, the next and last
// earnings, and new SEC filings. Each part loads on its own, so one source
// being down still leaves the rest of the card.

export interface TickerFiling {
  form: string;
  /** Plain words: "Earnings release", "Quarterly report", "Leadership change". */
  label: string;
  filed: string;
  url: string;
}

export interface TickerSnapshot {
  ticker: string;
  name: string | null;
  /** When the price was read (ISO timestamp). */
  priceAt: string | null;
  price: number | null;
  dayChangePercent: number | null;
  marketCap: number | null;
  nextEarnings: { date: string; timing: 'before_open' | 'after_close' | null } | null;
  lastEarnings: {
    /** "Fiscal Q2 2027", or "Quarter ended Sep 30, 2026" when there is no fiscal label. */
    label: string;
    actual: number;
    estimate: number | null;
    outcome: 'beat' | 'miss' | 'in_line' | null;
  } | null;
  /** Newest first, from the last 45 days. */
  filings: TickerFiling[];
  /** Parts that could not be loaded right now. */
  unavailable: Array<'market' | 'earnings' | 'filings'>;
}

export const MAX_SNAPSHOT_TICKERS = 12;
const CACHE_MS = 10 * 60 * 1000;
const FILING_DAYS = 45;
const MAX_FILINGS = 5;

// 8-K item numbers, in the words a reader would use. The first item that has a label wins.
const ITEM_LABELS: Array<[string, string]> = [
  ['2.02', 'Earnings release'],
  ['5.02', 'Leadership change'],
  ['2.01', 'Acquisition or sale'],
  ['1.01', 'Major agreement'],
  ['1.02', 'Agreement ended'],
  ['2.05', 'Restructuring'],
  ['2.06', 'Write-down'],
  ['3.01', 'Exchange listing notice'],
  ['4.02', 'Restated results'],
  ['5.07', 'Shareholder vote'],
  ['7.01', 'Company announcement'],
  ['8.01', 'Company announcement'],
];

export function filingLabel(form: string, items: string): string {
  const base = form.replace(/\/A$/, '');
  const amended = form.endsWith('/A') ? ' (amended)' : '';
  if (base === '10-Q') return `Quarterly report${amended}`;
  if (base === '10-K') return `Annual report${amended}`;
  const list = items.split(',').map((i) => i.trim());
  const hit = ITEM_LABELS.find(([item]) => list.includes(item));
  return `${hit ? hit[1] : 'Current report'}${amended}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const iso = (date: Date) => date.toISOString().slice(0, 10);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export interface TickerSnapshots {
  get(tickers: string[]): Promise<TickerSnapshot[]>;
}

export function createTickerSnapshots({ sec, finnhub, now = () => new Date() }: { sec: SecClient; finnhub: FinnhubClient | null; now?: () => Date }): TickerSnapshots {
  const cache = new Map<string, { at: number; value: Promise<TickerSnapshot> }>();

  async function market(ticker: string) {
    if (!finnhub) return null;
    const [quote, profile] = await Promise.all([finnhub.quote(ticker), finnhub.profile(ticker)]);
    if (!quote?.c && !profile?.name) return null;
    const cap = num(profile?.marketCapitalization);
    return {
      name: profile?.name || null,
      price: quote?.c ? quote.c : null,
      dayChangePercent: quote?.c ? num(quote.dp) : null,
      priceAt: quote?.t ? new Date(quote.t * 1000).toISOString() : null,
      marketCap: cap === null ? null : cap * 1e6,
    };
  }

  async function earnings(ticker: string) {
    if (!finnhub) return null;
    const today = now();
    const [history, upcoming] = await Promise.all([
      finnhub.earnings(ticker),
      finnhub.earningsCalendar(ticker, iso(today), iso(new Date(today.getTime() + 100 * 86_400_000))).catch(() => []),
    ]);
    const next = upcoming.filter((r) => typeof r.date === 'string' && r.date >= iso(today)).sort((a, b) => (a.date < b.date ? -1 : 1))[0];
    const last = [...history].filter((r) => num(r.actual) !== null).sort((a, b) => (a.period < b.period ? 1 : -1))[0];
    let lastEarnings: TickerSnapshot['lastEarnings'] = null;
    if (last) {
      const actual = last.actual!;
      const estimate = num(last.estimate);
      const diff = estimate === null ? null : actual - estimate;
      const q = last.quarter;
      // Finnhub's period date is approximate for non-calendar fiscal years, so the fiscal label goes first.
      const label =
        q >= 1 && q <= 4 && last.year
          ? `Fiscal Q${q} ${last.year}`
          : `Quarter ended ${MONTHS[Number(last.period.slice(5, 7)) - 1]} ${Number(last.period.slice(8))}, ${last.period.slice(0, 4)}`;
      lastEarnings = { label, actual, estimate, outcome: diff === null ? null : Math.abs(diff) < 0.005 ? 'in_line' : diff > 0 ? 'beat' : 'miss' };
    }
    return {
      nextEarnings: next ? { date: next.date, timing: next.hour === 'bmo' ? ('before_open' as const) : next.hour === 'amc' ? ('after_close' as const) : null } : null,
      lastEarnings,
    };
  }

  async function filings(ticker: string): Promise<TickerFiling[]> {
    const company = await sec.lookupTicker(ticker);
    if (!company) return [];
    const recent = (await sec.getSubmissions(company.cik))?.filings?.recent;
    if (!recent) return [];
    const since = iso(new Date(now().getTime() - FILING_DAYS * 86_400_000));
    const out: TickerFiling[] = [];
    for (let i = 0; i < recent.form.length && out.length < MAX_FILINGS; i++) {
      const form = recent.form[i]!;
      const filed = recent.filingDate[i]!;
      if (filed < since) break; // newest first
      if (!/^(10-Q|10-K|8-K)(\/A)?$/.test(form)) continue;
      const accession = recent.accessionNumber[i]!;
      const doc = recent.primaryDocument?.[i];
      out.push({ form, label: filingLabel(form, recent.items?.[i] ?? ''), filed, url: `${filingUrl(company.cik, accession)}${doc ?? ''}` });
    }
    return out;
  }

  async function build(ticker: string): Promise<TickerSnapshot> {
    const unavailable: TickerSnapshot['unavailable'] = [];
    const settle = async <T>(part: 'market' | 'earnings' | 'filings', work: Promise<T>, fallback: T): Promise<T> => {
      try {
        return await work;
      } catch (error) {
        console.error(`Ticker ${part} for ${ticker} failed`, error);
        unavailable.push(part);
        return fallback;
      }
    };
    const [m, e, f] = await Promise.all([settle('market', market(ticker), null), settle('earnings', earnings(ticker), null), settle('filings', filings(ticker), [])]);
    const company = m?.name ? null : await sec.lookupTicker(ticker).catch(() => null);
    return {
      ticker,
      name: m?.name ?? company?.title ?? null,
      priceAt: m?.priceAt ?? null,
      price: m?.price ?? null,
      dayChangePercent: m?.dayChangePercent ?? null,
      marketCap: m?.marketCap ?? null,
      nextEarnings: e?.nextEarnings ?? null,
      lastEarnings: e?.lastEarnings ?? null,
      filings: f,
      unavailable,
    };
  }

  return {
    async get(tickers) {
      const list = [...new Set(tickers)].slice(0, MAX_SNAPSHOT_TICKERS);
      // A few at a time: each ticker is four Finnhub calls, and the free tier allows 60 a minute.
      const results: TickerSnapshot[] = [];
      for (let i = 0; i < list.length; i += 4) {
        const batch = list.slice(i, i + 4).map((t) => {
          const hit = cache.get(t);
          if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
          const value = build(t);
          cache.set(t, { at: Date.now(), value });
          if (cache.size > 200) cache.delete(cache.keys().next().value!);
          return value;
        });
        results.push(...(await Promise.all(batch)));
      }
      return results;
    },
  };
}

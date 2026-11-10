import type { FetchLike } from '../sec/client';

// Thin client for Finnhub's free tier (https://finnhub.io/docs/api): 60 calls a
// minute, US stocks, personal and non-commercial use. The key goes in a header,
// not the URL, so it never shows up in logs.

export interface FinnhubQuote {
  /** Current price. 0 when Finnhub does not know the symbol. */
  c: number;
  /** Change since the previous close, in dollars and percent. */
  d: number | null;
  dp: number | null;
  /** Previous close. */
  pc: number;
  /** Time of the price, in Unix seconds. */
  t: number;
}

export interface FinnhubProfile {
  name?: string;
  ticker?: string;
  /** Market value in millions of US dollars. */
  marketCapitalization?: number;
  currency?: string;
}

/** Only the fields HypeCheck reads. Finnhub returns many more. */
export interface FinnhubMetrics {
  metric?: Record<string, number | string | null | undefined>;
}

export interface FinnhubEarnings {
  actual: number | null;
  estimate: number | null;
  /** End of the quarter, "2026-06-30". */
  period: string;
  quarter: number;
  year: number;
  surprise: number | null;
  surprisePercent: number | null;
  symbol: string;
}

export interface FinnhubCalendarRow {
  /** "2026-11-19" */
  date: string;
  /** "bmo" before the open, "amc" after the close, "dmh" during market hours, or empty. */
  hour?: string;
  quarter?: number;
  year?: number;
  epsEstimate?: number | null;
  symbol: string;
}

export class FinnhubClient {
  private fetchImpl: FetchLike;

  constructor(private options: { apiKey: string; fetch?: FetchLike }) {
    this.fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  }

  private async get<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = `https://finnhub.io/api/v1${path}?${new URLSearchParams(params).toString()}`;
    const res = await this.fetchImpl(url, { headers: { 'X-Finnhub-Token': this.options.apiKey, Accept: 'application/json' } });
    if (res.status === 429) throw new Error('Finnhub rate limit reached (60 calls a minute on the free tier).');
    if (res.status === 401 || res.status === 403) throw new Error(`Finnhub refused the request (${res.status}). Check FINNHUB_API_KEY.`);
    if (!res.ok) throw new Error(`Finnhub request failed (${res.status}) for ${path}`);
    return (await res.json()) as T;
  }

  quote(symbol: string) {
    return this.get<FinnhubQuote>('/quote', { symbol });
  }

  profile(symbol: string) {
    return this.get<FinnhubProfile>('/stock/profile2', { symbol });
  }

  metrics(symbol: string) {
    return this.get<FinnhubMetrics>('/stock/metric', { symbol, metric: 'all' });
  }

  /** Upcoming (or recent) earnings dates for one symbol between two ISO dates. */
  async earningsCalendar(symbol: string, from: string, to: string): Promise<FinnhubCalendarRow[]> {
    const data = await this.get<{ earningsCalendar?: FinnhubCalendarRow[] } | null>('/calendar/earnings', { from, to, symbol });
    return Array.isArray(data?.earningsCalendar) ? data!.earningsCalendar! : [];
  }

  /** The last four quarters of EPS, actual vs the analyst estimate, newest first. */
  async earnings(symbol: string): Promise<FinnhubEarnings[]> {
    const rows = await this.get<FinnhubEarnings[] | null>('/stock/earnings', { symbol });
    return Array.isArray(rows) ? rows : [];
  }
}

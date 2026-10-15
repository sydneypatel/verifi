// Thin client for the SEC's public JSON APIs. No API key exists; the SEC asks
// automated clients to send a User-Agent with a name and contact email.
// These endpoints do not allow browser (CORS) calls, so this runs server-side.

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface SecFact {
  start?: string;
  end: string;
  val: number;
  accn: string;
  fy?: number;
  fp?: string;
  form: string;
  filed: string;
  frame?: string;
}

export interface SecConcept {
  label?: string;
  units: Record<string, SecFact[]>;
}

export interface SecCompanyFacts {
  cik: number;
  entityName: string;
  facts: Record<string, Record<string, SecConcept>>;
}

interface TickerRow {
  cik_str: number;
  ticker: string;
  title: string;
}

export interface SecClientOptions {
  userAgent: string;
  fetch?: FetchLike;
}

export class SecClient {
  private fetchImpl: FetchLike;
  private tickers: Promise<Map<string, TickerRow>> | null = null;
  private facts = new Map<number, { at: number; data: Promise<SecCompanyFacts | null> }>();

  constructor(private options: SecClientOptions) {
    this.fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  }

  private async getJson(url: string): Promise<unknown | null> {
    const res = await this.fetchImpl(url, {
      headers: { 'User-Agent': this.options.userAgent, Accept: 'application/json' },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`SEC request failed (${res.status}) for ${url}`);
    return res.json();
  }

  /** Ticker -> SEC company id (CIK). The full ticker list is fetched once per process. */
  async lookupTicker(ticker: string): Promise<{ cik: number; title: string } | null> {
    if (!this.tickers) {
      this.tickers = this.getJson('https://www.sec.gov/files/company_tickers.json').then((data) => {
        const map = new Map<string, TickerRow>();
        for (const row of Object.values((data ?? {}) as Record<string, TickerRow>)) {
          map.set(row.ticker.toUpperCase(), row);
        }
        return map;
      });
      // Do not cache a failed download.
      this.tickers.catch(() => {
        this.tickers = null;
      });
    }
    const row = (await this.tickers).get(ticker.toUpperCase());
    return row ? { cik: row.cik_str, title: row.title } : null;
  }

  /** Every structured number the company has reported. Null if the SEC has none. */
  async getCompanyFacts(cik: number): Promise<SecCompanyFacts | null> {
    // The file is several megabytes for large companies, and more than one
    // source reads it, so one download is shared for ten minutes.
    const hit = this.facts.get(cik);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.data;

    const padded = String(cik).padStart(10, '0');
    const data = this.getJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${padded}.json`) as Promise<SecCompanyFacts | null>;
    this.facts.set(cik, { at: Date.now(), data });
    data.catch(() => this.facts.delete(cik));
    if (this.facts.size > 50) this.facts.delete(this.facts.keys().next().value!);
    return data;
  }
}

/** Link to the filing's folder on sec.gov. */
export function filingUrl(cik: number, accession: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replace(/-/g, '')}/`;
}

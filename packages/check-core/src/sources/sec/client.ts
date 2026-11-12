// Thin client for the SEC's public JSON APIs. No API key exists; the SEC asks
// automated clients to send a User-Agent with a name and contact email.
// These endpoints do not allow browser (CORS) calls, so this runs server-side.

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  /** Needed only for documents that are not JSON (earnings press releases). */
  text?(): Promise<string>;
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

/** The SEC's list of a company's recent filings, as parallel arrays (one index per filing). */
export interface SecSubmissions {
  cik?: string;
  name?: string;
  filings: {
    recent: {
      accessionNumber: string[];
      filingDate: string[];
      reportDate?: string[];
      form: string[];
      items?: string[];
      primaryDocument?: string[];
    };
  };
}

/** One file inside a filing's folder. */
export interface FilingFile {
  name: string;
  type?: string;
  size?: string | number;
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

  private async getRaw(url: string): Promise<string | null> {
    const res = await this.fetchImpl(url, { headers: { 'User-Agent': this.options.userAgent, Accept: 'text/html,text/plain' } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`SEC request failed (${res.status}) for ${url}`);
    if (!res.text) throw new Error('This fetch cannot read documents.');
    return res.text();
  }

  /** The company's recent filings (forms, dates, 8-K item numbers). */
  async getSubmissions(cik: number): Promise<SecSubmissions | null> {
    const padded = String(cik).padStart(10, '0');
    return (await this.getJson(`https://data.sec.gov/submissions/CIK${padded}.json`)) as SecSubmissions | null;
  }

  /** The files inside one filing (the main form and its exhibits). */
  async getFilingFiles(cik: number, accession: string): Promise<FilingFile[]> {
    const data = (await this.getJson(`${filingUrl(cik, accession)}index.json`)) as { directory?: { item?: FilingFile[] } } | null;
    return data?.directory?.item ?? [];
  }

  /** A document from a filing, as raw HTML or text. */
  async getDocument(url: string): Promise<string | null> {
    return this.getRaw(url);
  }

  private loadTickers(): Promise<Map<string, TickerRow>> {
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
        this.names = null;
      });
    }
    return this.tickers;
  }

  /** Ticker -> SEC company id (CIK). The full ticker list is fetched once per process. */
  async lookupTicker(ticker: string): Promise<{ cik: number; title: string } | null> {
    const row = (await this.loadTickers()).get(ticker.toUpperCase());
    return row ? { cik: row.cik_str, title: row.title } : null;
  }

  private names: Promise<Map<string, TickerRow[]>> | null = null;

  /**
   * Company name -> ticker, from the same SEC list: "CoreWeave" -> CRWV,
   * "BrightView" -> BV, "Nebius" -> NBIS. The name must be the company's
   * listed name without "Inc.", "Holdings" and the like, or its first words.
   * Null when no company or more than one company fits.
   */
  async findByName(name: string): Promise<{ ticker: string; title: string } | null> {
    const key = companyKey(name);
    if (key.length < 3) return null;
    if (!this.names) {
      this.names = this.loadTickers().then((tickers) => {
        const map = new Map<string, TickerRow[]>();
        for (const row of tickers.values()) {
          const k = companyKey(row.title);
          if (k) map.set(k, [...(map.get(k) ?? []), row]);
        }
        return map;
      });
    }
    const names = await this.names;
    const pick = (rows: TickerRow[]) => {
      // Share classes (GOOGL, GOOG) are one company. Different companies are a guess.
      if (new Set(rows.map((r) => r.cik_str)).size !== 1) return null;
      // The SEC list puts a company's main ticker first.
      return { ticker: rows[0]!.ticker.toUpperCase(), title: rows[0]!.title };
    };
    const exact = names.get(key);
    if (exact) return pick(exact);
    if (key.length < 4) return null;
    const prefixed = [...names.entries()].filter(([k]) => k.startsWith(`${key} `)).flatMap(([, rows]) => rows);
    return prefixed.length ? pick(prefixed) : null;
  }

  /** The company name the SEC lists for a ticker. */
  async titleOf(ticker: string): Promise<string | null> {
    return (await this.lookupTicker(ticker))?.title ?? null;
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

// Words that don't tell companies apart: "BrightView Holdings, Inc." is "brightview".
const NAME_NOISE = new Set([
  'the', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'cos', 'ltd', 'limited', 'plc', 'llc', 'lp', 'group',
  'holdings', 'holding', 'nv', 'sa', 'ag', 'se', 'spa', 'ab', 'asa', 'class', 'a', 'b', 'c', 'common', 'stock', 'shares', 'ordinary', 'ads', 'adr', 'de', 'new',
]);

/** A company name reduced to the words that identify it. */
export function companyKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\/[a-z]{2}\/?/g, ' ') // "/DE/" state suffixes
    .replace(/[.'’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !NAME_NOISE.has(w))
    .join(' ');
}

/** "NVIDIA" names "NVIDIA CORP"; "SoftBank" does not. One must be the other's leading words. */
export function namesMatch(a: string, b: string): boolean {
  const x = companyKey(a);
  const y = companyKey(b);
  if (!x || !y) return false;
  return x === y || x.startsWith(`${y} `) || y.startsWith(`${x} `) || x.replace(/ /g, '') === y.replace(/ /g, '');
}

/** Link to the filing's folder on sec.gov. */
export function filingUrl(cik: number, accession: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replace(/-/g, '')}/`;
}

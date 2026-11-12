import type { FetchLike } from '../sec/client';

// Thin client for Alpaca's market data API (https://docs.alpaca.markets).
// The free Basic plan has US stock bars since 2016, 200 calls a minute, and
// full-market (SIP) history up to 15 minutes ago. Keys go in headers, never the URL.

export interface AlpacaBar {
  /** RFC-3339 time the bar starts. */
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type AlpacaFeed = 'sip' | 'iex';

export interface BarsRequest {
  timeframe: '1Day' | '5Min';
  /** RFC-3339 or YYYY-MM-DD. */
  start: string;
  end: string;
}

export class AlpacaClient {
  private fetchImpl: FetchLike;
  /** The feed that worked last. Free accounts without SIP access fall back to IEX. */
  feed: AlpacaFeed = 'sip';

  constructor(private options: { keyId: string; secretKey: string; fetch?: FetchLike }) {
    this.fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  }

  private async page(symbol: string, req: BarsRequest, feed: AlpacaFeed, pageToken?: string) {
    const params = new URLSearchParams({
      timeframe: req.timeframe,
      start: req.start,
      end: req.end,
      // Split-adjusted, so a 4-for-1 split doesn't read as a 75% crash.
      adjustment: 'split',
      feed,
      limit: '10000',
      sort: 'asc',
      ...(pageToken ? { page_token: pageToken } : {}),
    });
    const url = `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/bars?${params.toString()}`;
    const res = await this.fetchImpl(url, {
      headers: { 'APCA-API-KEY-ID': this.options.keyId, 'APCA-API-SECRET-KEY': this.options.secretKey, Accept: 'application/json' },
    });
    return res;
  }

  /** Every bar for one symbol in the range, oldest first. Empty for a symbol Alpaca doesn't know. */
  async bars(symbol: string, req: BarsRequest): Promise<AlpacaBar[]> {
    const out: AlpacaBar[] = [];
    let token: string | undefined;
    for (let pages = 0; pages < 20; pages++) {
      let res = await this.page(symbol, req, this.feed, token);
      if (res.status === 403 && this.feed === 'sip') {
        const message = String(((await res.json().catch(() => null)) as { message?: unknown } | null)?.message ?? '');
        // "subscription does not permit querying recent SIP data": only this request asked
        // for the last 15 minutes, so only it uses IEX. Otherwise the account has no SIP.
        if (!/recent SIP/i.test(message)) this.feed = 'iex';
        res = await this.page(symbol, req, 'iex', token);
      }
      if (res.status === 429) throw new Error('Alpaca rate limit reached (200 calls a minute on the free plan).');
      if (res.status === 401 || res.status === 403) throw new Error(`Alpaca refused the request (${res.status}). Check ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY.`);
      // An unknown or delisted symbol.
      if (res.status === 400 || res.status === 404 || res.status === 422) return [];
      if (!res.ok) throw new Error(`Alpaca request failed (${res.status}) for ${symbol}`);
      const data = (await res.json()) as { bars?: AlpacaBar[] | null; next_page_token?: string | null };
      for (const b of data.bars ?? []) {
        if (typeof b?.t === 'string' && [b.o, b.h, b.l, b.c].every((n) => typeof n === 'number' && Number.isFinite(n))) out.push(b);
      }
      token = data.next_page_token ?? undefined;
      if (!token) break;
    }
    return out;
  }
}

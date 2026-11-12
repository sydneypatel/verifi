// Price claims from past days, measured on the post's own trading day from Alpaca price history.
import { describe, expect, it, vi } from 'vitest';
import {
  AlpacaClient,
  EMPTY_CLAIM,
  FinnhubClient,
  MemoryCache,
  barDate,
  checkPost,
  createAlpacaHistory,
  createFinnhubMarketSource,
  createPriceHistorySource,
  createRuleBasedExtractor,
  evaluatePriceHistoryClaim,
  measureHistory,
  needsHistory,
  type DailyBar,
  type FetchLike,
  type IntradayBar,
} from '../src';
import { createAlpacaFixtureFetch, createFinnhubFixtureFetch, demoDailyBars } from '../src/fixtures';
import type { Claim } from '../src/types';

const TODAY = '2026-11-12';
const claim = (o: Partial<Claim>): Claim => ({ ...EMPTY_CLAIM, id: 'c1', quote: 'q', type: 'price_move', ticker: 'ABC', ...o });

const bar = (date: string, close: number, high = close, low = close, open = close): DailyBar => ({ date, open, high, low, close });
// Late Oct to early Nov 2026. Nov 3 closes up 5%, after trading up to +10%.
const BARS: DailyBar[] = [
  bar('2023-03-01', 40, 41, 39, 38),
  bar('2025-11-10', 120, 130, 118),
  bar('2026-10-29', 90),
  bar('2026-10-30', 95),
  bar('2026-11-02', 100),
  bar('2026-11-03', 105, 110, 99),
  bar('2026-11-04', 103, 104, 101),
  bar('2026-11-05', 101),
  bar('2026-11-06', 102),
  bar('2026-11-11', 100),
];

function check(o: Partial<Claim>, extra: { intraday?: IntradayBar[]; marketCap?: number; bars?: DailyBar[] } = {}) {
  const c = claim(o);
  const evidence = measureHistory(c, extra.bars ?? BARS, { today: TODAY, intraday: extra.intraday, marketCap: extra.marketCap, entityName: 'ABC Corp' });
  return { ...evaluatePriceHistoryClaim(c, evidence), evidence };
}

describe('moves on the post\'s own day', () => {
  it('checks "up 5% today" on a post from last week', () => {
    const r = check({ claimedPercent: 5, direction: 'up', window: 'day', postedAt: '2026-11-03' });
    expect(r.verdict).toBe('holds_up');
    expect(r.reason).toContain('ABC Corp closed at $105.00 on Nov 3, 2026, up 5.0% on Nov 3, 2026 (from $100.00 on Nov 2, 2026)');
    expect(r.evidence.settled).toBe(true);
  });

  it('counts a move the stock reached during the session, for a post written that day', () => {
    const r = check({ claimedPercent: 10, direction: 'up', window: 'day', postedAt: '2026-11-03' });
    expect(r.verdict).toBe('holds_up');
    expect(r.reason).toContain('traded between down 1.0% and up 10.0% on the day');
    // Written the next day, "today" is the next day's session, which fell.
    expect(check({ claimedPercent: 10, direction: 'up', window: 'day', postedAt: '2026-11-04' }).verdict).toBe('contradicted');
  });

  it('uses the session before a weekend post, at the close', () => {
    const r = check({ claimedPercent: 1, direction: 'up', window: 'day', postedAt: '2026-11-08' });
    expect(r.evidence.sessionDate).toBe('2026-11-06');
    expect(r.evidence.intraday).toBe(false);
    expect(r.verdict).toBe('holds_up');
    expect(r.reason).toContain('The post is from Nov 8, 2026, so the session before it is used.');
  });

  it('reads "this week" as the calendar week and "past week" as 5 sessions', () => {
    const thisWeek = check({ quote: 'up 8% this week', claimedPercent: 8, direction: 'up', window: 'week', postedAt: '2026-11-04' });
    expect(thisWeek.evidence.move).toMatchObject({ from: { date: '2026-10-30', price: 95 }, to: { date: '2026-11-04', price: 103 } });
    expect(thisWeek.verdict).toBe('holds_up');
    const pastWeek = check({ quote: 'up 14% over the past week', claimedPercent: 14, direction: 'up', window: 'week', postedAt: '2026-11-06' });
    expect(pastWeek.evidence.move!.from.date).toBe('2026-10-30');
  });

  it('measures "48 hours" and other day counts back from the post', () => {
    const r = check({ claimedPercent: 3, direction: 'up', windowDays: 2, postedAt: '2026-11-04' });
    expect(r.evidence.move).toMatchObject({ from: { date: '2026-11-02' }, label: 'over the 2 days to Nov 4, 2026' });
    expect(r.verdict).toBe('holds_up');
  });

  it('measures spans of years, and says when the history is too short', () => {
    const year = check({ claimedPercent: 17, direction: 'down', window: 'year', postedAt: '2026-11-11' });
    expect(year.evidence.move!.from).toMatchObject({ date: '2025-11-10', price: 120 });
    expect(year.verdict).toBe('holds_up');
    const long = check({ claimedPercent: 50, direction: 'up', windowDays: 1825, postedAt: '2026-11-11' });
    expect(long.verdict).toBe('cant_check');
    expect(long.reason).toContain('starts Mar 1, 2023');
  });

  it('checks "since IPO" only when the whole history is on record', () => {
    // First traded in 2023, after the history begins: from the first day's open.
    const r = check({ claimedPercent: 160, direction: 'up', windowDays: 36500, postedAt: '2026-11-11' });
    expect(r.evidence.move!.from).toMatchObject({ date: '2023-03-01', price: 38 });
    expect(r.verdict).toBe('holds_up');
    const old = [bar('2016-01-04', 10), ...BARS.slice(1)];
    expect(check({ claimedPercent: 900, direction: 'up', windowDays: 36500, postedAt: '2026-11-11' }, { bars: old }).verdict).toBe('cant_check');
  });

  it('checks a share price on the post\'s day, within that day\'s range', () => {
    expect(check({ claimedAmount: 108, postedAt: '2026-11-03' }).verdict).toBe('holds_up');
    expect(check({ claimedAmount: 150, postedAt: '2026-11-03' }).verdict).toBe('contradicted');
  });

  it('says so when the post predates the history', () => {
    const r = check({ claimedPercent: 5, direction: 'up', window: 'day', postedAt: '2015-06-01' });
    expect(r.verdict).toBe('cant_check');
    expect(r.reason).toContain('after the post');
  });
});

describe('highs', () => {
  it('measures "down X% from its highs" against the high before the post', () => {
    // Nov 4: $103 vs the Nov 10, 2025 high of $130 is 20.8% below.
    const r = check({ claimedPercent: 21, direction: 'down', reference: 'high_all_time', postedAt: '2026-11-04' });
    expect(r.verdict).toBe('holds_up');
    expect(r.reason).toContain('20.8% below its all-time high of $130.00 on Nov 10, 2025');
    expect(check({ claimedPercent: 21, direction: 'down', reference: 'high_52_week', postedAt: '2026-11-04' }).verdict).toBe('holds_up');
    expect(check({ claimedPercent: 50, direction: 'down', reference: 'high', postedAt: '2026-11-04' }).verdict).toBe('contradicted');
  });

  it("can't name an all-time high when the history starts in 2016", () => {
    const old = [bar('2016-01-04', 300), ...BARS.slice(1)];
    expect(check({ claimedPercent: 70, direction: 'down', reference: 'high_all_time', postedAt: '2026-11-04' }, { bars: old }).verdict).toBe('cant_check');
    // "Its highs": a smaller drop than from the known high is still wrong; a bigger one may be from an older high.
    expect(check({ claimedPercent: 90, direction: 'down', reference: 'high', postedAt: '2026-11-04' }, { bars: old }).verdict).toBe('cant_check');
    expect(check({ claimedPercent: 66, direction: 'down', reference: 'high', postedAt: '2026-11-04' }, { bars: old }).verdict).toBe('holds_up');
  });
});

describe('pre-market and after-hours', () => {
  const at = (minute: number, close: number, high = close, low = close): IntradayBar => ({ date: '2026-11-03', minute, time: '', open: close, high, low, close });

  it('checks a pre-market move against the previous close', () => {
    const intraday = [at(7 * 60, 101), at(9 * 60 + 25, 104, 104.5, 103.8), at(9 * 60 + 30, 105)];
    const r = check({ claimedPercent: 4, direction: 'up', session: 'pre_market', postedAt: '2026-11-03' }, { intraday });
    expect(r.verdict).toBe('holds_up');
    expect(r.reason).toContain('last traded at $104.00 before the open on Nov 3, 2026, up 4.0% from $100.00');
  });

  it('checks an after-hours move against that day\'s close', () => {
    const intraday = [at(15 * 60 + 55, 105), at(17 * 60, 100)];
    const r = check({ claimedPercent: 5, direction: 'down', session: 'after_hours', postedAt: '2026-11-03' }, { intraday });
    expect(r.verdict).toBe('holds_up');
    expect(r.reason).toContain('after the close');
  });

  it("can't check when the feed has no extended-hours trades", () => {
    const r = check({ claimedPercent: 4, direction: 'up', session: 'pre_market', postedAt: '2026-11-03' }, { intraday: [at(10 * 60, 104)] });
    expect(r.verdict).toBe('cant_check');
    expect(r.reason).toContain('no pre-market trades');
  });
});

describe('market value on a past day', () => {
  it('checks "$X wiped out" on the post\'s day from today\'s value', () => {
    // $1B today at $100; on Nov 3 the price was $105, so about $1.05B, up 5% that day: about $50M added.
    const r = check({ type: 'market_cap', claimedAmount: 50e6, direction: 'up', window: 'day', postedAt: '2026-11-03' }, { marketCap: 1e9 });
    expect(r.verdict).toBe('holds_up');
    expect(r.reason).toContain('gained about $50M in market value');
    expect(check({ type: 'market_cap', claimedAmount: 1.05e9, postedAt: '2026-11-03' }, { marketCap: 1e9 }).verdict).toBe('holds_up');
  });
});

describe('routing', () => {
  it('sends a claim to history only when the latest price can\'t answer it', () => {
    expect(needsHistory(claim({ postedAt: '2026-11-03' }), TODAY)).toBe(true);
    expect(needsHistory(claim({ postedAt: TODAY, window: 'day' }), TODAY)).toBe(false);
    expect(needsHistory(claim({ window: 'day' }), TODAY)).toBe(false);
    expect(needsHistory(claim({ windowDays: 2 }), TODAY)).toBe(true);
    expect(needsHistory(claim({ reference: 'high' }), TODAY)).toBe(true);
    expect(needsHistory(claim({ session: 'after_hours' }), TODAY)).toBe(true);
  });

  const deps = (withHistory: boolean) => {
    const now = () => new Date('2026-11-12T15:00:00Z');
    const finnhub = new FinnhubClient({ apiKey: 'test', fetch: createFinnhubFixtureFetch() });
    const alpaca = new AlpacaClient({ keyId: 'k', secretKey: 's', fetch: createAlpacaFixtureFetch() });
    const history = createPriceHistorySource({ history: createAlpacaHistory({ alpaca, now }), finnhub, now });
    return {
      extractor: createRuleBasedExtractor(),
      sources: [...(withHistory ? [history] : []), createFinnhubMarketSource({ finnhub, now })],
      cache: new MemoryCache(),
      now,
    };
  };

  it('checks a post from last week end to end, which the live price alone could not', async () => {
    // The live quote is from Nov 3, so it says nothing about Nov 2.
    const text = '$TGSR is up 3.5% today.';
    const without = await checkPost(text, deps(false), { postedAt: 'Nov 2' });
    expect(without.claims[0]!.verdict).toBe('cant_check');

    const r = await checkPost(text, deps(true), { postedAt: 'Nov 2' });
    expect(r.claims[0]!.verdict).toBe('holds_up');
    expect(r.claims[0]!.evidence?.kind).toBe('price_history');
    expect(r.claims[0]!.reason).toContain('Tallgrass Solar Inc closed at $17.81 on Nov 2, 2026, up 3.5%');
  });

  it('checks highs, pre-market and after-hours from the demo history', async () => {
    const r = await checkPost(
      '$TGSR is down 30% from its highs. $TGSR is up 6% in premarket trading. $TGSR fell 3% after hours.',
      deps(true),
      { postedAt: 'Nov 3' },
    );
    expect(r.claims.map((c) => c.verdict)).toEqual(['holds_up', 'holds_up', 'cant_check']);
    // The after-hours trades in the demo are on Nov 2.
    const later = await checkPost('$TGSR fell 3% after hours.', deps(true), { postedAt: 'Nov 2' });
    expect(later.claims[0]!.verdict).toBe('holds_up');
  });

  it('still answers a claim about the current session with the live price', async () => {
    const r = await checkPost('$TGSR is a $1.3B company.', deps(true));
    expect(r.claims[0]!.evidence?.kind).toBe('market');
  });
});

describe('Alpaca client', () => {
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

  it('sends the keys in headers and asks for split-adjusted bars, following pages', async () => {
    const fetchMock = vi.fn<FetchLike>(async (url) =>
      url.includes('page_token=p2')
        ? ok({ bars: [{ t: '2026-11-04T05:00:00Z', o: 1, h: 1, l: 1, c: 1, v: 1 }], next_page_token: null })
        : ok({ bars: [{ t: '2026-11-03T05:00:00Z', o: 1, h: 1, l: 1, c: 1, v: 1 }], next_page_token: 'p2' }),
    );
    const client = new AlpacaClient({ keyId: 'id', secretKey: 'secret', fetch: fetchMock });
    const bars = await client.bars('ABC', { timeframe: '1Day', start: '2016-01-01', end: '2026-11-12' });
    expect(bars).toHaveLength(2);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain('https://data.alpaca.markets/v2/stocks/ABC/bars?');
    expect(url).toContain('adjustment=split');
    expect(url).toContain('feed=sip');
    expect(url).not.toContain('secret');
    expect(init?.headers).toMatchObject({ 'APCA-API-KEY-ID': 'id', 'APCA-API-SECRET-KEY': 'secret' });
  });

  it('falls back to the IEX feed when the account has no SIP access', async () => {
    const fetchMock = vi.fn<FetchLike>(async (url) => (url.includes('feed=sip') ? { ok: false, status: 403, json: async () => ({}) } : ok({ bars: [], next_page_token: null })));
    const client = new AlpacaClient({ keyId: 'id', secretKey: 's', fetch: fetchMock });
    await client.bars('ABC', { timeframe: '1Day', start: '2016-01-01', end: '2026-11-12' });
    expect(client.feed).toBe('iex');
    expect(fetchMock.mock.calls[1]![0]).toContain('feed=iex');
  });

  it('uses IEX for one request that reaches into the last 15 minutes, and keeps SIP for the rest', async () => {
    const fetchMock = vi.fn<FetchLike>(async (url) =>
      url.includes('feed=sip') && url.includes('recent')
        ? { ok: false, status: 403, json: async () => ({ message: 'subscription does not permit querying recent SIP data' }) }
        : ok({ bars: [], next_page_token: null }),
    );
    const client = new AlpacaClient({ keyId: 'id', secretKey: 's', fetch: fetchMock });
    await client.bars('ABC', { timeframe: '5Min', start: '2026-11-12T08:00:00Z', end: 'recent' });
    expect(fetchMock.mock.calls[1]![0]).toContain('feed=iex');
    expect(client.feed).toBe('sip');
  });

  it('returns no bars for an unknown symbol and throws on bad keys', async () => {
    // The real API answers an unknown symbol with 200 and "bars": null.
    const unknown = new AlpacaClient({ keyId: 'id', secretKey: 's', fetch: async () => ok({ bars: null, next_page_token: null, symbol: 'ZZZZ' }) });
    expect(await unknown.bars('ZZZZ', { timeframe: '1Day', start: '2016-01-01', end: '2026-11-12' })).toEqual([]);
    const bad = new AlpacaClient({ keyId: 'id', secretKey: 's', fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
    await expect(bad.bars('ABC', { timeframe: '1Day', start: '2016-01-01', end: '2026-11-12' })).rejects.toThrow('ALPACA_API_KEY_ID');
  });

  it('dates daily bars by the New York day and caches history', async () => {
    expect(barDate('2026-11-03T05:00:00Z')).toBe('2026-11-03');
    expect(barDate('2026-07-01T04:00:00Z')).toBe('2026-07-01');
    expect(barDate('2026-11-03T00:00:00Z')).toBe('2026-11-03');
    const fetchMock = vi.fn(createAlpacaFixtureFetch());
    const history = createAlpacaHistory({ alpaca: new AlpacaClient({ keyId: 'k', secretKey: 's', fetch: fetchMock }), now: () => new Date('2026-11-12T15:00:00Z') });
    await history.daily('TGSR');
    await history.daily('tgsr');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Only data at least 15 minutes old: the free plan's limit.
    expect(fetchMock.mock.calls[0]![0]).toContain(`end=${encodeURIComponent('2026-11-12T14:44:00.000Z')}`);
  });

  it('demo history agrees with the Finnhub fixture', () => {
    const bars = demoDailyBars();
    const close = (d: string) => bars.find((b) => b.t.startsWith(d))!.c;
    expect(close('2026-11-03')).toBe(18.42);
    expect(((close('2026-11-03') / close('2026-10-27') - 1) * 100).toFixed(1)).toBe('11.8');
    expect(Math.max(...bars.map((b) => b.h))).toBe(26.31);
  });
});
